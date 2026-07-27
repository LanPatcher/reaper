import { createEncryptionKeys } from "./crypto";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

/**
 * Device identity.
 *
 * An Ed25519 keypair. The public key *is* the account — there is no server to
 * register with and nothing to reset against, which has a consequence worth
 * stating plainly rather than discovering later: losing the private key loses
 * the account permanently. Key backup is a feature this design owes the user,
 * not a nicety.
 *
 * Ed25519 rather than RSA or P-256 because signatures are 64 bytes and
 * verification is fast. Every event carries one, and peers verify every event
 * they receive during a sync, so this is on the hot path.
 */

/** Length of a user id in characters. */
const USER_ID_LENGTH = 26;

/**
 * Crockford base32, minus I/L/O/U.
 *
 * Matches the alphabet Revolt's ULIDs already use, so ids coming out of this
 * module are the same shape the client's existing code expects — 26 characters,
 * no ambiguous glyphs, safe in a URL.
 */
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface Identity {
  /** Stable user id derived from the public key */
  userId: string;

  /** Ed25519 public key, base64, safe to publish */
  publicKey: string;

  /** Ed25519 private key, base64. Never leaves this process unencrypted. */
  privateKey: string;

  /**
   * X25519 public key for key agreement, base64.
   *
   * Separate from the signing key on purpose: Ed25519 signs, X25519 agrees,
   * and converting between them is possible but subtle enough not to be worth
   * it for the few bytes saved.
   *
   * Optional so identities written before encryption existed still load; they
   * are upgraded in place on first use.
   */
  encPublicKey?: string;

  /** X25519 private key, base64. */
  encPrivateKey?: string;
}

/**
 * Derive a user id from a public key.
 *
 * A truncated hash rather than the key itself, so ids stay short enough to
 * display. 130 bits of the digest survives truncation, which is far past the
 * point where collisions matter for a network of this size — and a collision
 * would only confuse display anyway, since signatures verify against the full
 * key.
 */
export function userIdFromPublicKey(publicKey: string): string {
  const digest = createHash("sha256").update(publicKey, "base64").digest();

  let id = "";
  for (let i = 0; i < USER_ID_LENGTH; i++) {
    id += BASE32[digest[i] % BASE32.length];
  }

  return id;
}

/**
 * Generate a fresh device identity.
 */
export function createIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  const publicRaw = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const privateRaw = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

  return {
    userId: userIdFromPublicKey(publicRaw),
    publicKey: publicRaw,
    privateKey: privateRaw,
    ...createEncryptionKeys(),
  };
}

/**
 * Add encryption keys to an identity that predates them.
 *
 * The user id is derived from the *signing* key, so this leaves the account
 * intact — an existing identity gains the ability to encrypt without becoming
 * a different person.
 */
export function ensureEncryptionKeys(identity: Identity): Identity {
  if (identity.encPublicKey && identity.encPrivateKey) return identity;
  return { ...identity, ...createEncryptionKeys() };
}

/**
 * Sign a digest with an identity's private key.
 */
export function signDigest(digest: Buffer, identity: Identity): string {
  const key = createPrivateKey({
    key: Buffer.from(identity.privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });

  // Ed25519 signs the message directly — passing a digest algorithm here is
  // an error rather than an optimisation, because the scheme does its own
  // hashing internally.
  return sign(null, digest, key).toString("base64");
}

/**
 * Verify a signature against a public key.
 *
 * Never throws. A malformed key or signature arriving from a peer is an
 * expected condition — that is exactly what an attacker would send — and it
 * must read as "invalid", not as a crash in the sync loop.
 */
export function verifyDigest(
  digest: Buffer,
  signature: string,
  publicKey: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki",
    });

    return verify(null, digest, key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/**
 * Somewhere to keep a private key at rest.
 *
 * An interface rather than a direct call to Electron's `safeStorage` so the
 * event and sync layers can be exercised in a plain Node test process, where
 * no such thing exists. The Electron implementation lives in `keystore.ts`.
 */
export interface Keystore {
  load(): Identity | undefined;
  save(identity: Identity): void;
}

/**
 * Load the device identity, creating one on first run.
 */
export function loadOrCreateIdentity(keystore: Keystore): Identity {
  const existing = keystore.load();

  if (existing) {
    const upgraded = ensureEncryptionKeys(existing);
    if (upgraded !== existing) keystore.save(upgraded);
    return upgraded;
  }

  const identity = createIdentity();
  keystore.save(identity);
  return identity;
}
