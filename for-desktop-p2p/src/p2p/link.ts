import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createSocket, type Socket as Datagram } from "node:dgram";
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

/** The port announcements go to. Chosen high and fixed so both sides agree. */
export const LINK_DISCOVERY_PORT = 45817;

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

/** How often to announce while linking is open. */
const ANNOUNCE_EVERY_MS = 2000;

/** How long an announcement is believed after it stops arriving. */
const FORGET_AFTER_MS = 8000;

/** A device that has gone quiet mid-handshake is not coming back. */
const HANDSHAKE_TIMEOUT_MS = 15_000;

/** Bytes per blob chunk on the wire. Larger than Tor's — this is a LAN. */
const CHUNK = 256 * 1024;

export interface LinkPeer {
  /** Where it is, this time. Not stable and not worth storing. */
  host: string;
  port: number;

  /** What it calls itself. Shown to the user; not trusted for anything. */
  name: string;

  /** Its device id, so a claim can be attributed. */
  device: string;

  /** When it was last heard from. */
  at: number;
}

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
  | { t: "claims"; claims: Claim[] }
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

/** The announcement fingerprint: proves knowledge of the key without naming it. */
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
  #radio: Datagram | undefined;
  #beacon: ReturnType<typeof setInterval> | undefined;
  #salt = randomBytes(16).toString("hex");
  #seen = new Map<string, LinkPeer>();
  #port = 0;

  constructor(hooks: LinkHooks) {
    super();
    this.#hooks = hooks;
  }

  get port(): number {
    return this.#port;
  }

  /** Devices heard from recently, freshest first. */
  peers(): LinkPeer[] {
    const now = Date.now();
    for (const [key, peer] of this.#seen) {
      if (now - peer.at > FORGET_AFTER_MS) this.#seen.delete(key);
    }
    return [...this.#seen.values()].sort((a, b) => b.at - a.at);
  }

  /**
   * Start listening and announcing.
   *
   * Both at once on purpose. Which device dials and which answers should not
   * be something the user has to decide, and making every device do both means
   * whichever opens the screen second finds the other immediately.
   */
  async open(options: { announce?: boolean } = {}): Promise<number> {
    if (this.#server) return this.#port;

    this.#port = await this.#listen();

    // Separable so a test can drive two of these over loopback without
    // depending on whether the machine it runs on will carry a broadcast at
    // all — which, in a container, it will not.
    if (options.announce !== false) this.#announce();

    return this.#port;
  }

  /** Stop listening, stop announcing, forget who was seen. */
  close(): void {
    if (this.#beacon) clearInterval(this.#beacon);
    this.#beacon = undefined;

    this.#radio?.close();
    this.#radio = undefined;

    this.#server?.close();
    this.#server = undefined;

    this.#seen.clear();
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

  #announce(): void {
    const radio = createSocket({ type: "udp4", reuseAddr: true });
    this.#radio = radio;

    radio.on("error", (error) => this.emit("log", `link discovery: ${error.message}`));

    radio.on("message", (raw, from) => {
      let packet: Record<string, unknown>;
      try {
        packet = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      } catch {
        // Anything at all can arrive on a broadcast port.
        return;
      }

      if (packet.t !== "reaper-link" || typeof packet.salt !== "string") return;
      if (typeof packet.device !== "string" || packet.device === this.#hooks.device) return;

      // The only check that matters: could this have been produced without the
      // account's public key? The salt is theirs, so the hash is recomputed
      // rather than compared to anything stored.
      const expected = fingerprint(this.#hooks.identity.publicKey, packet.salt);
      if (packet.fingerprint !== expected) return;

      const port = Number(packet.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) return;

      this.#seen.set(packet.device, {
        host: from.address,
        port,
        name: typeof packet.name === "string" ? packet.name : "a device",
        device: packet.device,
        at: Date.now(),
      });

      this.emit("peers", this.peers());
    });

    radio.bind(LINK_DISCOVERY_PORT, () => {
      try {
        radio.setBroadcast(true);
      } catch (error) {
        this.emit("log", `link discovery cannot broadcast: ${(error as Error).message}`);
      }

      const beat = () => {
        // A fresh salt every time, so two announcements cannot be linked to
        // each other by an observer who is simply watching the port.
        this.#salt = randomBytes(16).toString("hex");

        const packet = Buffer.from(JSON.stringify({
          t: "reaper-link",
          v: 1,
          device: this.#hooks.device,
          name: this.#hooks.name,
          port: this.#port,
          salt: this.#salt,
          fingerprint: fingerprint(this.#hooks.identity.publicKey, this.#salt),
        }), "utf8");

        radio.send(packet, 0, packet.length, LINK_DISCOVERY_PORT, "255.255.255.255",
          (error) => {
            if (error) this.emit("log", `link announce: ${error.message}`);
          });
      };

      beat();
      this.#beacon = setInterval(beat, ANNOUNCE_EVERY_MS);
    });
  }

  /**
   * Dial a device and sync with it.
   *
   * The address comes from an announcement or from the user typing what the
   * other device is showing. Either way it is not trusted — the handshake is
   * what decides, and a wrong address simply fails to authenticate.
   */
  async connect(host: string, port: number): Promise<LinkProgress> {
    const socket = new Socket();

    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.connect(port, host, () => {
        socket.removeListener("error", reject);
        resolve();
      });
    });

    return this.#session(socket, true);
  }

  /**
   * Sync with a device that is not on this network.
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
  async adopt(socket: Socket, options: { files?: boolean } = {}): Promise<LinkProgress> {
    return this.#session(socket, true, options.files !== false);
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

    const send = (message: Message) => {
      const body = Buffer.from(JSON.stringify(message), "utf8");

      if (!key) {
        // Only the hello is in the clear, and it carries a hash and a nonce.
        const header = Buffer.alloc(4);
        header.writeUInt32BE(body.length);
        socket.write(Buffer.concat([header, body]));
        return;
      }

      socket.write(encodeFrame(body, key));
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

    socket.on("data", (chunk) => {
      inbox = Buffer.concat([inbox, chunk]);

      for (;;) {
        if (!key) {
          if (inbox.length < 4) return;
          const length = inbox.readUInt32BE(0);
          if (inbox.length < 4 + length) return;

          const body = inbox.subarray(4, 4 + length);
          inbox = inbox.subarray(4 + length);

          try {
            deliver(JSON.parse(body.toString("utf8")) as Message);
          } catch {
            socket.destroy();
            return;
          }
          continue;
        }

        const frame = decodeFrame(inbox, 0, key);
        if (!frame) return;

        inbox = inbox.subarray(frame.size);

        try {
          deliver(JSON.parse(frame.payload.toString("utf8")) as Message);
        } catch {
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
      if (hello.t !== "hello" || hello.v !== 1) {
        throw new Error("that is not a Reaper device link");
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

      // Anything still buffered was sent in the clear and is not trusted past
      // this point. In practice there is nothing, because both sides wait.
      inbox = Buffer.alloc(0);

      // ---- who holds the address -------------------------------------------

      send({ t: "claims", claims: this.#hooks.claims() });

      const theirClaims = await receive();
      if (theirClaims.t !== "claims") throw new Error("the link went out of step");

      for (const claim of theirClaims.claims) {
        if (isClaim(claim)) this.#hooks.addClaim(claim);
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

    // Skipped entirely when the link is running over Tor. Not a limitation
    // being worked around — attachments can be fetched from the people who
    // sent them, and pushing the whole store through three relays to save a
    // request that will probably never be made is a poor trade for both
    // devices and for the network.
    let held: string[] = [];
    try {
      if (files) held = this.#hooks.blobIds(community);
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
