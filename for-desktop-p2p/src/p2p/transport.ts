import { EventEmitter } from "node:events";
import { Socket, createServer, type Server } from "node:net";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";

import { BLOB_CHUNK } from "./blobs";
import type { SignedEvent } from "./events";
import type { Summary } from "./vector";
import { socksConnect } from "./tor";

/**
 * Peer transport.
 *
 * Plain TCP with length-prefixed JSON frames, and no dependencies at all.
 *
 * The obvious alternative is libp2p, and it is the right long-term answer —
 * it brings the DHT for finding peers and hole punching for reaching them
 * behind NAT. It is deliberately not the starting point, for one reason: the
 * hard part of peer-to-peer is not moving bytes, it is discovery and NAT. Both
 * of those can be layered on later *without touching this file's protocol*,
 * because reconciliation is already solved above it (`missingFor` / `merge`).
 *
 * Starting here means two machines on the same network sync today, and the
 * sync logic gets exercised for real before the connectivity machinery is
 * added on top. Starting with libp2p means debugging a large dependency and an
 * unproven sync path at the same time.
 *
 * Every connection goes through Tor. There is no direct-IP path and no LAN
 * discovery, by design: either would reveal an address, and one accidental
 * fallback is enough to undo the property the whole design exists for.
 *
 * The cost is latency. Tor adds a few hundred milliseconds and carries only
 * TCP, which is irrelevant for text and history sync, and is the reason voice
 * here is turn-taking rather than conversational — see the `audio` message
 * below.
 *
 * ## Framing
 *
 *   [4 bytes big-endian length][1 byte flags][body]
 *
 * TCP is a stream, not a message channel — a `data` event may hold half a
 * message or three of them. The length prefix is what turns it back into
 * discrete messages, and getting this wrong is the classic way a protocol
 * works on localhost and corrupts under real latency.
 *
 * ## Compression
 *
 * Tor is slow enough that bytes are worth spending effort on. The body is
 * Brotli-compressed when that helps, flagged in the header byte.
 *
 * What compresses is the envelope, not the contents: payloads are encrypted,
 * and ciphertext is indistinguishable from random. But a `give` carrying a
 * hundred events repeats the same JSON keys, the same 44-character author key
 * and the same community id every time, and that redundancy is most of the
 * bytes for short messages.
 *
 * Compression is attempted, then kept only if the result is actually smaller.
 * Encrypted payloads and base64 audio both *grow* under Brotli, so an
 * unconditional compress would have made the common case worse.
 */

const MAX_FRAME = 32 * 1024 * 1024;

/** Header flag: body is Brotli-compressed. */
const FLAG_COMPRESSED = 0x01;

/**
 * Below this, compression is not attempted.
 *
 * Brotli's own header costs tens of bytes, so a short control message comes
 * out larger. The floor avoids the work and the check.
 */
const COMPRESS_MIN_BYTES = 256;

/**
 * Quality 4 rather than the default 11.
 *
 * On JSON of this shape the ratio difference is a couple of percent while 11
 * is roughly an order of magnitude slower — and this runs on every frame,
 * including audio at five per second.
 */
const COMPRESS_QUALITY = 4;

/**
 * Most events in one `give` or `push`.
 *
 * Reconciliation used to answer with every missing event in a single frame.
 * That is fine until it isn't: once a community's backlog exceeded MAX_FRAME
 * the receiver rejected the frame and dropped the connection, reconnected,
 * was sent the same oversized frame, and dropped again. Sync wedged
 * permanently and stayed wedged across restarts, because nothing about it was
 * in memory — the backlog was on disk and simply too big to answer in one go.
 *
 * Batching means a large backlog takes several round trips instead of failing.
 */
const GIVE_EVENTS = 64;

/** ...and a byte ceiling, since one event can be an attachment. */
const GIVE_BYTES = 4 * 1024 * 1024;

/**
 * How much unsent data may sit on a socket before audio is discarded.
 *
 * Audio and messages share one ordered TCP stream, so a backlog of audio
 * delays everything behind it — and over Tor a stall of a few seconds is
 * enough to look like the app has died. A dropped audio frame costs a
 * syllable; a dropped message costs the conversation, so audio is what gives
 * way.
 */
const AUDIO_BACKLOG = 256 * 1024;

/** Audio frames remembered for loop suppression. */
const AUDIO_MEMORY = 4096;

/**
 * How often to re-offer an id set that has not changed.
 *
 * Offers are how gaps are found, so they cannot stop entirely — but repeating
 * an identical list every fifteen seconds is pure cost. Sending it only when
 * it changes, plus once every few minutes as a safety net, keeps the recovery
 * property while removing almost all of the traffic.
 */
const REOFFER_EVERY_MS = 240000;

/** Most ids remembered per peer as already sent. */
const SENT_MEMORY = 20000;

/**
 * What jumps the queue.
 *
 * One ordered TCP stream per peer carries everything, so a large transfer sits
 * in front of whatever follows it — and over Tor "in front" can mean several
 * seconds. Priority decides what is written when several things are waiting,
 * which is the only lever available short of opening more circuits.
 *
 * The order is by how badly delay hurts:
 *
 *   - Voice is worthless late. A syllable that arrives a second after it was
 *     spoken is not a syllable, it is a glitch.
 *   - Liveness, so a busy connection is never mistaken for a dead one.
 *   - Things addressed to a person: a mention, a direct message, a call being
 *     placed. Being told promptly is the entire point of them.
 *   - Ordinary live messages.
 *   - Reconciliation and file transfer, which are background work by nature
 *     and the things most likely to be large.
 */
const PRIORITY: Record<string, number> = {
  audio: 0,
  ping: 1,
  pong: 1,
  signal: 1,
  // Receipts and refusals are tiny, and everything waiting on one is blocked
  // until it arrives.
  ack: 1,
  refuse: 1,
  urgent: 2,
  push: 3,
  hello: 3,
  focus: 3,
  announce: 4,
  have: 4,
  want: 4,
  noblob: 4,
  give: 5,
  blob: 5,
};

const PRIORITIES = 6;

/**
 * How much a peer may be sent per second, and how much may be queued for it.
 *
 * Unlimited by default: the queue exists to order things, and a limit is only
 * useful to somebody who knows their connection cannot take the full rate.
 * The backlog cap is not optional though — without it a slow circuit turns
 * into unbounded memory.
 */
const DEFAULT_BACKLOG_BYTES = 8 * 1024 * 1024;

/**
 * A blob frame small enough to send during a call.
 *
 * Sized against `BLOB_CHUNK`: a file larger than one chunk is split, and every
 * one of its frames exceeds this, so the test cleanly separates "a whole small
 * file" from "part of a large one". Profile pictures and banners are the
 * things that fit, which is the point — they are what a call was starving.
 */
const SMALL_BLOB_BYTES = 96 * 1024;

/**
 * What this build understands beyond the original protocol.
 *
 * Sent in the handshake and used to decide, per peer, whether a newer form of
 * a message is safe to use. Anything a peer does not claim falls back to the
 * form every build has always spoken, so an old client and a new one still
 * reconcile completely — just less efficiently.
 *
 * `vec` — summarise a log by watermark rather than by listing every id.
 */
const CAPABILITIES = new Set(["vec"]);

/**
 * A summary reduced to one comparable string.
 *
 * Only used to notice that an offer has not changed since the last one, so it
 * needs to be stable and cheap rather than collision-proof.
 */
function summaryShape(summary: Summary): string {
  const vector = Object.keys(summary.vector)
    .sort()
    .map((author) => `${author}:${summary.vector[author]}`)
    .join(",");

  return `${vector}|${[...summary.extra].sort().join(",")}`;
}

/**
 * How long to wait for a peer to start answering a file request.
 *
 * Long, because it is measuring the wrong thing cheaply: a peer that is simply
 * slow will have sent a first chunk well inside this, and one that intends to
 * answer nothing costs only this much delay before the next is tried.
 */
const WANT_TIMEOUT_MS = 20000;

/** How many blob origins to remember. See `#blobFrom`. */
const BLOB_SOURCE_MEMORY = 4096;

/**
 * How often to prove a connection is still alive, and how long to wait before
 * concluding it is not.
 *
 * TCP keepalive is no help here. The socket goes to the local Tor daemon, so
 * keepalive only ever proves that Tor is running on this machine — the circuit
 * beyond it can be gone entirely while the socket stays open and writable.
 * Nothing errors, nothing closes, and the peer sits in the list looking
 * connected forever. Since the dial loop skips anyone already "connected", it
 * never redials either, and the app stays silently offline until it is
 * restarted.
 *
 * So liveness has to be established end to end, at this layer.
 *
 * The timeout is what decides how long somebody keeps looking online after
 * their machine is switched off — a power cut sends no FIN, so nothing tells
 * us and the only evidence is silence. Sixty seconds was too generous: it
 * meant a friend who shut down was shown as present for over a minute, which
 * reads as a bug because it is indistinguishable from one.
 *
 * Forty seconds against a twelve-second ping still allows three round trips to
 * be lost before a peer is judged gone, which matters more than it sounds:
 * dropping a live peer costs a redial and a fresh circuit, and a circuit takes
 * long enough to build that a false drop is far more disruptive than a stale
 * dot. Tor's round trip is normally a second or two, so three missed pings is
 * a connection that is genuinely not working.
 */
const PING_EVERY_MS = 12000;
const IDLE_TIMEOUT_MS = 40000;

/** Overridable so a test can reach the timeout without waiting a minute. */
export interface TransportTiming {
  pingEveryMs?: number;
  idleTimeoutMs?: number;

  /**
   * This install's id, announced so peers can tell two of your machines apart.
   *
   * Optional, and absent it behaves exactly as it did before the field
   * existed. It is not security-relevant — it decides which of two sockets to
   * keep, and a peer that lies about it costs itself a connection.
   */
  device?: string;
}

/** Wire messages. */
type Wire =
  // `caps` is what a build understands beyond the original protocol — see
  // `CAPABILITIES`. Optional, because a peer that predates it says nothing and
  // is talked to in the older way.
  //
  // It was being sent and read without ever being declared here, which the
  // compiler had been objecting to for as long as it has existed. Worth fixing
  // rather than suppressing: this union is the only written statement of what
  // the two sides may say to each other, and a field missing from it is a
  // field nothing checks the shape of.
  // `device` distinguishes two machines signed into one account — see the
  // duplicate-connection rule in `#handle`. Optional, because a peer that
  // predates it is a peer for whom one user id really did mean one machine.
  | {
      t: "hello";
      userId: string;
      communities: string[];
      caps?: string[];
      device?: string;
    }
  // Liveness. Cheap enough to send unconditionally; the reply is what proves
  // the circuit still carries traffic in both directions.
  //
  // The user id rides along, which looks redundant next to `hello` and is
  // not. `hello` is sent exactly once, at connect time, and anything that
  // costs us that one frame — a duplicate connection collapsing, a frame
  // arriving mid-teardown — leaves a peer permanently anonymous: connected,
  // carrying traffic, and shown as "connecting…" forever because nothing ever
  // says who it is again. Repeating it every fifteen seconds makes that
  // self-correcting instead of terminal.
  | { t: "ping"; userId: string }
  | { t: "pong"; userId: string }
  // Re-announce the community list on an existing connection.
  //
  // `hello` is sent once, at connect time. Joining a community afterwards used
  // to be invisible to peers already connected: they had been told the old
  // list and were never told again, so the new community simply never synced
  // and appeared permanently empty.
  | { t: "announce"; communities: string[] }
  // Which communities this peer wants live writes for.
  //
  // Without it, suppressing background sync only saves the *asking* — a peer
  // still pushed every message from every shared community, and the bytes
  // arrived whether or not anyone was going to look at them. Saying so up
  // front is what turns that into an actual saving, because the sender skips
  // the write instead of the receiver discarding it.
  //
  // Absent means everything, so a peer that never says anything keeps the old
  // behaviour and nothing is lost by not understanding this message.
  | { t: "focus"; communities: string[] }
  // What a peer actually stored.
  //
  // Everything else in this protocol is best-effort by design: an event is
  // offered, and whether it lands is somebody else's business. That is fine
  // for chat, where the next reconciliation fixes it, and wrong for the small
  // number of things that must happen exactly once and cannot be inferred from
  // anything else — being removed from a friend list, being invited to a
  // group, leaving a room. Those have a sender who needs to know, and until
  // this message existed there was no way for them to find out.
  //
  // It is a receipt, not an acknowledgement of a send: the ids listed are the
  // ids now in the peer's log, so a duplicate delivery is acked too and a
  // rejected event is not.
  | { t: "ack"; community: string; ids: string[] }
  // Why a peer refused something.
  //
  // A silent refusal leaves both sides wrong in different ways: the sender
  // keeps offering, and the receiver keeps discarding. Saying why lets the
  // sender repair the disagreement — usually by removing somebody from a
  // member list, or by re-sending the invitation that would have made the
  // refusal wrong.
  | { t: "refuse"; community: string; reason: string }
  // `ids` is the original form — every event id held. `summary` is the compact
  // one, a watermark per author, sent only to a peer that said it understands
  // them. Exactly one of the two is meaningful; `ids` is empty when a summary
  // is present.
  | { t: "have"; community: string; ids: string[]; summary?: Summary }
  | { t: "give"; community: string; events: SignedEvent[] }
  | { t: "push"; community: string; events: SignedEvent[] }
  // Voice signalling. Carried here rather than in the event log because SDP
  // and ICE are ephemeral negotiation state — putting them in an append-only
  // log would persist and replicate call setup forever.
  | { t: "signal"; to: string; from: string; data: unknown }
  // Voice. Opus frames relayed to everyone in a call.
  //
  // Audio rides the same TCP stream as everything else because Tor offers
  // nothing else — there is no UDP over Tor, so the usual media path is
  // unavailable. Reliable ordered delivery is wrong for audio (a lost frame
  // should be skipped, not retransmitted while everything behind it waits),
  // and that, plus Tor's latency, is why this is push-to-talk quality rather
  // than a normal call. The alternative was no voice at all.
  | { t: "audio"; channel: string; from: string; seq: number; frame: string }
  // File transfer, deliberately outside the event log.
  //
  // Attachments used to ride inside the message event, which meant every peer
  // downloaded and permanently stored every file the moment it was sent —
  // there was no point at which anyone could decline. Asking for bytes is what
  // makes declining possible.
  | { t: "want"; community: string; blob: string }
  | { t: "blob"; community: string; blob: string; index: number; total: number; data: string }
  | { t: "noblob"; community: string; blob: string };

export interface PeerInfo {
  id: string;
  address: string;
  userId?: string;

  /**
   * Which of that person's machines this is, when they said.
   *
   * A user id names an account, and an account can be signed in on several
   * devices at once. Without this the transport could not tell a second
   * machine from a second socket to the same one.
   */
  device?: string;

  inbound: boolean;

  /**
   * Round trip in milliseconds, from the liveness ping.
   *
   * The ping already existed and already had to be answered, so timing it
   * costs nothing and measures the real path — through Tor, three hops each
   * way — rather than something synthetic.
   */
  rtt?: number;
}

/**
 * Byte and frame counters, per wire message type.
 *
 * Recorded here rather than at each call site because every outbound frame
 * passes through `encode` and every inbound one through the reader — two
 * chokepoints, so nothing can be added later and quietly go uncounted.
 *
 * Sizes are on-the-wire sizes: after compression, including the header. That
 * is the number that matters, since it is what Tor actually carries, and it is
 * frequently half of what the message looks like in memory.
 */
export interface WireCounters {
  frames: number;
  bytes: number;
}

const WIRE_STATS: {
  out: Record<string, WireCounters>;
  in: Record<string, WireCounters>;
  dropped: WireCounters;
  recent: { at: number; bytes: number; out: boolean }[];
} = { out: {}, in: {}, dropped: { frames: 0, bytes: 0 }, recent: [] };

/** How long the rolling rate window looks back. */
const RATE_WINDOW_MS = 10000;

/**
 * Where the live part of `recent` starts.
 *
 * `Array.shift` is O(n) in the length of the array, and this runs on every
 * frame in both directions — including audio, which is five a second per peer
 * during a call, on top of every blob chunk of every transfer. Dropping the
 * head by moving an index instead makes the common path O(1), and the array is
 * compacted only when the dead prefix is worth reclaiming.
 */
let recentHead = 0;

function note(out: boolean, type: string, bytes: number): void {
  const side = out ? WIRE_STATS.out : WIRE_STATS.in;
  const c = side[type] || (side[type] = { frames: 0, bytes: 0 });
  c.frames++;
  c.bytes += bytes;

  const now = Date.now();
  WIRE_STATS.recent.push({ at: now, bytes, out });

  // Pruned on write rather than on read: the reader is a UI poll and should
  // not be the thing that decides how much memory this keeps.
  const cutoff = now - RATE_WINDOW_MS;
  while (
    recentHead < WIRE_STATS.recent.length &&
    WIRE_STATS.recent[recentHead].at < cutoff
  ) {
    recentHead++;
  }

  // One copy when half of it is dead, rather than one shift per frame.
  if (recentHead > 256 && recentHead * 2 >= WIRE_STATS.recent.length) {
    WIRE_STATS.recent = WIRE_STATS.recent.slice(recentHead);
    recentHead = 0;
  }
}

/** A snapshot for the UI. Rates are bytes per second over the last window. */
export function wireStats(): {
  out: Record<string, WireCounters>;
  in: Record<string, WireCounters>;
  dropped: WireCounters;
  rateOut: number;
  rateIn: number;
} {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  let outBytes = 0;
  let inBytes = 0;

  for (let i = recentHead; i < WIRE_STATS.recent.length; i++) {
    const r = WIRE_STATS.recent[i];
    if (r.at < cutoff) continue;
    if (r.out) outBytes += r.bytes; else inBytes += r.bytes;
  }

  const seconds = RATE_WINDOW_MS / 1000;
  return {
    out: { ...WIRE_STATS.out },
    in: { ...WIRE_STATS.in },
    dropped: { ...WIRE_STATS.dropped },
    rateOut: Math.round(outBytes / seconds),
    rateIn: Math.round(inBytes / seconds),
  };
}

export function resetWireStats(): void {
  WIRE_STATS.out = {};
  WIRE_STATS.in = {};
  WIRE_STATS.dropped = { frames: 0, bytes: 0 };
  WIRE_STATS.recent = [];
  recentHead = 0;
}

function encode(msg: Wire): Buffer {
  const raw = Buffer.from(JSON.stringify(msg), "utf8");

  let body = raw;
  let flags = 0;

  if (raw.length >= COMPRESS_MIN_BYTES) {
    const packed = brotliCompressSync(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: COMPRESS_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      },
    });

    // Only if it actually helped. Encrypted payloads and base64 audio are
    // incompressible and come back bigger.
    if (packed.length < raw.length) {
      body = packed;
      flags |= FLAG_COMPRESSED;
    }
  }

  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length, 0);
  head.writeUInt8(flags, 4);

  note(true, msg.t, body.length + 5);
  return Buffer.concat([head, body]);
}

/**
 * Accumulates bytes and emits whole messages.
 */
class FrameReader {
  #buffer = Buffer.alloc(0);

  push(chunk: Buffer, onMessage: (msg: Wire) => void): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    for (;;) {
      // 5 bytes of header now: length plus a flag byte.
      if (this.#buffer.length < 5) return;

      const length = this.#buffer.readUInt32BE(0);
      if (length > MAX_FRAME) throw new Error(`frame too large: ${length}`);
      if (this.#buffer.length < 5 + length) return;

      const flags = this.#buffer.readUInt8(4);
      const body = this.#buffer.subarray(5, 5 + length);
      this.#buffer = this.#buffer.subarray(5 + length);

      const raw =
        flags & FLAG_COMPRESSED ? brotliDecompressSync(body) : body;

      const msg = JSON.parse(raw.toString("utf8")) as Wire;
      note(false, msg.t, length + 5);
      onMessage(msg);
    }
  }
}

export interface TransportHooks {
  /** Communities this device participates in. */
  communities(): string[];

  /** Every event id held for a community. */
  idsFor(community: string): string[];

  /** Events held that the peer's id set lacks. */
  missingFor(community: string, peerIds: Set<string>): SignedEvent[];

  /**
   * Take in events from a peer.
   *
   * Returns the ids now held, which is not the same as the ids accepted just
   * now: an event that was already here is still something the sender is owed
   * a receipt for, because from their side "you have it" and "you took it from
   * me" are the same fact and only the first one matters.
   */
  merge(community: string, events: SignedEvent[]): { accepted: number; held: string[] };

  /**
   * Why this peer may not sync a community, if it may not.
   *
   * Returns undefined when there is nothing to say. A reason is only sent in
   * answer to something the peer actually asked for, so this is never a way to
   * enumerate what somebody is not in.
   */
  refusal?(community: string, peerUserId: string | undefined): string | undefined;

  /**
   * Whether to exchange anything at all with this peer, for a community.
   *
   * Distinct from `accepts`, which answers "would I take this conversation on
   * sight". This answers "does this peer belong here", and it is asked on
   * every offer rather than once at first contact — membership is decided by
   * the log, and the log changes.
   */
  serves(community: string, peerUserId: string | undefined): boolean;

  /** This log as a watermark summary, when the peer understands one. */
  summaryFor?(community: string): Summary;

  /** What a peer lacks, given their summary. */
  missingForSummary?(community: string, summary: Summary): SignedEvent[];

  /**
   * Whether to *start* reconciling a community with a peer.
   *
   * Offering our id set is what triggers a full comparison, and the cost of
   * that scales with history and with the number of communities held. Someone
   * in twenty servers was paying for twenty comparisons on every connection
   * and every announce, over Tor, for nineteen conversations they were not
   * looking at.
   *
   * Deliberately one-directional: this suppresses offers, and never refusals.
   * A peer who *is* looking at that server still gets an answer when they
   * offer their own ids, so the cost lands on whoever actually wants the data
   * rather than on everybody holding it.
   */
  reconciles(community: string): boolean;

  /**
   * Bytes for a blob, if this device holds it and the peer may have it.
   *
   * The community is passed so the answer can be scoped to it. Ids travel
   * inside messages, so knowing one proves nothing about being entitled to the
   * file — only membership of the conversation it was posted in does.
   */
  blobFor(community: string, blob: string): Buffer | undefined;

  /** A blob arrived in full and verified. */
  blobDone(community: string, blob: string, data: Buffer): void;

  /**
   * Whether to accept a community this device does not yet hold.
   *
   * Sync used to require both sides to already have a community, which made
   * first contact impossible: a direct conversation exists only on the
   * sender's side until the recipient has heard of them, so the intersection
   * was empty and the request never arrived.
   *
   * The bridge decides. It accepts a conversation whose id derives from this
   * user and the peer — provable without asking anyone — and refuses the rest,
   * so a peer cannot push arbitrary communities onto a device.
   */
  accepts(community: string, peerUserId: string | undefined): boolean;
}

export class Transport extends EventEmitter {
  #server: Server | undefined;
  #peers = new Map<
    string,
    {
      socket: Socket;
      info: PeerInfo;
      lastSeen: number;
      pingedAt?: number;
      /** What they asked for. Undefined means they never said, so: all. */
      wants?: Set<string>;

      /**
       * Event ids already handed to this peer on this connection.
       *
       * Without it, anything a peer declines to keep is offered again on every
       * announce, forever. That is not hypothetical: an event they reject —
       * a bad signature, an author over capacity, a community they have since
       * left — never appears in their id set, so it is "missing" every time we
       * look, and a log with one such event re-sends the whole batch around it
       * on every pass.
       */
      sent?: Set<string>;

      /** Id sets last offered, so an unchanged offer is not repeated. */
      offered?: Map<string, string>;

      /** Frames waiting to go out, one bucket per priority. */
      queue?: Buffer[][];

      /** Bytes currently queued, so a slow circuit cannot eat memory. */
      queued?: number;

      /** A pending drain, when the rate limit made us wait. */
      draining?: ReturnType<typeof setTimeout>;

      /** Tokens for the rate limit, refilled as time passes. */
      tokens?: number;
      refilled?: number;

      /** The same, for what arrives. See `#throttleIn`. */
      inTokens?: number;
      inRefilled?: number;
      resume?: ReturnType<typeof setTimeout>;

      /** What this peer's build understands. Empty means the original set. */
      caps?: Set<string>;
    }
  >();
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #hooks: TransportHooks;
  #userId: string;
  #seq = 0;

  /** Bytes per second allowed out, per peer. Zero means no limit. */
  #rateOut = 0;
  #rateIn = 0;

  /** Whether only call-critical traffic should move. */
  #callFocus = false;

  /** Recently relayed audio, so a mesh containing a cycle cannot amplify it. */
  #seenAudio = new Set<string>();
  #seenAudioOrder: string[] = [];

  /** Partially received blobs, keyed by peer, community and id. */
  #incoming = new Map<string, { chunks: (Buffer | undefined)[]; have: number; total: number }>();

  #pingEvery: number;
  #idleTimeout: number;
  #device: string | undefined;

  constructor(userId: string, hooks: TransportHooks, timing: TransportTiming = {}) {
    super();
    this.#userId = userId;
    this.#hooks = hooks;
    this.#pingEvery = timing.pingEveryMs ?? PING_EVERY_MS;
    this.#idleTimeout = timing.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.#device = timing.device;
  }

  /** Port we are listening on, or undefined if not started. */
  get port(): number | undefined {
    const address = this.#server?.address();
    return address && typeof address !== "string" ? address.port : undefined;
  }

  peers(): PeerInfo[] {
    return [...this.#peers.values()].map((p) => p.info);
  }

  /**
   * Start accepting connections.
   *
   * Port 0 asks the OS for a free one, which is right for a first run but
   * useless for being *reached* — a peer needs a stable port to connect back
   * to, so a fixed one should be configured and forwarded.
   */
  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#server = createServer((socket) => this.#attach(socket, true));
      this.#server.on("error", reject);
      this.#server.listen(port, () => resolve(this.port!));
    });
  }

  /**
   * Connect to a peer's onion address.
   *
   * Onion addresses only. A plain host:port is rejected rather than quietly
   * accepted — a single direct connection would expose the address this whole
   * transport exists to hide, and "it still worked" is exactly how that kind
   * of leak survives review.
   */
  async connect(address: string): Promise<void> {
    const host = address.trim().replace(/^\w+:\/\//, "").split("/")[0];

    if (!/^[a-z2-7]{56}\.onion$/i.test(host)) {
      throw new Error(
        `not an onion address: ${address} — direct connections are disabled`,
      );
    }

    // One attempt at a time, per address.
    //
    // Callers above dial on a timer, on a drop, on opening a conversation and
    // on a presence sweep — all reasonable, and all asking "is this person
    // reachable". Without a guard here those overlap: a circuit that takes
    // twenty seconds to build collects four more attempts behind it, each
    // becoming its own connection, each triggering a handshake and a full
    // offer. Hundreds of handshakes in a session is that, not a flaky network.
    if (this.#dialling.has(host)) return;
    this.#dialling.add(host);

    try {
      // Port 80 on the onion maps to the peer's listener, so a caller never
      // needs to know or supply a port.
      const socket = await socksConnect(host, 80);
      this.#attach(socket, false);
    } finally {
      // Briefly held after the attempt as well, so a failure does not turn
      // into an immediate retry from the next caller in line.
      // Held for a while after the attempt. Dialling the same onion again
      // moments later never helps: either the circuit is still building, or
      // it just failed and will fail again. Five seconds was short enough
      // that overlapping callers still stacked up.
      setTimeout(() => this.#dialling.delete(host), 30000).unref?.();
    }
  }

  /**
   * Hang up on somebody.
   *
   * Used when two people stop having anything in common. The circuit is not
   * free — a keepalive every twelve seconds, a slot at both ends, and a peer
   * that the dial loop will keep restoring — so a connection nobody has a
   * reason for is worth closing rather than leaving to time out.
   */
  drop(userId: string): boolean {
    let dropped = false;

    for (const [id, peer] of [...this.#peers]) {
      if (peer.info.userId !== userId) continue;
      peer.socket.destroy();
      if (this.#peers.delete(id)) dropped = true;
    }

    if (dropped) this.emit("peers", this.peers());
    return dropped;
  }

  /** Addresses with a dial in flight. */
  #dialling = new Set<string>();

  /**
   * Adopt an already-open socket.
   *
   * The connection is assumed to have been established by something that
   * understands the addressing rules — `connect` for Tor, and eventually a
   * relay. Exposed rather than reached through `connect` so that the onion-only
   * check there stays unconditional: a test-only bypass inside it is exactly
   * the kind of thing that survives into production.
   */
  adopt(socket: Socket, inbound: boolean): void {
    this.#attach(socket, inbound);
  }

  /**
   * Reply to a community list with what we hold.
   *
   * Sends a `have` for anything we already have, and for anything the bridge
   * is willing to accept sight-unseen — an empty id list in that case, which
   * is exactly what tells the peer to send everything.
   */
  #offer(
    id: string,
    socket: Socket,
    communities: string[],
    peerUserId: string | undefined,
  ): void {
    // Guarded as a whole.
    //
    // Everything below calls into the layer above — which store to read, who
    // counts as a member, what is worth syncing — and any of it can fail on
    // a community this device happens to hold in an odd state. Letting that
    // reach the frame handler closes the connection, and since the peer then
    // reconnects and is offered the same list, it closes again. That is a
    // reconnect loop caused entirely by our own bookkeeping.
    try {
      this.#offerAll(id, socket, communities, peerUserId);
    } catch (error) {
      this.emit(
        "log",
        `offer failed for ${peerUserId || "unknown peer"}: ` +
          `${(error as Error).message || String(error)}`,
      );
    }
  }

  #offerAll(
    id: string,
    socket: Socket,
    communities: string[],
    peerUserId: string | undefined,
  ): void {
    const mine = new Set(this.#hooks.communities());
    const peer = this.#peers.get(id);

    for (const community of communities) {
      // Somebody a community has no room for is offered nothing at all — not
      // even an empty `have`, which would otherwise invite them to send theirs
      // and begin an exchange this side has already declined.
      if (!this.#hooks.serves(community, peerUserId)) continue;

      if (mine.has(community)) {
        if (!this.#hooks.reconciles(community)) continue;
        this.#offerOne(id, peer, community);
      } else if (this.#hooks.accepts(community, peerUserId)) {
        this.#send(id, { t: "have", community, ids: [] });
      }
    }
  }

  /**
   * State what this device holds of a community.
   *
   * Two forms of the same statement. The compact one — a watermark per author —
   * is used when the peer said they understand it; otherwise every id held goes
   * on the wire, exactly as it always did. Older peers are not left behind,
   * they are simply talked to in the older, larger way.
   */
  #offerOne(
    id: string,
    peer: { offered?: Map<string, string>; lastSeen: number; caps?: Set<string> } | undefined,
    community: string,
  ): void {
    const summary = peer?.caps?.has("vec")
      ? this.#hooks.summaryFor?.(community)
      : undefined;

    if (summary) {
      // Deduplicated on the summary itself: two watermarks that agree say the
      // same thing, so re-sending one is pure noise.
      if (peer && !this.#worthOffering(peer, community, [summaryShape(summary)])) return;

      this.#send(id, { t: "have", community, ids: [], summary });
      return;
    }

    const ids = this.#hooks.idsFor(community);
    if (peer && !this.#worthOffering(peer, community, ids)) return;

    this.#send(id, { t: "have", community, ids });
  }

  /**
   * What this device can be asked to do.
   *
   * Claimed only where it is true. A build that cannot answer a summary must
   * not say it understands them, or a peer will send one and get silence back —
   * so this is derived from the hooks that are actually wired up rather than
   * declared as a flat constant.
   */
  #capabilities(): string[] {
    return [...CAPABILITIES].filter((cap) =>
      cap !== "vec" || (!!this.#hooks.summaryFor && !!this.#hooks.missingForSummary));
  }

  /**
   * Whether an id set is worth putting on the wire again.
   *
   * An offer is a list of every event held, and it was being sent in full on
   * every announce whether or not anything had changed — which is most of the
   * sync traffic on a quiet connection, and it grows with history rather than
   * with activity.
   *
   * Repeated periodically regardless, because an offer is also how a missed
   * gap is eventually noticed, and a peer that silently failed to keep
   * something would otherwise never be asked again.
   */
  #worthOffering(
    peer: { offered?: Map<string, string>; lastSeen: number },
    community: string,
    ids: string[],
  ): boolean {
    if (!peer.offered) peer.offered = new Map();

    // An empty offer is never suppressed.
    //
    // "I have nothing for this community" is the message that unlocks a first
    // sync — the peer computes everything as missing and sends it. It is also
    // a handful of bytes, so there is nothing to save by withholding it, and
    // withholding it stops a joiner ever being filled in.
    if (ids.length === 0) return true;

    // A cheap summary rather than the list: count plus the last id is enough
    // to notice a change, since ids only ever accumulate.
    const stamp = `${ids.length}:${ids[ids.length - 1] || ""}`;
    const previous = peer.offered.get(community);
    const [was, at] = (previous || "|0").split("|");

    if (was === stamp && Date.now() - Number(at) < REOFFER_EVERY_MS) return false;

    peer.offered.set(community, `${stamp}|${Date.now()}`);
    return true;
  }

  #attach(socket: Socket, inbound: boolean): void {
    const id = `p${++this.#seq}`;
    // Deliberately not the socket's remote address. Inbound Tor connections
    // arrive from the local Tor daemon, so it would read 127.0.0.1 and mean
    // nothing; for outbound it would be the SOCKS proxy. The peer identifies
    // itself by user id in `hello`.
    const address = inbound ? "inbound" : "outbound";
    const info: PeerInfo = { id, address, inbound };

    // Nagle's algorithm holds a small write back for up to 40ms hoping to
    // coalesce it with the next one. That is exactly wrong here: a voice
    // segment and a ring are both small, both complete, and both want to
    // leave now. Tor already costs a few hundred milliseconds — there is no
    // room in the budget for the kernel adding more on purpose.
    socket.setNoDelay(true);

    this.#peers.set(id, { socket, info, lastSeen: Date.now() });
    this.emit("peers", this.peers());
    this.#startHeartbeat();

    const reader = new FrameReader();

    socket.on("data", (chunk) => {
      // Any traffic counts as proof of life, not just a pong — a peer sending
      // us a busy stream of messages should never be judged idle.
      const seen = this.#peers.get(id);
      if (seen) seen.lastSeen = Date.now();

      this.#throttleIn(id, chunk.length);

      try {
        reader.push(chunk, (msg) => this.#handle(id, socket, msg));
      } catch (error) {
        // A peer that cannot frame correctly is either broken or hostile;
        // either way there is nothing useful to do with the rest of the
        // stream, and continuing risks acting on garbage.
        //
        // The message matters: a fault in our own handling reaches here too,
        // and closing the connection makes it look like the peer's fault. A
        // reconnect loop with no explanation is what that produces.
        this.emit(
          "log",
          `peer ${address} dropped: ${(error as Error).message || String(error)}`,
        );
        socket.destroy();
      }
    });

    const drop = () => {
      // Half-received transfers from this peer are worthless and would
      // otherwise sit in memory until the app closed.
      for (const key of [...this.#incoming.keys()]) {
        if (key.startsWith(`${id}:`)) this.#incoming.delete(key);
      }

      // A transfer this peer was in the middle of. Waiting out the timeout
      // would be waiting on a socket that is already gone.
      for (const [key, want] of this.#wants) {
        if (want.peerId === id) this.#askNext(key);
      }

      // Timers outlive the socket unless they are cancelled here, and a
      // resume firing against a destroyed peer is a leak that only shows up
      // as a slow drift in handle count over a long session.
      const going = this.#peers.get(id);
      if (going?.resume) clearTimeout(going.resume);
      if (going?.draining) clearTimeout(going.draining);

      if (!this.#peers.delete(id)) return;
      this.emit("peers", this.peers());
      this.emit("log", `peer ${address} disconnected`);
    };

    socket.on("close", drop);
    socket.on("error", drop);

    this.#send(id, {
      t: "hello",
      userId: this.#userId,
      communities: this.#hooks.communities(),
      caps: this.#capabilities(),
      ...(this.#device ? { device: this.#device } : {}),
    });

    // Declared immediately, so a peer never spends a round of pushes sending
    // things this device has already decided it does not want.
    if (this.#focus) {
      this.#send(id, { t: "focus", communities: this.#focus });
    }
  }

  /**
   * Messages that are only answered once we know who is asking.
   *
   * Every access decision above this layer is made about a *user id* — whether
   * they are in the community, whether the community has room for them,
   * whether a file may be handed over. `servesPeer` answers "yes" for a peer it
   * cannot name, on the reasoning that the greeting has not arrived yet and
   * refusing would break first contact.
   *
   * That reasoning holds for the moment between connecting and greeting, and
   * not for a peer that simply never greets. One that opens a socket and goes
   * straight to `want` was, until this, handed the file: not identified, so not
   * judged, so served. The same held for `have`, which answers with the id set
   * of a community, and for `give`, which puts events into a log.
   *
   * The protocol already guarantees this costs nothing: `hello` is the first
   * frame either side enqueues, and a stream is ordered, so an honest peer is
   * always named before it asks for anything.
   */
  static #NEEDS_IDENTITY = new Set([
    "have", "give", "push", "want", "blob", "noblob", "announce", "ack", "refuse",
  ]);

  #handle(id: string, socket: Socket, msg: Wire): void {
    const peer = this.#peers.get(id);
    if (!peer) return;

    if (!peer.info.userId && Transport.#NEEDS_IDENTITY.has(msg.t)) {
      this.emit(
        "log",
        `ignored "${msg.t}" from a peer that has not said who it is`,
      );
      return;
    }

    switch (msg.t) {
      case "hello": {
        peer.info.userId = msg.userId;
        peer.info.device = msg.device;
        peer.caps = new Set(msg.caps ?? []);

        // Two devices that dial each other at the same time end up with two
        // sockets between them, and everything after that is doubled: two
        // handshakes, two full reconciliations, every message sent twice —
        // and a two-node cycle for audio to bounce around.
        //
        // Both ends have to choose the same survivor without negotiating, so
        // the rule is fixed: keep the connection dialled by whichever user id
        // sorts lower. Each side reaches that conclusion independently and
        // closes the same socket.
        //
        // ## Why the device has to be part of the test
        //
        // A user id is not one machine any more. Somebody with a desktop and a
        // phone signed into the same account has two devices with *the same*
        // user id, and both of them dial their friends — being displaced from
        // the account address stops a device being reached, never stops it
        // reaching out. So a friend saw two connections claiming to be the
        // same person and collapsed them, every time, killing whichever one
        // lost the coin toss.
        //
        // The dropped device redials, is collapsed again, and repeats: its
        // messages sit in the outbox, its presence flaps, and from both ends it
        // reads as a bad connection rather than as a rule doing this on
        // purpose. Two sockets to two machines are not a duplicate — they are
        // two peers who happen to be one person.
        //
        // Compared with `?? ""` on both sides so a peer that predates the field
        // behaves exactly as before: two anonymous devices still collapse,
        // which is the old rule, and is right for the old single-device case
        // it was written for.
        const twin = [...this.#peers].find(
          ([otherId, other]) =>
            otherId !== id &&
            other.info.userId === msg.userId &&
            (other.info.device ?? "") === (msg.device ?? ""),
        );

        if (twin) {
          const keepInbound = this.#userId > msg.userId;
          const loser = peer.info.inbound === keepInbound ? twin[1] : peer;

          // Removed before the socket closes, so the peer list never briefly
          // shows this person twice and then once. Anything watching for
          // changes would otherwise see a departure that never happened.
          const loserId = loser === peer ? id : twin[0];
          this.#peers.delete(loserId);

          this.emit("log", `collapsed duplicate connection to ${msg.userId}`);
          loser.socket.destroy();

          if (loser === peer) break;
        }

        this.emit("peers", this.peers());
        this.emit("log", `peer ${peer.info.address} is ${msg.userId}`);

        this.#offer(id, socket, msg.communities, peer.info.userId);
        break;
      }

      case "announce": {
        this.#offer(id, socket, msg.communities, peer.info.userId);
        break;
      }

      case "focus": {
        peer.wants = new Set(msg.communities);
        break;
      }

      case "ping": {
        this.#learn(peer, msg.userId);
        this.#send(id, { t: "pong", userId: this.#userId });
        break;
      }

      case "pong":
        // Arriving at all is most of the point, and `lastSeen` was already
        // updated by the data handler — but the id is worth taking too.
        this.#learn(peer, msg.userId);

        if (peer.pingedAt) {
          const sample = Date.now() - peer.pingedAt;
          // Smoothed, because a single sample over Tor swings wildly and a
          // number that jumps between 400ms and 3s tells nobody anything.
          peer.info.rtt = peer.info.rtt
            ? Math.round(peer.info.rtt * 0.7 + sample * 0.3)
            : sample;
          peer.pingedAt = undefined;
          this.emit("peers", this.peers());
        }
        break;

      case "have": {
        if (!this.#hooks.serves(msg.community, peer.info.userId)) {
          const why = this.#hooks.refusal?.(msg.community, peer.info.userId);
          if (why) this.#send(id, { t: "refuse", community: msg.community, reason: why });
          break;
        }

        // A summary answers the same question as an id list, so the only
        // difference here is which one arrived.
        const missing = msg.summary && this.#hooks.missingForSummary
          ? this.#hooks.missingForSummary(msg.community, msg.summary)
          : this.#hooks.missingFor(msg.community, new Set(msg.ids));

        // Anything already handed over on this connection is not sent again.
        //
        // A peer that declines to keep an event never lists it, so it looks
        // missing on every pass — and the whole batch around it goes out with
        // it. That is what turns a converged pair into a connection that
        // re-sends its history indefinitely.
        if (!peer.sent) peer.sent = new Set();
        const fresh = missing.filter((e) => !peer.sent!.has(e.id));

        if (fresh.length < missing.length) {
          this.emit(
            "log",
            `held back ${missing.length - fresh.length} event(s) already sent to ${peer.info.address}`,
          );
        }

        for (const e of fresh) {
          if (peer.sent.size >= SENT_MEMORY) break;
          peer.sent.add(e.id);
        }

        this.#sendEvents(id, "give", msg.community, fresh);

        // Their id list also tells us what *we* lack, but we cannot ask for
        // specific events without knowing they exist. Sending ours back closes
        // the loop — each side ends up offering what the other is short of.
        // The `inbound` guard stops that bouncing forever.
        //
        // Answered even for a community this device is not actively syncing:
        // the peer asked, so they are the one who wants it, and refusing here
        // would leave them unable to catch up from us.
        if (peer.info.inbound) {
          // Through the same path every other offer takes.
          //
          // This used to build and send the reply directly, which meant it
          // skipped the "has this changed since last time" check that all the
          // other offers go through — so a converged pair sent each other a
          // list of every event id they hold, in full, on every reconciliation
          // round, forever. On a large community that is the single biggest
          // thing an idle connection spends, and it is spent over Tor.
          //
          // Suppression is safe precisely because it is conditional on having
          // already said the same thing recently: if the list has not changed,
          // the peer already has it.
          this.#offerOne(id, peer, msg.community);
        }
        break;
      }

      case "signal": {
        // Relayed only to the addressed peer. With a direct connection per
        // peer this is a straight local dispatch; it becomes forwarding once
        // there are peers we can only reach through someone else.
        if (msg.to === this.#userId) {
          this.emit("signal", msg.from, msg.data);
        }
        break;
      }

      case "audio": {
        // Loop suppression, and it has to happen here rather than at the far
        // end of the pipe.
        //
        // Relaying to every other peer amplifies without bound the moment the
        // mesh contains a cycle — three people connected to each other, or
        // even two who dialled each other at the same time and ended up with
        // two sockets. Each copy arriving is relayed again, and the count
        // doubles per hop. It saturates the stream within seconds, and because
        // audio shares that stream with everything else, message sync and
        // presence stop dead behind it. That is the "worked for a minute then
        // everything froze" failure, and it needed a voice call to start it.
        //
        // Sequence numbers alone could not fix this: the check has to reject a
        // frame *before* it is passed on, not merely avoid playing it twice.
        const key = `${msg.from}:${msg.channel}:${msg.seq}`;
        if (this.#seenAudio.has(key)) break;

        this.#seenAudio.add(key);
        this.#seenAudioOrder.push(key);
        if (this.#seenAudioOrder.length > AUDIO_MEMORY) {
          this.#seenAudio.delete(this.#seenAudioOrder.shift()!);
        }

        // Never relay our own voice back into the room. If a frame we
        // originated has reached us, it has already been everywhere it needs
        // to go, and passing it on again is how one utterance becomes several.
        if (msg.from === this.#userId) break;

        this.emit("audio", msg.channel, msg.from, msg.seq, msg.frame);

        // Relayed onward so a call works without every participant being
        // directly connected.
        for (const [otherId] of this.#peers) {
          if (otherId === id) continue;
          this.#send(otherId, msg);
        }
        break;
      }

      case "want": {
        if (!this.#hooks.serves(msg.community, peer.info.userId)) break;

        // Never back to whoever gave it to us.
        //
        // A peer that sent a file has it by definition, so a request for it
        // from that same peer is a mistake on their side — a stale retry, or a
        // second client of theirs — and answering costs the whole file again
        // in the direction it just came from. This is where the megabytes went
        // for somebody who had uploaded nothing at all.
        const source = this.#blobFrom.get(`${msg.community}:${msg.blob}`);
        if (source && source === peer.info.userId) {
          this.#send(id, { t: "noblob", community: msg.community, blob: msg.blob });
          this.emit("log", `refused to send ${msg.blob.slice(0, 12)} back to its source`);
          break;
        }

        const data = this.#hooks.blobFor(msg.community, msg.blob);

        if (!data) {
          this.#send(id, { t: "noblob", community: msg.community, blob: msg.blob });
          break;
        }

        // Chunked so a large file does not occupy the stream in one
        // uninterruptible write. The connection is ordered and shared with
        // messages, so anything sent as a single frame blocks everything
        // behind it for as long as the transfer takes.
        const total = Math.max(1, Math.ceil(data.length / BLOB_CHUNK));
        for (let index = 0; index < total; index++) {
          const slice = data.subarray(index * BLOB_CHUNK, (index + 1) * BLOB_CHUNK);
          this.#send(id, {
            t: "blob",
            community: msg.community,
            blob: msg.blob,
            index,
            total,
            data: slice.toString("base64"),
          });
        }
        break;
      }

      case "noblob": {
        // This peer does not have it. Someone else may — and now that requests
        // go to one peer at a time, this is the signal to try the next one
        // rather than a shrug.
        const key = `${msg.community}:${msg.blob}`;
        const want = this.#wants.get(key);
        if (want && want.peerId === id) this.#askNext(key);
        break;
      }

      case "blob": {
        const key = `${id}:${msg.community}:${msg.blob}`;

        if (msg.index < 0 || msg.index >= msg.total) break;

        let pending = this.#incoming.get(key);
        if (!pending || pending.total !== msg.total) {
          // Filled rather than left sparse. `new Array(n)` produces holes, and
          // the array methods that would check for completeness — `some`,
          // `every`, `forEach` — skip holes entirely, so an empty buffer
          // reported itself as finished and reassembly ran on nothing.
          pending = {
            chunks: new Array<Buffer | undefined>(msg.total).fill(undefined),
            have: 0,
            total: msg.total,
          };
          this.#incoming.set(key, pending);
        }

        // Counted rather than rescanned, which also makes a repeated chunk
        // harmless instead of a way to appear complete early.
        if (pending.chunks[msg.index] === undefined) pending.have++;
        pending.chunks[msg.index] = Buffer.from(msg.data, "base64");

        if (pending.have < pending.total) break;

        this.#incoming.delete(key);
        this.#settleWant(msg.community, msg.blob);

        // Remembered so this file is never sent back the way it came.
        if (peer.info.userId) {
          this.#blobFrom.set(`${msg.community}:${msg.blob}`, peer.info.userId);
          if (this.#blobFrom.size > BLOB_SOURCE_MEMORY) {
            const oldest = this.#blobFrom.keys().next().value;
            if (oldest !== undefined) this.#blobFrom.delete(oldest);
          }
        }

        // Verification happens above this layer, against the id: the hooks
        // discard anything whose hash does not match what was asked for.
        this.#hooks.blobDone(msg.community, msg.blob, Buffer.concat(pending.chunks as Buffer[]));
        break;
      }

      case "give":
      case "push": {
        // Refused in both directions. Not serving them keeps them from
        // reading; not accepting from them keeps them out of everybody else's
        // copy, which is what stops an intruder appearing in the conversation
        // at all.
        if (!this.#hooks.serves(msg.community, peer.info.userId)) {
          // Told rather than dropped. The sender is holding an obligation that
          // will otherwise be retried forever, and the reason is the only
          // thing that lets them repair the state that produced it.
          const why = this.#hooks.refusal?.(msg.community, peer.info.userId);
          if (why) this.#send(id, { t: "refuse", community: msg.community, reason: why });
          break;
        }

        const result = this.#hooks.merge(msg.community, msg.events);

        // Read defensively. A hook returning the wrong shape used to reach the
        // catch around the frame reader, which treats an exception as a
        // malformed peer and destroys the connection — so a mistake on *this*
        // side presented as the other end being broken, mid-transfer, with a
        // log line blaming them. Storing the events is the important half;
        // failing to send a receipt is worth degrading to rather than dying.
        const accepted = typeof result === "number" ? result : (result?.accepted ?? 0);
        const held = Array.isArray(result?.held) ? result.held : [];

        if (accepted > 0) {
          this.emit("log", `${accepted} event(s) from ${peer.info.address}`);
          this.emit("merged", msg.community, accepted);
        }

        // Receipt for everything now held, including what was already here.
        // Sent even when nothing was accepted: "I already have all of that" is
        // exactly what a sender retrying an old obligation needs to hear.
        if (held.length) {
          this.#send(id, { t: "ack", community: msg.community, ids: held });
        }
        break;
      }

      case "ack": {
        if (!peer.info.userId) break;
        this.emit("delivered", peer.info.userId, msg.community, msg.ids);
        break;
      }

      case "refuse": {
        if (!peer.info.userId) break;
        this.emit("refused", peer.info.userId, msg.community, String(msg.reason || ""));
        break;
      }
    }
  }

  /**
   * Send freshly-authored events to every connected peer.
   */
  /**
   * Send freshly-authored events to every peer who wants them.
   *
   * `urgent` names people the message is *about* — mentioned by name, or
   * everyone in the channel. They are sent it whether or not they are
   * following the community, because the whole point of addressing somebody
   * is that they find out without having to go looking.
   *
   * Only the author can decide this, and only at the moment of writing: the
   * payload is encrypted by the time it reaches the wire, so no relay can
   * work out who a message concerns, and none of them gets to override
   * somebody's preferences on a guess.
   */
  broadcast(community: string, events: SignedEvent[], urgent?: string[]): void {
    const calling = urgent && urgent.length ? new Set(urgent) : undefined;

    for (const peer of this.#peers.values()) {
      const following = !peer.wants || peer.wants.has(community);
      const addressed = !!(calling && peer.info.userId && calling.has(peer.info.userId));

      // Skipped for anyone not following and not addressed. They would only
      // discard it, and over Tor the bytes are the expensive part rather than
      // the discarding.
      if (!following && !addressed) continue;
      this.#sendEvents(peer.info.id, "push", community, events, addressed);
    }
  }

  /**
   * Tell every peer which communities we want live writes for.
   *
   * Sent whenever the set changes, and again on connect — a peer that joins
   * later has to be told, and one that reconnects has forgotten.
   */
  declareFocus(communities: string[]): void {
    this.#focus = communities;
    for (const [id] of this.#peers) {
      this.#send(id, { t: "focus", communities });
    }
  }

  #focus: string[] | undefined;

  /**
   * Write events out in frames small enough to survive the far end.
   *
   * Splitting on both a count and a byte total because either alone is
   * insufficient: sixty-four chat lines is nothing, while sixty-four
   * attachments is far past what the receiver will accept.
   */
  #sendEvents(
    id: string,
    t: "give" | "push",
    community: string,
    events: SignedEvent[],
    urgent?: boolean,
  ): void {
    let batch: SignedEvent[] = [];
    let bytes = 0;

    const flush = () => {
      if (batch.length === 0) return;
      // Queued rather than written. A peer that has gone away mid-write is
      // normal, not exceptional, and the queue handles that too.
      //
      // A push carrying something addressed to this person is marked urgent,
      // which is what lets a mention overtake a file transfer already in
      // flight rather than waiting behind it.
      this.#enqueue(
        id,
        urgent && t === "push" ? "urgent" : t,
        encode({ t, community, events: batch }),
      );
      batch = [];
      bytes = 0;
    };

    for (const event of events) {
      const size = JSON.stringify(event).length;

      // Flushed before adding, so a single oversized event still goes out on
      // its own rather than being silently skipped.
      if (batch.length > 0 && (batch.length >= GIVE_EVENTS || bytes + size > GIVE_BYTES)) {
        flush();
      }

      batch.push(event);
      bytes += size;
    }

    flush();
  }

  /**
   * Ask for a blob — one peer at a time.
   *
   * This used to broadcast, on the reasoning that the author may be offline
   * and any member who has the file can serve it. That reasoning is right and
   * the implementation was wrong: *every* peer who had it answered, so a file
   * requested once arrived once per peer. In a three-person server a ten
   * megabyte video was thirty megabytes across the wire, twenty of which were
   * thrown away on arrival because the first copy had already completed it.
   *
   * Worse, it shares one ordered TCP stream with voice. A duplicate transfer
   * is not merely wasted bandwidth; it is head-of-line delay in front of every
   * audio frame behind it, which is heard as a call breaking up.
   *
   * So: ask one, wait, and move on to the next if nothing comes. The
   * availability property is kept — every peer is still a candidate — and the
   * cost stops multiplying by the size of the room.
   */
  requestBlob(community: string, blob: string): void {
    const key = `${community}:${blob}`;
    if (this.#wants.has(key)) return;   // already chasing this one

    this.#wants.set(key, { community, blob, tried: new Set(), peerId: undefined });
    this.#askNext(key);
  }

  /**
   * Who each held blob came from.
   *
   * Bounded and lossy on purpose: forgetting an entry costs at worst one
   * redundant transfer, so this does not need to be durable or complete.
   */
  #blobFrom = new Map<string, string>();

  /** Requests in flight, so the same file is never chased twice at once. */
  #wants = new Map<string, {
    community: string;
    blob: string;
    tried: Set<string>;
    peerId: string | undefined;
    timer?: ReturnType<typeof setTimeout>;
  }>();

  /**
   * Try the next peer that has not been asked yet.
   *
   * Gives up when everyone has been asked, rather than looping: a file nobody
   * holds is a fact, and asking forever would be a slow broadcast with extra
   * steps.
   */
  #askNext(key: string): void {
    const want = this.#wants.get(key);
    if (!want) return;

    if (want.timer) clearTimeout(want.timer);

    const candidate = [...this.#peers.keys()].find((id) => !want.tried.has(id));
    if (!candidate) {
      this.#wants.delete(key);
      this.emit("log", `nobody has ${want.blob.slice(0, 12)}`);
      return;
    }

    want.tried.add(candidate);
    want.peerId = candidate;
    this.#send(candidate, { t: "want", community: want.community, blob: want.blob });

    // A peer that says nothing at all is the case this guards. `noblob` moves
    // on immediately; silence needs a clock, and it has to be long enough that
    // a large file arriving slowly over Tor is not mistaken for silence.
    want.timer = setTimeout(() => {
      const live = this.#wants.get(key);
      if (!live || live.peerId !== candidate) return;
      this.emit("log", `no answer for ${want.blob.slice(0, 12)}, trying another peer`);
      this.#askNext(key);
    }, WANT_TIMEOUT_MS);
    want.timer.unref?.();
  }

  /** Stop chasing a blob, however it ended. */
  #settleWant(community: string, blob: string): void {
    const key = `${community}:${blob}`;
    const want = this.#wants.get(key);
    if (!want) return;
    if (want.timer) clearTimeout(want.timer);
    this.#wants.delete(key);
  }

  /**
   * Send a signalling payload to a peer by user id.
   *
   * Returns false when that peer is not connected, which the caller needs:
   * a silently dropped offer looks identical to a call that never answers.
   */
  signal(to: string, data: unknown): boolean {
    let sent = false;

    for (const [id, { info }] of this.#peers) {
      if (info.userId !== to) continue;
      this.#send(id, { t: "signal", to, from: this.#userId, data });
      sent = true;
    }

    return sent;
  }

  /**
   * Tell every connected peer which communities we now hold.
   *
   * Called after joining or creating one. Without it a community added after
   * the connection was established never syncs.
   */
  announce(): void {
    const communities = this.#hooks.communities();
    const frame = encode({ t: "announce", communities });

    for (const [id, { info }] of this.#peers) {
      this.#enqueue(id, "announce", frame);

      // Our own id sets go out too, not just the list.
      //
      // Announcing alone was one-directional in the wrong direction: the
      // *receiver* replied with `have`, and the announcer — typically the side
      // that just joined and holds nothing — had nothing to give back, so the
      // peer never learned to send anything. A joined server stayed
      // permanently empty.
      // Through the same check as every other offer. Writing directly here
      // meant announcing re-sent a full id list per community every time,
      // which is most of what an idle connection was spending.
      const peer = this.#peers.get(id);

      for (const community of communities) {
        if (!this.#hooks.serves(community, info.userId)) continue;
        if (!this.#hooks.reconciles(community)) continue;

        this.#offerOne(id, peer, community);
      }
    }
  }

  /**
   * Send an audio frame to every connected peer.
   *
   * Fire and forget: a frame that cannot be written now is worthless a moment
   * later, so there is no queue and no retry.
   */
  sendAudio(channel: string, seq: number, frame: string): void {
    // Remembered as already seen, before it goes anywhere.
    //
    // Frames are relayed onward so a call works without everyone being
    // directly connected, and the relay skips only the peer a frame arrived
    // from. In a mesh of three that is enough for our own audio to come back
    // to us the long way round — and because nothing had recorded it on the
    // way out, it looked new: accepted, and relayed onward *again*. The frame
    // then made a second lap of the room.
    //
    // The playback side already refused to play our own voice, so this was
    // never audible directly. It was bandwidth, and it was bandwidth on the
    // same stream as the call.
    const key = `${this.#userId}:${channel}:${seq}`;
    if (!this.#seenAudio.has(key)) {
      this.#seenAudio.add(key);
      this.#seenAudioOrder.push(key);
      if (this.#seenAudioOrder.length > AUDIO_MEMORY) {
        this.#seenAudio.delete(this.#seenAudioOrder.shift()!);
      }
    }

    for (const [id] of this.#peers) {
      this.#send(id, { t: "audio", channel, from: this.#userId, seq, frame });
    }
  }

  stop(): void {
    if (this.#heartbeat) { clearInterval(this.#heartbeat); this.#heartbeat = undefined; }
    for (const { socket } of this.#peers.values()) socket.destroy();
    this.#peers.clear();
    this.#server?.close();
    this.#server = undefined;
  }

  /**
   * Ping every peer, and drop the ones that have stopped answering.
   *
   * Dropping is what matters. A peer removed from the list is one the dial
   * loop will try again, so a dead circuit becomes a reconnect instead of a
   * permanent, invisible disconnection.
   */
  /**
   * Note who a peer is, if we did not already know.
   *
   * Never overwrites: an established identity changing mid-connection would
   * be a peer claiming to be someone else, and the first claim is the one the
   * rest of the session was built on.
   */
  #learn(peer: { info: PeerInfo }, userId: string | undefined): void {
    if (!userId || peer.info.userId) return;
    peer.info.userId = userId;
    this.emit("peers", this.peers());
  }

  /**
   * Limits and focus.
   *
   * `bytesPerSecond` of zero means no limit, which is the default: shaping
   * traffic is only useful to somebody who knows their connection cannot take
   * the full rate, and guessing on their behalf makes everything slower for
   * no reason.
   */
  configure(options: {
    bytesPerSecond?: number;
    inboundBytesPerSecond?: number;
    callFocus?: boolean;
  }): void {
    if (options.bytesPerSecond !== undefined) {
      this.#rateOut = Math.max(0, options.bytesPerSecond);
    }
    if (options.inboundBytesPerSecond !== undefined) {
      this.#rateIn = Math.max(0, options.inboundBytesPerSecond);

      // Lifting the limit has to wake anything currently held down, or a peer
      // paused a moment ago stays paused until it sends again — which it
      // cannot, because we stopped reading.
      if (this.#rateIn === 0) {
        for (const peer of this.#peers.values()) {
          if (peer.resume) { clearTimeout(peer.resume); peer.resume = undefined; }
          peer.socket.resume();
        }
      }
    }
    if (options.callFocus !== undefined) this.#callFocus = options.callFocus;
  }

  /**
   * Slow down what a peer is sending us.
   *
   * There is no way to ask politely — the protocol has no "send less" message,
   * and adding one would only work against clients that chose to obey it. What
   * does work is refusing to read: TCP's receive window closes as our buffer
   * fills, and the sender's kernel stops transmitting on its own. So the limit
   * is enforced by pausing the socket, one peer at a time, and the peer needs
   * no cooperation and no awareness of it.
   *
   * The cost is real and worth stating: a paused socket holds back *everything*
   * from that peer, including voice. That is why the default is no limit and
   * why the setting warns about it — unlike the outbound scheduler, this cannot
   * let urgent frames past, because at this point they are undifferentiated
   * bytes that have not been parsed yet.
   */
  #throttleIn(id: string, bytes: number): void {
    if (this.#rateIn <= 0) return;

    const peer = this.#peers.get(id);
    if (!peer || peer.resume) return;

    const now = Date.now();
    const elapsed = (now - (peer.inRefilled ?? now)) / 1000;
    peer.inRefilled = now;
    peer.inTokens = Math.min(this.#rateIn, (peer.inTokens ?? this.#rateIn) + elapsed * this.#rateIn);
    peer.inTokens -= bytes;

    if (peer.inTokens >= 0) return;

    // Over budget: stop reading for exactly as long as the overdraft is worth,
    // capped so a huge burst cannot wedge the connection for minutes.
    const wait = Math.min(2000, Math.max(20, (-peer.inTokens / this.#rateIn) * 1000));
    peer.socket.pause();
    peer.resume = setTimeout(() => {
      const live = this.#peers.get(id);
      if (!live) return;
      live.resume = undefined;
      live.inTokens = 0;
      live.inRefilled = Date.now();
      live.socket.resume();
    }, wait);
  }

  /**
   * Queue a frame behind anything more urgent.
   *
   * Writing straight to the socket would put a two-megabyte transfer in front
   * of the next voice packet, and no amount of prioritising elsewhere can undo
   * that once the bytes are in the kernel's buffer. So everything goes through
   * here, and the buckets are drained in order.
   */
  #enqueue(id: string, type: string, frame: Buffer): void {
    const peer = this.#peers.get(id);
    if (!peer) return;

    if (!peer.queue) {
      peer.queue = Array.from({ length: PRIORITIES }, () => [] as Buffer[]);
      peer.queued = 0;
      peer.tokens = 0;
      peer.refilled = Date.now();
    }

    // During a call, background work waits. Not dropped and not disconnected:
    // a peer that stops being told about reconciliation still delivers
    // messages, still reports who has joined, and picks up where it left off
    // the moment the call ends.
    //
    // Two exceptions, and they are the same exception twice: a request that
    // was allowed out must be allowed to be answered. `want` was already
    // exempt, but the reply to it was not — so during a call a client could
    // ask for a profile picture and the answer was silently discarded at the
    // other end. Worse, `noblob` went with it, so "I do not have that" never
    // arrived either and the request simply hung, marked as in flight and
    // never retried. That is why faces went missing mid-call and stayed
    // missing.
    //
    // The size test is what keeps this from undoing call focus. A whole small
    // file arrives in one frame; a large one is cut into chunks that are each
    // bigger than this, so an avatar gets through and a video does not.
    const level = PRIORITY[type] ?? 4;
    if (this.#callFocus && level >= 4) {
      const answering =
        type === "want" ||
        type === "noblob" ||
        (type === "blob" && frame.length <= SMALL_BLOB_BYTES);

      if (!answering) return;
    }

    // Voice is the one thing worth discarding rather than delaying. A frame
    // that has waited behind a backlog is not late audio, it is a glitch —
    // and unlike a message, nobody benefits from it arriving eventually.
    if (type === "audio" && (peer.queued ?? 0) > AUDIO_BACKLOG) {
      WIRE_STATS.dropped.frames++;
      WIRE_STATS.dropped.bytes += frame.length;
      return;
    }

    // A backlog that cannot be cleared is a memory leak with extra steps. The
    // lowest-priority bucket is shed first, since it is background by
    // definition and will be offered again anyway.
    if ((peer.queued ?? 0) + frame.length > DEFAULT_BACKLOG_BYTES) {
      for (let i = PRIORITIES - 1; i > level; i--) {
        while (peer.queue[i].length && (peer.queued ?? 0) + frame.length > DEFAULT_BACKLOG_BYTES) {
          const dropped = peer.queue[i].shift()!;
          peer.queued = (peer.queued ?? 0) - dropped.length;
        }
      }
      if ((peer.queued ?? 0) + frame.length > DEFAULT_BACKLOG_BYTES) return;
    }

    peer.queue[level].push(frame);
    peer.queued = (peer.queued ?? 0) + frame.length;

    this.#drain(id);
  }

  /**
   * Send one wire message to one peer.
   *
   * Every outbound frame goes through here rather than to a socket directly,
   * because ordering is only meaningful if nothing can bypass it.
   */
  #send(id: string, msg: Wire): void {
    this.#enqueue(id, msg.t, encode(msg));
  }

  /** Write whatever the rate allows, most urgent first. */
  #drain(id: string): void {
    const peer = this.#peers.get(id);
    if (!peer || !peer.queue) return;

    const now = Date.now();

    if (this.#rateOut > 0) {
      const elapsed = (now - (peer.refilled ?? now)) / 1000;
      peer.refilled = now;
      // A second's worth of burst, so a limit smooths traffic rather than
      // stuttering it.
      peer.tokens = Math.min(this.#rateOut, (peer.tokens ?? 0) + elapsed * this.#rateOut);
    }

    for (let level = 0; level < PRIORITIES; level++) {
      const bucket = peer.queue[level];

      while (bucket.length) {
        const frame = bucket[0];

        if (this.#rateOut > 0 && (peer.tokens ?? 0) < frame.length) {
          // Out of allowance. Come back when more has accrued.
          const wait = Math.max(20, ((frame.length - (peer.tokens ?? 0)) / this.#rateOut) * 1000);
          if (!peer.draining) {
            peer.draining = setTimeout(() => {
              const live = this.#peers.get(id);
              if (live) live.draining = undefined;
              this.#drain(id);
            }, Math.min(wait, 1000));
            peer.draining.unref?.();
          }
          return;
        }

        bucket.shift();
        peer.queued = (peer.queued ?? 0) - frame.length;
        if (this.#rateOut > 0) peer.tokens = (peer.tokens ?? 0) - frame.length;

        peer.socket.write(frame, () => undefined);
      }
    }
  }

  #startHeartbeat(): void {
    if (this.#heartbeat) return;

    this.#heartbeat = setInterval(() => {
      const now = Date.now();
      const frame = encode({ t: "ping", userId: this.#userId });

      for (const [id, peer] of [...this.#peers]) {
        if (now - peer.lastSeen > this.#idleTimeout) {
          this.emit("log", `peer ${peer.info.address} went quiet — dropping`);
          peer.socket.destroy();
          if (this.#peers.delete(id)) this.emit("peers", this.peers());
          continue;
        }

        // Only timed when nothing is outstanding, so a reply to an earlier
        // ping is never attributed to a later one.
        if (!peer.pingedAt) peer.pingedAt = now;
        peer.socket.write(frame, () => undefined);
      }

      if (this.#peers.size === 0 && this.#heartbeat) {
        clearInterval(this.#heartbeat);
        this.#heartbeat = undefined;
      }
    }, this.#pingEvery);

    // Never a reason to hold the process open on its own.
    this.#heartbeat.unref?.();
  }
}

