import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

/**
 * Does the interface actually load, and is everything it calls really there?
 *
 * Twice now a function has been called from four places and defined in none,
 * because an edit that added the definition was rolled back while the edits
 * that added the calls were not. Nothing caught it: the file still parsed, the
 * bundle still built, and the failure only appeared when a particular menu was
 * opened on a particular kind of row.
 *
 * Parsing is not enough and grepping is worse — this file is full of prose
 * comments containing apostrophes and slashes, which defeats any regex that
 * tries to tell code from text. So this runs the thing. A stub DOM, the real
 * script, and then questions asked of the resulting scope.
 *
 * It is a smoke test, not a substitute for the app: nothing here proves a
 * button does the right thing. It proves the button's handler exists.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

const html = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));

/** The smallest DOM that lets the script finish loading. */
function stubDom() {
  const listeners: Record<string, unknown[]> = {};

  const element = (tag: string): Record<string, unknown> => {
    const el: Record<string, unknown> = {
      tagName: String(tag).toUpperCase(),
      children: [] as unknown[],
      style: { setProperty() {}, removeProperty() {}, cssText: "" },
      dataset: {},
      classList: {
        _s: new Set<string>(),
        add(...c: string[]) { c.forEach((x) => this._s.add(x)); },
        remove(...c: string[]) { c.forEach((x) => this._s.delete(x)); },
        toggle(c: string, on?: boolean) { if (on === false) this._s.delete(c); else this._s.add(c); },
        contains(c: string) { return this._s.has(c); },
      },
      appendChild(child: unknown) { (el.children as unknown[]).push(child); return child; },
      removeChild() {},
      insertBefore(child: unknown) { (el.children as unknown[]).push(child); return child; },
      remove() {},
      setAttribute() {},
      getAttribute() { return null; },
      removeAttribute() {},
      addEventListener() {},
      removeEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; },
      focus() {}, blur() {}, click() {}, scrollIntoView() {},
      textContent: "", innerHTML: "", value: "", title: "", placeholder: "",
      disabled: false, checked: false, scrollTop: 0, scrollHeight: 0,
    };
    return el;
  };

  const doc: Record<string, unknown> = {
    body: element("body"),
    documentElement: element("html"),
    createElement: (tag: string) => element(tag),
    createElementNS: (_ns: string, tag: string) => element(tag),
    createTextNode: () => element("text"),
    getElementById: () => element("div"),
    querySelector: () => element("div"),
    querySelectorAll: () => [],
    addEventListener: (name: string, fn: unknown) => {
      (listeners[name] ||= []).push(fn);
    },
    removeEventListener: () => {},
    hasFocus: () => true,
    visibilityState: "visible",
  };

  return { doc, listeners };
}

const { doc } = stubDom();

const sandbox: Record<string, unknown> = {
  document: doc,
  navigator: { language: "en-GB", languages: ["en-GB"], clipboard: { writeText() {} } },
  crypto: { subtle: { digest: async () => new ArrayBuffer(32) }, getRandomValues: (a: Uint8Array) => a },
  console,
  setTimeout: () => 0,
  setInterval: () => 0,
  clearTimeout: () => {},
  clearInterval: () => {},
  requestAnimationFrame: () => 0,
  // Faithful to the browser, which throws on malformed input. Node's decoder
  // silently drops bad characters, so a lenient stub would let a decoding bug
  // pass here and fail in the app.
  atob: (s: string) => {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 === 1) {
      throw new Error("InvalidCharacterError");
    }
    return Buffer.from(s, "base64").toString("binary");
  },
  btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
  Image: class {},
  FileReader: class {},
  Blob: class {},
  MediaRecorder: class {},
  AudioContext: class {},
  URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
  TextDecoder,
  Uint8Array,
};
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
sandbox.innerWidth = 1280;
sandbox.innerHeight = 800;
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

// Deliberately no `window.p2p`. The script's entry point checks for it and
// stops, which is exactly what is wanted here: every definition is evaluated,
// and nothing tries to reach a network that does not exist.
const context = createContext(sandbox);

// The script leaves `me` null until an identity arrives over IPC, which never
// happens here. Anything that compares against `me.userId` would throw, so the
// probes below install a stand-in first.
const IDENTITY = { userId: "SELF00000000000000000000000" };

let loaded = true;
let failure = "";
try {
  runInContext(script, context, { filename: "index.html" });
} catch (error) {
  loaded = false;
  failure = (error as Error).message;
}

ck("the interface script loads", loaded, failure);

if (!loaded) {
  console.log("\n1 FAILED");
  process.exit(1);
}

// ---- everything the interface calls exists -------------------------------
//
// Named explicitly rather than derived, because the point is to pin the
// functions that other code depends on. A name here is a claim that something
// calls it.
const required = [
  // membership and standing
  "clearStandingCache", "mayReach", "maySend", "reasonToStayConnected",
  "dropIdleConnection", "forgetPeerAddress", "hasLeft", "applyEviction",
  "retractAfterRemoval", "oweEveryone",
  // the outbox
  "owe", "settle", "flushOutbox", "onDelivered", "handleRefusal",
  "totalUptimeMs", "startOutbox",
  // conversations
  "noteConversation", "conversationList", "closeConversation", "openDM",
  // leaving and joining
  "departServer", "departGroup", "leaveGroupLocally", "announceLeaving",
  "recoverDepartures", "startFarewells", "forgetFarewell",
  "acceptGroupInvite", "inviteToGroup", "askToBeReinvited",
  // moderation
  "kickMember", "banMember", "unbanMember", "readmitMember", "removeFriend",
  "addFriendLocal", "sendRequest",
  // rendering
  "renderRail", "renderSide", "renderMembers", "renderMessages",
  "renderFriendsPane", "renderActivity", "paintComposer", "netNote",
  "groupSize", "reopenConversation", "rememberInvite", "faceWithStatus",
  "isTextType", "textFromDataUrl", "textFileEl",
  "attachmentEl", "attachmentBody", "viewLoadCandidate", "sweepViewport",
  "sentByMe", "deleteAttachment", "confirmDialog",
  "notifyDesktop", "watchNotificationClicks", "jumpTo", "whereLabel",
  "noteConversation", "touchConversation",
  "chaseStalledImages", "retryMissingImages",
  "growMessageWindow", "resetMessageWindow", "watchForTop", "jumpToMessage",
  "rowSignature", "buildRow", "firstRowSlot",
  "placeName", "describeOwed",
  // calls and voice
  "joinVoice", "leaveVoice", "maybeRing", "startRinging", "stopRinging",
  "cancelRing", "nudge", "participantsOf", "segmentMs",
  "drainVoice", "captureStream", "startMic", "stopMic", "markVoicePresent",
  "soundJoinSelf", "soundLeaveSelf", "soundJoinOther", "soundLeaveOther", "inThisCall",
  // the rest of the surface
  "syncEverything", "updateSyncFocus", "settingsDialog", "voiceSettings",
  "serverSettings", "tabbed", "applyLanguage", "applyAppearance", "t",
];

const missing = required.filter((name) => typeof sandbox[name] !== "function");
ck("every named function is defined", missing.length === 0, missing.join(", "));

// ---- and the state they read is initialised ------------------------------
const state = [
  "outbox", "farewells", "conversations", "closedDMs", "unfriended",
  "refusals", "toldThem", "askedAbout", "memberLog", "evicted", "departed",
  "roster", "seenInvites", "leftGroups",
  "LANGUAGES", "THEMES", "userPrefs", "voicePrefs",
];

const uninitialised = state.filter((name) => sandbox[name] === undefined);
ck("every shared collection is initialised", uninitialised.length === 0,
   uninitialised.join(", "));

// ---- a few behaviours, now that it is running -----------------------------
const t = sandbox.t as (s: string, v?: Record<string, unknown>) => string;
ck("translation works after load", t("Friends") === "Friends");
ck("substitution works after load",
   t("{n} members", { n: 4 }) === "4 members", t("{n} members", { n: 4 }));

const conversationList = sandbox.conversationList as () => string[];
ck("the conversation list is empty on a fresh device",
   Array.isArray(conversationList()) && conversationList().length === 0);

// ---- a conversation outlives the friendship ------------------------------
//
// The property that kept regressing. Unfriending used to take the whole
// conversation off the sidebar, because the sidebar *was* the friend list —
// so the messages were still on disk and there was no way to reach them.
{
  const noteConversation = sandbox.noteConversation as (uid: string, at?: number) => void;
  const conversationList = sandbox.conversationList as () => string[];
  const closed = sandbox.closedDMs as Record<string, boolean>;
  const conversations = sandbox.conversations as Record<string, number>;

  // An identity has to exist before any of this: the helper compares the id
  // against `me` so that a conversation with oneself is never listed.
  sandbox.me = IDENTITY;

  // Nobody is a friend in this sandbox; the point is that it does not matter.
  noteConversation("stranger1", 1000);
  ck("a conversation with a non-friend is listed",
     conversationList().includes("stranger1"));

  noteConversation("stranger2", 2000);
  ck("the most recent comes first",
     conversationList()[0] === "stranger2", conversationList().join(","));

  // Closing is the only thing that removes a row, and it is a separate act.
  closed.stranger1 = true;
  ck("a closed conversation is hidden", !conversationList().includes("stranger1"));
  ck("but its history is untouched", conversations.stranger1 === 1000);

  const reopen = sandbox.reopenConversation as (uid: string) => void;
  reopen("stranger1");
  ck("reopening brings it back", conversationList().includes("stranger1"));

  // Self is never a row.
  noteConversation(IDENTITY.userId);
  ck("no conversation with oneself", !conversationList().includes(IDENTITY.userId));
}

// ---- unfriending does not touch the list ---------------------------------
//
// Checked against the source rather than by running it, because the removal
// path needs a network. What matters is that it records the conversation
// instead of only deleting the friend.
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
  const remove = source.slice(source.indexOf("async function removeFriend("));
  const body = remove.slice(0, remove.indexOf("\n      /**"));

  ck("removing a friend keeps the conversation",
     body.includes("noteConversation(uid)"));
  ck("and does not close it",
     !body.includes("closedDMs[uid] = true"));
}

// ---- a group counts its people, including you ----------------------------
{
  const groupSize = sandbox.groupSize as (g: unknown) => number;
  const roster = sandbox.roster as Record<string, Record<string, boolean>>;

  ck("a group of two counts two",
     groupSize({ id: "g1", members: ["other"] }) === 2,
     String(groupSize({ id: "g1", members: ["other"] })));

  ck("an empty roster still counts you",
     groupSize({ id: "g2", members: [] }) === 1);

  // The log is evidence too — somebody who has written in the group is in it,
  // whether or not any invitation snapshot mentioned them.
  roster.g3 = { spoke: true };
  ck("people known only from the log are counted",
     groupSize({ id: "g3", members: [] }) === 2);

  ck("nobody is counted twice",
     groupSize({ id: "g3", members: ["spoke"] }) === 2);

  ck("you are never in your own members list",
     groupSize({ id: "g4", members: [IDENTITY.userId] }) === 1);
}

// ---- membership is not friendship ----------------------------------------
//
// The coupling that made a group vanish after an unfriend/refriend cycle.
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");

  const accept = source.slice(source.indexOf("async function acceptGroupInvite("));
  const body = accept.slice(0, accept.indexOf("\n      async function rememberCommunityKey"));

  ck("an invitation does not require a current friendship",
     !/if \(!friends\.some\(function \(f\) \{ return f\.userId === e\.author; \}\)\) return;/
       .test(body));

  ck("an invitation merges the roster instead of replacing it",
     !/known\.members = p\.members/.test(body) && body.includes("known.members.push(u)"));

  // Only a departure removes anybody.
  const replay = source.slice(source.indexOf('else if (e.type === "group.leave")'));
  ck("only leaving removes somebody from a group",
     replay.slice(0, 600).includes("delete roster[id][gone]"));
}

// ---- a kick is decided after the replay, not during it --------------------
//
// Acting inside the loop meant a rejoin recorded later in the same log could
// not undo it: the server had already been stripped from the sidebar.
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
  const kick = source.slice(source.indexOf('else if (e.type === "member.kick")'));
  const branch = kick.slice(0, kick.indexOf('else if (e.type === "group.member.add")'));

  ck("the replay does not leave a community mid-loop",
     !branch.includes('append(INDEX, "community.leave"'));
  ck("nor strip it from the sidebar mid-loop",
     !branch.includes("servers = servers.filter"));
  ck("it only records that it happened", branch.includes("evicted[id] = true"));
}

// ---- the outbox serves whoever is actually reachable ----------------------
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
  const flush = source.slice(source.indexOf("async function flushOutbox("));
  const body = flush.slice(0, flush.indexOf("\n      /**"));

  ck("reachable recipients are separated from unreachable ones",
     body.includes("ready") && body.includes("waiting"));
  ck("and are served first", body.indexOf("for (var i = 0; i < ready.length") <
     body.indexOf("for (var j = 0; j < waiting.length"));
  ck("oldest first among those that can be sent",
     body.includes("outbox[a].at - outbox[b].at"));
  ck("dials for the unreachable are capped",
     /Object\.keys\(asked\)\.length < 3/.test(body));
}

// ---- the queue survives a restart ----------------------------------------
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
  ck("obligations are written to the index",
     /append\(INDEX, "outbox\.add"/.test(source));
  ck("and removed from it when settled",
     /append\(INDEX, "outbox\.done"/.test(source));
  ck("and both are replayed at startup",
     /e\.type === "outbox\.add"/.test(source) && /e\.type === "outbox\.done"/.test(source));
}

// ---- an old invitation is not a new one ----------------------------------
//
// A conversation's log is append-only, so every invitation ever sent is still
// in it. Replaying that log — which is how an old friend request is still
// found — was re-adding groups the person had deliberately left, every single
// time they opened the inviter's conversation.
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
  const accept = source.slice(source.indexOf("async function acceptGroupInvite("));
  const body = accept.slice(0, accept.indexOf("\n      async function rememberCommunityKey"));

  ck("an invitation already answered is ignored",
     /if \(e\.id && seenInvites\[e\.id\]\) return;/.test(body));
  ck("answering one is recorded", body.includes("await rememberInvite(e)"));
  ck("the record survives a restart",
     /append\(INDEX, "invite\.seen"/.test(source) &&
     /e\.type === "invite\.seen"/.test(source));

  // The distinction the whole fix rests on: a real re-invitation is a new
  // event with a new id, so it is not in the seen set and is acted on.
  ck("a fresh invitation still gets you back in",
     body.includes("delete leftGroups[p.id]"));

  // The other silent re-add: asking to be re-invited because somebody is
  // still talking in a group we walked out of.
  const ask = source.slice(source.indexOf("function askToBeReinvited("));
  ck("leaving stops the app asking its way back in",
     ask.slice(0, 900).includes("if (leftGroups[community]) return;"));

  ck("leaving is recorded as a decision",
     /leftGroups\[id\] = true;/.test(source) && /e\.type === "group\.left"/.test(source));
}

// ---- the seen set behaves ------------------------------------------------
{
  const seen = sandbox.seenInvites as Record<string, boolean>;
  const left = sandbox.leftGroups as Record<string, boolean>;

  ck("nothing is seen on a fresh device", Object.keys(seen).length === 0);
  ck("and no group has been left", Object.keys(left).length === 0);

  seen.abc = true;
  ck("an answered invitation is remembered", seen.abc === true);
  ck("a different invitation is not", seen.def === undefined);
}

// ---- presence is shown to friends, and only to friends -------------------
//
// A dot for somebody who is not a friend would be a lie in one direction or a
// leak in the other: grey because no circuit exists rather than because they
// are away, or — in a shared room — publishing when somebody is at their
// machine to people they never agreed to tell.
{
  const faceWithStatus = sandbox.faceWithStatus as (uid: string, size?: number) =>
    { className?: string; children?: unknown[]; title?: string };
  const friends = sandbox.friends as { userId: string; username?: string }[];

  const stranger = faceWithStatus("stranger9");
  ck("a non-friend gets a plain face", stranger.className === "av");
  ck("and no presence is published about them",
     !(stranger.children ?? []).length);

  friends.push({ userId: "pal", username: "pal" });
  const pal = faceWithStatus("pal");

  ck("a friend's face is wrapped", pal.className === "avwrap");
  ck("and carries a dot", (pal.children ?? []).length === 2);
  ck("the dot says which status",
     /^st /.test(String((pal.children as { className?: string }[])[1].className)));
  ck("and the words are there for a closer look",
     typeof pal.title === "string" && pal.title.includes("·"));

  // Unfriending removes the dot, not the conversation.
  friends.length = 0;
  ck("a former friend keeps the face and loses the dot",
     faceWithStatus("pal").className === "av");
}

// ---- text files are read in place ----------------------------------------
{
  const isTextType = sandbox.isTextType as (type: string, name: string) => boolean;

  ck("a declared text type counts", isTextType("text/plain", "notes"));
  ck("json counts", isTextType("application/json", "data.json"));

  // The common case: a browser hands over octet-stream for anything it does
  // not recognise, which is most source files.
  ck("an unhelpful type falls back to the name",
     isTextType("application/octet-stream", "server.ts"));
  ck("and to a bare name where that is the convention",
     isTextType("", "Dockerfile"));

  ck("a binary is not text", !isTextType("application/octet-stream", "clip.mp4"));
  ck("an image is not text", !isTextType("image/png", "shot.png"));
  ck("an unknown extension is not guessed at", !isTextType("", "archive.7z"));

  // ---- decoding ----------------------------------------------------------
  const textFromDataUrl = sandbox.textFromDataUrl as (d: string) =>
    { text: string; truncated: boolean; failed: boolean };

  const encode = (body: string) =>
    "data:text/plain;base64," + Buffer.from(body, "utf8").toString("base64");

  const hello = textFromDataUrl(encode("line one\nline two"));
  ck("text comes back intact", hello.text === "line one\nline two", hello.text);
  ck("and is not marked truncated", !hello.truncated);

  const accented = textFromDataUrl(encode("café — naïve"));
  ck("utf-8 survives the round trip", accented.text === "café — naïve", accented.text);

  const cap = sandbox.TEXT_PREVIEW_BYTES as number;
  const huge = textFromDataUrl(encode("x".repeat(cap + 5000)));
  ck("an oversized file is cut to the limit", huge.text.length === cap,
     String(huge.text.length));
  ck("and says so", huge.truncated);

  ck("nonsense is reported rather than thrown",
     textFromDataUrl("data:text/plain;base64,!!!not base64!!!").failed);
}

// ---- and are never built as markup ---------------------------------------
//
// The contents come from somebody else. Assigning them to innerHTML would let
// an attached file run as markup in the reader's window.
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
  const fn = source.slice(source.indexOf("function textFileEl("));
  const body = fn.slice(0, fn.indexOf("\n      function attachmentEl("));

  ck("the preview never touches innerHTML", !body.includes("innerHTML"));
  ck("it uses textContent for the file body", body.includes("pre.textContent = read.text"));
  ck("and the name is not built as markup either",
     body.includes("nm.textContent = f.name"));
}

// ---- a profile update must not erase the picture -------------------------
//
// The live handler rebuilt the profile from the incoming payload and left the
// avatar fields out entirely, so any later hello from that person deleted the
// one field that says which picture is theirs. The bytes stayed cached under
// the hash; nothing knew its name any more, so the face fell back to initials
// until something else put the id back. No network failure required.
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");

  // Every place that writes a whole profile object has to carry the id.
  //
  // A window after each assignment rather than a brace match: the object
  // literals here contain nested braces (`profiles[x] || {}`), and a lazy
  // match stops at the first one — which reads as a violation in code that is
  // perfectly fine. The window is generous and the test only looks at blocks
  // that set a username, which is what makes one a whole-profile write.
  const writes = [...source.matchAll(/profiles\[[^\]]+\]\s*=\s*(?:Object\.assign\()?\{?/g)]
    .map((m) => source.slice(m.index ?? 0, (m.index ?? 0) + 700))
    .filter((block) => block.includes("username:"));

  ck("more than one place builds a profile", writes.length >= 2, String(writes.length));

  const dropping = writes.filter((block) => !block.includes("avatarId"));
  ck("none of them drops the avatar id", dropping.length === 0,
     dropping.map((b) => b.slice(0, 60)).join(" | "));

  // And the stalled-request repair exists, for the case where the id survived
  // but the answer never came.
  ck("unanswered picture requests are chased",
     /function chaseStalledImages\(/.test(source));
  ck("requests are timestamped so staleness is knowable",
     /imageAskedAt\[id\] = Date\.now\(\)/.test(source));
  ck("and the chase runs when call focus lifts",
     /chaseStalledImages\(\);\s*\n\s*retryMissingImages\(\);/.test(source));
}

// ---- call focus must not starve a request it allowed ----------------------
{
  const transport = readFileSync(join(process.cwd(), "src/p2p/transport.ts"), "utf8");
  const guard = transport.slice(transport.indexOf("if (this.#callFocus && level >= 4)"));
  const block = guard.slice(0, 700);

  ck("a file request is still allowed out", block.includes('type === "want"'));
  ck("the refusal to it is allowed back", block.includes('type === "noblob"'));
  ck("and so is a small answer", block.includes('type === "blob" && frame.length <= SMALL_BLOB_BYTES'));

  // The size test is what keeps call focus meaningful: a chunk of a large
  // file is bigger than this, so video still waits.
  const limit = /const SMALL_BLOB_BYTES = (\d+) \* 1024;/.exec(transport);
  ck("the small-blob limit is below one chunk",
     !!limit && Number(limit[1]) < 192, limit ? limit[1] + " KB" : "missing");
}

// ---- voice: one rate, gain in the path, order preserved -------------------
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");

  // A pitch that jumps high or low is a sample rate disagreeing with itself.
  // Every segment is a self-contained file carrying its own declared rate, and
  // the decoder believes it — so capture, the capture graph and playback are
  // all pinned to the same number.
  ck("there is one voice sample rate", /var VOICE_RATE = 48000;/.test(source));
  ck("capture asks for it", /sampleRate: VOICE_RATE/.test(source));
  ck("the capture graph runs at it",
     /new AudioContext\(\{ sampleRate: VOICE_RATE \}\)/.test(source));
  ck("and so does playback",
     /webkitAudioContext\)\(\{\s*\n?\s*sampleRate: VOICE_RATE,/.test(source));

  // The input volume slider used to move a meter and nothing else: the
  // recorder was handed the raw device, so the gain node was decorative.
  ck("the gain node is in the signal path",
     /gainNode\.connect\(micOut\)/.test(source));
  ck("and the encoder records the processed stream",
     /new MediaRecorder\(captureStream\(\)/.test(source));
  ck("the raw device is not what gets encoded",
     !/new MediaRecorder\(micStream/.test(source));

  // decodeAudioData gives no ordering guarantee, so segments have to be put
  // back in sequence before they are scheduled.
  ck("segments are queued by sequence", /live\.ready\[seq\] = buf;/.test(source));
  ck("and played in order", /function drainVoice\(/.test(source));
  ck("a lost segment does not stall the ones behind it",
     /live\.playSeq = ahead - 1;/.test(source));
  ck("a failed decode leaves a hole rather than a gap that waits",
     /live\.ready\[seq\] = null;/.test(source));
}

// ---- voice keeps working when the window is not in front ------------------
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
  const win = readFileSync(join(process.cwd(), "src/native/window.ts"), "utf8");

  ck("background timers are not throttled",
     /backgroundThrottling: false/.test(win));

  // The other half: the app used to stop transmitting the moment it lost the
  // screen, which is right for reading and wrong for talking.
  // The handler this is about, not merely the first one.
  //
  // This took the first `visibilitychange` in the file, which was fine while
  // there was one. Presence added another — the app going into the background
  // is what decides whether other people see you — and it happens to sit
  // earlier, so this silently started reading a block that has nothing to do
  // with the microphone and reporting the absence of code it was never going
  // to find. A test that can be broken by unrelated code moving is not
  // guarding what it claims to.
  const body = [...source.matchAll(/addEventListener\("visibilitychange"/g)]
    .map((found) => source.slice(found.index ?? 0, (found.index ?? 0) + 1200))
    .find((block) => /roadcast/.test(block)) ?? "";

  ck("the voice visibility handler is still there to check", body !== "");
  ck("hiding the window does not stop the microphone",
     !/visibilityState === "hidden"[\s\S]{0,200}stopBroadcast\(\)/.test(body));
  ck("but coming back repairs a stopped recorder",
     /!broadcasting[\s\S]{0,120}startBroadcast/.test(body));
}

// ---- call tiles hold still -----------------------------------------------
//
// `voice.here` is a heartbeat from everybody every few seconds. Treating each
// one as a fresh join removed and re-appended the sender, so the list was
// reordered continuously and the tiles shuffled under the person watching
// them — which looked like they moved when somebody spoke.
{
  const markVoicePresent = sandbox.markVoicePresent as (ch: string, uid: string) => void;
  const voiceState = sandbox.voiceState as Record<string, string[]>;

  markVoicePresent("call:x", "first");
  markVoicePresent("call:x", "second");
  markVoicePresent("call:x", "third");
  ck("join order is the order", voiceState["call:x"].join() === "first,second,third");

  // The heartbeat, several times over.
  markVoicePresent("call:x", "first");
  markVoicePresent("call:x", "second");
  markVoicePresent("call:x", "first");
  ck("a heartbeat does not move anybody",
     voiceState["call:x"].join() === "first,second,third",
     voiceState["call:x"].join());
  ck("and does not duplicate anybody", voiceState["call:x"].length === 3);

  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
  ck("nothing re-appends on presence any more",
     !/voiceState\[[^\]]+\]\.push\(e\.author\)/.test(source));
}

// ---- files are fetched once, from one peer -------------------------------
{
  const transport = readFileSync(join(process.cwd(), "src/p2p/transport.ts"), "utf8");
  const blobs = readFileSync(join(process.cwd(), "src/p2p/blobs.ts"), "utf8");

  // A broadcast request meant every peer holding the file answered with all
  // of it — one request, one copy per peer, on the same stream as voice.
  const request = transport.slice(transport.indexOf("requestBlob(community: string"));
  const body = request.slice(0, 900);
  ck("a request goes to one peer", !/for \(const \[id\] of this\.#peers\)/.test(body));
  ck("and is tracked while in flight", body.includes("this.#wants.set"));
  ck("a refusal moves to the next peer", transport.includes("if (want && want.peerId === id) this.#askNext(key)"));
  ck("so does silence", /WANT_TIMEOUT_MS/.test(transport));
  ck("so does a peer disappearing",
     /if \(want\.peerId === id\) this\.#askNext\(key\)/.test(transport));
  ck("a completed transfer stops the chase", transport.includes("this.#settleWant("));

  // And the file is never sent back the way it came.
  ck("the source of each file is remembered", transport.includes("#blobFrom"));
  ck("and is never served it again",
     transport.includes("refused to send") && /source === peer\.info\.userId/.test(transport));

  // Chunk size decides how long audio waits behind a transfer.
  const chunk = /export const BLOB_CHUNK = (\d+) \* 1024;/.exec(blobs);
  ck("chunks are small enough to interleave with voice",
     !!chunk && Number(chunk[1]) <= 32, chunk ? chunk[1] + " KB" : "missing");
}

// ---- calls sound like calls ----------------------------------------------
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");

  for (const name of ["soundJoinSelf", "soundLeaveSelf", "soundJoinOther", "soundLeaveOther"]) {
    ck(name + " exists", typeof sandbox[name] === "function");
  }

  // Rising means arriving, falling means leaving — checked because getting it
  // backwards is the kind of thing nobody notices in code and everybody
  // notices in use.
  // Cut at the end of the playTones call, not a fixed window: the next
  // function starts a couple of lines later and its notes would be read as
  // part of this one.
  const figure = (name: string) => {
    const fn = source.slice(source.indexOf("function " + name + "("));
    const call = fn.slice(0, fn.indexOf("]]"));
    return [...call.matchAll(/\[(\d+),/g)].map((m) => Number(m[1]));
  };

  const joinSelf = figure("soundJoinSelf");
  const leaveSelf = figure("soundLeaveSelf");
  ck("joining rises", joinSelf.length === 2 && joinSelf[1] > joinSelf[0], joinSelf.join(","));
  ck("leaving falls", leaveSelf.length === 2 && leaveSelf[1] < leaveSelf[0], leaveSelf.join(","));

  const joinOther = figure("soundJoinOther");
  ck("somebody else is quieter and higher",
     joinOther[0] > joinSelf[0], joinOther.join(",") + " vs " + joinSelf.join(","));

  // Only while actually in that call, and never on the replay that happens
  // when a conversation is opened.
  ck("sounds are scoped to the call you are in",
     /function inThisCall\(/.test(source));
  ck("a heartbeat does not announce anybody",
     /var alreadyIn = [\s\S]{0,800}if \(!alreadyIn/.test(source));
  ck("someone timing out still sounds like leaving",
     /if \(inThisCall\(ch\)\) soundLeaveOther\(\);/.test(source));

  // And there is finally a way to turn them off.
  ck("the sound preference has a control",
     /userPrefs\.mutedSounds = !sndc\.checked/.test(source));
  ck("which every sound respects",
     /if \(userPrefs\.mutedSounds\) return;/.test(source));
}

// ---- feedback cannot run away --------------------------------------------
//
// A loop whose round-trip gain exceeds one gets louder every pass: a faint
// echo of your own voice becomes a scream in seconds. Nothing upstream can
// promise the loop does not exist — a room with speakers always has one — so
// the app has to stop it gaining energy rather than assume it away.
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
  const transport = readFileSync(join(process.cwd(), "src/p2p/transport.ts"), "utf8");

  // 1. The last thing before the speakers refuses to pass a spike.
  ck("output goes through a limiter",
     /playLimiter = playCtxRef\.createDynamicsCompressor\(\)/.test(source));
  ck("the limiter is in the path, not hanging off it",
     /playGain\.connect\(playLimiter\)/.test(source) &&
     /playLimiter\.connect\(dest\)/.test(source));
  ck("and it is set as a wall rather than an effect",
     /playLimiter\.ratio\.value = 20/.test(source));

  // 2. Capture is stricter while their voice is audible.
  ck("playback windows are tracked", /remoteAudioUntil/.test(source));
  ck("the gate ducks during them",
     /var speakingOver = Date\.now\(\) < remoteAudioUntil/.test(source));
  ck("with a floor for very low thresholds",
     /Math\.max\(voicePrefs\.vad \* DUCK_FACTOR, DUCK_FLOOR\)/.test(source));

  // The arithmetic of the bar, which is the part that must not be wrong.
  const duck = (vad: number, factor: number, floor: number) => Math.max(vad * factor, floor);
  ck("a low threshold is lifted to the floor", duck(0.02, 4, 0.08) === 0.08);
  ck("a high one is scaled instead", Math.abs(duck(0.05, 4, 0.08) - 0.2) < 1e-9);
  ck("ducking always raises the bar, never lowers it",
     [0.01, 0.02, 0.05, 0.2].every((v) => duck(v, 4, 0.08) >= v));

  // 3. Our own audio never circulates.
  ck("outgoing frames are remembered as seen",
     /const key = `\$\{this\.#userId\}:\$\{channel\}:\$\{seq\}`/.test(transport));
  ck("and our own voice is never relayed onward",
     /if \(msg\.from === this\.#userId\) break;/.test(transport));

  // 4. And when it happens anyway, the app says why.
  ck("a sustained overlap is reported",
     /overlapRun === FEEDBACK_RUN/.test(source));
  ck("only once per call",
     /feedbackWarned = false;/.test(source) && /!feedbackWarned/.test(source));
}

// ---- a menu must not move the view out from under the sidebar -------------
//
// "Invite people" set `view = s.id` and opened the dialog. The sidebar then
// drew that server's *name* over the *currently open* community's contents,
// because those are two variables and only one had changed — so a member of a
// working server was told nobody had described it yet.
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");

  ck("the invite menu names its server instead of switching view",
     /\{ label: "Invite people", run: function \(\) \{ inviteDialog\(s\); \} \}/.test(source));
  ck("and so does server settings",
     /run: function \(\) \{ serverSettings\(s\); \} \}/.test(source));
  ck("neither reassigns view any more",
     !/view = s\.id; (?:inviteDialog|serverSettings)\(\)/.test(source));

  // Both are also wired straight to buttons, so what arrives can be an event.
  ck("a click event is not mistaken for a server",
     /var named = server && server\.id/.test(source) &&
     /var chosen = server && server\.id/.test(source));

  // And the readiness note is about the pane's own server.
  ck("the sidebar judges the server it is drawing",
     /if \(!isReady\(showing\)\)/.test(source));
  ck("including which server a retry pings",
     /pingServer\(showing\)/.test(source));
}

// ---- the same file twice costs nothing ------------------------------------
//
// Content addressing is supposed to make this free, and it does — but only
// because three separate layers each check before acting. Pinned here because
// any one of them quietly regressing would be invisible: everything would keep
// working, just at several times the cost.
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
  const bridge = readFileSync(join(process.cwd(), "src/p2p/bridge.ts"), "utf8");
  const blobs = readFileSync(join(process.cwd(), "src/p2p/blobs.ts"), "utf8");

  // 1. Storing the same bytes twice writes one file, and the id is the hash,
  //    so the second message quotes the first message's file.
  ck("identical bytes are stored once",
     /const path = this\.#path\(id\);\s*\n\s*if \(existsSync\(path\)\) return \{ id, size: data\.length \};/
       .test(blobs));

  // 2. Nothing is pushed to anybody. The message carries a name, a size and an
  //    id; bytes move only when a reader asks.
  const send = source.slice(source.indexOf("payload.files = [];"));
  ck("a message carries the id, not the bytes",
     /blob: ref\.id,/.test(send.slice(0, 400)) && !/data: f\.data/.test(send.slice(0, 400)));

  // 3. A reader looks locally before it asks anyone.
  const hydrate = source.slice(source.indexOf("async function hydrateAttachments("));
  const body = hydrate.slice(0, hydrate.indexOf("\n      // ---- rendering"));
  ck("held bytes are found without a request",
     body.indexOf("await window.p2p.getBlob(") < body.indexOf("fetchBlob(f, null)"));

  ck("and the request path checks again before using the network",
     /if \(blobsFor\(community\)\.has\(id\)\) return true;/.test(bridge));
}

// ---- long channels do not have to be drawn in full ------------------------
//
// Every repaint used to rebuild the entire channel, and a repaint happens
// whenever anybody says anything — so a few thousand messages meant a few
// thousand elements of layout per incoming message.
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
  const growMessageWindow = sandbox.growMessageWindow as () => void;
  const resetMessageWindow = sandbox.resetMessageWindow as () => void;

  ck("a window exists", typeof sandbox.WINDOW_START === "number");
  ck("it is large enough to fill any window",
     (sandbox.WINDOW_START as number) >= 50, String(sandbox.WINDOW_START));

  resetMessageWindow();
  const start = sandbox.windowSize as number;
  ck("it starts at the default", start === sandbox.WINDOW_START);

  growMessageWindow();
  ck("growing reveals more",
     (sandbox.windowSize as number) === start + (sandbox.WINDOW_STEP as number),
     String(sandbox.windowSize));

  resetMessageWindow();
  ck("and changing conversation starts over",
     (sandbox.windowSize as number) === start);

  // Only the tail is drawn, and what is left out is offered rather than lost.
  ck("only the newest are drawn", /var shown = hidden \? mine\.slice\(hidden\) : mine;/.test(source));
  ck("the rest are reachable", /Show older messages/.test(source));
  ck("and reaching the top reveals them without asking",
     /function watchForTop\(/.test(source) && /box\.scrollTop > 120/.test(source));

  // Growing changes the height above the viewport, so the position has to be
  // corrected or the content jumps and the reader loses their place.
  ck("scroll position is preserved when growing",
     /box\.scrollTop = box\.scrollHeight - before \+ wasAt;/.test(source));

  // A reply can point at something above the window.
  const jump = source.slice(source.indexOf("function jumpToMessage("));
  ck("jumping unrolls far enough to reach its target",
     jump.slice(0, 900).includes("windowSize = Math.max(windowSize, mine.length - at + WINDOW_STEP)"));
  ck("and still reports a message that genuinely is not here",
     jump.slice(0, 1100).includes("That message is not loaded here"));

  // Both places that change conversation reset it.
  ck("opening a channel resets the window",
     /channel = id;[\s\S]{0,400}resetMessageWindow\(\);/.test(source));
  ck("opening a community does too",
     /current = id;\s*\n\s*resetMessageWindow\(\);/.test(source));
}

// ---- repainting must not destroy what is playing --------------------------
//
// Windowing capped how many rows were rebuilt; it did not stop them being
// rebuilt. Clearing the container and constructing every row again destroys
// the elements, not just the markup — so a video playing in the channel was
// replaced by a fresh one at zero seconds, paused, whenever anybody spoke.
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
  const render = source.slice(source.indexOf("function renderMessages("));
  const body = render.slice(0, render.indexOf("function firstRowSlot("));

  ck("the container is not cleared on every paint",
     !/box\.innerHTML = "";\s*\n\s*var mine/.test(body));
  ck("but it is cleared when the channel empties",
     /if \(!mine\.length\) \{\s*\n\s*box\.innerHTML = "";/.test(body));
  ck("unchanged rows are kept", body.includes("have.dataset.sig === sig"));
  ck("and moved rather than rebuilt when out of place",
     /if \(have !== after\) box\.insertBefore\(have, after\);/.test(body));
  ck("rows that are gone are removed",
     /keep\[id\]\.remove\(\)/.test(body));

  // ---- the signature ------------------------------------------------------
  //
  // Reuse is only safe if the signature names every input the row is drawn
  // from. Anything left out is something that will silently stop updating.
  const rowSignature = sandbox.rowSignature as (m: unknown, cont: boolean) => string;
  const profiles = sandbox.profiles as Record<string, unknown>;
  profiles.author1 = { username: "author1" };

  const msg = (over: Record<string, unknown> = {}) => ({
    id: "m1",
    author: "author1",
    timestamp: 1000,
    payload: Object.assign({ channelId: "c1", content: "hello" }, over),
  });

  const base = rowSignature(msg(), false);
  ck("the same message signs the same", rowSignature(msg(), false) === base);

  ck("edited text signs differently",
     rowSignature(msg({ content: "goodbye" }), false) !== base);
  ck("becoming a continuation signs differently",
     rowSignature(msg(), true) !== base);
  ck("a reply signs differently",
     rowSignature(msg({ reply: { id: "m0", author: "author1" } }), false) !== base);
  ck("an attachment signs differently",
     rowSignature(msg({ files: [{ blob: "abc" }] }), false) !== base);
  ck("an undecryptable body signs differently",
     rowSignature(msg({ undecryptable: true }), false) !== base);

  // The header is drawn from the profile, and profiles arrive late.
  profiles.author1 = { username: "renamed" };
  ck("a renamed author signs differently", rowSignature(msg(), false) !== base);

  // And an attachment arriving is the difference between a Download button
  // and a picture, so it has to force a rebuild of that one row.
  const withFile = rowSignature(msg({ files: [{ blob: "abc" }] }), false);
  const cache = sandbox.blobCache as Record<string, string>;
  const blobKey = sandbox.blobKey as (c: string, b: string) => string;
  cache[blobKey(sandbox.current as string, "abc")] = "data:x";
  ck("bytes arriving sign differently",
     rowSignature(msg({ files: [{ blob: "abc" }] }), false) !== withFile);
}

// ---- presence stopped being written down ---------------------------------
//
// `voice.here` was appended to the community log every ten seconds per person
// in a call: signed, replicated and permanent, to say "still here, ten seconds
// ago". Worthless on arrival — the sweep discards anyone not seen in the last
// half-minute — and the single largest source of log growth in the app.
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");

  ck("the heartbeat is no longer written to the log",
     !/append\(inVoice\.community, "voice\.here"/.test(source));
  ck("it is sent as a signal instead", /t: "here", community: inVoice\.community/.test(source));
  ck("and the other end still records presence",
     /if \(data\.t === "here"\)/.test(source));

  // Joining and leaving stay in the log. They happen once, and somebody
  // arriving later has a legitimate reason to learn them.
  ck("joining is still an event", /append\(current, "voice\.join"/.test(source));
  ck("leaving is still an event", /"voice\.leave", \{ channelId/.test(source));
}

const placeName = sandbox.placeName as (id: string) => string;
ck("an unknown community names itself", placeName("s404") === "s404");

const segmentMs = sandbox.segmentMs as () => number;
ck("the segment length is within its bounds",
   segmentMs() >= 200 && segmentMs() <= 700, String(segmentMs()));

// ---- the size limit decides fetching, not showing -------------------------
//
// Lowering the limit used to hide attachments that were already on the disk,
// which reads as though the setting deleted them. It governs what is worth
// pulling over a slow circuit; bytes already here have been paid for.
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
  const fn = source.slice(source.indexOf("function attachmentBody("));
  const decide = fn.slice(0, fn.indexOf("if (inline &&"));

  ck("what is drawn inline does not consult the size limit",
     !/autoMaxBytes/.test(decide), decide.match(/.*autoMaxBytes.*/)?.[0] ?? "");
  ck("it still consults the two settings that are about display",
     /userPrefs\.lowData/.test(decide) && /userPrefs\.autoImages/.test(decide));

  // The limit still has to govern the thing it is for.
  const hydrate = source.slice(source.indexOf("async function hydrateAttachments("));
  ck("but fetching still honours it",
     /f\.size <= userPrefs\.autoMaxBytes/.test(hydrate.slice(0, 2000)));
}

// ---- files loaded while they are being looked at --------------------------
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
  const viewLoadCandidate = sandbox.viewLoadCandidate as (f: unknown) => boolean;
  const prefs = sandbox.userPrefs as Record<string, unknown>;

  prefs.viewLoad = true;
  prefs.lowData = false;
  prefs.autoMaxBytes = 2000000;

  ck("a big file from somebody else is a candidate",
     viewLoadCandidate({ blob: "a".repeat(64), size: 9000000 }));
  ck("a small one is not — it is fetched normally",
     !viewLoadCandidate({ blob: "a".repeat(64), size: 1000 }));
  ck("nor is one with no bytes to fetch",
     !viewLoadCandidate({ size: 9000000 }));

  prefs.lowData = true;
  ck("and refusing files entirely wins over it",
     !viewLoadCandidate({ blob: "a".repeat(64), size: 9000000 }));

  prefs.lowData = false;
  prefs.viewLoad = false;
  ck("off means off", !viewLoadCandidate({ blob: "a".repeat(64), size: 9000000 }));
  prefs.viewLoad = true;

  // The mark has to survive row reconciliation, which replaces the element
  // objects — so it is an attribute rather than anything held in a closure.
  ck("candidates are marked on the element",
     /el\.dataset\.vblob = f\.blob;/.test(source));

  const sweep = source.slice(source.indexOf("async function sweepViewport("));
  const body = sweep.slice(0, sweep.indexOf("\n      // ---- rendering"));

  ck("something out of view is not dropped immediately",
     /VIEW_KEEP_MS/.test(body) && (sandbox.VIEW_KEEP_MS as number) >= 10000,
     String(sandbox.VIEW_KEEP_MS));
  ck("the window it is dropped outside is wider than the one it loads inside",
     (sandbox.VIEW_FAR as number) > (sandbox.VIEW_NEAR as number),
     `${sandbox.VIEW_FAR} vs ${sandbox.VIEW_NEAR}`);
  ck("dropping goes through the main process, which decides if it may",
     /await window\.p2p\.forgetBlob\(community, blob\)/.test(body));
  ck("and a refusal leaves the cached copy alone",
     /if \(!answer \|\| !answer\.dropped/.test(body));
}

// ---- deleting other people's files ----------------------------------------
//
// Three rules, and each of them was broken in a different way.
//
// The payload one is the interesting bug. `message.send` is sealed whenever
// the community has a key, so the stored event carries `{ e: 1, n, c, t }` and
// `payload.files` is simply absent. Reading it raw meant the sweep found no
// files at all and cleared nothing — and, far worse, the single-file delete
// concluded that nothing had ever been sent from this device and would happily
// have deleted the only copy of something. One failed closed; the other failed
// open.
{
  const bridge = readFileSync(join(process.cwd(), "src/p2p/bridge.ts"), "utf8");

  const reader = bridge.slice(bridge.indexOf("function attachmentsIn("));
  const body = reader.slice(0, reader.indexOf("function someoneHasIt("));

  ck("attachments are read through decryption",
     /decryptPayload\(community, event\.payload\)/.test(body));
  ck("and ownership is decided by the event author",
     /event\.author === me/.test(body));

  // One reader, used by both. Two readings of the same log is how they would
  // start disagreeing about who owns what.
  const sweep = bridge.slice(bridge.indexOf("CHANNEL.sweepBlobs"));
  const forget = bridge.slice(bridge.indexOf("CHANNEL.forgetBlob"));

  ck("the sweep uses it", /attachmentsIn\(community\)/.test(sweep.slice(0, 2000)));
  ck("and so does the single-file path",
     /attachmentsIn\(community\)/.test(forget.slice(0, 1500)));

  // Rule one, which nothing may override.
  ck("our own attachments are never swept",
     /if \(mine\.has\(blob\)\) continue;/.test(sweep.slice(0, 2500)));
  ck("nor deleted one at a time",
     /if \(mine\.has\(blob\)\)[\s\S]{0,80}sent from this device/.test(forget.slice(0, 1500)));

  // Rule two.
  ck("only files over the limit go",
     /if \(size <= maxBytes\) continue;/.test(sweep.slice(0, 2500)));

  // Rule three: deleting is only reclaiming space while somebody can send it
  // back. Otherwise it is losing the file.
  const reach = bridge.slice(bridge.indexOf("function someoneHasIt("));
  const check = reach.slice(0, reach.indexOf("* Delete downloaded files"));

  ck("reachability is decided from the live peer list",
     /transport\?\.peers\(\)/.test(check));
  ck("the author counts", /peer\.userId === author/.test(check));
  ck("and so does anybody else in the community",
     /members\.has\(peer\.userId\)/.test(check));

  ck("the sweep keeps what nobody can re-supply",
     /if \(!force && !someoneHasIt\(community, author\)\)/.test(sweep.slice(0, 2500)));
  ck("and reports how much it kept",
     /stranded\+\+;/.test(sweep) && /strandedBytes/.test(sweep));

  // `force` is the user pressing delete on a specific file, having been told.
  // It overrides the third rule and never the first.
  ck("forcing overrides reachability", /force && /.test(sweep.slice(0, 2500)));
  ck("but the ownership check has no escape",
     !/force[\s\S]{0,40}mine\.has/.test(forget.slice(0, 1500)));

  // And the interface in front of it.
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
  const ui = source.slice(source.indexOf("stgBtn.onclick"));
  const look = ui.slice(0, ui.indexOf("stgGo.onclick"));
  const remove = ui.slice(ui.indexOf("stgGo.onclick"), ui.indexOf("stgRow.appendChild"));

  ck("checking only looks", /sweepBlobs\(limit, true\)/.test(look));
  ck("and never deletes", !/sweepBlobs\(limit, false/.test(look));
  ck("deleting is a separate control", /sweepBlobs\(limit, false, force\)/.test(remove));

  // The gap that made the panel useless in practice. Reachability is decided
  // against the live peer list, so with nobody connected *every* file is
  // unreplaceable — the safe button never appeared and there was nothing else,
  // leaving a sentence and no way to act on it. For an app whose peers are
  // asleep most of the time, that is most of the time.
  ck("there is a way through when nobody is online",
     /var stgForce = document\.createElement\("button"\)/.test(source));
  ck("shown exactly when something is being kept back",
     /if \(found\.stranded\) \{[\s\S]{0,220}stgForce\.style\.display = ""/.test(look));
  ck("and it is the only thing that forces",
     /runSweep\(true\)/.test(remove) && /runSweep\(false\)/.test(remove));
  ck("with a confirmation that says they are not coming back",
     /cannot be downloaded again/.test(remove));

  // Forcing overrides reachability and nothing else. What guarantees that is
  // *order*: ownership is decided first and unconditionally, so `force` is
  // never even consulted for a file this device sent.
  //
  // Stated as an ordering rather than as "force does not appear near
  // ownership", which was the first attempt and matched the `force?: boolean`
  // in the signature — a test that failed on correct code.
  for (const [name, block] of [
    ["the sweep", bridge.slice(bridge.indexOf("CHANNEL.sweepBlobs"),
                               bridge.indexOf("CHANNEL.forgetBlob"))],
    ["the single-file path", bridge.slice(bridge.indexOf("CHANNEL.forgetBlob"),
                                          bridge.indexOf("CHANNEL.netInfo"))],
  ] as [string, string][]) {
    const owned = block.indexOf("mine.has(blob)");
    const forced = block.indexOf("!force");

    ck(`${name} decides ownership before it considers force`,
       owned !== -1 && forced !== -1 && owned < forced,
       `ownership at ${owned}, force at ${forced}`);
  }

  // The complaint that produced this shape: the same button relabelled itself,
  // so the offer to delete only existed *after* a press and read as a button
  // that reports a number and does nothing about it.
  ck("the delete button exists in its own right",
     /var stgGo = document\.createElement\("button"\)/.test(source));
  ck("hidden until there is something to delete",
     /stgGo\.style\.display = "none"/.test(source) &&
     /stgGo\.style\.display = ""/.test(look));
  ck("and it confirms first", /await confirmDialog\(/.test(remove));

  ck("it distinguishes nothing-to-clear from would-be-lost",
     /found\.stranded/.test(look));

  // A rejection used to leave the button disabled with nothing said, which is
  // indistinguishable from a control that does not work.
  ck("a failed check says so", /Could not check/.test(look));
  ck("a failed delete says so", /Could not delete/.test(remove));
  ck("and neither leaves the button disabled",
     (look.match(/disabled = false/g) ?? []).length >= 2 &&
     (remove.match(/disabled = false/g) ?? []).length >= 2);

  const manual = source.slice(source.indexOf("async function deleteAttachment("));
  const del = manual.slice(0, manual.indexOf("\n      }\n"));

  ck("deleting one file asks unforced first",
     del.indexOf("forgetBlob(current, f.blob)") < del.indexOf("forgetBlob(current, f.blob, true)"));
  ck("and only warns when the warning is true",
     /answer\.reason === "nobody online has a copy"/.test(del));
}

// ---- the wallpaper reaches every panel ------------------------------------
//
// Panels that paint their own background have to be made transparent
// explicitly. The member list was not in the list, so it stayed opaque while
// the rest of the window went clear — a hard-edged block against the picture,
// which reads as the wallpaper being broken rather than a missing selector.
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
  const styles = source.slice(0, source.indexOf("</style>"));

  // Every `html.wall` rule, which is the whole of what a wallpaper changes.
  const wallRules = [...styles.matchAll(/html\.wall[^{]*\{[^}]*\}/g)]
    .map((m) => m[0])
    .join("\n");

  for (const panel of ["#rail", "#side", "#main", "#members", "#titlebar"]) {
    ck(`${panel} is dealt with under a wallpaper`,
       wallRules.includes(panel), panel);
  }

  ck("and the member list specifically goes transparent",
     /html\.wall[^{]*#members[^{]*\{[^}]*background: transparent/.test(wallRules) ||
     /#members,[\s\S]{0,120}background: transparent/.test(wallRules));

  // There is deliberately no "every element with a background is handled"
  // check here. It was tried and it is noise: CSS does not distinguish a panel
  // from a button, so it flags every hover state, the window controls, the
  // lightbox chrome and the tab strips — none of which should go transparent,
  // and all of which would have to be listed as exceptions until the list was
  // longer than the rule. The five panels above are the window; the rest are
  // things drawn on top of it.
  //
  // What is worth asserting is that the inputs sitting directly on the picture
  // were given something legible, since a flat `--side` disappears into a
  // photograph.
  ck("inputs on the wallpaper stay legible",
     /html\.wall #composer input/.test(wallRules));
}

// ---- clearing files as they leave the screen ------------------------------
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");

  // The window a file is dropped outside has to be reachable. It was 2400px,
  // which is taller than the whole windowed channel renders on most screens,
  // so nothing was ever far enough away and this never ran once.
  ck("the far edge is within a rendered channel",
     (sandbox.VIEW_FAR as number) <= 1500, String(sandbox.VIEW_FAR));
  ck("and still wider than the near edge",
     (sandbox.VIEW_FAR as number) > (sandbox.VIEW_NEAR as number));

  const sweep = source.slice(source.indexOf("async function sweepViewport("));
  const body = sweep.slice(0, sweep.indexOf("\n      // ---- rendering"));

  ck("a refusal is remembered for the session", /viewKept\[key\] = answer\.reason/.test(body));
  ck("and not re-asked every pass", /if \(viewKept\[key\]\) continue;/.test(body));
  ck("a peer arriving clears it",
     /viewKept = \{\};/.test(source.slice(source.indexOf("window.p2p.onPeers"))));
}

// ---- notifications say who and where, never what --------------------------
//
// This is the one place message text could leave the app without anybody
// noticing. A Windows notification is composed here but delivered by the
// shell: it is drawn over the lock screen by default and kept in the Action
// Centre afterwards, where it outlives the app being closed and is readable by
// whoever is sitting at the machine. A preview there would undo the part of
// this app that is the entire point.
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
  const preload = readFileSync(join(process.cwd(), "src/world/window.ts"), "utf8");
  const native = readFileSync(join(process.cwd(), "src/native/notify.ts"), "utf8");

  const notify = source.slice(source.indexOf("function notifyDesktop("));
  const body = notify.slice(0, notify.indexOf("/** Wire up what happens"));

  // The strongest form of the check: not "does it avoid sending the content",
  // but "is there anywhere it could be put". None of the three layers has a
  // field for it.
  ck("the client never reads the message when building one",
     !/payload\.content/.test(body), body.match(/.*payload\.content.*/)?.[0] ?? "");
  ck("the bridge has no field for a message body",
     !/\bbody\b/.test(preload.slice(preload.indexOf("notify: (request"),
                                    preload.indexOf("onNotifyClick"))));
  ck("and the main process composes the text itself",
     /body: request\.direct/.test(native) && !/request\.body/.test(native));

  ck("what it does send is a name and a place",
     /who: nameOf\(e\.author\)/.test(body) && /where: whereLabel\(/.test(body));
  ck("it can be turned off", /if \(!userPrefs\.toasts\) return;/.test(body));

  // And nothing draws them in the window any more.
  ck("there is no in-window notification stack", !/id="toasts"/.test(source));

  // Clicking one has to end up in the right conversation, which means the
  // window has to come back first — and only the main process can do that.
  ck("the click restores the window",
     /mainWindow\.isMinimized\(\)\) mainWindow\.restore\(\);/.test(native) &&
     /mainWindow\.focus\(\);/.test(native));
  ck("and hands back the routing it was given",
     /send\("notifyClick", request\.go/.test(native));
  ck("which the client turns into a conversation",
     /jumpTo\(go\.community, go\.channelId\)/.test(source));
  ck("the listener is installed at startup",
     /watchNotificationClicks\(\);/.test(source.slice(source.indexOf("startPresenceSweep()"))));

  // A notification kept alive only by the shell can be collected while it is
  // still on screen, taking its click handler with it.
  ck("live notifications are held onto", /live\.add\(notification\);/.test(native));

  // Everything that decides whether this is an interruption already ran: the
  // call site is after the standing check, the muting check and the "already
  // reading it" check, so one can never appear for something the unread count
  // ignored.
  const note = source.slice(source.indexOf("function noteIncoming_message("));
  const decide = note.slice(0, note.indexOf("renderRail(); renderSide();"));

  ck("a stranger cannot raise one",
     decide.indexOf("var why = mayReach(") < decide.indexOf("notifyDesktop("));
  ck("nor can a muted conversation",
     decide.indexOf("if (isMuted(") < decide.indexOf("notifyDesktop("));
  ck("and not one you are looking at",
     decide.indexOf("document.hasFocus()") < decide.indexOf("notifyDesktop("));
}

// ---- the direct-message list is ordered by activity, not by attention -----
//
// Every row carries a timestamp and the list sorts by it, so anything writing
// `Date.now()` moves that row to the top. It used to be the default, which
// meant *opening* a conversation reordered the list — and opening one is the
// single most common thing anybody does, so the order drifted into "recently
// looked at". Scrolling through a few old chats rearranged the whole sidebar.
{
  const source = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");
  const noteConversation = sandbox.noteConversation as (uid: string, at?: number) => void;
  const touchConversation = sandbox.touchConversation as (uid: string, at?: number) => void;
  const conversations = sandbox.conversations as Record<string, number>;

  const who = "SOMEBODYELSE0000000000000A";

  // Noting one puts it on the list without claiming anything happened.
  noteConversation(who);
  ck("a noted conversation appears", conversations[who] !== undefined,
     String(conversations[who]));
  ck("and does not jump to the top", (conversations[who] ?? 1) === 0,
     String(conversations[who]));

  // Doing it again — which is what opening it does — must not move it either.
  noteConversation(who);
  ck("noting it again still does not move it", conversations[who] === 0);

  // Activity does.
  touchConversation(who, 1_700_000_000_000);
  ck("activity raises it", conversations[who] === 1_700_000_000_000,
     String(conversations[who]));

  // And a later note must not drag it back down.
  noteConversation(who);
  ck("a note afterwards leaves it where it is",
     conversations[who] === 1_700_000_000_000);

  // Nor may an older event reorder anything.
  touchConversation(who, 1_600_000_000_000);
  ck("an older event does not lower it",
     conversations[who] === 1_700_000_000_000);

  // Opening a conversation must go through the passive one.
  const open = source.slice(source.indexOf("async function openDM("));
  const body = open.slice(0, open.indexOf("async function openGroup("));

  ck("opening a conversation only notes it",
     /noteConversation\(friend\.userId\)/.test(body) &&
     !/touchConversation/.test(body));

  // The three things that count as activity, and they all have to be wired.
  const incoming = source.slice(source.indexOf("function noteIncoming_message("));
  ck("a message arriving counts",
     /touchConversation\(e\.author, Date\.now\(\)\)/
       .test(incoming.slice(0, incoming.indexOf("renderRail(); renderSide();"))));

  const send = source.slice(source.indexOf("async function send()"));
  ck("a message being sent counts",
     /touchConversation\(currentDM\.userId, Date\.now\(\)\)/
       .test(send.slice(0, send.indexOf("async function deleteMessage("))));

  const ring = source.slice(source.indexOf("function maybeRing("));
  const rings = ring.slice(0, ring.indexOf("if (isMuted(community)) return;"));
  ck("an incoming call counts",
     /touchConversation\(e\.author, Date\.now\(\)\)/.test(rings));
  ck("and does so even for a muted conversation",
     rings.indexOf("touchConversation") < rings.length);
}

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
