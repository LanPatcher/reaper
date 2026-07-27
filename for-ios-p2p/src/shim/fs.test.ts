import { Buffer } from "buffer";

/**
 * The in-memory filesystem, and whether it persists what it claims to.
 *
 * `fs.ts` answers synchronously from memory and writes through to Capacitor in
 * the background, because the log is written with `appendFileSync` and no
 * filesystem a WebView can reach is synchronous. That arrangement has one
 * dangerous failure: reads that look right in a session and turn out never to
 * have reached the disk. On the next launch the app finds no identity, decides
 * it is a fresh install, and generates a new account — which is not a bug that
 * announces itself, it is an account that quietly no longer exists.
 *
 * So the shape of this test is: do the operations, flush, throw away the
 * memory, load again, and check it is all still there.
 *
 * Capacitor is stubbed with something that behaves the way the real plugin
 * does — base64 in and out, directories that must exist before a write — since
 * the point is to test the shim, not the plugin.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

// The plugin is replaced by `scripts/shim.mjs`, which aliases it to the stub
// below — so `fs.ts` and this file are looking at the same "disk".
import { disk } from "./fs-stub";

import * as fs from "./fs";

// ---- the synchronous surface ------------------------------------------------
{
  await fs.ready();

  ck("an empty tree has nothing in it", !fs.existsSync("communities/c1/log"));

  fs.mkdirSync("communities/c1", { recursive: true });
  fs.writeFileSync("communities/c1/head", Buffer.from("first"));

  ck("a written file is there immediately", fs.existsSync("communities/c1/head"));
  ck("and reads back the same bytes",
     fs.readFileSync("communities/c1/head").equals(Buffer.from("first")));

  // The log appends rather than rewrites, which is the hot path.
  fs.appendFileSync("communities/c1/head", Buffer.from("-second"));
  ck("appending concatenates",
     fs.readFileSync("communities/c1/head").toString() === "first-second");

  // Appending to something absent creates it, as Node does.
  fs.appendFileSync("communities/c1/new", Buffer.from("fresh"));
  ck("appending to nothing creates it",
     fs.readFileSync("communities/c1/new").toString() === "fresh");

  ck("size is reported", fs.statSync("communities/c1/head").size === 12,
     String(fs.statSync("communities/c1/head").size));

  // A missing file has to throw with a code, because callers distinguish
  // "not written yet" from "something is wrong".
  let code = "";
  try {
    fs.readFileSync("communities/c1/absent");
  } catch (error) {
    code = (error as { code?: string }).code ?? "";
  }
  ck("a missing file throws ENOENT", code === "ENOENT", code);
}

// ---- directories ------------------------------------------------------------
//
// There are none, really — a directory exists when something is inside it —
// and `knownCommunities()` walks them with `withFileTypes`, so that has to work
// anyway.
{
  fs.writeFileSync("communities/c2/log/0000", Buffer.from("x"));
  fs.writeFileSync("communities/c2/log/0001", Buffer.from("y"));
  fs.writeFileSync("blobs/c1/abc", Buffer.from("z"));

  const communities = fs.readdirSync("communities", { withFileTypes: true }) as {
    name: string;
    isDirectory(): boolean;
  }[];

  ck("directories are listed", communities.length === 2,
     communities.map((e) => e.name).join(","));
  ck("and are reported as directories",
     communities.every((entry) => entry.isDirectory()));

  const names = fs.readdirSync("communities/c2/log") as string[];
  ck("files are listed by name", names.join(",") === "0000,0001", names.join(","));

  ck("a directory exists once it holds something", fs.existsSync("blobs/c1"));
  ck("and not otherwise", !fs.existsSync("blobs/c9"));
}

// ---- moving and removing ----------------------------------------------------
//
// Compaction stages a new log beside the old one, renames both, and deletes.
// Getting this wrong loses a community's entire history.
{
  fs.writeFileSync("communities/c3/log/a", Buffer.from("one"));
  fs.writeFileSync("communities/c3/log/b", Buffer.from("two"));

  fs.renameSync("communities/c3/log", "communities/c3/previous");

  ck("a rename moves the whole subtree",
     !fs.existsSync("communities/c3/log") &&
     fs.readFileSync("communities/c3/previous/a").toString() === "one");

  fs.cpSync("communities/c3/previous", "communities/c3/copy", { recursive: true });
  ck("a copy duplicates it",
     fs.readFileSync("communities/c3/copy/b").toString() === "two");

  // And the copy is independent, or compaction would rewrite the original it
  // is meant to be staging beside.
  fs.writeFileSync("communities/c3/copy/b", Buffer.from("changed"));
  ck("the copy is independent",
     fs.readFileSync("communities/c3/previous/b").toString() === "two");

  fs.rmSync("communities/c3/previous", { recursive: true, force: true });
  ck("a recursive remove takes the subtree",
     !fs.existsSync("communities/c3/previous/a") &&
     !fs.existsSync("communities/c3/previous"));

  fs.unlinkSync("communities/c3/copy/a");
  ck("and a single file can go on its own",
     !fs.existsSync("communities/c3/copy/a") &&
     fs.existsSync("communities/c3/copy/b"));
}

// ---- persistence, which is the whole point ----------------------------------
{
  await fs.flush();

  ck("something reached the disk", disk.size > 0, `${disk.size} files`);
  ck("and it is stored under the app's own directory",
     [...disk.keys()].every((path) => path.startsWith("reaper/")));

  // Now the part that matters: throw the memory away and load from what was
  // actually written. This is a relaunch.
  await fs.ready();

  ck("the log survives a relaunch",
     fs.readFileSync("communities/c1/head").toString() === "first-second");
  ck("so do nested files",
     fs.readFileSync("communities/c2/log/0001").toString() === "y");
  ck("and blobs",
     fs.readFileSync("blobs/c1/abc").toString() === "z");

  ck("deleted files stay deleted", !fs.existsSync("communities/c3/previous/a"));
  ck("and so does a single unlinked one", !fs.existsSync("communities/c3/copy/a"));
  ck("while what was renamed is at its new name",
     fs.existsSync("communities/c3/copy/b"));

  // Directory listings have to survive too, since that is how communities are
  // discovered at startup.
  const communities = fs.readdirSync("communities") as string[];
  ck("communities are discoverable after a relaunch",
     communities.includes("c1") && communities.includes("c2"),
     communities.join(","));
}

// ---- binary ------------------------------------------------------------------
//
// Everything here is either an encrypted frame or a content-addressed blob, so
// a base64 round trip that mangles high bytes would corrupt all of it — and
// only on the second launch.
{
  const bytes = Buffer.alloc(4096);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) % 256;

  fs.writeFileSync("blobs/c1/binary", bytes);
  await fs.flush();
  await fs.ready();

  ck("arbitrary bytes survive the round trip",
     fs.readFileSync("blobs/c1/binary").equals(bytes));
}

// ---- flushing ----------------------------------------------------------------
{
  fs.writeFileSync("communities/c1/pending", Buffer.from("not yet"));

  // Deliberately not flushed. The debounce is what makes appends cheap, and
  // the cost of it is a window where a write is only in memory — which is why
  // the app also flushes when it leaves the foreground.
  ck("a fresh write is readable before it is persisted",
     fs.readFileSync("communities/c1/pending").toString() === "not yet");
  ck("but is not on the disk yet", !disk.has("reaper/communities/c1/pending"));

  await fs.flush();
  ck("flushing puts it there", disk.has("reaper/communities/c1/pending"));

  // Flushing twice must not throw or duplicate.
  await Promise.all([fs.flush(), fs.flush()]);
  ck("concurrent flushes are safe", disk.has("reaper/communities/c1/pending"));

  ck("held bytes are reported", fs.heldBytes() > 0, String(fs.heldBytes()));
}

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
