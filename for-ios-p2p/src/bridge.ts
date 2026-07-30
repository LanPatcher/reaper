import { Keepalive } from "@reaper/keepalive";
import { Notify } from "@reaper/notify";
import { Scanner } from "@reaper/scanner";

import { isForeground, onForeground } from "./lifecycle";
import { invoke, subscribe } from "./shim/electron";
import { flush } from "./shim/fs";

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
  onPresence: "p2p:presence",
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
  "torStatus",
  "putBlob", "getBlob", "hasBlob", "wantBlob", "sweepBlobs", "forgetBlob",
  "setPresence",
  "deviceInfo", "deviceName", "deviceTakeOver",
  "pairInvite", "pairRevoke", "pairJoin", "pairSync",
  "linkOpen",
  "syncDevices", "syncWith",
] as const;

type Surface = Record<string, unknown>;

/**
 * Calls that must reach the disk before they are allowed to look finished.
 *
 * ## Why this list exists
 *
 * Writes here are debounced — four hundred milliseconds, which is what makes
 * appending a message cheap enough to do on every keystroke's worth of
 * activity. The cost is a window in which the app's state lives in memory and
 * nowhere else, and almost everything survives it because almost nothing
 * destroys the JavaScript context on purpose.
 *
 * Linking does. `pairJoin` hands this device an account, merges the entire
 * history behind it, and the interface then calls `location.reload()` — which
 * is the correct thing to do, because the page has to come back up as somebody
 * else. It also throws away every pending write.
 *
 * So the phone linked, showed the account for a second, reloaded, and came
 * back as the identity it had before: not linked, no history, and a pairing
 * code on the other device now spent. The link had genuinely succeeded — the
 * desktop learned about it and consumed the invite — and none of it reached
 * the disk.
 *
 * These are all rare, deliberate and user-initiated, so an extra flush costs
 * nothing anybody can perceive. `append` is deliberately *not* here: it happens
 * constantly, and flushing on each one would undo the batching that makes the
 * log cheap to write.
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
            // In a `finally`, because a sync that failed half way through
            // still merged whatever arrived before it broke — and that is
            // exactly the state worth keeping, since the next attempt starts
            // from it rather than from nothing.
            await flush().catch(() => {
              // Nothing useful to say here. A failed write is reported by
              // `flush` itself and retried on the next one.
            });
          }
        }
      : (...args: unknown[]) => invoke(`p2p:${name}`, ...args);
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

    setBadgeCount: (count: number) => {
      void Notify.badge({ count: Number(count) || 0 }).catch(() => {
        // No permission, or an older build. A wrong number on an icon is not
        // worth a line in the log every time a message arrives.
      });
    },

    /**
     * Whether a call is up, which decides the audio session's category.
     *
     * At rest the app claims `.playback`, which leaves other audio on the
     * device alone. A call needs the microphone, so it claims `.playAndRecord`
     * and the hands-free Bluetooth profile — worse quality for everything
     * playing, and therefore claimed only while a call is actually running.
     */
    setInCall: (active: boolean) => {
      void Keepalive.setInCall({ active: Boolean(active) }).catch(() => {
        // A call that cannot switch category still works; it is the quality
        // that suffers, and there is nothing useful to show the user here.
      });
    },

    // Saving a file needs a share sheet, which is a native plugin this build
    // does not have yet. Doing nothing is wrong but quiet; saying so is not.
    downloadFile: () => {
      console.warn("[native] saving files is not implemented on iOS yet");
    },

    /**
     * A message arrived somewhere the reader is not looking.
     *
     * ## What is decided here, and what is not
     *
     * Almost nothing is decided here, on purpose. Whether this message is
     * worth interrupting somebody over has already been settled by the shared
     * interface before this is called: muting, whether the conversation is
     * open, whether the sender is still allowed to reach you, whether
     * notifications are switched off at all, and — since the fix for a phone
     * that buzzed once per message in its entire history — whether the message
     * is arriving or merely being copied across.
     *
     * Two things are left, and both are specific to a phone:
     *
     *   - **Only while in the background.** In the foreground the interface
     *     draws its own notice, and a system banner over the conversation
     *     somebody is already reading is noise. Checked at post time rather
     *     than subscribed to, because the app can be backgrounded between a
     *     message arriving and this running.
     *
     *   - **One entry per conversation.** The identifier is the conversation,
     *     so a busy channel replaces its own row in the shade instead of
     *     stacking forty. Forty banners from one person is not forty times as
     *     informative as one.
     *
     * The message itself is never included, matching the desktop. A
     * notification sits on a lock screen where anyone holding the phone can
     * read it, and "who, and where" is enough to decide whether to pick it up.
     */
    notify: (what: {
      who?: string;
      where?: string;
      direct?: boolean;
      go?: { community?: string; channelId?: string | null };
    }) => {
      if (isForeground()) return;

      const who = String(what?.who || "Someone");
      const where = String(what?.where || "");

      void Notify.show({
        // One per conversation. `go` is what the interface uses to open it, so
        // it is also exactly the right grain for "the same place".
        id: `msg:${what?.go?.community ?? "?"}:${what?.go?.channelId ?? ""}`,
        title: who,
        body: what?.direct
          ? "Sent you a message"
          : where ? `Wrote in ${where}` : "Wrote a message",
        data: JSON.stringify(what?.go ?? {}),
      }).catch(() => {
        // Refused permission, most likely. Nothing to do and nothing worth
        // saying: the interface has already shown the unread mark, which is
        // the part that does not depend on anybody's permission.
      });
    },

    /**
     * Whether the app is being looked at.
     *
     * Offered to the shared interface because the page cannot work it out for
     * itself here: iOS can leave a WebView visible while the app is not
     * frontmost, so `document.hidden` reports somebody as present while they
     * are looking at something else. Presence is broadcast to other people, so
     * that is not a small inaccuracy.
     *
     * Absent on the desktop, and the interface falls back to page visibility
     * there — which is correct, because a desktop window losing focus means
     * somebody looked at their email rather than put the machine away.
     */
    onAppState: (handler: (active: boolean) => void) => onForeground(handler),

    onNotifyClick: (handler: (go: unknown) => void) => {
      void Notify.addListener("tapped", (event) => {
        try {
          handler(JSON.parse(event.data || "{}"));
        } catch {
          // A notification from a build that carried something else. Opening
          // the app is still the right outcome, and it has already happened.
        }
      });
    },

    onceScreenPicker: () => {},
    screenPickerCallback: () => {},

    /**
     * Read a QR code with the camera.
     *
     * Only present on this platform, and the interface checks for it before
     * offering the button — a desktop gets no scan control at all rather than
     * a disabled one, which is a question the user would have to answer for
     * themselves.
     *
     * Resolves with null when the camera is closed without finding anything,
     * which is an ordinary outcome. Only a refused permission rejects.
     */
    scanQr: async (): Promise<string | null> => {
      const found = await Scanner.scan();
      return found.text ?? null;
    },
  };

  (globalThis as Record<string, unknown>).desktopConfig = {
    get: () => undefined,
    read: async () => undefined,
    set: () => {},
    getAutostart: async () => false,
    setAutostart: async () => false,
  };
}
