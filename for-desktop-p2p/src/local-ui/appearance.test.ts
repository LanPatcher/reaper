import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Themes and wallpapers.
 *
 * The property worth protecting here is not that the colours are pretty — it is
 * that decoration stays local. A theme is a preference; a wallpaper is an image
 * of the user's choosing, and an image is a fingerprint. Neither has any reason
 * to reach a peer, so this checks the wallpaper is stored under a private
 * community prefix and never appended to anything shared.
 *
 * The rest is completeness: a theme missing one variable does not fail, it
 * inherits whatever the last theme set, which shows up as one stray colour
 * nobody can explain.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

const html = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");

function extract(opener: string): string {
  const at = html.indexOf(opener);
  if (at === -1) throw new Error(`${opener} not found`);

  let depth = 0;
  let i = html.indexOf("{", at);
  const start = i;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    } else if (html[i] === '"') {
      i++;
      while (i < html.length && html[i] !== '"') i += html[i] === "\\" ? 2 : 1;
    }
  }
  throw new Error(`${opener} is unbalanced`);
}

const THEMES = eval("(" + extract("var THEMES = ") + ")") as Record<
  string,
  { name: string; vars: Record<string, string> }
>;

const names = Object.keys(THEMES);

// ---- completeness --------------------------------------------------------
ck("several themes ship", names.length >= 4, names.join(", "));
ck("the default exists", names.includes("midnight"));

const base = Object.keys(THEMES.midnight.vars).sort();
ck("the default defines the full palette", base.length >= 10, String(base.length));

for (const name of names) {
  const vars = Object.keys(THEMES[name].vars).sort();
  const missing = base.filter((v) => !vars.includes(v));
  ck(`${name} defines every variable`, missing.length === 0, missing.join(", "));
  ck(`${name} has a display name`, !!THEMES[name].name);

  const bad = Object.entries(THEMES[name].vars)
    .filter(([, value]) => !/^#[0-9a-f]{6}$/i.test(value));
  ck(`${name} is all six-digit hex`, bad.length === 0,
     bad.map(([k, v]) => `${k}=${v}`).join(", "));
}

// Two themes that are the same palette under different names would be a copy
// left half-edited.
const palettes = names.map((n) => JSON.stringify(THEMES[n].vars));
ck("no two themes are identical", new Set(palettes).size === names.length);

// ---- contrast ------------------------------------------------------------
//
// Not a full WCAG check — a rough luminance gap, enough to catch a theme where
// the text was never adjusted to the background it now sits on.
const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const parts = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

for (const name of names) {
  const v = THEMES[name].vars;
  ck(`${name} keeps body text readable`, ratio(v["--text"], v["--main"]) >= 7,
     ratio(v["--text"], v["--main"]).toFixed(1) + ":1");
  ck(`${name} keeps muted text legible`, ratio(v["--dim"], v["--main"]) >= 3,
     ratio(v["--dim"], v["--main"]).toFixed(1) + ":1");
}

// ---- decoration never leaves the device ----------------------------------
//
// The claim the feature makes to the user, checked rather than asserted in a
// comment.
ck("the wallpaper is stored under a private prefix",
   /var WALLPAPERS = "@/.test(html));

const shareableAppend = new RegExp(
  String.raw`append\(\s*(?!INDEX)[A-Za-z0-9_.$]+\s*,\s*"[^"]*"\s*,\s*\{[^}]*wallpaper`,
  "i",
);
ck("no wallpaper is appended to a shared community", !shareableAppend.test(html));

ck("the wallpaper is not published in a profile",
   !/publishProfile[\s\S]{0,600}wallpaper/i.test(html));

// The profile payload is the one thing that is deliberately broadcast; if a
// decoration ever reaches it, that is the leak.
const profilePayloads = [...html.matchAll(/"profile\.(?:update|known)"[\s\S]{0,700}?\}/g)]
  .map((m) => m[0]);
ck("profile payloads carry no theme or wallpaper",
   profilePayloads.every((p) => !/wallpaper|theme|accent/i.test(p)),
   String(profilePayloads.length) + " payload(s) checked");

// ---- the wallpaper cannot be served to a peer ----------------------------
//
// The bridge refuses to serve blobs for any community whose name starts with
// the private prefix, which is what makes storing it as a blob safe at all.
const bridge = readFileSync(join(process.cwd(), "src/p2p/bridge.ts"), "utf8");
ck("private communities are never shareable",
   /PRIVATE_PREFIX = "@"/.test(bridge) &&
   /isShareable\(community\)\s*\?\s*blobsFor/.test(bridge));

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
