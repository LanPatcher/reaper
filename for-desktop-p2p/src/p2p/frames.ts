import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";

/**
 * On-disk frame format for the append-only event log.
 *
 * A frame is a batch of events, compressed then encrypted, with a fixed header
 * that makes the file scannable without an external index.
 *
 *   magic       4 bytes   "STF1", detects corruption and format drift
 *   length      4 bytes   uint32 BE, byte length of `ciphertext`
 *   nonce      12 bytes   per-frame, random
 *   tag        16 bytes   AES-GCM authentication tag
 *   ciphertext N bytes    AES-256-GCM( brotli( payload ) )
 *
 * Three decisions worth explaining, because each has an obvious-looking
 * alternative that's worse:
 *
 * **Batched, not per-event.** Chat messages are tiny — a few hundred bytes —
 * and compressing them individually makes them *bigger*, because Brotli's
 * window and header cost more than the payload. Batching a few hundred events
 * into one frame is what turns compression from a pessimisation into roughly
 * an 8-10x saving, since the dictionary gets to see repeated author ids,
 * channel ids and JSON keys.
 *
 * **Compress before encrypt.** Ciphertext is indistinguishable from random and
 * does not compress at all, so the other order saves nothing. The usual
 * objection to compress-then-encrypt is compression-ratio side channels
 * (CRIME/BREACH), which need an attacker who can inject chosen plaintext into
 * the same frame as a secret and watch the size. That's a live concern for
 * request/response protocols; it isn't one for an append-only local log the
 * attacker would have to already have on disk to measure.
 *
 * **Length-prefixed frames rather than one compressed stream.** Appending to a
 * single Brotli stream means rewriting it. Independent frames append in O(1),
 * and a frame that fails to parse bounds the damage from a torn write to the
 * tail rather than the whole file.
 */

const MAGIC = Buffer.from("STF1", "ascii");

const MAGIC_SIZE = 4;
const LENGTH_SIZE = 4;
const NONCE_SIZE = 12;
const TAG_SIZE = 16;

export const HEADER_SIZE = MAGIC_SIZE + LENGTH_SIZE + NONCE_SIZE + TAG_SIZE;

/**
 * Upper bound on a single frame's ciphertext.
 *
 * Nothing legitimate approaches this; it exists so a corrupt length field
 * can't convince the reader to allocate an arbitrary buffer.
 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/**
 * Brotli quality.
 *
 * 11 (the default) is roughly twenty times slower than 5 for a few percent
 * better ratio on text this size — a bad trade when it runs on every append.
 */
const BROTLI_QUALITY = 5;

export interface DecodedFrame {
  /** Decrypted, decompressed payload */
  payload: Buffer;

  /** Total bytes consumed, i.e. where the next frame starts */
  size: number;
}

/**
 * Encode a payload into a single frame.
 */
export function encodeFrame(payload: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) {
    throw new Error(`frame key must be 32 bytes, got ${key.length}`);
  }

  const compressed = brotliCompressSync(payload, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      // Lets Brotli size its window sensibly instead of assuming the worst.
      [constants.BROTLI_PARAM_SIZE_HINT]: payload.length,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
    },
  });

  const nonce = randomBytes(NONCE_SIZE);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt32BE(ciphertext.length, MAGIC_SIZE);
  nonce.copy(header, MAGIC_SIZE + LENGTH_SIZE);
  tag.copy(header, MAGIC_SIZE + LENGTH_SIZE + NONCE_SIZE);

  return Buffer.concat([header, ciphertext]);
}

/**
 * Decode the frame starting at `offset`.
 *
 * Returns undefined when the buffer doesn't hold a complete, valid frame at
 * that position — which is the expected outcome at the tail of a log that was
 * being written when the process died, not an error worth throwing over. The
 * caller treats it as end-of-log and truncates.
 *
 * A frame whose header parses but whose contents fail authentication *does*
 * throw: that isn't a partial write, it's either the wrong key or real
 * corruption, and silently discarding history is the wrong response to both.
 */
export function decodeFrame(
  buffer: Buffer,
  offset: number,
  key: Buffer,
): DecodedFrame | undefined {
  if (offset + HEADER_SIZE > buffer.length) return undefined;

  if (buffer.compare(MAGIC, 0, MAGIC_SIZE, offset, offset + MAGIC_SIZE) !== 0) {
    return undefined;
  }

  const length = buffer.readUInt32BE(offset + MAGIC_SIZE);
  if (length > MAX_FRAME_BYTES) return undefined;

  const start = offset + HEADER_SIZE;
  const end = start + length;
  if (end > buffer.length) return undefined;

  const nonceAt = offset + MAGIC_SIZE + LENGTH_SIZE;
  const nonce = buffer.subarray(nonceAt, nonceAt + NONCE_SIZE);
  const tag = buffer.subarray(nonceAt + NONCE_SIZE, nonceAt + NONCE_SIZE + TAG_SIZE);
  const ciphertext = buffer.subarray(start, end);

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);

  let compressed: Buffer;
  try {
    compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error(
      `frame at offset ${offset} failed authentication — wrong key, or the log is corrupt`,
    );
  }

  return {
    payload: brotliDecompressSync(compressed),
    size: HEADER_SIZE + length,
  };
}
