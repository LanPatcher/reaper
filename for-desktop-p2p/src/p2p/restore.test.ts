import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packBundle, unpackBundle } from "./backup-bundle";
import { createIdentity } from "./identity";
import { CommunityStore } from "./store";

/**
 * Restoring an account, from a real store to a real store.
 *
 * The symptom this exists for: an identity imported onto a phone came back
 * with the right user id and *nothing else*. No friends, no servers. The
 * account was technically restored and practically empty, which is the worst
 * of both — it looks like it worked.
 *
 * There was nothing to test against, because packing and unpacking a backup
 * lived inside two IPC handlers that only run under Electron. So the only way
 * to find out whether a backup restores an account was to write one on a
 * desktop, carry it to a phone and look.
 *
 * This does the whole thing: a store with friends and servers in it, exported,
 * sealed, opened, and merged into an empty store belonging to a device that
 * has never seen any of it. Then it asks the question that matters — is the
 * friends list there.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

const INDEX = "@index";

function storeIn(root: string, identity: ReturnType<typeof createIdentity>) {
  const store = new CommunityStore({ root, community: INDEX, identity });
  store.open();
  return store;
}

// ---- the whole journey ------------------------------------------------------

{
  const identity = createIdentity();

  // The device this account lives on.
  const desktop = mkdtempSync(join(tmpdir(), "reaper-desktop-"));
  const before = storeIn(desktop, identity);

  before.append("friend.add", { userId: "u_alice", name: "Alice" });
  before.append("friend.add", { userId: "u_bob", name: "Bob" });
  before.append("community.create", { id: "srv_one", name: "The Server" });
  before.append("community.key", { id: "srv_one", key: "a-key" });
  before.append("group.create", { id: "grp_one", name: "A group chat" });
  before.append("outbox.add", { key: "o1", to: "u_alice", community: "dm_x" });
  before.append("profile.update", { name: "Ray" });

  const exported = before.events().map((event) => ({ ...event }));
  ck("the account has something in it to lose", exported.length === 7,
     String(exported.length));

  const file = await packBundle(
    { identity, index: exported, syncOnion: "a".repeat(56) + ".onion" },
    "a long enough passphrase",
  );

  // ---- and onto a device that has never seen any of it --------------------

  const opened = await unpackBundle(file, "a long enough passphrase");

  ck("the identity comes back", opened.identity.userId === identity.userId);
  ck("and the index travels with it",
     (opened.index ?? []).length === exported.length,
     String((opened.index ?? []).length));

  // The part that was missing on the phone. Merging into a store belonging to
  // a device with no history at all, exactly as an import does.
  const phone = mkdtempSync(join(tmpdir(), "reaper-phone-"));
  const after = storeIn(phone, opened.identity);

  const merged = after.merge(opened.index ?? []);

  ck("every event is accepted", merged.accepted.length === exported.length,
     `${merged.accepted.length} accepted, ${merged.rejected.length} rejected`);

  ck("and none rejected", merged.rejected.length === 0);

  const kinds = after.events().map((event) => event.type);

  ck("the friends are there", kinds.filter((k) => k === "friend.add").length === 2);
  ck("the server is there", kinds.includes("community.create"));
  ck("with its key", kinds.includes("community.key"));
  ck("the group chat is there", kinds.includes("group.create"));
  ck("and the unsent message is still queued", kinds.includes("outbox.add"));

  const alice = after.events().find(
    (event) => (event.payload as { userId?: string })?.userId === "u_alice",
  );
  ck("with their details intact",
     (alice?.payload as { name?: string })?.name === "Alice");

  // ---- and it survives being closed and reopened --------------------------
  //
  // The import writes and then the app restarts, so what is on disk is what
  // the user actually gets. A merge that is only in memory would pass every
  // assertion above and produce precisely the empty account that was reported.

  after.close();

  const reopened = storeIn(phone, opened.identity);
  const kept = reopened.events();

  ck("it is still there after a restart", kept.length === exported.length,
     String(kept.length));

  ck("including the friends",
     kept.filter((event) => event.type === "friend.add").length === 2);

  reopened.close();
  before.close();
}

// ---- your own face ----------------------------------------------------------
//
// Profile pictures are attachments, and attachments are deliberately left out
// of a backup because they can be fetched again from whoever sent them. Your
// own cannot: nobody else has them to send back. A restored account came up
// with the right name and a blank grey circle, permanently.

{
  const identity = createIdentity();
  const picture = randomBytes(6000);
  const id = createHash("sha256").update(picture).digest("hex");

  const file = await packBundle({
    identity,
    index: [],
    avatars: { [id]: picture.toString("base64") },
  }, "a long enough passphrase");

  const opened = await unpackBundle(file, "a long enough passphrase");

  ck("a backup carries your own picture",
     !!opened.avatars && Object.keys(opened.avatars).length === 1);

  const back = Buffer.from(opened.avatars![id], "base64");
  ck("byte for byte", back.equals(picture));

  // Named by its hash, which is what lets the import refuse anything that has
  // been tampered with rather than writing it under a name other devices will
  // ask for and believe.
  ck("and still hashes to its own name",
     createHash("sha256").update(back).digest("hex") === id);
}

// ---- the address for the first sync ----------------------------------------

{
  const identity = createIdentity();

  const withAddress = await packBundle(
    { identity, index: [], syncOnion: "b".repeat(56) + ".onion" },
    "another good passphrase",
  );

  const opened = await unpackBundle(withAddress, "another good passphrase");
  ck("a backup carries where to sync from",
     opened.syncOnion === "b".repeat(56) + ".onion");

  // A file written by a build that predates this. It still opens, and the
  // absence is what tells the interface not to offer a catch-up it cannot do.
  const old = await packBundle({ identity, index: [] }, "another good passphrase");
  const older = await unpackBundle(old, "another good passphrase");

  ck("and an older one simply has none", older.syncOnion === undefined);
}

// ---- refusals ---------------------------------------------------------------

{
  const identity = createIdentity();
  const file = await packBundle({ identity }, "the right passphrase");

  let wrong = false;
  try { await unpackBundle(file, "the wrong passphrase"); } catch { wrong = true; }
  ck("the wrong passphrase is refused", wrong);

  let damaged = false;
  const outer = JSON.parse(file) as Record<string, string>;
  outer.data = Buffer.from(outer.data, "base64").toString("base64").slice(0, -8) + "AAAAAAAA";
  try { await unpackBundle(JSON.stringify(outer), "the right passphrase"); } catch { damaged = true; }
  ck("and a damaged file is refused", damaged);

  let notOurs = false;
  try { await unpackBundle(JSON.stringify({ hello: 1 }), "x"); } catch { notOurs = true; }
  ck("and a file that is not ours at all", notOurs);
}

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
