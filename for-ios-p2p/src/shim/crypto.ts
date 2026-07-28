import { gcm } from "@noble/ciphers/aes.js";
import { scrypt as nobleScrypt } from "@noble/hashes/scrypt.js";

import ScryptWorker from "./scrypt-worker.ts?worker&inline";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf as nobleHkdf } from "@noble/hashes/hkdf.js";
import { sha256 as nobleSha256, sha512 as nobleSha512 } from "@noble/hashes/sha2.js";
import { sha3_256 as nobleSha3_256 } from "@noble/hashes/sha3.js";

import { Buffer } from "buffer";

/**
 * `node:crypto`, for a WebView.
 *
 * ## Why not WebCrypto
 *
 * `crypto.subtle` is the obvious answer and it is the wrong one, for a reason
 * that has nothing to do with the algorithms: **every method on it is async.**
 *
 * The core this has to serve is synchronous throughout — `eventId()` hashes,
 * `createEvent()` signs, `verifyEvent()` verifies, and all three are ordinary
 * function calls used inside `filter`, inside sort comparators, inside a loop
 * that replays ten thousand events. Making them async would mean rewriting the
 * event model, the store, the transport and the reconciliation loop on both
 * platforms, and the desktop build would pay for a constraint that only exists
 * on this one.
 *
 * The audited pure-JS implementations are synchronous, and fast enough: on an
 * A15, verifying a signed event costs about 0.3 ms, so a cold replay of ten
 * thousand of them is roughly three seconds of work that happens once behind a
 * loading state. WebCrypto would be quicker per call and would cost a rewrite
 * of everything above it.
 *
 * ## Wire compatibility
 *
 * This is the part that has to be exactly right, because getting it subtly
 * wrong produces an app that works perfectly on its own and cannot talk to a
 * single desktop peer.
 *
 * Node hands out keys as DER — SPKI for public, PKCS#8 for private — and those
 * base64 strings are what a published identity contains and what every peer
 * verifies against. The libraries here work in raw 32-byte keys. So the two
 * are translated at the boundary rather than storing something different and
 * hoping nobody notices: an identity created on a phone is byte-identical to
 * one created on a desktop, and either can verify the other's events.
 *
 * For Ed25519 and X25519 that translation is not really parsing. Both key
 * types are fixed-length with a constant prefix, so it is a prefix check and a
 * 32-byte slice — see `RAW_KEY_SIZE` below.
 */

// ---- DER --------------------------------------------------------------------
//
// The full encodings, since they never vary for these two curves:
//
//   Ed25519 SPKI   302a300506032b6570032100 || 32 bytes   (44 total)
//   Ed25519 PKCS8  302e020100300506032b657004220420 || 32 (48 total)
//   X25519  SPKI   302a300506032b656e032100 || 32 bytes   (44 total)
//   X25519  PKCS8  302e020100300506032b656e04220420 || 32 (48 total)
//
// The only difference between the pairs is the algorithm OID — 2b6570 for
// Ed25519, 2b656e for X25519 — which is why these are written as tables rather
// than as a general-purpose ASN.1 parser. A parser would be more code, more
// attack surface, and would accept encodings Node never produces.

const RAW_KEY_SIZE = 32;

const PREFIX = {
  ed25519: {
    spki: hex("302a300506032b6570032100"),
    pkcs8: hex("302e020100300506032b657004220420"),
  },
  x25519: {
    spki: hex("302a300506032b656e032100"),
    pkcs8: hex("302e020100300506032b656e04220420"),
  },
} as const;

type Curve = keyof typeof PREFIX;
type Shape = "spki" | "pkcs8";

function hex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Wrap a raw 32-byte key in the DER Node would have produced. */
function toDer(raw: Uint8Array, curve: Curve, shape: Shape): string {
  const prefix = PREFIX[curve][shape];
  const out = new Uint8Array(prefix.length + RAW_KEY_SIZE);
  out.set(prefix, 0);
  out.set(raw, prefix.length);
  return Buffer.from(out).toString("base64");
}

/**
 * Pull the raw 32 bytes back out.
 *
 * Strict about the prefix. A key that does not match is not "probably fine" —
 * it is either a different algorithm or something a peer made up, and both
 * should fail here rather than three layers further in.
 */
function fromDer(base64: string, curve: Curve, shape: Shape): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  const prefix = PREFIX[curve][shape];

  if (bytes.length !== prefix.length + RAW_KEY_SIZE) {
    throw new Error(`bad ${curve} ${shape}: ${bytes.length} bytes`);
  }

  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) throw new Error(`bad ${curve} ${shape} header`);
  }

  return bytes.subarray(prefix.length);
}

// ---- what the core actually imports -----------------------------------------

/** A `KeyObject` stand-in. Only ever produced and consumed by this module. */
export interface KeyLike {
  curve: Curve;
  shape: Shape;
  raw: Uint8Array;
}

export interface KeyPair {
  publicKey: { export(options: { type: string; format: string }): Buffer };
  privateKey: { export(options: { type: string; format: string }): Buffer };
}

/**
 * Note the shape of the return value: `.export({ type, format })` returning a
 * Buffer, exactly as Node's `KeyObject` does. The call sites are shared with
 * the desktop build and are not adapted for this one.
 */
export function generateKeyPairSync(type: "ed25519" | "x25519"): KeyPair {
  const curve = type === "ed25519" ? ed25519 : x25519;
  const secret = curve.utils.randomSecretKey();
  const publicRaw = curve.getPublicKey(secret);

  return {
    publicKey: {
      export: () => Buffer.from(toDer(publicRaw, type, "spki"), "base64"),
    },
    privateKey: {
      export: () => Buffer.from(toDer(secret, type, "pkcs8"), "base64"),
    },
  };
}

export function createPrivateKey(options: {
  key: Buffer | Uint8Array;
  format?: string;
  type?: string;
}): KeyLike {
  const base64 = Buffer.from(options.key).toString("base64");

  // Which curve it is has to be worked out from the bytes: the call sites say
  // "pkcs8" and nothing more, because with Node the OID inside is what decides
  // and the caller never had to care.
  for (const curve of ["ed25519", "x25519"] as Curve[]) {
    try {
      return { curve, shape: "pkcs8", raw: fromDer(base64, curve, "pkcs8") };
    } catch {
      // Next curve.
    }
  }

  throw new Error("unrecognised private key");
}

export function createPublicKey(options: {
  key: Buffer | Uint8Array;
  format?: string;
  type?: string;
}): KeyLike {
  const base64 = Buffer.from(options.key).toString("base64");

  for (const curve of ["ed25519", "x25519"] as Curve[]) {
    try {
      return { curve, shape: "spki", raw: fromDer(base64, curve, "spki") };
    } catch {
      // Next curve.
    }
  }

  throw new Error("unrecognised public key");
}

/**
 * Sign a message.
 *
 * The first argument is the digest algorithm, and for Ed25519 it must be null —
 * the scheme hashes internally, so naming one is an error rather than a choice.
 * It is accepted and ignored here for the same reason Node accepts it.
 */
export function sign(
  _algorithm: null,
  message: Buffer | Uint8Array,
  key: KeyLike,
): Buffer {
  if (key.curve !== "ed25519") throw new Error("cannot sign with an X25519 key");
  return Buffer.from(ed25519.sign(new Uint8Array(message), key.raw));
}

/**
 * Check a signature.
 *
 * Never throws, matching the desktop behaviour and for the same reason: a
 * malformed signature arriving from a peer is an expected condition — it is
 * precisely what an attacker would send — and it has to read as "invalid"
 * rather than as an exception in the sync loop.
 */
export function verify(
  _algorithm: null,
  message: Buffer | Uint8Array,
  key: KeyLike,
  signature: Buffer | Uint8Array,
): boolean {
  try {
    if (key.curve !== "ed25519") return false;
    return ed25519.verify(
      new Uint8Array(signature),
      new Uint8Array(message),
      key.raw,
    );
  } catch {
    return false;
  }
}

export function diffieHellman(options: {
  privateKey: KeyLike;
  publicKey: KeyLike;
}): Buffer {
  return Buffer.from(
    x25519.getSharedSecret(options.privateKey.raw, options.publicKey.raw),
  );
}

// ---- hashing ----------------------------------------------------------------

/**
 * `createHash(...)`, with the chaining the call sites use.
 *
 * Only the subset that is actually called: `.update()` a few times, then
 * `.digest()` with no argument or `"hex"`. Supporting the rest of Node's hash
 * interface would be inventing requirements.
 *
 * Three algorithms, and each is here because something broke without it:
 *
 *   - **sha256** — event ids, blob names, the link handshake.
 *   - **sha512** — the device link's session key, derived from the identity's
 *     private key. Without it, linking two devices threw on the phone at the
 *     moment the handshake succeeded.
 *   - **sha3-256** — the checksum inside a v3 onion address. `onionAddress`
 *     uses it to check that a restored service key and the address written
 *     beside it agree, which runs during an identity import — so an
 *     unsupported hash here took out the one operation the whole backup exists
 *     for.
 *
 * The list is closed on purpose. An unknown algorithm throws rather than
 * falling back to sha256, because a hash that silently computes the wrong
 * thing produces ids and addresses that are wrong everywhere and reported
 * nowhere.
 */
const HASHES: Record<string, (input: Uint8Array) => Uint8Array> = {
  sha256: nobleSha256,
  sha512: nobleSha512,
  "sha3-256": nobleSha3_256,
};

export function createHash(algorithm: string) {
  const hash = HASHES[algorithm];
  if (!hash) throw new Error(`unsupported hash: ${algorithm}`);

  const parts: Uint8Array[] = [];

  const api = {
    update(data: Buffer | Uint8Array | string, encoding?: BufferEncoding) {
      parts.push(
        typeof data === "string"
          ? new Uint8Array(Buffer.from(data, encoding ?? "utf8"))
          : new Uint8Array(data),
      );
      return api;
    },

    digest(encoding?: "hex" | "base64") {
      let total = 0;
      for (const part of parts) total += part.length;

      const joined = new Uint8Array(total);
      let at = 0;
      for (const part of parts) {
        joined.set(part, at);
        at += part.length;
      }

      const out = Buffer.from(hash(joined));
      return encoding ? out.toString(encoding) : out;
    },
  };

  return api;
}

/**
 * HMAC, built on the hashes above.
 *
 * Node has this natively and iOS does not, and CryptoKit's version is not
 * reachable from here without another native plugin — so it is the textbook
 * construction, which is short enough that adding a plugin for it would be the
 * larger risk:
 *
 *     HMAC(K, m) = H((K' ^ opad) || H((K' ^ ipad) || m))
 *
 * `K'` is the key padded to the hash's block size, or the hash of the key when
 * the key is longer than that. The block size is 64 bytes for every algorithm
 * this supports; SHA-512 would need 128, so it is asserted rather than assumed
 * — a silently wrong block size still produces plausible-looking output, and
 * the failure would appear as a pairing that refuses a correct password.
 */
export function createHmac(algorithm: string, key: Buffer | Uint8Array | string) {
  if (!HASHES[algorithm]) throw new Error(`unsupported hash: ${algorithm}`);

  const BLOCK = 64;

  if (algorithm === "sha512" || algorithm === "sha384") {
    throw new Error(`hmac: ${algorithm} needs a 128-byte block, which this does not implement`);
  }

  let secret = typeof key === "string"
    ? new Uint8Array(Buffer.from(key, "utf8"))
    : new Uint8Array(key);

  // A key longer than the block is replaced by its own digest, which is what
  // makes the construction accept a key of any length.
  if (secret.length > BLOCK) {
    secret = new Uint8Array(createHash(algorithm).update(Buffer.from(secret)).digest() as Buffer);
  }

  const padded = new Uint8Array(BLOCK);
  padded.set(secret);

  const inner = new Uint8Array(BLOCK);
  const outer = new Uint8Array(BLOCK);

  for (let at = 0; at < BLOCK; at++) {
    inner[at] = padded[at] ^ 0x36;
    outer[at] = padded[at] ^ 0x5c;
  }

  const run = createHash(algorithm).update(Buffer.from(inner));

  const api = {
    update(data: Buffer | Uint8Array | string, encoding?: BufferEncoding) {
      run.update(
        typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : Buffer.from(data),
      );
      return api;
    },

    digest(encoding?: "hex" | "base64") {
      const once = createHash(algorithm)
        .update(Buffer.from(outer))
        .update(run.digest() as Buffer)
        .digest() as Buffer;

      return encoding ? once.toString(encoding) : once;
    },
  };

  return api;
}

export function hkdfSync(
  digest: string,
  ikm: Buffer | Uint8Array,
  salt: Buffer | Uint8Array,
  info: Buffer | Uint8Array,
  length: number,
): ArrayBuffer {
  if (digest !== "sha256") throw new Error(`unsupported digest: ${digest}`);

  const out = nobleHkdf(
    nobleSha256,
    new Uint8Array(ikm),
    new Uint8Array(salt),
    new Uint8Array(info),
    length,
  );

  // Node returns an ArrayBuffer here, not a Buffer, and the caller wraps it.
  // Returning the wrong one produces a key that is right and a `Buffer.from`
  // that silently produces something else.
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

/**
 * Scrypt, for wrapping an exported identity.
 *
 * Deliberately expensive — the whole account sits behind one passphrase — and
 * the parameters come from the caller, which uses the same ones as the desktop.
 * `maxmem` is accepted and ignored: it is a Node-specific guard against
 * allocating too much, and this implementation allocates what it needs.
 *
 * A backup written on a phone has to open on a desktop and the reverse, so the
 * output has to match byte for byte. It does — scrypt is fully specified, and
 * `crypto.test.ts` checks this pair against Node's rather than assuming.
 */
export function scryptSync(
  passphrase: string | Buffer | Uint8Array,
  salt: string | Buffer | Uint8Array,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
): Buffer {
  const bytes = (value: string | Buffer | Uint8Array) =>
    typeof value === "string"
      ? new Uint8Array(Buffer.from(value, "utf8"))
      : new Uint8Array(value);

  return Buffer.from(
    nobleScrypt(bytes(passphrase), bytes(salt), {
      N: options?.N ?? 16384,
      r: options?.r ?? 8,
      p: options?.p ?? 1,
      dkLen: keylen,
    }),
  );
}

/**
 * `scrypt`, off the thread that draws.
 *
 * The synchronous version above is thirty-two megabytes of allocation and tens
 * of thousands of block-mixing rounds in pure JavaScript. In a WebView that
 * runs where the interface runs, so for its whole duration the app paints
 * nothing and answers nothing — which is what importing an identity looked
 * like from the outside, and what iOS eventually acts on.
 *
 * `scryptAsync` looks like the answer and is not. It yields with an empty
 * `await`, which drains microtasks and returns to the *same task*: timers do
 * not fire, frames are not drawn, and the thread is held exactly as firmly.
 * `crypto.test.ts` measures it — a four-millisecond interval fires zero times
 * across the entire derivation. That is worth writing down, because it is a
 * fix that would have passed review and changed nothing.
 *
 * So the work goes to a worker, where it cannot hold anything up. The
 * signature is Node's, callback and all, so `bridge.ts` is written against the
 * real API and runs unchanged on both platforms.
 */
export function scrypt(
  passphrase: string | Buffer | Uint8Array,
  salt: string | Buffer | Uint8Array,
  keylen: number,
  options: { N?: number; r?: number; p?: number; maxmem?: number } | ((error: Error | null, key: Buffer) => void),
  callback?: (error: Error | null, key: Buffer) => void,
): void {
  const settings = typeof options === "function" ? {} : options;
  const done = typeof options === "function" ? options : callback!;

  const bytes = (value: string | Buffer | Uint8Array) =>
    typeof value === "string"
      ? new Uint8Array(Buffer.from(value, "utf8"))
      : new Uint8Array(value);

  const N = settings.N ?? 16384;
  const r = settings.r ?? 8;
  const p = settings.p ?? 1;

  const work = {
    id: 1,
    passphrase: bytes(passphrase),
    salt: bytes(salt),
    keylen,
    N, r, p,
  };

  // Derived here if there is no worker to be had.
  //
  // Node has no `Worker`, which is where the tests run and where blocking a
  // thread costs nothing. On a device this is also the last resort if the
  // worker cannot start — slow and alive beats fast and "the key could not be
  // derived", which is what an error path produced the first time this was
  // tried.
  const here = () => {
    queueMicrotask(() => {
      try {
        done(null, scryptSync(passphrase, salt, keylen, settings));
      } catch (error) {
        done(error as Error, Buffer.alloc(0));
      }
    });
  };

  let worker: Worker | undefined;

  try {
    // Inlined by the bundler as a blob rather than emitted as a second file.
    //
    // The first attempt at this loaded the worker from its own URL, and it
    // failed on device with "the key could not be derived" — for exactly the
    // reason written above `inlineDynamicImports` in `vite.config.ts`: this
    // app is served from a custom scheme, and a second file fetched across it
    // does not arrive. A blob has no URL to get wrong.
    worker = new ScryptWorker();
  } catch {
    here();
    return;
  }

  let settled = false;

  const finish = (error: Error | null, key: Buffer) => {
    if (settled) return;
    settled = true;
    worker?.terminate();
    done(error, key);
  };

  worker.onmessage = (event: MessageEvent<{ key?: Uint8Array; error?: string }>) => {
    if (event.data.error) {
      // The worker started and the arithmetic failed, which is not a
      // scheme problem and will not be fixed by trying again here.
      finish(new Error(event.data.error), Buffer.alloc(0));
      return;
    }

    finish(null, Buffer.from(event.data.key!));
  };

  worker.onerror = () => {
    // The worker could not run at all. Falling back rather than failing: a
    // second or two of a frozen interface is worth an account that opens.
    if (settled) return;
    settled = true;
    worker?.terminate();
    here();
  };

  worker.postMessage(work);
}

export function randomBytes(size: number): Buffer {
  const out = new Uint8Array(size);
  globalThis.crypto.getRandomValues(out);
  return Buffer.from(out);
}

/**
 * Compare two buffers without leaking where they first differ.
 *
 * Node throws when the lengths differ rather than returning false, and callers
 * are written expecting that — so this does too. Getting it wrong in the other
 * direction would be worse than useless: a caller that relies on the throw to
 * catch a malformed input would silently accept one.
 *
 * The loop has no early exit on purpose. That is the entire point of the
 * function, and a compiler that short-circuits it would defeat it — which is
 * why the result is accumulated rather than branched on.
 */
export function timingSafeEqual(
  a: Buffer | Uint8Array,
  b: Buffer | Uint8Array,
): boolean {
  if (a.length !== b.length) {
    throw new RangeError("input buffers must have the same byte length");
  }

  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];

  return difference === 0;
}

// ---- AES-256-GCM ------------------------------------------------------------
//
// Node splits the tag out: `cipher.final()` then `cipher.getAuthTag()`, and on
// the way back in `decipher.setAuthTag()` before `final()`. The library here
// appends the tag to the ciphertext, which is what everything except Node
// does. So these adapt between the two — and that seam is exactly where a
// mistake would produce data this app can write and never read again, which is
// why the round trip is asserted in `crypto.test.ts` rather than assumed.

const TAG_SIZE = 16;

export function createCipheriv(
  algorithm: string,
  key: Buffer | Uint8Array,
  nonce: Buffer | Uint8Array,
) {
  if (algorithm !== "aes-256-gcm") throw new Error(`unsupported: ${algorithm}`);

  const parts: Uint8Array[] = [];
  let sealed: Uint8Array | undefined;

  return {
    update(data: Buffer | Uint8Array) {
      parts.push(new Uint8Array(data));
      // Everything is held until `final()`: GCM is not a streaming cipher here
      // and the call sites concatenate the two results anyway.
      return Buffer.alloc(0);
    },

    final() {
      sealed = gcm(new Uint8Array(key), new Uint8Array(nonce)).encrypt(join(parts));
      return Buffer.from(sealed.subarray(0, sealed.length - TAG_SIZE));
    },

    getAuthTag() {
      if (!sealed) throw new Error("getAuthTag before final");
      return Buffer.from(sealed.subarray(sealed.length - TAG_SIZE));
    },
  };
}

export function createDecipheriv(
  algorithm: string,
  key: Buffer | Uint8Array,
  nonce: Buffer | Uint8Array,
) {
  if (algorithm !== "aes-256-gcm") throw new Error(`unsupported: ${algorithm}`);

  const parts: Uint8Array[] = [];
  let tag: Uint8Array | undefined;

  return {
    setAuthTag(value: Buffer | Uint8Array) {
      tag = new Uint8Array(value);
    },

    update(data: Buffer | Uint8Array) {
      parts.push(new Uint8Array(data));
      return Buffer.alloc(0);
    },

    final() {
      if (!tag) throw new Error("setAuthTag before final");

      const body = join(parts);
      const withTag = new Uint8Array(body.length + tag.length);
      withTag.set(body, 0);
      withTag.set(tag, body.length);

      // Throws on a bad tag, which is the point of using GCM and is what the
      // callers already expect from Node.
      return Buffer.from(
        gcm(new Uint8Array(key), new Uint8Array(nonce)).decrypt(withTag),
      );
    },
  };
}

function join(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];

  let total = 0;
  for (const part of parts) total += part.length;

  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
