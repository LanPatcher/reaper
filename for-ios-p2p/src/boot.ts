import { App } from "@capacitor/app";
import { Keepalive } from "@reaper/keepalive";
import { Socket } from "@reaper/socket";
import { Tor, type TorEvent } from "@reaper/tor";

import { flush, ready as filesystemReady, heldBytes } from "./shim/fs";
import { ready as brotliReady } from "./shim/zlib";

/**
 * Starting up, in the order the pieces actually depend on each other.
 *
 * This order is not stylistic. Each step is a precondition for the next, and
 * getting it wrong produces failures that look like something else entirely:
 *
 *   1. **The filesystem, first.** Until it has loaded, `existsSync` answers
 *      "no" for files that are on the disk — so the app would decide it is a
 *      fresh install and generate a new identity, losing the account. This is
 *      the one that has to be right.
 *
 *   2. **Brotli, before anything is written.** Every frame on disk and most
 *      frames on the wire are Brotli inside AES-GCM, and the shim throws
 *      rather than silently writing something uncompressed that claims not to
 *      be. Loading it is asynchronous; using it is not.
 *
 *   3. **The keepalive**, before the app can be backgrounded. Starting it late
 *      means the first time somebody switches away, the app suspends and stops
 *      receiving until it is opened again.
 *
 *   4. **The listening socket, then Tor** — in that order, because Tor is told
 *      which port to forward to and cannot be told a port that does not exist
 *      yet. Starting Tor first would publish an onion service pointing at
 *      nothing, and a peer connecting to it would be refused by a device that
 *      is, as far as it is concerned, online.
 *
 * Only then is there any point opening a store.
 */

export interface BootStatus {
  storage: "loading" | "ready" | "failed";
  compression: "loading" | "ready" | "failed";
  background: "off" | "on" | "unavailable";

  /**
   * How far Tor has got.
   *
   * Deliberately more than a boolean. "Connecting" and "unreachable" are
   * different situations — the first resolves itself and the second does not —
   * and there is a stage in between where outbound works and inbound does not,
   * which is worth being able to say rather than showing a spinner.
   */
  network:
    | "off"
    | "starting"
    | "connecting"
    | "outbound"
    | "reachable"
    | "failed";

  /** Bootstrap progress, while connecting. */
  percent?: number;

  /** This device's address, once Tor has published it. */
  onion?: string;

  /** The loopback port peers arrive on. */
  listening?: number;

  error?: string;
  bytesHeld: number;
}

const status: BootStatus = {
  storage: "loading",
  compression: "loading",
  background: "off",
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

    // Nothing below this is worth starting. An app that cannot read its own
    // log should say so and stop, rather than come up looking empty and
    // inviting somebody to start again on top of history that is still there.
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

  // The audio session that stops iOS suspending the app. See
  // plugins/keepalive — it is silence, mixed with whatever else is playing, so
  // it neither makes a sound nor stops anything that does.
  try {
    const keepalive = await Keepalive.start();
    status.background = keepalive.running ? "on" : "unavailable";
    if (!keepalive.running && keepalive.error) {
      status.error = `background: ${keepalive.error}`;
    }
  } catch (error) {
    status.background = "unavailable";
    status.error = `background: ${(error as Error).message}`;
  }

  announce();

  // The network, last. Everything above it is local; this is the only part
  // that talks to anybody, and it is pointless before there is a log to sync.
  await startNetwork();

  watchLifecycle();

  return status;
}

/**
 * Listen, then tell Tor where to forward.
 *
 * The order is the whole of it. `Socket.listen` binds a loopback port and
 * returns the one it got; Tor then publishes an onion service pointing at that
 * port. Doing it the other way round means an address that resolves to a
 * closed port — the device looks online to every peer and refuses all of them.
 */
async function startNetwork(): Promise<void> {
  let listening: number;

  try {
    // Port zero: the system picks. A fixed port collides with whatever else is
    // using it, and the failure is a bind error at startup that reads as Tor
    // being broken.
    const bound = await Socket.listen({ port: 0 });
    listening = bound.port;
  } catch (error) {
    status.network = "failed";
    status.error = `listening: ${(error as Error).message}`;
    announce();
    return;
  }

  status.listening = listening;
  status.network = "starting";
  announce();

  await Tor.addListener("tor", (event: TorEvent) => {
    switch (event.state) {
      case "starting":
        status.network = "starting";
        break;

      case "bootstrapping":
        status.network = "connecting";
        status.percent = event.percent;
        break;

      case "ready":
        // A circuit exists, so this device can reach others. It cannot yet be
        // reached — the descriptor has not been published — and saying
        // "connected" here would be a quarter true.
        status.network = "outbound";
        break;

      case "published":
        status.network = "reachable";
        status.onion = event.onion;
        break;

      case "failed":
        status.network = "failed";
        status.error = event.error;
        break;

      case "stopped":
        status.network = "off";
        break;
    }

    announce();
  });

  try {
    await Tor.start({ localPort: listening });
  } catch (error) {
    status.network = "failed";
    status.error = `tor: ${(error as Error).message}`;
    announce();
  }
}

/**
 * Persist before iOS has a chance to kill the app.
 *
 * Writes are debounced — that is what makes appending cheap — which leaves a
 * few hundred milliseconds where a message exists only in memory. Backgrounding
 * is exactly when the system is most likely to reclaim the process, so it is
 * also exactly when that window should be closed.
 */
function watchLifecycle(): void {
  void App.addListener("appStateChange", ({ isActive }) => {
    if (!isActive) {
      void flush();
      return;
    }

    // Coming back. The audio session may have been torn down while away — an
    // interruption that never resumed, a route change nobody saw — and if it
    // was, the app has not been reachable. Cheaper to check than to wonder.
    void Keepalive.status().then((keepalive) => {
      if (keepalive.running) return;
      return Keepalive.start().then(() => {
        status.background = "on";
        announce();
      });
    });
  });

  // Being terminated. Not guaranteed to run — iOS does not promise the app a
  // chance to tidy up — so it is a last resort rather than the plan.
  void App.addListener("pause", () => {
    void flush();
  });
}
