import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "esbuild";

/**
 * Run the P2P core's demo and tests outside Electron.
 *
 *   npm run p2p:demo
 *   npm run p2p:test
 *
 * These are plain Node programs — no Electron, no window, no build. They
 * exercise storage, identity, signing and reconciliation directly, which is
 * the fastest way to check the core still behaves after a change.
 *
 * Bundled with esbuild first rather than run straight through Node's type
 * stripping. Node's ESM loader requires a file extension on every relative
 * import, while the Electron build (and TypeScript's own convention here) uses
 * extensionless ones. Rather than pick a side and make the source worse for
 * one of the two, esbuild resolves them the same way the real build does.
 */

const TARGETS = {
  demo: ["src/p2p/demo.ts"],
  test: [
    "src/p2p/crypto.test.ts",
    "src/p2p/storage.test.ts",
    "src/p2p/events.test.ts",
    "src/p2p/store.test.ts",
    "src/p2p/vector.test.ts",
    "src/p2p/compact.test.ts",
    "src/p2p/transport.test.ts",
    "src/p2p/blobs.test.ts",
    "src/p2p/bundle.test.ts",
    "src/p2p/compression.test.ts",
    "src/p2p/identity-change.test.ts",
    "src/p2p/membership.test.ts",
    "src/p2p/delivery.test.ts",
    "src/p2p/backup.test.ts",
    "src/p2p/onion.test.ts",
    "src/p2p/link.test.ts",

    // The device link, which is the one thing in here that has failed on real
    // hardware more often than in this file. It was written and then never
    // added to this list, so every run reported a green suite for a feature
    // nothing was exercising.
    "src/p2p/pair.test.ts",
    "src/p2p/restore.test.ts",
    "src/local-ui/language.test.ts",
    "src/local-ui/appearance.test.ts",
    "src/local-ui/boot.test.ts",
    "src/local-ui/membership-ui.test.ts",
    "src/local-ui/qr.test.ts",
  ],
};

const mode = process.argv[2];
const entries = TARGETS[mode];

if (!entries) {
  console.error(`usage: node scripts/p2p.mjs <${Object.keys(TARGETS).join("|")}>`);
  process.exit(1);
}

/**
 * What to say when esbuild cannot find its own compiler.
 *
 * esbuild ships the actual binary as a separate per-platform package, which npm
 * picks from `optionalDependencies` at install time. A `node_modules` tree
 * populated on a different operating system — copied between machines, restored
 * from a backup, or installed from inside WSL against a Windows folder — has a
 * compiler for the wrong platform, or none.
 *
 * The error names a package nobody has heard of and reads like a broken
 * dependency. It is not: the tree came from somewhere else, and the fix is one
 * command.
 */
function explainToolchain(error) {
  const message = String(error?.message ?? error);
  if (!message.includes("could not be found, and is needed by esbuild")) return;

  console.error(`
  esbuild has no compiler for this machine ` +
    `(@esbuild/${process.platform}-${process.arch}).

  node_modules was installed on a different operating system. Nothing is
  wrong with the project — the tree just came from somewhere else.

      rmdir /s /q node_modules
      del package-lock.json
      npm install
`);
}

const out = mkdtempSync(join(tmpdir(), "reaper-p2p-"));
let failed = false;

try {
  for (const entry of entries) {
    const bundle = join(out, `${entry.replace(/[\\/]/g, "_")}.mjs`);

    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: bundle,
      logLevel: "error",
    });

    if (entries.length > 1) console.log(`\n\x1b[1m${entry}\x1b[0m`);

    try {
      execFileSync(process.execPath, [bundle], { stdio: "inherit" });
    } catch {
      failed = true;
    }
  }
} catch (error) {
  // The toolchain failing, rather than a test reporting a failure. Tests print
  // their own results and set an exit code; this deserves an explanation.
  explainToolchain(error);
  console.error(error);
  failed = true;
} finally {
  rmSync(out, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
