import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The language table, checked against the UI that uses it.
 *
 * Translation bugs are quiet: a missing key renders English, a stale key
 * renders nothing at all, and neither throws. Both are invisible to anyone
 * reading the code in a language they do not speak, so they are worth asserting
 * rather than eyeballing.
 *
 * The table lives inside index.html, so it is read out of the file and
 * evaluated rather than imported. That is a little awkward, and it is the
 * reason the test is honest: it checks the table that actually ships, not a
 * copy that could drift from it.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

// Relative to the working directory rather than the module: the test is
// bundled into a temporary directory before it runs, so __dirname points
// somewhere unrelated to the source.
const html = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");

// ---- pull the table and its helpers out of the page ----------------------
function extract(name: string, opener: string): string {
  const at = html.indexOf(opener);
  if (at === -1) throw new Error(`${name} not found in index.html`);

  // Brace matching rather than a regular expression: the table contains braces
  // inside string literals and a lazy match would stop at the first one.
  let depth = 0;
  let i = html.indexOf("{", at);
  const start = i;

  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    } else if (html[i] === '"') {
      // Skip the string, so a brace inside one does not count.
      i++;
      while (i < html.length && html[i] !== '"') i += html[i] === "\\" ? 2 : 1;
    }
  }
  throw new Error(`${name} is unbalanced`);
}

const LANGUAGES = eval("(" + extract("LANGUAGES", "var LANGUAGES = ") + ")") as Record<
  string,
  { name: string; strings: Record<string, string> }
>;

const codes = Object.keys(LANGUAGES);

// ---- shape ---------------------------------------------------------------
ck("more than one language ships", codes.length > 1, codes.join(", "));
ck("English is present and is the base", codes.includes("en"));
ck("English has no table of its own",
   Object.keys(LANGUAGES.en.strings).length === 0);
ck("every language is named", codes.every((c) => !!LANGUAGES[c].name));

ck("each is named in its own language",
   LANGUAGES.es?.name === "Español" && LANGUAGES.de?.name === "Deutsch");

// ---- no empty or accidental identity translations ------------------------
//
// A key translating to itself is either an oversight or a word that genuinely
// does not change. The latter exists ("Online", "System"), so this only catches
// the case where a whole table is untouched.
for (const code of codes.filter((c) => c !== "en")) {
  const strings = LANGUAGES[code].strings;
  const keys = Object.keys(strings);

  ck(`${code} has entries`, keys.length > 0, String(keys.length));
  ck(`${code} has no empty values`, keys.every((k) => strings[k].trim() !== ""));

  const same = keys.filter((k) => strings[k] === k);
  ck(`${code} is actually translated`, same.length < keys.length / 2,
     same.length ? `${same.length} identical: ${same.slice(0, 3).join(", ")}` : "");
}

// ---- every key the code asks for exists somewhere -------------------------
//
// The direction that matters. `t("Add friend")` with no entry silently renders
// English, which looks fine to a developer and wrong to a user.
const asked = new Set<string>();
for (const m of html.matchAll(/\bt\(\s*"((?:[^"\\\n]|\\.)*)"/g)) {
  // What the source spells is not what `t` receives: "…" is three
  // characters of source and one character at runtime, and the table is keyed
  // by the runtime string.
  asked.add(
    m[1]
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\(.)/g, "$1"),
  );
}

// Tab names never appear inside a `t(...)` call — they are passed to the pane
// builder, which translates them when it draws the strip.
for (const m of html.matchAll(/\bpane\("([^"]+)"\)/g)) asked.add(m[1]);

ck("the UI calls t()", asked.size > 200, `${asked.size} strings`);

const covered = new Set(Object.keys(LANGUAGES.es.strings));
const missing = [...asked].filter((k) => !covered.has(k));

// A hard failure now that the interface is meant to be fully translated. An
// untranslated string still renders correct English, so nothing breaks — but
// it is exactly the kind of gap nobody notices until they are reading the app
// in a language they do not speak.
ck("every t() string has a translation", missing.length === 0,
   missing.slice(0, 6).map((k) => JSON.stringify(k.slice(0, 40))).join(", "));

// ---- stale keys ----------------------------------------------------------
//
// The opposite failure: an entry nothing looks up. Harmless at runtime, but it
// means the English was edited and the translation was not, so the string is
// now showing in English while appearing to be covered.
const usedAnywhere = (key: string) =>
  asked.has(key) ||
  html.includes(`"${key}"`) ||
  html.includes(`"${key.replace(/…/g, "\\u2026").replace(/"/g, '\\"')}"`);

for (const code of codes.filter((c) => c !== "en")) {
  const stale = Object.keys(LANGUAGES[code].strings).filter((k) => !usedAnywhere(k));
  ck(`${code} has no orphaned entries`, stale.length === 0,
     stale.slice(0, 5).map((k) => k.slice(0, 30)).join(" | "));
}

// ---- placeholders --------------------------------------------------------
//
// A translation that renames {n} to {número} produces a literal "{n}" on
// screen. The English is the contract; every translation has to honour it.
const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).slice().sort().join(",");

for (const code of codes.filter((c) => c !== "en")) {
  const wrong = Object.keys(LANGUAGES[code].strings)
    .filter((k) => holes(k) !== holes(LANGUAGES[code].strings[k]));
  ck(`${code} keeps every placeholder`, wrong.length === 0,
     wrong.slice(0, 4).map((k) => k.slice(0, 30)).join(" | "));
}

// ---- substitution --------------------------------------------------------
const fill = (text: string, vars: Record<string, unknown>) =>
  text.replace(/\{(\w+)\}/g, (whole, key) =>
    vars[key] === undefined ? whole : String(vars[key]));

ck("values are substituted", fill("{n} of {max} members.", { n: 3, max: 10 }) === "3 of 10 members.");
ck("a missing value renders as itself, not undefined",
   fill("{n} of {max}", { n: 1 }) === "1 of {max}");
ck("zero substitutes", fill("{n} results", { n: 0 }) === "0 results");

// ---- nothing user-authored is translated ---------------------------------
//
// The line the feature must not cross. Message bodies, names and channel names
// are the user's words, and a table that contained one would be rewriting what
// somebody said.
const forbidden = ["payload.content", "m.payload.content", "nameOf(", "s.name", "c.name"];
for (const code of codes.filter((c) => c !== "en")) {
  const leaked = Object.keys(LANGUAGES[code].strings).filter((k) =>
    forbidden.some((f) => k.includes(f)));
  ck(`${code} translates no user content`, leaked.length === 0, leaked.join(", "));
}

// The composer is where a message is typed; its placeholder is ours, the value
// never is.
ck("message bodies are not passed through t()",
   !/\bt\(\s*(?:m\.)?payload\.content/.test(html) && !/\bt\(\s*msg\.content/.test(html));

// ---- the tables agree with each other ------------------------------------
const base = Object.keys(LANGUAGES.es.strings).sort();
for (const code of codes.filter((c) => c !== "en" && c !== "es")) {
  const keys = Object.keys(LANGUAGES[code].strings).sort();
  const gaps = base.filter((k) => !keys.includes(k));
  ck(`${code} covers the same strings`, gaps.length === 0, gaps.slice(0, 5).join(", "));
}

// ---- lookup behaviour ----------------------------------------------------
let language = "en";
const t = (text: string) => {
  const table = (LANGUAGES[language] || { strings: {} }).strings || {};
  return table[text] || text;
};

ck("English passes through", t("Friends") === "Friends");

language = "es";
ck("a known string translates", t("Friends") === "Amigos", t("Friends"));
ck("an unknown string falls back to English",
   t("Something nobody has translated") === "Something nobody has translated");

language = "kl";
ck("an unknown language falls back to English", t("Friends") === "Friends");

// ---- locale matching -----------------------------------------------------
const systemLanguage = (tags: string[]) => {
  for (const tag of tags) {
    const b = String(tag).toLowerCase().split("-")[0];
    if (LANGUAGES[b]) return b;
  }
  return "en";
};

ck("exact tag matches", systemLanguage(["de"]) === "de");
ck("regional tag matches its base", systemLanguage(["pt-BR"]) === "pt");
ck("case is not significant", systemLanguage(["FR-CA"]) === "fr");
ck("first supported entry wins", systemLanguage(["kl", "is", "es-MX"]) === "es");
ck("nothing supported means English", systemLanguage(["kl", "is"]) === "en");
ck("no preference at all means English", systemLanguage([]) === "en");

// ---- the wiring in the page ----------------------------------------------
//
// Cheap string checks, but they catch the change that removes a call site and
// leaves the table looking healthy.
ck("preference is stored", /lang:\s*""/.test(html));
ck("the system is consulted", html.includes("navigator.languages"));
ck("boot adopts a language", html.includes("applyLanguage()"));
ck("static markup is translated too", html.includes("function translateStatic"));
ck("original English is kept for re-translation", html.includes("dataset.enTitle"));

// ---- tabbed dialogs ------------------------------------------------------
//
// Cheap structural checks on the split, because the failure mode is a whole
// section of settings that exists in the DOM and can never be reached.
const paneNames = [...html.matchAll(/\bpane\("([^"]+)"\)/g)].map((m) => m[1]);
ck("settings are split into panes", new Set(paneNames).size >= 5,
   [...new Set(paneNames)].join(", "));

ck("the tab strip translates its labels", /tab\.textContent = t\(name\)/.test(html));

// Save and Done act on every tab, so they belong to the dialog. If they were
// appended to a pane they would vanish whenever another tab was open.
ck("dialog buttons sit outside the panes",
   /buttons\(root, t\("Save"\)/.test(html) && /root\.appendChild\(r\)/.test(html));

ck("each tabbed dialog keeps a handle on the card",
   (html.match(/var pane = tabbed\(root\)/g) ?? []).length >= 3);

// A dialog opened after a tabbed one must not inherit its fixed height.
ck("the tabbed class is cleared between dialogs", /card\.className = "";/.test(html));

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
