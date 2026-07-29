import { registerP2PHandlers } from "../../for-desktop-p2p/src/p2p/bridge";
import { ready as brotliReady } from "../../for-ios-p2p/src/shim/zlib";
import { invoke } from "../../for-ios-p2p/src/shim/electron";

import { flush, ready as filesystemReady, heldBytes } from "./shim/fs";
import { relayReady, warmRelay } from "./shim/net";

/**
 * Starting up, in the order the pieces actually depend on each other.
 *
 * The same order as the phone, for the same reasons, with one substitution:
 * where iOS waits for a native Tor client this waits for the relay.
 *
 *   1. **Storage, first.** Until IndexedDB has loaded, `existsSync` answers
 *      "no" for files that are there — so the app would decide it is a fresh
 *      session and generate a new identity over the top of the account already
 *      in this browser. On a machine with no other copy, that is the account
 *      gone. This is the one that has to be right.
 *
 *   2. **Brotli, before anything is written.** Every frame on disk and most on
 *      the wire is Brotli inside AES-GCM, and the shim throws rather than
 *      silently writing something uncompressed that claims not to be.
 *
 *   3. **The core**, which loads the identity and installs every handler the
 *      interface calls — before the page appears, because the page asks who it
 *      is on its first line.
 *
 *   4. **The relay**, last. Everything above it is local, and a session with
 *      no network still has its history.
 */

export interface BootStatus {
  storage: "loading" | "ready" | "failed";
  compression: "loading" | "ready" | "failed";

  /**
   * Whether this session can reach anybody.
   *
   * Deliberately about the *relay* rather than about Tor. A page cannot
   * observe whether Tor has bootstrapped — that is happening on the server —
   * and claiming to would be inventing a fact. What it can say is whether it
   * has a link to the machine that would know.
   */
  network: "off" | "connecting" | "outbound" | "failed";

  error?: string;
  bytesHeld: number;
}

const status: BootStatus = {
  storage: "loading",
  compression: "loading",
  network: "off",
  bytesHeld: 0,
};

const watchers = new Set<(status: BootStatus) => void>();

export function onStatus(handler: (status: BootStatus) => void): () => void {
  watchers.add(handler);
  handler(status);
  return () => watchers.delete(handler);
}

function announce(): void {
  status.bytesHeld = heldBytes();
  for (const watcher of watchers) watcher({ ...status });
}

export async function boot(): Promise<BootStatus> {
  try {
    await filesystemReady();
    status.storage = "ready";
  } catch (error) {
    status.storage = "failed";
    status.error = `storage: ${(error as Error).message}`;
    announce();

    // Nothing below is worth starting. A session that cannot read its own log
    // should say so and stop, rather than come up looking empty and inviting
    // somebody to start again on top of history that is still there.
    return status;
  }

  announce();

  try {
    await brotliReady();
    status.compression = "ready";
  } catch (error) {
    status.compression = "failed";
    status.error = `compression: ${(error as Error).message}`;
  }

  announce();

  await startNetwork();
  watchLifecycle();

  return status;
}

async function startNetwork(): Promise<void> {
  // The core first: identity, index, and every handler the interface will
  // call. Fatal if it fails, unlike the network — with no identity the
  // interface would offer to create an account over one that already exists.
  try {
    registerP2PHandlers();
  } catch (error) {
    status.storage = "failed";
    status.error = `could not open the store: ${(error as Error).message}`;
    announce();
    return;
  }

  status.network = "connecting";
  announce();

  // Opened early so the first dial is not also the first handshake. Nothing
  // waits on it: a session with no relay still shows its history, and the
  // interface reports the state rather than blocking on it.
  warmRelay();

  // The pairing listener and the transport.
  //
  // Neither can actually receive anything here — see `net.ts` — and both are
  // started anyway, because the code above them is the same code the desktop
  // runs and it dials through objects these calls create. A browser session
  // reaches its devices and its peers; none of them reach it.
  try {
    await invoke("p2p:linkOpen");
  } catch (error) {
    console.warn("[boot] no device link in this session:", error);
  }

  try {
    await invoke("p2p:netStart", 0);
  } catch (error) {
    // Recorded, not fatal. Without it there is no chat, and saying so is
    // right — but linking and syncing dial directly and still work, which is
    // very often the thing that fixes it.
    status.error = `could not start the transport: ${(error as Error).message}`;
    console.warn("[boot]", status.error);
  }

  status.network = relayReady() ? "outbound" : "connecting";
  announce();

  // The relay can take a moment, and can drop later. Reported rather than
  // decided once: a link that was up at startup and is gone now is the state
  // somebody is actually in when nothing is arriving.
  setInterval(() => {
    const now: BootStatus["network"] = relayReady() ? "outbound" : "connecting";
    if (now === status.network) return;
    status.network = now;
    announce();
  }, 3_000);
}

/**
 * Write before the tab goes.
 *
 * `fs.ts` already flushes on `visibilitychange` and `pagehide`, which is where
 * it belongs — those are the events a browser actually delivers. This is the
 * other half: a session that has been left open for hours should not be
 * holding an hour of writes in memory because nothing happened to hide it.
 */
function watchLifecycle(): void {
  setInterval(() => { void flush(); }, 30_000);
}
