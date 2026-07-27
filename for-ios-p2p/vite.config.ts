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
export default defineConfig({
  resolve: {
    alias: {
      "node:crypto": resolve(__dirname, "src/shim/crypto.ts"),
      "node:zlib": resolve(__dirname, "src/shim/zlib.ts"),
      "node:fs": resolve(__dirname, "src/shim/fs.ts"),
      "node:path": resolve(__dirname, "src/shim/path.ts"),
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
