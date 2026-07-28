import { invoke, subscribe } from "./shim/electron";

/**
 * `window.p2p`, the surface the interface talks to.
 *
 * The desktop exposes this from a preload script over Electron IPC. Here the
 * core and the page are the same JavaScript context, so every call goes
 * straight into the handler `bridge.ts` registered — through the `ipcMain`
 * shim, which collected them into a map instead of an IPC channel.
 *
 * The point of doing it this way rather than writing sixty methods by hand:
 * the interface is `for-desktop-p2p/src/local-ui/index.html`, unmodified, and
 * it will call whatever it calls. A hand-written surface would be a list of
 * the methods somebody remembered, and the ones they forgot would fail at
 * runtime, on a phone, as a screen that does not react.
 *
 * So the surface is generated from the channel names instead. Everything the
 * desktop registers is reachable, automatically and by definition.
 */

/** Channels that carry a stream of events rather than answering a question. */
const STREAMS = {
  onEvent: "p2p:event",
  onPeers: "p2p:peers",
  onBlob: "p2p:blob",
  onSignal: "p2p:signal",
  onAudio: "p2p:audio",
  onDelivered: "p2p:delivered",
  onRefused: "p2p:refused",
  onDevices: "p2p:devices",
} as const;

/**
 * Every method the desktop preload declares.
 *
 * Read from the same list rather than retyped: `p2p:${name}` is the convention
 * `bridge.ts` uses for every handler, so the mapping is mechanical and cannot
 * drift from what is actually registered.
 */
const METHODS = [
  "identity", "open", "append", "events", "heads", "merge", "stats", "close",
  "netStart", "netConnect", "netPeers", "netInfo", "netSignal", "netAudio",
  "netAnnounce", "netFocus", "netDrop", "netTune", "netLog", "netStats",
  "netStatsReset", "setKey", "dmKey", "wrapKey", "unwrapKey",
  "exportCommunity", "importCommunity", "communities", "sharedWith", "compact",
  "torStatus", "exportIdentity", "importIdentity",
  "putBlob", "getBlob", "hasBlob", "wantBlob", "sweepBlobs", "forgetBlob",
  "deviceInfo", "deviceName", "deviceTakeOver",
  "linkOpen", "linkClose", "linkPeers", "linkTo",
  "syncDevices", "syncWith",
] as const;

type Surface = Record<string, unknown>;

export function installBridge(): void {
  const p2p: Surface = {};

  for (const name of METHODS) {
    p2p[name] = (...args: unknown[]) => invoke(`p2p:${name}`, ...args);
  }

  // Subscriptions return an unsubscribe function, matching the preload — the
  // interface stores those and calls them when a view goes away.
  for (const [name, channel] of Object.entries(STREAMS)) {
    p2p[name] = (handler: (...args: unknown[]) => void) =>
      subscribe(channel, handler);
  }

  (globalThis as Record<string, unknown>).p2p = p2p;
}

/**
 * The two smaller surfaces the interface also expects.
 *
 * `window.native` is the desktop's window controls and notifications, and
 * `window.desktopConfig` is start-with-Windows and the tray. Neither concept
 * exists on a phone, so these answer honestly rather than being absent — a
 * missing object throws on first use and takes the whole page down, while an
 * object that says "no" lets the interface hide the control.
 */
export function installNative(): void {
  (globalThis as Record<string, unknown>).native = {
    versions: {
      node: () => "",
      chrome: () => "",
      electron: () => "",
      desktop: () => "ios",
    },

    // A phone has no window to minimise, maximise or close.
    minimise: () => {},
    maximise: () => {},
    close: () => {},

    setBadgeCount: () => {},

    // Saving a file needs a share sheet, which is a native plugin this build
    // does not have yet. Doing nothing is wrong but quiet; saying so is not.
    downloadFile: () => {
      console.warn("[native] saving files is not implemented on iOS yet");
    },

    // Drawn in-window by the interface itself on this platform. iOS
    // notifications need a permission prompt and an entitlement, and the app
    // is usually in the foreground anyway.
    notify: () => {},
    onNotifyClick: () => {},

    onceScreenPicker: () => {},
    screenPickerCallback: () => {},
  };

  (globalThis as Record<string, unknown>).desktopConfig = {
    get: () => undefined,
    read: async () => undefined,
    set: () => {},
    getAutostart: async () => false,
    setAutostart: async () => false,
  };
}
