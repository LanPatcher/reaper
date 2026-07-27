import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Blobs get their own envelope rather than `crypto.seal`.
 *
 * That helper produces a JSON object with base64 fields, which is right for a
 * message payload and wrong for a file: it would inflate every attachment by a
 * third and force the whole thing through a JSON encoder twice. Here the
 * layout is fixed and binary.
 *
 *   [5-byte magic]["MBLB1"][12-byte nonce][16-byte tag][ciphertext]
 *
 * The magic exists so a store can tell an encrypted file from one written
 * before a key was installed, instead of guessing and producing garbage.
 */
const MAGIC = Buffer.from("MBLB1", "ascii");

function sealBytes(key: Buffer, data: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), body]);
}

/** Undefined when the key is wrong or the file has been tampered with. */
function openBytes(key: Buffer, raw: Buffer): Buffer | undefined {
  if (raw.length < MAGIC.length + 28) return undefined;
  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) return undefined;

  const nonce = raw.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = raw.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const body = raw.subarray(MAGIC.length + 28);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return undefined;
  }
}

function looksSealed(raw: Buffer): boolean {
  return raw.length >= MAGIC.length && raw.subarray(0, MAGIC.length).equals(MAGIC);
}

/**
 * File bytes, kept out of the event log.
 *
 * Attachments used to be part of the message event itself. That is the
 * simplest thing that works and it has two properties that get worse the
 * longer the app is used: every peer downloads every file whether or not
 * anyone ever opens it, and every peer keeps it forever, because an
 * append-only log has no delete. A ten-megabyte upload was a ten-megabyte cost
 * for everyone in the community, permanently, decided entirely by the sender.
 *
 * Here the message carries only a name, a size, a type and an id, and the
 * bytes move separately when someone asks for them. That is what makes an
 * upload limit a *receiver's* setting rather than a sender's: nothing arrives
 * until this device requests it.
 *
 * ## Ids are content hashes
 *
 * A blob is named by the SHA-256 of its bytes. Three things follow, and all of
 * them matter more than the convenience:
 *
 *   - What arrives can be checked against what was asked for. A peer serving
 *     the request cannot substitute different content, because the id would
 *     not match and the bytes are discarded.
 *   - The same file sent twice is stored once.
 *   - The id can be quoted in a signed event, which means the *sender's*
 *     signature covers the file contents too, even though the bytes travel
 *     outside the log.
 */

/**
 * How much of a blob goes in one frame, before base64.
 *
 * Small, and deliberately so. Everything shares one ordered TCP connection,
 * so a frame handed to the kernel cannot be overtaken — the priority scheduler
 * can put a voice packet ahead of the *next* chunk, but not ahead of the one
 * already being written. At 192 KB, and Tor's throughput, that was upwards of
 * a second during which no audio could leave: a call that broke up whenever
 * anybody attached a file, which is exactly what was reported.
 *
 * At 32 KB the gap is a fraction of a segment, so a transfer costs a little
 * throughput and stops costing the conversation. The extra framing is about
 * a hundred bytes per chunk — some tens of kilobytes on a ten-megabyte file,
 * against the megabytes that duplicate transfers were spending.
 */
export const BLOB_CHUNK = 32 * 1024;

/** Bytes of a file, and the id that names it. */
export interface BlobRef {
  id: string;
  size: number;
}

export function blobId(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Per-community blob storage.
 *
 * Kept per community rather than in one pool so that a request can be answered
 * only from the community it was made in. Serving from a global pool would let
 * anyone who learned an id pull a file out of a conversation they are not part
 * of — and ids travel in messages, so learning one is not hard.
 */
export class BlobStore {
  #dir: string;
  #key: Buffer | undefined;

  constructor(dir: string, key?: Buffer) {
    this.#dir = dir;
    this.#key = key;
  }

  /** Install or replace the key used to encrypt blobs at rest. */
  setKey(key: Buffer | undefined): void {
    this.#key = key;
  }

  #path(id: string): string {
    // Ids are hex from a hash, but they arrive over the network, so they are
    // checked rather than trusted: anything else could climb out of the
    // directory.
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`not a blob id: ${id}`);
    return join(this.#dir, id);
  }

  has(id: string): boolean {
    try {
      return existsSync(this.#path(id));
    } catch {
      return false;
    }
  }

  /**
   * Read a blob, or undefined if this device does not hold it.
   *
   * Undefined rather than throwing because "we do not have it" is the ordinary
   * answer to a peer's request, not an error.
   */
  read(id: string): Buffer | undefined {
    try {
      const path = this.#path(id);
      if (!existsSync(path)) return undefined;

      const raw = readFileSync(path);

      // A file written before a key existed stays readable. Deciding by what
      // is on disk rather than by whether a key is loaded means installing a
      // key later does not orphan everything already stored.
      if (!looksSealed(raw)) return raw;
      if (!this.#key) return undefined;
      return openBytes(this.#key, raw);
    } catch {
      return undefined;
    }
  }

  /**
   * Store bytes and return the id that names them.
   *
   * Written to a temporary name and renamed into place, so a crash or a
   * half-received transfer cannot leave a file that looks complete. A blob
   * present under its id is a blob whose hash was verified.
   */
  write(data: Buffer): BlobRef {
    const id = blobId(data);
    mkdirSync(this.#dir, { recursive: true });

    const path = this.#path(id);
    if (existsSync(path)) return { id, size: data.length };

    const body = this.#key ? sealBytes(this.#key, data) : data;
    const temp = `${path}.${randomBytes(6).toString("hex")}.part`;
    writeFileSync(temp, body);
    renameSync(temp, path);

    return { id, size: data.length };
  }

  /**
   * Store bytes that claim to be a particular blob.
   *
   * Returns false if they are not. This is the check that makes requesting a
   * file from an untrusted peer safe: the id came from a signed message, so
   * content that hashes to it is content the author put there.
   */
  accept(id: string, data: Buffer): boolean {
    if (blobId(data) !== id) return false;
    this.write(data);
    return true;
  }

  /** Total bytes held, for reporting. */
  size(): number {
    try {
      return readdirSync(this.#dir)
        .filter((name) => /^[a-f0-9]{64}$/.test(name))
        .reduce((total, name) => total + statSync(join(this.#dir, name)).size, 0);
    } catch {
      return 0;
    }
  }

  /** Forget a blob. The message referring to it stays; only the bytes go. */
  forget(id: string): void {
    try {
      const path = this.#path(id);
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // Already gone, which is the desired state anyway.
    }
  }
}
