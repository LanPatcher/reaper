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
   * Keep the app running in the background, by whatever mechanism the
   * platform actually grants that for.
   *
   * **iOS**: an audio session, `.playback` with `.mixWithOthers`, playing
   * silence — it earns background execution without becoming the "now
   * playing" app, so nothing else is paused, ducked, or handed to the lock
   * screen controls. Reachability is "usually", not "always": memory
   * pressure, a reboot, or a force-quit all end it, and there is no way
   * around that on iOS — see `Keepalive.swift`.
   *
   * **Android**: a genuine foreground service with a persistent
   * notification, which is a real, sanctioned "stay alive" grant rather
   * than a workaround — the process is not suspended for being in the
   * background at all while the service runs, `START_STICKY` asks the
   * system to recreate it if it is killed for memory, and the persistent
   * notification is what the platform requires in exchange for the grant
   * (Android will not run an invisible background service indefinitely).
   * A user can still force-stop the app from system settings, and a reboot
   * still ends it until reopened — the same honest limits as iOS, reached
   * by a stronger mechanism.
   */
  start(): Promise<KeepaliveStatus>;

  /** Give the background grant back. The app may be suspended/stopped afterwards. */
  stop(): Promise<KeepaliveStatus>;

  /**
   * Enter or leave call mode.
   *
   * On iOS: at rest the app claims `.playback`, which leaves other audio on
   * the device alone. A call needs the microphone, so it claims
   * `.playAndRecord` and the hands-free Bluetooth profile — which costs
   * quality for everything playing, and is why it is only claimed while a
   * call is actually up.
   *
   * On Android this is a no-op: the foreground service already grants full
   * background execution regardless of call state, so there is no
   * equivalent trade to make.
   */
  setInCall(options: { active: boolean }): Promise<{ ok: boolean }>;

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
