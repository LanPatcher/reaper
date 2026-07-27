import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";

import { Buffer } from "buffer";

/**
 * `node:fs`, for a WebView.
 *
 * ## The mismatch
 *
 * The log is written synchronously — `appendFileSync`, `readFileSync`,
 * `existsSync` — and every filesystem a WebView can reach is asynchronous.
 * That is not a small difference to paper over: `readFileSync` cannot return a
 * promise, and the code above it is a hot loop that replays thousands of
 * events.
 *
 * ## What this does instead
 *
 * Keeps the files in memory and persists in the background.
 *
 *   - Everything is loaded once at startup, into a map of path to bytes.
 *   - Reads answer from that map, synchronously and immediately.
 *   - Writes update the map, synchronously, and mark the path dirty.
 *   - A debounced flush writes dirty paths out through Capacitor.
 *
 * The log was already designed around this shape: appends are buffered so a
 * batch compresses usefully, which means the desktop build also holds a couple
 * of seconds of writes in memory. This widens that window rather than
 * introducing it.
 *
 * ## What it costs
 *
 * Memory proportional to history. A megabyte of log is a megabyte of heap, and
 * on a phone that is a real ceiling — a few hundred megabytes of conversation
 * would not fit. Compaction and the version-vector watermarks both help, and
 * neither makes the ceiling go away.
 *
 * The proper fix is the Origin Private File System, whose
 * `createSyncAccessHandle` is genuinely synchronous — but only inside a Web
 * Worker, which means moving the whole P2P core off the main thread. That is
 * the right end state and a larger change than this one; it is written up in
 * `docs/ios-port.md` rather than half-done here.
 *
 * ## Durability
 *
 * A flush that has not run yet is lost if the app is killed. Two things reduce
 * that to something acceptable: the flush is also triggered when the app
 * leaves the foreground, which is when iOS is most likely to kill it, and the
 * frame format bounds the damage — a torn write costs the last frame, not the
 * file, because frames are independently length-prefixed.
 */

/** Where everything lives, under the app's private Documents directory. */
const ROOT = "reaper";

/** How long to wait for writes to settle before persisting. */
const FLUSH_DELAY_MS = 400;

/** In-memory mirror of the tree. Keys are paths relative to `ROOT`. */
const files = new Map<string, Buffer>();

/** Paths written since the last flush. */
const dirty = new Set<string>();

/** Paths deleted since the last flush. */
const removed = new Set<string>();

let timer: ReturnType<typeof setTimeout> | undefined;
let flushing: Promise<void> | undefined;

// ---- startup ----------------------------------------------------------------

/**
 * Read the whole tree into memory.
 *
 * Must finish before anything opens a store. Until it does, `existsSync` would
 * answer "no" for files that are on the disk, and the app would decide it is a
 * fresh install and generate a new identity — losing the account.
 */
export async function ready(): Promise<void> {
  files.clear();
  dirty.clear();
  removed.clear();

  await Filesystem.mkdir({
    path: ROOT,
    directory: Directory.Data,
    recursive: true,
  }).catch(() => {
    // Already there, which is the desired state.
  });

  await load(ROOT);
}

async function load(path: string): Promise<void> {
  let entries;

  try {
    entries = await Filesystem.readdir({ path, directory: Directory.Data });
  } catch {
    return;
  }

  for (const entry of entries.files) {
    const full = `${path}/${entry.name}`;

    if (entry.type === "directory") {
      await load(full);
      continue;
    }

    try {
      const read = await Filesystem.readFile({
        path: full,
        directory: Directory.Data,
      });

      // Capacitor hands back base64 for binary reads, which is what every file
      // here is — encrypted frames and content-addressed blobs.
      files.set(relative(full), Buffer.from(read.data as string, "base64"));
    } catch {
      // A file that cannot be read is left out rather than crashing startup.
      // The log tolerates a missing segment; it does not tolerate not opening.
    }
  }
}

function relative(path: string): string {
  return path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : path;
}

function absolute(path: string): string {
  const clean = path.replace(/^\/+/, "");
  return clean.startsWith(`${ROOT}/`) ? clean : `${ROOT}/${clean}`;
}

/** The key a path is stored under. */
function key(path: string): string {
  return relative(absolute(path));
}

// ---- the synchronous surface ------------------------------------------------

export function existsSync(path: string): boolean {
  const at = key(path);
  if (files.has(at)) return true;

  // Directories are not stored, so one exists when something is inside it.
  const prefix = `${at}/`;
  for (const known of files.keys()) {
    if (known.startsWith(prefix)) return true;
  }

  return false;
}

export function readFileSync(path: string): Buffer;
export function readFileSync(path: string, encoding: BufferEncoding): string;
export function readFileSync(path: string, encoding?: BufferEncoding) {
  const data = files.get(key(path));

  if (!data) {
    // Shaped like Node's, because the callers check `.code` to tell "not
    // there yet" from "something is wrong".
    const error = new Error(`ENOENT: no such file, open '${path}'`) as Error & {
      code: string;
    };
    error.code = "ENOENT";
    throw error;
  }

  return encoding ? data.toString(encoding) : data;
}

export function writeFileSync(
  path: string,
  data: Buffer | Uint8Array | string,
): void {
  files.set(key(path), asBuffer(data));
  touch(key(path));
}

export function appendFileSync(
  path: string,
  data: Buffer | Uint8Array | string,
): void {
  const at = key(path);
  const existing = files.get(at);
  const addition = asBuffer(data);

  files.set(at, existing ? Buffer.concat([existing, addition]) : addition);
  touch(at);
}

export function mkdirSync(_path: string, _options?: { recursive?: boolean }): void {
  // Nothing to do. Directories exist here exactly when they contain something,
  // and Capacitor creates the parents on write.
}

export function unlinkSync(path: string): void {
  const at = key(path);
  if (!files.delete(at)) return;

  dirty.delete(at);
  removed.add(at);
  schedule();
}

export function rmSync(
  path: string,
  options?: { recursive?: boolean; force?: boolean },
): void {
  const at = key(path);

  if (options?.recursive) {
    const prefix = `${at}/`;
    for (const known of [...files.keys()]) {
      if (known === at || known.startsWith(prefix)) {
        files.delete(known);
        dirty.delete(known);
        removed.add(known);
      }
    }
    schedule();
    return;
  }

  unlinkSync(path);
}

export function renameSync(from: string, to: string): void {
  const source = key(from);
  const target = key(to);
  const prefix = `${source}/`;

  for (const known of [...files.keys()]) {
    if (known !== source && !known.startsWith(prefix)) continue;

    const moved = known === source ? target : target + known.slice(source.length);
    files.set(moved, files.get(known)!);
    files.delete(known);

    dirty.delete(known);
    removed.add(known);
    touch(moved);
  }
}

export function readdirSync(
  path: string,
  options?: { withFileTypes?: boolean },
): unknown[] {
  const prefix = key(path) === "" ? "" : `${key(path)}/`;
  const names = new Set<string>();
  const directories = new Set<string>();

  for (const known of files.keys()) {
    if (prefix && !known.startsWith(prefix)) continue;

    const rest = known.slice(prefix.length);
    const slash = rest.indexOf("/");

    if (slash === -1) {
      names.add(rest);
    } else {
      const name = rest.slice(0, slash);
      names.add(name);
      directories.add(name);
    }
  }

  const sorted = [...names].sort();

  if (!options?.withFileTypes) return sorted;

  return sorted.map((name) => ({
    name,
    isDirectory: () => directories.has(name),
    isFile: () => !directories.has(name),
  }));
}

export function statSync(path: string): { size: number } {
  const data = files.get(key(path));
  if (!data) throw new Error(`ENOENT: no such file, stat '${path}'`);
  return { size: data.length };
}

export function cpSync(
  from: string,
  to: string,
  _options?: { recursive?: boolean },
): void {
  const source = key(from);
  const prefix = `${source}/`;

  for (const known of [...files.keys()]) {
    if (known !== source && !known.startsWith(prefix)) continue;

    const copy = known === source
      ? key(to)
      : key(to) + known.slice(source.length);

    files.set(copy, Buffer.from(files.get(known)!));
    touch(copy);
  }
}

function asBuffer(data: Buffer | Uint8Array | string): Buffer {
  return typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
}

// ---- persistence ------------------------------------------------------------

function touch(at: string): void {
  dirty.add(at);
  removed.delete(at);
  schedule();
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void flush();
  }, FLUSH_DELAY_MS);
}

/**
 * Write everything outstanding to disk.
 *
 * Also called directly when the app leaves the foreground, which is the moment
 * it is most likely to be killed and therefore the moment a pending write is
 * most likely to be lost.
 */
export async function flush(): Promise<void> {
  // One at a time. Two overlapping flushes can write the same path in the
  // wrong order, and the loser is a log segment several frames behind.
  if (flushing) return flushing;

  flushing = (async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }

    const writes = [...dirty];
    const deletes = [...removed];
    dirty.clear();
    removed.clear();

    for (const at of deletes) {
      await Filesystem.deleteFile({
        path: `${ROOT}/${at}`,
        directory: Directory.Data,
      }).catch(() => {
        // Already gone.
      });
    }

    for (const at of writes) {
      const data = files.get(at);
      if (!data) continue;

      const path = `${ROOT}/${at}`;
      const folder = path.slice(0, path.lastIndexOf("/"));

      await Filesystem.mkdir({
        path: folder,
        directory: Directory.Data,
        recursive: true,
      }).catch(() => {
        // Already there.
      });

      try {
        await Filesystem.writeFile({
          path,
          directory: Directory.Data,
          data: data.toString("base64"),
        });
      } catch (error) {
        // Put it back, so the next flush tries again rather than the write
        // being quietly forgotten.
        dirty.add(at);
        console.error(`[fs] could not write ${at}:`, error);
      }
    }
  })().finally(() => {
    flushing = undefined;
  });

  return flushing;
}

/** Bytes held in memory. Shown in settings, since it is a real limit here. */
export function heldBytes(): number {
  let total = 0;
  for (const data of files.values()) total += data.length;
  return total;
}

// Not part of Node's surface — used by the writable-stream shape `log.ts`
// expects for its buffered appends.
export { Encoding };
