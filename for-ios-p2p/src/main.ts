import { boot, onStatus, type BootStatus } from "./boot";

/**
 * What the app shows before the interface exists.
 *
 * This is a startup screen, not a placeholder for one. The three things it
 * reports are the three that decide whether the app can work at all — whether
 * it can read its own log, whether it can read what peers send, and whether it
 * keeps running when it is not on screen — and each of them fails in a way that
 * would otherwise be invisible.
 *
 * The interface itself is the desktop client, which is a single self-contained
 * page driving `window.p2p`. Bringing it across is the next step and needs the
 * transport underneath it first: see `docs/ios-port.md`, which is honest about
 * what is done and what is not.
 */

const STATES: Record<string, { label: string; detail: string }> = {
  "storage:loading": {
    label: "Reading the log",
    detail: "Everything is loaded into memory before anything else starts.",
  },
  "storage:ready": {
    label: "Storage ready",
    detail: "History is on this device and encrypted with a key only it holds.",
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

  "background:off": {
    label: "Background delivery off",
    detail: "Messages will only arrive while Reaper is open.",
  },
  "background:on": {
    label: "Background delivery on",
    detail:
      "A silent audio session keeps the app running. It does not make a " +
      "sound and does not interrupt anything else playing.",
  },
  "background:unavailable": {
    label: "Background delivery unavailable",
    detail: "Messages will only arrive while Reaper is open.",
  },

  "network:off": {
    label: "Not connected",
    detail: "Tor has not been started.",
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
    label: "Connected, not yet reachable",
    detail:
      "You can reach other people. They cannot reach you until this " +
      "device's address is published, which takes a moment longer.",
  },
  "network:reachable": {
    label: "Reachable",
    detail: "Your address is published. Peers can open a connection to you.",
  },
  "network:failed": {
    label: "Tor could not start",
    detail: "Nothing can be sent or received. Everything here needs it.",
  },
};

function humanSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

function draw(status: BootStatus): void {
  const box = document.getElementById("status");
  const note = document.getElementById("note");
  if (!box || !note) return;

  box.textContent = "";

  for (const key of ["storage", "compression", "background", "network"] as const) {
    const value = status[key];
    const state = STATES[`${key}:${value}`];
    if (!state) continue;

    // The one place a number is worth showing: a first bootstrap can take a
    // couple of minutes, and a label that never changes reads as a hang.
    const suffix =
      key === "network" && value === "connecting" && status.percent
        ? ` — ${status.percent}%`
        : "";

    const row = document.createElement("div");
    row.className = "row";

    const dot = document.createElement("div");
    dot.className = `dot ${value}`;
    row.appendChild(dot);

    const grow = document.createElement("div");
    grow.className = "grow";

    const what = document.createElement("div");
    what.className = "what";
    what.textContent = state.label + suffix;
    grow.appendChild(what);

    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = state.detail;
    grow.appendChild(detail);

    row.appendChild(grow);
    box.appendChild(row);
  }

  const lines: string[] = [];

  if (status.error) lines.push(status.error);

  if (status.bytesHeld) {
    // Worth showing, and not as a curiosity: the log is held in memory to be
    // readable synchronously, so on a phone this is a real ceiling rather than
    // a statistic.
    lines.push(`Holding ${humanSize(status.bytesHeld)} in memory.`);
  }

  if (status.onion) {
    // Shown in full. It is this device's address, it has to be given to
    // anybody who wants to reach you, and an abbreviated one cannot be.
    lines.push(`You are at ${status.onion}`);
  }

  note.textContent = lines.join(" ");
}

onStatus(draw);

void boot().then((status) => {
  if (status.storage === "failed") {
    console.error("[boot] storage failed, nothing else started");
  }
});
