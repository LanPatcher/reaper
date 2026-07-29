import { invoke, subscribe } from "../../for-ios-p2p/src/shim/electron";

import { flush } from "./shim/fs";

/**
 * `window.p2p` and `window.native`, the surfaces the interface talks to.
 *
 * The desktop exposes these from a preload script over Electron IPC. Here — as
 * on the phone — the core and the page are the same JavaScript context, so
 * every call goes straight into the handler `bridge.ts` registered, through
 * the `ipcMain` shim that collected them into a map instead of a channel.
 *
 * Generated from the channel names rather than written out by hand, for the
 * reason the iOS build gives: the interface is the desktop's own file and it
 * will call whatever it calls. A hand-written surface is a list of the methods
 * somebody remembered, and the ones they forgot fail at runtime as a screen
 * that does not react.
 */

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

const METHODS = [
  "identity", "open", "append", "events", "heads", "merge", "stats", "close",
  "netStart", "netConnect", "netPeers", "netInfo", "netSignal", "netAudio",
  "netAnnounce", "netFocus", "netDrop", "netTune", "netLog", "netStats",
  "netStatsReset", "setKey", "dmKey", "wrapKey", "unwrapKey",
  "exportCommunity", "importCommunity", "communities", "sharedWith", "compact",
  "torStatus",
  "putBlob", "getBlob", "hasBlob", "wantBlob", "sweepBlobs", "forgetBlob",
  "deviceInfo", "deviceName", "deviceTakeOver",
  "pairInvite", "pairRevoke", "pairJoin", "pairSync",
  "linkOpen",
  "syncDevices", "syncWith",
] as const;

type Surface = Record<string, unknown>;

/**
 * Calls that must reach storage before they are allowed to look finished.
 *
 * The same list as the phone and for the same reason: writes are debounced, and
 * linking ends with the interface calling `location.reload()` — which throws
 * away the JavaScript context and every pending write with it, including the
 * account it was just handed.
 *
 * A browser reloads far more casually than an app restarts, so if anything this
 * matters more here.
 */
const DURABLE = new Set<string>([
  "pairJoin",
  "pairSync",
  "syncDevices",
  "syncWith",
  "deviceTakeOver",
  "deviceName",
  "importCommunity",
  "compact",
]);

export function installBridge(): void {
  const p2p: Surface = {};

  for (const name of METHODS) {
    p2p[name] = DURABLE.has(name)
      ? async (...args: unknown[]) => {
          try {
            return await invoke(`p2p:${name}`, ...args);
          } finally {
            await flush().catch(() => {});
          }
        }
      : (...args: unknown[]) => invoke(`p2p:${name}`, ...args);
  }

  for (const [name, channel] of Object.entries(STREAMS)) {
    p2p[name] = (handler: (...args: unknown[]) => void) => subscribe(channel, handler);
  }

  (globalThis as Record<string, unknown>).p2p = p2p;
}

/**
 * The smaller surfaces: window controls, notifications, and desktop settings.
 *
 * A tab has no window to minimise and no autostart, so those answer honestly
 * and the interface hides the controls. Notifications it does have — the
 * browser's own, which need no server and no relay.
 */
export function installNative(): void {
  (globalThis as Record<string, unknown>).native = {
    versions: {
      node: () => "",
      chrome: () => "",
      electron: () => "",
      desktop: () => "web",
    },

    minimise: () => {},
    maximise: () => {},
    close: () => {},

    setBadgeCount: (count: number) => {
      // Supported in a few browsers and absent in most. Attempted rather than
      // skipped, because where it works it is the least intrusive way to say
      // something is waiting.
      const badge = navigator as unknown as {
        setAppBadge?: (n?: number) => Promise<void>;
        clearAppBadge?: () => Promise<void>;
      };

      const n = Number(count) || 0;

      try {
        if (n > 0) void badge.setAppBadge?.(n)?.catch(() => {});
        else void badge.clearAppBadge?.()?.catch(() => {});
      } catch {
        // Not supported. Nothing to report and nothing lost.
      }
    },

    setInCall: () => {},

    downloadFile: (name: string, base64: string, type?: string) => {
      // A browser saving a file is the one native thing a browser is best at.
      try {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(
          new Blob([bytes], { type: type || "application/octet-stream" }),
        );

        const link = document.createElement("a");
        link.href = url;
        link.download = name || "file";
        link.click();

        // Released on the next turn, not immediately: revoking before the
        // click has been processed cancels the download.
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      } catch (error) {
        console.warn("[native] could not save that file:", error);
      }
    },

    /**
     * A message arrived somewhere the reader is not looking.
     *
     * The browser's own notifications, which involve nobody: no push service,
     * no relay, no server. They only appear while the page is open, which for
     * a tab is the only time it is running at all — the same honest limit the
     * phone build has when the app is force-quit, and here it is the normal
     * case rather than the exception.
     *
     * Everything about *whether* to interrupt — muting, notifications off,
     * already reading it, arriving versus backfilled — has already been
     * decided by the shared interface before this is called.
     */
    notify: (what: {
      who?: string;
      where?: string;
      direct?: boolean;
      go?: { community?: string; channelId?: string | null };
    }) => {
      if (typeof Notification === "undefined") return;
      if (Notification.permission !== "granted") return;

      // Only when the tab is not being looked at. A banner over the
      // conversation somebody is already reading is noise, and the interface
      // draws its own notice for that case.
      if (document.visibilityState === "visible") return;

      try {
        const note = new Notification(String(what?.who || "Someone"), {
          body: what?.direct
            ? "Sent you a message"
            : what?.where ? `Wrote in ${what.where}` : "Wrote a message",

          // One entry per conversation, so a busy channel replaces its own
          // rather than stacking forty.
          tag: `msg:${what?.go?.community ?? "?"}:${what?.go?.channelId ?? ""}`,
        });

        note.onclick = () => {
          window.focus();
          for (const handler of tapped) handler(what?.go ?? {});
          note.close();
        };
      } catch {
        // Refused, or unsupported. The unread mark is already drawn and does
        // not depend on anybody's permission.
      }
    },

    onNotifyClick: (handler: (go: unknown) => void) => { tapped.add(handler); },

    notify_: undefined,

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

/** Whoever wants to know a notification was clicked. */
const tapped = new Set<(go: unknown) => void>();

/**
 * Ask about notifications, once, after the interface is up.
 *
 * Not during startup: a permission prompt over a loading screen asks somebody
 * to decide before they have seen the app, and browsers increasingly refuse to
 * show one that was not prompted by a gesture. Requested on the first click
 * instead, which is both allowed everywhere and the first moment the answer
 * means anything.
 */
export function askAboutNotifications(): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "default") return;

  const ask = () => {
    document.removeEventListener("click", ask);
    void Notification.requestPermission().catch(() => undefined);
  };

  document.addEventListener("click", ask, { once: true });
}
