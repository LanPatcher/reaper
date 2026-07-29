import { Buffer } from "buffer";

/**
 * `node:fs`, over IndexedDB.
 *
 * The same shape as the iOS shim and for the same reason: the core is
 * synchronous about the disk — `existsSync`, `readFileSync`, `appendFileSync`
 * — and every storage a browser has is asynchronous. So the whole account is
 * held in memory as a map of path to bytes, reads and writes hit that map, and
 * a debounced flush puts it back into IndexedDB.
 *
 * That is only reasonable because of what is being stored: an account's own
 * logs, which are compressed and encrypted and measured in megabytes rather
 * than gigabytes. Attachments never come near it — they are fetched from
 * whoever sent them and are not part of a browser session at all.
 *
 * ## What this costs, and the one thing it must never do
 *
 * `ready()` has to finish before anything reads. Until the map is populated,
 * `existsSync` answers "no" for files that are on the disk — and the very
 * first thing the app asks is whether it has an identity. Answering wrongly
 * means generating a new one over the top of an account that already exists,
 * which on this platform means losing it: there is no other copy on the
 * machine, and the key is the account.
 *
 * That is the single most dangerous line in this file and it is why `boot`
 * awaits this before it does anything else.
 *
 * ## Why IndexedDB and not localStorage
 *
 * localStorage is synchronous, which would be far more convenient here, and it
 * is a few megabytes of UTF-16 strings. An account's log passes that quickly,
 * and the failure when it does is a thrown quota error in the middle of a
 * write. IndexedDB stores bytes as bytes and is measured in a fraction of the
 * disk.
 */

const DB = "reaper";
const STORE = "files";

/** Everything, by path. The whole account, in memory. */
const files = new Map<string, Buffer>();

/** Paths written or removed since the last flush. */
const dirty = new Set<string>();
const removed = new Set<string>();

let timer: ReturnType<typeof setTimeout> | undefined;
let flushing: Promise<void> | undefined;
let database: IDBDatabase | undefined;

/**
 * How long to let writes settle.
 *
 * Appending is what the app does constantly, and each append is a few hundred
 * bytes. Writing through on every one would mean a transaction per keystroke's
 * worth of activity. The window is short enough that the flush on hide — see
 * `watchUnload` — closes it in every case a browser gives warning of.
 */
const FLUSH_DELAY_MS = 400;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb refused to open"));

    // Another tab holding an upgrade open. Worth naming: it presents as the
    // app hanging on its first screen with nothing in the console.
    request.onblocked = () =>
      reject(new Error("another tab of this app is open and busy — close it and reload"));
  });
}

let loaded: Promise<void> | undefined;

/**
 * Load the account into memory.
 *
 * Awaited before anything else runs. See the note above about what happens if
 * it is not.
 */
export function ready(): Promise<void> {
  if (loaded) return loaded;

  loaded = (async () => {
    database = await open();

    await new Promise<void>((resolve, reject) => {
      const transaction = database!.transaction(STORE, "readonly");
      const cursor = transaction.objectStore(STORE).openCursor();

      cursor.onsuccess = () => {
        const at = cursor.result;

        if (!at) { resolve(); return; }

        const value = at.value as ArrayBuffer | Uint8Array;
        files.set(String(at.key), Buffer.from(value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : value));

        at.continue();
      };

      cursor.onerror = () => reject(cursor.error ?? new Error("could not read storage"));
    });

    watchUnload();
  })();

  return loaded;
}

/**
 * Normalise a path into a key.
 *
 * The core builds paths with `join`, which on this platform is the POSIX one,
 * so they arrive as `/`-separated already. Leading slashes are dropped so the
 * root is "" and a prefix match on a directory is a plain `startsWith`.
 */
function key(path: string): string {
  return String(path).replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+$/, "");
}

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

export function existsSync(path: string): boolean {
  const at = key(path);
  if (files.has(at)) return true;

  // A directory exists when something is in it. There are no directories in
  // this store — only paths — so the question is answered the only way it can
  // be, and it is the same answer the iOS shim gives.
  const prefix = `${at}/`;
  for (const known of files.keys()) if (known.startsWith(prefix)) return true;

  return false;
}

export function readFileSync(path: string): Buffer;
export function readFileSync(path: string, encoding: BufferEncoding): string;
export function readFileSync(path: string, encoding?: BufferEncoding): Buffer | string {
  const held = files.get(key(path));

  if (!held) {
    const error = new Error(`ENOENT: no such file or directory, open '${path}'`);
    (error as NodeJS.ErrnoException).code = "ENOENT";
    throw error;
  }

  return encoding ? held.toString(encoding) : held;
}

export function writeFileSync(
  path: string,
  data: Buffer | Uint8Array | string,
  _options?: unknown,
): void {
  const at = key(path);
  files.set(at, asBuffer(data));
  touch(at);
}

export function appendFileSync(
  path: string,
  data: Buffer | Uint8Array | string,
  _options?: unknown,
): void {
  const at = key(path);
  const held = files.get(at);
  files.set(at, held ? Buffer.concat([held, asBuffer(data)]) : asBuffer(data));
  touch(at);
}

export function mkdirSync(_path: string, _options?: { recursive?: boolean }): void {
  // Nothing to do. A directory here is a prefix, and a prefix exists exactly
  // when something has that prefix.
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
      if (known !== at && !known.startsWith(prefix)) continue;
      files.delete(known);
      dirty.delete(known);
      removed.add(known);
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
  const at = key(path);
  const prefix = at === "" ? "" : `${at}/`;
  const names = new Set<string>();

  for (const known of files.keys()) {
    if (!known.startsWith(prefix)) continue;

    const rest = known.slice(prefix.length);
    if (!rest) continue;

    const cut = rest.indexOf("/");
    names.add(cut < 0 ? rest : rest.slice(0, cut));
  }

  const listed = [...names];

  if (!options?.withFileTypes) return listed;

  return listed.map((name) => ({
    name,
    isDirectory: () => !files.has(prefix + name),
    isFile: () => files.has(prefix + name),
  }));
}

export function statSync(path: string): { size: number } {
  const held = files.get(key(path));

  if (!held) {
    const error = new Error(`ENOENT: no such file or directory, stat '${path}'`);
    (error as NodeJS.ErrnoException).code = "ENOENT";
    throw error;
  }

  return { size: held.length };
}

export function cpSync(from: string, to: string, _options?: unknown): void {
  const source = key(from);
  const target = key(to);
  const prefix = `${source}/`;

  for (const known of [...files.keys()]) {
    if (known !== source && !known.startsWith(prefix)) continue;

    const copied = known === source ? target : target + known.slice(source.length);
    files.set(copied, Buffer.from(files.get(known)!));
    touch(copied);
  }
}

export function openSync(path: string, _flags?: string): string {
  const at = key(path);
  if (!files.has(at)) { files.set(at, Buffer.alloc(0)); touch(at); }
  return at;
}

export function closeSync(_handle: string): void {
  // Nothing is held open. Writes went straight into the map.
}

export function truncateSync(path: string, length = 0): void {
  const at = key(path);
  const held = files.get(at);
  if (!held) return;

  files.set(at, held.subarray(0, length));
  touch(at);
}

function asBuffer(data: Buffer | Uint8Array | string): Buffer {
  return typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
}

/**
 * Write everything outstanding.
 *
 * One at a time: two overlapping flushes can write the same path in the wrong
 * order, and the loser is a log segment several frames behind.
 */
export function flush(): Promise<void> {
  if (flushing) return flushing;
  if (!database) return Promise.resolve();

  flushing = (async () => {
    if (timer) { clearTimeout(timer); timer = undefined; }

    const writes = [...dirty];
    const deletes = [...removed];
    dirty.clear();
    removed.clear();

    if (!writes.length && !deletes.length) return;

    await new Promise<void>((resolve, reject) => {
      const transaction = database!.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);

      for (const at of deletes) store.delete(at);

      for (const at of writes) {
        const data = files.get(at);
        if (!data) continue;

        // A copy, and not the Buffer itself. Buffers in this runtime are views
        // onto a shared pool, so storing one can persist a window over
        // somebody else's bytes — which reads back as a file with another
        // file's contents in it.
        store.put(new Uint8Array(data), at);
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        // Put them back, so the next flush tries again rather than the write
        // being quietly forgotten.
        for (const at of writes) dirty.add(at);
        reject(transaction.error ?? new Error("could not write to storage"));
      };
    });
  })().finally(() => { flushing = undefined; });

  return flushing;
}

/** Bytes held in memory. Shown in settings, since it is a real limit here. */
export function heldBytes(): number {
  let total = 0;
  for (const data of files.values()) total += data.length;
  return total;
}

/**
 * Flush before the tab goes.
 *
 * `visibilitychange` to hidden rather than `beforeunload`, because that is the
 * one a browser actually guarantees on a phone — a tab discarded in the
 * background never sees an unload. This is the same window the iOS build
 * closes when the app is backgrounded, for the same reason.
 */
function watchUnload(): void {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush();
  });

  window.addEventListener("pagehide", () => { void flush(); });
}

export { Buffer as Encoding };
