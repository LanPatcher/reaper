import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The compact friend code in `index.html`.
 *
 * ## What it is for
 *
 * A friend code is base64 of JSON — an id, an onion address, an encryption key
 * and a name — which comes to 246 characters. The QR encoder in the same file
 * stops at version six and 134 bytes, so the ordinary code cannot be a picture
 * at all. The compact form drops the name and stores the other three as what
 * they actually are rather than as their spelling.
 *
 * ## Why this is tested rather than eyeballed
 *
 * Every field is a repacking, and a repacking that is subtly wrong still
 * produces a plausible-looking string. An id off by one symbol names nobody; an
 * onion address off by one names a service that does not exist; a key off by
 * one derives a shared secret the other side does not have, and *that* one
 * fails silently as a conversation neither party can read.
 *
 * So the properties held down here are: it round-trips exactly, it fits inside
 * the encoder it exists for, and it refuses what it cannot read instead of
 * returning something plausible.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

const html = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");

const from = html.indexOf("      // ---- compact friend codes");
const to = html.indexOf("      // ---- end compact friend codes");

if (from < 0 || to < 0) {
  console.log("FAIL  the compact friend code helpers could not be found in index.html");
  process.exit(1);
}

/**
 * The helpers depend on `me` and `myOnion`, which are interface state. They are
 * supplied here so the pure part can be exercised on its own.
 */
const build = new Function(
  "me",
  "myOnion",
  "btoa",
  "atob",
  "decodeCode",
  html.slice(from, to) +
    "\nreturn { compactFriendCode: compactFriendCode, readFriendCode: readFriendCode };",
);

const b64 = (s: string) => Buffer.from(s, "binary").toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("binary");

/** A real-shaped account: 26-symbol id, 56-character onion, 32-byte key. */
const ID = "0123456789ABCDEFGHJKMNPQRS";
const ONION = "abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx";
const EK = Buffer.alloc(32, 7).toString("base64");

const api = build(
  { userId: ID, encPublicKey: EK },
  `${ONION}.onion`,
  b64,
  unb64,
  () => null,
);

const code = api.compactFriendCode() as string;

// ---- it fits, which is the whole reason it exists ------------------------
{
  ck("a compact code is produced", typeof code === "string" && code.length > 0);
  ck("it is marked as one", code.startsWith("R3"));
  ck("and it fits inside the QR encoder", code.length <= 134, `${code.length} of 134`);

  // The long form, for contrast — this is what does not fit.
  const long = Buffer.from(
    JSON.stringify({ k: "f", id: ID, n: "someusername", at: `${ONION}.onion`, ek: EK }),
    "utf8",
  ).toString("base64").replace(/=+$/, "");

  ck("...where the long form does not", long.length > 134, `${long.length} of 134`);
}

// ---- and it says exactly what went in ------------------------------------
{
  const read = api.readFriendCode(code) as {
    id: string; at: string; ek: string; n: string;
  };

  ck("the id survives", read.id === ID, read.id);
  ck("the address survives", read.at === `${ONION}.onion`, read.at);
  ck("the key survives",
     Buffer.from(read.ek, "base64").equals(Buffer.from(EK, "base64")),
     read.ek);
  ck("the name is deliberately absent", read.n === "");
}

// ---- a scanner may wrap it -----------------------------------------------
{
  const read = api.readFriendCode(`reaper://friend/${code}`) as { id: string };
  ck("a url wrapper is unwrapped", read && read.id === ID);

  const spaced = api.readFriendCode(`  ${code}  `) as { id: string };
  ck("and surrounding space is ignored", spaced && spaced.id === ID);
}

// ---- refusing, rather than inventing --------------------------------------
{
  ck("nothing reads as nothing", api.readFriendCode("") === null);
  ck("a truncated code is refused", api.readFriendCode(code.slice(0, 40)) === null);
  ck("a code of the wrong version is refused",
     api.readFriendCode("R3" + Buffer.concat([
       Buffer.from([9]), Buffer.alloc(84),
     ]).toString("base64").replace(/=+$/, "")) === null);
  ck("rubbish is refused", api.readFriendCode("R3not base64 at all!!") === null);
}

// ---- the long form still works everywhere the short one does --------------
{
  const legacy = { k: "f", id: ID, n: "ray", at: `${ONION}.onion`, ek: EK };
  const withLegacy = build(
    { userId: ID, encPublicKey: EK },
    `${ONION}.onion`,
    b64,
    unb64,
    (text: string) => (text === "LONG" ? legacy : null),
  );

  const read = withLegacy.readFriendCode("LONG") as { id: string; n: string };
  ck("a pasted long code is still accepted", read && read.id === ID);
  ck("and it keeps its name", read.n === "ray");
}

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
