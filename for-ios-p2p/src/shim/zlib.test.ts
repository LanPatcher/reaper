import { createRequire } from "node:module";
import { brotliCompressSync as nodeCompress, brotliDecompressSync as nodeDecompress } from "node:zlib";

import { Buffer } from "buffer";

import { brotliCompressSync, brotliDecompressSync, constants, isReady, ready } from "./zlib";

/**
 * Brotli in a WebView, against Brotli in Node.
 *
 * The stakes are the same as in `crypto.test.ts` and the failure looks
 * different: compression is part of two formats that have to agree, so a phone
 * that compresses differently produces a log the desktop cannot open and reads
 * nothing a desktop peer sends. It would connect happily and receive garbage.
 *
 * Both directions are checked, because they fail differently. Decompression
 * failing means a phone cannot read what it is sent. Compression failing means
 * nothing else can read what the phone writes — which is worse, since the
 * damage is on disk and permanent.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

// ---- the loading rule -------------------------------------------------------
//
// WebAssembly instantiates asynchronously and everything above this is
// synchronous, so the module is loaded once at startup. Using it before that
// has to be loud: falling back to writing data uncompressed would produce
// frames that claim to be Brotli and are not, and nothing would notice until
// another device tried to read them.
{
  ck("nothing is available before loading", !isReady());

  let threw = false;
  try {
    brotliCompressSync(Buffer.from("too early"));
  } catch {
    threw = true;
  }
  ck("and using it early throws rather than guessing", threw);
}

// The Node entry point rather than the browser one: same WebAssembly, fetched
// differently. `require` picks it, because the package only exports the web
// build to `import`.
const nodeEntry = createRequire(import.meta.url)("brotli-wasm");

await ready(() => Promise.resolve(nodeEntry));
ck("loading makes it available", isReady());

// Loading twice must not reload — startup calls it from more than one place.
await ready();
ck("loading again is harmless", isReady());

// ---- round trips ------------------------------------------------------------
{
  const cases: [string, Buffer][] = [
    ["nothing", Buffer.alloc(0)],
    ["one byte", Buffer.from([42])],
    ["a short message", Buffer.from(JSON.stringify({ content: "hello" }), "utf8")],
    ["repetitive text", Buffer.from("the same thing ".repeat(400), "utf8")],
    ["random bytes", Buffer.from(
      Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256),
    )],
    ["unicode", Buffer.from("héllo wörld 😀 ".repeat(50), "utf8")],
  ];

  for (const [name, input] of cases) {
    const mine = brotliCompressSync(input);

    ck(`node reads what the shim compressed — ${name}`,
       nodeDecompress(mine).equals(input));

    ck(`and the shim reads what node compressed — ${name}`,
       brotliDecompressSync(nodeCompress(input)).equals(input));
  }
}

// ---- the settings the log actually uses -------------------------------------
//
// `encodeFrame` compresses at quality 5 with a size hint and text mode. The
// hint and the mode do not have to be honoured — Brotli is self-describing, so
// a stream compressed with different settings still decompresses — but quality
// has to be accepted rather than throwing.
{
  const payload = Buffer.from(
    JSON.stringify(Array.from({ length: 200 }, (_, i) => ({
      type: "message.send",
      community: "c1",
      payload: { content: `message number ${i}` },
    }))),
    "utf8",
  );

  const options = {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 5,
      [constants.BROTLI_PARAM_SIZE_HINT]: payload.length,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
    },
  };

  const mine = brotliCompressSync(payload, options);

  ck("the frame settings are accepted", mine.length > 0);
  ck("node reads a frame the phone wrote", nodeDecompress(mine).equals(payload));

  // The reason batching exists at all: a log of similar events should shrink a
  // long way, and if it does not, something is being compressed one event at a
  // time and the whole arrangement is pointless.
  ck("a batch of events compresses hard", mine.length < payload.length / 5,
     `${payload.length} -> ${mine.length}`);
}

// ---- the wire ---------------------------------------------------------------
//
// The transport compresses anything over 256 bytes and sets a flag. A desktop
// peer sets that flag constantly, so this is the path a phone spends most of
// its time on.
{
  const frame = Buffer.from(
    JSON.stringify({ t: "push", community: "c1", events: Array(40).fill({
      type: "message.send", payload: { content: "chatter" },
    }) }),
    "utf8",
  );

  const fromDesktop = nodeCompress(frame, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
  });

  ck("a phone reads a desktop's compressed frame",
     brotliDecompressSync(fromDesktop).equals(frame));

  // And something large, since attachments go over the same wire.
  const big = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251;

  ck("a megabyte survives the round trip",
     brotliDecompressSync(brotliCompressSync(big)).equals(big));
}

// ---- corruption -------------------------------------------------------------
//
// A truncated or altered stream has to fail rather than produce partial output
// that would then be parsed as events.
{
  const good = brotliCompressSync(Buffer.from("something worth keeping".repeat(20)));

  let threw = false;
  try {
    brotliDecompressSync(good.subarray(0, Math.floor(good.length / 2)));
  } catch {
    threw = true;
  }
  ck("a truncated stream is refused", threw);

  const bent = Buffer.from(good);
  bent[Math.floor(bent.length / 2)] ^= 0xff;

  let refused = false;
  try {
    const out = brotliDecompressSync(bent);
    // Brotli can occasionally decode a corrupted stream to *something*. What
    // matters is that it is not silently accepted as the original.
    refused = !out.equals(Buffer.from("something worth keeping".repeat(20)));
  } catch {
    refused = true;
  }
  ck("a corrupted stream does not decode to the original", refused);
}

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
