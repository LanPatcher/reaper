import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The interface half of membership.
 *
 * Most of what went wrong here was not a protocol failure. It was a button
 * whose handler threw before it did anything, an event written to a log nobody
 * else reads, or a check placed below a `return` that skipped it. None of those
 * are visible in a protocol test, because the protocol was never reached.
 *
 * So this reads the source. It is a blunt instrument and it is aimed at exactly
 * the mistakes that actually happened: a shadowed helper, a private log used
 * for a shared statement, and a handler sitting under a guard that drops
 * everything not currently on screen.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

const html = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
const script = html.slice(html.indexOf("<script>"));

// ---- the shadowing bug ---------------------------------------------------
//
// `var t = document.createElement(...)` inside a dialog builder shadows the
// translation helper for the whole function, because `var` is function-scoped
// and hoisted. Every later `t("…")` in that builder then calls a DOM element.
// It threw, the builder stopped, and the dialog rendered without its buttons —
// which is why Leave group, Delete channel and New channel all silently did
// nothing. Nothing in the app reported it; the dialog just came up wrong.
const shadowed = [...script.matchAll(/\bvar\s+t\s*=/g)];
ck("nothing shadows the translation helper", shadowed.length === 0,
   `${shadowed.length} site(s)`);

// The same hazard for the other single-letter helpers that are called after
// being declared in the same scope.
for (const name of ["flash", "modal", "owe", "settle"]) {
  const re = new RegExp(`\\bvar\\s+${name}\\s*=`, "g");
  ck(`nothing shadows ${name}()`, !re.test(script));
}

// ---- statements that must be shared, not private -------------------------
//
// `@index` is this device's own log and is never sent to anybody. Anything
// written only there is invisible to the person it is about — which is exactly
// what happened to unfriending: the event went to the index, the other side
// was never told, and they carried on as friends.
const indexOnly = (type: string) => {
  const appends = [...script.matchAll(new RegExp(`append\\(([A-Za-z0-9_.$]+),\\s*"${type}"`, "g"))];
  return appends.length > 0 && appends.every((m) => m[1] === "INDEX");
};

ck("ending a friendship is written somewhere it can replicate", !indexOnly("friend.end"));
ck("leaving a group is written into the group", !indexOnly("group.leave"));
ck("leaving a server is written into the server", !indexOnly("member.leave"));
ck("a group invitation is written into the conversation", !indexOnly("group.invite"));

// ---- the delivery obligations -------------------------------------------
//
// Every one of these has a sender who needs to know it arrived, and no second
// path by which the recipient could learn it.
for (const [what, kind] of [
  ["unfriending", "unfriend"],
  ["group invitations", "invite"],
  ["leaving", "leave"],
  ["kicks", "kick"],
  ["bans", "ban"],
  ["readmissions", "readmit"],
]) {
  ck(`${what} are owed until confirmed`, script.includes(`"${kind}"`),
     `owe(..., "${kind}")`);
}

ck("obligations survive a restart", /append\(INDEX, "outbox\.add"/.test(script));
ck("and are retired on a receipt", /onDelivered/.test(script));
ck("uptime is recorded, not assumed", /"uptime\.tick"/.test(script));

// ---- handlers that must run for every community --------------------------
//
// `if (community !== current) return;` is the guard that made half of these
// bugs. Anything about membership has to be handled above it, or it only
// applies to whatever happens to be on screen.
const guard = script.indexOf("if (community !== current) return;");
ck("the open-community guard is still there", guard > 0);

const beforeGuard = script.slice(0, guard);
for (const type of ["friend.end", "group.invite", "member.kick", "member.leave", "member.join"]) {
  ck(`${type} is handled regardless of what is open`,
     beforeGuard.includes(`"${type}"`));
}

// ---- standing ------------------------------------------------------------
//
// Delivery is not permission. A former friend can still hand us a signed event
// — the question is whether it may put a mark on the sidebar and make a sound.
ck("there is a standing check", /function mayReach\(/.test(script));
ck("notifications consult it", /var why = mayReach\(community, e\.author\)/.test(script));
ck("a refusal is explained to the sender", /t: "standing"/.test(script));
ck("sending is checked too, not only the disabled field",
   /function maySend\(/.test(script) && /var blockedBecause = maySend\(current\)/.test(script));

// ---- leaving actually leaves --------------------------------------------
ck("one shared exit for servers", /function departServer\(/.test(script));
ck("one shared exit for groups", /function departGroup\(/.test(script));
ck("the local removal is its own step",
   /function leaveGroupLocally\(/.test(script));

// Both leave buttons must use the shared path, or they drift — which they had.
const leaveCalls = (script.match(/departServer\(s\)/g) ?? []).length;
ck("both server leave buttons use it", leaveCalls >= 2, String(leaveCalls));

// ---- rejoining restores the sidebar --------------------------------------
//
// The eviction is recorded in three places, and clearing two of them left the
// server joined, open, rendered — and missing from the rail.
const rejoin = script.slice(script.indexOf('await window.p2p.append(data.id, "member.join"'));
for (const place of ["departed[data.id]", "delete evicted[data.id]", "delete farewells[data.id]"]) {
  ck(`rejoining clears ${place}`, rejoin.slice(0, 1400).includes(place));
}

// ---- the sync button -----------------------------------------------------
//
// It used to dial and announce, which cannot discover anything this device does
// not already know it is missing.
const sync = script.slice(script.indexOf("async function syncEverything("));
const syncBody = sync.slice(0, sync.indexOf("\n      function updateSyncFocus"));

ck("full sync re-reads direct conversations", syncBody.includes("loadRequests("));
ck("full sync flushes what is owed", syncBody.includes("flushOutbox("));
ck("full sync looks for forgotten departures", syncBody.includes("recoverDepartures("));
ck("full sync re-derives what is on screen", syncBody.includes("paintComposer("));

// ---- the membership log --------------------------------------------------
ck("membership changes are recorded", /var memberLog = \[\]/.test(script));
ck("and shown somewhere durable",
   /Recent membership changes/.test(script));

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
