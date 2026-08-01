import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig } from "vite";

/**
 * The build that produces `dist/`, which Capacitor copies into the app.
 *
 * This mirrors `for-ios-p2p/vite.config.ts` closely — same substitutions, same
 * reasoning — because the app-facing code they both build is the same code.
 * `for-ios-p2p/src/*` (boot.ts, bridge.ts, the `node:*` shims, mobile.ts/css)
 * is referenced from there rather than copied here: none of it is actually
 * iOS-specific (no `Capacitor.getPlatform()` branch anywhere in it), it is
 * mobile-shared code that happens to live in the folder that got there first,
 * and a second copy is a second copy to keep in step by hand — the same
 * reasoning `reaperInterface` below already applies to the shared interface
 * HTML. Only the two native plugins this build actually has
 * (`@reaper/socket`, `@reaper/tor`) differ per platform, and those live in
 * each plugin's own `android` folder under `for-ios-p2p/plugins` — see the
 * naming-scheme discussion in the plan file from the session that added
 * this build.
 */
function reaperInterface(path: string) {
  const ID = "\0reaper-interface";

  return {
    name: "reaper-interface",
    enforce: "pre" as const,

    resolveId(source: string) {
      return source === "./interface" ||
        source === "/src/interface" ||
        source.endsWith("/src/interface")
        ? ID
        : null;
    },

    load(id: string) {
      if (id !== ID) return null;
      const html = readFileSync(path, "utf8");
      return `export default ${JSON.stringify(html)};`;
    },

    configureServer(server: { watcher: { add(path: string): void } }) {
      server.watcher.add(path);
    },
  };
}

/**
 * `Buffer` and `process`, which the shared core assumes are simply there.
 *
 * See `for-ios-p2p/vite.config.ts` for the full reasoning — identical here.
 */
function nodeGlobals() {
  const NEEDS_BUFFER = /(^|[^.\w$])Buffer\s*[.[]/;
  const NEEDS_PROCESS = /(^|[^.\w$])process\s*\./;

  return {
    name: "node-globals",

    transform(code: string, id: string) {
      // Only the shared core. Everything under for-ios-p2p/src is mobile
      // code written knowing it is mobile code.
      if (!id.includes("for-desktop-p2p")) return null;

      const prelude: string[] = [];

      if (NEEDS_BUFFER.test(code) && !/from\s+["']buffer["']/.test(code)) {
        prelude.push('import { Buffer } from "buffer";');
      }

      if (NEEDS_PROCESS.test(code)) {
        prelude.push(
          'const process = { platform: "android", arch: "arm64", ' +
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

/**
 * Redirect the shared core's `./tor` to the mobile shim.
 *
 * Same substitution as iOS, and for the same reason: `transport.ts` imports
 * `./tor` for its SOCKS helper, and the desktop's copy spawns a subprocess
 * and drags in `node:child_process`, which does not exist in a WebView. The
 * mobile shim talks to Tor through the `@reaper/tor` plugin instead — see
 * `for-ios-p2p/src/shim/tor.ts`, unchanged for Android: it only ever calls
 * through the plugin interface, never anything iOS-specific.
 */
function useMobileTor(shimPath: string) {
  return {
    name: "mobile-tor",
    enforce: "pre" as const,

    resolveId(source: string, importer?: string) {
      if (!importer || !importer.includes("for-desktop-p2p")) return null;

      const isTor =
        source === "./tor" ||
        source.endsWith("/p2p/tor") ||
        source.endsWith("/p2p/tor.ts");

      return isTor ? shimPath : null;
    },
  };
}

const iosSrc = resolve(__dirname, "../for-ios-p2p/src");

export default defineConfig({
  // `npm run dev` serves index.html's real entry point from
  // ../for-ios-p2p/src — outside this project's root, which Vite's dev
  // server otherwise refuses on principle. `npm run build` never hits this;
  // it is only the dev server's file guard.
  server: {
    fs: {
      allow: [resolve(__dirname, "..")],
    },
  },

  plugins: [
    nodeGlobals(),
    useMobileTor(resolve(iosSrc, "shim/tor.ts")),
    reaperInterface(
      resolve(__dirname, "../for-desktop-p2p/src/local-ui/index.html"),
    ),
  ],

  resolve: {
    alias: {
      "node:crypto": resolve(iosSrc, "shim/crypto.ts"),
      "node:zlib": resolve(iosSrc, "shim/zlib.ts"),
      "node:fs": resolve(iosSrc, "shim/fs.ts"),
      "node:path": resolve(iosSrc, "shim/path.ts"),
      "node:net": resolve(iosSrc, "shim/net.ts"),
      "node:events": resolve(iosSrc, "shim/events.ts"),
      "node:dgram": resolve(iosSrc, "shim/dgram.ts"),
      "node:os": resolve(iosSrc, "shim/os.ts"),
      electron: resolve(iosSrc, "shim/electron.ts"),
      // The npm package, by path — resolved from *this* project's own
      // node_modules, not for-ios-p2p's (each mobile project installs its
      // own copy of the plain JS dependencies).
      buffer: resolve(__dirname, "node_modules/buffer/index.js"),
    },
  },

  define: {
    "process.env.NODE_ENV": JSON.stringify(
      process.env.NODE_ENV ?? "production",
    ),
    global: "globalThis",
  },

  worker: {
    format: "es",
  },

  build: {
    // A language-level target rather than a claimed browser: Android's
    // System WebView is Chromium-based and updates independently of the OS
    // on most devices, so there is no single "floor version" the way iOS 15
    // is Safari's — es2020 is comfortably supported by any WebView current
    // enough to run this app's minSdk 24.
    target: "es2020",
    outDir: "dist",
    emptyOutDir: true,

    rollupOptions: {
      output: {
        // One file. The WebView loads from a custom scheme, and chunked
        // dynamic imports across that scheme are a source of loading
        // failures that only appear on device.
        inlineDynamicImports: true,
      },
    },
  },

  assetsInclude: ["**/*.wasm"],
});
