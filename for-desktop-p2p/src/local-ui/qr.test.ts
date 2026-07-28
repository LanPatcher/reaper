import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The QR encoder in `index.html`.
 *
 * Written by hand, because that file has no build step and no module loader
 * and there is nowhere for a dependency to go. That is a reasonable trade
 * exactly once — when the result is pinned, which is what this is.
 *
 * ## How it was established as correct
 *
 * Not by looking at it. A QR code that is subtly wrong still looks like a QR
 * code, and the ways it can be wrong are invisible: the format bits placed
 * least-significant-first produce a perfectly plausible grid that every
 * scanner refuses, because the format is the first thing read and a reader
 * gives up before it reaches the data.
 *
 * So it was checked two ways while being written. Its data region was compared
 * module for module against the `qrcode` package with the mask forced, which
 * proves the encoding, the error correction, the interleave and the placement.
 * Then its output was rendered to pixels and read back with `jsQR` — sixty
 * eight strings including real onion addresses, every one decoding to exactly
 * what went in.
 *
 * Neither library is a dependency of this project and neither is needed to run
 * this test. What is kept here is the output that survived them.
 *
 * ## Why matrices and not round-trips
 *
 * Decoding needs a decoder, and adding one as a test dependency to check code
 * that exists to avoid a dependency would be a strange bargain. These are the
 * verified matrices; if the encoder changes what it produces, that is
 * something to have found out deliberately.
 *
 * A different *mask* would change every module here and still be a valid code
 * — the mask is recorded in the format bits. So this pins the choice as well
 * as the arithmetic, which is the stricter statement and the useful one.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

/** Matrices verified against `qrcode` and read back with `jsQR`. */
const VECTORS: Record<string, string> = {
  "x":
    "111111101011101111111/100000100011001000001/101110101101001011101/101110101100101011101/101110101001001011101/100000100111101000001/111111101010101111111/000000000001100000000/111100101111110011101/001010000101111001000/111110111011000001101/000100011111001111110/110001100010100100101/000000001001001001010/111111100101100101000/100000100000000110110/101110100110111110001/101110101111001111110/101110101100101100000/100000101100010100101/111111101010010010000",
  "hello":
    "111111100101101111111/100000101101001000001/101110101100101011101/101110100101001011101/101110101000101011101/100000101001101000001/111111101010101111111/000000001111100000000/110100110110001110110/011111011100001000011/001101111010110001101/000101001001000001011/000010110110101010000/000000001111000110101/111111101110010101110/100000100111110110000/101110100101001110001/101110101011000101111/101110100110100010101/100000101110011000000/111111101011100101010",
  "0123456789":
    "111111101100101111111/100000100100101000001/101110101010101011101/101110101001001011101/101110101110001011101/100000100000001000001/111111101010101111111/000000000110000000000/111100101010010011101/000001010110110010111/001110110110110000001/011101010000110000010/100010111111011001000/000000001000000111010/111111100010010010110/100000100011100000101/101110100111010100100/101110101100011100010/101110101001010101000/100000101111101001001/111111101001110111100",
  "VWW6YBAL4BD7SZMGNCYRUUCPGFKQAHZDDI37KTCEO3AH7NGMCOPNPYYD.ONION":
    "111111100010011001100000001111111/100000101110000111001111101000001/101110101000001101100000101011101/101110100100111000010110001011101/101110101110101010010000001011101/100000101010100111110100001000001/111111101010101010101010101111111/000000001011001001110100100000000/110100110001101111001001101110110/011011001101100110000001110001100/001100100001100001010000001101101/111110011111111010000101100011010/111000100011001110011000111010111/000100010001010011001001100011011/100100111101011010001111111001000/001101000111000111111101011110001/001100111000110000011010001100101/111000000110111111010100111000001/101100111001101000000000001101111/100110011100101111110110011110011/001000100110000101000001110111110/010001011101001111011101100000100/110100101010000011111010010110101/010100011110001100110100101000010/100100111110100100000000111111011/000000001001100100001010100010010/111111101110100010001011101011110/100000100110111101100110100010011/101110100101011010001100111110100/101110101100000110110111001010000/101110100100010010100111111010001/100000101111010001011100000110000/111111101101101111001110101111110",
  "reaper://sync/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.onion":
    "111111100001000010111101001111111/100000101010010101100000101000001/101110100101000000110101101011101/101110101101111101000010101011101/101110100001000010111101001011101/100000101010010101100000101000001/111111101010101010101010101111111/000000000000100000110101100000000/111110111111111101000010110101010/010101010101000010111101001001101/111000100100110101100000100111110/111010000111000000110101101101100/110000111101111101000010110111000/010101000011000010111101001000111/000111101110010101100000100010010/111101011101000000110101101010110/110110111001111101000010110111000/111001001101000010111101001100001/010101111110110101100000100010010/101011000001000000110101101100110/110101110001111101000010110110010/101010001011100010111101001001001/100101111100110101100000100111010/100110010001100000110101101010101/101111101100111101000010111110000/000000001111000010111100100011011/111111101010110101100001101011010/100000100111100000110101100011100/101110101000111101000010111111011/101110101011000010111100010110100/101110101110110101100000101001010/100000101001100000110100000001100/111111101100111101000011101111010"
};

// Pulled out of the page and run, rather than imported: `index.html` is one
// file with no exports, which is the same reason the encoder is in it.
const html = readFileSync(join(process.cwd(), "src/local-ui/index.html"), "utf8");

const from = html.indexOf("      // QR codes");
const to = html.indexOf("      /**\n       * A QR code as an `<svg>`");

if (from === -1 || to === -1) {
  console.log("FAIL  the QR encoder could not be found in index.html");
  process.exit(1);
}

const encoder = new Function(
  html.slice(from, to) + "\nreturn qrEncode;",
)() as (text: string) => number[][];

for (const [text, expected] of Object.entries(VECTORS)) {
  const rows = encoder(text).map((row) => row.join(""));
  const got = rows.join("/");

  ck(
    `${text.length > 24 ? text.slice(0, 21) + "…" : text} encodes to a known-good matrix`,
    got === expected,
    got === expected ? "" : `${rows.length}x${rows[0]?.length}`,
  );
}

// ---- the shape of what it produces -----------------------------------------

{
  const small = encoder("x");
  ck("a short string fits version one", small.length === 21, String(small.length));

  const address = encoder("a".repeat(56) + ".onion");
  ck("an onion address fits version four", address.length === 33,
     String(address.length));

  // The three finders, which is the first thing any scanner looks for.
  const corner = (grid: number[][], top: number, left: number) =>
    grid[top][left] === 1 && grid[top + 1][left + 1] === 0 &&
    grid[top + 3][left + 3] === 1 && grid[top + 6][left + 6] === 1;

  ck("with a finder in each of three corners",
     corner(address, 0, 0) &&
     corner(address, 0, address.length - 7) &&
     corner(address, address.length - 7, 0));

  // Always dark, and a scanner uses it to orient.
  ck("and the dark module where it belongs",
     address[address.length - 8][8] === 1);
}

// ---- refusals ---------------------------------------------------------------

{
  let refused = false;
  try { encoder("x".repeat(200)); } catch { refused = true; }

  // Version six at level L holds 134 bytes and nothing here is close to that.
  // Refusing loudly beats emitting a truncated code that scans to half an
  // address.
  ck("too much to encode is refused rather than truncated", refused);
}


/* ---- the size the pairing invite actually is ----------------------------- */

/**
 * The encoder has to accept a real invite.
 *
 * This is here because it did not. The invite grew when pairing was rebuilt —
 * a longer, encrypted payload where a bare onion address used to be — and the
 * encoder stops at version 6, so the Devices screen showed "too much for a QR
 * code this size" where the code belonged. Nothing connected the two files, so
 * nothing caught it.
 *
 * Asserting the real thing rather than a length is the point: a constant here
 * would drift the moment the invite format changed again, which is precisely
 * the change that broke it.
 */
{
  const { mintInvite } = await import("../p2p/pair");

  const raw = Buffer.concat([randomBytes(34), Buffer.from([3])]);
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, spelled = "";
  for (const byte of raw) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { spelled += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }

  // Minted rather than assembled by hand, so this is the code the app actually
  // shows — salt, session id, expiry and all. A hand-built one would stay the
  // same size while the real one grew, which is exactly how the encoder came to
  // be handed something it could not take.
  const { code } = mintInvite(spelled.toLowerCase() + ".onion");

  let encoded = true;
  let why = "";

  try {
    encoder(code);
  } catch (error) {
    encoded = false;
    why = (error as Error).message;
  }

  ck("the encoder takes a real pairing invite", encoded, why);

  // Room to spare, so a small format change does not put it over again.
  ck(
    "with room left before the encoder's limit",
    code.length <= 100,
    `${code.length} of 134 bytes`,
  );
}

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
