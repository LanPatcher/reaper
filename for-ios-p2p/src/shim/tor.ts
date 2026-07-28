import { Tor } from "@reaper/tor";

import { EventEmitter } from "./events";
import { Socket, proxyReady, setProxyPort } from "./net";

/**
 * `tor.ts`, for iOS.
 *
 * The desktop version spawns the `tor` binary and implements the SOCKS5
 * handshake in JavaScript. Neither applies here: Tor is linked into the app as
 * a library (`@reaper/tor`), and the handshake is done in Swift inside the
 * socket plugin, before the first byte of the real protocol.
 *
 * So this exports the one function `transport.ts` imports, implemented as
 * "connect, the native side has already dealt with the proxy". Everything else
 * in the desktop file — the process supervisor, the version check, the torrc
 * writer — has no meaning on a phone and is deliberately absent rather than
 * stubbed, so an accidental call is a compile error rather than a silent no-op.
 */

/** How long to wait before giving up on a peer. */
const CONNECT_TIMEOUT_MS = 45_000;

/**
 * How long to wait for Tor to open its SOCKS port.
 *
 * Generous, because the thing being waited for is a cold Tor bootstrap on a
 * phone. On wifi that is twenty seconds; on a bad cellular connection it is
 * well over a minute, and the consensus download in front of it is not
 * something this app can hurry along.
 *
 * The alternative to waiting is what this code used to do — ask once, and
 * report "Tor has not opened its SOCKS port yet" — which is an accurate
 * description of a situation that resolves itself in under a minute, delivered
 * as though it were a permanent fault. It is the single most reported failure
 * in the device link, and every instance of it was a user pressing Link five
 * seconds after opening an app that needed sixty.
 */
const PROXY_WAIT_MS = 150_000;

/** How often to re-ask while waiting. Cheap: it is a status call, not a probe. */
const PROXY_POLL_MS = 500;

/**
 * The ports Tor was last asked to forward to.
 *
 * Recorded by `boot.ts` so that anything which finds Tor stopped can start it
 * again with the same configuration. Without this the only code that knew the
 * ports was the one boot path, and a device that reached `socksConnect` with
 * Tor not running had no way to do anything about it.
 */
let ports: { localPort: number; syncPort: number } | undefined;

export function rememberPorts(next: { localPort: number; syncPort: number }): void {
  ports = next;
}

/**
 * Start Tor if it is not already running.
 *
 * Idempotent — the native side returns early when it is up — and safe to call
 * from anywhere that needs the network, which is the point. `bridge.ts` calls
 * `TorService.start()` before dialling a sibling precisely so that linking
 * works on a device that has not finished starting up, and on this platform
 * that call used to do nothing at all.
 */
async function ensureRunning(): Promise<void> {
  try {
    const status = await Tor.status();
    if (status.running) return;
  } catch {
    // No plugin, or not up. Starting is still worth attempting.
  }

  if (!ports) return;

  try {
    await Tor.start(ports);
  } catch {
    // Reported by the caller, in terms of what it was trying to do.
  }
}

/**
 * Wait for Tor to open its SOCKS port, up to a deadline.
 *
 * Returns whether it did. Polling rather than subscribing because the plugin's
 * `tor` event is already consumed by `boot.ts`, and a second native listener
 * for a value that is sitting in `status()` is a coordination problem bought
 * for nothing.
 */
export async function waitForProxy(timeoutMs = PROXY_WAIT_MS): Promise<boolean> {
  if (proxyReady()) return true;

  await ensureRunning();

  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await adoptProxyPort()) return true;
    if (Date.now() >= deadline) return false;

    await new Promise((resolve) => setTimeout(resolve, PROXY_POLL_MS));
  }
}

/**
 * How far Tor has got, in a sentence worth showing someone.
 *
 * Only ever read when something has already failed, so the cost of a status
 * call does not matter and the detail does: "still starting up" and "Tor is
 * not running at all" have completely different answers, and reporting both as
 * the former is how a device that would never have worked looked like one that
 * needed another moment.
 */
async function whyNotReady(): Promise<string> {
  try {
    const status = await Tor.status();

    if (status.error) return `Tor reported an error: ${status.error}`;
    if (!status.running) return "Tor is not running on this device";
    if (!status.bootstrapped) {
      return "Tor is still building its first circuit — this can take a " +
        "couple of minutes on a phone, especially on cellular";
    }

    return "Tor is running but has not opened a SOCKS port";
  } catch (error) {
    return `Tor could not be reached: ${(error as Error).message}`;
  }
}

/**
 * Open a connection to an onion address.
 *
 * Resolves when the circuit is up and the proxy has confirmed the destination,
 * which is what the desktop's version promises too — the transport writes its
 * hello immediately on resolution and would lose it otherwise.
 *
 * The timeout is longer than the desktop's: a first circuit on a phone, over
 * cellular, is genuinely slow, and failing early here means a contact that
 * would have answered is marked unreachable.
 */
export async function socksConnect(host: string, port: number): Promise<Socket> {
  // Wait, rather than ask once.
  //
  // The SOCKS port used to arrive only in a `ready` event, delivered once when
  // the first circuit is established — and anything that misses that event
  // never learns the port at all. Asking `status()` fixed that half; this
  // fixes the other half, which is that the answer to "is it ready" on a
  // freshly launched app is *no, not yet*, and the only correct response to
  // that is to wait for it.
  //
  // Missing the event is not exotic either. Reloading the page — which
  // importing an identity does — restarts the JavaScript context but not Tor,
  // so `Tor.start` returns early because it is already running and no event is
  // ever emitted again.
  const ready = await waitForProxy();

  if (!ready) {
    throw new Error(await whyNotReady());
  }

  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`timed out connecting to ${host}`));
    }, CONNECT_TIMEOUT_MS);

    socket.on("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    // Port and host both go to the native side untouched: the onion address is
    // handed to Tor as a name, so this device never resolves it.
    socket.connect(port, host);
  });
}


/**
 * Learn the SOCKS port from the client, whenever anything needs it.
 *
 * Idempotent and cheap. Called before a connection and on every poll, so there
 * is no single moment this has to be got right.
 */
export async function adoptProxyPort(): Promise<boolean> {
  try {
    const status = await Tor.status();
    if (status.socksPort) {
      setProxyPort(status.socksPort);
      return true;
    }
  } catch {
    // Not up yet. The caller reports that in its own words.
  }

  return false;
}

/**
 * The desktop's Tor supervisor, which does not apply here.
 *
 * On a desktop this spawns the `tor` binary, watches it, restarts it and reads
 * its version. On iOS Tor is linked into the app and driven by `@reaper/tor` —
 * started long before `bridge.ts` is even loaded — so there is nothing for this
 * to supervise.
 *
 * It exists because `bridge.ts` imports it, and it reports honestly rather than
 * pretending to run something: `running` is whatever the plugin says, and
 * `start` is a no-op because starting already happened.
 */
export class TorService extends EventEmitter {
  address: string | undefined;

  /**
   * Where this device's own devices reach it.
   *
   * One Tor client publishes both services here, so both addresses come from
   * the same status call. The desktop is now the same shape — it used to try a
   * second tor process, which could never bind and never published anything.
   */
  syncAddress: string | undefined;

  running = false;

  #watching: ReturnType<typeof setInterval> | undefined;

  /**
   * Keep `address` and `running` in step with the plugin.
   *
   * `bridge.ts` answers `netInfo` from these two fields, and the interface
   * builds the friend code out of the address it gets back. On the desktop
   * `start()` does not return until Tor has written its hostname file, so the
   * address is there by the time anything asks.
   *
   * Here it is not. Tor is started by `boot.ts` before this object exists, and
   * publishing a descriptor takes another minute or two after that — so
   * everything asking for the address got `undefined`, permanently, and the
   * interface showed "waiting for Tor to publish your address" for the rest of
   * the session with an onion service that had been live the whole time.
   *
   * Polling rather than subscribing because the plugin's events are already
   * consumed by `boot.ts`, and two subscribers to one native listener is a
   * coordination problem for a value that changes twice in the life of the
   * app.
   */
  #watch(): void {
    if (this.#watching) return;

    const look = () => {
      void Tor.status().then((status) => {
        this.running = status.running;

        // The proxy port, on every tick. It costs nothing and it is the one
        // value whose absence stops the whole app reaching anybody.
        if (status.socksPort) setProxyPort(status.socksPort);

        if (status.onion && status.onion !== this.address) {
          this.address = status.onion;
          this.emit("ready", status.onion);
        }

        if (status.syncOnion && status.syncOnion !== this.syncAddress) {
          this.syncAddress = status.syncOnion;
          this.emit("sync", status.syncOnion);
        }

        // Nothing left to wait for. Neither address changes again without the
        // app restarting, and the proxy port is now known.
        if (this.address && this.syncAddress && proxyReady() && this.#watching) {
          clearInterval(this.#watching);
          this.#watching = undefined;
        }
      }).catch(() => {
        // Not running yet, or no plugin. The next tick asks again.
      });
    };

    look();
    this.#watching = setInterval(look, 3000);
  }

  constructor(_options?: unknown) {
    // An EventEmitter, because the desktop's is one and `bridge.ts` — the same
    // file, running here unchanged — subscribes to it the moment it is built:
    //
    //     tor.on("log", (line) => log("[tor]", line));
    //
    // A plain class has no `on`, so that line throws a TypeError inside the
    // `netStart` handler, which rejects, which surfaces as "could not start
    // the transport" — an error naming the one part that had just worked.
    //
    // Extending the shim rather than adding a stub `on` that discards its
    // argument: this class does emit something worth hearing the moment
    // anything is added to it, and a listener silently thrown away is the same
    // class of bug as the one that froze this app on its startup screen.
    super();
  }

  /**
   * Bring Tor up, and do not return until it can carry an outbound connection.
   *
   * This used to be a no-op that reported whatever `status()` happened to say,
   * on the reasoning that `boot.ts` starts Tor and there is nothing left to
   * supervise. Both halves of that were wrong in the one case that matters
   * most.
   *
   * `bridge.ts` calls this from `ensureTorClient`, immediately before dialling
   * a sibling, and it exists for exactly one situation: a device with no
   * account, sitting on the setup screen, whose entire purpose in that moment
   * is to reach another device and be given one. On the desktop that call
   * spawns `tor` and waits for its hostname file, so by the time it returns the
   * dial will work. Here it returned instantly with `running: false`, the dial
   * went ahead anyway, and the honest answer came back — "Tor has not opened
   * its SOCKS port yet" — about a Tor that nothing had started and nothing was
   * going to.
   *
   * So it starts Tor if it is not running, and waits for the SOCKS port before
   * returning. It does *not* wait for an address: publishing a descriptor takes
   * another minute or two, this device does not need one to dial out, and
   * blocking on it would turn a working link into a timeout.
   */
  async start(): Promise<string | undefined> {
    this.#watch();

    await waitForProxy();

    const status = await Tor.status().catch(() => undefined);

    if (status?.onion) this.address = status.onion;
    if (status?.syncOnion) this.syncAddress = status.syncOnion;
    this.running = status?.running ?? false;

    return this.address;
  }

  /**
   * Publish the account address, or stop publishing it.
   *
   * On the desktop this rewrites the torrc and restarts the process. Here it
   * cannot: `@reaper/tor` publishes both services from one configuration read
   * at launch, and there is no call to withdraw one of them.
   *
   * It exists because `bridge.ts` — the same file, running here unchanged —
   * calls it from `publishIfHolding` on every start. A class without it throws
   * `tor.setAccount is not a function` inside the `netStart` handler, which
   * rejects, which the interface reports as "could not start the transport": an
   * error naming the transport, thrown by the address bookkeeping that runs
   * after the transport has already started successfully.
   *
   * The consequence of it being a no-op is worth stating plainly rather than
   * hiding: a phone that has been displaced goes on publishing the account
   * descriptor until it is next launched, so for that window two devices
   * answer at one address. Withdrawing it properly needs the native side to
   * support a second configuration, which is a change to make deliberately and
   * not as a side effect of this.
   */
  async setAccount(_publish: boolean): Promise<void> {
    // Nothing to do, and nothing pretended.
  }

  stop(): void {
    // Deliberately not stopping Tor.
    //
    // On the desktop this kills the process, and `bridge.ts` calls it when
    // another device takes the address over. Here Tor is the app's only route
    // to anyone — SOCKS included — so tearing it down would take outbound
    // connections with it and leave a displaced device unable to reach even
    // the device that displaced it.
    //
    // Ceasing to publish is what is actually wanted, and that is decided by
    // whether the address is claimed rather than by whether Tor is alive.
    if (this.#watching) clearInterval(this.#watching);
    this.#watching = undefined;
  }
}

/**
 * The version check, which the desktop uses to warn about an old `tor`.
 *
 * Here the version is whatever Tor.framework was built against, and it is not
 * something a user can change — so there is nothing actionable to warn about.
 * Reported as unknown rather than as a number that might be wrong.
 */
export function torVersion(): string | undefined {
  return undefined;
}

// ---- the address, as something that can be moved ---------------------------
//
// Same contract as the desktop's, different plumbing. There the service key is
// three files under the app's data directory and `bridge.ts` reads them with
// `fs`; here it is three files inside the app container that only Swift knows
// the path of, because the directory is chosen by `TorService` and protected
// with a file-protection class that has no equivalent on a desktop.
//
// The signatures match the desktop's exactly, including the `dataDir` argument
// that is meaningless on a phone. `bridge.ts` is the same file on both
// platforms and calls these the same way; a shim that needed a different call
// site would mean forking the one file this whole build exists to avoid
// forking.

export interface OnionKey {
  secret: string;
  public: string;
  hostname: string;
}

/** This device's service key, or nothing if Tor has not made one yet. */
export async function readOnionKey(_dataDir?: string): Promise<OnionKey | undefined> {
  const key = await Tor.exportKey();
  if (!key.secret || !key.public) return undefined;

  return { secret: key.secret, public: key.public, hostname: key.hostname ?? "" };
}

/**
 * Validate without writing.
 *
 * Deliberately not a re-implementation of the desktop's checks. The native
 * side has to do the same validation anyway — it is the thing that writes the
 * files — and two copies of a format check are two chances to disagree about
 * what a valid key looks like. So this only catches what can be caught without
 * the key material in hand, and the real refusal comes from `importKey`.
 */
export function checkOnionKey(key: OnionKey): string {
  if (!key || !key.secret || !key.public) {
    throw new Error("that file's onion key is incomplete");
  }
  return (key.hostname ?? "").trim().toLowerCase();
}

/**
 * Install a service key, so this device answers at that address.
 *
 * Unlike the desktop this does not wait for a restart of the app: Tor is a
 * library here and can be stopped and started in place, so the native side
 * does exactly that and the new address is published within a minute or two.
 */
export async function writeOnionKey(
  _dataDir: string,
  key: OnionKey,
): Promise<string> {
  const { hostname } = await Tor.importKey(key);
  return hostname;
}

export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const left = parts(a);
  const right = parts(b);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return difference < 0 ? -1 : 1;
  }

  return 0;
}
