import { createRequire } from "node:module";

import { registerP2PHandlers } from "../../../for-desktop-p2p/src/p2p/bridge";

import { invoke } from "./electron";
import { ready as filesystemReady } from "./fs";
import { grantPort, reset } from "./socket-stub";
import { ready as brotliReady } from "./zlib";

/**
 * Startup, run rather than reasoned about.
 *
 * Every failure this app has had on a phone has been the same shape: a step in
 * `boot.ts` that never finished, no error anywhere, and a screen holding on one
 * row for ever. `Buffer` undefined at module scope. A port bound twice. A
 * callback passed in a position the shim did not read. None of them threw.
 * Each cost a full build cycle to find, because each was diagnosed by reading.
 *
 * Reading is what failed. A bundle can be inspected all day and it will not
 * tell you that a promise never settles — only running it does.
 *
 * So this runs the real sequence: the real `bridge.ts`, the real `Transport`,
 * the real handler registration, over the shims, with the native plugins
 * standing in. What it cannot cover is Swift, and that is the honest boundary —
 * everything on this side of the bridge is exercised, and every hang so far
 * has been on this side.
 *
 * The timeout is the whole point of the file. A test for a freeze must fail
 * rather than freeze, or it reproduces the bug instead of reporting it.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

async function step<T>(what: string, ms: number, work: Promise<T>): Promise<T | undefined> {
  const outcome = await Promise.race([
    work.then((value) => ({ ok: true as const, value })),
    new Promise<{ ok: false; value: undefined }>((resolve) =>
      setTimeout(() => resolve({ ok: false, value: undefined }), ms)),
  ]).catch((error: Error) => ({ ok: false as const, value: undefined, error }));

  if (!outcome.ok) {
    const why = "error" in outcome && outcome.error
      ? (outcome.error as Error).message
      : `did not finish within ${ms}ms — this is the freeze`;
    ck(what, false, why);
    return undefined;
  }

  ck(what, true);
  return outcome.value;
}

// ---- the same order `boot.ts` uses ------------------------------------------

reset();
grantPort(51999);

await step("the filesystem comes up", 10_000, filesystemReady());

// `brotli-wasm` ships three entry points around one WebAssembly binary. The
// browser one fetches the `.wasm` over HTTP — correct inside a WebView, where
// it comes from the app's own bundle, and impossible under Node. The Node
// entry point is handed in instead, exactly as `zlib.test.ts` does: it changes
// how the binary is obtained and nothing about what it computes.
const nodeBrotli = createRequire(import.meta.url)("brotli-wasm");
await step("brotli loads", 20_000, brotliReady(() => Promise.resolve(nodeBrotli)));

// The core. It loads the identity, opens the index and registers every handler
// the interface calls — and it is where `Buffer` being undefined used to stop
// the whole module graph before a line of it ran.
{
  let failed: Error | undefined;
  try {
    registerP2PHandlers();
  } catch (error) {
    failed = error as Error;
  }

  ck("the handlers register", !failed, failed?.message);
}

// ---- the step that froze ----------------------------------------------------
//
// `netStart` binds a listener and then builds a `TorService`. Both have hung
// here before, for unrelated reasons, and neither reported anything: the bind
// waited on a callback that was never called, and the Tor object was missing
// the `on` its constructor's very next line uses.

{
  const started = await step(
    "the network starts",
    15_000,
    invoke("p2p:netStart", 0) as Promise<{ port: number }>,
  );

  ck("and reports a port Tor can be pointed at",
     !!started && started.port === 51999, String(started?.port));
}

// ---- what the interface asks for on its first line --------------------------
//
// A surface that resolves but answers nothing leaves the page blank with no
// error, which is the same failure wearing a different coat.

{
  const me = await step(
    "the identity is readable",
    5_000,
    invoke("p2p:identity") as Promise<{ userId?: string }>,
  );

  ck("and it has a user id", !!me?.userId, JSON.stringify(me));
}

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
