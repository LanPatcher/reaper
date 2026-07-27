import {
  IUpdateInfo,
  UpdateSourceType,
  updateElectronApp,
} from "update-electron-app";

import { Notification, app } from "electron";

import { log } from "./diagnostics";

/**
 * Updates served from somewhere Ray controls.
 *
 * ## Why not GitHub
 *
 * `updateElectronApp()` with no arguments reads `repository` from
 * package.json and asks `update.electronjs.org` about it. In a fork that
 * means the *upstream* project's releases: turning it on would have this
 * build quietly replace itself with the official Stoat one, losing the local
 * client, the P2P core and everything else here. That is why it has been off.
 *
 * The fix is not a different repository — it is not depending on anyone
 * else's infrastructure at all, which is the same argument the rest of this
 * app makes. Squirrel.Windows can update from plain static files, so a
 * directory on a web server is a complete update server.
 *
 * ## What the server has to hold
 *
 * Exactly what `scripts/release.mjs` produces:
 *
 *   <base>/win32/x64/RELEASES          — the manifest Squirrel reads
 *   <base>/win32/x64/Reaper-1.4.2-full.nupkg
 *   <base>/win32/x64/reaper-setup.exe  — for people installing the first time
 *
 * No application code, no database, no API. `RELEASES` is a text file and the
 * packages beside it are static downloads, so this works on any host that can
 * serve a directory — including a bucket, a CDN, or a Caddy one-liner.
 *
 * ## What this does not give you
 *
 * Authenticity. Squirrel trusts whatever the URL returns, so the guarantee is
 * only as strong as HTTPS and the server: anyone who can serve that path can
 * hand this app an executable and it will run it. Code signing is what fixes
 * that properly, and it costs money and a certificate. Until then the honest
 * summary is that the update channel is exactly as trustworthy as the domain.
 */

/**
 * Where to look.
 *
 * An environment variable so a build can be pointed at a staging host without
 * a code change, falling back to the constant below for ordinary releases.
 * Empty means updates are off, which is the right default for anyone who
 * builds this themselves and has nowhere to serve them from.
 */
const UPDATE_BASE_URL = process.env.REAPER_UPDATE_URL ?? "";

/**
 * How often to ask.
 *
 * Ten minutes is the library's default and far too eager for something whose
 * releases are occasional; every check is a request that says this machine is
 * running Reaper. Six hours still picks up a release the same day.
 */
const UPDATE_INTERVAL = "6 hours";

/**
 * Start checking for updates, if this build was given somewhere to check.
 *
 * Returns whether it did, so the caller can say so in the log rather than
 * leaving "did that do anything?" unanswered.
 */
export function startUpdates(): boolean {
  // Squirrel only exists on Windows, and an unpackaged run has nothing to
  // replace. Both would otherwise throw at startup.
  if (process.platform !== "win32" || !app.isPackaged) return false;

  if (!UPDATE_BASE_URL) {
    log("updates: no update URL configured, staying on this version");
    return false;
  }

  let base: URL;
  try {
    base = new URL(UPDATE_BASE_URL);
  } catch {
    log(`updates: ${UPDATE_BASE_URL} is not a URL, ignoring`);
    return false;
  }

  // Plain HTTP would let anybody on the path hand this machine an executable.
  // Localhost is allowed because that is how the release script is tested.
  const localhost = base.hostname === "127.0.0.1" || base.hostname === "localhost";
  if (base.protocol !== "https:" && !localhost) {
    log(`updates: refusing to check over ${base.protocol}`);
    return false;
  }

  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.StaticStorage,
      // Squirrel appends the platform path itself; the base is everything
      // above it.
      baseUrl: `${UPDATE_BASE_URL.replace(/\/+$/, "")}/${process.platform}/${process.arch}`,
    },
    updateInterval: UPDATE_INTERVAL,
    logger: { log, info: log, warn: log, error: log },
    onNotifyUser: announce,
  });

  log(`updates: checking ${UPDATE_BASE_URL} every ${UPDATE_INTERVAL}`);
  return true;
}

/**
 * Say an update is ready, without stealing focus.
 *
 * The library's own prompt is a modal dialog with a Restart button, which
 * interrupts whatever is being typed to ask about something that can wait
 * indefinitely. A silent notification says the same thing and lets the next
 * restart apply it.
 */
function announce(info: IUpdateInfo): void {
  log(`updates: ${info.releaseName || "a new version"} is ready`);

  if (!Notification.isSupported()) return;

  new Notification({
    title: "Reaper update ready",
    body: "It will be applied the next time you restart.",
    silent: true,
  }).show();
}
