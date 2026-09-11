import { Socket } from "node:net";

import { createIdentity } from "./identity";
import { Transport, type TransportHooks } from "./transport";

/**
 * Who a camera frame reaches.
 *
 * ## Why this is tested rather than eyeballed
 *
 * It used to reach everybody. Media was sent to every connected peer and each
 * client discarded the frames for a call it was not in, which is invisible from
 * the interface — the person in an unrelated server sees nothing, because their
 * client chose not to look. That is fine as tidiness and worthless as privacy:
 * the bytes were on their machine, and a modified client keeps whatever it is
 * sent.
 *
 * A camera makes the difference matter. So the filter is on the sender now, and
 * this is the test that says so: a peer outside the call must receive nothing,
 * and "nothing" has to be asserted on the wire rather than in the interface.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function node(userId: string) {
  const logs: Record<string, never[]> = {};
  const heard: { channel: string; from: string; frame: string }[] = [];

  const hooks: TransportHooks = {
    communities: () => Object.keys(logs),
    idsFor: () => [],
    missingFor: () => [],
    merge: () => ({ accepted: 0, held: [] }),
    serves: () => true,
    reconciles: () => true,
    accepts: () => true,
    blobFor: () => undefined,
    blobDone: () => undefined,
  };

  const t = new Transport(userId, hooks, { pingEveryMs: 500, idleTimeoutMs: 9000 });
  t.on("audio", (channel: string, from: string, _seq: number, frame: string) =>
    heard.push({ channel, from, frame }));

  return { userId, t, heard };
}

function join(port: number, client: { t: Transport }) {
  return new Promise<void>((resolve) => {
    const sock = new Socket();
    sock.connect(port, "127.0.0.1", () => { client.t.adopt(sock, false); resolve(); });
  });
}

const alice = createIdentity();
const bob = createIdentity();
const mallory = createIdentity();

async function main() {
  const a = node(alice.userId);
  const b = node(bob.userId);
  const m = node(mallory.userId);

  const pa = await a.t.listen(0);
  await b.t.listen(0);
  await m.t.listen(0);

  // Both connected to Alice. Only Bob is in the call.
  await join(pa, b);
  await join(pa, m);
  await wait(500);

  // ---- before anything is declared ----------------------------------------
  //
  // The safe default: a device that has not said who is in the call sends to
  // nobody, so a frame produced by a bug cannot reach anyone.
  a.t.sendAudio("call:1", 1, "AAAA");
  await wait(300);
  ck("with no call declared, nothing is sent at all",
     b.heard.length === 0 && m.heard.length === 0,
     `bob ${b.heard.length}, mallory ${m.heard.length}`);

  // ---- the call ------------------------------------------------------------
  a.t.setCallAudience([alice.userId, bob.userId]);
  b.t.setCallAudience([alice.userId, bob.userId]);

  a.t.sendAudio("cam:call:1", 2, "FACE");
  await wait(400);

  ck("someone in the call receives the frame",
     b.heard.some((h) => h.frame === "FACE"), JSON.stringify(b.heard));

  ck("someone merely connected receives nothing",
     m.heard.length === 0, JSON.stringify(m.heard));

  // ---- and it is not relayed to them either -------------------------------
  //
  // Alice relays what she receives so a call works without everyone being
  // directly connected. Mallory is connected to Alice, so if the relay went to
  // every peer she would get Bob's camera through Alice without ever being in
  // the call.
  b.t.sendAudio("cam:call:1", 3, "BOBFACE");
  await wait(500);

  ck("a relayed frame does not escape the call",
     m.heard.length === 0, JSON.stringify(m.heard));

  // ---- frames from outside the call are refused ---------------------------
  //
  // The other direction. Mallory is not in the call, so what she sends must not
  // appear in it — the interface would ignore it, but "ignored" and "cannot
  // arrive" are different properties, and a camera tile appearing from outside
  // the room is the one that must not be possible.
  m.t.setCallAudience([mallory.userId, alice.userId]);
  m.t.sendAudio("cam:call:1", 4, "INTRUDER");
  await wait(400);

  ck("a frame from outside the call is dropped rather than shown",
     !a.heard.some((h) => h.frame === "INTRUDER"), JSON.stringify(a.heard));

  // ---- leaving stops it ----------------------------------------------------
  a.t.setCallAudience([]);
  b.heard.length = 0;
  a.t.sendAudio("cam:call:1", 5, "AFTER");
  await wait(300);

  ck("once the call is left, nothing more is sent",
     b.heard.length === 0, JSON.stringify(b.heard));

  a.t.stop(); b.t.stop(); m.t.stop();
  await wait(150);
}

main().then(() => {
  console.log(f ? "\n" + f + " FAILED" : "\nall passed");
  process.exit(f ? 1 : 0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
