import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";

import { createEvent, findHeads, mergeEvents, type SignedEvent } from "./events";
import { createIdentity } from "./identity";

/**
 * Server export, at the level that matters.
 *
 * The bundle format is deliberately thin — compressed JSON holding signed
 * events — so what is worth testing is not the plumbing but the claim the
 * feature rests on: that events survive the round trip intact, still verify
 * against their original author, and that a tampered bundle is rejected on
 * the way back in rather than trusted because it arrived as a file.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

const owner = createIdentity();
const member = createIdentity();

// A server: channels from the owner, messages from a member.
const log: SignedEvent[] = [];

for (let i = 0; i < 3; i++) {
  log.push(
    createEvent(
      { type: "channel.create", community: "s1", payload: { id: "c" + i, name: "chan" + i } },
      owner,
      findHeads(log),
    ),
  );
}

for (let i = 0; i < 20; i++) {
  log.push(
    createEvent(
      { type: "message.send", community: "s1", payload: { channelId: "c0", content: "hello " + i } },
      member,
      findHeads(log),
    ),
  );
}

// A message referring to a file, the way an attachment does.
log.push(
  createEvent(
    {
      type: "message.send",
      community: "s1",
      payload: {
        channelId: "c0",
        content: "",
        files: [{ name: "big.mp4", size: 40_000_000, type: "video/mp4", blob: "a".repeat(64) }],
      },
    },
    member,
    findHeads(log),
  ),
);

function pack(events: SignedEvent[]): Buffer {
  return brotliCompressSync(
    Buffer.from(JSON.stringify({ reaper: "server", v: 1, id: "s1", events }), "utf8"),
    { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT } },
  );
}

function unpack(data: Buffer): { events: SignedEvent[] } {
  return JSON.parse(brotliDecompressSync(data).toString("utf8"));
}

// ---- compression ---------------------------------------------------------
const raw = Buffer.from(JSON.stringify({ mayhem: "server", v: 1, id: "s1", events: log }), "utf8");
const packed = pack(log);

ck("bundle is smaller than the log", packed.length < raw.length,
   `${raw.length}B -> ${packed.length}B`);
ck("compression is worth doing", raw.length / packed.length > 2,
   (raw.length / packed.length).toFixed(1) + "x");

// ---- round trip ----------------------------------------------------------
const restored = unpack(packed);
ck("every event survived", restored.events.length === log.length,
   `${restored.events.length}/${log.length}`);

// Merged into an empty log, exactly as an import does.
const fresh = mergeEvents([], restored.events);
ck("all accepted on import", fresh.accepted.length === log.length,
   `${fresh.accepted.length} accepted, ${fresh.rejected.length} rejected`);

ck("channels still belong to the owner",
   fresh.events.filter((e) => e.type === "channel.create")
     .every((e) => e.author === owner.userId));

ck("messages still belong to the member",
   fresh.events.filter((e) => e.type === "message.send")
     .every((e) => e.author === member.userId));

// ---- the file reference outlives the file --------------------------------
//
// The whole point of leaving large attachments out: the message still knows
// the file exists, so it can be offered for download from a peer.
const withFile = fresh.events.find(
  (e) => (e.payload as { files?: unknown[] })?.files !== undefined,
);
const files = (withFile?.payload as { files: { name: string; size: number; blob: string }[] }).files;

ck("large file still described", !!withFile && files[0].name === "big.mp4");
ck("its size is known", files[0].size === 40_000_000);
ck("its id is known, so peers can be asked", files[0].blob.length === 64);

// ---- tampering -----------------------------------------------------------
//
// A bundle is a peer's log in a file, and is trusted exactly as much: not at
// all until the signatures say so.
const forged = JSON.parse(JSON.stringify(restored.events)) as SignedEvent[];
const target = forged.find((e) => e.type === "message.send")!;
(target.payload as { content: string }).content = "something else entirely";

const checked = mergeEvents([], forged);
ck("edited event refused", checked.rejected.length === 1,
   `${checked.rejected.length} rejected`);
ck("the rest still land", checked.accepted.length === log.length - 1,
   `${checked.accepted.length}`);

// Re-signing under a different identity does not launder it either: the event
// is then genuinely that person's, and owner-only types are checked against
// the owner elsewhere.
const impostor = createIdentity();
const reSigned = createEvent(
  { type: "channel.create", community: "s1", payload: { id: "sneaky", name: "sneaky" } },
  impostor,
  [],
);
const mixed = mergeEvents([], restored.events.concat([reSigned]));
const sneaky = mixed.events.find(
  (e) => (e.payload as { id?: string })?.id === "sneaky",
);
ck("a forged channel is attributed to its real signer",
   !!sneaky && sneaky.author === impostor.userId);
ck("and not to the owner", !!sneaky && sneaky.author !== owner.userId);

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
