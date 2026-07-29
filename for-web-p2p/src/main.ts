import { boot, onStatus, type BootStatus } from "./boot";
import { askAboutNotifications, installBridge, installNative } from "./bridge";

/**
 * Starting the app, in two phases.
 *
 * Until storage and compression are up there is nothing worth showing — the
 * interface would replay a log it cannot read — so a status screen holds the
 * ground. Once they are, the real interface takes over the page.
 *
 * That interface is `for-desktop-p2p/src/local-ui/index.html`, unmodified: the
 * same file the desktop ships, driven by the same core, through a `window.p2p`
 * that calls the same handlers. Read through a build plugin rather than copied,
 * so three builds cannot drift into three products.
 */

const STATES: Record<string, { label: string; detail: string }> = {
  "storage:loading": {
    label: "Reading your history",
    detail: "Loaded from this browser's storage before anything else starts.",
  },
  "storage:ready": {
    label: "Storage ready",
    detail: "History is in this browser, encrypted with a key only it holds.",
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
  "network:off": {
    label: "Not connected",
    detail: "Your history is here. Nothing is being sent or received.",
  },
  "network:connecting": {
    label: "Reaching the relay",
    detail: "Every connection goes through it, and through Tor beyond it.",
  },
  "network:outbound": {
    label: "Connected",
    detail: "This session reaches your devices and peers. They cannot reach it.",
  },
  "network:failed": {
    label: "Relay unreachable",
    detail: "Nothing can be sent or received until it answers.",
  },
};

function paint(status: BootStatus): void {
  const box = document.getElementById("status");
  if (!box) return;

  const rows: [string, string][] = [
    ["storage", status.storage],
    ["compression", status.compression],
    ["network", status.network],
  ];

  box.textContent = "";

  for (const [what, state] of rows) {
    const known = STATES[`${what}:${state}`];

    const row = document.createElement("div");
    row.className = "row";

    const dot = document.createElement("div");
    dot.className = `dot ${state}`;
    row.appendChild(dot);

    const grow = document.createElement("div");
    grow.className = "grow";

    const label = document.createElement("div");
    label.className = "what";
    label.textContent = known?.label ?? `${what}: ${state}`;
    grow.appendChild(label);

    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = known?.detail ?? "";
    grow.appendChild(detail);

    row.appendChild(grow);
    box.appendChild(row);
  }

  const note = document.getElementById("note");
  if (note && status.error) note.textContent = status.error;
}

onStatus(paint);

/**
 * Swap the status screen for the real interface.
 *
 * The bridge goes in *before* the page runs, not after: its script reads
 * `window.p2p` while it is still parsing, and an interface that starts against
 * an absent bridge throws once and never recovers.
 */
async function showInterface(): Promise<void> {
  const html = (await import("./interface")).default;

  installBridge();
  installNative();

  const parsed = new DOMParser().parseFromString(html, "text/html");

  // Kept across the swap.
  //
  // Replacing `head.innerHTML` throws away everything this page declared — the
  // icons, the manifest, the theme colour — and the shared interface declares
  // none of them, because on a desktop those are the packaging's job and on a
  // phone they are the app bundle's. So the tab lost its icon a second after
  // gaining it, which reads as the icon never having worked.
  //
  // Captured before, re-appended after. The same shape of bug cost the iOS
  // build its entire stylesheet once; this is the cheapest place to stop it
  // happening a third time.
  const keep = Array.from(
    document.head.querySelectorAll('link[rel*="icon"], link[rel="manifest"], meta[name="theme-color"]'),
  ).map((node) => node.cloneNode(true));

  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;

  for (const node of keep) document.head.appendChild(node);

  // Scripts do not run when they arrive as parsed markup — they have to be
  // recreated as elements for the browser to execute them.
  for (const original of Array.from(parsed.querySelectorAll("script"))) {
    const script = document.createElement("script");

    for (const attribute of Array.from(original.attributes)) {
      script.setAttribute(attribute.name, attribute.value);
    }

    script.textContent = original.textContent;
    document.body.appendChild(script);
  }
}

const stalled = setTimeout(() => {
  const note = document.getElementById("note");
  if (note) {
    note.textContent =
      "This is taking longer than it should. Whichever row above is the last " +
      "state reached is where it stopped.";
  }
}, 60_000);

void boot().then(async (status) => {
  clearTimeout(stalled);

  // The network is allowed to be down — history is local, and a session with
  // no relay should still show its conversations. Storage is not: without it
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
    // Reported on the screen, not just the console. A failure here otherwise
    // leaves the startup screen up for ever with nothing to explain it.
    const note = document.getElementById("note");
    if (note) {
      note.textContent = `The interface could not start: ${(error as Error).message}`;
    }
    console.error("[boot] the interface could not start:", error);
  }
});
