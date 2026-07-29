import { EventEmitter } from "../../../for-ios-p2p/src/shim/events";

import { existsSync, readFileSync, writeFileSync } from "./fs";
import { Socket, publish, relayReady, unpublish, warmRelay } from "./net";

/**
 * `tor.ts`, for a browser session.
 *
 * Tor is not here. It is on the machine serving this page, and every
 * connection is dialled through it — see `server/relay.mjs`. So the peers this
 * session reaches are reached at their real onion addresses, over real
 * circuits, and a desktop or a phone on the other end cannot tell the
 * difference and does not have to: it is an ordinary Tor connection arriving
 * from an ordinary Tor client.
 *
 * What differs is only where that client runs, and the consequence of that is
 * stated where it belongs, at the top of the relay.
 *
 * ## Two services, and where their keys live
 *
 * This session publishes what every other device does: an account address, and
 * a sync address only its own devices dial. Tor makes them on request through
 * its control port — see `server/control.mjs` — and forwards them to the relay,
 * which tunnels the connections here.
 *
 * The keys are kept in this session's own storage, next to its account, and
 * handed to the relay only to be registered for as long as the tab is open.
 * Nothing about them is written down there. A key Tor generates comes straight
 * back here to be stored, so an address survives a refresh and belongs to the
 * account rather than to the server.
 *
 * The consequence worth naming: while the tab is open, the relay has been
 * handed a key that can answer at your address. It cannot when you are gone,
 * and it has nothing to keep. That is a real cost and a much smaller one than
 * a relay that holds every visitor's identity permanently.
 */

/**
 * Open a connection to an onion address.
 *
 * The SOCKS handshake happens on the relay, before the first byte of the real
 * protocol, exactly as it happens in Swift on the phone. By the time this
 * resolves the circuit is up and the stream is ordinary.
 */
export function socksConnect(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`timed out connecting to ${host}`));
    }, 60_000);

    socket.on("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on("error", ((error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }) as never);

    // The host goes to the relay untouched: the onion address is handed to Tor
    // as a name, so it is never resolved by this device or by the relay.
    socket.connect(port, host);
  });
}

/**
 * The supervisor, which has nothing to supervise.
 *
 * `bridge.ts` — the same file the desktop ships — builds one of these and
 * subscribes to it on the next line, so it has to be an `EventEmitter` and it
 * has to answer honestly. `running` is whether the relay is reachable, which
 * is the nearest true thing to "can this session reach anybody".
 */
/**
 * Where this session keeps its service keys.
 *
 * Inside the same virtual filesystem as the account, so they are covered by
 * the same storage and the same lifetime — an address that outlived its
 * account, or the reverse, would be worse than not having one.
 */
const KEY_FILE = { account: "tor/onion.key", sync: "tor/sync.key" } as const;

function heldKey(which: "account" | "sync"): string | undefined {
  try {
    const at = KEY_FILE[which];
    return existsSync(at) ? readFileSync(at, "utf8").trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

function keepKey(which: "account" | "sync", key: string): void {
  try {
    writeFileSync(KEY_FILE[which], key);
  } catch (error) {
    // An address that cannot be stored still works for this session; it simply
    // will not be the same one next time. Worth a line and not worth failing.
    console.warn(`[tor] could not keep the ${which} address key:`, error);
  }
}

export class TorService extends EventEmitter {
  address: string | undefined;
  syncAddress: string | undefined;

  running = false;

  #options: { targetPort?: number; syncPort?: number; account?: boolean };
  #watching: ReturnType<typeof setInterval> | undefined;

  /** One attempt at a time; publishing is slow and retrying is on a timer. */
  #publishing = false;

  constructor(options?: { targetPort?: number; syncPort?: number; account?: boolean }) {
    super();
    this.#options = options ?? {};
  }

  /**
   * Bring the session onto the network and publish its addresses.
   *
   * The relay has to answer first — it is what talks to Tor — and then each
   * service is registered against the loopback port its server was granted.
   * Failing to publish is not fatal: a session that can dial out but cannot be
   * dialled is the old behaviour and is still a usable client, so it is
   * reported rather than thrown.
   */
  async start(): Promise<string | undefined> {
    warmRelay();

    const deadline = Date.now() + 30_000;
    while (!relayReady() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    this.running = relayReady();

    if (!this.running) {
      this.emit("log", "the relay did not answer — this session cannot reach anybody");
      this.#watch();
      return undefined;
    }

    this.emit("log", "connected to the relay");

    // The sync address, which only this account's own devices dial. Published
    // unconditionally, exactly as the desktop does: a device that is not
    // holding the account address still has to be reachable by its siblings,
    // and that is precisely when reaching it matters most.
    if (this.#options.syncPort) {
      this.syncAddress = await this.#serve("sync", this.#options.syncPort);
      if (this.syncAddress) this.emit("sync", this.syncAddress);
    }

    // The account address, only when this session is the one holding it.
    if (this.#options.account !== false && this.#options.targetPort) {
      this.address = await this.#serve("account", this.#options.targetPort);
      if (this.address) this.emit("ready", this.address);
    }

    this.#watch();
    return this.address;
  }

  async #serve(which: "account" | "sync", port: number): Promise<string | undefined> {
    try {
      const result = await publish(which, port, heldKey(which));

      // Only present when Tor generated one. Stored immediately, because the
      // window between having an address and being able to reproduce it is the
      // window in which a refresh loses it.
      if (result.key) keepKey(which, result.key);

      this.emit("log", `${which} address published: ${result.onion}`);
      return result.onion;
    } catch (error) {
      this.emit("log", `could not publish the ${which} address: ${(error as Error).message}`);
      return undefined;
    }
  }

  /**
   * Keep trying, rather than failing once and staying failed.
   *
   * Publishing needs Tor's control port, and the most likely reason it is not
   * there is that the torrc has not been changed yet. That is a thing somebody
   * fixes *while the tab is open* — so a session that gave up at startup would
   * sit there addressless next to a Tor that had just been made ready for it,
   * and the only way through would be a reload nobody knows to do.
   *
   * Also covers the relay dropping and coming back, which takes the services
   * with it: Tor withdraws anything registered on a control connection when
   * that connection closes, so they have to be registered again.
   */
  #watch(): void {
    if (this.#watching) return;

    this.#watching = setInterval(() => {
      const now = relayReady();

      if (now !== this.running) {
        this.running = now;
        this.emit("log", now ? "the relay is back" : "the relay dropped");
      }

      if (!now || this.#publishing) return;

      const wantsSync = this.#options.syncPort && !this.syncAddress;
      const wantsAccount =
        this.#options.account !== false && this.#options.targetPort && !this.address;

      if (!wantsSync && !wantsAccount) return;

      this.#publishing = true;

      void (async () => {
        try {
          if (wantsSync) {
            this.syncAddress = await this.#serve("sync", this.#options.syncPort!);
            if (this.syncAddress) this.emit("sync", this.syncAddress);
          }

          if (wantsAccount) {
            this.address = await this.#serve("account", this.#options.targetPort!);
            if (this.address) this.emit("ready", this.address);
          }
        } finally {
          this.#publishing = false;
        }
      })();
    }, 10_000);
  }

  /**
   * Publish the account address, or stop.
   *
   * Real here, unlike on the phone. Exactly one device answers at an account
   * address at a time, and a session that has been displaced has to stop
   * publishing or two of them answer and peers reach whichever Tor heard from
   * last. The sync address is untouched either way — a displaced device is the
   * one that most needs to be reachable, because that is how it catches up and
   * how it takes the account back.
   */
  async setAccount(publishIt: boolean): Promise<void> {
    if (publishIt === (this.address !== undefined)) return;

    if (!publishIt) {
      unpublish("account");
      this.address = undefined;
      this.emit("log", "stopped publishing the account address");
      return;
    }

    if (!this.#options.targetPort || !relayReady()) return;

    this.address = await this.#serve("account", this.#options.targetPort);
    if (this.address) this.emit("ready", this.address);
  }

  stop(): void {
    if (this.#watching) clearInterval(this.#watching);
    this.#watching = undefined;

    unpublish("account");
    unpublish("sync");

    this.address = undefined;
    this.syncAddress = undefined;
    this.running = false;
  }
}

export interface OnionKey {
  secret: string;
  public: string;
  hostname: string;
}

/**
 * This session's service key, as something to hand to another device.
 *
 * Answers nothing, and the reason is a format rather than a policy. What is
 * stored here is what `ADD_ONION` wants — the 64-byte expanded key — and what
 * a sibling needs is tor's 96-byte file *and* the matching public key, which
 * cannot be recovered from the private half without doing ed25519 scalar
 * multiplication by hand.
 *
 * The consequence is worth stating: a device linked *from* a browser session
 * gets the account but not its address, so it comes up as the right identity
 * at a new one. Link from a desktop or a phone when that matters.
 *
 * Undefined rather than a throw, because `bridge.ts` reads this whenever it
 * hands an account to a sibling — and failing there would break the link
 * itself over the absence of something optional to it.
 */
export async function readOnionKey(_dataDir?: string): Promise<OnionKey | undefined> {
  return undefined;
}

export function checkOnionKey(key: OnionKey): string {
  if (!key || !key.secret || !key.public) {
    throw new Error("that file's onion key is incomplete");
  }
  return (key.hostname ?? "").trim().toLowerCase();
}

/**
 * Take on the account's address, so this session answers where it should.
 *
 * ## The format conversion, and why it is here
 *
 * An account *is* its address, so a device handed an account is handed the key
 * to that address with it — otherwise it comes up as the right identity
 * somewhere else entirely and every friend code anybody holds stops working.
 *
 * The two ends spell the key differently. Tor's own service directory keeps a
 * 96-byte file: a 32-byte tag naming the format, then the 64-byte expanded
 * key. `ADD_ONION` wants only those 64 bytes, base64, prefixed `ED25519-V3:`.
 * So the tag is stripped and the rest re-encoded — which is the whole of the
 * difference, and getting it wrong produces a key Tor rejects with nothing to
 * say why.
 *
 * Stored rather than registered immediately. Publishing is decided by whether
 * this device is the one holding the address — `setAccount` — and adopting an
 * account is not the same act as claiming its address.
 */
export async function writeOnionKey(_dataDir: string, key: OnionKey): Promise<string> {
  const address = checkOnionKey(key);

  const raw = Uint8Array.from(atob(key.secret), (c) => c.charCodeAt(0));

  if (raw.length !== 96) {
    throw new Error(`that onion key is ${raw.length} bytes, not tor's 96`);
  }

  // Past the 32-byte format tag. What follows is the key itself.
  const expanded = raw.subarray(32);
  let binary = "";
  for (const byte of expanded) binary += String.fromCharCode(byte);

  keepKey("account", `ED25519-V3:${btoa(binary)}`);

  return address;
}

export function torVersion(): string | undefined {
  return undefined;
}

export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const left = parts(a);
  const right = parts(b);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return difference < 0 ? -1 : 1;
  }

  return 0;
}
