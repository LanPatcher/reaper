import { pathToFileURL } from "node:url";

import { Buffer } from "buffer";

/**
 * A phone and a laptop, made to talk to each other.
 *
 * `crypto.test.ts` checks the shim against `node:crypto` primitive by
 * primitive. This does the same thing one level up: it takes the *actual*
 * Reaper core — the same `events.ts`, `identity.ts` and `crypto.ts` the desktop
 * app ships — and builds it twice. Once against Node's real builtins, which is
 * the desktop. Once against the shims, which is the phone.
 *
 * Then it makes them exchange things.
 *
 * The reason this is worth the machinery: every check here corresponds to a
 * failure that would be invisible in testing and total in practice. An event id
 * computed differently means neither device ever believes it has the other's
 * events, and reconciliation converges on sending everything, forever. A
 * signature scheme that disagrees means every incoming event is discarded as
 * forged. Both look, from the inside, exactly like a network problem.
 *
 * The two bundles are built by `scripts/shim.mjs` and their paths arrive in the
 * environment, because a file cannot import two different compilations of
 * itself by name.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

const desktopPath = process.env.REAPER_CORE_NODE;
const phonePath = process.env.REAPER_CORE_SHIM;

if (!desktopPath || !phonePath) {
  console.log("FAIL  the two builds were not provided");
  process.exit(1);
}

type Core = typeof import("./core-entry");

// Converted to a `file://` URL rather than imported by path.
//
// A dynamic import takes a *specifier*, not a filename, and Node's ESM loader
// parses it as a URL. On Linux an absolute path starts with `/` and happens to
// resolve; on Windows it starts with `C:`, which parses as a protocol named
// `c:` and is refused outright:
//
//     ERR_UNSUPPORTED_ESM_URL_SCHEME — Received protocol 'c:'
//
// So this passed everywhere it was written and failed on the machine it was
// written for. `pathToFileURL` is the supported way to cross that gap and is
// correct on both.
const desktop: Core = await import(pathToFileURL(desktopPath).href);
const phone: Core = await import(pathToFileURL(phonePath).href);

// ---- identity ---------------------------------------------------------------
//
// The user id is a hash of the public key, so if the two disagree about key
// encoding then the same keypair is two different accounts.
{
  const madeOnPhone = phone.createIdentity();
  const madeOnDesktop = desktop.createIdentity();

  ck("a phone identity has the expected shape",
     madeOnPhone.userId.length === 26 &&
     Buffer.from(madeOnPhone.publicKey, "base64").length === 44,
     `${madeOnPhone.userId.length} chars, ` +
     `${Buffer.from(madeOnPhone.publicKey, "base64").length} byte key`);

  ck("both derive the same id from the same key",
     desktop.userIdFromPublicKey(madeOnPhone.publicKey) === madeOnPhone.userId &&
     phone.userIdFromPublicKey(madeOnDesktop.publicKey) === madeOnDesktop.userId,
     `${desktop.userIdFromPublicKey(madeOnPhone.publicKey)} vs ${madeOnPhone.userId}`);

  ck("and encryption keys come out the same size",
     Buffer.from(madeOnPhone.encPublicKey!, "base64").length ===
     Buffer.from(madeOnDesktop.encPublicKey!, "base64").length);
}

// ---- event ids --------------------------------------------------------------
//
// An id is SHA-256 of the canonical form. Two devices must produce the same
// string for the same content, including for the awkward values — undefined
// fields are skipped, key order is normalised, and both of those are places an
// independent implementation would drift.
{
  const values = [
    { b: 1, a: 2 },
    { a: undefined, b: 1 },
    { nested: { z: 1, a: [3, 2, 1] } },
    { text: "unicode: éèê and \u{1f600}" },
    { empty: {}, list: [] },
    { n: 0, f: false, nil: null },
  ];

  for (const value of values) {
    ck(`canonical form agrees for ${JSON.stringify(value).slice(0, 32)}`,
       desktop.canonicalise(value) === phone.canonicalise(value),
       `${phone.canonicalise(value)} vs ${desktop.canonicalise(value)}`);
  }
}

// ---- signed events, both directions ----------------------------------------
{
  const laptop = desktop.createIdentity();
  const mobile = phone.createIdentity();

  const fromLaptop = desktop.createEvent(
    { type: "message.send", community: "c1", payload: { content: "from the laptop" } },
    laptop,
    [],
  );

  const fromMobile = phone.createEvent(
    { type: "message.send", community: "c1", payload: { content: "from the phone" } },
    mobile,
    [],
  );

  // The whole point.
  ck("a phone accepts a laptop's event", phone.verifyEvent(fromLaptop));
  ck("a laptop accepts a phone's event", desktop.verifyEvent(fromMobile));

  // Each also has to reject what it should.
  const tampered = { ...fromLaptop, payload: { content: "not what was said" } };
  ck("a phone rejects a tampered event", !phone.verifyEvent(tampered));

  const restamped = { ...fromMobile, timestamp: fromMobile.timestamp + 1 };
  ck("a laptop rejects a restamped event", !desktop.verifyEvent(restamped));

  // Ids have to match, or reconciliation never terminates: each side offers
  // what it has, neither recognises the other's ids, and both send everything
  // again on every connection.
  const content = {
    type: "message.send",
    community: "c1",
    payload: { content: "identical" },
    author: laptop.userId,
    authorKey: laptop.publicKey,
    parents: [],
    clock: 1,
    timestamp: 1700000000000,
  };

  ck("the same content hashes to the same id",
     desktop.digestContent(content as never).toString("hex") ===
     phone.digestContent(content as never).toString("hex"));

  // And a signature made on one verifies on the other, byte for byte —
  // Ed25519 is deterministic, so anything else means one of them is doing
  // something non-standard.
  const digest = desktop.digestContent(content as never);
  ck("signatures are byte-identical",
     desktop.signDigest(digest, laptop) === phone.signDigest(digest, laptop));
  ck("and verify across the boundary",
     phone.verifyDigest(digest, desktop.signDigest(digest, laptop), laptop.publicKey) &&
     desktop.verifyDigest(digest, phone.signDigest(digest, laptop), laptop.publicKey));
}

// ---- encrypted payloads -----------------------------------------------------
//
// A direct conversation derives its key from both sides' keys. If one side is
// a phone the answer has to be the same, or every message is unreadable in one
// direction — and it would look like a decryption bug rather than a key
// agreement bug.
{
  const laptop = desktop.createIdentity();
  const mobile = phone.createIdentity();

  const onLaptop = desktop.deriveKey(
    desktop.agree(laptop.encPrivateKey!, mobile.encPublicKey!),
    "dm-abc",
  );

  const onPhone = phone.deriveKey(
    phone.agree(mobile.encPrivateKey!, laptop.encPublicKey!),
    "dm-abc",
  );

  ck("both sides derive the same conversation key",
     Buffer.from(onLaptop).equals(Buffer.from(onPhone)),
     `${Buffer.from(onPhone).toString("hex").slice(0, 16)} vs ` +
     `${Buffer.from(onLaptop).toString("hex").slice(0, 16)}`);

  // A different conversation must not produce the same key, or two chats
  // between the same people share one.
  const other = desktop.deriveKey(
    desktop.agree(laptop.encPrivateKey!, mobile.encPublicKey!),
    "dm-xyz",
  );
  ck("a different conversation gets a different key",
     !Buffer.from(onLaptop).equals(Buffer.from(other)));

  const message = { content: "sealed on one, opened on the other", n: 42 };

  const sealedOnLaptop = desktop.seal(message, onLaptop);
  ck("a phone opens what a laptop sealed",
     JSON.stringify(phone.open(sealedOnLaptop, onPhone)) === JSON.stringify(message));

  const sealedOnPhone = phone.seal(message, onPhone);
  ck("a laptop opens what a phone sealed",
     JSON.stringify(desktop.open(sealedOnPhone, onLaptop)) === JSON.stringify(message));

  ck("both recognise a sealed payload",
     desktop.isSealed(sealedOnPhone) && phone.isSealed(sealedOnLaptop));

  // A community key travels in an invite, so it has to survive being written
  // by one and read by the other.
  const invite = phone.randomKey();
  const key = Buffer.from(invite, "base64");
  ck("a community key is 32 bytes", key.length === 32, String(key.length));
  ck("and works in both directions",
     JSON.stringify(desktop.open(phone.seal(message, key), key)) ===
     JSON.stringify(message));

  // Tampering must not decrypt to rubbish. `open` answers `undefined` rather
  // than throwing, deliberately — an event from a community this device has no
  // key for is the ordinary case and must not interrupt loading everything
  // else — so what matters is that it refuses, not how.
  const bent = { ...sealedOnLaptop, c: Buffer.from("nonsense").toString("base64") };
  ck("a tampered payload will not open", phone.open(bent, onPhone) === undefined);

  // And the wrong key is refused the same way, rather than yielding something
  // that happens to parse.
  const stranger = Buffer.from(phone.randomKey(), "base64");
  ck("nor does the wrong key open it",
     phone.open(sealedOnLaptop, stranger) === undefined);
}

// ---- ordering and reconciliation -------------------------------------------
//
// Both devices have to agree on the order of a conversation, or the same
// messages appear in different sequences on a phone and a laptop.
{
  const laptop = desktop.createIdentity();
  const mobile = phone.createIdentity();

  const events: ReturnType<Core["createEvent"]>[] = [];

  // Alternating authors, each descending from what came before, which is the
  // ordinary shape of a conversation between two people.
  for (let i = 0; i < 6; i++) {
    const write = i % 2 ? phone : desktop;
    const who = i % 2 ? mobile : laptop;

    events.push(write.createEvent(
      { type: "message.send", community: "c1", payload: { n: i } },
      who,
      write.findHeads(events),
    ));
  }

  const onLaptop = desktop.causalSort([...events]).map((e) => e.id).join();
  const onPhone = phone.causalSort([...events].reverse()).map((e) => e.id).join();

  ck("both sort a conversation the same way", onLaptop === onPhone);

  // Merging is what a sync actually does, so it has to accept the other
  // device's events rather than rejecting them as unverifiable.
  const half = events.filter((_, i) => i % 2 === 0);
  const rest = events.filter((_, i) => i % 2 === 1);

  const merged = phone.mergeEvents(half, rest);
  ck("a phone merges a laptop's half", merged.accepted.length === rest.length,
     `${merged.accepted.length} of ${rest.length}`);
  ck("and rejects nothing legitimate", merged.rejected.length === 0);

  // The watermarks, since those are what the offer is made of now.
  const summary = phone.summarise(events);
  ck("both summarise a log identically",
     JSON.stringify(summary) === JSON.stringify(desktop.summarise(events)));
  ck("and neither offers the other anything it already has",
     desktop.missingFrom(events, summary).length === 0 &&
     phone.missingFrom(events, desktop.summarise(events)).length === 0);
}

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
