import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * End-to-end encryption for event payloads.
 *
 * ## What this protects against
 *
 * Peers relay events for each other, so a message passes through machines
 * belonging to people who may not be in that conversation. Signing proves who
 * wrote something; it does nothing to stop a relay reading it. Tor encrypts
 * each hop, which stops a network observer, and equally does nothing about the
 * peer at the other end.
 *
 * So payloads are encrypted to a key only the participants hold. A relay sees
 * the author, the community and the timestamp — it has to, in order to route
 * and order events — but not the content.
 *
 * ## Keys
 *
 * Two kinds, because two situations:
 *
 *   - **Direct messages** derive a key from X25519 between the two people. No
 *     distribution problem: both sides compute the same secret from keys they
 *     already have, and nobody else can.
 *
 *   - **Communities** use a random key carried in the invite. Whoever has the
 *     invite can read the history; whoever does not, cannot, including peers
 *     that relay it. The invite is the secret.
 *
 * ## What this does not do
 *
 * No forward secrecy, and no revocation. A community key never changes, so
 * someone removed from a server can still read anything they already hold and
 * anything they can still obtain. Fixing that needs key rotation on membership
 * change and a way to re-wrap for remaining members — real work, and worth
 * being explicit about rather than implying more protection than exists.
 *
 * The signing key is deliberately not reused here. Ed25519 is for signatures
 * and X25519 for agreement; the conversion between them is possible but subtle,
 * and a separate keypair costs nothing.
 */

export interface EncryptionKeys {
  /** X25519 public key, base64. Published alongside the signing key. */
  encPublicKey: string;

  /** X25519 private key, base64. Never leaves the main process. */
  encPrivateKey: string;
}

/** Generate an X25519 keypair for key agreement. */
export function createEncryptionKeys(): EncryptionKeys {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");

  return {
    encPublicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    encPrivateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

/**
 * Shared secret between us and a peer.
 *
 * X25519 is symmetric — both sides derive the same 32 bytes from their own
 * private key and the other's public key, with nothing transmitted.
 */
export function agree(myPrivate: string, theirPublic: string): Buffer {
  const priv = createPrivateKey({
    key: Buffer.from(myPrivate, "base64"),
    format: "der",
    type: "pkcs8",
  });

  const pub = createPublicKey({
    key: Buffer.from(theirPublic, "base64"),
    format: "der",
    type: "spki",
  });

  return diffieHellman({ privateKey: priv, publicKey: pub });
}

/**
 * Turn a shared secret into a key for a specific conversation.
 *
 * The raw output of key agreement is never used directly: HKDF binds it to the
 * conversation id, so the same pair of people talking in two places do not
 * reuse one key.
 */
export function deriveKey(secret: Buffer, context: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", secret, Buffer.from(context, "utf8"), Buffer.from("mayhem-e2ee-v1"), 32),
  );
}

/** A fresh random key, for a community. */
export function randomKey(): string {
  return randomBytes(32).toString("base64");
}

export interface Sealed {
  /** Marker, so an encrypted payload is never mistaken for a plain one. */
  e: 1;
  n: string;
  c: string;
  t: string;
}

/**
 * Encrypt a payload.
 *
 * AES-256-GCM: the tag authenticates the ciphertext, so a payload altered in
 * transit fails to open rather than decrypting to rubbish.
 */
export function seal(payload: unknown, key: Buffer): Sealed {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);

  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    e: 1,
    n: nonce.toString("base64"),
    c: ciphertext.toString("base64"),
    t: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Whether a payload is encrypted.
 *
 * Checked structurally rather than by trying to decrypt, so a plaintext
 * payload from an older build still works — the two coexist during a rollout,
 * and refusing to display older messages would be worse than reading them.
 */
export function isSealed(payload: unknown): payload is Sealed {
  const p = payload as Sealed | null;
  return !!p && typeof p === "object" && p.e === 1 &&
    typeof p.n === "string" && typeof p.c === "string" && typeof p.t === "string";
}

/**
 * Decrypt a payload.
 *
 * Returns undefined rather than throwing when the key is wrong. That is the
 * normal case for an event from a community this device has no key for — a
 * relayed message, say — and it must not interrupt loading everything else.
 */
export function open(sealed: Sealed, key: Buffer): unknown {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.n, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.t, "base64"));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.c, "base64")),
      decipher.final(),
    ]);

    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    return undefined;
  }
}
