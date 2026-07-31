import { join } from "node:path";

import {
  BrowserWindow,
  Menu,
  MenuItem,
  app,
  desktopCapturer,
  ipcMain,
  nativeImage,
  screen,
  session,
} from "electron";

import windowIconAsset from "../../assets/desktop/icon.png?asset";

import {
  CLIENT_SCHEME,
  CLIENT_URL,
  getClientDir,
  hasBundledClient,
} from "./clientProtocol";
import { config } from "./config";
import { attachDiagnostics, getLogPath, log } from "./diagnostics";
import { updateTrayMenu } from "./tray";

// global reference to main window
export let mainWindow: BrowserWindow;

/**
 * Work out what to load.
 *
 * Either an explicitly forced remote server, or the client bundled into this
 * app. There is deliberately no fallback to a public instance when the bundle
 * is missing.
 *
 * An earlier version did fall back, and it was actively harmful: a build
 * packaged before the web client had finished building silently loaded
 * https://stoat.chat/app instead. The app looked like it worked, so the
 * missing bundle presented as "the customisations aren't there" rather than
 * "there is no bundle" — and it quietly pointed users at a server that isn't
 * yours. Failing visibly is better; the protocol handler serves a diagnostic
 * page explaining what to do.
 */
function resolveBuildUrl(): URL {
  if (app.commandLine.hasSwitch("force-server")) {
    return new URL(app.commandLine.getSwitchValue("force-server"));
  }

  // No check for a bundled client here, unlike the server-backed build.
  //
  // This app serves its own local interface from the protocol handler, so
  // there is nothing to be missing. `client-dist` is optional and only used
  // for assets the local client references.
  return new URL(CLIENT_URL);
}

// currently in-use build
export const BUILD_URL = resolveBuildUrl();

/**
 * Whether we are running the client bundled into this app
 */
export const USING_BUNDLED_CLIENT = BUILD_URL.protocol.startsWith(CLIENT_SCHEME);

// internal window state
let shouldQuit = false;

/**
 * Protocol of a URL, or "" if it doesn't parse.
 *
 * The renderer is not trusted to send a sane URL here — a compromised page
 * could ask the main process to "download" a `file://` path, which Chromium
 * will happily copy out of the local filesystem.
 */
function safeProtocol(candidate: string): string {
  try {
    return new URL(candidate).protocol;
  } catch {
    return "";
  }
}

// load the window icon
const windowIcon = nativeImage.createFromDataURL(windowIconAsset);

// windowIcon.setTemplateImage(true);

/**
 * Create the main application window
 */
export function createMainWindow() {
  // (CLI arg --hidden or config)
  const startHidden =
    app.commandLine.hasSwitch("hidden") || config.startMinimisedToTray;
  const isMacOS = process.platform === "darwin";

  // create the window
  mainWindow = new BrowserWindow({
    minWidth: 300,
    minHeight: 300,
    width: 1280,
    height: 720,
    backgroundColor: "#191919",
    frame: isMacOS ? true : !config.customFrame,
    titleBarStyle: isMacOS ? "hidden" : "default",
    trafficLightPosition: isMacOS ? { x: 8, y: 8 } : undefined,
    icon: windowIcon,
    show: !startHidden,
    webPreferences: {
      // relative to `.vite/build`
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,

      // Chromium throttles timers in a backgrounded window — down to roughly
      // one wake per minute — which is sensible for a web page and ruinous
      // here. Voice is captured on a timer: a recorder is started, stopped a
      // few hundred milliseconds later, and the segment is sent. Throttled,
      // that loop stops almost entirely, so alt-tabbing out of the app made
      // the microphone appear to die while the call carried on around it.
      //
      // The cost is that a hidden window keeps running its timers, which is
      // exactly what an app in a call needs to do.
      backgroundThrottling: false,
    },
  });

  // hide the options
  mainWindow.setMenu(null);

  // Restore the previous size and position, but only somewhere it can
  // actually be seen.
  //
  // The saved state was being applied unconditionally, which strands the
  // window whenever the display setup has changed since it was written —
  // unplugging a second monitor, or a resolution change. It reopens at
  // coordinates that no longer exist, mostly or entirely off-screen, and
  // because the frame is hidden there is no titlebar to drag it back with.
  {
    const state = config.windowState;

    const width = state.width > 0 ? state.width : 1280;
    const height = state.height > 0 ? state.height : 720;

    // Match against the display nearest the saved position rather than the
    // primary one, so a window legitimately living on a second monitor is
    // restored there instead of being yanked to the main screen.
    const area = screen.getDisplayNearestPoint({
      x: state.x ?? 0,
      y: state.y ?? 0,
    }).workArea;

    const clampedWidth = Math.min(width, area.width);
    const clampedHeight = Math.min(height, area.height);

    mainWindow.setSize(clampedWidth, clampedHeight);

    if (state.x > 0 || state.y > 0) {
      // Keep the whole window inside the work area. Clamping the top-left
      // alone would still allow the bottom and right edges to hang off.
      const x = Math.max(
        area.x,
        Math.min(state.x, area.x + area.width - clampedWidth),
      );
      const y = Math.max(
        area.y,
        Math.min(state.y, area.y + area.height - clampedHeight),
      );

      mainWindow.setPosition(Math.round(x), Math.round(y));
    } else {
      mainWindow.center();
    }
  }

  // maximise the window if it was maximised before
  if (config.windowState.isMaximised) {
    mainWindow.maximize();
  }

  // Wire up logging before the first load, so a failure during that load is
  // captured rather than missed.
  attachDiagnostics(mainWindow);

  log("[startup]", `version=${app.getVersion()}`, `packaged=${app.isPackaged}`);
  log("[startup]", `loading=${BUILD_URL.toString()}`);
  log("[startup]", `clientDir=${getClientDir()}`);
  log("[startup]", `bundlePresent=${hasBundledClient()}`);
  log("[startup]", `logFile=${getLogPath()}`);

  // load the entrypoint
  mainWindow.loadURL(BUILD_URL.toString());

  // minimise window to tray
  mainWindow.on("close", (event) => {
    if (!shouldQuit && config.minimiseToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // update tray menu when window is shown/hidden
  mainWindow.on("show", updateTrayMenu);
  mainWindow.on("hide", updateTrayMenu);

  // keep track of window state
  function generateState() {
    config.windowState = {
      x: mainWindow.getPosition()[0],
      y: mainWindow.getPosition()[1],
      width: mainWindow.getSize()[0],
      height: mainWindow.getSize()[1],
      isMaximised: mainWindow.isMaximized(),
    };
  }

  mainWindow.on("maximize", generateState);
  mainWindow.on("unmaximize", generateState);
  mainWindow.on("moved", generateState);
  mainWindow.on("resized", generateState);

  // rebind zoom controls to be more sensible
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.control && (input.key === "=" || input.key === "+")) {
      // zoom in (+)
      event.preventDefault();
      mainWindow.webContents.setZoomLevel(
        mainWindow.webContents.getZoomLevel() + 1,
      );
    } else if (input.control && input.key === "-") {
      // zoom out (-)
      event.preventDefault();
      mainWindow.webContents.setZoomLevel(
        mainWindow.webContents.getZoomLevel() - 1,
      );
    } else if (input.control && input.key === "0") {
      // reset zoom to default.
      event.preventDefault();
      mainWindow.webContents.setZoomLevel(0);
    } else if (
      input.key === "F5" ||
      ((input.control || input.meta) && input.key.toLowerCase() === "r")
    ) {
      event.preventDefault();
      mainWindow.webContents.reload();
    }
  });

  // send the config
  mainWindow.webContents.on("did-finish-load", () => config.sync());

  // configure spellchecker context menu
  mainWindow.webContents.on("context-menu", (_, params) => {
    const menu = new Menu();

    // add all suggestions
    for (const suggestion of params.dictionarySuggestions) {
      menu.append(
        new MenuItem({
          label: suggestion,
          click: () => mainWindow.webContents.replaceMisspelling(suggestion),
        }),
      );
    }

    // allow users to add the misspelled word to the dictionary
    if (params.misspelledWord) {
      menu.append(
        new MenuItem({
          label: "Add to dictionary",
          click: () =>
            mainWindow.webContents.session.addWordToSpellCheckerDictionary(
              params.misspelledWord,
            ),
        }),
      );
    }

    // add an option to toggle spellchecker
    menu.append(
      new MenuItem({
        label: "Toggle spellcheck",
        click() {
          config.spellchecker = !config.spellchecker;
        },
      }),
    );

    // show menu if we've generated enough entries
    if (menu.items.length > 0) {
      menu.popup();
    }
  });

  // Create display media request handler
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => {
          // Shortcut for linux wayland.
          if (sources.length == 1) {
            // TODO: Get audio to work with wayland
            // See vencord for an implementation using a virtual microphone.
            request.audioRequested
              ? callback({
                  video: sources[0],
                  audio: "loopback",
                })
              : callback({
                  video: sources[0],
                });
            return;
          }
          // No renderer-side picker exists to answer a choice, so rather than
          // block on a selection that can never arrive — which is why sharing
          // "did nothing" on the desktop — grant the primary screen. That is
          // what sharing a screen means by default.
          if (!sources[0]) { callback({}); return; }
          request.audioRequested
            ? callback({ video: sources[0], audio: "loopback" })
            : callback({ video: sources[0] });
        })
        .catch((error) => {
          log("[screenshare] could not enumerate screens:", String(error));
          callback({});
        });
    },
    // Deterministically use the callback above (the primary screen) rather than
    // a system picker that was not engaging on Windows and left the share doing
    // nothing. A source picker can be added later; working comes first.
    { useSystemPicker: false },
  );

  // save a file to disk, showing the OS save dialog
  ipcMain.on("downloadFile", (_, url: string) => {
    if (!/^https?:$/.test(safeProtocol(url))) {
      log("[download] refused non-http url:", url);
      return;
    }

    log("[download]", url);
    mainWindow.webContents.downloadURL(url);
  });

  // push world events to the window
  ipcMain.on("minimise", () => mainWindow.minimize());
  ipcMain.on("maximise", () =>
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(),
  );
  ipcMain.on("close", () => mainWindow.close());

  // mainWindow.webContents.openDevTools();

  // let i = 0;
  // setInterval(() => setBadgeCount((++i % 30) + 1), 1000);
}

/**
 * Quit the entire app
 */
export function quitApp() {
  shouldQuit = true;
  mainWindow.close();
}

// Ensure global app quit works properly
app.on("before-quit", () => {
  shouldQuit = true;
});
