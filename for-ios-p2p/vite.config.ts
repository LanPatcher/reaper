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

    resolveId(source) {
      return source === "./interface" || source === "/src/interface"
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

function useIosTor(shimPath) {
  return {
    name: "ios-tor",
    resolveId(source, importer) {
      if (source !== "./tor" || !importer) return null;
      if (!importer.includes("for-desktop-p2p")) return null;
      return shimPath;
    },
  };
}

export default defineConfig({
  plugins: [
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
      // The whole desktop bridge runs here; see src/shim/electron.ts.
      electron: resolve(__dirname, "src/shim/electron.ts"),
      // `Buffer` is used throughout the core. The polyfill is a real
      // implementation rather than a stub, because the core does arithmetic on
      // buffers — `readUInt32BE`, `subarray`, `equals` — not just carry them.
      buffer: "buffer",
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
