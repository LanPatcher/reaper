import { registerPlugin } from "@capacitor/core";

export interface KeepaliveStatus {
  /** Whether the silent audio session is currently being held open. */
  running: boolean;

  /**
   * Why it is not, when it is not.
   *
   * Surfaced rather than only logged so the app can say "messages will not
   * arrive while this is closed" honestly, instead of leaving somebody to work
   * that out from messages turning up late and all at once.
   */
  error?: string | null;
}

export interface KeepalivePlugin {
  /**
   * Hold an audio session open so iOS does not suspend the app.
   *
   * The session is `.playback` with `.mixWithOthers` playing silence: it earns
   * background execution without becoming the "now playing" app, so nothing
   * else is paused, ducked, or handed to the lock screen controls.
   */
  start(): Promise<KeepaliveStatus>;

  /** Give the audio session back. The app will suspend normally afterwards. */
  stop(): Promise<KeepaliveStatus>;

  status(): Promise<KeepaliveStatus>;

  addListener(
    event: "backgrounded" | "foregrounded",
    handler: (status: KeepaliveStatus) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

/**
 * On anything that is not iOS this resolves to `running: false` rather than
 * throwing — the desktop build has no such problem to solve, and the browser
 * dev server should not need a stub for every native call.
 */
export const Keepalive = registerPlugin<KeepalivePlugin>("Keepalive", {
  web: () => ({
    start: async () => ({ running: false, error: "not iOS" }),
    stop: async () => ({ running: false }),
    status: async () => ({ running: false, error: "not iOS" }),
    addListener: async () => ({ remove: async () => {} }),
  }),
});
