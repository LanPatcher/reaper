import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { build } from "esbuild";

/**
 * Run the shim tests outside a WebView.
 *
 *   npm run shim:test
 *
 * These compare the browser implementations against Node's, so they have to run
 * somewhere both exist — which is here, not on a phone. Bundled with esbuild
 * first because the source uses extensionless relative imports, which Node's
 * ESM loader refuses and every real build resolves.
 *
 * ## The interop build
 *
 * `core.test.ts` is the important one and needs something the others do not:
 * two compilations of the *same* Reaper core, one against Node's builtins and
 * one against the shims, so they can be made to exchange signed events. A file
 * cannot import two builds of itself by name, so both are compiled here and
 * their paths handed over in the environment.
 *
 * The aliases below are the same ones `vite.config.ts` applies for the real
 * app. Keeping them in step matters: a test that passes against a different
 * substitution than the app ships is testing nothing.
 */

const HERE = resolve(process.cwd());

const SHIM_ALIASES = {
  "node:crypto": join(HERE, "src/shim/crypto.ts"),
  "node:zlib": join(HERE, "src/shim/zlib.ts"),
  "node:fs": join(HERE, "src/shim/fs.ts"),
  "node:path": join(HERE, "src/shim/path.ts"),
  "node:net": join(HERE, "src/shim/net.ts"),
  "node:events": join(HERE, "src/shim/events.ts"),
  electron: join(HERE, "src/shim/electron.ts"),

  // The native plugins, which cannot load outside a WebView. The interop test
  // reaches them through `net.ts` and never calls them — see plugins-stub.ts.
  "@reaper/socket": join(HERE, "src/shim/plugins-stub.ts"),
  "@reaper/tor": join(HERE, "src/shim/plugins-stub.ts"),
  "@reaper/keepalive": join(HERE, "src/shim/plugins-stub.ts"),
};

const TESTS = [
  "src/shim/crypto.test.ts",
  "src/shim/zlib.test.ts",
  "src/shim/fs.test.ts",
  "src/shim/core.test.ts",
];

/**
 * Where the bundles go.
 *
 * Inside `node_modules` rather than in a temporary directory, and that is not
 * arbitrary: the bundles leave their dependencies external, so they have to sit
 * somewhere Node's resolver will walk up from and find this project's
 * `node_modules`. Built into `/tmp` they resolve against nothing.
 *
 * `brotli-wasm` makes the point sharply — its Node entry point `require`s the
 * WebAssembly binary at runtime, so it cannot be inlined and has to be
 * resolvable from wherever the test runs.
 */
const out = join(HERE, "node_modules/.reaper-tests");

let failed = 0;

/**
 * What to say when esbuild cannot find its own compiler.
 *
 * esbuild ships the actual binary as a separate per-platform package, which npm
 * picks from `optionalDependencies` at install time. So a `node_modules` tree
 * populated somewhere else — copied between machines, restored from a backup,
 * or installed from inside WSL against a Windows folder — contains a compiler
 * for the wrong operating system, or none.
 *
 * The error it raises names a package nobody has heard of and reads like a
 * broken dependency. It is not: it is a tree that was built somewhere else, and
 * the fix is one command.
 */
function explain(error) {
  const message = String(error?.message ?? error);
  if (!message.includes("could not be found, and is needed by esbuild")) return;

  const platform = `@esbuild/${process.platform}-${process.arch}`;

  console.error(`
  esbuild has no compiler for this machine (${platform}).

  This happens when node_modules was installed on a different operating
  system. Nothing is wrong with the project — the tree just came from
  somewhere else.

      build-ios.bat clean

  or, by hand:

      rmdir /s /q node_modules
      del package-lock.json
      npm install
`);
}

/** The same substitution as `vite.config.ts`, in esbuild's shape. */
const iosTor = {
  name: "ios-tor",
  setup(build) {
    build.onResolve({ filter: /^\.\/tor$/ }, (args) => {
      if (!args.importer.includes("for-desktop-p2p")) return null;
      return { path: join(HERE, "src/shim/tor.ts") };
    });
  },
};

/** Build one entry point into the temporary directory. */
async function bundle(entry, name, options = {}) {
  const file = join(out, name);

  await build({
    entryPoints: [entry],
    outfile: file,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "warning",
    ...options,
  });

  return file;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

try {
  // The two halves of the interop test. Node's builtins stay external on their
  // own under `platform: "node"`, so this build needs nothing said about them —
  // the point of it is that `node:crypto` is the real one.
  const nodeCore = await bundle("src/shim/core-entry.ts", "core-node.mjs", {
    packages: "external",
  });

  const shimCore = await bundle("src/shim/core-entry.ts", "core-shim.mjs", {
    alias: SHIM_ALIASES,
    plugins: [iosTor],
    packages: "external",
  });

  for (const test of TESTS) {
    if (!existsSync(test)) {
      console.log(`\n=== ${test} — not written yet, skipped ===`);
      continue;
    }

    // One at a time with an explicit outfile. Bundling them together puts the
    // output under a mirrored directory tree, and guessing that path is how a
    // runner ends up silently executing nothing.
    const file = await bundle(
      test,
      test.replace(/[/\\]/g, "_").replace(/\.ts$/, ".mjs"),
      {
        // Nothing shimmed, so `node:crypto` here is Node's — which is the
        // entire point, since these tests exist to compare the shim against it.
        //
        // Capacitor is the exception. It cannot load outside a WebView, so the
        // filesystem plugin is replaced with a stub that behaves like it; the
        // test imports the same stub, which is how it can see what reached the
        // disk. Bundled rather than external so both halves get one instance.
        packages: "external",
        alias: { "@capacitor/filesystem": join(HERE, "src/shim/fs-stub.ts") },
        external: ["node:*", "buffer"],
      },
    );

    console.log(`\n=== ${test} ===`);

    try {
      execFileSync(process.execPath, [file], {
        stdio: "inherit",
        env: {
          ...process.env,
          REAPER_CORE_NODE: nodeCore,
          REAPER_CORE_SHIM: shimCore,
        },
      });
    } catch {
      failed++;
    }
  }
} catch (error) {
  // Anything thrown out of a build rather than out of a test. The tests report
  // their own failures and set an exit code; this is the toolchain itself
  // failing, which deserves an explanation rather than a stack trace.
  explain(error);
  console.error(error);
  failed++;
} finally {
  rmSync(out, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n${failed} suite(s) FAILED`);
  process.exit(1);
}

console.log("\nevery suite passed");
