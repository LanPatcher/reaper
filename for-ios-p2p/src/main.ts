import { Notify } from "@reaper/notify";

import { boot, onStatus, type BootStatus } from "./boot";
import { installBridge, installNative } from "./bridge";
import { onForeground } from "./lifecycle";
import { installMobileLayout } from "./mobile";

// The phone layout, as text rather than as a side effect.
//
// A plain `import "./mobile.css"` asks the bundler to inject a `<style>` into
// the head at load — and this file then replaces the entire head when it swaps
// in the interface, which threw that style away. Every phone-layout complaint
// traced back to that one line: no slide-over, so the menu button toggled a
// class nothing responded to; no rule hiding the window controls, so they
// stayed; desktop-sized targets everywhere.
//
// Imported as a string and applied *after* the swap instead. There is then
// nothing to preserve and nothing that can be lost, which is a better
// guarantee than remembering to carry it across.
import mobileCss from "./mobile.css?inline";

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
  "storage:ready": {
    label: "Storage ready",
    detail: "History is on this device, encrypted with a key only it holds.",
  },
  "storage:failed": {
    label: "Storage failed",
    detail: "The log could not be read. Nothing else has been started.",
  },
  "compression:loading": {
    label: "Loading Brotli",
    detail: "The same encoder the desktop uses, so frames match byte for byte.",
  },
  "compression:ready": {
    label: "Compression ready",
    detail: "Frames written here can be read by any other Reaper device.",
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
  "network:outbound": {
    label: "Connected",
    detail: "You can reach other people. Publishing your address takes a moment longer.",
  },
  "network:reachable": {
    label: "Reachable",
    detail: "Your address is published. Peers can open a connection to you.",
  },
  "network:off": {
    label: "Not connected",
    detail: "Tor has not been started.",
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

  // Last, so it wins on equal specificity — this is a layer of overrides on
  // top of the interface's own stylesheet, and a rule that arrives first loses
  // every tie.
  const layout = document.createElement("style");
  layout.id = "reaper-mobile";
  layout.textContent = mobileCss;
  document.head.appendChild(layout);

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

/**
 * Nothing should take a minute to start.
 *
 * Every step of startup crosses into native code, and a native call that never
 * answers stalls the `await` above it permanently — no error, no rejection,
 * nothing to catch. That is not hypothetical: binding a port that was already
 * held did exactly this, and the app sat on its startup screen indefinitely
 * with no indication anything was wrong.
 *
 * So the screen says so rather than lying by omission. It does not cancel
 * anything — there is nothing safe to cancel halfway through opening a store —
 * it just stops pretending to be busy.
 */
const stalled = setTimeout(() => {
  const note = document.getElementById("note");
  if (!note || note.textContent) return;

  note.textContent =
    "Startup has taken longer than a minute. Whichever row above has no " +
    "state reached is where it stopped.";
}, 60_000);

/**
 * Ask for notification permission, once, at a moment it makes sense.
 *
 * Deliberately after the interface is up rather than during startup. A system
 * prompt over a "Reading the log" screen asks somebody to decide about
 * notifications before they have seen the app, and the honest answer to that
 * question at that moment is "I do not know yet" — which iOS records as no,
 * permanently, with no second prompt ever.
 *
 * Asked at all rather than left to a settings screen because the app is
 * useless in the background without it: it stays running and keeps receiving,
 * and then has no way to tell anybody. That is the whole feature.
 *
 * Also clears the shade whenever the app comes to the front. Notifications are
 * about things that happened while you were away; still being there once you
 * are back is just a list of things you have already dealt with.
 */
function askAboutNotifications(): void {
  void Notify.permission()
    .then((state) => (state.asked ? state : Notify.request()))
    .catch(() => undefined);

  onForeground((active) => {
    if (!active) return;

    void Notify.clear().catch(() => undefined);
    void Notify.badge({ count: 0 }).catch(() => undefined);
  });
}

void boot().then(async (status) => {
  clearTimeout(stalled);

  // The network is allowed to be down — history is local, and a phone with no
  // signal should still show its conversations. Storage is not: without it
  // there is no identity, and the interface would offer to create an account
  // on top of one that already exists.
  if (status.storage !== "ready" || status.compression !== "ready") {
    console.error("[boot] not starting the interface:", status.error);
    return;
  }

  try {
    await showInterface();
    askAboutNotifications();
  } catch (error) {
    // Reported on the screen, not just the console. There is no console on a
    // phone, and a failure here leaves the startup screen up for ever with
    // nothing to explain it — which is exactly how it presented.
    const note = document.getElementById("note");
    if (note) {
      note.textContent =
        `The interface could not start: ${(error as Error).message}`;
    }
    console.error("[boot] the interface could not start:", error);
  }
});
