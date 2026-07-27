import { BrowserWindow, app, shell } from "electron";
import started from "electron-squirrel-startup";

import {
  registerClientProtocol,
  registerClientScheme,
} from "./native/clientProtocol";
// Registers the setBadgeCount handler. Without this import the module is
// tree-shaken out entirely and the renderer's badge calls reach nothing —
// which is exactly what was happening.
import "./native/badges";
// Same reason: this module is nothing but two IPC handlers, so nothing
// referenced it and the bundler removed it. The renderer's "start with
// Windows" switch was calling into a channel that did not exist.
import "./native/autoLaunch";
import { config } from "./native/config";
import { log } from "./native/diagnostics";
import { registerNotifications } from "./native/notify";
import { initTray } from "./native/tray";
import { startUpdates } from "./native/updates";
import { BUILD_URL, createMainWindow, mainWindow } from "./native/window";
import { registerP2PHandlers, shutdownP2P } from "./p2p/bridge";

// Scheme privileges have to be declared before the app becomes ready, so this
// runs at module scope rather than inside the ready handler below.
registerClientScheme();

// Squirrel-specific logic
// create/remove shortcuts on Windows when installing / uninstalling
// we just need to close out of the app immediately
if (started) {
  app.quit();
}

// disable hw-accel if so requested
if (!config.hardwareAcceleration) {
  app.disableHardwareAcceleration();
}

// ensure only one copy of the application can run
const acquiredLock = app.requestSingleInstanceLock();

/**
 * Whether a URL belongs to the app itself and may be navigated to in-window.
 *
 * Compares scheme and host rather than `origin`, because the WHATWG URL parser
 * reports `"null"` as the origin for every non-special scheme. Using `origin`
 * would therefore treat any custom-scheme URL as internal, not just ours.
 */
function isInternalUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return (
      url.protocol === BUILD_URL.protocol &&
      url.host === BUILD_URL.host &&
      // For http(s) builds the port is part of identity; for custom schemes
      // it's always empty, so this is a no-op there.
      url.port === BUILD_URL.port
    );
  } catch {
    return false;
  }
}

if (acquiredLock) {
  // Updates, from wherever this build was told to look. See
  // `src/native/updates.ts` — it is a directory of static files on a server
  // you control, not a service, and it is off unless a URL was given.
  startUpdates();

  // create and configure the app when electron is ready
  app.on("ready", () => {
    // Before anything can raise a notification. Windows matches this against
    // the shortcut the installer wrote to decide which app a notification
    // belongs to; set it late and the first ones are attributed to whatever
    // Electron guessed instead.
    //
    // Changed with the rename, which means a notification raised before the
    // new installer has run may still carry the old name until it does.
    if (process.platform === "win32") {
      app.setAppUserModelId("chat.reaper.notifications");
    }

    // serve the bundled client before anything tries to load it
    registerClientProtocol();

    // Local event store. Registered before the window exists, because the
    // renderer may call into it during its very first render — an IPC message
    // arriving before its handler is installed is silently dropped, and shows
    // up as history that is mysteriously empty on a cold start and fine on a
    // reload.
    // Guarded because a throw here is an uncaught exception in the main
    // process, which Electron shows as a modal error and then quits. Losing
    // networking is bad; refusing to open the app at all is worse, and leaves
    // no way to reach the settings that might fix it.
    try {
      registerP2PHandlers();
    } catch (error) {
      log("[p2p] failed to initialise:", String(error));
    }

    // create window and application contexts
    createMainWindow();

    // Desktop notifications. After the window exists, because clicking one
    // has to bring that window back.
    registerNotifications();

    // save first launch state
    if (config.firstLaunch) {
      // Doesn't do anything right now. Used to enable auto start, but that behaviour was removed.
      // Left in case it gets used in the future.
      config.firstLaunch = false;
    }

    initTray();
  });

  // focus the window if we try to launch again
  app.on("second-instance", () => {
    mainWindow.show();
    mainWindow.restore();
    mainWindow.focus();
  });

  // macOS specific behaviour to keep app active in dock:
  // (irrespective of the minimise-to-tray option)

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  // Appends are buffered so batches compress usefully, which leaves up to a
  // couple of seconds of messages in memory at any moment. Flush them, or the
  // buffering that makes storage cheap would cost data on every quit.
  app.on("before-quit", shutdownP2P);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // ensure URLs launch in external context
  app.on("web-contents-created", (_, contents) => {
    // prevent navigation out of build URL origin
    contents.on("will-navigate", (event, navigationUrl) => {
      const internal = isInternalUrl(navigationUrl);
      log("[will-navigate]", navigationUrl, internal ? "allowed" : "BLOCKED");

      if (!internal) {
        event.preventDefault();
      }
    });

    // handle links externally
    contents.setWindowOpenHandler(({ url, disposition }) => {
      // Chromium reports this for a link it decided should be saved rather
      // than opened. Sending it to the system browser would be actively
      // wrong, so download it here instead. The client's download buttons
      // call `native.downloadFile` directly and don't rely on this, but any
      // other download link in the app lands here.
      if (disposition === "save-to-disk") {
        log("[download]", url);
        contents.downloadURL(url);
        return { action: "deny" };
      }

      if (
        url.startsWith("http:") ||
        url.startsWith("https:") ||
        url.startsWith("mailto:")
      ) {
        setImmediate(() => {
          shell.openExternal(url);
        });
      }

      return { action: "deny" };
    });
  });
} else {
  app.quit();
}
