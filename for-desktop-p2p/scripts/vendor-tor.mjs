import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copy the Tor daemon into `vendor/tor/` so it can be packaged with the app.
 *
 *   npm run vendor:tor                     search the usual places
 *   npm run vendor:tor -- "C:\\path\\tor.exe"  use a specific binary
 *
 * Tor is what makes this app reachable at all — without it there is no onion
 * service and no way for peers to find each other, since every direct-address
 * path was deliberately removed. So it is a hard dependency of a working
 * build, not an optional extra.
 *
 * The daemon is taken from an existing Tor Browser install rather than
 * downloaded. Tor Browser ships the same `tor` binary, it is already verified
 * by whatever installed it, and fetching a security-critical executable over
 * plain HTTP inside a build script would be a poor trade for convenience.
 *
 * Tor is free software under the BSD 3-clause licence, so redistributing it
 * alongside this app is permitted. `LICENSE-tor.txt` is copied next to the
 * binary to satisfy the attribution requirement.
 */

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, "..");
const outDir = join(project, "vendor", "tor");

const exeName = process.platform === "win32" ? "tor.exe" : "tor";

/**
 * Both binary names are searched, not just the host platform's.
 *
 * Packaging for Windows from another machine is a normal thing to do, and a
 * search that only looks for the local name reports "not found" while the
 * binary sits right there — which is what happened the first time this ran.
 */
const exeNames = ["tor.exe", "tor"];

/** Where a Tor Browser install keeps the daemon, per platform. */
function torBrowserPaths() {
  const layouts = [
    ["Browser", "TorBrowser", "Tor"],
    // macOS keeps it inside the .app bundle.
    ["Contents", "MacOS", "Tor"],
  ];

  const roots = [
    // Sitting next to the project, which is where it usually lands after a
    // manual download.
    join(project, "..", "Tor Browser"),
    join(project, "Tor Browser"),
    join(process.env.USERPROFILE ?? "", "Desktop", "Tor Browser"),
    join(process.env.USERPROFILE ?? "", "Downloads", "Tor Browser"),
    join(process.env.LOCALAPPDATA ?? "", "Tor Browser"),
    "/Applications/Tor Browser.app",
    join(process.env.HOME ?? "", ".local", "share", "torbrowser"),
  ];

  const paths = [];
  for (const root of roots.filter(Boolean)) {
    for (const layout of layouts) {
      for (const name of exeNames) {
        paths.push(join(root, ...layout, name));
      }
    }
  }
  return paths;
}

/** A system-installed tor, which most Linux distributions provide. */
function systemPaths() {
  return ["/usr/bin/tor", "/usr/local/bin/tor", "/opt/homebrew/bin/tor"];
}

function findTor() {
  const explicit = process.argv[2];
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`no file at ${explicit}`);
    }
    return explicit;
  }

  for (const candidate of [...torBrowserPaths(), ...systemPaths()]) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    "could not find a tor binary.\n\n" +
      "Install Tor Browser (https://www.torproject.org/download/) and re-run\n" +
      "this, or point it at a binary directly:\n\n" +
      `  npm run vendor:tor -- "C:\\\\path\\\\to\\\\${exeName}"\n\n` +
      "Searched:\n" +
      [...torBrowserPaths(), ...systemPaths()]
        .map((p) => `  ${p}`)
        .join("\n"),
  );
}

const source = findTor();
mkdirSync(outDir, { recursive: true });

// Named for the target platform, not the source: a tor.exe copied on Linux
// for a Windows package still has to be called tor.exe at the far end.
const target = join(outDir, source.endsWith(".exe") ? "tor.exe" : exeName);
copyFileSync(source, target);

// Preserved on Unix — a copied binary without the execute bit fails at spawn
// time with a message that does not mention permissions.
if (!target.endsWith(".exe")) {
  chmodSync(target, 0o755);
}

// Attribution, kept beside the binary so it travels with it.
const licenceNote = join(outDir, "LICENSE-tor.txt");
if (!existsSync(licenceNote)) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    licenceNote,
    [
      "This directory contains the Tor daemon, redistributed with this",
      "application under the BSD 3-clause licence.",
      "",
      "Tor is developed by The Tor Project, Inc.",
      "Source and full licence text: https://www.torproject.org/",
      "",
      `Vendored from: ${source}`,
    ].join("\n"),
    "utf8",
  );
}

const size = (statSync(target).size / 1e6).toFixed(1);
console.log(`tor vendored: ${source}`);
console.log(`          -> ${target} (${size} MB)`);
console.log("\nIt will be packaged into resources/tor/ automatically.");
