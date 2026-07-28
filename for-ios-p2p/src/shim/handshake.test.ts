// Node's real sockets, under a name the build does not substitute — this file
// needs both implementations at once, which is the whole point of it.
import { createServer as nodeServer, type Socket as NodeSocket } from "real:net";

import {
  PairService,
  openInvite,
  type PairHooks,
} from "../../../for-desktop-p2p/src/p2p/pair";

import { Socket as ShimSocket, setProxyPort } from "./net";
import { attach } from "./socket-stub";

/**
 * Pairing two devices, with the phone's socket on one side.
 *
 * This exists because three fixes for one symptom did not fix it, and every one
 * of them was written by reasoning about the protocol rather than running it
 * where it broke. `pair.test.ts` already runs both sides over a real loopback
 * socket and passes, so the protocol is not where the difference lives; what
 * differs on a device is that one side's socket is `src/shim/net.ts` rather
 * than Node's, and everything peculiar about that shim — bytes arriving before
 * a listener is attached, a connection that reports ready before the peer has
 * answered, a half-close that does not exist natively — is invisible from the
 * desktop.
 *
 * So that is what this sets up: the real `PairService`, on both sides, over a
 * real TCP connection, with the shim standing exactly where it stands on a
 * phone. The stub underneath it is backed by an actual socket rather than a
 * script, so chunk boundaries, coalescing and delivery timing come from the
 * operating system rather than from a test author's idea of what a socket does.
 *
 * Both directions are run, because a QR code is shown by one device and scanned
 * by the other and the failures are not symmetric — the phone dialling out
 * exercises the shim's write buffering, and the phone answering exercises the
 * accept path and the bytes that arrive before anything is listening for them.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

/** A device with just enough behind it to complete a pairing. */
function device(name: string, account: string | undefined) {
  const learned: { device: string; name: string; onion: string }[] = [];
  let held = account;

  const hooks: PairHooks = {
    device: name,
    name,
    onion: () => `${name[0].repeat(56)}.onion`,
    accountSecret: () => held,

    communities: () => ["@index"],
    summary: () => ({ vector: {}, extra: {} }) as never,
    missingForSummary: () => [],
    merge: () => 0,

    pictureIds: () => [],
    readPicture: () => undefined,
    writePicture: () => {},

    identity: () => (held ? { identity: `{"userId":"${name}"}` } : undefined),
    needsIdentity: () => !held,
    adoptIdentity: (given) => {
      // The account secret arrives with the account, which is what lets every
      // sync after this one authorise without a code.
      held = given.identity;
    },

    holding: () => false,
    wants: () => false,
    claimN: () => 0,

    learn: (peer) => { learned.push(peer); },
    yield: () => {},
    asked: () => {},
  };

  return { hooks, learned, get account() { return held; } };
}

/**
 * The address a pairing code has to contain.
 *
 * A real v3 address: 32 bytes of key, 2 of checksum, then the version byte 3.
 * `sealInvite` refuses anything else, and rightly — a code carrying something
 * that is not an address produces a failure at dial time, three layers from
 * the mistake.
 */
function onionAddress(seed: number): string {
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const raw = new Uint8Array(35);
  for (let at = 0; at < 34; at++) raw[at] = (seed * 37 + at * 11) & 0xff;
  raw[34] = 3;

  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of raw) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }

  return out.toLowerCase() + ".onion";
}

/**
 * One pairing, with the shim on whichever side is named.
 *
 * `dials` is the side holding the code — the one that scanned it. The other
 * side minted it and is listening. Which of those the shim stands in for is
 * the variable, because the two exercise completely different parts of it.
 */
async function pairs(shimSide: "dialler" | "listener"): Promise<void> {
  // The listener has the account; the dialler is the fresh device being
  // linked, which is the ordinary case and the one that has to work.
  const listens = device("laptop", '{"userId":"laptop"}');
  const dials = device("phone", undefined);

  const minting = new PairService(listens.hooks);
  const joining = new PairService(dials.hooks);

  const minted = minting.mint(onionAddress(1));
  const opened = openInvite(minted.code, minted.password);

  ck(`[${shimSide}] the code it just minted opens with its own passphrase`,
     opened.ok === true);
  if (opened.ok !== true) return;

  setProxyPort(9050);

  // The listening half: a real Node server, running the real session over
  // whichever socket implementation this run is testing.
  //
  // Held as a promise that is *created before the connection arrives*, rather
  // than a variable assigned inside the handler. Reading such a variable when
  // the race is built captures whatever it held at that instant — which is
  // `undefined`, because the handler has not run yet — and the wait then
  // finishes as soon as the dialling side is done, with the answering side
  // still mid-session. That is not a hypothetical: this test was written the
  // other way first and reported a code as still on offer that was about to be
  // spent a millisecond later.
  let sessionArrived!: (session: Promise<unknown>) => void;
  const answered = new Promise<unknown>((resolve) => {
    sessionArrived = (session) => resolve(session);
  });

  const port = await new Promise<number>((resolve) => {
    const server = nodeServer((socket: NodeSocket) => {
      sessionArrived(
        shimSide === "listener"
          // The phone answering. The accepted connection is a Node socket, so
          // the shim is wired to it the same way the native plugin wires an
          // accepted connection: an id, then bytes pushed up through `receive`.
          ? adoptThroughShim(socket, minting)
          : minting.answer(socket as never),
      );
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(address && typeof address !== "string" ? address.port : 0);
    });
  });

  ck(`[${shimSide}] a pairing service is listening`, port > 0, String(port));

  // The dialling half.
  let dialled: Promise<unknown>;

  if (shimSide === "dialler") {
    // The shim's socket, wired to a genuine TCP connection. `attach` is what
    // makes this real rather than scripted: every byte crosses an actual
    // socket. The order mirrors the app — the connection is started first,
    // then `connect()` registers the socket so the native `connect` event has
    // somewhere to land. Without that registration the socket never becomes
    // ready and every write queues silently, which is the same silence the app
    // would show.
    const socket = new ShimSocket();
    await attach(socket.id, "127.0.0.1", port);
    socket.connect(port, "127.0.0.1");

    dialled = joining.join(socket as never, opened.invite, minted.password);
  } else {
    const net = await import("real:net");
    const socket = await new Promise<NodeSocket>((resolve) => {
      const s = new net.Socket();
      s.connect(port, "127.0.0.1", () => resolve(s));
    });

    dialled = joining.join(socket as never, opened.invite, minted.password);
  }

  const outcome = await Promise.race([
    Promise.all([dialled, answered]).then(() => "completed").catch((e: Error) => e.message),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve("timed out"), 20_000).unref?.()),
  ]);

  ck(`[${shimSide}] the pairing completes through the phone's socket`,
     outcome === "completed", String(outcome));

  ck(`[${shimSide}] and the fresh device came away with the account`,
     dials.account === '{"userId":"laptop"}', String(dials.account));

  ck(`[${shimSide}] and each learned where the other is`,
     listens.learned.length === 1 && dials.learned.length === 1,
     `${listens.learned.length} / ${dials.learned.length}`);

  // The code is spent. Not by a timer and not by the interface hiding it — the
  // device that minted it no longer has it, so a second attempt is refused by
  // the only thing that can actually refuse one.
  ck(`[${shimSide}] and the code it used is no longer being offered`,
     minting.offering().length === 0,
     JSON.stringify(minting.offering()));

  await minting.close();
  await joining.close();
}

/**
 * Run a session on an accepted Node socket, through the phone's shim.
 *
 * This is the accept path, which is where the phone has failed before: the
 * native side delivers an accepted connection's first bytes in the same turn
 * it announces the connection, so the greeting can arrive before the `Socket`
 * that is supposed to receive it exists. `net.ts` holds those bytes; this
 * drives the same sequence deliberately.
 */
function adoptThroughShim(socket: NodeSocket, service: PairService): Promise<unknown> {
  const shim = new ShimSocket(`in-${Math.random().toString(36).slice(2)}`);

  socket.on("data", (chunk: Buffer) => {
    (shim as unknown as { receive: (b: Buffer) => void }).receive(chunk);
  });

  socket.on("close", () => {
    (shim as unknown as { closed: () => void }).closed();
  });

  socket.on("error", () => { /* reported through the session */ });

  // Everything the session writes goes out over the real connection. The shim
  // would normally hand this to the native plugin; here the plugin is the
  // socket on the other side of this function.
  (shim as unknown as { write: unknown }).write = (
    data: Buffer | string,
    encoding?: unknown,
    done?: unknown,
  ) => {
    const finish = typeof encoding === "function" ? encoding : done;
    socket.write(data as Buffer, () => (finish as (() => void) | undefined)?.());
    return true;
  };

  return service.answer(shim as never);
}

await pairs("dialler");
await pairs("listener");

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
