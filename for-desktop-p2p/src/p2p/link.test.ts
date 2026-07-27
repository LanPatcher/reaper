import { createHash, randomBytes } from "node:crypto";

import { type Claim, claimFor, holder, holds, standing } from "./devices";
import type { SignedEvent } from "./events";
import { createIdentity } from "./identity";
import { LinkService, fingerprint, type LinkHooks } from "./link";
import { summarise } from "./vector";

/**
 * Linking two of your own devices.
 *
 * Two properties decide whether this feature is worth having, and neither can
 * be established by reading:
 *
 *   1. **It converges.** After one link, both devices hold the same events and
 *      the same files — including the private index log, which carries the
 *      friends list, the servers joined, the preferences and the outbox, and
 *      which is the one log that can never be recovered from a peer.
 *
 *   2. **Only you can link.** The protocol hands over the entire account with
 *      no filtering at all, so the authentication is not a check on top of the
 *      feature — it *is* the feature. A device that cannot sign with the
 *      account's private key must get nothing, and must be told why in terms
 *      that do not accuse a neighbour's laptop of an attack.
 *
 * Both are exercised over a real loopback socket with two real accounts. The
 * broadcast half is not — a container will not carry one — so discovery is
 * tested at the level that can be: the fingerprint, which is what decides
 * whether an announcement is even looked at.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

/** A device, in memory. Enough of a store to be synced. */
function device(identity: ReturnType<typeof createIdentity>, name: string) {
  const logs = new Map<string, SignedEvent[]>();
  const blobs = new Map<string, Map<string, Buffer>>();
  const claims: Claim[] = [];
  const id = createHash("sha256").update(name).digest("hex").slice(0, 32);

  const hooks: LinkHooks = {
    identity,
    device: id,
    name,

    communities: () => [...logs.keys()],
    summary: (community) => summarise(logs.get(community) ?? []),

    missingForSummary: (community, summary) => {
      const held = logs.get(community) ?? [];
      const covered = new Set(summary.extra);

      return held.filter((event) => {
        const seq = (event as { seq?: number }).seq ?? 0;
        const watermark = summary.vector[event.author] ?? 0;
        return !(seq > 0 && seq <= watermark) && !covered.has(event.id);
      });
    },

    merge: (community, events) => {
      const held = logs.get(community) ?? [];
      const known = new Set(held.map((event) => event.id));

      let added = 0;
      for (const event of events) {
        if (known.has(event.id)) continue;
        held.push(event);
        known.add(event.id);
        added++;
      }

      logs.set(community, held);
      return added;
    },

    blobIds: (community) => [...(blobs.get(community)?.keys() ?? [])],
    readBlob: (community, blob) => blobs.get(community)?.get(blob),

    writeBlob: (community, blob, bytes) => {
      const bag = blobs.get(community) ?? new Map<string, Buffer>();
      bag.set(blob, bytes);
      blobs.set(community, bag);
    },

    claims: () => claims,
    addClaim: (claim) => {
      if (!claims.some((c) => c.device === claim.device && c.n === claim.n)) {
        claims.push(claim);
      }
    },
  };

  return { hooks, logs, blobs, claims, id };
}

let counter = 0;
function event(author: string, body: string): SignedEvent {
  counter++;
  return {
    id: createHash("sha256").update(author + body + counter).digest("hex"),
    author,
    seq: counter,
    type: "message",
    payload: { body },
    at: Date.now(),
    parents: [],
    signature: "x",
  } as unknown as SignedEvent;
}

// ---- one link, and both devices hold everything -----------------------------

{
  const identity = createIdentity();

  const desktop = device(identity, "Ray's desktop");
  const phone = device(identity, "Ray's phone");

  // The private index log, which is the one that matters. A peer never sees
  // this, so a device that does not get it here will never get it at all.
  desktop.logs.set("@index", [
    event(identity.userId, "friend.add"),
    event(identity.userId, "outbox.add"),
  ]);

  desktop.logs.set("srv_one", [event(identity.userId, "hello there")]);
  phone.logs.set("dm_two", [event(identity.userId, "sent from the phone")]);

  // A file only the desktop holds, named by its hash the way the store does.
  const bytes = randomBytes(400_000);
  const blob = createHash("sha256").update(bytes).digest("hex");
  desktop.blobs.set("srv_one", new Map([[blob, bytes]]));

  desktop.claims.push({ device: desktop.id, name: "Ray's desktop", n: 1, at: 1000 });

  const listener = new LinkService(phone.hooks);
  const dialler = new LinkService(desktop.hooks);

  const port = await listener.open({ announce: false });
  ck("a device opens a port to be linked on", port > 0, String(port));

  const progress = await dialler.connect("127.0.0.1", port);

  ck("the link completes", progress.done);
  ck("and says which device it spoke to", progress.name === "Ray's phone", progress.name);

  // The heart of it.
  ck("the phone now has the private index log",
     (phone.logs.get("@index") ?? []).length === 2,
     String((phone.logs.get("@index") ?? []).length));

  ck("including the queued outbox entry",
     (phone.logs.get("@index") ?? []).some((e) =>
       (e.payload as { body: string }).body === "outbox.add"));

  ck("the phone has the server's history",
     (phone.logs.get("srv_one") ?? []).length === 1);

  ck("and the desktop has the conversation that only existed on the phone",
     (desktop.logs.get("dm_two") ?? []).length === 1);

  ck("the file crossed as well",
     phone.blobs.get("srv_one")?.get(blob)?.length === bytes.length,
     String(phone.blobs.get("srv_one")?.get(blob)?.length));

  ck("and arrived byte for byte",
     !!phone.blobs.get("srv_one")?.get(blob)?.equals(bytes));

  ck("the phone learned which device holds the address",
     phone.claims.some((c) => c.device === desktop.id && c.n === 1));

  listener.close();
  dialler.close();
}

// ---- linking twice moves nothing the second time ----------------------------
//
// A sync that re-sent everything every time would work and be unusable: the
// index log on a busy account is tens of thousands of events, and the files
// are the whole of the attachment store.

{
  const identity = createIdentity();
  const a = device(identity, "one");
  const b = device(identity, "two");

  a.logs.set("@index", [event(identity.userId, "x"), event(identity.userId, "y")]);

  const listener = new LinkService(b.hooks);
  const port = await listener.open({ announce: false });

  await new LinkService(a.hooks).connect("127.0.0.1", port);

  // Counted on the receiving side. `progress.events` is what *this* device
  // merged, and the device that dialled had nothing to learn — reading its
  // own count would have reported zero and called it a pass.
  ck("the first link moves the events",
     (b.logs.get("@index") ?? []).length === 2,
     String((b.logs.get("@index") ?? []).length));

  const before = (b.logs.get("@index") ?? []).length;
  const again = await new LinkService(a.hooks).connect("127.0.0.1", port);

  ck("the second moves nothing",
     again.events === 0 && (b.logs.get("@index") ?? []).length === before,
     String(again.events));

  listener.close();
}

// ---- a device signed in as somebody else ------------------------------------

{
  const mine = createIdentity();
  const theirs = createIdentity();

  const me = device(mine, "mine");
  const stranger = device(theirs, "a neighbour's laptop");

  const listener = new LinkService(me.hooks);
  const port = await listener.open({ announce: false });

  let refused = "";
  try {
    await new LinkService(stranger.hooks).connect("127.0.0.1", port);
  } catch (error) {
    refused = (error as Error).message;
  }

  ck("a different account cannot link", !!refused, refused);

  // The wording matters. On a shared network the overwhelmingly likely cause
  // is somebody else's Reaper, not an attack, and an alarming message would
  // be wrong far more often than it was right.
  ck("and is told so without being accused of anything",
     /signed in as somebody else/.test(refused), refused);

  ck("nothing of the account crossed",
     (stranger.logs.get("@index") ?? []).length === 0);

  listener.close();
}

// ---- the announcement gives nothing away ------------------------------------

{
  const identity = createIdentity();
  const salt = randomBytes(16).toString("hex");
  const shown = fingerprint(identity.publicKey, salt);

  ck("an announcement carries a hash, not the key",
     !shown.includes(identity.publicKey.slice(0, 16)));

  ck("which your own device can recompute",
     fingerprint(identity.publicKey, salt) === shown);

  ck("and another account cannot",
     fingerprint(createIdentity().publicKey, salt) !== shown);

  // A fresh salt each beat, or two announcements are trivially the same device
  // to anyone watching the port.
  ck("a new salt gives a different fingerprint",
     fingerprint(identity.publicKey, randomBytes(16).toString("hex")) !== shown);
}

// ---- who holds the address --------------------------------------------------

{
  const none: Claim[] = [];
  ck("a device that has never been linked publishes", holds(none, "a"));
  ck("and is described as unclaimed", standing(none, "a").state === "unclaimed");

  const claims: Claim[] = [
    { device: "a", name: "desktop", n: 1, at: 1000 },
    { device: "b", name: "phone", n: 2, at: 2000 },
  ];

  ck("the highest claim wins", holder(claims)?.device === "b");
  ck("the displaced device stops publishing", !holds(claims, "a"));

  const state = standing(claims, "a");
  ck("and is told which device took over",
     state.state === "displaced" && state.by.name === "phone");

  // Reclaiming, which is what the Reconnect button does.
  const back = claimFor(claims, "a", "desktop", 3000);
  ck("reclaiming outranks it", back.n === 3);
  ck("and hands the address back", holds([...claims, back], "a"));

  // Two devices that could not see each other and both claimed. They must
  // agree on which of them won, even though neither is more right.
  const split: Claim[] = [
    { device: "a", name: "desktop", n: 5, at: 4000 },
    { device: "b", name: "phone", n: 5, at: 4000 },
  ];

  ck("a tie resolves the same way from both sides",
     holder(split)?.device === holder([...split].reverse())?.device);

  ck("and exactly one of them publishes",
     [holds(split, "a"), holds(split, "b")].filter(Boolean).length === 1);
}

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
