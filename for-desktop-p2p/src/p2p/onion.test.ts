import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkOnionKey,
  onionAddress,
  onionDir,
  readOnionKey,
  writeOnionKey,
  type OnionKey,
} from "./tor";

/**
 * Moving an address between devices.
 *
 * The bug this exists for: importing an identity restored the signing key and
 * nothing else, so the account came back with its name, its friends list and
 * its servers — and a different onion address. A friend code contains the
 * address. Every code its owner had ever handed out pointed at a device that
 * no longer answered, and the only people who could still reach them were the
 * ones already connected, who relearn the address from a `peer.address` event.
 * Which is exactly backwards: a friend code is for the people you have *not*
 * spoken to yet.
 *
 * So the service key travels with the identity, and these tests cover the two
 * ways that can go wrong. Either the address is computed incorrectly — in
 * which case the device publishes at one address and tells everyone another —
 * or a malformed key is written before it has been checked, in which case the
 * import has already destroyed the old identity by the time tor refuses to
 * start.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

// ---- the address is the key ------------------------------------------------
//
// A v3 onion address is `base32(publicKey ‖ checksum ‖ version)`, so getting
// the encoding wrong produces an address that is well-formed, plausible, and
// nobody's. There is nothing downstream that would catch it: tor publishes
// whatever the key spells, the app reports whatever it computed, and the two
// only disagree at the moment somebody tries to connect.
//
// The bit-packing is the part worth doubting, so it is checked against an
// implementation that works a completely different way — whole-number
// arithmetic over the buffer rather than a shifting accumulator. Two methods
// agreeing on 35 bytes of output is worth far more than one method agreeing
// with itself.

/** RFC 4648 base32 by arithmetic rather than by bit shifting. */
function base32ByArithmetic(bytes: Buffer): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";

  // The whole buffer as one integer, then read five bits at a time from the
  // top. Slow and obviously correct, which is what a cross-check should be.
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  const groups = Math.ceil((bytes.length * 8) / 5);
  value <<= BigInt(groups * 5 - bytes.length * 8);

  let out = "";
  for (let i = groups - 1; i >= 0; i--) {
    out += alphabet[Number((value >> BigInt(i * 5)) & 31n)];
  }

  return out;
}

/** Pull an address apart again, without using anything the encoder used. */
function decodeOnion(address: string): Buffer {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const body = address.replace(/\.onion$/, "");

  let value = 0n;
  for (const character of body) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error(`not base32: ${character}`);
    value = (value << 5n) | BigInt(index);
  }

  // 56 characters is 280 bits carrying 35 bytes; the low five are padding.
  value >>= BigInt(body.length * 5 - 35 * 8);

  const out = Buffer.alloc(35);
  for (let i = 34; i >= 0; i--) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }

  return out;
}

{
  const publicKey = randomBytes(32);
  const address = onionAddress(publicKey);

  ck("an address is 56 characters and .onion",
     /^[a-z2-7]{56}\.onion$/.test(address), address);

  const decoded = decodeOnion(address);

  ck("it carries the public key unchanged",
     decoded.subarray(0, 32).equals(publicKey));

  ck("and says it is version three", decoded[34] === 3, String(decoded[34]));

  const expected = createHash("sha3-256")
    .update(Buffer.concat([
      Buffer.from(".onion checksum", "ascii"),
      publicKey,
      Buffer.from([3]),
    ]))
    .digest()
    .subarray(0, 2);

  ck("with a checksum over the key and the version",
     decoded.subarray(32, 34).equals(expected));

  // The independent encoder, on the exact bytes the address is made of.
  ck("the bit packing agrees with arithmetic done a different way",
     base32ByArithmetic(decoded) === address.replace(".onion", ""));

  // One bit, because a mistake that only shows on unusual input is the kind
  // that ships.
  const nudged = Buffer.from(publicKey);
  nudged[31] ^= 1;
  ck("a one-bit change is a different address", onionAddress(nudged) !== address);

  let refused = false;
  try { onionAddress(randomBytes(31)); } catch { refused = true; }
  ck("a key of the wrong size is refused", refused);
}

// ---- what a valid key looks like -------------------------------------------

function tag(text: string): Buffer {
  const padded = Buffer.alloc(32);
  padded.write(text, "ascii");
  return padded;
}

function makeKey(): { key: OnionKey; publicKey: Buffer } {
  const publicKey = randomBytes(32);

  return {
    publicKey,
    key: {
      secret: Buffer.concat([
        tag("== ed25519v1-secret: type0 =="),
        randomBytes(64),
      ]).toString("base64"),
      public: Buffer.concat([
        tag("== ed25519v1-public: type0 =="),
        publicKey,
      ]).toString("base64"),
      hostname: onionAddress(publicKey),
    },
  };
}

// ---- checking happens before writing ---------------------------------------
//
// This is the ordering that matters. Importing an identity closes every store
// and overwrites the keystore, and none of that can be undone. A service key
// found to be malformed after that point leaves the device with a new
// identity, no address, and no route back to the old one — so everything that
// can be judged from the file alone is judged before anything is touched.

{
  const { key } = makeKey();
  ck("a well-formed key passes", checkOnionKey(key) === key.hostname);

  const refuses = (name: string, mutate: (k: OnionKey) => void) => {
    const broken = { ...makeKey().key };
    mutate(broken);

    let threw = false;
    try { checkOnionKey(broken); } catch { threw = true; }
    ck(name, threw);
  };

  refuses("a secret key of the wrong length is refused", (k) => {
    k.secret = randomBytes(64).toString("base64");
  });

  refuses("a secret key without tor's tag is refused", (k) => {
    k.secret = randomBytes(96).toString("base64");
  });

  refuses("a public key of the wrong length is refused", (k) => {
    k.public = randomBytes(32).toString("base64");
  });

  refuses("a public key without tor's tag is refused", (k) => {
    k.public = randomBytes(64).toString("base64");
  });

  refuses("a missing key is refused", (k) => { k.secret = ""; });

  // The one that would otherwise produce a device publishing at one address
  // while telling everybody another.
  refuses("an address that does not match the key is refused", (k) => {
    k.hostname = onionAddress(randomBytes(32));
  });

  // A bundle written by a build that did not record the hostname is still
  // usable — the key is what decides the address, and the address can be
  // computed from it.
  const noHostname = { ...makeKey().key };
  const derived = onionAddress(Buffer.from(noHostname.public, "base64").subarray(32));
  noHostname.hostname = "";
  ck("a bundle with no address written down still works",
     checkOnionKey(noHostname) === derived);
}

// ---- round trip through a directory ----------------------------------------

{
  const dataDir = mkdtempSync(join(tmpdir(), "reaper-onion-"));
  const { key } = makeKey();

  const written = writeOnionKey(dataDir, key);
  ck("writing reports the address the key spells", written === key.hostname);

  const dir = onionDir(dataDir);
  const files = readdirSync(dir).sort();

  ck("all three files tor expects are there",
     files.join(",") === "hostname,hs_ed25519_public_key,hs_ed25519_secret_key",
     files.join(","));

  ck("the hostname file is what tor would write",
     readFileSync(join(dir, "hostname"), "utf8").trim() === key.hostname);

  // Not a precaution — tor refuses to use a service directory anything else
  // can read, and reports the refusal as a startup failure with no obvious
  // cause. Skipped on Windows, where the mode bits are not meaningful.
  if (process.platform !== "win32") {
    const mode = statSync(join(dir, "hs_ed25519_secret_key")).mode & 0o777;
    ck("the secret key is readable only by its owner", mode === 0o600,
       mode.toString(8));
  }

  const read = readOnionKey(dataDir);
  ck("reading it back gives the same key",
     !!read && read.secret === key.secret && read.public === key.public &&
     read.hostname === key.hostname);

  // The state before tor has ever run. Absent is an answer, not a failure:
  // an export from a device that has not published yet should still write a
  // backup, because the signing key is the irreplaceable part.
  const empty = mkdtempSync(join(tmpdir(), "reaper-onion-empty-"));
  ck("a device with no service reports no key", readOnionKey(empty) === undefined);

  // And a directory holding keys but no hostname — which is what tor leaves
  // between generating the service and publishing it.
  const partial = mkdtempSync(join(tmpdir(), "reaper-onion-partial-"));
  writeOnionKey(partial, key);
  writeFileSync(join(onionDir(partial), "hostname"), "");

  const recovered = readOnionKey(partial);
  ck("an unpublished service still reports its address",
     recovered?.hostname === key.hostname, recovered?.hostname);
}

// ---- the import path, in the order it happens ------------------------------
//
// `bridge.ts` cannot be executed here — it opens Electron — so this reads it.
// Text, and normally that would be worth little; what makes it worth something
// is that the assertion is about *order*, which is the property that cannot be
// checked any other way and is the one that turns a bad file into a lost
// account.

{
  const source = readFileSync(join(process.cwd(), "src/p2p/bridge.ts"), "utf8");
  const handler = source.slice(source.indexOf("CHANNEL.importIdentity"));

  const validated = handler.indexOf("checkOnionKey");
  const destroyed = handler.indexOf("for (const [, store] of stores) store.close()");
  const written = handler.indexOf("writeOnionKey");

  ck("the import validates the service key", validated >= 0);
  ck("before it closes anything", validated >= 0 && validated < destroyed);
  ck("and writes it only after the identity is saved",
     written > handler.indexOf("new ElectronKeystore().save"));

  // The export has to reach for the key at all — the whole failure was an
  // export that quietly did not.
  const exporter = source.slice(
    source.indexOf("CHANNEL.exportIdentity"),
    source.indexOf("CHANNEL.importIdentity"),
  );

  ck("the export carries the service key", exporter.includes("readOnionKey"));
  ck("and a missing one does not stop it",
     exporter.includes("try {") && exporter.includes("catch"));
}


// ---- the file tor is actually given ----------------------------------------
//
// The sync address never appeared, and the reason was not in any code that
// looked like it was about addresses: this ran a *second* tor process for the
// second service. The SOCKS and control ports are fixed constants, so that
// process could never bind, exited at once, and published nothing — leaving a
// screen that said the address was still being generated, for ever, with no
// sign anywhere that anything had died.
//
// One process, two services. This reads the configuration that gets written,
// because the ordering in it is load-bearing and invisible: tor applies each
// `HiddenServicePort` to whichever `HiddenServiceDir` came before it, so a
// file that is merely *correct line by line* can still point both services at
// one port.

{
  const source = readFileSync(join(process.cwd(), "src/p2p/tor.ts"), "utf8");
  const start = source.slice(source.indexOf("async start()"));

  const socks = (start.match(/SocksPort/g) ?? []).length;
  ck("exactly one SOCKS port is asked for", socks === 1, String(socks));

  const control = (start.match(/ControlPort/g) ?? []).length;
  ck("and exactly one control port", control === 1, String(control));

  // Both services, and in pairs.
  const dirs = start.indexOf("HiddenServiceDir ${serviceDir}");
  const port = start.indexOf("HiddenServicePort 80 127.0.0.1:${this.#options.targetPort}");
  const syncDir = start.indexOf("HiddenServiceDir ${syncDir}");
  const syncPort = start.indexOf("HiddenServicePort 80 127.0.0.1:${this.#options.syncPort}");

  ck("both services are configured", dirs >= 0 && syncDir >= 0);

  ck("each directory is followed by its own port",
     dirs < port && port < syncDir && syncDir < syncPort);

  // The thing that broke it. A second `new TorService` for the sync address
  // reads as reasonable and cannot work.
  const bridge = readFileSync(join(process.cwd(), "src/p2p/bridge.ts"), "utf8");
  const instances = (bridge.match(/new TorService\(/g) ?? []).length;

  ck("the bridge starts tor once, not twice", instances === 1, String(instances));

  // And the link server has to be listening before tor is configured, because
  // tor is told the port it forwards to and reads its configuration once.
  const opened = bridge.indexOf("forSync = await openLink");
  const created = bridge.indexOf("new TorService(");

  ck("the device link is listening before tor is configured",
     opened >= 0 && opened < created);
}

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
