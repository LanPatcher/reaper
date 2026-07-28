import { Tor } from "@reaper/tor";

import { EventEmitter } from "./events";
import { Socket, proxyReady } from "./net";

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
export function socksConnect(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (!proxyReady()) {
      reject(new Error("Tor is not ready yet"));
      return;
    }

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
  running = false;

  #watching: ReturnType<typeof setInterval> | undefined;

  /**
   * Which of this device's two addresses this object reports.
   *
   * The desktop runs two Tor processes with separate data directories and
   * tells them apart by path. Here there is one linked-in client publishing
   * both services, so the object has to be told which of the two it stands
   * for — otherwise `bridge.ts` builds a sync service, asks it for its
   * address, and is handed the account's. That would record the account
   * address in the device roster, and every device of yours would then try to
   * sync with whichever one is currently holding it: the exact device that
   * does not need reaching.
   */
  #role: "account" | "sync";

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

        const found = this.#role === "sync" ? status.syncOnion : status.onion;

        if (found && found !== this.address) {
          this.address = found;
          this.emit("ready", found);
        }

        // Nothing left to wait for. The address does not change again without
        // the app restarting.
        if (this.address && this.#watching) {
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

  constructor(options?: { role?: "account" | "sync" }) {
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

    // Defaulting to the account address, which is what every caller written
    // before there were two of them means.
    this.#role = options?.role ?? "account";
  }

  async start(): Promise<string | undefined> {
    // Already running. See `boot.ts` — Tor is started before the store opens,
    // because the transport needs its SOCKS port the moment it comes up. What
    // this does is start watching for the address it will eventually publish.
    this.#watch();

    const status = await Tor.status().catch(() => undefined);

    const found = this.#role === "sync" ? status?.syncOnion : status?.onion;
    if (found) this.address = found;
    this.running = status?.running ?? false;

    return this.address;
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
