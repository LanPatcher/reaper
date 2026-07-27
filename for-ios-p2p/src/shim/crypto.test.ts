import * as node from "node:crypto";

import { Buffer } from "buffer";

import * as shim from "./crypto";

/**
 * The shim against the thing it replaces.
 *
 * This is the most important test in the port, and the reason is worth stating
 * plainly: every bug this catches produces an app that works perfectly on its
 * own and cannot exchange a single message with a desktop peer. A signature
 * scheme that verifies its own output is not evidence of anything — two
 * incompatible implementations both pass that test.
 *
 * So nothing here checks the shim against itself. Every case crosses the two:
 * Node signs and the shim verifies, the shim seals and Node opens, Node writes
 * a key and the shim reads it back. A difference of one byte anywhere shows up
 * as a failure rather than as an empty conversation months later.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

// ---- key encodings ---------------------------------------------------------
//
// A published identity *is* these base64 strings. If the shim writes a
// different encoding then an account made on a phone is a different account
// everywhere else, and the user id — which is a hash of the public key —
// changes with it.
{
  for (const type of ["ed25519", "x25519"] as const) {
    const fromNode = node.generateKeyPairSync(type);
    const nodePub = fromNode.publicKey.export({ type: "spki", format: "der" });
    const nodePriv = fromNode.privateKey.export({ type: "pkcs8", format: "der" });

    const fromShim = shim.generateKeyPairSync(type);
    const shimPub = fromShim.publicKey.export({ type: "spki", format: "der" });
    const shimPriv = fromShim.privateKey.export({ type: "pkcs8", format: "der" });

    ck(`${type}: public keys are the same length`,
       shimPub.length === nodePub.length, `${shimPub.length} vs ${nodePub.length}`);
    ck(`${type}: and the same DER header`,
       shimPub.subarray(0, 12).equals(Buffer.from(nodePub).subarray(0, 12)),
       shimPub.subarray(0, 12).toString("hex"));

    ck(`${type}: private keys match too`,
       shimPriv.length === nodePriv.length &&
       shimPriv.subarray(0, 16).equals(Buffer.from(nodePriv).subarray(0, 16)));

    // And Node can read what the shim wrote, which is the actual requirement.
    let readable = true;
    try {
      node.createPublicKey({ key: shimPub, format: "der", type: "spki" });
      node.createPrivateKey({ key: shimPriv, format: "der", type: "pkcs8" });
    } catch (error) {
      readable = false;
      ck(`${type}: node reads shim keys`, false, (error as Error).message);
    }
    if (readable) ck(`${type}: node reads shim keys`, true);
  }

  // A key of the wrong curve must be refused rather than silently reinterpreted.
  const ed = node.generateKeyPairSync("ed25519").publicKey
    .export({ type: "spki", format: "der" });
  const parsed = shim.createPublicKey({ key: ed });
  ck("a key knows which curve it is", parsed.curve === "ed25519", parsed.curve);

  let refused = false;
  try {
    shim.createPublicKey({ key: Buffer.from("not a key at all") });
  } catch {
    refused = true;
  }
  ck("rubbish is refused", refused);
}

// ---- signatures, both directions -------------------------------------------
{
  const message = Buffer.from("the quick brown fox jumps over the lazy dog");

  // Node signs, shim verifies. This is a phone checking a desktop's events.
  {
    const { publicKey, privateKey } = node.generateKeyPairSync("ed25519");
    const signature = node.sign(null, message, privateKey);

    const key = shim.createPublicKey({
      key: publicKey.export({ type: "spki", format: "der" }),
    });

    ck("shim verifies a node signature", shim.verify(null, message, key, signature));
    ck("and rejects a tampered message",
       !shim.verify(null, Buffer.from("something else"), key, signature));

    const bent = Buffer.from(signature);
    bent[0] ^= 0xff;
    ck("and a tampered signature", !shim.verify(null, message, key, bent));
  }

  // Shim signs, node verifies. A desktop checking a phone's events.
  {
    const pair = shim.generateKeyPairSync("ed25519");
    const priv = shim.createPrivateKey({
      key: pair.privateKey.export({ type: "pkcs8", format: "der" }),
    });

    const signature = shim.sign(null, message, priv);
    const pub = node.createPublicKey({
      key: pair.publicKey.export({ type: "spki", format: "der" }),
      format: "der",
      type: "spki",
    });

    ck("node verifies a shim signature", node.verify(null, message, pub, signature));
    ck("the signature is the right size", signature.length === 64,
       String(signature.length));
  }

  // Ed25519 is deterministic, so the same key over the same message must give
  // byte-identical signatures on both. Anything else means one of them is
  // doing something non-standard.
  {
    const { publicKey, privateKey } = node.generateKeyPairSync("ed25519");
    const der = privateKey.export({ type: "pkcs8", format: "der" });

    const fromNode = node.sign(null, message, privateKey);
    const fromShim = shim.sign(null, message, shim.createPrivateKey({ key: der }));

    ck("both produce identical signatures", fromNode.equals(fromShim),
       `${fromNode.toString("hex").slice(0, 24)} vs ${fromShim.toString("hex").slice(0, 24)}`);
    void publicKey;
  }

  // Never throws, whatever arrives.
  {
    const pair = shim.generateKeyPairSync("ed25519");
    const pub = shim.createPublicKey({
      key: pair.publicKey.export({ type: "spki", format: "der" }),
    });

    let threw = false;
    try {
      shim.verify(null, message, pub, Buffer.from([1, 2, 3]));
      shim.verify(null, message, pub, Buffer.alloc(0));
    } catch {
      threw = true;
    }
    ck("a malformed signature is false, not an exception", !threw);
  }
}

// ---- key agreement ---------------------------------------------------------
//
// Both sides of a direct conversation derive the same key from keys they
// already hold. One of them being a phone must not change the answer.
{
  const phone = shim.generateKeyPairSync("x25519");
  const desktop = node.generateKeyPairSync("x25519");

  const phonePubDer = phone.publicKey.export({ type: "spki", format: "der" });
  const phonePrivDer = phone.privateKey.export({ type: "pkcs8", format: "der" });
  const desktopPubDer = desktop.publicKey.export({ type: "spki", format: "der" });

  const onPhone = shim.diffieHellman({
    privateKey: shim.createPrivateKey({ key: phonePrivDer }),
    publicKey: shim.createPublicKey({ key: desktopPubDer }),
  });

  const onDesktop = node.diffieHellman({
    privateKey: desktop.privateKey,
    publicKey: node.createPublicKey({
      key: phonePubDer,
      format: "der",
      type: "spki",
    }),
  });

  ck("both sides agree on the same secret", onPhone.equals(onDesktop),
     `${onPhone.toString("hex").slice(0, 16)} vs ${onDesktop.toString("hex").slice(0, 16)}`);
  ck("and it is 32 bytes", onPhone.length === 32, String(onPhone.length));
}

// ---- hashing ---------------------------------------------------------------
//
// Event ids are SHA-256 of the canonical form, so a disagreement here means
// two devices give the same event two different ids and neither ever believes
// it has the other's.
{
  const cases = ["", "a", "hello world", JSON.stringify({ a: 1, b: [2, 3] })];

  for (const text of cases) {
    const fromNode = node.createHash("sha256").update(text, "utf8").digest("hex");
    const fromShim = shim.createHash("sha256").update(text, "utf8").digest("hex");
    ck(`sha256 of ${JSON.stringify(text.slice(0, 20))}`, fromNode === fromShim,
       `${fromShim.slice(0, 16)} vs ${fromNode.slice(0, 16)}`);
  }

  // Chained updates, which `blobId` and `eventId` both rely on.
  const chainedNode = node.createHash("sha256")
    .update(Buffer.from("one")).update(Buffer.from("two")).digest("hex");
  const chainedShim = shim.createHash("sha256")
    .update(Buffer.from("one")).update(Buffer.from("two")).digest("hex");
  ck("chained updates agree", chainedNode === chainedShim);

  // And a digest with no encoding is a Buffer, because that is what gets signed.
  const raw = shim.createHash("sha256").update("x").digest();
  ck("an unencoded digest is 32 raw bytes",
     Buffer.isBuffer(raw) && raw.length === 32);

  // Binary input, not just text: attachment hashes are content addresses.
  const bytes = node.randomBytes(4096);
  ck("binary input agrees",
     node.createHash("sha256").update(bytes).digest("hex") ===
     shim.createHash("sha256").update(bytes).digest("hex"));
}

// ---- HKDF ------------------------------------------------------------------
{
  const secret = node.randomBytes(32);
  const salt = Buffer.from("dm123", "utf8");
  const info = Buffer.from("mayhem-e2ee-v1");

  const fromNode = Buffer.from(node.hkdfSync("sha256", secret, salt, info, 32));
  const fromShim = Buffer.from(shim.hkdfSync("sha256", secret, salt, info, 32));

  ck("derived keys are identical", fromNode.equals(fromShim),
     `${fromShim.toString("hex").slice(0, 16)} vs ${fromNode.toString("hex").slice(0, 16)}`);

  // The argument order is salt-then-info and it is easy to transpose. If they
  // were swapped the two would still agree with each other, so this checks the
  // shim notices the difference at all.
  const swapped = Buffer.from(shim.hkdfSync("sha256", secret, info, salt, 32));
  ck("salt and info are not interchangeable", !swapped.equals(fromShim));
}

// ---- AES-256-GCM -----------------------------------------------------------
//
// The seam where the two libraries genuinely disagree: Node keeps the tag
// separate, everything else appends it. Getting this wrong writes data that
// can never be read back.
{
  const key = node.randomBytes(32);
  const nonce = node.randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify({ content: "hello", n: 1 }), "utf8");

  // Node seals, shim opens.
  {
    const cipher = node.createCipheriv("aes-256-gcm", key, nonce);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const decipher = shim.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    decipher.update(body);

    ck("shim opens what node sealed", decipher.final().equals(plaintext));
  }

  // Shim seals, node opens.
  {
    const cipher = shim.createCipheriv("aes-256-gcm", key, nonce);
    cipher.update(plaintext);
    const body = cipher.final();
    const tag = cipher.getAuthTag();

    ck("the tag is 16 bytes", tag.length === 16, String(tag.length));
    ck("and is not part of the ciphertext", body.length === plaintext.length,
       `${body.length} vs ${plaintext.length}`);

    const decipher = node.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);

    ck("node opens what the shim sealed",
       Buffer.concat([decipher.update(body), decipher.final()]).equals(plaintext));
  }

  // Byte-identical, since GCM is deterministic given key and nonce.
  {
    const a = node.createCipheriv("aes-256-gcm", key, nonce);
    const fromNode = Buffer.concat([a.update(plaintext), a.final()]);

    const b = shim.createCipheriv("aes-256-gcm", key, nonce);
    b.update(plaintext);
    const fromShim = b.final();

    ck("both produce the same ciphertext", fromNode.equals(fromShim));
    ck("and the same tag", a.getAuthTag().equals(b.getAuthTag()));
  }

  // A wrong tag must throw. This is the whole reason for using GCM: a payload
  // altered by a relay has to fail to open, not decrypt to rubbish.
  {
    const cipher = node.createCipheriv("aes-256-gcm", key, nonce);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = Buffer.from(cipher.getAuthTag());
    tag[0] ^= 0xff;

    const decipher = shim.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    decipher.update(body);

    let threw = false;
    try {
      decipher.final();
    } catch {
      threw = true;
    }
    ck("a forged tag is refused", threw);
  }

  // Multi-part updates, which `encodeFrame` uses for batched events.
  {
    const parts = [Buffer.from("aaaa"), Buffer.from("bbbb"), Buffer.from("cccc")];
    const whole = Buffer.concat(parts);

    const cipher = shim.createCipheriv("aes-256-gcm", key, nonce);
    for (const part of parts) cipher.update(part);
    const body = cipher.final();

    const reference = node.createCipheriv("aes-256-gcm", key, nonce);
    const expected = Buffer.concat([reference.update(whole), reference.final()]);

    ck("split updates match one big one", body.equals(expected));
  }

  // And something larger than a chat message, since attachments go through
  // the same path.
  {
    const big = node.randomBytes(512 * 1024);

    const cipher = shim.createCipheriv("aes-256-gcm", key, nonce);
    cipher.update(big);
    const body = cipher.final();
    const tag = cipher.getAuthTag();

    const decipher = node.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);

    ck("half a megabyte survives the round trip",
       Buffer.concat([decipher.update(body), decipher.final()]).equals(big));
  }
}

// ---- randomness ------------------------------------------------------------
{
  const a = shim.randomBytes(32);
  const b = shim.randomBytes(32);

  ck("random bytes are the right length", a.length === 32);
  ck("and not the same twice", !a.equals(b));
  ck("and not all zero", !a.equals(Buffer.alloc(32)));
}

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
