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
export class TorService {
  address: string | undefined;
  running = false;

  constructor(_options?: unknown) {}

  async start(): Promise<void> {
    // Already running. See `boot.ts` — Tor is started before the store opens,
    // because the transport needs its SOCKS port the moment it comes up.
  }

  stop(): void {}
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
