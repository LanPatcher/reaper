import { existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { app, net, protocol } from "electron";

import { log } from "./diagnostics";

/**
 * Content types by file extension.
 *
 * These have to be set explicitly. `net.fetch` on a `file://` URL does not
 * infer a MIME type, and Chromium *hard-refuses* to execute a
 * `<script type="module">` that isn't served as JavaScript — it blocks the
 * script and renders nothing, with no visible error. The client's entry point
 * is a module script, so without this the app is simply a blank window.
 *
 * Stylesheets are equally strict under `X-Content-Type-Options: nosniff`
 * semantics, so they're covered here too.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

/**
 * Best-guess content type for a path on disk
 */
function contentTypeFor(filePath: string): string {
  return (
    CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream"
  );
}

/**
 * Custom scheme the bundled client is served from.
 *
 * We deliberately do not load the client over `file://`. The client uses
 * history-based routing (@solidjs/router), and `file://` has no real origin,
 * which breaks route resolution, localStorage partitioning and service worker
 * registration. A registered standard scheme behaves like a normal origin, so
 * everything works exactly as it does on the web.
 */
// `?raw` hands us the file's contents as a string at build time. Vite resolves
// this for the main process the same way it does for the renderer.
import localClient from "../local-ui/index.html?raw";

export const CLIENT_SCHEME = "reaper";

/**
 * Origin the client is served from
 */
export const CLIENT_ORIGIN = `${CLIENT_SCHEME}://app`;

/**
 * Entry point for the bundled client
 */
export const CLIENT_URL = `${CLIENT_ORIGIN}/`;

/**
 * Locate the bundled client on disk.
 *
 * Packaged builds get it via `extraResource` in forge.config.ts, which lands
 * it next to the asar. Unpackaged runs read it straight out of the project
 * directory so `pnpm start` works without repackaging.
 */
export function getClientDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "client-dist")
    : join(app.getAppPath(), "client-dist");
}

/**
 * Whether a bundled client is actually present.
 *
 * The desktop app is usable without one — it falls back to loading a remote
 * instance — so this is a question, not an assertion.
 */
export function hasBundledClient(): boolean {
  return existsSync(join(getClientDir(), "index.html"));
}

/**
 * Declare the scheme's privileges.
 *
 * Must run before the app `ready` event, hence being a separate function from
 * the handler registration below.
 */
export function registerClientScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CLIENT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/**
 * Diagnostic page shown when no client bundle is present.
 *
 * This exists because the alternative — quietly loading a public instance —
 * is far more confusing: the app appears to work, so a packaging mistake
 * shows up as "my changes are missing" rather than "there is no bundle", and
 * meanwhile it has pointed the user at somebody else's server.
 */
function missingBundleResponse(): Response {
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Stoat — no client bundled</title>
  <style>
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center;
      justify-content: center; background: #191919; color: #e6e6e6;
      font-family: system-ui, sans-serif; line-height: 1.6;
    }
    main { max-width: 34rem; padding: 2rem; }
    h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
    p { color: #b4b4b4; }
    code {
      display: block; margin: 1rem 0; padding: .75rem 1rem;
      background: #0f0f0f; border-radius: .5rem; color: #d4c5ff;
      font-family: ui-monospace, monospace; font-size: .9rem;
    }
    small { color: #8a8a8a; }
  </style>
</head>
<body>
  <main>
    <h1>No client bundled</h1>
    <p>
      This build was packaged without the web client, so there is nothing to
      display. It most often means the app was packaged before the web build
      finished.
    </p>
    <p>Rebuild with:</p>
    <code>for-desktop\\build.bat</code>
    <p>
      That builds <strong>for-web</strong> first, copies the result in, then
      packages the app.
    </p>
    <small>Expected bundle at: ${getClientDir().replace(/&/g, "&amp;").replace(/</g, "&lt;")}</small>
  </main>
</body>
</html>`;

  return new Response(html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Serve the bundled client. Must run after the app `ready` event.
 */
export function registerClientProtocol() {
  const root = normalize(getClientDir());

  protocol.handle(CLIENT_SCHEME, async (request) => {
    let requestPath: string;

    try {
      requestPath = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    // The local P2P client.
    //
    // Served from a string compiled into the main bundle rather than from
    // disk, which sidesteps the packaging question entirely — there is no
    // extra resource to copy, and no difference between a packaged run and
    // `npm start`.
    //
    // It takes priority over any bundled Solid build, because this is the
    // serverless app: the Solid client still expects an HTTP backend, and
    // loading it here would produce a login screen pointed at a server that
    // does not exist.
    if (requestPath === "/" || requestPath === "/index.html") {
      return new Response(localClient, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    const resolved = normalize(join(root, requestPath));

    // Refuse to serve anything outside the client directory. Without this a
    // request for `reaper://app/../../../etc/passwd` would escape the root.
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      return new Response("Forbidden", { status: 403 });
    }

    // Single-page app fallback: any path that isn't a real file is a client
    // route, so hand back index.html and let the router sort it out. This is
    // what a web server would do, and it's why deep links and refreshes work.
    const isFile = existsSync(resolved) && statSync(resolved).isFile();
    const target = isFile ? resolved : join(root, "index.html");

    if (!existsSync(target)) {
      return missingBundleResponse();
    }

    try {
      const response = await net.fetch(pathToFileURL(target).toString());

      if (!response.ok) {
        log("[protocol]", `upstream ${response.status} for ${target}`);
      }

      log("[protocol]", `${requestPath} -> ${contentTypeFor(target)}`);

      // Re-wrap so we control the headers. The body is passed through as a
      // stream rather than buffered, so large assets don't sit in memory.
      return new Response(response.body, {
        status: response.status,
        headers: {
          "content-type": contentTypeFor(target),
          // The entry script and stylesheet are tagged `crossorigin` by Vite,
          // which makes the browser fetch them in CORS mode. Same-origin
          // requests should pass without this, but custom schemes are enough
          // of an edge case that stating it explicitly costs nothing and
          // removes a whole category of silent failure.
          "access-control-allow-origin": "*",
          // No caching. The bundle is on local disk, so caching buys nothing
          // measurable, and it costs two real things: a stale bundle can
          // survive an app update, and cached responses skip this handler
          // entirely — which makes the request log lie by omission when
          // something goes wrong.
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      // Reading the file failed outright. Without this the request rejects
      // and Chromium reports a generic network error, which says nothing
      // about which file or why.
      log("[protocol]", `FAILED ${requestPath} -> ${target}:`, String(error));

      return new Response(`Failed to read ${requestPath}`, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  });
}
