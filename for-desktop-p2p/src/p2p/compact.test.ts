import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compact, expiresAt, worthCompacting } from "./compact";
import { createEvent, findHeads, type SignedEvent } from "./events";
import { createIdentity } from "./identity";
import { CommunityStore } from "./store";

/**
 * Forgetting things safely.
 *
 * An append-only log grows without limit, and most of what accumulates is not
 * history — it is superseded state. The temptation is to delete events when
 * they stop mattering, and that breaks synchronisation in a way that is
 * invisible until two people talk: peers compare *sets of ids*, so a removed
 * event is indistinguishable from one never received, and the peer that still
 * has it sends it back.
 *
 * These tests hold both halves down: that the rules only drop what genuinely
 * cannot change a replay, and that what is dropped stays dropped.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

const alice = createIdentity();
const bob = createIdentity();

/** Build a small log, in order. */
function log(...writes: [ReturnType<typeof createIdentity>, string, unknown][]) {
  const events: SignedEvent[] = [];
  for (const [who, type, payload] of writes) {
    events.push(createEvent({ type, community: "c1", payload }, who, findHeads(events)));
  }
  return events;
}

// ---- superseded state ----------------------------------------------------
{
  const events = log(
    [alice, "profile.update", { username: "a1" }],
    [alice, "profile.update", { username: "a2" }],
    [alice, "profile.update", { username: "a3" }],
    [bob, "profile.update", { username: "b1" }],
  );

  const { keep, pruned } = compact(events);

  ck("only the newest profile per person is kept", keep.length === 2,
     `${keep.length} kept, ${pruned.length} pruned`);
  ck("and it is the newest one",
     (keep[0].payload as { username: string }).username === "a3");
  ck("everybody keeps their own", keep.some((e) => e.author === bob.userId));
}

{
  const events = log(
    [alice, "community.rename", { id: "c1", name: "one" }],
    [alice, "community.rename", { id: "c1", name: "two" }],
    [alice, "community.rename", { id: "c2", name: "other" }],
  );

  const { keep } = compact(events);
  ck("renames collapse per target", keep.length === 2, String(keep.length));
  ck("the surviving one is the latest",
     (keep[0].payload as { name: string }).name === "two");
}

// ---- deleted messages ----------------------------------------------------
{
  const events = log(
    [alice, "message.send", { channelId: "x", content: "kept" }],
    [alice, "message.send", { channelId: "x", content: "regretted" }],
  );
  const regretted = events[1];

  events.push(createEvent(
    { type: "message.delete", community: "c1", payload: { messageId: regretted.id } },
    alice,
    findHeads(events),
  ));

  const { keep, pruned } = compact(events);

  ck("the deleted body is dropped", !keep.some((e) => e.id === regretted.id));
  ck("and its id is remembered", pruned.includes(regretted.id));
  ck("the message that was not deleted survives",
     keep.some((e) => (e.payload as { content?: string }).content === "kept"));

  // The tombstone is what makes deletion expressible at all. Dropping it would
  // mean a peer that still holds the body could hand it back and nothing would
  // contradict them.
  ck("the tombstone is kept", keep.some((e) => e.type === "message.delete"));
}

// ---- presence ------------------------------------------------------------
{
  const events = log(
    [alice, "voice.join", { channelId: "v" }],
    [alice, "voice.here", { channelId: "v" }],
    [alice, "voice.here", { channelId: "v" }],
    [alice, "voice.here", { channelId: "v" }],
    [alice, "voice.leave", { channelId: "v" }],
  );

  const { keep } = compact(events);
  ck("heartbeats are dropped", !keep.some((e) => e.type === "voice.here"));
  ck("the join is kept", keep.some((e) => e.type === "voice.join"));
  ck("the departure is kept", keep.some((e) => e.type === "voice.leave"));
}

// ---- what must never be touched ------------------------------------------
{
  const events = log(
    [alice, "message.send", { channelId: "x", content: "one" }],
    [bob, "message.send", { channelId: "x", content: "two" }],
    [alice, "channel.create", { id: "x", name: "general" }],
    [alice, "community.owner", { userId: alice.userId }],
    [bob, "member.leave", {}],
    [alice, "member.kick", { userId: bob.userId }],
    [alice, "role.create", { id: "r1", name: "mod" }],
  );

  const { keep, pruned } = compact(events);
  ck("ordinary history is untouched", pruned.length === 0,
     pruned.length + " pruned");
  ck("every event survives", keep.length === events.length);
}

// ---- joining and leaving, over and over ----------------------------------
{
  const events = log(
    [alice, "community.owner", { userId: alice.userId }],
    [bob, "member.join", {}],
    [bob, "member.leave", {}],
    [bob, "member.join", {}],
    [bob, "member.leave", {}],
    [bob, "member.join", {}],
  );

  const { keep, pruned } = compact(events);

  ck("churn collapses to the last statement", pruned.length === 4,
     pruned.length + " pruned");
  ck("and the last one is what survives",
     keep.filter((e) => e.type === "member.join" || e.type === "member.leave").length === 1);
  ck("which leaves them a member",
     keep.some((e) => e.type === "member.join" && e.author === bob.userId));
}

{
  // The same churn, ending the other way.
  const events = log(
    [alice, "community.owner", { userId: alice.userId }],
    [bob, "member.join", {}],
    [bob, "member.leave", {}],
    [bob, "member.join", {}],
    [bob, "member.leave", {}],
  );

  const { keep } = compact(events);
  ck("a departure at the end survives",
     keep.some((e) => e.type === "member.leave" && e.author === bob.userId));
  ck("and nothing claims they are still there",
     !keep.some((e) => e.type === "member.join" && e.author === bob.userId));
}

// ---- unless the seat was contested ---------------------------------------
//
// The window between a join and its departure is a window in which that person
// occupied a seat. If the room was full at that moment, somebody else was
// turned away *because of it* — so collapsing the pair would silently let them
// in, years later, on a replay.
{
  const carol = createIdentity();
  const dave = createIdentity();

  const events: SignedEvent[] = [];
  const write = (who: ReturnType<typeof createIdentity>, type: string, payload: unknown = {}) => {
    events.push(createEvent({ type, community: "c1", payload }, who, findHeads(events)));
  };

  // The order matters, and this is the order that makes it matter: dave is
  // turned away *while* bob is holding a seat. Collapse bob's early join and
  // departure and dave is no longer turned away — so a replay years later
  // seats a different person.
  write(alice, "community.owner", { userId: alice.userId });
  write(bob, "member.join", {});
  write(carol, "member.join", {});      // room of two is now full
  write(dave, "member.join", {});       // refused: bob is holding a seat
  write(bob, "member.leave", {});       // bob gives it up
  write(bob, "member.join", {});        // and takes it straight back

  const cap = 2;
  const { keep, pruned } = compact(events, cap);

  ck("a contested seat is not collapsed away", pruned.length === 0,
     pruned.length + " pruned");
  ck("so the log is left exactly as it was",
     JSON.stringify(keep.map((e) => e.id)) === JSON.stringify(events.map((e) => e.id)));
}

// ---- a kick is never collapsed -------------------------------------------
{
  const events = log(
    [alice, "community.owner", { userId: alice.userId }],
    [bob, "member.join", {}],
    [alice, "member.kick", { userId: bob.userId }],
    [bob, "member.join", {}],
  );

  const { keep } = compact(events);
  ck("somebody else's decision about you is kept",
     keep.some((e) => e.type === "member.kick"));
}

// ---- the threshold -------------------------------------------------------
{
  ck("a short log is left alone", !worthCompacting(log([alice, "message.send", {}])));

  const noisy: SignedEvent[] = [];
  for (let i = 0; i < 400; i++) {
    noisy.push(createEvent(
      { type: "profile.update", community: "c1", payload: { username: "n" + i } },
      alice,
      findHeads(noisy),
    ));
  }
  ck("a log that is mostly dead weight is worth compacting", worthCompacting(noisy));

  const clean: SignedEvent[] = [];
  for (let i = 0; i < 400; i++) {
    clean.push(createEvent(
      { type: "message.send", community: "c1", payload: { content: "m" + i } },
      alice,
      findHeads(clean),
    ));
  }
  ck("a log of real messages is not", !worthCompacting(clean));
}

// ---- and it survives a round trip through the store -----------------------
const dir = mkdtempSync(join(tmpdir(), "compact-"));

try {
  const store = new CommunityStore({ root: dir, community: "c1", identity: alice });
  store.open();

  for (let i = 0; i < 30; i++) store.append("profile.update", { username: "v" + i });
  const wanted = store.append("message.send", { channelId: "x", content: "hello" });

  const before = store.events().length;
  const result = store.compact();

  ck("compaction reports what it did", !!result && result.removed === 29,
     JSON.stringify(result));
  ck("the log shrank", store.events().length === before - 29,
     `${before} -> ${store.events().length}`);
  ck("the message survived", store.events().some((e) => e.id === wanted.id));

  // The property the whole design rests on: a peer offering a pruned event
  // must be told we already have it.
  const dropped = result ? result.removed : 0;
  ck("pruned ids are still reported as known",
     store.knownIds().length === store.events().length + dropped,
     `${store.knownIds().length} known, ${store.events().length} held`);

  store.close();

  // Reopened from disk: the ledger has to have survived, or the next sync
  // undoes the compaction.
  const again = new CommunityStore({ root: dir, community: "c1", identity: alice });
  again.open();

  ck("the compacted log reloads", again.events().length === before - 29,
     String(again.events().length));
  ck("and still remembers what it dropped",
     again.knownIds().length === again.events().length + dropped,
     `${again.knownIds().length} known`);
  ck("the surviving message is readable",
     again.events().some((e) => e.id === wanted.id));

  again.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ---- sealed payloads -----------------------------------------------------
//
// Every rule in this file reads a field *inside* a payload, and in any
// community with an encryption key the payload is an envelope — `{ e, n, c, t }`
// — carrying none of them. So each of those rules did nothing at all, on every
// real community, and said nothing about it: compaction ran, reported the two
// rules that happen not to read a payload, and looked like it had worked.
//
// The events here are shaped exactly as `seal` shapes them, so the test fails
// against a `compact` that reads `event.payload` directly.
{
  const box = (payload: unknown) => ({
    e: 1,
    n: "nonce",
    c: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    t: "tag",
  });

  const open = (sealed: unknown) => {
    const envelope = sealed as { e?: number; c?: string };
    if (envelope?.e !== 1 || typeof envelope.c !== "string") return sealed;
    return JSON.parse(Buffer.from(envelope.c, "base64").toString("utf8"));
  };

  const doomed = createEvent(
    { type: "message.send", community: "c1", payload: box({ content: "gone" }) },
    alice,
    [],
  );

  const events = [
    doomed,
    createEvent(
      { type: "message.delete", community: "c1", payload: box({ messageId: doomed.id }) },
      alice,
      [doomed],
    ),
    createEvent(
      { type: "community.rename", community: "c1", payload: box({ id: "c1", name: "one" }) },
      alice,
      [],
    ),
    createEvent(
      { type: "community.rename", community: "c1", payload: box({ id: "c1", name: "two" }) },
      alice,
      [],
    ),
  ];

  // What the old behaviour produced, and what makes this worth a test: nothing.
  const blind = compact(events);
  ck("without a reader a sealed log looks like it has nothing to drop",
     blind.pruned.length === 0, String(blind.pruned.length));

  const seeing = compact(events, 10, open);

  ck("the body of a deleted message is dropped",
     seeing.pruned.includes(doomed.id),
     seeing.pruned.join(","));
  ck("...and its tombstone is kept",
     seeing.keep.some((e) => e.type === "message.delete"));
  ck("a superseded rename is dropped", seeing.pruned.length === 2,
     String(seeing.pruned.length));
  ck("and the latest one survives",
     seeing.keep.filter((e) => e.type === "community.rename").length === 1);
}

// ---- messages that expire -------------------------------------------------
//
// The most destructive rule in the file, so the boundaries are pinned rather
// than trusted: what goes, what stays, and — the one that matters most — what
// happens when the information needed to decide is missing.
{
  const HOUR = 3600000;
  const now = 1_000_000_000_000;

  /** A message written `age` ago, asking to live for `ttl`. */
  const said = (age: number, ttl?: number) =>
    ({
      id: `m${age}-${ttl ?? "forever"}`,
      type: "message.send",
      author: "a",
      timestamp: now - age,
      payload: ttl === undefined ? { content: "hi" } : { content: "hi", ttl },
    }) as unknown as SignedEvent;

  const run = (events: SignedEvent[], keepFor = 0) =>
    compact(events, 10, (p) => p, { now, keepFor });

  // The basic rule, from both directions.
  {
    const events = [said(2 * HOUR, HOUR), said(HOUR / 2, HOUR)];
    const { keep, pruned } = run(events);

    ck("a message past its time is dropped", pruned.length === 1, pruned.join(","));
    ck("...and one still inside it is kept",
       keep.length === 1 && keep[0].id === events[1].id);
  }

  // Forever is the default, and it is what silence means.
  {
    const old = [said(1000 * HOUR)];
    ck("a message with no ttl never expires", run(old).pruned.length === 0);

    const zero = [said(1000 * HOUR, 0)];
    ck("...and a ttl of zero means the same", run(zero).pruned.length === 0);
  }

  // The reader's own limit, which applies on top rather than instead.
  {
    const forever = [said(2 * HOUR)];
    ck("this device's limit expires somebody else's forever",
       run(forever, HOUR).pruned.length === 1);

    const short = [said(2 * HOUR, HOUR)];
    ck("...and a generous limit does not rescue a short message",
       run(short, 1000 * HOUR).pruned.length === 1);

    const young = [said(HOUR / 2, 1000 * HOUR)];
    ck("neither expires something inside both", run(young, 1000 * HOUR).pruned.length === 0);
  }

  // What must never be swept, however old.
  {
    const ancient = now - 1000 * HOUR;
    const others = [
      { id: "j", type: "member.join", author: "a", timestamp: ancient, payload: {} },
      { id: "k", type: "community.key", author: "a", timestamp: ancient, payload: {} },
      { id: "t", type: "message.delete", author: "a", timestamp: ancient,
        payload: { messageId: "gone" } },
    ] as unknown as SignedEvent[];

    ck("nothing but a message is ever expired",
       run(others, HOUR).pruned.length === 0);
  }

  // The case where the rule cannot be applied. Keeping is the only safe answer:
  // deleting on the strength of a field an event does not have is how a bug
  // here becomes lost conversation.
  {
    const undated = [{
      id: "u", type: "message.send", author: "a", payload: { content: "hi", ttl: 1 },
    }] as unknown as SignedEvent[];

    ck("a message with no timestamp is kept, not guessed at",
       run(undated, HOUR).pruned.length === 0);
  }

  // And the sealed case, which is every real community: without a reader the
  // ttl is inside an envelope and nothing should be dropped.
  {
    const sealed = [{
      id: "s", type: "message.send", author: "a", timestamp: now - 2 * HOUR,
      payload: { e: 1, n: "n", c: "c", t: "t" },
    }] as unknown as SignedEvent[];

    ck("a sealed message is not expired by a reader that cannot open it",
       compact(sealed, 10, (p) => p, { now }).pruned.length === 0);
  }

  // The interface has to be able to show the same answer the sweep will act on.
  {
    const one = said(0, HOUR);
    ck("the due time is offered to whatever draws the countdown",
       expiresAt(one, one.payload, 0) === now + HOUR);
    ck("...including this device's own limit",
       expiresAt(one, one.payload, HOUR / 2) === now + HOUR / 2);
    ck("...and says nothing for something that never expires",
       expiresAt(said(0), { content: "hi" }, 0) === undefined);
  }
}

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
