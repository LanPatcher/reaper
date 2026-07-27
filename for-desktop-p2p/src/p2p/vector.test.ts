import type { SignedEvent } from "./events";
import {
  droppableUpTo,
  missingFrom,
  nextSeq,
  sameSummary,
  summarise,
  summarySize,
  type Floors,
} from "./vector";

/**
 * Watermarks instead of id lists.
 *
 * This is the sync core, so it is tested on its own before it is allowed near
 * a socket. Every check here is about one of two properties:
 *
 *   - Nothing is lost. An event a peer does not have must always be offered,
 *     including in the awkward cases: gaps, events from before numbering, and
 *     a peer that has forgotten more than we have.
 *   - Nothing comes back. An event deliberately dropped must never be offered
 *     to us again, which is the property that makes forgetting possible at all.
 *
 * Where the two conflict, the tests take the side of not losing anything.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

/** A stand-in event. Only the fields the summary reads are real. */
function ev(author: string, seq?: number, id?: string): SignedEvent {
  return {
    id: id ?? `${author}-${seq ?? "legacy"}`,
    author,
    ...(seq === undefined ? {} : { seq }),
  } as unknown as SignedEvent;
}

// ---- describing a log ----------------------------------------------------
{
  const events = [ev("a", 1), ev("a", 2), ev("a", 3), ev("b", 1)];
  const s = summarise(events);

  ck("a complete chain becomes one number", s.vector.a === 3, JSON.stringify(s.vector));
  ck("each author is counted separately", s.vector.b === 1);
  ck("and nothing needs naming", s.extra.length === 0, JSON.stringify(s.extra));
}

// ---- gaps ----------------------------------------------------------------
//
// The case that decides whether this is safe. Holding 1, 2 and 7 does not mean
// holding "up to 7": claiming so would lose 3 through 6 permanently.
{
  const events = [ev("a", 1), ev("a", 2), ev("a", 7)];
  const s = summarise(events);

  ck("a watermark stops at the gap", s.vector.a === 2, String(s.vector.a));
  ck("and what is above it is named", s.extra.includes("a-7"), JSON.stringify(s.extra));

  // Which means a peer sends 3..6 and does not resend 7.
  const theirs = [ev("a", 3), ev("a", 4), ev("a", 7)];
  const send = missingFrom(theirs, s).map((e) => e.id);

  ck("the hole is filled", send.includes("a-3") && send.includes("a-4"));
  ck("what we already have is not resent", !send.includes("a-7"), JSON.stringify(send));
}

// ---- events from before numbering existed --------------------------------
//
// They cannot be given a number — an event's id is the hash of its contents
// and the signature covers it — so they keep the old treatment.
{
  const events = [ev("a", undefined, "old-1"), ev("a", undefined, "old-2"), ev("a", 1)];
  const s = summarise(events);

  ck("old events are named individually",
     s.extra.includes("old-1") && s.extra.includes("old-2"));
  ck("numbered ones still collapse", s.vector.a === 1);

  const theirs = [ev("a", undefined, "old-1"), ev("a", undefined, "old-3")];
  const send = missingFrom(theirs, s).map((e) => e.id);

  ck("an old event they lack is offered", send.includes("old-3"));
  ck("an old event they have is not", !send.includes("old-1"));
}

// ---- forgetting ----------------------------------------------------------
//
// The whole point. A floor says "everything up to here is accounted for",
// whether or not it is still on disk.
{
  const floors: Floors = { a: 300 };
  const events = [ev("a", 301), ev("a", 302)];
  const s = summarise(events, floors);

  ck("a floor carries the watermark", s.vector.a === 302, String(s.vector.a));
  ck("nothing below it needs naming", s.extra.length === 0);

  // A peer that still holds the old history must not send it back.
  const hoarder = [ev("a", 5), ev("a", 200), ev("a", 301), ev("a", 303)];
  const send = missingFrom(hoarder, s).map((e) => e.id);

  ck("discarded history is not resurrected",
     !send.includes("a-5") && !send.includes("a-200"), JSON.stringify(send));
  ck("but genuinely new events still arrive", send.includes("a-303"));
}

{
  // A floor with nothing held at all — everything was dropped.
  const s = summarise([], { a: 500 });
  ck("an emptied author still reports its floor", s.vector.a === 500);

  const send = missingFrom([ev("a", 12), ev("a", 501)], s).map((e) => e.id);
  ck("and still refuses the old events", !send.includes("a-12"));
  ck("while accepting newer ones", send.includes("a-501"));
}

// ---- a peer that knows less than we do -----------------------------------
{
  const ours = [ev("a", 1), ev("a", 2), ev("a", 3), ev("b", 1)];
  const theirs = summarise([ev("a", 1)]);

  const send = missingFrom(ours, theirs).map((e) => e.id);
  ck("they are sent everything after their watermark",
     send.includes("a-2") && send.includes("a-3"), JSON.stringify(send));
  ck("including authors they have never heard of", send.includes("b-1"));
  ck("and nothing they already had", !send.includes("a-1"));
}

// ---- an empty summary ----------------------------------------------------
{
  const ours = [ev("a", 1), ev("b", 1), ev("c", undefined, "old")];
  const send = missingFrom(ours, { vector: {}, extra: [] });
  ck("a peer with nothing gets everything", send.length === 3, String(send.length));
}

// ---- numbering the next event --------------------------------------------
{
  const events = [ev("a", 1), ev("a", 2), ev("b", 9)];

  ck("counts on from the highest held", nextSeq(events, "a") === 3);
  ck("per author", nextSeq(events, "b") === 10);
  ck("a new author starts at one", nextSeq(events, "c") === 1);

  // The case that would otherwise renumber history: a device that has dropped
  // its old events must not start again from 1.
  ck("a floor is respected", nextSeq([], "a", { a: 412 }) === 413);
  ck("and the higher of the two wins",
     nextSeq([ev("a", 500)], "a", { a: 412 }) === 501);

  // Legacy events have no number and must not be counted as one.
  ck("old events do not affect numbering",
     nextSeq([ev("a", undefined, "old")], "a") === 1);
}

// ---- what could be dropped ----------------------------------------------
{
  const s = summarise([ev("a", 1), ev("a", 2), ev("b", 1), ev("b", 5)]);
  const floors = droppableUpTo(s);

  ck("everything below a watermark is droppable", floors.a === 2);
  ck("and a gap limits it", floors.b === 1, String(floors.b));
}

// ---- skipping an exchange -----------------------------------------------
{
  const a = summarise([ev("a", 1), ev("a", 2)]);
  const b = summarise([ev("a", 1), ev("a", 2)]);
  const c = summarise([ev("a", 1), ev("a", 2), ev("a", 3)]);

  ck("identical summaries compare equal", sameSummary(a, b));
  ck("a newer one does not", !sameSummary(a, c));
  ck("nor does a differing exception list",
     !sameSummary({ vector: { a: 1 }, extra: [] }, { vector: { a: 1 }, extra: ["x"] }));
  ck("order in the exception list is not significant",
     sameSummary({ vector: {}, extra: ["x", "y"] }, { vector: {}, extra: ["y", "x"] }));
}

// ---- the size claim ------------------------------------------------------
//
// This exists because of bandwidth, so the saving is worth measuring rather
// than asserting.
{
  const many: SignedEvent[] = [];
  for (let i = 1; i <= 5000; i++) many.push(ev("a", i));
  for (let i = 1; i <= 5000; i++) many.push(ev("b", i));

  const s = summarise(many);
  const asIds = many.length * 66;

  ck("ten thousand events summarise to two numbers",
     Object.keys(s.vector).length === 2 && s.extra.length === 0);
  ck("which is thousands of times smaller",
     summarySize(s) * 1000 < asIds,
     `${summarySize(s)} B vs ${Math.round(asIds / 1024)} KB`);

  // And the pathological case: all legacy, so no better than before.
  const old: SignedEvent[] = [];
  for (let i = 0; i < 1000; i++) old.push(ev("a", undefined, "old-" + i));
  ck("a log from before numbering costs what it always did",
     summarySize(summarise(old)) === 1000 * 66);
}

// ---- the property, stated once more --------------------------------------
//
// Whatever two devices hold, exchanging summaries and sending what the other
// lacks has to leave both able to reach the same set.
{
  const mine = [ev("a", 1), ev("a", 2), ev("b", 1), ev("c", undefined, "old-x")];
  const yours = [ev("a", 1), ev("a", 3), ev("d", 1)];

  const toYou = missingFrom(mine, summarise(yours));
  const toMe = missingFrom(yours, summarise(mine));

  const yoursAfter = new Set([...yours, ...toYou].map((e) => e.id));
  const mineAfter = new Set([...mine, ...toMe].map((e) => e.id));

  ck("both sides end up with the union",
     yoursAfter.size === mineAfter.size &&
     [...yoursAfter].every((id) => mineAfter.has(id)),
     `${[...mineAfter].sort().join(",")} vs ${[...yoursAfter].sort().join(",")}`);
}

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
