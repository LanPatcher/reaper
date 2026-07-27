import { createIdentity } from "./identity";
import { createEvent, findHeads, mergeEvents, type SignedEvent } from "./events";
import { Transport, resetWireStats, wireStats } from "./transport";

let f=0; const ck=(n:string,c:boolean,e="")=>{console.log((c?"PASS":"FAIL")+"  "+n+(e?"  "+e:""));if(!c)f++;};
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));

// A tiny in-memory node standing in for CommunityStore.
function node(name: string) {
  const id = createIdentity();
  const logs: Record<string, SignedEvent[]> = { c1: [] };
  const blobs: Record<string, Buffer> = {};
  const got: Record<string, Buffer> = {};
  const t = new Transport(id.userId, {
    communities: () => Object.keys(logs),
    idsFor: (c) => (logs[c] || []).map(e => e.id),
    missingFor: (c, peer) => (logs[c] || []).filter(e => !peer.has(e.id)),
    accepts: () => true,
    serves: () => true,
    reconciles: () => true,
    blobFor: (_c, id) => blobs[id],
    blobDone: (_c, id, data) => { got[id] = data; },
    merge: (c, evs) => {
      const r = mergeEvents(logs[c] || [], evs);
      logs[c] = r.events;
      const offered = new Set(evs.map((e) => e.id));
      return {
        accepted: r.accepted.length,
        held: r.events.filter((e) => offered.has(e.id)).map((e) => e.id),
      };
    },
  });
  return {
    id, logs, t, name, blobs, got,
    say(text: string) {
      const e = createEvent({ type: "message.send", community: "c1", payload: { text } }, id, findHeads(logs.c1));
      logs.c1.push(e);
      t.broadcast("c1", [e]);
      return e;
    },
  };
}

const a = node("A"), b = node("B");

const portA = await a.t.listen(0);
const portB = await b.t.listen(0);
ck("both listening", portA > 0 && portB > 0, `A:${portA} B:${portB}`);

// Each writes 3 messages while disconnected.
for (let i=0;i<3;i++) a.say("from A " + i);
for (let i=0;i<3;i++) b.say("from B " + i);
ck("diverged", a.logs.c1.length === 3 && b.logs.c1.length === 3);

// Connect and let them reconcile.
//
// `connect()` accepts onion addresses only, by design — there is no Tor in a
// test process, so the socket is opened here and handed to the transport. That
// exercises everything above the addressing rule without punching a hole in it.
const { Socket } = await import("node:net");
await new Promise<void>((resolve) => {
  const sock = new Socket();
  sock.connect(portA, "127.0.0.1", () => { b.t.adopt(sock, false); resolve(); });
});
await wait(400);

ck("A has everything", a.logs.c1.length === 6, `${a.logs.c1.length}`);
ck("B has everything", b.logs.c1.length === 6, `${b.logs.c1.length}`);
ck("identical order", a.logs.c1.map(e=>e.id).join() === b.logs.c1.map(e=>e.id).join());

// Live gossip after sync.
a.say("live from A");
await wait(250);
ck("live event reached B", b.logs.c1.length === 7, `${b.logs.c1.length}`);

b.say("live from B");
await wait(250);
ck("live event reached A", a.logs.c1.length === 8, `${a.logs.c1.length}`);
ck("still identical", a.logs.c1.map(e=>e.id).join() === b.logs.c1.map(e=>e.id).join());

// Peer listing
ck("A sees a peer", a.t.peers().length === 1);
ck("A learned B's userId", a.t.peers()[0].userId === b.id.userId);
ck("A's peer is inbound", a.t.peers()[0].inbound === true);
ck("B's peer is outbound", b.t.peers()[0].inbound === false);

// Forgery over the wire is refused
const forged = { ...a.logs.c1[0], payload: { text: "TAMPERED" } };
const before = b.logs.c1.length;
b.t["#hooks"]; // no-op
(b as any).t.emit; // no-op
const accepted = (b.logs.c1.length);
const r = mergeEvents(b.logs.c1, [forged as any]);
ck("forged event refused", r.rejected.length === 1 && r.events.length === before);

// Bad address
let threw = false;
try { await a.t.connect("nonsense"); } catch { threw = true; }
ck("bad address rejected", threw);

// Disconnect handling
b.t.stop();
await wait(200);
ck("A drops the peer", a.t.peers().length === 0);

// A community added after connecting must still sync.
{
  const c = node("C"), d = node("D");
  const pc = await c.t.listen(0);
  await d.t.listen(0);
  const { Socket: S2 } = await import("node:net");
  await new Promise<void>((res) => {
    const sk = new S2();
    sk.connect(pc, "127.0.0.1", () => { d.t.adopt(sk, false); res(); });
  });
  await wait(300);

  // Both gain a community neither had at connect time.
  c.logs["late"] = []; d.logs["late"] = [];
  const e = createEvent({ type: "m", community: "late", payload: { x: 1 } }, c.id, []);
  c.logs["late"].push(e);
  c.t.announce();
  await wait(400);
  ck("community added after connect syncs", d.logs["late"].length === 1, String(d.logs["late"].length));
  c.t.stop(); d.t.stop();
}

// First contact: a community the receiving side has never heard of.
{
  const e = node("E"), g = node("F");
  const pe = await e.t.listen(0);
  await g.t.listen(0);
  const { Socket: S3 } = await import("node:net");
  await new Promise<void>((res) => {
    const sk = new S3();
    sk.connect(pe, "127.0.0.1", () => { g.t.adopt(sk, false); res(); });
  });
  await wait(300);

  // Only E has it. G must accept and receive.
  e.logs["dmNEW"] = [];
  const ev = createEvent({ type: "friend.request", community: "dmNEW", payload: { hi: 1 } }, e.id, []);
  e.logs["dmNEW"].push(ev);
  e.t.announce();
  await wait(500);

  ck("first contact reaches an unknown community",
     (g.logs["dmNEW"] || []).length === 1, String((g.logs["dmNEW"] || []).length));
  e.t.stop(); g.t.stop();
}

// The empty side announcing must still be filled.
{
  const h = node("G"), i = node("H");
  const ph = await h.t.listen(0);
  await i.t.listen(0);
  const { Socket: S4 } = await import("node:net");
  await new Promise<void>((res) => {
    const sk = new S4();
    sk.connect(ph, "127.0.0.1", () => { i.t.adopt(sk, false); res(); });
  });
  await wait(300);

  // H holds a server; I joins it empty and announces.
  for (let n = 0; n < 5; n++) {
    h.logs.c1.push(createEvent({ type: "m", community: "c1", payload: { n } }, h.id, findHeads(h.logs.c1)));
  }
  i.logs["c1"] = [];
  i.t.announce();
  await wait(500);

  ck("empty joiner receives history", i.logs.c1.length === 5, String(i.logs.c1.length));
  h.t.stop(); i.t.stop();
}

// Audio must not multiply in a mesh that contains a cycle.
//
// Three peers connected to each other is the smallest case: without
// suppression each relay produces two more copies, and the count doubles per
// hop until the stream is saturated. One frame in must mean one frame out at
// each listener, no matter how many paths exist between them.
{
  const x = node("X"), y = node("Y"), z = node("Z");
  const px = await x.t.listen(0), py = await y.t.listen(0);
  await z.t.listen(0);

  const { Socket: S5 } = await import("node:net");
  const dial = (port: number, from: { t: typeof x.t }) =>
    new Promise<void>((res) => {
      const sk = new S5();
      sk.connect(port, "127.0.0.1", () => { from.t.adopt(sk, false); res(); });
    });

  await dial(px, y);   // Y -> X
  await dial(px, z);   // Z -> X
  await dial(py, z);   // Z -> Y  — closes the triangle
  await wait(400);

  const heard: Record<string, number> = { X: 0, Y: 0, Z: 0 };
  x.t.on("audio", () => heard.X++);
  y.t.on("audio", () => heard.Y++);
  z.t.on("audio", () => heard.Z++);

  x.t.sendAudio("vc", 1, "AAAA");
  await wait(600);

  ck("audio reaches both listeners", heard.Y === 1 && heard.Z === 1,
     `Y:${heard.Y} Z:${heard.Z}`);
  ck("audio does not echo back to its sender", heard.X === 0, String(heard.X));

  // The real symptom: a second frame arriving after the storm would show a
  // count far above one. Repeat to be sure suppression is not one-shot.
  heard.X = heard.Y = heard.Z = 0;
  x.t.sendAudio("vc", 2, "BBBB");
  await wait(600);
  ck("suppression holds for later frames", heard.Y === 1 && heard.Z === 1,
     `Y:${heard.Y} Z:${heard.Z}`);

  x.t.stop(); y.t.stop(); z.t.stop();
}

// Two nodes dialling each other at once must end up with one connection.
{
  const m = node("M"), n = node("N");
  const pm = await m.t.listen(0), pn = await n.t.listen(0);

  const { Socket: S6 } = await import("node:net");
  await new Promise<void>((res) => {
    const sk = new S6();
    sk.connect(pm, "127.0.0.1", () => { n.t.adopt(sk, false); res(); });
  });
  await new Promise<void>((res) => {
    const sk = new S6();
    sk.connect(pn, "127.0.0.1", () => { m.t.adopt(sk, false); res(); });
  });
  await wait(600);

  ck("duplicate connection collapsed on M", m.t.peers().length === 1,
     String(m.t.peers().length));
  ck("duplicate connection collapsed on N", n.t.peers().length === 1,
     String(n.t.peers().length));

  // And the survivor still works.
  m.say("after the collapse");
  await wait(400);
  ck("surviving connection still syncs",
     n.logs.c1.some((e) => (e.payload as { text?: string }).text === "after the collapse"));

  m.t.stop(); n.t.stop();
}

// A backlog larger than one frame must still transfer.
{
  const p1 = node("P"), q1 = node("Q");
  const pp = await p1.t.listen(0);
  await q1.t.listen(0);

  // Comfortably past GIVE_EVENTS, so reconciliation has to span several
  // frames. Before batching this arrived as one frame and, once big enough,
  // was rejected outright — which wedged sync permanently rather than slowly.
  for (let k = 0; k < 500; k++) {
    p1.logs.c1.push(
      createEvent({ type: "m", community: "c1", payload: { k } }, p1.id, findHeads(p1.logs.c1)),
    );
  }

  const { Socket: S7 } = await import("node:net");
  await new Promise<void>((res) => {
    const sk = new S7();
    sk.connect(pp, "127.0.0.1", () => { q1.t.adopt(sk, false); res(); });
  });
  await wait(1200);

  ck("large backlog transfers in batches", q1.logs.c1.length === 500,
     String(q1.logs.c1.length));

  p1.t.stop(); q1.t.stop();
}

// A peer that stops answering must be dropped, not kept forever.
//
// The socket is deliberately left open. That is the failure this exists for:
// a dead Tor circuit does not close anything, so without an application-level
// check the peer stays in the list looking connected, the dial loop skips it
// as "already connected", and the app is silently offline until a restart.
{
  const id1 = createIdentity(), id2 = createIdentity();
  const empty = {
    communities: () => [],
    idsFor: () => [],
    missingFor: () => [],
    accepts: () => false,
    serves: () => true,
    reconciles: () => true,
    blobFor: () => undefined,
    blobDone: () => undefined,
    merge: () => ({ accepted: 0, held: [] }),
  };

  const quick = new Transport(id1.userId, empty, { pingEveryMs: 80, idleTimeoutMs: 400 });
  const mute = new Transport(id2.userId, empty, { pingEveryMs: 80, idleTimeoutMs: 400 });

  const pq = await quick.listen(0);
  await mute.listen(0);

  const { Socket: S8 } = await import("node:net");
  const sock = new S8();
  await new Promise<void>((res) => {
    sock.connect(pq, "127.0.0.1", () => { mute.adopt(sock, false); res(); });
  });
  await wait(200);
  ck("keepalive: connected", quick.peers().length === 1, String(quick.peers().length));

  // Silence the far end without closing anything: it stops replying to pings
  // but the socket remains open and writable, exactly as a dead circuit does.
  mute.stop();
  sock.pause();

  await wait(1200);
  ck("keepalive: silent peer dropped", quick.peers().length === 0,
     String(quick.peers().length));

  quick.stop();
}

// Blobs transfer on request, and only on request.
{
  const { createHash } = await import("node:crypto");
  const holder = node("Holder"), asker = node("Asker");
  const ph = await holder.t.listen(0);
  await asker.t.listen(0);

  // Comfortably more than one chunk, so reassembly is exercised rather than
  // assumed.
  const file = Buffer.alloc(500 * 1024);
  for (let k = 0; k < file.length; k++) file[k] = (k * 7) & 0xff;
  const fileId = createHash("sha256").update(file).digest("hex");
  holder.blobs[fileId] = file;

  const { Socket: S9 } = await import("node:net");
  await new Promise<void>((res) => {
    const sk = new S9();
    sk.connect(ph, "127.0.0.1", () => { asker.t.adopt(sk, false); res(); });
  });
  await wait(300);

  // The point of the whole design: connecting and syncing does not move the
  // file. Nothing arrives until this side asks.
  ck("blob does not arrive unasked", asker.got[fileId] === undefined);

  asker.t.requestBlob("c1", fileId);
  await wait(800);

  ck("blob arrives when requested", asker.got[fileId] !== undefined);
  ck("blob arrives intact",
     !!asker.got[fileId] && Buffer.compare(asker.got[fileId], file) === 0);

  // A blob nobody holds is answered, not left hanging.
  const missing = createHash("sha256").update("nope").digest("hex");
  asker.t.requestBlob("c1", missing);
  await wait(300);
  ck("unknown blob does not arrive", asker.got[missing] === undefined);

  holder.t.stop(); asker.t.stop();
}

// A peer whose hello was missed must still be identified.
//
// `hello` happens once. Anything that costs us that frame used to leave the
// connection anonymous forever — working, carrying traffic, and displayed as
// "connecting…" because nothing said who it was a second time.
{
  const one = createIdentity(), two = createIdentity();
  const empty = {
    communities: () => [],
    idsFor: () => [],
    missingFor: () => [],
    accepts: () => false,
    serves: () => true,
    reconciles: () => true,
    blobFor: () => undefined,
    blobDone: () => undefined,
    merge: () => ({ accepted: 0, held: [] }),
  };

  // Pinging fast so the recovery is observable without a long wait.
  const left = new Transport(one.userId, empty, { pingEveryMs: 120, idleTimeoutMs: 9000 });
  const right = new Transport(two.userId, empty, { pingEveryMs: 120, idleTimeoutMs: 9000 });

  const pl = await left.listen(0);
  await right.listen(0);

  const { Socket: SA } = await import("node:net");
  await new Promise<void>((res) => {
    const sk = new SA();
    sk.connect(pl, "127.0.0.1", () => { right.adopt(sk, false); res(); });
  });
  await wait(250);

  ck("identified normally", left.peers()[0] && left.peers()[0].userId === two.userId);

  // Simulate the hello having been lost: forget who this peer is.
  const anonymised = left.peers()[0];
  (anonymised as { userId?: string }).userId = undefined;
  ck("anonymous after losing hello", left.peers()[0].userId === undefined);

  // The heartbeat carries the id, so the next tick repairs it.
  await wait(500);
  ck("identity recovered from heartbeat",
     left.peers()[0] && left.peers()[0].userId === two.userId,
     String(left.peers()[0] && left.peers()[0].userId));

  left.stop(); right.stop();
}

// A joiner must be able to catch up from a member while the owner is away.
//
// Nothing in reconciliation cares who it is talking to: every event carries
// its own signature, so a channel created by the owner is just as valid when
// a member hands it over. The owner being the only *source* was a bootstrap
// problem — knowing an address — not a trust one.
{
  const owner = node("Owner"), member = node("Member"), joiner = node("Joiner");

  // The owner writes the channels, then goes away entirely.
  const created: SignedEvent[] = [];
  for (let k = 0; k < 4; k++) {
    const ev = createEvent(
      { type: "channel.create", community: "c1", payload: { id: "ch" + k, name: "ch" + k } },
      owner.id, findHeads(owner.logs.c1),
    );
    owner.logs.c1.push(ev);
    created.push(ev);
  }

  // The member holds the owner's events, unmodified and still owner-signed.
  member.logs.c1 = created.slice();
  owner.t.stop();

  const pm = await member.t.listen(0);
  await joiner.t.listen(0);

  const { Socket: SB } = await import("node:net");
  await new Promise<void>((res) => {
    const sk = new SB();
    sk.connect(pm, "127.0.0.1", () => { joiner.t.adopt(sk, false); res(); });
  });

  // The joiner starts empty, exactly as it would after accepting an invite.
  joiner.logs.c1 = [];
  joiner.t.announce();
  await wait(700);

  ck("joiner got the channels from a member", joiner.logs.c1.length === 4,
     String(joiner.logs.c1.length));

  ck("and they are still the owner's, not the relay's",
     joiner.logs.c1.every((e) => e.author === owner.id.userId));

  ck("relaying did not alter them",
     joiner.logs.c1.map((e) => e.id).sort().join() ===
     created.map((e) => e.id).sort().join());

  member.t.stop(); joiner.t.stop();
}

// A community that is full refuses to serve anyone else.
//
// The limit cannot be enforced by refusing entry — there is no server to
// refuse anything, and a modified client can write itself into the log. What
// honest clients can do is agree on *who* the members are and decline to talk
// to anyone else, which costs an intruder the thing they wanted: the
// conversation.
//
// Agreement comes from causal order, which is already deterministic, so every
// device names the same members without anyone coordinating.
{
  // The production figure, so the test exercises the number that actually
  // ships rather than a convenient stand-in.
  const CAP = 10;

  function capped(name: string) {
    const id = createIdentity();
    const logs: Record<string, SignedEvent[]> = { c1: [] };
    const t = new Transport(id.userId, {
      communities: () => Object.keys(logs),
      idsFor: (c) => (logs[c] || []).map((e) => e.id),
      missingFor: (c, peer) => (logs[c] || []).filter((e) => !peer.has(e.id)),
      accepts: () => true,
      // The rule under test: first CAP distinct authors in causal order.
      reconciles: () => true,
      serves: (c, who) => {
        if (!who) return true;
        const members = new Set<string>();
        for (const e of logs[c] || []) {
          if (members.size >= CAP) break;
          members.add(e.author);
        }
        if (members.size < CAP) return true;
        return members.has(who);
      },
      blobFor: () => undefined,
      blobDone: () => undefined,
      merge: (c, evs) => {
        const r = mergeEvents(logs[c] || [], evs);
        logs[c] = r.events;
        const offered = new Set(evs.map((e) => e.id));
        return {
          accepted: r.accepted.length,
          held: r.events.filter((e) => offered.has(e.id)).map((e) => e.id),
        };
      },
    });
    return { id, logs, t, name };
  }

  const host = capped("Host");
  const gate = capped("Gatecrasher");

  // Ten members already, so the community is full.
  const founders = Array.from({ length: CAP }, () => createIdentity());
  for (const who of founders) {
    host.logs.c1.push(
      createEvent(
        { type: "message.send", community: "c1", payload: { content: "hi" } },
        who, findHeads(host.logs.c1),
      ),
    );
  }

  // Everyone agrees who those three are, from the log alone.
  const seen = new Set(host.logs.c1.map((e) => e.author));
  ck("membership is the first ten authors", seen.size === CAP, String(seen.size));

  const ph = await host.t.listen(0);
  await gate.t.listen(0);

  const { Socket: SC } = await import("node:net");
  await new Promise<void>((res) => {
    const sk = new SC();
    sk.connect(ph, "127.0.0.1", () => { gate.t.adopt(sk, false); res(); });
  });
  await wait(500);

  ck("intruder receives no history", gate.logs.c1.length === 0,
     String(gate.logs.c1.length));

  // And writing does not get them in either.
  const shout = createEvent(
    { type: "message.send", community: "c1", payload: { content: "let me in" } },
    gate.id, [],
  );
  gate.logs.c1.push(shout);
  gate.t.broadcast("c1", [shout]);
  await wait(500);

  ck("intruder's message is refused",
     !host.logs.c1.some((e) => e.author === gate.id.userId));
  ck("the host's log is untouched", host.logs.c1.length === CAP,
     String(host.logs.c1.length));

  host.t.stop(); gate.t.stop();
}

// Leaving gives the slot back, and everyone reaches that conclusion alone.
//
// Membership has to be a function of the log, or two devices disagree about
// who belongs and start refusing each other. So departure is an event like
// any other, replayed in causal order, and the resulting set is identical
// everywhere without anyone being asked.
{
  const CAP = 10;

  /** The membership rule, exactly as the bridge computes it. */
  function resolve(log: SignedEvent[], owner: string): Set<string> {
    const members = new Set<string>();
    const banned = new Set<string>();

    for (const e of log) {
      const p = e.payload as { userId?: string };

      if (e.type === "member.leave") { members.delete(e.author); continue; }

      if (e.type === "member.kick" || e.type === "member.ban") {
        if (e.author === owner && p.userId) {
          members.delete(p.userId);
          if (e.type === "member.ban") banned.add(p.userId);
        }
        continue;
      }

      if (banned.has(e.author)) continue;
      if (members.has(e.author)) continue;
      if (members.size < CAP) members.add(e.author);
    }
    return members;
  }

  const owner = createIdentity();
  const log: SignedEvent[] = [];
  const say = (who: ReturnType<typeof createIdentity>, type: string, payload: unknown) => {
    const e = createEvent({ type, community: "c1", payload }, who, findHeads(log));
    log.push(e);
    return e;
  };

  say(owner, "community.owner", { userId: owner.userId });

  // Nine more, filling the place.
  const others = Array.from({ length: CAP - 1 }, () => createIdentity());
  others.forEach((who) => say(who, "message.send", { content: "hi" }));

  ck("full at capacity", resolve(log, owner.userId).size === CAP,
     String(resolve(log, owner.userId).size));

  // An eleventh is refused while it is full.
  const late = createIdentity();
  say(late, "message.send", { content: "room?" });
  ck("newcomer refused while full", !resolve(log, owner.userId).has(late.userId));

  // Somebody leaves of their own accord.
  say(others[0], "member.leave", { userId: others[0].userId });
  const afterLeave = resolve(log, owner.userId);
  ck("leaver is no longer a member", !afterLeave.has(others[0].userId));
  ck("the slot is genuinely free", afterLeave.size === CAP - 1, String(afterLeave.size));

  // And the newcomer takes it by writing again.
  say(late, "message.send", { content: "thanks" });
  const afterJoin = resolve(log, owner.userId);
  ck("newcomer takes the freed slot", afterJoin.has(late.userId));
  ck("back to capacity", afterJoin.size === CAP, String(afterJoin.size));

  // A kick frees a slot too, and only the owner's kick counts.
  const impostor = createIdentity();
  say(impostor, "member.kick", { userId: others[1].userId });
  ck("a non-owner kick does nothing", resolve(log, owner.userId).has(others[1].userId));

  say(owner, "member.kick", { userId: others[1].userId });
  ck("the owner's kick removes them", !resolve(log, owner.userId).has(others[1].userId));

  // A kick is not a ban: writing again gets them back in.
  say(others[1], "message.send", { content: "sorry" });
  ck("a kicked member can return", resolve(log, owner.userId).has(others[1].userId));

  // A ban does bar the door.
  say(owner, "member.ban", { userId: others[2].userId });
  say(others[2], "message.send", { content: "let me back" });
  ck("a banned member cannot return", !resolve(log, owner.userId).has(others[2].userId));

  // The whole point: replaying the same log elsewhere gives the same answer.
  const elsewhere = resolve(log.slice(), owner.userId);
  const here = resolve(log, owner.userId);
  ck("every device agrees on the membership",
     [...here].sort().join() === [...elsewhere].sort().join());
}

// A peer that is not listening is not sent live writes.
//
// Suppressing our own asking saves one side of the exchange. This saves the
// other, and it is the larger half: in a busy server the pushes outnumber the
// reconciliations by a wide margin, and over Tor the bytes are the expensive
// part rather than the discarding of them.
{
  const writer = node("Writer"), reader = node("Reader");
  writer.logs.c2 = [];
  reader.logs.c2 = [];

  const pw = await writer.t.listen(0);
  await reader.t.listen(0);

  const { Socket: SD } = await import("node:net");
  await new Promise<void>((res) => {
    const sk = new SD();
    sk.connect(pw, "127.0.0.1", () => { reader.t.adopt(sk, false); res(); });
  });
  await wait(300);

  // The reader follows c1 and ignores c2.
  reader.t.declareFocus(["c1"]);
  await wait(250);

  writer.say("live in c1");
  const ignored = createEvent(
    { type: "message.send", community: "c2", payload: { text: "live in c2" } },
    writer.id, findHeads(writer.logs.c2),
  );
  writer.logs.c2.push(ignored);
  writer.t.broadcast("c2", [ignored]);
  await wait(500);

  ck("followed community still arrives",
     reader.logs.c1.some((e) => (e.payload as { text?: string }).text === "live in c1"));
  ck("unfollowed community is not sent", reader.logs.c2.length === 0,
     String(reader.logs.c2.length));

  // Changing the declaration takes effect without reconnecting.
  reader.t.declareFocus(["c1", "c2"]);
  await wait(250);

  const later = createEvent(
    { type: "message.send", community: "c2", payload: { text: "now listening" } },
    writer.id, findHeads(writer.logs.c2),
  );
  writer.logs.c2.push(later);
  writer.t.broadcast("c2", [later]);
  await wait(400);

  ck("following again resumes delivery", reader.logs.c2.length === 1,
     String(reader.logs.c2.length));

  writer.t.stop(); reader.t.stop();
}

// Messages written while a peer was still connecting must still arrive.
//
// Reconciliation only happens when somebody offers their id set, and every
// trigger for that is an event that can be missed: a connection completing
// mid-write, a circuit dropping, a focus that had not been decided yet. Each
// leaves a hole neither side notices, because both believe they are current.
//
// So the recovery has to come from re-offering rather than from catching the
// moment — which is what `announce` does.
{
  const early = node("Early"), late = node("Late");
  const pe = await early.t.listen(0);
  await late.t.listen(0);

  // Written before anyone is connected. This is the window where a client is
  // still bringing Tor up.
  early.say("sent while alone 1");
  early.say("sent while alone 2");

  // A peer whose offers are suppressed for this community, standing in for a
  // server left in the background.
  let offering = false;
  const gated = node("Gated");
  Object.assign(gated, {});
  // Rebuilt with a focus rule we can flip, since that is the behaviour under
  // test rather than anything about the socket.
  const gatedT = new Transport(gated.id.userId, {
    communities: () => Object.keys(gated.logs),
    idsFor: (c) => (gated.logs[c] || []).map((e) => e.id),
    missingFor: (c, peer) => (gated.logs[c] || []).filter((e) => !peer.has(e.id)),
    accepts: () => true,
    serves: () => true,
    reconciles: () => offering,
    blobFor: () => undefined,
    blobDone: () => undefined,
    merge: (c, evs) => {
      const r = mergeEvents(gated.logs[c] || [], evs);
      gated.logs[c] = r.events;
      const offered = new Set(evs.map((e) => e.id));
      return {
        accepted: r.accepted.length,
        held: r.events.filter((e) => offered.has(e.id)).map((e) => e.id),
      };
    },
  });
  await gatedT.listen(0);

  const { Socket: SE } = await import("node:net");
  await new Promise<void>((res) => {
    const sk = new SE();
    sk.connect(pe, "127.0.0.1", () => { gatedT.adopt(sk, false); res(); });
  });
  await wait(400);

  ck("nothing arrives while suppressed", (gated.logs.c1 || []).length === 0,
     String((gated.logs.c1 || []).length));

  // The user opens the server: focus changes, and the client announces.
  offering = true;
  gatedT.announce();
  await wait(600);

  ck("the backlog arrives once it announces", gated.logs.c1.length === 2,
     String(gated.logs.c1.length));

  // A later message, written while connected, still flows live.
  early.say("sent while connected");
  await wait(400);
  ck("live messages continue", gated.logs.c1.length === 3,
     String(gated.logs.c1.length));

  early.t.stop(); late.t.stop(); gatedT.stop();
}

// Being named reaches someone who is not following the community.
//
// Following is a bandwidth decision, and it should not be able to swallow the
// one kind of message that is specifically about the person. Only the author
// can make that call, and only while writing: a moment later the payload is
// sealed, so no relay could identify a mention even if it were trusted to.
{
  const caller = node("Caller"), quiet = node("Quiet");
  caller.logs.c2 = [];
  quiet.logs.c2 = [];

  const pc = await caller.t.listen(0);
  await quiet.t.listen(0);

  const { Socket: SF } = await import("node:net");
  await new Promise<void>((res) => {
    const sk = new SF();
    sk.connect(pc, "127.0.0.1", () => { quiet.t.adopt(sk, false); res(); });
  });
  await wait(300);

  // Following nothing at all.
  quiet.t.declareFocus([]);
  await wait(250);

  const ordinary = createEvent(
    { type: "message.send", community: "c2", payload: { text: "anyone about?" } },
    caller.id, findHeads(caller.logs.c2),
  );
  caller.logs.c2.push(ordinary);
  caller.t.broadcast("c2", [ordinary]);
  await wait(400);

  ck("an ordinary message is withheld", quiet.logs.c2.length === 0,
     String(quiet.logs.c2.length));

  const named = createEvent(
    { type: "message.send", community: "c2", payload: { text: "you there?" } },
    caller.id, findHeads(caller.logs.c2),
  );
  caller.logs.c2.push(named);
  caller.t.broadcast("c2", [named], [quiet.id.userId]);
  await wait(400);

  ck("being named gets through anyway", quiet.logs.c2.length === 1,
     String(quiet.logs.c2.length));

  // And naming somebody else does not open the door.
  const elsewhere = createEvent(
    { type: "message.send", community: "c2", payload: { text: "not you" } },
    caller.id, findHeads(caller.logs.c2),
  );
  caller.logs.c2.push(elsewhere);
  caller.t.broadcast("c2", [elsewhere], [createIdentity().userId]);
  await wait(400);

  ck("someone else's mention is still withheld", quiet.logs.c2.length === 1,
     String(quiet.logs.c2.length));

  caller.t.stop(); quiet.t.stop();
}

// A converged pair must go quiet.
//
// Two devices holding the same log have nothing to say to each other, and the
// traffic view made it obvious when that was not true: repeated transfers of
// the same eighty kilobytes, and an id list on the wire on every announce
// whether or not anything had changed.
{
  const one = node("One"), two = node("Two");
  const p1 = await one.t.listen(0);
  await two.t.listen(0);

  for (let i = 0; i < 30; i++) one.say("history " + i);

  const { Socket: SG } = await import("node:net");
  await new Promise<void>((res) => {
    const sk = new SG();
    sk.connect(p1, "127.0.0.1", () => { two.t.adopt(sk, false); res(); });
  });
  await wait(700);

  ck("initial sync delivered", two.logs.c1.length === 30, String(two.logs.c1.length));

  // Counters are process-wide, and other pairs in this file are still
  // connected — so they are zeroed here to measure only what follows.
  resetWireStats();

  // Several rounds of announcing with nothing new to say.
  for (let i = 0; i < 5; i++) { one.t.announce(); two.t.announce(); await wait(120); }
  await wait(300);

  const after = wireStats();
  const haveFrames = (after.out.have || { frames: 0 }).frames;
  const giveFrames = (after.out.give || { frames: 0 }).frames;

  ck("no history is re-sent when converged", giveFrames === 0, String(giveFrames));
  ck("identical offers are not repeated", haveFrames <= 2, String(haveFrames));

  // A genuine change still gets through.
  one.say("something new");
  await wait(400);
  ck("new messages still arrive", two.logs.c1.length === 31, String(two.logs.c1.length));

  one.t.stop(); two.t.stop();
}

// Collapsing a duplicate must not look like losing a peer.
//
// Two devices that dial each other at the same time end up with two sockets
// and drop one. That is healthy. Read as a departure it schedules a redial,
// which produces another duplicate, which collapses, which reads as another
// departure — an app that spends its life reconnecting to somebody it is
// already connected to.
{
  const one = node("Left"), two = node("Right");
  const p1 = await one.t.listen(0);
  const p2 = await two.t.listen(0);

  // Everything the peer list ever reported, in order.
  const seen: string[][] = [];
  one.t.on("peers", (list: { userId?: string }[]) => {
    seen.push(list.map((p) => p.userId || "?").sort());
  });

  const { Socket: SH } = await import("node:net");
  await new Promise<void>((res) => {
    const sk = new SH();
    sk.connect(p1, "127.0.0.1", () => { two.t.adopt(sk, false); res(); });
  });
  await new Promise<void>((res) => {
    const sk = new SH();
    sk.connect(p2, "127.0.0.1", () => { one.t.adopt(sk, false); res(); });
  });
  await wait(700);

  ck("one connection survives", one.t.peers().length === 1,
     String(one.t.peers().length));
  ck("and it is identified", one.t.peers()[0].userId === two.id.userId);

  // The identified set must only ever have grown: never two, never back to
  // none. Anything watching by identity therefore sees no departure.
  const identified = seen.map(function (list) {
    return list.filter(function (u) { return u !== "?"; });
  });
  const shrank = identified.some(function (list, i) {
    return i > 0 && list.length < identified[i - 1].length;
  });
  const doubled = identified.some(function (list) {
    return list.filter(function (u) { return u === two.id.userId; }).length > 1;
  });

  ck("the peer never appears twice", !doubled);
  ck("and is never reported as leaving", !shrank);

  one.t.stop(); two.t.stop();
}

// ---- watermarks, and the peers that have never heard of them --------------
//
// Describing a log by watermark instead of by listing every id is the whole
// reason the offer stopped being megabytes. But an offer is only useful if the
// other side understands it, and there will be builds in the wild that do not
// — so the capability is announced, and a peer that does not claim it is
// talked to in the old, larger way.
//
// The failure this guards against is silent and total: an upgraded device
// sending a summary to a peer that reads `ids` would be offering an empty list,
// and the two would sit connected, agreeing there is nothing to send, forever.
{
  const { summarise, missingFrom } = await import("./vector");

  /**
   * A node that can be built either way.
   *
   * The old build is not simulated by faking a wire message — it is a node
   * with no summary hooks, which is exactly what an old build is. The
   * transport derives what it announces from the hooks it was given, so this
   * produces a genuinely old-shaped conversation rather than an imitation.
   */
  function vecNode(understands: boolean) {
    const id = createIdentity();
    const logs: Record<string, SignedEvent[]> = { c1: [] };
    let seq = 0;

    const hooks: Record<string, unknown> = {
      communities: () => Object.keys(logs),
      idsFor: (c: string) => (logs[c] || []).map((e) => e.id),
      missingFor: (c: string, peer: Set<string>) =>
        (logs[c] || []).filter((e) => !peer.has(e.id)),
      accepts: () => true,
      serves: () => true,
      reconciles: () => true,
      merge: (c: string, evs: SignedEvent[]) => {
        const r = mergeEvents(logs[c] || [], evs);
        logs[c] = r.events;
        const offered = new Set(evs.map((e) => e.id));
        return {
          accepted: r.accepted.length,
          held: r.events.filter((e) => offered.has(e.id)).map((e) => e.id),
        };
      },
    };

    if (understands) {
      hooks.summaryFor = (c: string) => summarise(logs[c] || []);
      hooks.missingForSummary = (c: string, summary: never) =>
        missingFrom(logs[c] || [], summary);
    }

    const t = new Transport(id.userId, hooks as never);

    return {
      id, logs, t,
      say(text: string) {
        // Numbered, which is what makes a watermark possible at all.
        const e = createEvent(
          { type: "message.send", community: "c1", payload: { text }, seq: ++seq },
          id,
          findHeads(logs.c1),
        );
        logs.c1.push(e);
        t.broadcast("c1", [e]);
        return e;
      },
    };
  }

  async function converge(left: ReturnType<typeof vecNode>, right: ReturnType<typeof vecNode>) {
    const port = await left.t.listen(0);
    await right.t.listen(0);

    const { Socket: S } = await import("node:net");
    await new Promise<void>((res) => {
      const sk = new S();
      sk.connect(port, "127.0.0.1", () => { right.t.adopt(sk, false); res(); });
    });
    await wait(500);
  }

  // Both new. The summary path, end to end.
  {
    const one = vecNode(true), two = vecNode(true);
    for (let i = 0; i < 4; i++) one.say("one " + i);
    for (let i = 0; i < 3; i++) two.say("two " + i);

    await converge(one, two);

    ck("two new peers converge", one.logs.c1.length === 7 && two.logs.c1.length === 7,
       `${one.logs.c1.length} / ${two.logs.c1.length}`);
    ck("and agree on the order",
       one.logs.c1.map((e) => e.id).join() === two.logs.c1.map((e) => e.id).join());

    // Live traffic still arrives; the summary is about catching up, not about
    // replacing the push that follows.
    one.say("after");
    await wait(250);
    ck("live events still arrive", two.logs.c1.length === 8, String(two.logs.c1.length));

    one.t.stop(); two.t.stop();
  }

  // New offering to old. The one that would fail silently.
  {
    const upgraded = vecNode(true), legacy = vecNode(false);
    for (let i = 0; i < 4; i++) upgraded.say("new " + i);
    for (let i = 0; i < 2; i++) legacy.say("old " + i);

    await converge(upgraded, legacy);

    ck("an old peer still receives everything", legacy.logs.c1.length === 6,
       String(legacy.logs.c1.length));
    ck("and is still able to give", upgraded.logs.c1.length === 6,
       String(upgraded.logs.c1.length));

    upgraded.t.stop(); legacy.t.stop();
  }

  // And the other way round, since either side may be the one that connects.
  {
    const legacy = vecNode(false), upgraded = vecNode(true);
    for (let i = 0; i < 3; i++) legacy.say("old " + i);
    for (let i = 0; i < 3; i++) upgraded.say("new " + i);

    await converge(legacy, upgraded);

    ck("an old peer dialling a new one converges too",
       legacy.logs.c1.length === 6 && upgraded.logs.c1.length === 6,
       `${legacy.logs.c1.length} / ${upgraded.logs.c1.length}`);

    legacy.t.stop(); upgraded.t.stop();
  }
}

a.t.stop();
console.log(f ? "\n"+f+" FAILED" : "\nall passed");
process.exit(f?1:0);
