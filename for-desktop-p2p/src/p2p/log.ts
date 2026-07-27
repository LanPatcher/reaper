import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  truncateSync,
} from "node:fs";
import { join } from "node:path";

import { HEADER_SIZE, decodeFrame, encodeFrame } from "./frames";

/**
 * Append-only event log, stored as a series of compressed encrypted segments.
 *
 * ## Why a log and not SQLite
 *
 * The obvious choice for local storage is a database, and for a purely local
 * app it would be the right one. It isn't here, for a reason that only shows
 * up once peers start syncing.
 *
 * In a serverless network there is no authority to ask "what is the current
 * state of this channel". Peers reconcile by exchanging the events they have
 * that the other doesn't — so the thing on disk has to be an ordered,
 * append-only, individually-signed sequence. That *is* a log. Storing state in
 * tables would mean maintaining a second, separate log purely to sync from,
 * and keeping the two consistent forever.
 *
 * So the log is the source of truth and the wire format at once. Anything that
 * wants random access builds an index over it, which is cheap and disposable.
 *
 * ## Segments
 *
 * The log is split into numbered segment files rather than one growing file:
 *
 *   000000.seg, 000001.seg, ...
 *
 * A cap on segment size means a torn write can only ever cost the tail of the
 * newest segment, old segments become immutable (so they can be checksummed,
 * backed up, or served to a syncing peer without a lock), and pruning history
 * later is a file deletion rather than a rewrite.
 */

/**
 * Roll to a new segment once the current one passes this.
 *
 * Measured on the *compressed* size, which is the whole reason this number
 * looks small. Chat text lands around 25x, so a 1 MiB segment already holds
 * something like 25 MB of raw history — on the order of a hundred thousand
 * messages. Setting it higher produced a single segment that never rolled at
 * any realistic volume, which quietly removed the benefit of segmenting at
 * all: sealed segments are what let old history be checksummed, pruned, or
 * handed to a syncing peer without touching the file being written to.
 */
const SEGMENT_TARGET_BYTES = 1024 * 1024;

/**
 * Events buffered before a frame is written.
 *
 * The entire compression argument depends on batching — see frames.ts. Too
 * small and the ratio collapses; too large and a crash loses more unflushed
 * work. A few hundred messages is well under a second of typing for a group
 * this size.
 */
const DEFAULT_BATCH_SIZE = 256;

/** Flush a partial batch after this long, so a quiet channel still persists. */
const DEFAULT_FLUSH_INTERVAL_MS = 2000;

export interface LogOptions {
  batchSize?: number;
  flushIntervalMs?: number;
}

export class EventLog {
  readonly #dir: string;
  readonly #key: Buffer;
  readonly #batchSize: number;
  readonly #flushIntervalMs: number;

  #pending: Buffer[] = [];
  #flushTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(dir: string, key: Buffer, options: LogOptions = {}) {
    this.#dir = dir;
    this.#key = key;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

    mkdirSync(dir, { recursive: true });
  }

  /**
   * Segment files, oldest first.
   */
  #segments(): string[] {
    // Tolerates the directory having been removed underneath us — recovery
    // paths move it aside, and a missing directory means no segments, not a
    // failure worth propagating.
    if (!existsSync(this.#dir)) return [];

    return readdirSync(this.#dir)
      .filter((name) => name.endsWith(".seg"))
      .sort();
  }

  /**
   * Path of the segment new frames should go into, creating one if needed.
   */
  #activeSegment(): string {
    const segments = this.#segments();

    if (segments.length === 0) {
      return join(this.#dir, "000000.seg");
    }

    const newest = segments[segments.length - 1];
    const path = join(this.#dir, newest);

    if (statSync(path).size < SEGMENT_TARGET_BYTES) return path;

    const index = Number.parseInt(newest.slice(0, 6), 10) + 1;
    return join(this.#dir, `${String(index).padStart(6, "0")}.seg`);
  }

  /**
   * Append an event. Buffered; see `flush`.
   */
  append(event: unknown): void {
    if (this.#closed) throw new Error("log is closed");

    this.#pending.push(Buffer.from(JSON.stringify(event), "utf8"));

    if (this.#pending.length >= this.#batchSize) {
      this.flush();
      return;
    }

    this.#flushTimer ??= setTimeout(() => this.flush(), this.#flushIntervalMs);
  }

  /**
   * Write buffered events out as one frame.
   */
  flush(): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }

    if (this.#pending.length === 0) return;

    // Newline-delimited JSON inside the frame. Line-oriented means a reader
    // can stream the batch without loading a parsed array, and it compresses
    // marginally better than a JSON array by dropping the punctuation.
    const payload = Buffer.concat(
      this.#pending.flatMap((event) => [event, Buffer.from("\n")]),
    );

    this.#pending = [];

    appendFileSync(this.#activeSegment(), encodeFrame(payload, this.#key));
  }

  /**
   * Read every event in the log, oldest first.
   *
   * Yields parsed events one at a time rather than returning an array, so
   * replaying a large history doesn't need all of it resident at once.
   */
  *read(): Generator<unknown> {
    for (const name of this.#segments()) {
      const path = join(this.#dir, name);
      const buffer = readFileSync(path);

      let offset = 0;

      while (offset < buffer.length) {
        let frame;
        try {
          frame = decodeFrame(buffer, offset, this.#key);
        } catch (error) {
          // Authentication failure. Not recoverable by truncating: it means
          // the key is wrong or the bytes are damaged, and either way the rest
          // of this segment can't be trusted.
          throw new Error(`${path}: ${(error as Error).message}`);
        }

        // A short or malformed frame at the very end is the signature of a
        // process that died mid-append. Everything before it is intact, so
        // trim the partial frame and carry on rather than refusing to open.
        if (!frame) {
          if (offset < buffer.length) {
            truncateSync(path, offset);
          }
          break;
        }

        for (const line of frame.payload.toString("utf8").split("\n")) {
          if (line.length > 0) yield JSON.parse(line);
        }

        offset += frame.size;
      }
    }
  }

  /**
   * Bytes currently on disk.
   */
  size(): number {
    return this.#segments().reduce(
      (total, name) => total + statSync(join(this.#dir, name)).size,
      0,
    );
  }

  /**
   * Flush and stop accepting writes.
   */
  close(): void {
    this.flush();
    this.#closed = true;
  }
}

/**
 * Whether a directory looks like a log we wrote.
 *
 * Used to tell "no history yet" from "history exists but won't open", which
 * want very different handling: the first is normal, the second should be
 * surfaced rather than silently starting from scratch over the top of it.
 */
export function logExists(dir: string): boolean {
  if (!existsSync(dir)) return false;

  return readdirSync(dir).some((name) => {
    if (!name.endsWith(".seg")) return false;
    return statSync(join(dir, name)).size >= HEADER_SIZE;
  });
}

/**
 * Create an empty segment so `logExists` reports true for a fresh community.
 */
export function touchLog(dir: string): void {
  mkdirSync(dir, { recursive: true });
  closeSync(openSync(join(dir, "000000.seg"), "a"));
}
