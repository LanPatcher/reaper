import { Notification, ipcMain } from "electron";

import { mainWindow } from "./window";

/**
 * Desktop notifications.
 *
 * ## Why these go through the main process
 *
 * A renderer can construct a `Notification` on its own, and it would mostly
 * work. What it cannot do is bring the window back: clicking a notification
 * has to show, restore and focus a window that may be minimised or hidden in
 * the tray, and all three of those are main-process operations. Routing the
 * whole thing through here keeps the click and the window in one place
 * instead of splitting them across the boundary.
 *
 * ## What is in them
 *
 * Who, and where. Never what.
 *
 * A notification on Windows is not private: it is composed by the app but
 * delivered by the shell, drawn over the lock screen by default, and kept in
 * the Action Centre after it is dismissed — where it outlives the app being
 * closed and is readable by anyone at the machine. Putting message text in
 * there would quietly undo the part of this app that is the whole point.
 *
 * A name and a place is enough to decide whether to look, which is all a
 * notification is for.
 */

/** What the renderer asks for. Note the absence of anywhere to put a body. */
export interface NotifyRequest {
  /** Who it is from. */
  who: string;

  /** Where it landed — a server and channel, or a group name. */
  where: string;

  /** Whether they were addressing you specifically. */
  direct?: boolean;

  /**
   * Opaque routing information, handed back untouched when the notification is
   * clicked.
   *
   * Deliberately not interpreted here. The main process has no idea what a
   * conversation is, and teaching it would mean two places that have to agree
   * about how communities are addressed.
   */
  go?: unknown;
}

/** Notifications still on screen, so the click handlers stay reachable. */
const live = new Set<Notification>();

export function registerNotifications(): void {
  ipcMain.on("notify", (event, request: NotifyRequest) => {
    if (!Notification.isSupported()) return;
    if (!request || typeof request.who !== "string") return;

    const notification = new Notification({
      title: request.who,
      // The place, and nothing else. `direct` earns a word rather than a
      // preview: it is the difference between "worth interrupting for" and
      // "worth knowing about", which is what somebody glancing at this needs.
      body: request.direct
        ? `${request.where} — mentioned you`
        : request.where,
      // The app plays its own sounds, and it distinguishes a mention from an
      // ordinary message. Letting Windows play one as well means two.
      silent: true,
    });

    notification.on("click", () => {
      // Back to the front, from wherever it was. Minimised, hidden in the
      // tray and merely behind another window are three different states and
      // all three have to end the same way.
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }

      // Told to the renderer that asked for it, not broadcast: the window may
      // have been reloaded since, in which case there is nothing listening and
      // the click simply brings the app forward.
      if (!event.sender.isDestroyed()) {
        event.sender.send("notifyClick", request.go ?? null);
      }
    });

    notification.on("close", () => live.delete(notification));

    // Held onto deliberately. A Notification that is only referenced by the
    // shell can be collected while it is still on screen, and its click
    // handler goes with it — which presents as notifications that work until
    // the garbage collector runs and then silently stop.
    live.add(notification);
    notification.show();
  });
}
