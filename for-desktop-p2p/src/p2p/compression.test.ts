import { createIdentity } from "./identity";
import { createEvent, findHeads, mergeEvents, type SignedEvent } from "./events";
import { Transport } from "./transport";
import { seal, randomKey } from "./crypto";

let f=0; const ck=(n:string,c:boolean,e="")=>{console.log((c?"PASS":"FAIL")+"  "+n+(e?"  "+e:""));if(!c)f++;};
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));

function node(name: string) {
  const id = createIdentity();
  const logs: Record<string, SignedEvent[]> = { c1: [] };
  let bytesOut = 0;
  const t = new Transport(id.userId, {
    communities: () => Object.keys(logs),
    idsFor: (c) => (logs[c] || []).map(e => e.id),
    missingFor: (c, peer) => (logs[c] || []).filter(e => !peer.has(e.id)),
    accepts: () => true,
    serves: () => true,
    reconciles: () => true,
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
  return { id, logs, t, name, get bytesOut(){return bytesOut;}, count(n:number){bytesOut+=n;} };
}

const a = node("A"), b = node("B");
const key = Buffer.from(randomKey(), "base64");

// A realistic backlog: encrypted payloads, repeated envelope.
for (let i = 0; i < 150; i++) {
  a.logs.c1.push(createEvent(
    { type: "message.send", community: "c1", payload: seal({ channelId: "cgeneral", content: "message number " + i, username: "ray" }, key) },
    a.id, findHeads(a.logs.c1)
  ));
}

const portA = await a.t.listen(0);
await b.t.listen(0);

// Measure what actually crosses the socket.
const { Socket } = await import("node:net");
let wireBytes = 0;
await new Promise<void>((res) => {
  const sock = new Socket();
  const realWrite = sock.write.bind(sock);
  sock.connect(portA, "127.0.0.1", () => { b.t.adopt(sock, false); res(); });
  sock.on("data", (d) => { wireBytes += d.length; });
});
await wait(900);

ck("backlog synced", b.logs.c1.length === 150, String(b.logs.c1.length));

const rawJson = Buffer.byteLength(JSON.stringify({ t:"give", community:"c1", events: a.logs.c1 }), "utf8");
const ratio = rawJson / wireBytes;
console.log(`     raw ${rawJson}B -> wire ${wireBytes}B (${ratio.toFixed(2)}x)`);
ck("compression saves bandwidth", wireBytes < rawJson * 0.75, ratio.toFixed(2) + "x");

// Incompressible content must not be inflated.
const audio = Buffer.from(Array.from({length: 4000}, () => Math.floor(Math.random()*256))).toString("base64");
const before = wireBytes;
a.t.sendAudio("call:x", 1, audio);
await wait(250);
const audioWire = wireBytes - before;
ck("incompressible payload not inflated", audioWire < audio.length * 1.15, `${audio.length}B -> ${audioWire}B`);

a.t.stop(); b.t.stop();
console.log(f ? "\n"+f+" FAILED" : "\nall passed");
process.exit(f?1:0);
