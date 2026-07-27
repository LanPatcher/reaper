/**
 * Runnable demonstration of the P2P core.
 *
 *   cd for-desktop-p2p
 *   node --experimental-strip-types src/p2p/demo.ts
 *
 * Simulates two people on separate machines: they talk, lose contact, keep
 * talking independently, then reconnect and reconcile. Everything here is the
 * real implementation — identities, signing, the causal DAG, the compressed
 * encrypted log on disk. The only thing faked is the network, which is a
 * function call instead of a socket.
 *
 * The point is to make the parts that are hard to believe visible: that two
 * machines which diverged independently arrive at byte-identical history, and
 * that a forged message is refused.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createIdentity } from "./identity";
import { CommunityStore } from "./store";

const COMMUNITY = "hytlands";

function heading(text: string) {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
  console.log("─".repeat(text.length));
}

function transcript(store: CommunityStore, label: string) {
  console.log(`\n  ${label}`);
  for (const event of store.events()) {
    if (event.type !== "message.send") continue;
    const { author, content } = event.payload as { author: string; content: string };
    console.log(`    ${author.padEnd(8)} ${content}`);
  }
}

/**
 * Stand-in for the network: hand each side whatever the other is missing.
 *
 * This is deliberately the same call the real sync layer will make — the
 * transport changes, the reconciliation does not.
 */
function sync(a: CommunityStore, b: CommunityStore) {
  const aIds = new Set(a.events().map((event) => event.id));
  const bIds = new Set(b.events().map((event) => event.id));

  const toB = a.missingFor(bIds);
  const toA = b.missingFor(aIds);

  b.merge(toB);
  a.merge(toA);

  return { toA: toA.length, toB: toB.length };
}

const rayHome = mkdtempSync(join(tmpdir(), "stoat-ray-"));
const samHome = mkdtempSync(join(tmpdir(), "stoat-sam-"));

try {
  heading("Identities");

  const ray = createIdentity();
  const sam = createIdentity();

  console.log(`  ray  ${ray.userId}`);
  console.log(`  sam  ${sam.userId}`);
  console.log("\n  Derived from the device public key. No server issued these,");
  console.log("  and nothing had to agree they were free.");

  const rayStore = new CommunityStore({ root: rayHome, community: COMMUNITY, identity: ray });
  const samStore = new CommunityStore({ root: samHome, community: COMMUNITY, identity: sam });
  rayStore.open();
  samStore.open();

  heading("Both online");

  rayStore.append("message.send", { author: "ray", content: "is this thing on?" });
  sync(rayStore, samStore);
  samStore.append("message.send", { author: "sam", content: "loud and clear" });
  sync(rayStore, samStore);

  transcript(rayStore, "ray sees:");
  transcript(samStore, "sam sees:");

  heading("Connection drops — both keep typing");

  rayStore.append("message.send", { author: "ray", content: "did you see the match?" });
  rayStore.append("message.send", { author: "ray", content: "hello?" });

  samStore.append("message.send", { author: "sam", content: "my wifi died" });
  samStore.append("message.send", { author: "sam", content: "back now" });

  transcript(rayStore, "ray sees (offline):");
  transcript(samStore, "sam sees (offline):");

  console.log(`\n  Two independent histories. ray has ${rayStore.events().length} events,`);
  console.log(`  sam has ${samStore.events().length}. Neither is authoritative.`);

  heading("Reconnect");

  const moved = sync(rayStore, samStore);
  console.log(`  ray sent ${moved.toB} events, received ${moved.toA}.`);

  transcript(rayStore, "ray sees:");
  transcript(samStore, "sam sees:");

  const rayOrder = rayStore.events().map((event) => event.id).join();
  const samOrder = samStore.events().map((event) => event.id).join();

  console.log(
    `\n  Identical order on both machines: ${rayOrder === samOrder ? "yes" : "NO"}`,
  );
  console.log("  Nothing coordinated this. Both sorted the same DAG the same way.");

  heading("Forgery");

  const genuine = rayStore.events().find((e) => e.type === "message.send")!;
  const forged = { ...genuine, payload: { author: "ray", content: "I owe sam £500" } };

  const result = samStore.merge([forged]);
  console.log(`  sam accepted ${result.accepted.length}, rejected ${result.rejected.length}.`);
  console.log("  The id no longer matches the content it claims to hash.");

  const impersonation = {
    ...rayStore.events().find((e) => (e.payload as { author: string }).author === "ray")!,
    author: sam.userId,
  };
  const second = samStore.merge([impersonation]);
  console.log(`  Impersonation attempt: rejected ${second.rejected.length}.`);

  heading("On disk");

  rayStore.close();
  samStore.close();

  const events = rayStore.events().length;
  const raw = rayStore
    .events()
    .reduce((total, event) => total + JSON.stringify(event).length, 0);
  const stored = rayStore.size();

  console.log(`  ${events} events`);
  console.log(`  ${raw} bytes raw`);
  console.log(`  ${stored} bytes stored  (compressed, then AES-256-GCM encrypted)`);
  console.log("\n  The ratio is poor here only because the sample is tiny — Brotli");
  console.log("  has nothing to learn from a dozen messages. At a few thousand it");
  console.log("  settles around 25x; see storage.test.ts.");

  heading("Restart");

  const reopened = new CommunityStore({ root: rayHome, community: COMMUNITY, identity: ray });
  reopened.open();
  console.log(`  Reloaded ${reopened.events().length} events from disk.`);
  console.log(
    `  Same order as before shutdown: ${
      reopened.events().map((e) => e.id).join() === rayOrder ? "yes" : "NO"
    }`,
  );
  reopened.close();

  const wrongKey = new CommunityStore({
    root: rayHome,
    community: COMMUNITY,
    identity: sam,
  });

  try {
    wrongKey.open();
    console.log("  Another user reading ray's log: SUCCEEDED — this is a bug");
  } catch {
    console.log("  Another user reading ray's log: refused");
  }

  console.log("\n\x1b[1mWhat this does not yet do\x1b[0m");
  console.log("─".repeat(26));
  console.log("  No UI      — the store is exposed at window.p2p, but the Solid");
  console.log("               client still reads from stoat.js over HTTP");
  console.log("  No network — sync() above is a function call, not a socket");
  console.log("  No E2EE    — payloads are signed and encrypted at rest, not in transit");
  console.log("  No voice, files, roles, or membership yet\n");
} finally {
  rmSync(rayHome, { recursive: true, force: true });
  rmSync(samHome, { recursive: true, force: true });
}
