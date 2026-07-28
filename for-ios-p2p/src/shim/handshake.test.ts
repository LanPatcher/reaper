// Node's real sockets, under a name the build does not substitute — this file
// needs both implementations at once, which is the whole point of it.
import { createServer as nodeServer, type Socket as NodeSocket } from "real:net";

import { LinkService, type LinkHooks } from "../../../for-desktop-p2p/src/p2p/link";
import { createIdentity } from "../../../for-desktop-p2p/src/p2p/identity";

import { Socket as ShimSocket, setProxyPort } from "./net";
import { attach } from "./socket-stub";

/**
 * The device link handshake, with the phone's socket on one side.
 *
 * This exists because three fixes for one symptom did not fix it. The symptom
 * is precise — a phone dialling a desktop reports
 *
 *     expected a device link greeting and got "proof"
 *
 * which means the first message of the exchange never reached the code that
 * was waiting for it. `link.test.ts` already runs both sides of this protocol
 * over a real loopback socket and passes, so the protocol is not the problem;
 * what differs on a device is that one side's socket is `src/shim/net.ts`
 * rather than Node's.
 *
 * So that is what this sets up: the *real* `LinkService`, on both sides, over
 * a *real* TCP connection, with the shim standing where it stands on a phone.
 * The stub underneath it is backed by an actual socket rather than a script,
 * so chunk boundaries, coalescing and delivery timing are whatever the
 * operating system decides rather than whatever a test author imagined.
 *
 * Guessing at this from the outside produced three wrong answers. This is the
 * apparatus that should have been built first.
 */

let f = 0;
const ck = (n: string, c: boolean, e = "") => {
  console.log((c ? "PASS" : "FAIL") + "  " + n + (e ? "  " + e : ""));
  if (!c) f++;
};

function hooks(identity: ReturnType<typeof createIdentity>, name: string): LinkHooks {
  return {
    identity,
    device: name,
    name,
    communities: () => ["@index"],
    summary: () => ({ vector: {}, extra: [] }),
    missingForSummary: () => [],
    merge: () => 0,
    blobIds: () => [],
    readBlob: () => undefined,
    writeBlob: () => {},
    claims: () => [],
    addClaim: () => {},
    holding: () => false,
    asking: () => false,
    defer: () => {},
    handOver: () => {},
  };
}

const identity = createIdentity();

// ---- the desktop half: a real server running the real session ---------------

const desktop = new LinkService(hooks(identity, "desktop"));

const port = await new Promise<number>((resolve) => {
  const server = nodeServer((socket) => {
    // Exactly what `LinkService.#listen` does when a device dials in.
    void (desktop as unknown as {
      session: (s: NodeSocket, first: boolean) => Promise<unknown>;
    });

    // The private session cannot be reached from here, so the server side is
    // driven through the public surface instead: `adopt` runs a session on a
    // socket that is already connected. `first` differs from the real listener,
    // which only changes who offers first — not the handshake this is about.
    void desktop.adopt(socket as never, { files: false, first: false }).catch(() => {});
  });

  server.listen(0, () => {
    const address = server.address();
    resolve(address && typeof address !== "string" ? address.port : 0);
  });
});

ck("a desktop-side link server is listening", port > 0, String(port));

// ---- the phone half: the shim socket, over the same TCP -------------------

{
  const phone = new LinkService(hooks(identity, "phone"));

  // The shim's socket, wired to a genuine TCP connection. `attach` is what
  // makes this a real test rather than a scripted one: every byte crosses an
  // actual socket, with the operating system deciding how it is chunked.
  // The order matters and mirrors the app: the real connection is started
  // first, then `connect()` registers the socket so the native `connect` event
  // has somewhere to land. Without the registration the socket never becomes
  // ready and every write queues silently — which is worth knowing, because it
  // is the same silence the app would show.
  setProxyPort(9050);

  const socket = new ShimSocket();
  await attach(socket.id, "127.0.0.1", port);
  socket.connect(port, "127.0.0.1");

  const outcome = await Promise.race([
    phone.adopt(socket as never, { files: false })
      .then(() => "completed")
      .catch((error: Error) => error.message),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve("timed out"), 15_000).unref?.()),
  ]);

  // The assertion that matters. Anything mentioning "proof" is the reported
  // failure reproduced; a timeout means it stalled somewhere else; only
  // "completed" is the handshake working.
  ck("the handshake completes over the phone's socket",
     outcome === "completed", String(outcome));
}

console.log(f ? "\n" + f + " FAILED" : "\nall passed");
process.exit(f ? 1 : 0);
