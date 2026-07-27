import { createIdentity, userIdFromPublicKey } from "./identity";
import { canonicalise, createEvent, verifyEvent, findHeads, causalSort, mergeEvents } from "./events";

let failures = 0;
const check = (n: string, c: boolean, e = "") => { console.log(`${c?"PASS":"FAIL"}  ${n}${e?"  "+e:""}`); if(!c) failures++; };

const ray = createIdentity();
const friend = createIdentity();

check("identity has 26-char id", ray.userId.length === 26, ray.userId);
check("ids are stable", userIdFromPublicKey(ray.publicKey) === ray.userId);
check("ids differ", ray.userId !== friend.userId);

// canonical form is order-independent
check("canonical: key order irrelevant",
  canonicalise({ b: 1, a: [2, { d: 4, c: 3 }] }) === canonicalise({ a: [2, { c: 3, d: 4 }], b: 1 }));
check("canonical: survives a JSON round-trip",
  canonicalise({ z: 1, a: 2 }) === canonicalise(JSON.parse(JSON.stringify({ a: 2, z: 1 }))));
let threw = false; try { canonicalise({ x: NaN }); } catch { threw = true; }
check("canonical: rejects NaN", threw);

// sign + verify
const e1 = createEvent({ type: "message.send", community: "c1", payload: { content: "hello" } }, ray);
check("event verifies", verifyEvent(e1));
check("first event has clock 1", e1.clock === 1);
check("first event has no parents", e1.parents.length === 0);

// tampering
check("tampered payload rejected", !verifyEvent({ ...e1, payload: { content: "goodbye" } }));
check("tampered author rejected", !verifyEvent({ ...e1, author: friend.userId }));
check("tampered signature rejected", !verifyEvent({ ...e1, signature: Buffer.alloc(64).toString("base64") }));
// impersonation: friend signs, claims to be ray
const forged = createEvent({ type: "message.send", community: "c1", payload: { content: "hi" } }, friend);
check("impersonation rejected", !verifyEvent({ ...forged, author: ray.userId }));

// chaining
const e2 = createEvent({ type: "message.send", community: "c1", payload: { content: "second" } }, ray, [e1]);
check("clock increments", e2.clock === 2);
check("parent recorded", e2.parents[0] === e1.id);
check("heads = latest", findHeads([e1, e2]).map(e => e.id).join() === e2.id);

// concurrent branches converge to the same order on both peers
const a = createEvent({ type: "m", community: "c1", payload: { n: "a" } }, ray, [e1]);
const b = createEvent({ type: "m", community: "c1", payload: { n: "b" } }, friend, [e1]);
const orderA = causalSort([e1, a, b]).map(e => e.id).join();
const orderB = causalSort([b, e1, a]).map(e => e.id).join();
const orderC = causalSort([a, b, e1]).map(e => e.id).join();
check("concurrent events converge", orderA === orderB && orderB === orderC);
check("causal order respected", causalSort([a, b, e1])[0].id === e1.id);
check("two heads after a fork", findHeads([e1, a, b]).length === 2);

// merge after the fork
const merged = createEvent({ type: "m", community: "c1", payload: { n: "merge" } }, ray, findHeads([e1, a, b]));
check("merge has both parents", merged.parents.length === 2);
check("merge clock is max+1", merged.clock === Math.max(a.clock, b.clock) + 1);
check("merge sorts last", causalSort([merged, b, e1, a]).at(-1)!.id === merged.id);

// partial history: parents we don't have yet
check("orders with missing parents", causalSort([e2]).length === 1);

// mergeEvents filters junk
const bad = { ...e1, id: "0".repeat(64) } as typeof e1;
const r = mergeEvents([e1], [e2, bad, e1]);
check("merge accepts good", r.accepted.length === 1 && r.accepted[0].id === e2.id);
check("merge rejects bad", r.rejected.length === 1);
check("merge dedupes", r.events.length === 2);

// id collision: same id, different content, is an attack not a duplicate
{
  const genuine = createEvent({ type: "m", community: "c1", payload: { v: "real" } }, ray);
  const collided = { ...genuine, payload: { v: "tampered" } };
  const r2 = mergeEvents([genuine], [collided]);
  check("id collision reported as rejected", r2.rejected.length === 1);
  check("id collision does not replace ours",
    (r2.events[0].payload as any).v === "real");
  const dup = mergeEvents([genuine], [{ ...genuine }]);
  check("true duplicate stays silent", dup.rejected.length === 0 && dup.accepted.length === 0);
}

// large DAG determinism
const many = [e1];
for (let i = 0; i < 300; i++) {
  const who = i % 2 ? ray : friend;
  many.push(createEvent({ type: "m", community: "c1", payload: { i } }, who, findHeads(many)));
}
const shuffled = [...many].sort(() => Math.random() - 0.5);
check("300-event DAG is deterministic",
  causalSort(many).map(e=>e.id).join() === causalSort(shuffled).map(e=>e.id).join());
check("all 300 verify", many.every(verifyEvent));

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
