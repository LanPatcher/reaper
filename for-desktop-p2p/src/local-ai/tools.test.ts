import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NUDGE,
  NUDGE_ANSWER,
  NUDGE_FABRICATION,
  NUDGE_NARRATION,
  looksLikeNarration,
  looksLikeRefusal,
  looksLikeUnbackedResult,
  normalize,
  parseCommands,
  resultTurn,
  stripCommands,
  toolPrompt,
} from "./agent";
import { htmlToText, insideFolder, listFolder, readFile, writeFile } from "./tools";

/**
 * The folder a character was given, and the edge of it.
 *
 * ## Why this is tested rather than eyeballed
 *
 * Everything here is a way of naming a file that is not in the folder while
 * looking like a file that is. `../../secrets` is the obvious one and the least
 * interesting; a symbolic link inside the folder pointing anywhere is the one
 * that defeats every check written on the string rather than on the path, and
 * it does not look like an attack in a directory listing.
 *
 * The model on the other end of this is a 0.5B, so it will also do all of this
 * by accident: "READ ../notes.txt" is a thing it says when it means
 * "notes.txt". The containment is load-bearing for ordinary use, not only for
 * a hostile one.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

const root = mkdtempSync(join(tmpdir(), "reaper-tools-"));
const outside = mkdtempSync(join(tmpdir(), "reaper-outside-"));

writeFileSync(join(root, "notes.txt"), "the notes", "utf8");
writeFileSync(join(root, "secret.png"), "not text", "utf8");
mkdirSync(join(root, "sub"), { recursive: true });
writeFileSync(join(root, "sub", "deep.md"), "deep", "utf8");
writeFileSync(join(outside, "passwords.txt"), "hunter2", "utf8");

// ---- staying inside --------------------------------------------------------
ck("a plain name resolves", !!insideFolder(root, "notes.txt"));
ck("a name in a subfolder resolves", !!insideFolder(root, "sub/deep.md"));

// Built rather than typed: a source file with a real null byte in it is a
// source file that does not survive being moved around.
const NUL = String.fromCharCode(0);

const ESCAPES: [string, string][] = [
  ["../passwords.txt", "a parent traversal"],
  ["../../etc/passwd", "a deeper traversal"],
  ["sub/../../outside.txt", "a traversal that doubles back"],
  [join(outside, "passwords.txt"), "an absolute path elsewhere"],
  ["notes.txt" + NUL + ".png", "a null byte in the name"],
  [".reaper-backups/anything", "our own backups"],
];

for (const [name, why] of ESCAPES) {
  ck(`refused: ${why}`, insideFolder(root, name) === null, String(insideFolder(root, name)));
}

// A symlink inside the folder pointing out of it. Skipped where the platform
// will not make one without privileges, which is Windows for an unelevated
// process; the check still runs everywhere else.
let linked = false;
try {
  symlinkSync(outside, join(root, "escape"), "dir");
  linked = true;
} catch {
  /* not permitted here */
}

if (linked) {
  ck("refused: a symlink out of the folder",
     insideFolder(root, "escape/passwords.txt") === null,
     String(insideFolder(root, "escape/passwords.txt")));
} else {
  console.log("SKIP  symlinks need privileges on this platform");
}

// ---- reading ---------------------------------------------------------------
ck("a text file reads", readFile(root, "notes.txt").detail.includes("the notes"));
ck("a file outside is refused", !readFile(root, "../../etc/passwd").ok);
ck("a file that is not text is refused", !readFile(root, "secret.png").ok);
ck("a listing names what is there",
   listFolder(root).detail.includes("notes.txt") &&
   listFolder(root).detail.includes("sub/deep.md"));

// ---- writing ---------------------------------------------------------------
ck("a new file writes", writeFile(root, "fresh.md", "hello").ok);
ck("and is on disk", readFileSync(join(root, "fresh.md"), "utf8") === "hello");

const over = writeFile(root, "notes.txt", "replaced");
ck("an overwrite succeeds", over.ok);
ck("and says the old version was kept", over.note.includes(".reaper-backups"));
ck("the new contents are there", readFileSync(join(root, "notes.txt"), "utf8") === "replaced");

// The point of the backup: a small model that misreads an instruction must not
// be able to destroy work.
ck("the previous version is recoverable",
   readFileSync(
     join(root, ".reaper-backups", readdirSync(join(root, ".reaper-backups"))[0]),
     "utf8",
   ) === "the notes");
ck("and backups are not listed back to the model",
   !listFolder(root).detail.includes(".reaper-backups"));

ck("a write outside the folder is refused", !writeFile(root, "../escape.txt", "x").ok);
ck("and nothing was created there", !existsSync(join(outside, "..", "escape.txt")));
ck("a binary extension is refused", !writeFile(root, "thing.exe", "x").ok);

// ---- the command protocol --------------------------------------------------
ck("a bare command parses",
   parseCommands("FETCH https://example.com")[0]?.arg === "https://example.com");
ck("lower case parses", parseCommands("read notes.txt")[0]?.name === "READ");
ck("a bulleted, backticked command parses", parseCommands("- `LIST`")[0]?.name === "LIST");
ck("only the first command is acted on",
   parseCommands("LIST\nREAD a.txt\nFETCH https://x.example").length === 1);

const fence = "```";
const write = parseCommands(
  "WRITE notes.txt\n" + fence + "\nline one\nline two\n" + fence,
)[0];
ck("a write takes the fenced block", write?.body === "line one\nline two",
   JSON.stringify(write?.body));

ck("speech before a command is kept",
   stripCommands("Let me look.\nFETCH https://x.example") === "Let me look.");
ck("and the command itself never is",
   !stripCommands("Let me look.\nFETCH https://x.example").includes("FETCH"));

ck("a character with nothing switched on is told about nothing",
   toolPrompt({ web: false, folder: "" }) === "");
ck("web only mentions the web",
   toolPrompt({ web: true, folder: "" }).includes("FETCH") &&
   !toolPrompt({ web: true, folder: "" }).includes("WRITE"));
ck("a folder only mentions the folder",
   toolPrompt({ web: false, folder: "/tmp/x" }).includes("WRITE") &&
   !toolPrompt({ web: false, folder: "/tmp/x" }).includes("FETCH"));

// ---- page text -------------------------------------------------------------
ck("scripts and tags are stripped from a page",
   htmlToText("<p>hi</p><script>bad()</script><b>there</b>") === "hi there",
   JSON.stringify(htmlToText("<p>hi</p><script>bad()</script><b>there</b>")));

// ---- refusal recovery ------------------------------------------------------
//
// The one failure a small model produces confidently with tools switched on:
// it apologises for being unable instead of running the command it holds. The
// loop leans on `looksLikeRefusal` to notice that and re-prompt with `NUDGE`
// once, so the apology never reaches the user. These pin the shapes it must
// catch, the ones it must leave alone, and the fact that a plain refusal
// carries no command (so the loop reaches the refusal branch at all).

const REFUSALS = [
  "I'm sorry, but I can't assist with that.",
  "I'm sorry, but I cannot help with that request.",
  "Sorry, I am unable to browse the web.",
  "I can't access the internet.",
  "I cannot fetch that page for you.",
  "I do not have the ability to search the web.",
  "As an AI, I can't access external websites.",
];
for (const r of REFUSALS) {
  ck(`refusal is recognised: ${r.slice(0, 32)}...`, looksLikeRefusal(r), r);
  ck("and a refusal carries no command", parseCommands(r).length === 0);
}

const NOT_REFUSALS = [
  "I'm sorry to hear that happened to you.",
  "Sorry, that came out wrong — what I meant was this.",
  "Let me look that up for you.",
  "I searched and found three results.",
];
for (const r of NOT_REFUSALS) {
  ck(`ordinary speech is left alone: ${r.slice(0, 32)}...`, !looksLikeRefusal(r), r);
}

ck("the nudge names the commands as real", /work|command/i.test(NUDGE));

// ---- fabricated results ----------------------------------------------------
//
// The other confident failure with web on: instead of fetching, the model
// writes out a result it never looked up, complete with an invented link. On
// the first reply — before any command has run — a URL can only be one it made
// up, and that is the signal the loop nudges on. These pin that a made-up
// answer is caught, that ordinary prose without a link is not, and that the
// nudge tells it to run the command.

const FABRICATED = [
  'Sure thing! Here it is: "The Martian". URL: https://www.youtube.com/watch?v=6QbXo78tWzA',
  "I found it for you: http://example.com/article",
  "Here's the page: https://en.wikipedia.org/wiki/Dune",
];
for (const r of FABRICATED) {
  ck(`a made-up link is caught: ${r.slice(0, 30)}...`, looksLikeUnbackedResult(r), r);
}

const CLEAN = [
  "I'm not sure that video exists — want me to look it up?",
  "The Martian is a 2015 film directed by Ridley Scott.",
  "Sure, what would you like to know about Reaper?",
];
for (const r of CLEAN) {
  ck(`ordinary prose is not flagged: ${r.slice(0, 30)}...`, !looksLikeUnbackedResult(r), r);
}

ck("the fabrication nudge tells it to run a command",
   /SEARCH|FETCH|command/i.test(NUDGE_FABRICATION));

// ---- the tool prompt shows the model a real example ------------------------
//
// The whole point of the rewrite: a small model copies a shape it is shown far
// more reliably than one it is only told about, so the exact command it must
// type has to appear in the prompt, and the rule against inventing results has
// to be in there in words.
ck("the web prompt shows a literal SEARCH example",
   /\n {4}SEARCH /.test(toolPrompt({ web: true, folder: "" })));
ck("the web prompt forbids inventing a result",
   /never\s+invent/i.test(toolPrompt({ web: true, folder: "" })));
ck("the folder-only prompt shows a literal LIST example",
   /\n {4}LIST/.test(toolPrompt({ web: false, folder: "/tmp/x" })));


// ---- saying it is not doing it ---------------------------------------------
//
// The failure that looks most like success. Asked to fetch something, the model
// writes "Searching for X." and stops — right tool, right subject, no command,
// nothing runs, and the user sits watching a sentence that reads like work in
// progress. Caught only before anything has run, so the same words after a
// result ("Looking at the results, …") are left alone.
for (const r of [
  'Searching for "Caramelldansen on YouTube".',
  'Fetching "Caramelldansen on YouTube".',
  "I'll search the web for that now.",
  "Let me look that up for you.",
  "Okay, checking that for you.",
  "One moment while I find it.",
  "I am going to read the file.",
]) {
  ck(`narration is recognised: ${r.slice(0, 34)}...`, looksLikeNarration(r), r);
}

for (const r of [
  "The song is by Caramell and the video is at the link above.",
  "Search results turned up three videos; the first is the original upload.",
  "I found it. The channel is Caramell's own, and it was posted in 2006.",
  "Sure, the capital of France is Paris.",
]) {
  ck(`a real answer is not flagged: ${r.slice(0, 34)}...`,
     !looksLikeNarration(r), r);
}

ck("a long reply is never treated as a stage direction",
   !looksLikeNarration("Looking at what came back, " + "x".repeat(300)));

ck("the narration nudge asks for the command line itself",
   /command line/i.test(NUDGE_NARRATION));


// ---- apologising at a result that already arrived --------------------------
//
// The opposite instruction to NUDGE, and it matters that they are different: a
// model nudged with "write only the command line" after a successful fetch goes
// and fetches the same thing again, burning the round budget on work already
// done. This one has to point at what is already there.
ck("the answer nudge tells it to use what came back",
   /answer/i.test(NUDGE_ANSWER) && !/only the command/i.test(NUDGE_ANSWER));
ck("the answer nudge forbids another command",
   /not run another command/i.test(NUDGE_ANSWER));


// ---- the right tool, addressed wrongly -------------------------------------
//
// Both of these were observed. `FETCH <description>` fails as "not a valid
// address" and the model, told its tool does not work, apologises; `SEARCH
// <search url>` searches for a URL and returns nothing useful. Renaming is all
// that is needed, and `run` still checks the caps on the result.
const asSearchUrl = normalize({
  name: "SEARCH",
  arg: "https://www.youtube.com/results?search_query=caramelldansen",
});
ck("a search handed a search URL searches for its terms",
   asSearchUrl.name === "SEARCH" && asSearchUrl.arg === "caramelldansen",
   JSON.stringify(asSearchUrl));

const asPlainUrl = normalize({
  name: "SEARCH",
  arg: "https://en.wikipedia.org/wiki/Caramelldansen",
});
ck("a search handed a plain URL fetches it instead",
   asPlainUrl.name === "FETCH", JSON.stringify(asPlainUrl));

const asDescription = normalize({ name: "FETCH", arg: "caramelldansen on yt" });
ck("a fetch handed a description searches for it",
   asDescription.name === "SEARCH" && asDescription.arg === "caramelldansen on yt",
   JSON.stringify(asDescription));

const realFetch = normalize({
  name: "FETCH",
  arg: "https://example.com/page",
});
ck("a real fetch is left alone",
   realFetch.name === "FETCH" && realFetch.arg === "https://example.com/page");

const listing = normalize({ name: "LIST", arg: "" });
ck("commands with no address are untouched", listing.name === "LIST");

ck("normalizing twice changes nothing",
   JSON.stringify(normalize(normalize({
     name: "SEARCH",
     arg: "https://www.youtube.com/results?search_query=caramelldansen",
   }))) === JSON.stringify(asSearchUrl));


// ---- the result turn carries the question back -----------------------------
//
// Without it a small model reaches the end of a page of results having lost
// what it was looking for, and answers the last thing it read. It also has to
// be told to stop reaching for tools, which is the opposite of what the system
// prompt told it a moment ago.
const turn = resultTurn(
  { name: "SEARCH", arg: "caramelldansen" },
  { ok: true, note: "searched", detail: "1. Caramelldansen\n   https://x/y" },
  "fetch caramelldansen on yt for me",
);
ck("the result turn repeats what the user asked",
   turn.includes("fetch caramelldansen on yt for me"), turn);
ck("the result turn tells it to answer now", /answer them now/i.test(turn), turn);
ck("the result turn still marks the text as data",
   /not instructions/i.test(turn), turn);
ck("the result turn works without a question",
   resultTurn({ name: "LIST", arg: "" },
              { ok: true, note: "listed", detail: "a.txt" }).includes("a.txt"));


rmSync(root, { recursive: true, force: true });
rmSync(outside, { recursive: true, force: true });

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
