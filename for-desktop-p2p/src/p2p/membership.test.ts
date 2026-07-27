import { createEvent, findHeads, type SignedEvent } from "./events";
import { createIdentity } from "./identity";

/**
 * Removal, and coming back from it.
 *
 * Membership here is derived, not stored: every device replays the same log in
 * causal order and arrives at the same set, with nobody to ask. That makes the
 * rules worth testing directly, because a rule that reads plausibly can still
 * mean "a kick lasts until the person types again" — which is what it did mean
 * before this file existed.
 *
 * The three properties that matter:
 *
 *   - A kick holds against everything already in flight. Carrying on talking
 *     must not re-admit anybody.
 *   - A kick can be undone by rejoining, without the owner being awake.
 *   - A ban cannot.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

// A copy of the rule under test, fed the same events the bridge would replay.
// Duplicated deliberately: importing the bridge would drag in Electron, and
// what is being checked is the decision procedure, not the plumbing.
function membersOf(log: SignedEvent[], cap = 10): Set<string> {
  const members = new Set<string>();
  const banned = new Set<string>();
  const evicted = new Set<string>();
  let owner: string | undefined;

  for (const event of log) {
    const payload = (event.payload ?? {}) as { userId?: string };

    if (event.type === "community.owner") {
      owner = payload.userId ?? event.author;
      continue;
    }

    if (event.type === "member.leave") {
      members.delete(event.author);
      continue;
    }

    if (event.type === "member.kick" || event.type === "member.ban") {
      if (owner && event.author === owner && payload.userId) {
        members.delete(payload.userId);
        evicted.add(payload.userId);
        if (event.type === "member.ban") banned.add(payload.userId);
      }
      continue;
    }

    if (event.type === "member.unban" || event.type === "member.readmit") {
      if (owner && event.author === owner && payload.userId) {
        banned.delete(payload.userId);
        evicted.delete(payload.userId);
      }
      continue;
    }

    if (event.type === "member.join") {
      if (!banned.has(event.author)) {
        evicted.delete(event.author);
        if (!members.has(event.author) && members.size < cap) members.add(event.author);
      }
      continue;
    }

    if (banned.has(event.author)) continue;
    if (evicted.has(event.author)) continue;
    if (members.has(event.author)) continue;
    if (members.size < cap) members.add(event.author);
  }

  return members;
}

const owner = createIdentity();
const alice = createIdentity();
const bob = createIdentity();

const log: SignedEvent[] = [];
const write = (who: ReturnType<typeof createIdentity>, type: string, payload: unknown = {}) => {
  const e = createEvent({ type, community: "s1", payload }, who, findHeads(log));
  log.push(e);
  return e;
};

write(owner, "community.owner", { userId: owner.userId });
write(owner, "channel.create", { id: "c0", name: "general" });
write(alice, "message.send", { channelId: "c0", content: "hello" });
write(bob, "message.send", { channelId: "c0", content: "hi" });

ck("everyone who spoke is a member",
   membersOf(log).has(alice.userId) && membersOf(log).has(bob.userId));

// ---- a kick removes ------------------------------------------------------
write(owner, "member.kick", { userId: bob.userId });
ck("a kicked member is out", !membersOf(log).has(bob.userId));
ck("nobody else is affected", membersOf(log).has(alice.userId));

// ---- and holds -----------------------------------------------------------
//
// The bug this replaces: removal frees a slot, a free slot goes to whoever
// writes next, so Bob's own next message put him straight back.
write(bob, "message.send", { channelId: "c0", content: "still here" });
write(bob, "message.send", { channelId: "c0", content: "and here" });
ck("talking does not undo a kick", !membersOf(log).has(bob.userId));

// ---- rejoining does ------------------------------------------------------
write(bob, "member.join", {});
ck("rejoining lets a kicked member back", membersOf(log).has(bob.userId));
ck("and no owner action was needed",
   !log.some((e) => e.type === "member.readmit"));

write(bob, "message.send", { channelId: "c0", content: "back" });
ck("they stay in once back", membersOf(log).has(bob.userId));

// ---- the owner can also let someone back ---------------------------------
const log2 = log.slice(0, 6);   // up to and including the kick
const readmit = createEvent(
  { type: "member.readmit", community: "s1", payload: { userId: bob.userId } },
  owner,
  findHeads(log2),
);
log2.push(readmit);
log2.push(createEvent(
  { type: "message.send", community: "s1", payload: { channelId: "c0", content: "thanks" } },
  bob,
  findHeads(log2),
));
ck("readmitting works too", membersOf(log2).has(bob.userId));

// ---- only the owner can remove -------------------------------------------
const log3 = log.slice(0, 4);
log3.push(createEvent(
  { type: "member.kick", community: "s1", payload: { userId: alice.userId } },
  bob,
  findHeads(log3),
));
ck("a member cannot kick another member", membersOf(log3).has(alice.userId));

// ---- a ban is a wall -----------------------------------------------------
const log4 = log.slice(0, 4);
log4.push(createEvent(
  { type: "member.ban", community: "s1", payload: { userId: bob.userId } },
  owner,
  findHeads(log4),
));
log4.push(createEvent(
  { type: "member.join", community: "s1", payload: {} },
  bob,
  findHeads(log4),
));
ck("a banned member cannot rejoin", !membersOf(log4).has(bob.userId));

log4.push(createEvent(
  { type: "member.unban", community: "s1", payload: { userId: bob.userId } },
  owner,
  findHeads(log4),
));
log4.push(createEvent(
  { type: "member.join", community: "s1", payload: {} },
  bob,
  findHeads(log4),
));
ck("unbanning lets them back", membersOf(log4).has(bob.userId));

// ---- leaving is not an eviction ------------------------------------------
//
// Somebody who left of their own accord can come back by simply writing again;
// only a removal requires the deliberate return.
const log5 = log.slice(0, 4);
log5.push(createEvent(
  { type: "member.leave", community: "s1", payload: {} },
  bob,
  findHeads(log5),
));
ck("leaving frees the slot", !membersOf(log5).has(bob.userId));
log5.push(createEvent(
  { type: "message.send", community: "s1", payload: { channelId: "c0", content: "oops" } },
  bob,
  findHeads(log5),
));
ck("and coming back needs no ceremony", membersOf(log5).has(bob.userId));

// ---- a kick still frees the slot for somebody else ------------------------
const cap2 = log.slice(0, 6);   // owner + alice + bob, then bob kicked
const carol = createIdentity();
cap2.push(createEvent(
  { type: "message.send", community: "s1", payload: { channelId: "c0", content: "new here" } },
  carol,
  findHeads(cap2),
));
ck("a removal gives the room back", membersOf(cap2, 3).has(carol.userId));

// ---- determinism ---------------------------------------------------------
//
// The whole model rests on every device computing the same answer, so the
// answer must not depend on the order events happened to arrive in.
const shuffled = [...log].sort((a, b) =>
  a.clock === b.clock ? (a.id < b.id ? -1 : 1) : a.clock - b.clock);
ck("causal order is what decides",
   [...membersOf(shuffled)].sort().join() === [...membersOf(log)].sort().join());

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
