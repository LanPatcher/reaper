import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { Socket, createServer, type Server } from "node:net";

import { deriveKey } from "./crypto";
import { type Claim, holder, isClaim } from "./devices";
import type { SignedEvent } from "./events";
import { decodeFrame, encodeFrame } from "./frames";
import { type Identity, signDigest, verifyDigest } from "./identity";
import type { Summary } from "./vector";

/**
 * The link between two of your own devices, over the local network.
 *
 * ## Why this is not the ordinary transport
 *
 * `transport.ts` moves events between *people*, and almost everything it does
 * is about deciding what a peer is allowed to see: private logs are withheld,
 * communities they are not a member of are refused, blobs are answered only
 * from the conversation they were asked in. All of that is correct and all of
 * it is wrong here, because the device on the other end is you. It should get
 * the friends list, the preferences, the outbox, every conversation and every
 * file — the whole of the account, including the parts that are deliberately
 * never offered to anybody else.
 *
 * So this is a separate protocol with the opposite default. Nothing is
 * filtered. What makes that safe is not a permission check but the
 * authentication: the only party this will exchange a byte with is one that
 * can sign with the account's own private key, which is to say, one that
 * already has everything.
 *
 * ## Two ways to carry it
 *
 * The same exchange runs over either of two connections, and which one is used
 * changes nothing about the protocol:
 *
 *   - **The local network**, for bulk. Fast, and the only sensible way to move
 *     an attachment store. Discovery is by UDP broadcast, which is why it is
 *     off unless the user is on the linking screen on both devices, and why
 *     the packet carries `sha256(publicKey ‖ salt)` with a fresh salt rather
 *     than anything that names the account.
 *
 *   - **Tor**, for everything else. Each device publishes its own onion
 *     service — a *sync address*, separate from the account's address — so any
 *     of your devices can reach any other from anywhere, with no port
 *     forwarding and without being on the same network. This is what makes a
 *     phone able to take the account over while the desktop is still running
 *     at home, and it is the path that carries friends, servers, group chats,
 *     messages and the outbox.
 *
 * The account's own onion address cannot serve this. Exactly one device
 * publishes it at a time — that is the whole point of `devices.ts` — so
 * dialling it reaches whichever device is already holding, which is precisely
 * the one that does not need to be reached.
 *
 * ## What a sync address is worth if it leaks
 *
 * Nothing but a connection. Knowing the address lets somebody open a socket;
 * the handshake below then asks them to sign a challenge with the account's
 * private key, and without it the exchange ends before a single log is named.
 * Nor could a party that somehow got past it insert anything: every event in
 * every log is signed by its author, and one that is not is dropped on merge.
 *
 * So an address that ends up somewhere it should not is a privacy leak — it
 * says a device exists — and not an authority leak. That distinction is worth
 * holding on to when deciding how carefully these have to be handled.
 *
 * ## The handshake
 *
 * Both sides send a nonce and a fingerprint. Both verify the fingerprint
 * against the public key they already hold, then sign the pair of nonces and
 * check the signature. Only then is a session key derived — from the private
 * key and both nonces — and every frame after that is encrypted under it.
 *
 * No public key crosses the wire, so watching the exchange on a hostile
 * network reveals neither who you are nor that these two devices belong
 * together.
 */

/**
 * Index events that another device would want to know about promptly.
 *
 * Not everything in the index log is worth a Tor circuit. Read receipts, mute
 * settings and window sizes change constantly and matter to nobody but the
 * device they happened on; a friend added or a server joined is something the
 * user will look for on their phone within the hour and be confused not to
 * find.
 *
 * The list is deliberately short. Syncing on every append would keep a circuit
 * permanently busy for no benefit, and the periodic pass catches the rest
 * within a few minutes anyway.
 */
export const WORTH_SYNCING = new Set([
  "friend.add",
  "friend.remove",
  "friend.outgoing",
  "friend.incoming",
  "community.create",
  "community.key",
  "community.leave",
  "group.create",
  "group.left",
  "profile.update",
  "outbox.add",
  "peer.enckey",
]);

/**
 * How long to wait for the other side to say anything.
 *
 * Sized for Tor rather than for a local network. Building a circuit to an
 * onion service takes tens of seconds on its own, and this timer covers every
 * exchange in the protocol — including the one where a device with a long
 * index log is working through it. Fifteen seconds was comfortable over wifi
 * and cut a Tor sync off mid-handshake, which surfaced as the other device
 * simply not answering.
 */
const HANDSHAKE_TIMEOUT_MS = 90_000;

/**
 * Bytes per blob chunk on the wire.
 *
 * Modest, because everything now goes through Tor. A large chunk on a circuit
 * is a long stall in one direction rather than a faster transfer.
 */
const CHUNK = 64 * 1024;

/**
 * The only files a device link carries.
 *
 * Attachments are not synced between your own devices and that is deliberate:
 * they can be fetched from whoever sent them, they are the bulk of the store
 * by far, and pushing them through three relays to save a request that may
 * never be made is a poor trade for both devices and for the network.
 *
 * Pictures are the exception, because there is nobody to fetch *your own* face
 * from. Profile pictures, banners and server icons all live in this one store,
 * so naming it is the whole rule.
 */
const PICTURES = "@avatars";

/**
 * Everything the link needs from the rest of the app.
 *
 * Injected rather than imported so this module can be driven by a test with
 * two in-memory accounts and a loopback socket — which is the only way to find
 * out whether a sync protocol actually converges. Reading the code tells you
 * what it intends to do.
 */
export interface LinkHooks {
  identity: Identity;
  device: string;
  name: string;

  /** Every log on this device, private ones included. */
  communities(): string[];

  summary(community: string): Summary;
  missingForSummary(community: string, summary: Summary): SignedEvent[];

  /** Returns how many were new, for reporting. */
  merge(community: string, events: SignedEvent[]): number;

  blobIds(community: string): string[];
  readBlob(community: string, id: string): Buffer | undefined;
  writeBlob(community: string, id: string, bytes: Buffer): void;

  claims(): Claim[];
  addClaim(claim: Claim): void;

  /** Whether this device is publishing the account address right now. */
  holding(): boolean;

  /** Whether the user has asked this device to take the address over. */
  asking(): boolean;

  /** Another device is already publishing; stop expecting to. */
  defer(device: string, name: string): void;

  /** Another device asked for the address and this one has it. Give it up. */
  handOver(device: string, name: string): void;
}

/** What one side tells the other about a sync as it goes. */
export interface LinkProgress {
  device: string;
  name: string;
  events: number;
  files: number;
  communities: number;
  done: boolean;
}

type Message =
  | { t: "hello"; v: number; device: string; name: string; nonce: string; fingerprint: string }
  | { t: "proof"; sig: string }
  | { t: "claims"; claims: Claim[]; holding: boolean; asking: boolean }
  | { t: "want"; community: string; summary: Summary; blobs: string[] }
  | { t: "give"; community: string; events: SignedEvent[] }
  | { t: "logs"; communities: string[] }
  | { t: "blob"; community: string; id: string; part: number; of: number; data: string }
  | { t: "done" };

/** What the two sides sign, so a signature from one exchange is useless in another. */
function challenge(a: string, b: string): Buffer {
  return createHash("sha256")
    .update("reaper device link v1")
    .update(a)
    .update(b)
    .digest();
}

/**
 * Proves knowledge of the account key without naming it.
 *
 * Kept from the discovery packet it was written for, because the handshake
 * uses it too: each side sends `sha256(publicKey ‖ salt)` with a fresh salt,
 * and the other recomputes it. No public key crosses the wire, so watching the
 * exchange reveals neither who you are nor that two devices belong together.
 */
export function fingerprint(publicKey: string, salt: string): string {
  return createHash("sha256").update(publicKey).update(salt).digest("hex");
}

/**
 * The key both sides derive once they have each other's nonces.
 *
 * From the private key, which only your own devices hold. Somebody who
 * recorded the whole exchange has both nonces and still cannot compute this.
 */
function sessionKey(identity: Identity, a: string, b: string): Buffer {
  const secret = createHash("sha512")
    .update(identity.privateKey)
    // Sorted, so both sides derive the same key regardless of who dialled.
    .update([a, b].sort().join(""))
    .digest();

  return deriveKey(secret, "reaper-device-link");
}

export class LinkService extends EventEmitter {
  #hooks: LinkHooks;
  #server: Server | undefined;
  #port = 0;

  constructor(hooks: LinkHooks) {
    super();
    this.#hooks = hooks;
  }

  get port(): number {
    return this.#port;
  }

  /**
   * Start listening for the other devices on this account.
   *
   * Tor forwards this device's sync service to whichever port this returns, so
   * it has to be open before Tor is configured — see `bridge.ts`.
   *
   * There is no local-network half any more. It was removed rather than left
   * as a fast path: it needed UDP broadcast, an announcement protocol, a
   * discovery UI and a second set of failure modes, all to save time on a
   * transfer that is now a few hundred kilobytes of events. One way of doing
   * this is easier to make correct than two, and correct is what it was
   * missing.
   */
  async open(): Promise<number> {
    if (this.#server) return this.#port;

    this.#port = await this.#listen();
    return this.#port;
  }

  /** Stop listening. */
  close(): void {
    this.#server?.close();
    this.#server = undefined;
    this.#port = 0;
  }

  #listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => {
        // Answering, so this side does not speak first — see `#session`.
        //
        // The rejection is reported rather than dropped. A failure on this
        // side has no caller to throw to, and the side that dialled sees only
        // a closed socket — so without this, the device that actually knows
        // what went wrong is the one that says nothing.
        this.#session(socket, false).catch((error: Error) => {
          this.emit("log", `a device link failed: ${error.message}`);
          this.emit("failed", error.message);
        });
      });

      this.#server = server;
      server.on("error", reject);

      // The callback in the second position, which is a shape Node accepts and
      // one shim did not. See `for-ios-p2p/src/shim/net.test.ts`.
      server.listen(0, () => {
        const address = server.address();
        const port = address && typeof address !== "string" ? address.port : 0;

        if (!port) {
          reject(new Error("the system granted no port for device linking"));
          return;
        }

        resolve(port);
      });
    });
  }

  /**
   * Sync over a connection somebody else opened.
   *
   * The socket is handed in rather than opened here, because reaching another
   * of your devices through Tor is the transport's business and this module
   * should not know what an onion address is. Everything after the connection
   * is identical — same handshake, same exchange, same convergence — which is
   * the point: there is one sync protocol and two ways to carry it.
   *
   * `files` is how the two differ in practice. Over a local network the
   * attachment store is worth copying wholesale; over Tor it is tens of
   * megabytes through three relays, and the files can be fetched from the
   * people who sent them anyway. Conversations, friends, servers and the
   * outbox cannot be fetched from anywhere, so those always travel.
   */
  async adopt(
    socket: Socket,
    options: { files?: boolean; first?: boolean } = {},
  ): Promise<LinkProgress> {
    // `first` decides who offers before asking, and the two sides must
    // disagree about it or both wait for the other. Dialling is the default
    // because that is every caller in the app; it is settable so a test can
    // stand in for the listener, which is the only way to run both halves of
    // this protocol in one process.
    return this.#session(socket, options.first !== false, options.files !== false);
  }

  /**
   * One exchange, from handshake to done.
   *
   * `first` decides who speaks first at each step, which is what keeps this
   * from deadlocking with both sides waiting. The dialling device leads.
   */
  async #session(
    socket: Socket,
    first: boolean,
    files = true,
  ): Promise<LinkProgress> {
    const identity = this.#hooks.identity;

    const mine = randomBytes(16).toString("hex");
    const salt = randomBytes(16).toString("hex");

    let key: Buffer | undefined;
    let inbox: Buffer = Buffer.alloc(0);
    const waiting: ((message: Message) => void)[] = [];
    const queue: Message[] = [];

    const progress: LinkProgress = {
      device: "", name: "", events: 0, files: 0, communities: 0, done: false,
    };

    /**
     * Write one message.
     *
     * Every message on this connection is a 4-byte big-endian length followed
     * by that many bytes, from the first byte to the last, whether or not it is
     * encrypted. Only the *body* changes: the first two are plaintext JSON,
     * because they are what establishes the key, and everything after is a
     * sealed frame.
     *
     * That uniformity is the whole point, and it is why this is written out
     * rather than delegated to `encodeFrame` alone. The reader has to find
     * message boundaries before it can know anything about a message, and if
     * finding a boundary depends on whether the key has been set yet, then the
     * reader's behaviour depends on timing — see the note on the data handler.
     */
    const send = (message: Message) => {
      const json = Buffer.from(JSON.stringify(message), "utf8");
      const body = key ? encodeFrame(json, key) : json;

      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      socket.write(Buffer.concat([header, body]));
    };

    const deliver = (message: Message) => {
      const next = waiting.shift();
      if (next) next(message);
      else queue.push(message);
    };

    const receive = (): Promise<Message> =>
      new Promise((resolve, reject) => {
        const ready = queue.shift();
        if (ready) { resolve(ready); return; }

        const timer = setTimeout(
          () => reject(new Error("the other device stopped answering")),
          HANDSHAKE_TIMEOUT_MS,
        );

        waiting.push((message) => { clearTimeout(timer); resolve(message); });
      });

    /**
     * Split the stream into messages.
     *
     * ## Why this is not allowed to know about the key
     *
     * This used to have two modes. Before the key existed it read a plain
     * length prefix; after, it called `decodeFrame`. It also cleared the buffer
     * on the changeover, on the reasoning that the handshake was over and
     * anything left was stale.
     *
     * Both of those are bugs, and together they are *the* bug — the one that
     * made linking a device fail with a complaint about a message arriving out
     * of order, reliably, for weeks, while ordinary chat over the same onion
     * worked perfectly.
     *
     * The reason chat was fine is that its transport frames every message the
     * same way from the first byte. This did not, and a handler that changes
     * how it parses is a handler whose correctness depends on *when* it runs.
     *
     * Concretely: this loop is synchronous and drains the whole chunk, but the
     * key is set from an `await` continuation, which is a microtask and cannot
     * run until the loop has finished. Tor batches aggressively, so a single
     * chunk routinely carries the greeting, the proof and the first encrypted
     * message together. The first two parsed correctly. The third was a sealed
     * frame handed to the plaintext parser, which read its magic number as a
     * length, got something absurd, and gave up — after discarding the buffer.
     * And then the buffer was discarded a second time when the key was finally
     * set, taking whatever had arrived in the meantime with it.
     *
     * So framing is now uniform and unconditional: four bytes of length, then
     * that many bytes, forever. Nothing here inspects the key, nothing clears
     * the buffer, and a message that is only half-arrived is simply waited for.
     * Whether a body is plaintext or sealed is decided by *position* in the
     * conversation, below, which is the same on both sides and does not depend
     * on what has or has not been scheduled yet.
     */
    let seen = 0;

    socket.on("data", (chunk) => {
      inbox = Buffer.concat([inbox, chunk]);

      for (;;) {
        if (inbox.length < 4) return;

        const length = inbox.readUInt32BE(0);

        // Not a link at all.
        //
        // Worth naming separately, because the likeliest cause is not
        // corruption: it is having reached the *wrong service* on the right
        // device. The chat transport and this both listen on loopback ports,
        // and an onion service pointed at the wrong one delivers a perfectly
        // valid frame of a completely different protocol.
        //
        // Only ever decided on the first message. After that the stream is
        // known to be a link, so a bad length is a real desynchronisation and
        // pretending otherwise would hide it.
        if (length === 0 || length > 8 * 1024 * 1024) {
          deliver({
            t: seen === 0 ? "wrong-service" : "out-of-step",
            saw: inbox.subarray(0, Math.min(16, inbox.length)).toString("hex"),
          } as unknown as Message);
          socket.destroy();
          return;
        }

        // Not all here yet. Keep it and wait — never discard a partial
        // message, which is what a short read looks like and is not an error.
        if (inbox.length < 4 + length) return;

        const body = inbox.subarray(4, 4 + length);
        inbox = inbox.subarray(4 + length);

        // The first two messages each way are the greeting and the proof, in
        // that order, and they are in the clear because they are what derives
        // the key. Everything after them is sealed. Counting is deterministic
        // and identical on both sides; asking "is the key set yet" is not.
        const plain = seen < 2;
        seen += 1;

        let json: Buffer;

        if (plain) {
          json = body;
        } else {
          if (!key) {
            // Cannot happen: the key is derived from the proof, which is
            // message two, so it exists before message three is read. Stated
            // rather than assumed, because the version of this that assumed it
            // is the one that shipped broken.
            deliver({ t: "out-of-step", saw: "sealed before key" } as unknown as Message);
            socket.destroy();
            return;
          }

          const frame = decodeFrame(body, 0, key);

          if (!frame) {
            deliver({ t: "out-of-step", saw: "unreadable frame" } as unknown as Message);
            socket.destroy();
            return;
          }

          json = frame.payload;
        }

        try {
          deliver(JSON.parse(json.toString("utf8")) as Message);
        } catch {
          deliver({
            t: seen === 1 ? "wrong-service" : "out-of-step",
            saw: json.subarray(0, 24).toString("utf8"),
          } as unknown as Message);
          socket.destroy();
          return;
        }
      }
    });

    try {
      // ---- who are you ------------------------------------------------------

      send({
        t: "hello",
        v: 1,
        device: this.#hooks.device,
        name: this.#hooks.name,
        nonce: mine,
        fingerprint: fingerprint(identity.publicKey, salt) + ":" + salt,
      });

      const hello = await receive();

      if ((hello as { t: string }).t === "wrong-service") {
        throw new Error(
          "connected, but that address is not this account's sync service — " +
          "it answered with something else (" +
          (hello as unknown as { saw: string }).saw + ")",
        );
      }

      if (hello.t !== "hello") {
        throw new Error(
          `expected a device link greeting and got "${String(hello.t)}"`,
        );
      }

      if (hello.v !== 1) {
        throw new Error(
          `that device speaks version ${String(hello.v)} of the link protocol, ` +
          "this one speaks 1 — one of them needs updating",
        );
      }

      const [claimed, theirSalt] = String(hello.fingerprint).split(":");
      if (
        !theirSalt ||
        claimed !== fingerprint(identity.publicKey, theirSalt)
      ) {
        // The common case is not an attack: it is somebody else's Reaper on
        // the same network, or the wrong address typed in.
        throw new Error("that device is signed in as somebody else");
      }

      progress.device = hello.device;
      progress.name = hello.name;

      // ---- prove it ---------------------------------------------------------

      send({ t: "proof", sig: signDigest(challenge(mine, hello.nonce), identity) });

      const proof = await receive();
      if (proof.t !== "proof") throw new Error("that device did not prove itself");

      if (!verifyDigest(challenge(hello.nonce, mine), proof.sig, identity.publicKey)) {
        throw new Error("that device could not prove it is signed in as you");
      }

      key = sessionKey(identity, mine, hello.nonce);

      // Nothing is discarded here. Bytes that arrived while this was being
      // derived are the peer's next messages, already framed and waiting, and
      // throwing them away was half of why linking a device never worked.

      // ---- who holds the address -------------------------------------------

      // ---- who is actually answering right now -----------------------------
      //
      // The claim ledger says who *should* hold the address. This says who
      // *does* — and when the two disagree, the one that is already published
      // wins. An address is a live thing: a device that is answering at it has
      // people connected to it, and a ledger entry written somewhere else does
      // not change that. Taking it over by writing a number was how two
      // devices ended up both publishing.
      //
      // So control is asked for rather than declared, and only when the user
      // has pressed the button that asks for it.
      send({
        t: "claims",
        claims: this.#hooks.claims(),
        holding: this.#hooks.holding(),
        asking: this.#hooks.asking(),
      });

      const theirClaims = await receive();
      if (theirClaims.t !== "claims") throw new Error("the link went out of step");

      for (const claim of theirClaims.claims) {
        if (isClaim(claim)) this.#hooks.addClaim(claim);
      }

      // They are publishing and this device is not asking to take over, so
      // this device defers — whatever the ledger says.
      if (theirClaims.holding && !this.#hooks.asking()) {
        this.#hooks.defer(progress.device, progress.name);
      }

      // They asked, and this device is the one holding. Handing over is the
      // only way a second device can ever get the address, and it happens here
      // rather than by anyone writing a bigger number.
      if (theirClaims.asking && this.#hooks.holding()) {
        this.#hooks.handOver(progress.device, progress.name);
      }

      // ---- logs -------------------------------------------------------------
      //
      // Every one of them, private included. This is the whole point: the index
      // log holds the friends list, the servers joined, the preferences and the
      // outbox, and it is precisely the log that can never re-sync from a peer.

      send({ t: "logs", communities: this.#hooks.communities() });

      const theirLogs = await receive();
      if (theirLogs.t !== "logs") throw new Error("the link went out of step");

      const all = new Set([...this.#hooks.communities(), ...theirLogs.communities]);
      progress.communities = all.size;

      // Ordered, so both sides walk the same list in the same order and the
      // exchange stays in step without a request id on every message.
      for (const community of [...all].sort()) {
        if (first) {
          await this.#offer(community, send, receive, progress);
          await this.#ask(community, send, receive, progress, files);
        } else {
          await this.#ask(community, send, receive, progress, files);
          await this.#offer(community, send, receive, progress);
        }
      }

      // Finished — and then wait to be told the same thing.
      //
      // Without the wait, the side that dialled resolves the moment it has
      // *sent* its last batch, while the other is still reading it off the
      // socket and writing files. `connect()` returned "done", the interface
      // said the devices were linked, and the receiving device was several
      // hundred kilobytes short. Everything looked correct from the side the
      // user was watching, which is the worst place for a bug like this to
      // live.
      //
      // The socket is destroyed in `finally`, so the wait is not politeness:
      // resolving early actively cuts the transfer off.
      send({ t: "done" });

      const closing = await receive();
      if (closing.t !== "done") throw new Error("the link went out of step");

      progress.done = true;

      this.emit("synced", progress);
      return progress;
    } finally {
      socket.destroy();
    }
  }

  /** Tell them what we have, and hand over whatever they lack. */
  async #offer(
    community: string,
    send: (m: Message) => void,
    receive: () => Promise<Message>,
    progress: LinkProgress,
  ): Promise<void> {
    let summary: Summary;
    let blobs: string[];

    try {
      summary = this.#hooks.summary(community);
      blobs = this.#hooks.blobIds(community);
    } catch {
      // A community the other side has and this one does not. An empty
      // summary asks for everything, which is right: there is nothing here to
      // compare against.
      summary = { vector: {}, extra: [] };
      blobs = [];
    }

    send({ t: "want", community, summary, blobs });

    for (;;) {
      const message = await receive();

      if (message.t === "give") {
        progress.events += this.#hooks.merge(community, message.events);
        continue;
      }

      if (message.t === "blob") {
        this.#collect(community, message, progress);
        continue;
      }

      if (message.t === "done") return;
      throw new Error("the link went out of step");
    }
  }

  /** Hear what they have, and send what they are missing. */
  async #ask(
    community: string,
    send: (m: Message) => void,
    receive: () => Promise<Message>,
    _progress: LinkProgress,
    files = true,
  ): Promise<void> {
    const message = await receive();
    if (message.t !== "want") throw new Error("the link went out of step");

    let missing: SignedEvent[] = [];
    try {
      missing = this.#hooks.missingForSummary(community, message.summary);
    } catch {
      // Nothing here to send. Not an error — the other device simply has a
      // conversation this one has never opened.
    }

    // Batched, because one frame per event on a log with tens of thousands of
    // them spends more time framing than moving.
    for (let at = 0; at < missing.length; at += 500) {
      send({ t: "give", community, events: missing.slice(at, at + 500) });
    }

    // Pictures only — see `PICTURES`.
    //
    // Attachments are never carried between your own devices: they can be
    // fetched from whoever sent them, they are the bulk of the store, and this
    // link runs entirely over Tor. Your own profile picture, banner and server
    // icons have nobody else to come from, which is the entire exception.
    let held: string[] = [];
    try {
      if (files && community === PICTURES) held = this.#hooks.blobIds(community);
    } catch { /* none */ }

    const theirs = new Set(message.blobs);

    for (const id of held) {
      if (theirs.has(id)) continue;

      const bytes = this.#hooks.readBlob(community, id);
      if (!bytes) continue;

      const parts = Math.max(1, Math.ceil(bytes.length / CHUNK));
      for (let part = 0; part < parts; part++) {
        send({
          t: "blob",
          community,
          id,
          part,
          of: parts,
          data: bytes.subarray(part * CHUNK, (part + 1) * CHUNK).toString("base64"),
        });
      }
    }

    send({ t: "done" });
  }

  #partial = new Map<string, Buffer[]>();

  #collect(
    community: string,
    message: Extract<Message, { t: "blob" }>,
    progress: LinkProgress,
  ): void {
    const key = `${community}/${message.id}`;
    const parts = this.#partial.get(key) ?? new Array<Buffer>(message.of);

    parts[message.part] = Buffer.from(message.data, "base64");
    this.#partial.set(key, parts);

    if (parts.filter(Boolean).length !== message.of) return;

    const bytes = Buffer.concat(parts);
    this.#partial.delete(key);

    // Checked, not trusted. The id is the hash of the contents, so a file that
    // does not hash to its own name has been corrupted in transit — and
    // writing it would poison the store under a name other devices will ask
    // for by hash and believe.
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (!safeEqual(actual, message.id)) {
      this.emit("log", `a file arrived corrupted and was dropped: ${message.id}`);
      return;
    }

    this.#hooks.writeBlob(community, message.id, bytes);
    progress.files += 1;
  }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** The claim that should be published from, given everything now known. */
export { holder };
