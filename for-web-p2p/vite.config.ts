import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The iOS build already solved most of this. Its shims are browser code. */
const ios = (file: string) => resolve(__dirname, "../for-ios-p2p/src/shim", file);

/**
 * Reaper in a browser.
 *
 * The third build of one core. The desktop runs it in Electron's main process,
 * the phone runs it in a WebView over native plugins, and this runs it in an
 * ordinary tab — with the two things a tab cannot have supplied from outside:
 * sockets, by a relay on the machine serving the page, and a disk, by
 * IndexedDB.
 *
 * ## What is reused, and why that is the interesting part
 *
 * Almost everything. `crypto`, `zlib`, `path`, `events`, `os`, `dgram` and the
 * Electron stand-in are taken from the iOS build unchanged, because they were
 * written against a WebView — which is a browser. Only three shims are new,
 * and each corresponds to something a page genuinely cannot do:
 *
 *   - `net.ts`   — a browser cannot open a TCP socket.
 *   - `fs.ts`    — a browser has no synchronous disk.
 *   - `tor.ts`   — a browser cannot run Tor or publish a service.
 *
 * The interface is the same file the desktop ships, read through a plugin
 * rather than copied, so the three builds cannot drift into three products.
 */

/** `import html from "./interface"` — the desktop's page, not a copy of it. */
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
      return `export default ${JSON.stringify(readFileSync(path, "utf8"))};`;
    },

    configureServer(server: { watcher: { add: (p: string) => void } }) {
      server.watcher.add(path);
    },
  };
}

/**
 * `./tor`, as imported from inside the shared core.
 *
 * A resolver rather than an alias because the specifier is relative: by the
 * time Vite asks, it is an absolute path into `for-desktop-p2p`, and an alias
 * on `./tor` would never match.
 */
function useWebTor(shimPath: string) {
  return {
    name: "web-tor",
    enforce: "pre" as const,

    resolveId(source: string, importer?: string) {
      if (!importer || !importer.includes("for-desktop-p2p")) return null;

      const wanted =
        source === "./tor" ||
        source.endsWith("/p2p/tor") ||
        source.endsWith("/p2p/tor.ts");

      return wanted ? shimPath : null;
    },
  };
}

/**
 * `Buffer` and `process`, which the shared core assumes are simply there.
 *
 * Node has both as globals and the desktop files use them bare. A browser has
 * neither, so the first such module to evaluate throws and the entry never
 * runs — which looks exactly like a page that loaded and did nothing.
 *
 * Injected per module rather than assigned from an entry point, because an
 * entry only runs first if the bundler happens to order it first, and nothing
 * in the module graph says it must.
 */
function nodeGlobals() {
  const NEEDS_BUFFER = /(^|[^.\w$])Buffer\s*[.[]/;
  const NEEDS_PROCESS = /(^|[^.\w$])process\s*\./;

  return {
    name: "node-globals",

    transform(code: string, id: string) {
      if (!id.includes("for-desktop-p2p")) return null;

      const prelude: string[] = [];

      if (NEEDS_BUFFER.test(code) && !/from\s+["']buffer["']/.test(code)) {
        prelude.push('import { Buffer } from "buffer";');
      }

      if (NEEDS_PROCESS.test(code)) {
        prelude.push(
          'const process = { platform: "web", arch: "wasm", ' +
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

export default defineConfig({
  plugins: [
    nodeGlobals(),
    useWebTor(resolve(__dirname, "src/shim/tor.ts")),
    reaperInterface(resolve(__dirname, "../for-desktop-p2p/src/local-ui/index.html")),
  ],

  resolve: {
    alias: {
      // New here, because each is something a page cannot do.
      "node:net": resolve(__dirname, "src/shim/net.ts"),
      "node:fs": resolve(__dirname, "src/shim/fs.ts"),

      // Already browser code. Written for a WebView, which is a browser.
      "node:crypto": ios("crypto.ts"),
      "node:zlib": ios("zlib.ts"),
      "node:path": ios("path.ts"),
      "node:events": ios("events.ts"),
      "node:dgram": ios("dgram.ts"),
      "node:os": ios("os.ts"),
      electron: ios("electron.ts"),

      // Named by path so there is no builtin for Vite to prefer. A self-alias
      // of `buffer: "buffer"` leaves Vite treating it as a Node builtin and
      // swapping in a stub whose every property throws — and the core does
      // real arithmetic on buffers.
      buffer: resolve(__dirname, "node_modules/buffer/index.js"),
    },
  },

  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
    global: "globalThis",
  },

  worker: { format: "es" },

  build: {
    // Wide enough to cover what people actually browse with, narrow enough to
    // keep top-level await and modern crypto.
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },

  assetsInclude: ["**/*.wasm"],
});
