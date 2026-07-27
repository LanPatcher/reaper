import { Buffer } from "buffer";

/**
 * `electron`, for iOS.
 *
 * ## Why this exists rather than a second bridge
 *
 * The desktop's `bridge.ts` is seventeen hundred lines of decisions — who
 * counts as a member, which communities a peer may sync, when a file may be
 * deleted, how a key is wrapped for a group. Writing an iOS version of it would
 * mean writing all of that again and then keeping two copies in step forever.
 * The first divergence would be a bug on one platform only, found by somebody
 * whose messages stopped arriving.
 *
 * So the same file runs here. It talks to Electron through exactly four things
 * — `app.getPath`, `app.getAppPath`, `app.isPackaged`, and `ipcMain.handle` —
 * and this supplies all four. The handlers it registers land in a map instead
 * of an IPC channel, and `bridge.ts` on this side calls them directly.
 *
 * The same trick as `node:net` and `node:crypto`: replace the platform, keep
 * the program.
 */

// ---- app --------------------------------------------------------------------

/**
 * Where the store writes.
 *
 * `bridge.ts` asks for `userData` and appends `p2p`. There is no such concept
 * on iOS, so this is a fixed root inside the virtual filesystem in `fs.ts` —
 * which is itself backed by the app's Documents directory through Capacitor.
 * Nothing here touches a real path; `fs.ts` owns that translation.
 */
const PATHS: Record<string, string> = {
  userData: "/data",
  appData: "/data",
  temp: "/tmp",
  logs: "/data/logs",
  home: "/data",
  documents: "/data",
};

export const app = {
  getPath(name: string): string {
    return PATHS[name] ?? "/data";
  },

  getAppPath(): string {
    return "/app";
  },

  // Always true. There is no unpackaged run of an iOS app, and the flag is
  // only read to decide whether to look for development resources.
  isPackaged: true,

  getName(): string {
    return "Reaper";
  },

  getVersion(): string {
    return "0.1.0";
  },
};

// ---- ipcMain ----------------------------------------------------------------

type Handler = (event: unknown, ...args: never[]) => unknown;

const handlers = new Map<string, Handler>();
const listeners = new Map<string, Handler[]>();

/**
 * The sender every handler is given.
 *
 * On the desktop this is a `WebContents` and `send` crosses a process
 * boundary. Here the renderer and the core are the same context, so `send` is
 * a direct dispatch to whatever registered for that channel — which is what
 * makes `onEvent`, `onPeers` and the rest work without an IPC layer.
 */
const subscribers = new Map<string, Set<(...args: unknown[]) => void>>();

export function subscribe(
  channel: string,
  handler: (...args: unknown[]) => void,
): () => void {
  let set = subscribers.get(channel);
  if (!set) {
    set = new Set();
    subscribers.set(channel, set);
  }
  set.add(handler);
  return () => set!.delete(handler);
}

const sender = {
  isDestroyed: () => false,
  send(channel: string, ...args: unknown[]): void {
    const set = subscribers.get(channel);
    if (!set) return;

    for (const handler of [...set]) {
      try {
        handler(...args);
      } catch (error) {
        // A throwing listener must not take down whatever emitted the event.
        // On the desktop the process boundary provided that isolation for
        // free; here there is none, so it has to be explicit.
        console.error(`[ipc] listener for "${channel}" threw:`, error);
      }
    }
  },
};

const event = { sender };

export const ipcMain = {
  handle(channel: string, handler: Handler): void {
    handlers.set(channel, handler);
  },

  on(channel: string, handler: Handler): void {
    const list = listeners.get(channel) ?? [];
    list.push(handler);
    listeners.set(channel, list);
  },

  removeHandler(channel: string): void {
    handlers.delete(channel);
  },
};

/**
 * Call a registered handler.
 *
 * Async even when the handler is not, so the surface matches
 * `ipcRenderer.invoke` exactly — the interface awaits every one of these, and
 * a method that happened to return synchronously here and asynchronously on
 * the desktop would be a difference nobody would notice until it mattered.
 */
export async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);

  if (!handler) {
    throw new Error(`no handler registered for "${channel}"`);
  }

  return await handler(event, ...(args as never[]));
}

export function send(channel: string, ...args: unknown[]): void {
  for (const handler of listeners.get(channel) ?? []) {
    handler(event, ...(args as never[]));
  }
}

/** Whether a channel exists, so the bridge can report an unimplemented call. */
export function has(channel: string): boolean {
  return handlers.has(channel);
}

// ---- safeStorage ------------------------------------------------------------

/**
 * The private key at rest.
 *
 * On the desktop this is the OS keychain. iOS has one too, but reaching it
 * needs a native plugin, and the honest position is that this build does not
 * have one yet — so rather than pretend, this passes the bytes through and
 * says so.
 *
 * That is not as weak as it sounds: the file lands in the app's private
 * container, which is sandboxed from every other app and encrypted at rest by
 * the device whenever it is locked. What is missing compared to the desktop is
 * protection from somebody who has already extracted the container.
 *
 * `isEncryptionAvailable` returns false, which is the truthful answer, and
 * `keystore.ts` already handles that case — it stores the key unwrapped rather
 * than silently believing it is protected.
 */
export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return false;
  },

  encryptString(text: string): Buffer {
    return Buffer.from(text, "utf8");
  },

  decryptString(data: Buffer): string {
    return Buffer.from(data).toString("utf8");
  },
};

// ---- the rest ---------------------------------------------------------------
//
// `diagnostics.ts` imports `BrowserWindow` and never constructs one on this
// path; it is here so the import resolves.

export const BrowserWindow = {
  getAllWindows: () => [] as unknown[],
  fromWebContents: () => undefined,
};

export const Notification = class {
  static isSupported(): boolean {
    return false;
  }
  show(): void {}
  on(): void {}
};

export const shell = { openExternal: async () => {} };

export default { app, ipcMain, safeStorage, BrowserWindow, Notification, shell };
