import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig } from "vite";

/**
 * The build that produces `dist/`, which Capacitor copies into the app.
 *
 * The interesting part is the aliases. The Reaper core is written against
 * Node's builtins and is shared with the desktop build rather than forked, so
 * the substitutions happen here — one place, applied to every import, including
 * the ones several layers down inside `store.ts` and `transport.ts`.
 *
 * These have to stay in step with the aliases in `scripts/shim.mjs`, which is
 * what the tests use. A test that passes against a different substitution than
 * the app ships is testing nothing.
 */
/**
 * Replace the desktop's Tor module with the iOS one.
 *
 * `transport.ts` imports `./tor` for its SOCKS helper. On the desktop that
 * file also spawns the tor binary; on a phone Tor is linked in as a library
 * and the SOCKS handshake happens in Swift, so the whole module is wrong here
 * — and it drags in `node:child_process`, which does not exist.
 *
 * This is a resolver rather than an alias because the specifier is `./tor`,
 * which is both relative and far too common to redirect by name. Matching on
 * the importer means only the shared core's copy is substituted.
 */
/**
 * Serve the desktop interface as a module.
 *
 * `import html from "./interface"` returns the contents of
 * `for-desktop-p2p/src/local-ui/index.html` — the same file the desktop ships,
 * not a copy. Reading it through a plugin rather than committing a duplicate is
 * what keeps the two from drifting; the alternative is two interfaces that are
 * identical until somebody changes one.
 */
function reaperInterface(path) {
  const ID = "\0reaper-interface";

  return {
    name: "reaper-interface",

    // Same reason as `ios-tor` above: a relative specifier has to be caught
    // before Vite turns it into a path that does not exist.
    enforce: "pre",

    resolveId(source) {
      return source === "./interface" ||
        source === "/src/interface" ||
        source.endsWith("/src/interface")
        ? ID
        : null;
    },

    load(id) {
      if (id !== ID) return null;

      const html = readFileSync(path, "utf8");
      return `export default ${JSON.stringify(html)};`;
    },

    // Rebuild the page when the interface changes, so `npm run dev` reloads on
    // an edit to a file outside this project.
    configureServer(server) {
      server.watcher.add(path);
    },
  };
}

/**
 * `Buffer` and `process`, which the shared core assumes are simply there.
 *
 * Node has both as globals and the desktop files use them bare — `Buffer.from`
 * appears in nine of them and not one imports it. A browser has neither, so the
 * first of those modules to evaluate throws `ReferenceError: Buffer is not
 * defined`, the entry module never runs, and the page shows its static HTML
 * with no script behind it. That is not a hang and there is nothing to catch;
 * it looks exactly like an app that started and did nothing.
 *
 * Injected per module rather than assigned to `globalThis` from an entry point,
 * because an entry only runs first if the bundler happens to order it first —
 * and nothing in the module graph says it must. A module that declares its own
 * import cannot be reordered out of correctness.
 */
function nodeGlobals() {
  const NEEDS_BUFFER = /(^|[^.\w$])Buffer\s*[.[]/;
  const NEEDS_PROCESS = /(^|[^.\w$])process\s*\./;

  return {
    name: "node-globals",

    transform(code, id) {
      // Only the shared core. Everything under `src/` here is browser code
      // written knowing it is browser code.
      if (!id.includes("for-desktop-p2p")) return null;

      const prelude = [];

      if (NEEDS_BUFFER.test(code) && !/from\s+["']buffer["']/.test(code)) {
        prelude.push('import { Buffer } from "buffer";');
      }

      if (NEEDS_PROCESS.test(code)) {
        // Enough of it to satisfy the reads that survive into this build:
        // `process.platform` decides desktop-only branches, and the rest are
        // in modules that are shimmed away entirely.
        // `stdout` is a working object, not null.
        //
        // `diagnostics.ts` writes every log line with
        // `process.stdout.write(line)`, unconditionally — it is the line that
        // makes logging useful from a terminal. A null stdout turns that into
        // "null is not an object", thrown from inside `log()`, which is called
        // from the middle of importing an identity. The failure surfaces as a
        // crash in the account restore rather than in logging, four layers
        // from anything to do with either.
        //
        // Pointed at the console instead, which is also the only place a log
        // line can usefully go on a phone.
        prelude.push(
          'const process = { platform: "ios", arch: "arm64", ' +
            'env: {}, resourcesPath: "", ' +
            'stdout: { write: (text) => { ' +
            'console.log(String(text).replace(/\\n$/, "")); return true; } }, ' +
            'stderr: { write: (text) => { ' +
            'console.warn(String(text).replace(/\\n$/, "")); return true; } }, ' +
            'cwd: () => "/", on: () => {}, exit: () => {} };',
        );
      }

      if (!prelude.length) return null;

      return { code: prelude.join("\n") + "\n" + code, map: null };
    },
  };
}

function useIosTor(shimPath) {
  return {
    name: "ios-tor",

    // Before Vite's own resolution, not after.
    //
    // Without this the plugin is a "normal" one and Vite has already turned
    // `./tor` into an absolute path by the time it is asked — so the check
    // below never matched, the desktop's Tor module was pulled in, and the
    // build died on `node:child_process`. A plugin that silently never fires
    // looks exactly like no plugin at all.
    enforce: "pre",

    resolveId(source, importer) {
      if (!importer || !importer.includes("for-desktop-p2p")) return null;

      // Both spellings. `enforce: "pre"` should mean the bare specifier, but
      // resolution order is not something to stake a twenty-minute build on,
      // and matching the resolved path as well costs one condition.
      const isTor =
        source === "./tor" ||
        source.endsWith("/p2p/tor") ||
        source.endsWith("/p2p/tor.ts");

      return isTor ? shimPath : null;
    },
  };
}

export default defineConfig({
  plugins: [
    nodeGlobals(),
    useIosTor(resolve(__dirname, "src/shim/tor.ts")),
    reaperInterface(
      resolve(__dirname, "../for-desktop-p2p/src/local-ui/index.html"),
    ),
  ],

  resolve: {
    alias: {
      "node:crypto": resolve(__dirname, "src/shim/crypto.ts"),
      "node:zlib": resolve(__dirname, "src/shim/zlib.ts"),
      "node:fs": resolve(__dirname, "src/shim/fs.ts"),
      "node:path": resolve(__dirname, "src/shim/path.ts"),
      "node:net": resolve(__dirname, "src/shim/net.ts"),
      "node:events": resolve(__dirname, "src/shim/events.ts"),

      // Both reached through `link.ts` and `bridge.ts`, and both absent in a
      // WebView. Substituted rather than left alone, because Vite's answer to
      // an unknown Node builtin is `__vite-browser-external` — a module whose
      // every property throws *and* which fails the build outright when
      // something imports a named export from it. That is what
      // `import { createSocket } from "node:dgram"` did.
      "node:dgram": resolve(__dirname, "src/shim/dgram.ts"),
      "node:os": resolve(__dirname, "src/shim/os.ts"),
      // The whole desktop bridge runs here; see src/shim/electron.ts.
      electron: resolve(__dirname, "src/shim/electron.ts"),
      // The npm package, by path.
      //
      // `buffer: "buffer"` is a self-alias and does nothing, which left Vite to
      // treat it as a Node builtin and swap in `__vite-browser-external` — a
      // stub whose every property throws. The core does real arithmetic on
      // buffers (`readUInt32BE`, `subarray`, `equals`), so a stub is not a
      // degraded version of this, it is a guaranteed crash on first use.
      //
      // Named explicitly so there is no builtin for Vite to prefer.
      buffer: resolve(__dirname, "node_modules/buffer/index.js"),
    },
  },

  define: {
    // Some dependencies check this. Without it they throw on load, which in a
    // WebView presents as a blank screen and nothing in the console.
    "process.env.NODE_ENV": JSON.stringify(
      process.env.NODE_ENV ?? "production",
    ),
    global: "globalThis",
  },

  build: {
    // Safari on iOS 15 is the floor. Anything newer and the app fails to parse
    // on devices that are still perfectly capable of running it.
    target: "safari15",
    outDir: "dist",
    emptyOutDir: true,

    rollupOptions: {
      output: {
        // One file. The WebView loads from a custom scheme, and chunked
        // dynamic imports across that scheme are a source of loading failures
        // that only appear on device.
        inlineDynamicImports: true,
      },
    },
  },

  // The WebAssembly for Brotli has to be served as-is rather than inlined as
  // base64, which is what Vite would do to something this size by default.
  assetsInclude: ["**/*.wasm"],
});
