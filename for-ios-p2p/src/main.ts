import { boot, onStatus, type BootStatus } from "./boot";
import { installBridge, installNative } from "./bridge";
import { installMobileLayout } from "./mobile";

import "./mobile.css";

/**
 * Starting the app.
 *
 * Two phases, and the split matters. Until storage and compression are up
 * there is nothing worth showing — the interface would replay a log it cannot
 * read — so a status screen holds the ground. Once they are, the real
 * interface takes over the page and the status screen is gone.
 *
 * That interface is `for-desktop-p2p/src/local-ui/index.html`, unmodified. Not
 * a port of it: the same file the desktop ships, driven by the same core,
 * through a `window.p2p` that calls the same handlers. The only thing this
 * build adds is the layer that makes it usable with a thumb.
 */

const STATES: Record<string, { label: string; detail: string }> = {
  "storage:loading": {
    label: "Reading the log",
    detail: "Everything is loaded into memory before anything else starts.",
  },
  "storage:failed": {
    label: "Storage failed",
    detail: "The log could not be read. Nothing else has been started.",
  },
  "compression:loading": {
    label: "Loading Brotli",
    detail: "The same encoder the desktop uses, so frames match byte for byte.",
  },
  "compression:failed": {
    label: "Compression failed",
    detail: "Nothing can be written or read from peers until this works.",
  },
  "network:starting": {
    label: "Starting Tor",
    detail: "Every connection goes through it, including the first.",
  },
  "network:connecting": {
    label: "Building a circuit",
    detail: "The first one takes longest. Later starts reuse what it learned.",
  },
  "network:failed": {
    label: "Tor could not start",
    detail: "You can read what is here, but nothing will arrive or send.",
  },
};

function draw(status: BootStatus): void {
  const box = document.getElementById("status");
  const note = document.getElementById("note");
  if (!box || !note) return;

  box.textContent = "";

  for (const key of ["storage", "compression", "network"] as const) {
    const value = status[key];
    const state = STATES[`${key}:${value}`];
    if (!state) continue;

    const row = document.createElement("div");
    row.className = "row";

    const dot = document.createElement("div");
    dot.className = `dot ${value}`;
    row.appendChild(dot);

    const grow = document.createElement("div");
    grow.className = "grow";

    const what = document.createElement("div");
    what.className = "what";
    what.textContent = state.label +
      (key === "network" && value === "connecting" && status.percent
        ? ` — ${status.percent}%`
        : "");
    grow.appendChild(what);

    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = state.detail;
    grow.appendChild(detail);

    row.appendChild(grow);
    box.appendChild(row);
  }

  note.textContent = status.error ?? "";
}

/**
 * Replace the startup screen with the interface.
 *
 * The whole document is swapped rather than a container filled: the shared
 * page brings its own `<style>`, its own body and its own script, and grafting
 * that inside an existing document leaves two sets of rules fighting over the
 * same element ids.
 *
 * The scripts have to be re-created rather than carried across, because a
 * `<script>` that arrives through `innerHTML` is inert — the parser marks it
 * already-executed. That single detail is the difference between a page that
 * renders correctly and does nothing, and a working app.
 */
async function showInterface(): Promise<void> {
  const html = (await import("./interface")).default;

  // Before the page runs, not after. Its script reads `window.p2p` while it is
  // still parsing, and an interface that starts against an absent bridge
  // throws once and never recovers.
  installBridge();
  installNative();

  const parsed = new DOMParser().parseFromString(html, "text/html");

  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;

  // The phone layout goes on before the interface runs, so the first paint is
  // already the right shape rather than a desktop three-column flash.
  installMobileLayout();

  for (const original of Array.from(parsed.querySelectorAll("script"))) {
    const script = document.createElement("script");

    for (const attribute of Array.from(original.attributes)) {
      script.setAttribute(attribute.name, attribute.value);
    }

    script.textContent = original.textContent;
    document.body.appendChild(script);
  }
}

onStatus(draw);

void boot().then(async (status) => {
  // The network is allowed to be down — history is local, and a phone with no
  // signal should still show its conversations. Storage is not: without it
  // there is no identity, and the interface would offer to create an account
  // on top of one that already exists.
  if (status.storage !== "ready" || status.compression !== "ready") {
    console.error("[boot] not starting the interface:", status.error);
    return;
  }

  await showInterface();
});
