import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { torGet } from "../native/torFetch";

/**
 * What an AI character is allowed to do beyond talking.
 *
 * Two capabilities, both off unless the user turns them on for that character:
 * reading the open web, and reading and writing one folder they chose.
 *
 * ## The shape of the risk, stated plainly
 *
 * With both on at once these compose into a way for a web page to reach the
 * user's files. A page the model reads is untrusted text; if it contains
 * instructions and the model follows them, it can be told to read a file and
 * put what it found into the next address it fetches. Nothing here can prevent
 * that in general — a model that can both read your files and choose a URL has
 * a channel out, and that is what "browse freely" means.
 *
 * So what is done instead is to make it survivable and visible:
 *
 *   * The folder is one the user picked, and nothing outside it is reachable —
 *     `..`, absolute paths and symlinks all resolve and are checked against the
 *     real root before anything opens.
 *   * Every overwrite keeps the previous version under `.reaper-backups`. A
 *     0.5B model misreading an instruction is a normal event, not an unlikely
 *     one, so it must not be able to destroy work.
 *   * Every action is returned to the interface and shown in the transcript.
 *     A capability the user cannot watch is one they cannot judge.
 *   * Caps on size and count, so a model stuck in a loop cannot fill a disk.
 *
 * The honest summary for the interface is in `WARNING` below.
 */

export const WARNING =
  "With both web and folder access on, a page this character reads could tell " +
  "it to send your files somewhere. Turn on only what you need.";

/** A model that loops must not be able to fill a disk or a context window. */
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LIST = 200;
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_PAGE_CHARS = 4000;
const MAX_WRITE_BYTES = 1024 * 1024;

/** Text this app is willing to hand a model, or accept back from one. */
const TEXT_EXT =
  /\.(txt|md|markdown|csv|tsv|json|ya?ml|toml|ini|cfg|conf|log|xml|html?|css|js|ts|jsx|tsx|py|rb|rs|go|java|c|h|cpp|hpp|cs|sh|bat|ps1|sql)$/i;

export interface ToolResult {
  /** One line for the transcript, so the user sees what happened. */
  note: string;
  /** What the model is told. Empty when there is nothing useful to say. */
  detail: string;
  ok: boolean;
}

// ---------------------------------------------------------------- the folder

/**
 * Resolve `name` inside `root`, or refuse.
 *
 * The check is done on the *real* paths, after symlinks. A link inside the
 * folder pointing at `C:\Users` is otherwise a way out of it that no amount of
 * string checking on the name would catch, and "the folder you chose" has to
 * mean the folder rather than everywhere it happens to point.
 */
export function insideFolder(root: string, name: string): string | null {
  if (!root || !name) return null;
  if (name.includes("\0")) return null;

  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(root));
  } catch {
    return null;
  }

  const target = resolve(realRoot, name);

  // The parent has to exist and be inside; the file itself may not exist yet,
  // which is the ordinary case for a write.
  let anchor = target;
  while (!existsSync(anchor) && dirname(anchor) !== anchor) anchor = dirname(anchor);

  let realAnchor: string;
  try {
    realAnchor = realpathSync(anchor);
  } catch {
    return null;
  }

  const rest = relative(anchor, target);
  const real = rest ? join(realAnchor, rest) : realAnchor;

  const within = relative(realRoot, real);
  if (within === "") return real;
  if (within.startsWith("..") || within.includes(".." + sep)) return null;
  if (resolve(realRoot, within) !== real) return null;

  // Our own backups are not part of the folder as far as the model is
  // concerned, or it would read and rewrite its own history.
  if (within.split(sep)[0] === ".reaper-backups") return null;

  return real;
}

export function listFolder(root: string): ToolResult {
  try {
    const names: string[] = [];

    const walk = (dir: string, depth: number) => {
      if (names.length >= MAX_LIST || depth > 3) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (names.length >= MAX_LIST) return;
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          const rel = relative(root, full).split(sep).join("/");
          const size = statSync(full).size;
          names.push(`${rel} (${size} bytes)`);
        }
      }
    };

    walk(resolve(root), 0);

    return {
      ok: true,
      note: `listed ${names.length} file(s)`,
      detail: names.length
        ? `Files in the folder:\n${names.join("\n")}`
        : "The folder is empty.",
    };
  } catch (error) {
    return { ok: false, note: "could not list the folder", detail: String(error) };
  }
}

export function readFile(root: string, name: string): ToolResult {
  const path = insideFolder(root, name);
  if (!path) {
    return { ok: false, note: `refused to read ${name}`, detail: "That path is outside the folder." };
  }
  if (!TEXT_EXT.test(path)) {
    return { ok: false, note: `refused to read ${name}`, detail: "That is not a text file." };
  }

  try {
    const size = statSync(path).size;
    const text = readFileSync(path, "utf8").slice(0, MAX_FILE_BYTES);
    return {
      ok: true,
      note: `read ${name} (${size} bytes)`,
      detail: `Contents of ${name}:\n${text}`,
    };
  } catch (error) {
    return { ok: false, note: `could not read ${name}`, detail: String(error) };
  }
}

/**
 * Write a file, keeping whatever was there before.
 *
 * The backup is the whole reason this is allowed at all. A small model
 * misunderstanding "tidy up my notes" and replacing a file with one sentence is
 * an ordinary failure, and without a copy it is also a permanent one.
 */
export function writeFile(root: string, name: string, content: string): ToolResult {
  const path = insideFolder(root, name);
  if (!path) {
    return { ok: false, note: `refused to write ${name}`, detail: "That path is outside the folder." };
  }
  if (!TEXT_EXT.test(path)) {
    return { ok: false, note: `refused to write ${name}`, detail: "Only text files may be written." };
  }
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    return { ok: false, note: `refused to write ${name}`, detail: "That is too large to write." };
  }

  try {
    let backed = "";
    if (existsSync(path)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const rel = relative(resolve(root), path);
      const backup = join(resolve(root), ".reaper-backups", `${stamp}__${rel.split(sep).join("__")}`);
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(path, backup);
      backed = " (previous version kept in .reaper-backups)";
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");

    return {
      ok: true,
      note: `wrote ${name}${backed}`,
      detail: `Saved ${name}.`,
    };
  } catch (error) {
    return { ok: false, note: `could not write ${name}`, detail: String(error) };
  }
}

// ------------------------------------------------------------------- the web

/** Strip a page down to the words in it. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function fetchPage(href: string): Promise<ToolResult> {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { ok: false, note: `not a link: ${href}`, detail: "That is not a valid address." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, note: `refused ${url.host}`, detail: "Only https addresses are fetched." };
  }

  let target = url.toString();

  for (let hop = 0; hop < 3; hop++) {
    let response;
    try {
      response = await torGet(target, { accept: "text/html,text/plain", maxBytes: MAX_PAGE_BYTES });
    } catch (error) {
      const message = (error as Error).message || String(error);
      // Worth naming: a good many sites refuse Tor exits outright, and that is
      // a different problem from the page not existing.
      return {
        ok: false,
        note: `could not reach ${new URL(target).host}`,
        detail: `Could not reach it over Tor (${message}). Many sites block Tor.`,
      };
    }

    if (response.status >= 300 && response.status < 400 && response.location) {
      target = new URL(response.location, target).toString();
      continue;
    }

    if (response.status !== 200) {
      return {
        ok: false,
        note: `${new URL(target).host} answered ${response.status}`,
        detail: `That page returned ${response.status}.`,
      };
    }

    const text = htmlToText(response.body.toString("utf8")).slice(0, MAX_PAGE_CHARS);
    const host = new URL(target).host;

    return {
      ok: true,
      note: `read ${host}`,
      detail: `Text of ${target}:\n${text}`,
    };
  }

  return { ok: false, note: "too many redirects", detail: "That address redirected too many times." };
}

/**
 * A web search, over Tor.
 *
 * DuckDuckGo's plain-HTML endpoint, because it needs no key and no JavaScript.
 * It refuses Tor exits often enough that the failure is reported as itself
 * rather than as "nothing found" — a model told there are no results will
 * confidently say so.
 */
export async function search(query: string): Promise<ToolResult> {
  const q = query.trim().slice(0, 200);
  if (!q) return { ok: false, note: "empty search", detail: "No search terms were given." };

  const href = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q);

  let response;
  try {
    response = await torGet(href, { accept: "text/html", maxBytes: MAX_PAGE_BYTES });
  } catch (error) {
    return {
      ok: false,
      note: `search failed: ${q}`,
      detail: `The search could not be run over Tor (${(error as Error).message}).`,
    };
  }

  if (response.status !== 200) {
    return { ok: false, note: `search failed: ${q}`, detail: `The search engine answered ${response.status}.` };
  }

  const html = response.body.toString("utf8");
  const results: string[] = [];
  const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(html)) !== null && results.length < 6) {
    const title = htmlToText(m[2]);
    let link = m[1];
    // DuckDuckGo wraps results in a redirect; the real address is a parameter.
    const wrapped = /[?&]uddg=([^&]+)/.exec(link);
    if (wrapped) link = decodeURIComponent(wrapped[1]);
    if (title && link.startsWith("http")) {
      results.push(`${results.length + 1}. ${title}\n   ${link}`);
    }
  }

  if (!results.length) {
    return { ok: false, note: `no results for ${q}`, detail: "The search returned nothing readable." };
  }

  return {
    ok: true,
    note: `searched for ${q}`,
    detail:
      `These are the real search results for "${q}". ` +
      `The links below are real and may be quoted exactly:\n\n` +
      results.join("\n\n"),
  };
}
