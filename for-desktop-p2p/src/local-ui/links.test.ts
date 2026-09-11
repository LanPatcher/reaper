import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TRUSTED_HOSTS,
  hostMatches,
  parseSafeUrl as parseInMain,
  previewFor as previewInMain,
} from "../native/links";

/**
 * Links in messages, and the ways one can lie about where it goes.
 *
 * ## Why this is tested rather than eyeballed
 *
 * Every case here renders as something plausible. A link with credentials in
 * front of the host reads as the host; a hostname with one Cyrillic letter is
 * pixel-identical to the real one; `youtube.com.example.net` is a match for any
 * check written with `endsWith` or a substring. None of them look wrong on
 * screen, which is the entire point of them, so "it looked fine when I tried
 * it" establishes nothing.
 *
 * The other half is the pair of copies. The renderer decides what to *show* and
 * the main process decides what to *fetch*, and they are separate code because
 * the renderer has no imports. If they ever disagree, the interface is offering
 * something the main process will refuse — or worse, the other way round. So
 * both are run against the same corpus and required to agree.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

const html = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");

const from = html.indexOf("      // ---- links");
const to = html.indexOf("      // ---- end links");
if (from < 0 || to < 0) {
  console.log("FAIL  the link helpers could not be found in index.html");
  process.exit(1);
}

/** The renderer's copy, lifted out of the page and run on its own. */
const ui = new Function(
  "URL",
  "URLSearchParams",
  html.slice(from, to) +
    "\nreturn { parseSafeUrl: parseSafeUrl, previewFor: previewFor," +
    " hostMatches: hostMatches, hostIsTrusted: hostIsTrusted," +
    " trimUrlTail: trimUrlTail, linkLabel: linkLabel," +
    " TRUSTED_HOSTS: TRUSTED_HOSTS };",
)(URL, URLSearchParams) as {
  parseSafeUrl: (raw: string) => { host: string; trusted: boolean; href: string } | null;
  previewFor: (link: unknown) => string | null;
  hostMatches: (host: string, domain: string) => boolean;
  hostIsTrusted: (host: string) => boolean;
  trimUrlTail: (raw: string) => string;
  linkLabel: (link: { host: string; path: string }) => string;
  TRUSTED_HOSTS: string[];
};

// ---- the two copies agree --------------------------------------------------
ck("the renderer and the main process trust the same hosts",
   ui.TRUSTED_HOSTS.join(",") === TRUSTED_HOSTS.join(","),
   ui.TRUSTED_HOSTS.join(",") + "  vs  " + TRUSTED_HOSTS.join(","));

// ---- label boundaries ------------------------------------------------------
ck("a host is its own domain", hostMatches("youtube.com", "youtube.com"));
ck("and a subdomain of it", hostMatches("www.youtube.com", "youtube.com"));
ck("a suffix that is not a label boundary is not a match",
   !hostMatches("notyoutube.com", "youtube.com"));
ck("and neither is the domain used as a prefix",
   !hostMatches("youtube.com.example.net", "youtube.com"));

// ---- what must never be trusted -------------------------------------------
const NEVER_TRUSTED: [string, string][] = [
  ["https://youtube.com.example.net/watch?v=aaaaaaaaaaa", "a lookalike subdomain"],
  ["https://notyoutube.com/watch?v=aaaaaaaaaaa", "a lookalike suffix"],
  ["https://youtube.com@evil.example/path", "credentials standing in for a host"],
  ["https://user:pw@youtube.com/watch", "credentials on a real host"],
  ["http://youtube.com/watch?v=aaaaaaaaaaa", "plain http"],
  ["https://youtube.com:8443/watch", "a familiar name on an odd port"],
  ["https://xn--80ak6aa92e.com/a.png", "a punycode host"],
  ["https://evil.example/cdn.discordapp.com/a.png", "a trusted name in the path"],
  ["https://example.com/a.png", "an ordinary unknown host"],
];

for (const [url, why] of NEVER_TRUSTED) {
  const parsed = ui.parseSafeUrl(url);
  ck(`not trusted: ${why}`, !parsed || !parsed.trusted,
     parsed ? `${parsed.host} trusted=${parsed.trusted}` : "refused");
}

// ---- what must be refused outright ----------------------------------------
const REFUSED: [string, string][] = [
  ["javascript:alert(1)", "a script scheme"],
  ["data:text/html,<script>alert(1)</script>", "a data scheme"],
  ["file:///C:/Windows/System32/config/sam", "a file scheme"],
  ["https://you\u202Etube.com/a", "a right-to-left override inside the host"],
  ["https://youtube\u200B.com/a", "a zero-width space inside the host"],
  ["https://youtube.com/\u0000", "a control character"],
];

for (const [url, why] of REFUSED) {
  ck(`refused: ${why}`, ui.parseSafeUrl(url) === null,
     JSON.stringify(ui.parseSafeUrl(url)));
}

// ---- what should work ------------------------------------------------------
const TRUSTED_OK = [
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://youtu.be/dQw4w9WgXcQ",
  "https://cdn.discordapp.com/attachments/1/2/cat.png",
  "https://media.discordapp.net/attachments/1/2/cat.png?width=100",
  "https://i.imgur.com/abcdef.jpeg",
  "https://encrypted-tbn0.gstatic.com/images?q=tbn:AAA",
];

for (const url of TRUSTED_OK) {
  const parsed = ui.parseSafeUrl(url);
  ck(`trusted: ${url.slice(0, 46)}`, !!parsed && parsed.trusted,
     parsed ? String(parsed.trusted) : "refused");
}

// ---- previews are only ever an image on a trusted host --------------------
const yt = ui.parseSafeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
ck("a YouTube link previews as its thumbnail, not as a page",
   ui.previewFor(yt) === "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
   String(ui.previewFor(yt)));

ck("a signed Discord attachment is recognised by its path, not its query",
   ui.previewFor(ui.parseSafeUrl(
     "https://cdn.discordapp.com/attachments/1/2/cat.png?ex=abc&hm=def",
   )) !== null);

ck("a trusted host serving something that is not an image has no preview",
   ui.previewFor(ui.parseSafeUrl("https://cdn.discordapp.com/attachments/1/2/notes.pdf")) === null);

ck("an untrusted host never has a preview",
   ui.previewFor(ui.parseSafeUrl("https://example.com/cat.png")) === null);

ck("a YouTube id is rejected if it is not the right shape",
   ui.previewFor(ui.parseSafeUrl("https://www.youtube.com/watch?v=../../etc")) === null);

// ---- the two copies agree on every case above ------------------------------
const CORPUS = [
  ...NEVER_TRUSTED.map(([u]) => u),
  ...REFUSED.map(([u]) => u),
  ...TRUSTED_OK,
  "https://cdn.discordapp.com/attachments/1/2/notes.pdf",
  "https://example.com/cat.png",
];

const disagreements = CORPUS.filter((url) => {
  const a = ui.parseSafeUrl(url);
  const b = parseInMain(url);
  if (!a || !b) return !!a !== !!b;
  if (a.trusted !== b.trusted || a.host !== b.host || a.href !== b.href) return true;
  return ui.previewFor(a) !== previewInMain(b as never);
});

ck("the renderer and the main process reach the same verdict on every case",
   disagreements.length === 0, disagreements.join(", "));

// ---- trailing punctuation belongs to the sentence -------------------------
ck("a full stop after a link is not part of it",
   ui.trimUrlTail("https://youtu.be/dQw4w9WgXcQ.") === "https://youtu.be/dQw4w9WgXcQ");
ck("nor is a closing bracket the link never opened",
   ui.trimUrlTail("https://youtu.be/dQw4w9WgXcQ)") === "https://youtu.be/dQw4w9WgXcQ");
ck("but one the link did open is kept",
   ui.trimUrlTail("https://en.wikipedia.org/wiki/Tor_(network)") ===
     "https://en.wikipedia.org/wiki/Tor_(network)");

// ---- the label is always the destination ----------------------------------
//
// The property the whole feature rests on: whatever a message says, the words
// on the link are built from the URL the browser will be handed.
const long = ui.parseSafeUrl(
  "https://cdn.discordapp.com/attachments/" + "9".repeat(120) + "/x.png",
);
ck("a label names the real host", ui.linkLabel(long as never).startsWith("cdn.discordapp.com/"));
ck("and is bounded, so it cannot push the rest of the message off screen",
   ui.linkLabel(long as never).length <= 64, String(ui.linkLabel(long as never).length));

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
