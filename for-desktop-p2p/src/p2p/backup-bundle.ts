import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
} from "node:crypto";

import type { SignedEvent } from "./events";
import type { Identity } from "./identity";
import type { OnionKey } from "./tor";

/**
 * The identity backup file: what goes in it, and how it is sealed.
 *
 * Pulled out of `bridge.ts` so it can be run. It used to live inside two IPC
 * handlers, which meant the only way to find out whether a backup actually
 * restores an account was to write one on a desktop, carry it to a phone, and
 * look — and when the answer was "the identity came back and the friends list
 * did not", there was nothing to test against to find out why.
 *
 * There is no server here, so this file is the only thing standing between a
 * lost machine and a lost account. It deserves a test that runs.
 */

/**
 * How the file is wrapped.
 *
 * Scrypt rather than a bare hash: a passphrase is low-entropy and the whole
 * account sits behind this one, so guessing has to be made expensive.
 *
 * `maxmem` is the part that is easy to get wrong, and getting it wrong is how
 * exporting was broken once already. Scrypt needs `128 * N * r` bytes — at
 * N = 32768 and r = 8 that is exactly 33,554,432, which is exactly Node's
 * default ceiling, and Node requires *less* than the ceiling rather than at
 * most. So parameters chosen to be strong landed one byte over the line and
 * every export failed with an OpenSSL memory-limit error.
 *
 * Raising the ceiling rather than weakening the parameters, and stating it
 * explicitly rather than relying on a default that has moved before.
 */
export const IDENTITY_KDF = {
  N: 2 ** 15,
  r: 8,
  p: 1,
  maxmem: 96 * 1024 * 1024,
} as const;

/** What a backup carries. */
export interface Bundle {
  identity: Identity;

  /**
   * This device's own index: friends, servers joined, group chats, profile,
   * preferences and the outbox.
   *
   * The part people actually notice. Community history re-syncs from peers on
   * its own and is left out deliberately — it is the large part by far, and a
   * backup that takes minutes to write is one people stop making. The index
   * cannot re-sync from anywhere, which is exactly why it has to travel.
   */
  index?: SignedEvent[];

  /** The onion service key, so the restored account keeps its address. */
  onion?: OnionKey;

  /** Where the device that wrote this can be reached, for a first sync. */
  syncOnion?: string;

  v?: number;
  at?: number;
}

/**
 * Derive the key, without stopping everything else.
 *
 * The synchronous version blocked the Electron main process for about a
 * second, which is bad and survivable, and blocked a phone's WebView for long
 * enough to look like the app had died. Node runs this on its threadpool; the
 * iOS shim runs it in a worker.
 */
export function deriveIdentityKey(
  passphrase: string,
  salt: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(passphrase, salt, 32, IDENTITY_KDF, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

/** Seal a bundle under a passphrase. Returns the file's contents. */
export async function packBundle(
  bundle: Bundle,
  passphrase: string,
): Promise<string> {
  if (!passphrase || passphrase.length < 8) {
    throw new Error("passphrase must be at least 8 characters");
  }

  const payload = Buffer.from(
    JSON.stringify({ v: 3, at: Date.now(), ...bundle }),
    "utf8",
  );

  const salt = randomBytes(16);
  const key = await deriveIdentityKey(passphrase, salt);
  const nonce = randomBytes(12);

  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(payload), cipher.final()]);

  return JSON.stringify({
    reaper: "identity",
    v: 3,
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: body.toString("base64"),
  });
}

/** Open a bundle. Throws if the passphrase is wrong or the file is damaged. */
export async function unpackBundle(
  file: string,
  passphrase: string,
): Promise<Bundle> {
  const outer = JSON.parse(file) as Record<string, string>;

  // `mayhem` is the marker this file used to carry. Still accepted, because an
  // export is a backup and a backup that stops working on the day the app is
  // renamed is not a backup.
  if (outer.reaper !== "identity" && outer.mayhem !== "identity") {
    throw new Error("not a Reaper identity file");
  }

  const salt = Buffer.from(outer.salt, "base64");
  const key = await deriveIdentityKey(passphrase, salt);

  let plain: Buffer;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm", key, Buffer.from(outer.nonce, "base64"),
    );
    decipher.setAuthTag(Buffer.from(outer.tag, "base64"));
    plain = Buffer.concat([
      decipher.update(Buffer.from(outer.data, "base64")),
      decipher.final(),
    ]);
  } catch {
    // Authentication failing means the wrong passphrase or a damaged file, and
    // there is no way to tell which — saying so is honest.
    throw new Error("wrong passphrase, or the file is damaged");
  }

  const parsed = JSON.parse(plain.toString("utf8")) as Bundle;

  if (!parsed.identity || !parsed.identity.privateKey) {
    throw new Error("that file does not contain an identity");
  }

  return parsed;
}
