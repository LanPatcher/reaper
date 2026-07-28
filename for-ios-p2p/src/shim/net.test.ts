import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Transport } from "../../../for-desktop-p2p/src/p2p/transport";

import { createServer, setProxyPort, Socket } from "./net";
import { calls, fire, grantPort, reset } from "./socket-stub";

/**
 * `node:net`, as the shared core actually calls it.
 *
 * This test exists because of a freeze, and the freeze is worth writing down
 * because the shape of it will happen again.
 *
 * `transport.ts` opens its listener like this:
 *
 *     this.#server.listen(port, () => resolve(this.port!));
 *
 * Node accepts a callback in the second position. This shim did not — it read
 * that parameter as a hostname and looked for the callback in the third, where
 * there was nothing. `onListening?.()` then did exactly nothing, and the
 * optional-call operator turned a wrong argument into silence.
 *
 * What followed had no error in it anywhere. `transport.listen` never
 * resolved, so `netStart` never returned, so `boot()` never settled, so the
 * interface was never shown — and the app sat on "Starting Tor" indefinitely.
 * Every layer was patiently waiting for something reasonable. There was
 * nothing to catch, nothing logged, and nothing on screen but a row that never
 * changed.
 *
 * The general lesson, which is the reason this file is not just one assertion:
 * a shim for somebody else's interface has to accept everything its callers
 * actually use, and the callers here are a core written against Node that uses
 * Node's overloads freely. Implementing the tidy signature and quietly
 * ignoring the rest is how a shim passes review and hangs on a device.
 *
 * So this drives the shim through every call shape the core uses — and then
 * runs the real `Transport` against it, which is the path that actually broke.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

/**
 * Fail rather than hang. A test for a freeze must not be able to freeze.
 *
 * The timer is cleared on success rather than unreferenced. An unreferenced
 * timer lets Node exit the moment nothing else is pending — so a test that
 * hung printed "Detected unsettled top-level await" and stopped, with no line
 * saying which assertion never finished. Reporting is the entire job here.
 */
function within<T>(what: string, ms: number, work: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout>;

  const expiry = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      console.log(`FAIL  ${what} did not finish within ${ms}ms — this is the freeze`);
      f++;
      resolve(undefined);
    }, ms);
  });

  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

// ---- listen(port, callback) — the two-argument form -------------------------

{
  reset();
  grantPort(51820);

  const server = createServer(() => {});

  const listened = await within(
    "listen(port, callback)",
    1000,
    new Promise<number>((resolve) => {
      // Exactly the call `transport.ts` makes. Written the same way on
      // purpose: a test that used the three-argument form would have passed
      // throughout the entire time the app was frozen.
      server.listen(0, () => resolve(server.address()?.port ?? 0));
    }),
  );

  ck("a callback in the second position is called", listened === 51820, String(listened));
  ck("and the port it reports is the one the system granted",
     server.address()?.port === 51820);

  server.close();
}

// ---- listen(port, host, callback) — still works -----------------------------

{
  reset();
  grantPort(51821);

  const server = createServer(() => {});

  const listened = await within(
    "listen(port, host, callback)",
    1000,
    new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server.address()?.port ?? 0));
    }),
  );

  ck("a callback in the third position is still called", listened === 51821);
  server.close();
}

// ---- a port that was not granted -------------------------------------------
//
// Reported rather than resolved with zero. `transport.listen` reads
// `this.port!` off `address()`, so a zero would throw a TypeError inside a
// `.then` nobody catches — another promise that never settles, from another
// direction.

{
  reset();
  grantPort(0);

  const server = createServer(() => {});

  const outcome = await within(
    "a refused bind",
    1000,
    new Promise<string>((resolve) => {
      server.on("error", (error: Error) => resolve(error.message));
      server.listen(0, () => resolve("listening"));
    }),
  );

  ck("no port is an error rather than a silence",
     typeof outcome === "string" && outcome !== "listening", String(outcome));
}

// ---- connect(port, callback) and connect(port, host, callback) --------------

{
  reset();
  setProxyPort(9050);

  const two = new Socket();
  const connected = await within(
    "connect(port, callback)",
    1000,
    new Promise<boolean>((resolve) => { two.connect(80, () => resolve(true)); }),
  );

  ck("connect calls a callback in the second position", connected === true);
  ck("and dials loopback when no host was given",
     calls.find((c) => c.name === "connect")?.args.host === "127.0.0.1");

  reset();
  const three = new Socket();
  const named = await within(
    "connect(port, host, callback)",
    1000,
    new Promise<string>((resolve) => {
      three.connect(80, "example.onion", () =>
        resolve(String(calls.find((c) => c.name === "connect")?.args.host)));
    }),
  );

  ck("and passes an onion address through untouched",
     named === "example.onion", String(named));
}

// ---- write(data, callback) --------------------------------------------------
//
// `transport.ts` sends with `socket.write(frame, () => undefined)`. Nothing
// depends on that callback today, which is precisely why it would be safe to
// drop and then unsafe the moment something did.

{
  reset();
  setProxyPort(9050);

  const socket = new Socket();
  await new Promise<void>((resolve) => { socket.connect(80, () => resolve()); });

  const flushed = await within(
    "write(data, callback)",
    1000,
    new Promise<boolean>((resolve) => {
      socket.write(Buffer.from("hello"), () => resolve(true));
    }),
  );

  ck("write calls back once the bytes are away", flushed === true);
  ck("and the bytes reached the native side",
     calls.some((c) => c.name === "send"));
}

// ---- the path that actually broke ------------------------------------------
//
// The real `Transport`, from the shared core, listening through the shim. Not
// a re-creation of its call — the class itself, compiled against these shims
// the way the app compiles it.

{
  reset();
  grantPort(51900);

  const transport = new Transport("u_test", {
    events: () => [],
    merge: () => ({ accepted: 0, held: [] }),
    heads: () => [],
    communities: () => [],
  } as never);

  const port = await within("Transport.listen", 2000, transport.listen(0));

  ck("the real transport starts listening", port === 51900, String(port));
  ck("and reports the port it was granted", transport.port === 51900);
}

// ---- the call site itself ---------------------------------------------------
//
// If `transport.ts` ever changes how it calls `listen`, the tests above go on
// passing while the app breaks again. So the shape being relied on is read out
// of the source and stated.

{
  const source = readFileSync(
    join(process.cwd(), "../for-desktop-p2p/src/p2p/transport.ts"),
    "utf8",
  );

  ck("the core still calls listen with a callback in second position",
     /\.listen\(\s*port\s*,\s*\(\)\s*=>/.test(source));
}

// ---- bytes that arrive before anyone is listening ---------------------------
//
// The failure this covers reported the *second* message: "expected a device
// link greeting and got proof". The greeting was never lost on the wire — it
// was emitted as a `data` event at a moment when nothing was subscribed, and
// an event with no listener goes nowhere.
//
// The window is not exotic. `socksConnect` resolves on `connect`, and the
// caller attaches its `data` handler on the line after — so anything the far
// end sent the instant it accepted lands in between.

{
  reset();
  setProxyPort(9050);

  const socket = new Socket();
  await new Promise<void>((resolve) => { socket.connect(80, () => resolve()); });

  // Arriving with nobody listening, exactly as a greeting does.
  (socket as unknown as { receive: (b: Buffer) => void }).receive(
    Buffer.from("hello", "utf8"),
  );
  (socket as unknown as { receive: (b: Buffer) => void }).receive(
    Buffer.from(" there", "utf8"),
  );

  const seen = await within(
    "bytes that arrived before a listener",
    1000,
    new Promise<string>((resolve) => {
      let all = "";
      socket.on("data", (chunk: Buffer) => {
        all += chunk.toString("utf8");
        if (all === "hello there") resolve(all);
      });
    }),
  );

  ck("nothing is lost while nobody is listening", seen === "hello there",
     String(seen));

  // And in order, because a protocol that reads a length prefix cannot
  // tolerate its frames being reassembled out of sequence.
  ck("and it arrives in the order it was sent", seen === "hello there");
}

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
