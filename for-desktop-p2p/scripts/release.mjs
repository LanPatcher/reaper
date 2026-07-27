import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

/**
 * Assemble a release directory that can be uploaded to a web server as-is.
 *
 *   npm run make          — build the installer
 *   npm run release       — collect it into out/release/
 *
 * Then copy `out/release/` to wherever the domain serves from. That is the
 * whole deployment: there is no service to run and no API to keep up.
 *
 * ## What comes out
 *
 *   out/release/
 *     index.html                        a download page
 *     reaper-setup.exe                  first-time installer
 *     icon.ico                          shown by the installer while it runs
 *     SHA256SUMS                        so a download can be checked by hand
 *     win32/x64/
 *       RELEASES                        the manifest Squirrel reads
 *       Reaper-1.4.2-full.nupkg         the package it downloads
 *
 * The `win32/x64` layout is not a choice — it is where `update-electron-app`
 * looks when told a static base URL, and it appends the platform and
 * architecture itself.
 *
 * ## Serving it
 *
 * Any static host will do. Two requirements, both easy to get wrong:
 *
 *   - `RELEASES` must be served as it is on disk. A host that decides it is
 *     HTML and rewrites it, or 404s an extensionless file, breaks updates in a
 *     way that looks like "no update available".
 *   - HTTPS, because the app will run whatever this URL hands it. See the note
 *     about signing in `src/native/updates.ts`; until there is a certificate,
 *     the update channel is exactly as trustworthy as the server.
 *
 * A Caddy config that satisfies both:
 *
 *   releases.example.com {
 *     root * /srv/reaper
 *     file_server
 *   }
 *
 * and then build with:
 *
 *   set REAPER_UPDATE_URL=https://releases.example.com
 */

const ROOT = process.cwd();
const OUT = join(ROOT, "out", "release");
const MAKE = join(ROOT, "out", "make");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;

function fail(message) {
  console.error(`\n  [X] ${message}\n`);
  process.exit(1);
}

/** Every file under a directory, recursively. */
function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

function human(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ---- find what `electron-forge make` produced -----------------------------

if (!existsSync(MAKE)) {
  fail("out/make does not exist. Run `npm run make` first.");
}

const built = walk(MAKE);

const nupkgs = built.filter((p) => p.endsWith(".nupkg"));
const releases = built.filter((p) => basename(p) === "RELEASES");
const setups = built.filter((p) => /setup\.exe$/i.test(p));

if (!releases.length || !nupkgs.length) {
  fail(
    "No Squirrel output found under out/make.\n" +
      "      This script collects a Windows release; `npm run make` has to be\n" +
      "      run on Windows for the installer to exist at all.",
  );
}

// ---- stage it -------------------------------------------------------------

rmSync(OUT, { recursive: true, force: true });
const platform = join(OUT, "win32", "x64");
mkdirSync(platform, { recursive: true });

const staged = [];

function stage(from, to) {
  copyFileSync(from, to);
  staged.push(to);
  console.log(`  + ${to.slice(OUT.length + 1).replace(/\\/g, "/")}  ` +
    `(${human(statSync(to).size)})`);
}

console.log(`\n  Reaper ${VERSION} — staging release\n`);

// The manifest, and every package it names. Deltas are included when they
// exist: Squirrel prefers them, and a release without them still works but
// makes every user download the whole application again.
stage(releases[0], join(platform, "RELEASES"));
for (const nupkg of nupkgs) stage(nupkg, join(platform, basename(nupkg)));

// The installer, under a name that does not change between versions — so a
// download link on a page does not have to be edited for every release.
if (setups.length) stage(setups[0], join(OUT, "reaper-setup.exe"));
else console.log("  ! no setup.exe found; updates will work, first installs will not");

const icon = join(ROOT, "assets", "desktop", "icon.ico");
if (existsSync(icon)) stage(icon, join(OUT, "icon.ico"));

// ---- checksums ------------------------------------------------------------
//
// Not a substitute for signing — anyone who can replace a download can replace
// the list of checksums beside it. It is there so somebody who got the file
// from somewhere else can tell whether it is the same one.

const sums = staged
  .map((path) => `${sha256(path)}  ${path.slice(OUT.length + 1).replace(/\\/g, "/")}`)
  .join("\n");

writeFileSync(join(OUT, "SHA256SUMS"), sums + "\n");

// ---- a page to download from ----------------------------------------------

const setupSize = existsSync(join(OUT, "reaper-setup.exe"))
  ? human(statSync(join(OUT, "reaper-setup.exe")).size)
  : "";

writeFileSync(
  join(OUT, "index.html"),
  `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reaper ${VERSION}</title>
<style>
  body { background:#0d0e12; color:#dfe1e6; font:15px/1.6 system-ui,sans-serif;
         max-width:34rem; margin:12vh auto; padding:0 1.5rem; }
  h1 { font-size:1.6rem; margin:0 0 .2rem; }
  .v { color:#7c7f8a; margin-bottom:2rem; }
  a.get { display:inline-block; background:#5865f2; color:#fff; text-decoration:none;
          padding:.7rem 1.4rem; border-radius:8px; font-weight:600; }
  a.get:hover { background:#4752c4; }
  .note { color:#7c7f8a; font-size:13px; margin-top:2rem; }
  code { background:#1a1c22; padding:.1rem .35rem; border-radius:4px; }
</style>
<h1>Reaper</h1>
<div class="v">Version ${VERSION} &middot; Windows</div>
<p><a class="get" href="reaper-setup.exe">Download${setupSize ? ` (${setupSize})` : ""}</a></p>
<p class="note">
  Serverless and end-to-end encrypted. Everything goes over Tor, so the first
  start takes a moment while a circuit is built.
</p>
<p class="note">
  Checksums are in <a href="SHA256SUMS" style="color:#9aa0ad">SHA256SUMS</a>.
  Once installed, the app updates itself from this same address.
</p>
</html>
`,
);

console.log(`
  Staged ${staged.length} files into out/release/

  Upload the contents of that directory to the root of your release host,
  then build with REAPER_UPDATE_URL set to the same address so the app knows
  where to look:

    set REAPER_UPDATE_URL=https://releases.example.com
    npm run make && npm run release
`);
