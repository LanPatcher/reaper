import { App } from "@capacitor/app";

/**
 * Whether the app is being looked at.
 *
 * One place that knows, because three things now depend on it and they must
 * not be able to disagree:
 *
 *   - **Notifications.** Raised only while the app is in the background. A
 *     banner drawn over the conversation somebody is already reading is noise,
 *     and the interface has its own in-window notice for that case.
 *   - **Presence.** What other people see. Foreground means online; background
 *     means offline, which is what the user asked for and is the more private
 *     of the two available answers.
 *   - **Flushing.** Already handled in `boot.ts`, and left there — it is about
 *     surviving termination rather than about being looked at.
 *
 * Read through Capacitor's `appStateChange` rather than the page's
 * `visibilitychange`. They usually agree and the one time they do not is the
 * one that matters: iOS can leave a WebView visible while the app is not
 * frontmost, so a page that trusted `document.hidden` would report somebody as
 * present while they were looking at something else entirely.
 */

/**
 * Assumed true until told otherwise.
 *
 * The app has just launched, which on iOS means somebody opened it. Starting
 * from `false` would announce a user as offline for the fraction of a second
 * before the first event arrives, and presence changes are broadcast — so that
 * fraction of a second reaches other people.
 */
let foreground = true;

const watchers = new Set<(active: boolean) => void>();

export function isForeground(): boolean {
  return foreground;
}

/**
 * Be told when it changes.
 *
 * Called immediately with the current state, so a subscriber never has to
 * handle "I do not know yet" as a third case.
 */
export function onForeground(handler: (active: boolean) => void): () => void {
  watchers.add(handler);
  handler(foreground);
  return () => watchers.delete(handler);
}

let watching = false;

export function watchForeground(): void {
  if (watching) return;
  watching = true;

  void App.addListener("appStateChange", ({ isActive }) => {
    if (isActive === foreground) return;

    foreground = isActive;
    for (const watcher of watchers) {
      try {
        watcher(isActive);
      } catch (error) {
        // One subscriber failing must not stop the others being told. A
        // presence update that did not happen because a notification handler
        // threw is the kind of coupling that is impossible to find later.
        console.warn("[lifecycle] a foreground watcher failed:", error);
      }
    }
  });
}
