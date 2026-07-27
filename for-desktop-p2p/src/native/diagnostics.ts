import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { BrowserWindow, app } from "electron";

declare global {
  interface Window {
    __stoatTraps?: string[];
  }
}

/**
 * Diagnostics for a packaged build.
 *
 * A packaged Electron app has no visible console: `console.log` from the main
 * process goes nowhere the user can see, and renderer errors are only visible
 * with DevTools open. That combination makes a blank window completely opaque
 * — you cannot tell a failed script load from a crashed component from a
 * missing file.
 *
 * So everything interesting is written to a log file, and DevTools is opened
 * automatically when a load actually fails.
 */

let logPath: string | undefined;

/**
 * Where the log is written. Reported in the window title on failure so it can
 * be found without knowing Electron's directory layout.
 */
export function getLogPath(): string {
  if (!logPath) {
    const dir = app.getPath("userData");
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Best effort; appendFileSync below will surface anything fatal.
    }
    logPath = join(dir, "reaper.log");
  }

  return logPath;
}

/**
 * Append a line to the diagnostics log.
 *
 * Deliberately synchronous and failure-tolerant: this is used on paths where
 * the app may be about to become unusable, and losing the log to an async
 * write that never flushed would defeat the point.
 */
export function log(...parts: unknown[]) {
  const line = `[${new Date().toISOString()}] ${parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ")}\n`;

  // Still useful when run from a terminal via `pnpm start`.
  process.stdout.write(line);

  try {
    appendFileSync(getLogPath(), line);
  } catch {
    // Nothing sensible to do if even logging fails.
  }
}

/**
 * Attach diagnostics to a window.
 */
export function attachDiagnostics(window: BrowserWindow) {
  const contents = window.webContents;

  // Renderer console output. This is where a blocked script, a failed import
  // or a thrown component error actually shows up.
  contents.on("console-message", (event) => {
    const { level, message, lineNumber, sourceId } = event;
    log(`[renderer:${level}]`, `${message}`, `(${sourceId}:${lineNumber})`);
  });

  // The page itself failed to load.
  contents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      log(
        "[did-fail-load]",
        `code=${errorCode}`,
        `desc=${errorDescription}`,
        `url=${validatedURL}`,
        `mainFrame=${isMainFrame}`,
      );

      if (isMainFrame) {
        openDevTools(window, "page failed to load");
      }
    },
  );

  // A subresource failed. Chromium reports blocked module scripts here, which
  // is exactly the class of failure that renders a blank page silently.
  contents.on("did-fail-provisional-load", (_e, code, desc, url) => {
    log("[provisional-load-failed]", `code=${code}`, `desc=${desc}`, `url=${url}`);
  });

  contents.on("render-process-gone", (_event, details) => {
    log("[render-process-gone]", JSON.stringify(details));
    openDevTools(window, "renderer process died");
  });

  contents.on("preload-error", (_event, preloadPath, error) => {
    log("[preload-error]", preloadPath, error?.message ?? String(error));
  });

  contents.on("did-finish-load", () => {
    log("[did-finish-load]", contents.getURL());

    // Install renderer-side error traps. Uncaught exceptions and rejected
    // promises inside a framework's async boundaries do not always reach
    // `console-message`, and those are exactly the failures that leave a
    // rendered-but-empty page.
    contents
      .executeJavaScript(
        `(() => {
          if (window.__stoatTraps) return;
          window.__stoatTraps = [];
          window.addEventListener("error", (e) => {
            window.__stoatTraps.push("error: " + (e.error?.stack || e.message));
          });
          window.addEventListener("unhandledrejection", (e) => {
            window.__stoatTraps.push(
              "unhandledrejection: " + (e.reason?.stack || String(e.reason))
            );
          });
        })()`,
        true,
      )
      .catch(() => void 0);

    // Check late, not immediately. Solid mounts asynchronously and lazy route
    // components resolve after that, so an instant check reports "empty" on a
    // perfectly healthy app — which it did, and sent me chasing the wrong
    // thing. Two seconds is well past a normal boot.
    setTimeout(() => void inspectRender(window), 2000);
  });

  // Manual access, since the default menu (and its DevTools accelerator) is
  // removed for this app.
  contents.on("before-input-event", (_event, input) => {
    const wantsDevTools =
      input.key === "F12" ||
      (input.control && input.shift && input.key.toLowerCase() === "i");

    if (wantsDevTools && input.type === "keyDown") {
      contents.isDevToolsOpened()
        ? contents.closeDevTools()
        : contents.openDevTools({ mode: "right" });
    }
  });
}

/**
 * Report on what the page actually rendered.
 *
 * "Blank window" has several very different causes that look identical from
 * outside: nothing mounted, something mounted but is zero-height, something
 * mounted but is transparent or scrolled away, or a component threw during
 * render. This distinguishes them, because guessing between them from a
 * screenshot does not work.
 */
async function inspectRender(window: BrowserWindow) {
  if (window.isDestroyed()) return;

  try {
    const report = await window.webContents.executeJavaScript(
      `(() => {
        const root = document.getElementById("root");
        const body = document.body;
        const el = root && root.firstElementChild;
        const rect = el && el.getBoundingClientRect();
        const cs = el && getComputedStyle(el);
        const bodyStyle = getComputedStyle(body);

        // LoadTheme applies every --md-sys-color-* variable as an inline style
        // on <body>. If those are missing, the app renders at full size with
        // every colour resolving to nothing — visually a black window, which
        // is indistinguishable from "nothing rendered" without checking.
        const themeVar = bodyStyle.getPropertyValue("--md-sys-color-surface").trim();

        return {
          url: location.href,
          readyState: document.readyState,
          rootExists: !!root,
          rootChildren: root ? root.childElementCount : -1,
          rootHtmlLength: root ? root.innerHTML.length : -1,
          rootHtmlHead: root ? root.innerHTML.slice(0, 200) : "",
          bodyChildren: body ? body.childElementCount : -1,
          firstChildTag: el ? el.tagName : null,
          firstChildBox: rect
            ? { w: Math.round(rect.width), h: Math.round(rect.height) }
            : null,
          firstChildStyle: cs
            ? {
                display: cs.display,
                visibility: cs.visibility,
                opacity: cs.opacity,
                background: cs.backgroundColor,
                color: cs.color,
              }
            : null,
          // Did LoadTheme's effect actually run to completion?
          themeVarsApplied: body.style.length,
          themeSurface: themeVar || "(UNSET)",
          bodyBackground: bodyStyle.backgroundColor,
          // The decisive one: text present but invisible still shows here.
          visibleText: (body.innerText || "").replace(/\\s+/g, " ").slice(0, 300),
          stylesheets: document.styleSheets.length,
          traps: window.__stoatTraps || [],
        };
      })()`,
      true,
    );

    log("[render-report]", JSON.stringify(report));

    if (Array.isArray(report.traps) && report.traps.length > 0) {
      for (const trap of report.traps) {
        log("[renderer-exception]", String(trap));
      }
    }

    if (report.rootChildren > 0) {
      log("[ok]", "App mounted.");
      // Mounted but occupying no space is still a blank window to the user.
      const box = report.firstChildBox;
      if (box && (box.w === 0 || box.h === 0)) {
        log("[warn]", "Mounted content has zero size — a layout/CSS problem.");
        openDevTools(window, "rendered content has zero size");
      }
      return;
    }

    // `rootChildren` is -1 when there is no `#root` element at all, which is
    // not a failure — it means the page simply isn't the Solid client. Only
    // an empty `#root` indicates a mount that went wrong.
    //
    // Treating "no #root" as "did not mount" popped DevTools open on every
    // launch of a page that had rendered perfectly well.
    if (report.rootChildren === -1) {
      log("[ok]", "No #root element; not a Solid build. Skipping mount check.");
      return;
    }

    log("[empty-render]", "#root is still empty two seconds after load.");
    openDevTools(window, "app did not mount");
  } catch (error) {
    log("[render-report-failed]", String(error));
  }
}

/**
 * Open DevTools and say why in the log.
 */
function openDevTools(window: BrowserWindow, reason: string) {
  log("[devtools]", `opening automatically: ${reason}`);
  log("[devtools]", `log file: ${getLogPath()}`);

  if (!window.isDestroyed()) {
    window.webContents.openDevTools({ mode: "right" });
    window.show();
  }
}
