import { gcm } from "@noble/ciphers/aes.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf as nobleHkdf } from "@noble/hashes/hkdf.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

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
 * `createHash("sha256")`, with the chaining the call sites use.
 *
 * Only the subset that is actually called: `.update()` once or twice, then
 * `.digest()` with no argument or `"hex"`. Supporting the rest of Node's hash
 * interface would be inventing requirements.
 */
export function createHash(algorithm: string) {
  if (algorithm !== "sha256") throw new Error(`unsupported hash: ${algorithm}`);

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

      const out = Buffer.from(nobleSha256(joined));
      return encoding ? out.toString(encoding) : out;
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

export function randomBytes(size: number): Buffer {
  const out = new Uint8Array(size);
  globalThis.crypto.getRandomValues(out);
  return Buffer.from(out);
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
