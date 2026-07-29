import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { causalSort, findHeads } from "./events";
import { createIdentity } from "./identity";
import { CommunityStore } from "./store";

let failures = 0;
const check = (n: string, c: boolean, e = "") => { console.log(`${c?"PASS":"FAIL"}  ${n}${e?"  "+e:""}`); if(!c) failures++; };

const ray = createIdentity();
const friend = createIdentity();
const root = mkdtempSync(join(tmpdir(), "store-"));
const root2 = mkdtempSync(join(tmpdir(), "store2-"));

// --- append + persist -------------------------------------------------------
{
  const s = new CommunityStore({ root, community: "hytlands", identity: ray });
  s.open();
  for (let i = 0; i < 50; i++) s.append("message.send", { content: `hello ${i}` });
  check("events in memory", s.events().length === 50);
  check("single head", s.heads().length === 1);
  s.close();

  const reopened = new CommunityStore({ root, community: "hytlands", identity: ray });
  reopened.open();
  check("survives restart", reopened.events().length === 50, `got ${reopened.events().length}`);
  check("order preserved", (reopened.events()[0].payload as any).content === "hello 0");
  check("compressed on disk", reopened.size() < 50 * 200, `${reopened.size()}B for 50 events`);
  reopened.close();
}

// --- per-community key isolation -------------------------------------------
{
  const a = new CommunityStore({ root, community: "other", identity: ray });
  a.open(); a.append("message.send", { content: "secret" }); a.close();
  // A different identity cannot read it. That used to throw; it now recovers
  // by moving the unreadable data aside, because throwing here killed startup
  // before the app could even ask for a username.
  const impostor = new CommunityStore({ root, community: "other", identity: friend });
  impostor.open();
  check("wrong identity reads nothing", impostor.events().length === 0);
  check("wrong identity does not throw", true);
}

// --- two peers reconciling --------------------------------------------------
{
  const mine = new CommunityStore({ root: root2, community: "c", identity: ray });
  mine.open();
  const theirs = new CommunityStore({ root: mkdtempSync(join(tmpdir(), "peer-")), community: "c", identity: friend });
  theirs.open();

  // both write while disconnected
  for (let i = 0; i < 5; i++) mine.append("message.send", { from: "ray", i });
  for (let i = 0; i < 5; i++) theirs.append("message.send", { from: "friend", i });

  check("diverged", mine.events().length === 5 && theirs.events().length === 5);

  // exchange
  const toThem = mine.missingFor(new Set(theirs.events().map(e => e.id)));
  const toMe = theirs.missingFor(new Set(mine.events().map(e => e.id)));
  theirs.merge(toThem);
  mine.merge(toMe);

  check("both have everything", mine.events().length === 10 && theirs.events().length === 10,
    `${mine.events().length} / ${theirs.events().length}`);
  check("identical order on both peers",
    mine.events().map(e=>e.id).join() === theirs.events().map(e=>e.id).join());

  // idempotent
  mine.merge(toMe);
  check("re-merge is a no-op", mine.events().length === 10);

  // forged event rejected
  const forged = { ...mine.events()[0], payload: { from: "ray", i: 999 } };
  const r = mine.merge([forged as any]);
  check("forged event rejected", r.accepted.length === 0);

  // continues cleanly after merge
  mine.append("message.send", { from: "ray", after: true });
  check("appends after merge", mine.events().length === 11);
  check("new event descends from both branches",
    mine.events().at(-1)!.clock > 5);

  mine.close(); theirs.close();
}

// --- forgetting must not undo itself ---------------------------------------
//
// The watermark a log reports is derived from the numbers it holds, so
// dropping an event punches a hole and drags the watermark back below it. A
// peer that still has the event would then be told we lack it and send it
// again — and the compaction that was supposed to free space becomes a loop
// that re-downloads what it just deleted.
{
  const root3 = mkdtempSync(join(tmpdir(), "store3-"));
  const s = new CommunityStore({ root: root3, community: "keep", identity: ray });
  s.open();

  // Something worth keeping, then a great deal that is not: every profile but
  // the last is superseded, which is what compaction exists to remove.
  const wanted = s.append("message.send", { content: "the only real message" });
  for (let i = 0; i < 40; i++) s.append("profile.update", { username: "v" + i });

  const before = s.summary();
  const removed = s.compact();

  check("compaction happened", !!removed && removed.removed > 30,
    JSON.stringify(removed));

  const after = s.summary();

  check("the watermark did not move backwards",
    after.vector[ray.userId] >= before.vector[ray.userId],
    `${before.vector[ray.userId]} -> ${after.vector[ray.userId]}`);

  // Which is the property that matters, stated the way a peer would ask it: a
  // peer holding the whole log is told there is nothing to send.
  check("a peer that still holds the dropped events is offered nothing",
    s.missingForSummary(before).length === 0,
    String(s.missingForSummary(before).length));

  check("the message that mattered is still here",
    s.events().some((e) => e.id === wanted.id));

  // And the next event must not reuse a number that has been spent. Two events
  // claiming the same place in one author's chain means a peer learns about
  // exactly one of them, forever.
  const used = new Set(s.events().map((e) => (e as { seq?: number }).seq));
  const next = s.append("message.send", { content: "after" });
  check("the next event does not reuse a spent number",
    !used.has((next as { seq?: number }).seq) &&
    (next as { seq?: number }).seq! > before.vector[ray.userId],
    String((next as { seq?: number }).seq));

  s.close();

  // All of which has to survive a restart, or the first sync after reopening
  // undoes the compaction.
  const again = new CommunityStore({ root: root3, community: "keep", identity: ray });
  again.open();

  check("the watermark survives a restart",
    again.summary().vector[ray.userId] >= after.vector[ray.userId],
    JSON.stringify(again.summary().vector));
  check("and the dropped events are still not offered back",
    again.missingForSummary(before).length <= 1,
    String(again.missingForSummary(before).length));

  again.close();
  rmSync(root3, { recursive: true, force: true });
}

// --- the shortcuts append takes ---------------------------------------------
//
// Appending no longer re-sorts the log, recomputes the heads, or rescans for
// the next sequence number. All three are safe only because of properties that
// are easy to state and easy to break later, so they are checked rather than
// asserted in a comment.
{
  const root4 = mkdtempSync(join(tmpdir(), "store4-"));
  const s = new CommunityStore({ root: root4, community: "fast", identity: ray });
  s.open();

  for (let i = 0; i < 30; i++) s.append("message.send", { content: `m${i}` });

  // A merge from a peer, then more local writes on top of it.
  const other = new CommunityStore({ root: root4, community: "fast2", identity: friend });
  other.open();
  for (let i = 0; i < 10; i++) other.append("message.send", { content: `f${i}` });
  s.merge([...other.events()]);
  other.close();

  for (let i = 0; i < 10; i++) s.append("message.send", { content: `after${i}` });

  const order = s.events().map((e) => e.id);
  check("appending leaves the log in causal order",
    causalSort([...s.events()]).map((e) => e.id).join(",") === order.join(","));

  check("the cached heads match a full recomputation",
    s.heads().map((e) => e.id).sort().join(",") ===
      findHeads([...s.events()]).map((e) => e.id).sort().join(","),
    s.heads().length + " heads");

  const numbers = s.events()
    .filter((e) => e.author === ray.userId)
    .map((e) => (e as { seq?: number }).seq);

  check("every number this device spent is distinct",
    new Set(numbers).size === numbers.length,
    numbers.join(","));
  check("...and there are no gaps in them",
    numbers.slice().sort((a, b) => (a ?? 0) - (b ?? 0))
      .every((n, i) => n === i + 1),
    numbers.join(","));

  // A merge that accepts nothing must not disturb anything.
  const before = s.events().map((e) => e.id).join(",");
  const again = s.merge([...s.events()]);
  check("re-merging what is already held accepts nothing",
    again.accepted.length === 0 && again.rejected.length === 0);
  check("...and does not reorder the log",
    s.events().map((e) => e.id).join(",") === before);

  const next = s.append("message.send", { content: "still fine" });
  check("and appending after it still works",
    s.events()[s.events().length - 1].id === next.id);

  s.close();
  rmSync(root4, { recursive: true, force: true });
}

rmSync(root, { recursive: true, force: true });
rmSync(root2, { recursive: true, force: true });
console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
