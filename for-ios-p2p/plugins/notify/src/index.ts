import { registerPlugin } from "@capacitor/core";

/**
 * Notifications, posted by this app about itself.
 *
 * ## Why these are local and not push
 *
 * Apple's push service delivers what a *server* sends it. There is no server
 * here and there is not going to be one — that is the whole design, and adding
 * one to carry notifications would mean handing a third party the one fact
 * this app exists to keep: who is talking to whom, and when.
 *
 * So the app raises its own. It can, because it is still running: the keepalive
 * audio session keeps the process alive in the background, the Tor circuits and
 * sockets stay open, and messages keep arriving over them. What was missing was
 * only the part that tells the person holding the phone.
 *
 * From the user's side the difference is invisible — same banner, same lock
 * screen, same tap-to-open. From everyone else's side the difference is that
 * Apple never learns a message was sent.
 *
 * The cost is honest and worth stating: if iOS suspends or terminates the app
 * anyway — the user force-quits it, or the system reclaims memory under
 * pressure — nothing is running to notice a message, so nothing is announced.
 * A server-backed app would still buzz. This one cannot, and it says so rather
 * than pretending.
 */

export interface NotifyPermission {
  /** Whether notifications may be posted right now. */
  granted: boolean;

  /**
   * Whether the user has been asked yet.
   *
   * Distinguished because the two need opposite handling: not-yet-asked is
   * resolved by asking, and refused is not — asking again does nothing at all,
   * and a settings screen should say so rather than offering a button that
   * cannot work.
   */
  asked: boolean;
}

export interface NotifyPlugin {
  /**
   * Ask the user, once.
   *
   * Resolves with the answer either way. Calling it again after a refusal is
   * harmless and returns the refusal; iOS does not show the prompt twice.
   */
  request(): Promise<NotifyPermission>;

  /** Whether notifications may be posted, without prompting for anything. */
  permission(): Promise<NotifyPermission>;

  /**
   * Post one.
   *
   * `id` replaces any notification already showing with the same id, which is
   * what keeps a busy conversation to one entry in the shade rather than
   * forty. `data` comes back untouched when it is tapped.
   */
  show(options: {
    id?: string;
    title: string;
    body: string;
    data?: string;

    /** Whether to make a sound. Off for anything the app already chimed for. */
    sound?: boolean;
  }): Promise<void>;

  /** Take everything of ours out of the notification shade. */
  clear(): Promise<void>;

  /** The number on the app icon. Zero removes it. */
  badge(options: { count: number }): Promise<void>;

  /**
   * A notification was tapped.
   *
   * Carries whatever `data` was posted with it. Anything that arrived while no
   * listener was attached — which is every tap that launched the app, because
   * the JavaScript starts after the tap — is delivered as soon as one is.
   */
  addListener(
    event: "tapped",
    handler: (event: { data: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

export const Notify = registerPlugin<NotifyPlugin>("Notify", {
  // A browser has its own Notification API and nothing here should pretend to
  // be it. The dev server is not where this behaviour is worth exercising, and
  // a stub that half worked would make it look as though it were.
  web: () => ({
    request: async () => ({ granted: false, asked: false }),
    permission: async () => ({ granted: false, asked: false }),
    show: async () => {},
    clear: async () => {},
    badge: async () => {},
    addListener: async () => ({ remove: async () => {} }),
  }),
});
