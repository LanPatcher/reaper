import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";

import type { SignedEvent } from "./events";
import type { Summary } from "./vector";

/**
 * Pairing your own devices.
 *
 * ## Why this replaces the previous one rather than fixing it
 *
 * The old device link was a request/response script: send a greeting, await
 * the reply, send a proof, await the reply, derive a key, and from there a
 * fixed alternation of asks and answers. Every step assumed the next thing off
 * the wire was the thing that step was waiting for.
 *
 * That assumption is what failed, endlessly, with a complaint about receiving
 * a proof where a greeting belonged — and it failed *only* over Tor, while
 * ordinary chat over the very same onion services worked in both directions
 * without trouble. That contrast was the answer the whole time and it took far
 * too long to read it properly: the difference is not the network. It is that
 * `transport.ts` never waits for a particular message.
 *
 * The chat transport sends its greeting the instant a socket opens, then hands
 * everything that arrives to a `switch` on the message type. Nothing is ever
 * "expected". Two peers can greet simultaneously, answer out of order, batch
 * three messages into one packet or split one across three — and none of it
 * matters, because there is no step to be out of step with.
 *
 * So this is built the same way, deliberately and to the letter:
 *
 *   - **One frame format, from the first byte to the last.** Four bytes of
 *     length, one flag byte, then the body. It never changes mid-connection,
 *     so finding a message boundary never depends on how far through the
 *     conversation we are.
 *
 *   - **No awaiting a specific message.** `#handle` is a switch. Every case is
 *     valid whenever it arrives.
 *
 *   - **Symmetric.** Both ends do exactly the same thing on connect. Neither
 *     leads, so there is no order for them to disagree about.
 *
 * ## What replaces the key exchange
 *
 * The old protocol derived a session key and encrypted the second half of the
 * conversation. That is redundant work: this only ever runs over a v3 onion
 * service, which is already authenticated and end-to-end encrypted to a key
 * nobody else holds. Encrypting inside it protected nothing and cost the
 * mid-stream format change that broke the reader.
 *
 * What actually needs establishing is *authorisation* — that the device on the
 * other end is one of yours. That is a password, shared out of band by being
 * shown as a QR code on a screen you are already holding, and proved with an
 * HMAC over a nonce each side chooses. No handshake ordering, no derived
 * stream state: a greeting either carries a valid proof or it does not.
 */

/** Length prefix plus one flag byte, exactly as the chat transport frames. */
const HEADER = 5;

/** Bodies above this are compressed. Below it, Brotli costs more than it saves. */
const COMPRESS_OVER = 1024;

const FLAG_COMPRESSED = 1;

/** Nothing legitimate approaches this; it bounds a corrupt length field. */
const MAX_FRAME = 16 * 1024 * 1024;

/** Events per `give`. Large enough to be efficient, small enough to stream. */
const BATCH = 400;

/**
 * The only community whose files cross a pairing.
 *
 * Avatars, banners and server icons — small, and the interface looks wrong
 * without them. Message attachments are deliberately excluded: they can be
 * gigabytes, they are already replicated from the people who sent them, and
 * pushing them through a Tor circuit to a phone is a bad trade in every
 * direction.
 */
export const PICTURES = "@avatars";

/** How long a socket may sit idle before it is assumed dead. */
const IDLE_MS = 120_000;

/* ---- what a pairing invite contains ------------------------------------- */

/**
 * The payload behind a QR code.
 *
 * Deliberately tiny. A QR code holds a few hundred bytes before it becomes
 * dense enough that a phone camera struggles, and the invite has to survive
 * being photographed off a screen at an angle in bad light. So it carries the
 * address to dial and a display name, and nothing else — no keys, no history,
 * no identity material. Everything of substance arrives over the connection
 * the address opens.
 */
export interface Invite {
  /** Where to reach the device that produced this. */
  onion: string;

  /** What to call it while the pairing is in progress. */
  name: string;

  /** Salt for the password, so the same password gives a different key twice. */
  salt: string;
}

/**
 * Base32, upper case, no padding.
 *
 * Not base64, and the reason is the QR code rather than anything about the
 * bytes. A QR has a compact alphanumeric mode covering digits, capitals and a
 * handful of punctuation, and anything outside that set forces byte mode —
 * which stores roughly half as much per module, so the same invite becomes a
 * visibly denser grid that a phone camera has to work harder to read across a
 * room. Base64 is case-sensitive and cannot use it. Base32 can, and the ~20%
 * it loses in length is bought back several times over by the mode.
 */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function toBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  // Whatever is left, padded out to a final character rather than dropped.
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];

  return out;
}

function fromBase32(text: string): Buffer | undefined {
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const character of text.toUpperCase()) {
    const at = B32.indexOf(character);
    if (at < 0) return undefined;

    value = (value << 5) | at;
    bits += 5;

    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

/**
 * Turn an invite into the string a QR code carries.
 *
 * Encrypted with the password rather than merely signed by it. An onion
 * address is a routable location, and a QR code is displayed on a screen in
 * whatever room you happen to be in — a photograph of it from across a café
 * should not hand somebody the address of your device, even though they would
 * still need the password to get anything out of it.
 */
export function sealInvite(invite: Omit<Invite, "salt">, password: string): string {
  const salt = toBase32(randomBytes(5));
  const key = inviteKey(password, salt);

  const body = Buffer.from(JSON.stringify({ o: invite.onion, n: invite.name }), "utf8");
  const pad = Buffer.alloc(body.length);

  // A stream of key material the length of the body. The password is the only
  // secret, the salt makes it single-use, and the payload is a fixed 60-odd
  // bytes — so a stream cipher built from the hash is enough, and avoids the
  // 28 bytes of nonce and tag that GCM would add to something that has to fit
  // in a photograph.
  let block = key;
  for (let at = 0; at < body.length; at += 32) {
    block = createHmac("sha256", key).update(block).digest();
    block.copy(pad, at, 0, Math.min(32, body.length - at));
  }

  for (let at = 0; at < body.length; at++) body[at] ^= pad[at];

  const mac = createHmac("sha256", key).update(body).digest().subarray(0, 8);

  // Upper case throughout, including the prefix, so the whole string lives in
  // the QR's alphanumeric set and nothing forces it into byte mode.
  return ["REAPER1", salt, toBase32(body), toBase32(mac)].join(".");
}

/**
 * Read a QR code back, or explain why it cannot be read.
 *
 * The two failures are told apart on purpose. A code that is not a Reaper
 * invite at all means the camera caught something else, and the answer is to
 * scan again. A code that is an invite but will not open means the password is
 * wrong, and the answer is to type it again — which is a different sentence,
 * and telling someone to rescan a perfectly good code is how they conclude the
 * feature is broken.
 */
export function openInvite(
  code: string,
  password: string,
): { ok: true; invite: Invite } | { ok: false; reason: "not-an-invite" | "wrong-password" } {
  const parts = code.trim().split(".");
  // Case-insensitive, because a QR scanner returns what was encoded but a
  // person typing the code by hand will not hold shift for forty characters.
  if (parts.length !== 4 || parts[0].toUpperCase() !== "REAPER1") {
    return { ok: false, reason: "not-an-invite" };
  }

  const [, salt, payload, mac] = parts;

  const body = fromBase32(payload);
  const given = fromBase32(mac);

  if (!body || !given || !body.length || given.length !== 8) {
    return { ok: false, reason: "not-an-invite" };
  }

  const key = inviteKey(password, salt);
  const want = createHmac("sha256", key).update(body).digest().subarray(0, 8);

  if (!timingSafeEqual(want, given)) return { ok: false, reason: "wrong-password" };

  const pad = Buffer.alloc(body.length);
  let block = key;
  for (let at = 0; at < body.length; at += 32) {
    block = createHmac("sha256", key).update(block).digest();
    block.copy(pad, at, 0, Math.min(32, body.length - at));
  }

  const plain = Buffer.from(body);
  for (let at = 0; at < plain.length; at++) plain[at] ^= pad[at];

  try {
    const read = JSON.parse(plain.toString("utf8")) as { o: string; n: string };
    if (!/^[a-z2-7]{56}\.onion$/.test(read.o)) return { ok: false, reason: "wrong-password" };
    return { ok: true, invite: { onion: read.o, name: String(read.n || "a device"), salt } };
  } catch {
    return { ok: false, reason: "wrong-password" };
  }
}

/**
 * Stretch the password.
 *
 * scrypt rather than a plain hash, because this is the only thing standing
 * between a scanned code and an account, and people choose short passwords. N
 * is kept at 2^14 rather than something larger: it has to run on a phone, and
 * a pairing password is typed once during a deliberate act with the two
 * devices in the same room, not left standing as a permanent credential.
 */
function inviteKey(password: string, salt: string): Buffer {
  // The salt is upper-case base32 as produced, but it arrives back as whatever
  // the user typed. Folding it here rather than at the call sites means a code
  // entered in lower case derives the same key — which it must, because a
  // forty-character string typed by hand is not going to be typed in capitals.
  return scryptSync(password.normalize("NFKC"), `reaper-pair.${salt.toUpperCase()}`, 32, {
    N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
  });
}

/* ---- the wire ------------------------------------------------------------ */

type Wire =
  /**
   * Sent immediately by both ends, and the only message that authorises.
   *
   * It carries this device's own sync address, which is what makes pairing
   * two-way from a one-way QR code: the scanner learns where to reach the
   * device it scanned from the invite, and the device that showed the invite
   * learns where to reach the scanner from this. After one pairing either can
   * start the next one.
   */
  | {
      t: "hello";
      device: string;
      name: string;
      onion: string;
      nonce: string;
      proof: string;
      communities: string[];
    }
  /** Refused, with a reason worth showing someone. */
  | { t: "no"; why: string }
  /** What this device holds for a community, so the peer can send the rest. */
  | { t: "have"; community: string; summary: Summary }
  /** Events the peer lacked. */
  | { t: "give"; community: string; events: SignedEvent[] }
  /** Which pictures this device holds, so the peer can ask for what it lacks. */
  | { t: "pics"; ids: string[] }
  /** Send me this picture. */
  | { t: "getpic"; id: string }
  /** Here is one. */
  | { t: "pic"; id: string; bytes: string }
  /** Nothing further for this community. */
  | { t: "end"; community: string }
  /** Who is currently answering at the account address, and who wants to. */
  | { t: "claim"; holding: boolean; wants: boolean; n: number }
  /** Everything this side meant to send has been sent. */
  | { t: "done" };

/**
 * Split a stream into messages.
 *
 * Lifted from the chat transport unchanged in shape, because that reader has
 * never once desynchronised and this one used to do little else. It has no
 * notion of where the conversation has got to, so there is no state for a
 * packet boundary to catch it between.
 */
class FrameReader {
  #buffer = Buffer.alloc(0);

  push(chunk: Buffer, onMessage: (msg: Wire) => void): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    for (;;) {
      if (this.#buffer.length < HEADER) return;

      const length = this.#buffer.readUInt32BE(0);
      if (length > MAX_FRAME) throw new Error(`frame too large: ${length}`);

      // Not all here yet. Wait — a short read is the ordinary case, not a
      // fault, and the buffer is never discarded because of one.
      if (this.#buffer.length < HEADER + length) return;

      const flags = this.#buffer.readUInt8(4);
      const body = this.#buffer.subarray(HEADER, HEADER + length);
      this.#buffer = this.#buffer.subarray(HEADER + length);

      const raw = flags & FLAG_COMPRESSED ? brotliDecompressSync(body) : body;
      onMessage(JSON.parse(raw.toString("utf8")) as Wire);
    }
  }
}

function frame(message: Wire): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");

  const compress = json.length > COMPRESS_OVER;
  const body = compress ? brotliCompressSync(json) : json;

  const header = Buffer.alloc(HEADER);
  header.writeUInt32BE(body.length, 0);
  header.writeUInt8(compress ? FLAG_COMPRESSED : 0, 4);

  return Buffer.concat([header, body]);
}

/* ---- what the surrounding app has to provide ----------------------------- */

export interface PairHooks {
  /** This install. Not the user and not the machine. */
  device: string;

  /** What to call this device in a sentence. */
  name: string;

  /** This device's own sync address, so the peer can reach back. */
  onion(): string;

  /** The pairing password currently set, if any. */
  password(): string | undefined;

  communities(): string[];
  summary(community: string): Summary;
  missingForSummary(community: string, summary: Summary): SignedEvent[];
  merge(community: string, events: SignedEvent[]): number;

  pictureIds(): string[];
  readPicture(id: string): Buffer | undefined;
  writePicture(id: string, bytes: Buffer): void;

  /** Is this device the one currently answering at the account address. */
  holding(): boolean;

  /** Has the user asked to move the account address to this device. */
  wants(): boolean;

  /** The highest claim number this device knows about. */
  claimN(): number;

  /** A peer has proved itself; remember where it is and what it is called. */
  learn(peer: { device: string; name: string; onion: string }): void;

  /** The peer holds the address and this device asked for it. Give way. */
  yield(peer: { device: string; name: string }): void;

  /** The peer asked for the address and this device holds it. */
  asked(peer: { device: string; name: string }): void;
}

export interface PairResult {
  device: string;
  name: string;
  onion: string;
  events: number;
  pictures: number;
  communities: number;
  done: boolean;
}

/* ---- the session --------------------------------------------------------- */

/**
 * One connection, in both directions at once.
 *
 * There is no dialler and no listener here; there is no `first` flag and no
 * lead. Whichever side opened the socket, both do the identical thing: greet,
 * then react. A session finishes when both ends have said `done`, which is the
 * only piece of sequencing in the whole protocol and is a pair of booleans
 * rather than an order.
 */
class Session {
  readonly #socket: Socket;
  readonly #hooks: PairHooks;
  readonly #reader = new FrameReader();

  /** Ours, sent in the greeting, and what the peer must sign. */
  readonly #nonce = randomBytes(16).toString("hex");

  #authorised = false;
  #saidDone = false;
  #heardDone = false;
  #settled = false;

  /** Communities still expecting an `end`. */
  readonly #open = new Set<string>();

  /** Pictures asked for and not yet arrived. */
  readonly #chasing = new Set<string>();

  readonly #result: PairResult = {
    device: "", name: "", onion: "",
    events: 0, pictures: 0, communities: 0, done: false,
  };

  #resolve!: (value: PairResult) => void;
  #reject!: (error: Error) => void;
  #timer?: NodeJS.Timeout;

  constructor(socket: Socket, hooks: PairHooks) {
    this.#socket = socket;
    this.#hooks = hooks;
  }

  run(): Promise<PairResult> {
    return new Promise<PairResult>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;

      const password = this.#hooks.password();

      if (!password) {
        this.#send({ t: "no", why: "that device has no pairing password set" });
        this.#fail("set a pairing password on this device first");
        return;
      }

      this.#socket.setNoDelay(true);
      this.#touch();

      this.#socket.on("data", (chunk: Buffer) => {
        this.#touch();

        try {
          this.#reader.push(chunk, (msg) => this.#handle(msg));
        } catch (error) {
          this.#fail((error as Error).message || "that device sent something unreadable");
        }
      });

      this.#socket.on("error", (error: Error) => this.#fail(error.message));

      this.#socket.on("close", () => {
        // A close after both sides finished is how a session ends, not a
        // failure. Only an early one is worth reporting.
        if (this.#result.done) this.#settle();
        else this.#fail("that device closed the connection");
      });

      // Immediately, and without waiting for anything. This is the part the
      // old protocol got wrong: there is nothing to wait for.
      this.#send({
        t: "hello",
        device: this.#hooks.device,
        name: this.#hooks.name,
        onion: this.#hooks.onion(),
        nonce: this.#nonce,
        proof: "",
        communities: this.#hooks.communities(),
      });
    });
  }

  /**
   * The greeting is sent before the peer's nonce is known, so the proof cannot
   * be in it. It is sent as its own message the moment their nonce arrives —
   * which keeps the greeting unordered like everything else, at the cost of
   * one extra message that costs nothing on an already-open circuit.
   */
  #handle(msg: Wire): void {
    switch (msg.t) {
      case "hello": {
        const password = this.#hooks.password();
        if (!password) return;

        const expect = createHmac("sha256", inviteKey(password, "pair"))
          .update(`${msg.device}:${this.#nonce}`)
          .digest("hex");

        // An empty proof is the opening greeting; answer it with one over
        // their nonce. A filled one is their answer to ours.
        if (!msg.proof) {
          this.#result.device = msg.device;
          this.#result.name = msg.name || "a device";
          this.#result.onion = msg.onion || "";

          this.#send({
            t: "hello",
            device: this.#hooks.device,
            name: this.#hooks.name,
            onion: this.#hooks.onion(),
            nonce: this.#nonce,
            proof: createHmac("sha256", inviteKey(password, "pair"))
              .update(`${this.#hooks.device}:${msg.nonce}`)
              .digest("hex"),
            communities: this.#hooks.communities(),
          });
          return;
        }

        if (msg.proof.length !== expect.length ||
            !timingSafeEqual(Buffer.from(msg.proof), Buffer.from(expect))) {
          this.#send({ t: "no", why: "that is a different account or a different password" });
          this.#fail("the password did not match");
          return;
        }

        this.#authorised = true;
        this.#result.device = msg.device;
        this.#result.name = msg.name || this.#result.name || "a device";
        this.#result.onion = msg.onion || this.#result.onion;

        // The whole point of the two-way bootstrap: remember where this device
        // is, so the next sync can start from either end without a QR code.
        if (this.#result.onion) {
          this.#hooks.learn({
            device: this.#result.device,
            name: this.#result.name,
            onion: this.#result.onion,
          });
        }

        this.#send({
          t: "claim",
          holding: this.#hooks.holding(),
          wants: this.#hooks.wants(),
          n: this.#hooks.claimN(),
        });

        // Offer everything at once rather than one community at a time. There
        // is no ordering to preserve — each `have` names its own community.
        const mine = new Set([...this.#hooks.communities(), ...msg.communities, PICTURES]);
        this.#result.communities = mine.size;

        for (const community of mine) {
          this.#open.add(community);
          this.#send({ t: "have", community, summary: this.#hooks.summary(community) });
        }

        this.#send({ t: "pics", ids: this.#hooks.pictureIds() });
        this.#maybeDone();
        return;
      }

      case "no":
        this.#fail(msg.why || "that device refused");
        return;

      default:
        // Everything below needs the peer to have proved itself. Reaching here
        // unauthorised is not a protocol slip to be tolerated — it is someone
        // who found the address trying to skip the password.
        if (!this.#authorised) {
          this.#fail("that device sent data before proving the password");
          return;
        }
    }

    switch (msg.t) {
      case "have": {
        const missing = this.#hooks.missingForSummary(msg.community, msg.summary);

        for (let at = 0; at < missing.length; at += BATCH) {
          this.#send({
            t: "give",
            community: msg.community,
            events: missing.slice(at, at + BATCH),
          });
        }

        this.#send({ t: "end", community: msg.community });
        return;
      }

      case "give":
        this.#result.events += this.#hooks.merge(msg.community, msg.events);
        return;

      case "end":
        this.#open.delete(msg.community);
        this.#maybeDone();
        return;

      case "pics": {
        const held = new Set(this.#hooks.pictureIds());

        for (const id of msg.ids) {
          if (held.has(id) || this.#chasing.has(id)) continue;
          this.#chasing.add(id);
          this.#send({ t: "getpic", id });
        }

        this.#maybeDone();
        return;
      }

      case "getpic": {
        const bytes = this.#hooks.readPicture(msg.id);
        if (bytes) this.#send({ t: "pic", id: msg.id, bytes: bytes.toString("base64") });
        return;
      }

      case "pic": {
        this.#chasing.delete(msg.id);

        try {
          this.#hooks.writePicture(msg.id, Buffer.from(msg.bytes, "base64"));
          this.#result.pictures += 1;
        } catch {
          // A picture that will not decode is not worth abandoning a sync for.
        }

        this.#maybeDone();
        return;
      }

      case "claim": {
        const peer = { device: this.#result.device, name: this.#result.name };

        // Both sides compute this from the same two booleans and reach the
        // same answer, which is what keeps exactly one device answering.
        if (msg.holding && this.#hooks.wants()) this.#hooks.asked(peer);
        else if (msg.wants && this.#hooks.holding()) this.#hooks.yield(peer);

        return;
      }

      case "done":
        this.#heardDone = true;
        this.#maybeDone();
        return;
    }
  }

  /**
   * Finished when there is nothing outstanding and the peer agrees.
   *
   * Checked after every message rather than at a fixed point in a script, so
   * it does not matter which order things completed in.
   */
  #maybeDone(): void {
    if (!this.#authorised) return;

    if (!this.#saidDone && !this.#open.size && !this.#chasing.size) {
      this.#saidDone = true;
      this.#send({ t: "done" });
    }

    if (this.#saidDone && this.#heardDone) {
      this.#result.done = true;
      this.#socket.end();
      this.#settle();
    }
  }

  #send(message: Wire): void {
    if (this.#socket.destroyed) return;
    this.#socket.write(frame(message));
  }

  #touch(): void {
    if (this.#timer) clearTimeout(this.#timer);

    // Restarted by traffic rather than set once for the whole session. A large
    // account over a slow circuit takes as long as it takes; silence is the
    // thing worth giving up on.
    this.#timer = setTimeout(() => this.#fail("that device stopped responding"), IDLE_MS);
  }

  #settle(): void {
    if (this.#settled) return;
    this.#settled = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#resolve(this.#result);
  }

  #fail(why: string): void {
    if (this.#settled) return;
    this.#settled = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#socket.destroy();
    this.#reject(new Error(why));
  }
}

/* ---- the service --------------------------------------------------------- */

/**
 * Listens for siblings, and runs a session over any socket handed to it.
 *
 * It does not dial. Opening a Tor circuit belongs to the code that knows what
 * an onion address is, and keeping that out of here is what lets the same
 * class run on a phone, where the socket comes from a native plugin.
 */
export class PairService extends EventEmitter {
  readonly #hooks: PairHooks;
  #server?: Server;
  #port?: number;

  constructor(hooks: PairHooks) {
    super();
    this.#hooks = hooks;
  }

  get port(): number | undefined {
    return this.#port;
  }

  async open(): Promise<number> {
    if (this.#port) return this.#port;

    const server = createServer((socket) => {
      new Session(socket, this.#hooks).run()
        .then((result) => this.emit("paired", result))
        .catch((error: Error) => this.emit("failed", error.message));
    });

    this.#server = server;

    this.#port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);

      // Loopback only. The onion service is the way in, and binding wider
      // would put the account on the local network as well.
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as { port: number }).port);
      });
    });

    return this.#port;
  }

  /** Run a session over a socket somebody else connected. */
  adopt(socket: Socket): Promise<PairResult> {
    return new Session(socket, this.#hooks).run();
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (!server) return;

    this.#server = undefined;
    this.#port = undefined;

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
