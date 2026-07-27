import { Socket } from "node:net";

import { createEvent, mergeEvents, type SignedEvent } from "./events";
import { createIdentity } from "./identity";
import { Transport, type TransportHooks } from "./transport";

/**
 * Knowing something arrived.
 *
 * Everything else in this protocol is content to be eventually consistent: an
 * event is offered, and if it is missed the next reconciliation catches it.
 * That works because both sides keep asking. It stops working for the events
 * that are *about* the relationship itself — leaving, being removed, being
 * invited — because after one of those, one side often stops asking. The
 * invited person is not syncing a group they have never heard of; the removed
 * person is not syncing a server they have dropped.
 *
 * So the sender has to know. These tests cover the receipt that tells them,
 * and the refusal that tells them when the answer is no.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A peer that keeps its logs in memory and records what it was told. */
function node(userId: string, opts: { serves?: (c: string, p?: string) => boolean } = {}) {
  const logs: Record<string, SignedEvent[]> = {};

  const delivered: { to: string; community: string; ids: string[] }[] = [];
  const refused: { from: string; community: string; reason: string }[] = [];

  const hooks: TransportHooks = {
    communities: () => Object.keys(logs),
    idsFor: (c) => (logs[c] || []).map((e) => e.id),
    missingFor: (c, theirs) => (logs[c] || []).filter((e) => !theirs.has(e.id)),
    merge: (c, incoming) => {
      const result = mergeEvents(logs[c] || [], incoming);
      logs[c] = result.events;

      const offered = new Set(incoming.map((e) => e.id));
      return {
        accepted: result.accepted.length,
        held: result.events.filter((e) => offered.has(e.id)).map((e) => e.id),
      };
    },
    serves: (c, p) => (opts.serves ? opts.serves(c, p) : true),
    reconciles: () => true,
    accepts: () => true,
    blobFor: () => undefined,
    blobDone: () => undefined,
    refusal: (c, p) => (opts.serves && !opts.serves(c, p) ? "not-a-member" : undefined),
  };

  const t = new Transport(userId, hooks, { pingEveryMs: 200, idleTimeoutMs: 5000 });
  t.on("delivered", (to: string, community: string, ids: string[]) =>
    delivered.push({ to, community, ids }));
  t.on("refused", (from: string, community: string, reason: string) =>
    refused.push({ from, community, reason }));

  return { userId, logs, t, delivered, refused };
}

/** Dial one node from another over loopback, as the transport tests do. */
function join(server: { t: Transport }, port: number, client: { t: Transport }) {
  return new Promise<void>((resolve) => {
    void server;
    const sock = new Socket();
    sock.connect(port, "127.0.0.1", () => { client.t.adopt(sock, false); resolve(); });
  });
}

const alice = createIdentity();
const bob = createIdentity();

async function main() {
  // ---- a receipt comes back for what was stored --------------------------
  const a = node(alice.userId);
  const b = node(bob.userId);

  const pa = await a.t.listen(0);
  const pb = await b.t.listen(0);
  void pa;

  const invite = createEvent(
    { type: "group.invite", community: "dm1", payload: { id: "g1" } },
    alice,
    [],
  );
  a.logs.dm1 = [invite];

  await join(b, pb, a);
  await wait(400);

  a.t.broadcast("dm1", [invite]);
  await wait(400);

  ck("the invitation reached the other side",
     (b.logs.dm1 || []).some((e) => e.id === invite.id));

  ck("the sender was told it arrived",
     a.delivered.some((d) => d.ids.includes(invite.id)),
     JSON.stringify(a.delivered.map((d) => d.ids.length)));

  ck("the receipt names who has it",
     a.delivered.every((d) => d.to === bob.userId));

  // ---- a second delivery is acked too ------------------------------------
  //
  // The sender retrying an obligation needs "I already have that" to count as
  // an answer. Otherwise every retry after the first success is silent, and
  // the obligation is never retired.
  a.delivered.length = 0;
  a.t.broadcast("dm1", [invite]);
  await wait(400);

  ck("re-sending something already held is still acknowledged",
     a.delivered.some((d) => d.ids.includes(invite.id)));

  a.t.stop();
  b.t.stop();
  await wait(150);

  // ---- refusal -----------------------------------------------------------
  //
  // The other half: a peer that will not take the events has to say so, or the
  // sender retries forever against a wall.
  const c = node(alice.userId);
  const d = node(bob.userId, { serves: (community) => community !== "s1" });

  await c.t.listen(0);
  const pd = await d.t.listen(0);

  const message = createEvent(
    { type: "message.send", community: "s1", payload: { content: "hello" } },
    alice,
    [],
  );
  c.logs.s1 = [message];

  await join(d, pd, c);
  await wait(400);

  c.t.broadcast("s1", [message]);
  await wait(400);

  ck("a refused community is not stored", !(d.logs.s1 || []).length);
  ck("and the sender is told why",
     c.refused.some((r) => r.community === "s1" && r.reason === "not-a-member"),
     JSON.stringify(c.refused));
  ck("no receipt is sent for something refused",
     !c.delivered.some((x) => x.ids.includes(message.id)));

  c.t.stop();
  d.t.stop();
  await wait(150);

  // ---- the expiry rule ---------------------------------------------------
  //
  // Pure arithmetic, checked here rather than in the interface because getting
  // it wrong means either dropping something that was still deliverable or
  // retrying forever.
  const DAY = 86400000;
  const HOUR = 3600000;
  const expires = (ageDays: number, uptimeHours: number, kind: string) =>
    ageDays * DAY > 30 * DAY && uptimeHours * HOUR > 200 * HOUR && kind !== "message";

  ck("a fresh obligation is kept", !expires(1, 500, "invite"));
  ck("an old one is kept if this device was rarely awake", !expires(60, 10, "invite"));
  ck("old and well-tried is dropped", expires(60, 500, "invite"));
  ck("chat is never dropped on a timer", !expires(365, 5000, "message"));
  ck("the boundary is not inclusive", !expires(30, 200, "invite"));
}

main().then(() => {
  console.log(f ? "\n" + f + " FAILED" : "\nall passed");
  process.exit(f ? 1 : 0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
