import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { app, safeStorage } from "electron";

import type { Identity, Keystore } from "./identity";

/**
 * Private key storage backed by the OS keychain.
 *
 * `safeStorage` hands the encryption to the platform — Keychain on macOS,
 * DPAPI on Windows, libsecret on Linux — so the key at rest is bound to the
 * user's login and not to anything shipped in the app bundle.
 *
 * There is a real caveat on Linux: with no secret service available, Electron
 * falls back to a hardcoded key, which is obfuscation and not encryption.
 * `isEncryptionAvailable()` reports this, and it is surfaced loudly rather than
 * swallowed, because a user who believes their key is protected when it is not
 * is worse off than one who knows it isn't.
 */

function keyPath(): string {
  return join(app.getPath("userData"), "p2p", "identity.key");
}

/**
 * Whether an identity already exists.
 *
 * Used to tell "first run" from "the data directory moved", which look the
 * same to the user and need very different responses.
 */
export function identityExists(): boolean {
  return existsSync(keyPath());
}

export class ElectronKeystore implements Keystore {
  load(): Identity | undefined {
    const path = keyPath();
    if (!existsSync(path)) return undefined;

    const raw = readFileSync(path);

    // An empty file is not a corrupt identity, it is no identity. This is what
    // a half-finished delete or an interrupted first write leaves behind, and
    // treating it as damage meant the app refused to start over something with
    // nothing in it.
    if (raw.length === 0) return undefined;

    const asPlaintext = (): Identity | undefined => {
      try {
        const parsed = JSON.parse(raw.toString("utf8")) as Identity;
        return parsed && parsed.privateKey ? parsed : undefined;
      } catch {
        return undefined;
      }
    };

    // Written in plaintext by an older build, or on a machine with no secret
    // service. Read it so the account survives; `save` re-encrypts.
    if (!safeStorage.isEncryptionAvailable()) {
      return asPlaintext();
    }

    try {
      const parsed = JSON.parse(safeStorage.decryptString(raw)) as Identity;
      if (parsed && parsed.privateKey) return parsed;
    } catch {
      // Fall through: it may simply not be encrypted.
    }

    const plain = asPlaintext();
    if (plain) return plain;

    // Genuinely unreadable — truncated, or encrypted against credentials this
    // machine no longer has.
    //
    // Previously this threw, which surfaced as an uncaught exception dialog
    // and an app that would not start at all. Refusing to run is the wrong
    // response: the file is moved aside so the old bytes are still recoverable
    // by hand, and a fresh identity is created so the app remains usable.
    const aside = `${path}.unreadable-${Date.now()}`;
    try {
      renameSync(path, aside);
      console.warn(
        `[p2p] ${path} could not be read and was moved to ${aside}. ` +
          `A new identity will be created — the previous account cannot be ` +
          `recovered without that file, as there is no server holding a copy.`,
      );
    } catch (error) {
      console.error(`[p2p] ${path} is unreadable and could not be moved aside:`, error);
    }

    return undefined;
  }

  save(identity: Identity): void {
    const path = keyPath();
    mkdirSync(dirname(path), { recursive: true });

    if (safeStorage.isEncryptionAvailable()) {
      writeFileSync(path, safeStorage.encryptString(JSON.stringify(identity)), {
        mode: 0o600,
      });
      return;
    }

    console.warn(
      "[p2p] OS credential storage unavailable — the device key is being " +
        "written with file permissions as its only protection.",
    );

    writeFileSync(path, JSON.stringify(identity), { mode: 0o600 });
  }
}

/**
 * In-memory keystore, for tests and for the first-run flow before a location
 * on disk has been chosen.
 */
export class MemoryKeystore implements Keystore {
  #identity: Identity | undefined;

  load(): Identity | undefined {
    return this.#identity;
  }

  save(identity: Identity): void {
    this.#identity = identity;
  }
}
