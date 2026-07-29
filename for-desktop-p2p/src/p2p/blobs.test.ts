import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BlobStore, blobId } from "./blobs";
import { randomKey } from "./crypto";

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

const dir = mkdtempSync(join(tmpdir(), "blobs-"));

try {
  // ---- content addressing ------------------------------------------------
  const store = new BlobStore(join(dir, "plain"));

  const hello = Buffer.from("the quick brown fox");
  const ref = store.write(hello);

  ck("id is the content hash", ref.id === blobId(hello), ref.id.slice(0, 12));
  ck("size reported", ref.size === hello.length, String(ref.size));
  ck("held after write", store.has(ref.id));
  ck("reads back intact", Buffer.compare(store.read(ref.id)!, hello) === 0);

  // The same bytes twice must not cost twice.
  store.write(hello);
  const onDisk = readdirSync(join(dir, "plain")).filter((n) => /^[a-f0-9]{64}$/.test(n));
  ck("identical content stored once", onDisk.length === 1, String(onDisk.length));

  ck("unknown id reads as undefined", store.read(blobId(Buffer.from("nope"))) === undefined);

  // ---- verification ------------------------------------------------------
  //
  // The check that makes fetching from an untrusted peer safe: content is
  // accepted only if it hashes to the id that was asked for.
  const claimed = blobId(Buffer.from("what was promised"));
  ck("mismatched content refused", store.accept(claimed, Buffer.from("something else")) === false);
  ck("refused content not stored", !store.has(claimed));

  ck("matching content accepted", store.accept(claimed, Buffer.from("what was promised")) === true);
  ck("accepted content stored", store.has(claimed));

  // ---- path safety -------------------------------------------------------
  //
  // Ids arrive over the network, so they are validated rather than trusted.
  let escaped = false;
  try {
    store.read("../../../etc/passwd");
  } catch {
    escaped = true;
  }
  ck("traversal id rejected or refused", escaped || !store.has("../../../etc/passwd"));

  // ---- encryption at rest ------------------------------------------------
  //
  // A file is exactly as sensitive as the message carrying it, so it gets the
  // same key.
  const key = Buffer.from(randomKey(), "base64");
  const sealed = new BlobStore(join(dir, "sealed"), key);
  const secret = Buffer.from("attachment contents that should not be readable");
  const sref = sealed.write(secret);

  ck("sealed reads back", Buffer.compare(sealed.read(sref.id)!, secret) === 0);

  const raw = readdirSync(join(dir, "sealed"));
  const onDiskBytes = readFileSync(join(dir, "sealed", raw[0]));
  ck("not plaintext on disk", onDiskBytes.indexOf(secret) === -1);

  const wrong = new BlobStore(join(dir, "sealed"), Buffer.from(randomKey(), "base64"));
  ck("wrong key does not read it", wrong.read(sref.id) === undefined);

  // ---- forgetting --------------------------------------------------------
  sealed.forget(sref.id);
  ck("forgotten blob gone", !sealed.has(sref.id));
  ck("forgetting twice is fine", (sealed.forget(sref.id), true));

  // ---- a rotated key ------------------------------------------------------
  //
  // Removing somebody from a community mints a fresh payload key, and blobs are
  // sealed with it. Holding only the current one meant every file already on
  // disk stopped opening the moment that happened — every avatar, banner, icon
  // and downloaded attachment in that community, permanently, and silently:
  // `read` answers undefined for a file it cannot open and undefined is also
  // what "we do not have it" looks like.
  {
    const first = Buffer.from(randomKey(), "base64");
    const second = Buffer.from(randomKey(), "base64");

    const rotating = new BlobStore(join(dir, "rotating"), first);
    const face = Buffer.from("a profile picture");
    const ref = rotating.write(face);

    ck("readable under the key it was sealed with",
       Buffer.compare(rotating.read(ref.id)!, face) === 0);

    // What a rotation used to do.
    rotating.setKey(second);
    ck("a rotation without the history loses it", rotating.read(ref.id) === undefined);

    rotating.setKey(second, [first]);
    ck("...and keeping the old key gets it back",
       Buffer.compare(rotating.read(ref.id)!, face) === 0);

    // Anything written now uses the current key, and both stay readable.
    const fresh = Buffer.from("a newer picture");
    const newer = rotating.write(fresh);

    ck("new files use the current key",
       Buffer.compare(rotating.read(newer.id)!, fresh) === 0);
    ck("and the older one is still there",
       Buffer.compare(rotating.read(ref.id)!, face) === 0);

    // A key that was never used opens nothing, so this is not simply trying
    // everything until something looks plausible.
    rotating.setKey(second, [Buffer.from(randomKey(), "base64")]);
    ck("an unrelated key does not open it", rotating.read(ref.id) === undefined);
  }

  // ---- a corrupt file is not a crash -------------------------------------
  const junkId = blobId(Buffer.from("junk"));
  writeFileSync(join(dir, "plain", junkId), Buffer.from("not what it claims"));
  ck("unreadable blob reads as undefined or wrong-but-safe",
     (() => { try { store.read(junkId); return true; } catch { return false; } })());
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
