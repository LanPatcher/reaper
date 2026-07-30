import type { SignedEvent } from "./events";

/**
 * Which stored events no longer say anything.
 *
 * An append-only log only grows, and most of what accumulates in it is not
 * history — it is the debris of state that has since been overwritten. A
 * profile edited fifty times keeps fifty profiles. A message that was deleted
 * keeps both the message and the note saying it is gone. None of that is ever
 * read again, and all of it is signed, replicated and stored forever.
 *
 * ## Why the delete cannot simply remove the message
 *
 * The obvious fix — drop the `message.send` when the delete arrives — breaks
 * synchronisation, and does so silently.
 *
 * Peers reconcile by comparing *sets of event ids*: "here is what I have",
 * "here is what you are missing". An event that has been removed from a log is
 * indistinguishable from one that log never received. So the next time this
 * device met a peer that still held the message, that peer would helpfully
 * send it back, and the message would return from the dead. Deleting would
 * work until you talked to anybody.
 *
 * The tombstone is what makes deletion expressible at all: it is the only way
 * to say "this is gone" in a language where absence means "not yet seen".
 *
 * ## What can be dropped
 *
 * Something can be dropped when no future replay of the remaining events would
 * differ. That is a stricter test than "looks unused", and it is why this file
 * is a pure function over the event list rather than a set of rules spread
 * through the store: it can be reasoned about, and tested, on its own.
 *
 * Anything dropped must still be *remembered by id* — see `Compaction.pruned`.
 * Forgetting the id would let reconciliation re-fetch the event, which is the
 * resurrection problem again, one level down.
 */

/** What a compaction pass decided. */
export interface Compaction {
  /** Events worth keeping, in their original order. */
  keep: SignedEvent[];

  /**
   * Ids of events dropped.
   *
   * Must be reported as held during reconciliation. A peer that offers one of
   * these has to be told we already have it, or it will send it again — and
   * then the deleted message is back, the superseded profile is back, and the
   * compaction has achieved nothing but churn.
   */
  pruned: string[];
}

/**
 * Types whose payload is a *replacement*, keyed by author.
 *
 * Only the newest matters: a replay applies each in turn and the last one
 * wins, so every earlier one contributes exactly nothing. These are the events
 * that accumulate fastest in an app somebody actually uses — a profile is
 * rewritten every time an avatar, a status or a display name changes.
 */
const LATEST_PER_AUTHOR = new Set(["profile.update", "user.prefs", "voice.prefs"]);

/**
 * Types that replace a previous value keyed by the id inside the payload.
 *
 * A server renamed twenty times has nineteen dead names in its log.
 */
const LATEST_PER_TARGET = new Set([
  "community.rename",
  "community.icon",
  "channel.rename",
  "channel.category",
]);

/**
 * Presence, which is only ever true *now*.
 *
 * These are kept out of the log entirely by the client that writes them, so
 * this is here for logs written by older builds — an hour-long call could
 * leave a thousand of them behind, and they are worth clearing out once.
 */
const EPHEMERAL = new Set(["voice.here"]);

/**
 * Membership, replayed exactly as the bridge replays it.
 *
 * Duplicated deliberately. This is not the authority on who is in a community —
 * the bridge is — but compaction has to answer "would removing these events
 * change the answer", and the only honest way to answer that is to work it out
 * both ways and compare. A rule that merely *looks* safe is how a log loses
 * the event that decided who got the last seat.
 */
function membership(
  events: readonly SignedEvent[],
  cap: number,
  payloads: ReadonlyMap<string, Payload>,
): Set<string> {
  const members = new Set<string>();
  const banned = new Set<string>();
  const evicted = new Set<string>();
  let owner: string | undefined;

  for (const event of events) {
    const payload = payloads.get(event.id) ?? {};

    if (event.type === "community.owner") {
      owner = payload.userId ?? event.author;
      continue;
    }

    if (event.type === "member.leave" || event.type === "group.leave") {
      members.delete(payload.userId ?? event.author);
      continue;
    }

    if (event.type === "member.kick" || event.type === "member.ban") {
      if (owner && event.author === owner && payload.userId) {
        members.delete(payload.userId);
        evicted.add(payload.userId);
        if (event.type === "member.ban") banned.add(payload.userId);
      }
      continue;
    }

    if (event.type === "member.unban" || event.type === "member.readmit") {
      if (owner && event.author === owner && payload.userId) {
        banned.delete(payload.userId);
        evicted.delete(payload.userId);
      }
      continue;
    }

    if (event.type === "member.join") {
      if (!banned.has(event.author)) {
        evicted.delete(event.author);
        if (!members.has(event.author) && members.size < cap) members.add(event.author);
      }
      continue;
    }

    if (banned.has(event.author)) continue;
    if (evicted.has(event.author)) continue;
    if (members.has(event.author)) continue;
    if (members.size < cap) members.add(event.author);
  }

  return members;
}

/** Whether two membership sets agree. */
function same(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * Someone who joined, left, joined and left again leaves a trail.
 *
 * Only the last of those decides anything: the ones before are a person who is
 * no longer where they were. But they cannot simply be deleted, because the
 * window between a join and the matching departure is a window in which that
 * person occupied a seat — and if the room was full at that moment, somebody
 * else was turned away *because of it*. Removing the pair would silently let
 * them in.
 *
 * So the pair is proposed and then checked: membership is recomputed with the
 * events and without them, and the removal is kept only if the answer is
 * identical. Rooms are almost never at capacity, so in practice the churn
 * collapses; when it matters, nothing moves.
 */
function prunableChurn(
  events: readonly SignedEvent[],
  cap: number,
  payloads: ReadonlyMap<string, Payload>,
): Set<string> {
  // The last membership statement each person made about themselves. Anything
  // earlier is a candidate.
  const lastByAuthor = new Map<string, string>();

  for (const event of events) {
    if (event.type !== "member.join" &&
        event.type !== "member.leave" &&
        event.type !== "group.leave") continue;

    // Only self-signed statements. A kick is somebody else's decision and is
    // never collapsed away.
    const payload = payloads.get(event.id) ?? {};
    if (payload.userId && payload.userId !== event.author) continue;

    lastByAuthor.set(event.author, event.id);
  }

  const candidates = new Set<string>();
  for (const event of events) {
    if (event.type !== "member.join" &&
        event.type !== "member.leave" &&
        event.type !== "group.leave") continue;

    const payload = payloads.get(event.id) ?? {};
    if (payload.userId && payload.userId !== event.author) continue;
    if (lastByAuthor.get(event.author) === event.id) continue;

    candidates.add(event.id);
  }

  if (!candidates.size) return candidates;

  const before = membership(events, cap, payloads);
  const after = membership(
    events.filter((e) => !candidates.has(e.id)),
    cap,
    payloads,
  );

  // All or nothing. Narrowing down to the subset that is individually safe
  // would mean a pass per candidate, and the case where it matters — a room
  // that filled up — is exactly the case where keeping everything is right.
  return same(before, after) ? candidates : new Set<string>();
}

/** The payload shape the rules below look into. */
type Payload = {
  id?: string;
  messageId?: string;
  channelId?: string;
  userId?: string;

  /**
   * How long this message is meant to survive, in milliseconds.
   *
   * ## Why it lives in the payload
   *
   * Retention has to travel. A message that the author wanted gone in a day
   * should be gone in a day on every device that holds it, and the only thing
   * that reaches every device is the event itself. Putting it here means it is
   * inside the signature — so it cannot be edited in flight — and inside the
   * encryption, so a relay carrying the event cannot read how long anyone keeps
   * anything.
   *
   * It also means no coordination is needed. Every device computes
   * `timestamp + ttl` from the same signed bytes and reaches the same answer at
   * the same moment, so they expire together without exchanging a word about
   * it. A peer that has been offline for a month simply finds the message
   * already past its time and prunes it on the first pass.
   *
   * Absent or zero means forever, which is what every event written before this
   * existed says by omission — and is the right default for a log that has
   * always kept everything.
   */
  ttl?: number;
};

/** What a caller can say about time and its own retention preference. */
export interface CompactOptions {
  /** Overridable so a test can be at a particular moment. */
  now?: number;

  /**
   * The longest this device keeps *anything*, in milliseconds.
   *
   * Applied on top of whatever each message asks for, never instead of it. The
   * two are a floor and a ceiling on the same value: the author says how long
   * their message should live, the reader says how long they are willing to
   * store anything, and the message goes when the *first* of those runs out.
   *
   * So "keep mine for a year" cannot make somebody else's one-hour message
   * linger on this disk, and "keep nothing over a week" cannot be overridden by
   * a sender who wanted their message kept forever. Neither party can force the
   * other to store something, which is the only arrangement that works when
   * there is no server and the disk belongs to whoever is reading.
   *
   * Zero or absent means no limit of this device's own.
   */
  keepFor?: number;
}

/**
 * When a message is due to go, or undefined if it is not.
 *
 * Read from the author's own clock, which is advisory — it is not used for
 * ordering anywhere, and it is not trusted here either. That is a deliberate
 * limit worth stating: an author who lies about the time can make their own
 * message expire sooner or later than it should on other people's devices. It
 * cannot affect anybody else's messages, it cannot make a device keep something
 * it has decided not to (`keepFor` is applied by the reader, from the reader's
 * clock), and the worst case is a message of theirs that lingers or vanishes.
 *
 * That is a storage policy behaving oddly, not a security control failing, and
 * pretending otherwise would mean inventing a clock nobody has.
 */
function dueAt(
  event: SignedEvent,
  payload: Payload,
  keepFor: number,
): number | undefined {
  const asked = typeof payload.ttl === "number" && payload.ttl > 0
    ? payload.ttl
    : Infinity;

  const allowed = keepFor > 0 ? keepFor : Infinity;
  const life = Math.min(asked, allowed);

  if (!Number.isFinite(life)) return undefined;

  const written = typeof event.timestamp === "number" && event.timestamp > 0
    ? event.timestamp
    : undefined;

  // Nothing to count from. Kept, because the alternative is deleting a message
  // on the strength of a field it does not have.
  if (written === undefined) return undefined;

  return written + life;
}

/**
 * Whether a message has outlived what it or this device asked for.
 *
 * Exported so the interface can show the same answer it is about to act on —
 * a countdown beside a message has to agree with the sweep, and two
 * implementations of "when does this go" would eventually disagree.
 */
export function expiresAt(
  event: SignedEvent,
  payload: unknown,
  keepFor = 0,
): number | undefined {
  if (event.type !== "message.send") return undefined;
  return dueAt(event, (payload ?? {}) as Payload, keepFor);
}

/**
 * Decide what a log can forget.
 *
 * Deliberately conservative. Every rule here has to survive the question "if
 * this event were missing, could any replay reach a different answer?" —
 * anything where the answer is "possibly" is kept, because the cost of keeping
 * a dead event is some bytes and the cost of dropping a live one is a
 * conversation that quietly loses a message.
 */
export function compact(
  events: readonly SignedEvent[],
  capacity: number = 10,
  read: (payload: unknown) => unknown = (payload) => payload,
  options: CompactOptions = {},
): Compaction {
  // Undefined rather than omitted is what a caller with nothing to say looks
  // like once this is reached through an optional field.
  capacity = capacity ?? 10;
  read = read ?? ((payload) => payload);

  const now = options.now ?? Date.now();
  const keepFor = options.keepFor ?? 0;

  const keep: SignedEvent[] = [];
  const pruned: string[] = [];

  // ---- every rule below reads inside a payload, and payloads are sealed ----
  //
  // ## Why this parameter exists
  //
  // This file used to read `event.payload` directly, and on any community with
  // an encryption key that is a sealed envelope — `{ e, n, c, t }` — with none
  // of the fields these rules look for. So `payload.messageId` was undefined,
  // `payload.id` was undefined, `payload.userId` was undefined, and every rule
  // that depends on one of them quietly did nothing:
  //
  //   - **Deleted messages kept their bodies.** That is the headline saving —
  //     "the tombstone is small and the body is the part that was megabytes" —
  //     and it never once happened outside a test.
  //   - **Renames and icons were never deduped**, so a server renamed twenty
  //     times kept twenty names.
  //   - **Membership was computed without kicks or bans**, which is the model
  //     `prunableChurn` checks its own safety against.
  //
  // Nothing failed. Compaction ran, reported a small number of dropped events —
  // the two rules that happen not to read a payload — and looked like it had
  // worked. That is the worst shape a bug can have in the one operation that
  // rewrites history.
  //
  // The default is identity, so a caller with no key (the private index, which
  // is never sealed) and every existing test behave exactly as before.
  const payloads = new Map<string, Payload>();
  for (const event of events) {
    payloads.set(event.id, (read(event.payload) ?? {}) as Payload);
  }

  // ---- first pass: what does the end state look like? ---------------------
  //
  // Walked backwards, so the first time a key is seen is the *last* write to
  // it. Everything after that (in reverse) is superseded.
  const deleted = new Set<string>();
  const seenLatest = new Set<string>();
  const superseded = new Set<string>();

  // Joining and leaving repeatedly, where doing so decided nothing.
  for (const id of prunableChurn(events, capacity, payloads)) superseded.add(id);

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const payload = payloads.get(event.id) ?? {};

    if (event.type === "message.delete" && payload.messageId) {
      deleted.add(payload.messageId);
      continue;
    }

    if (EPHEMERAL.has(event.type)) {
      superseded.add(event.id);
      continue;
    }

    let key: string | undefined;
    if (LATEST_PER_AUTHOR.has(event.type)) key = `${event.type}/${event.author}`;
    else if (LATEST_PER_TARGET.has(event.type) && payload.id) {
      key = `${event.type}/${payload.id}`;
    }

    if (!key) continue;

    if (seenLatest.has(key)) superseded.add(event.id);
    else seenLatest.add(key);
  }

  // ---- second pass: keep what still matters -------------------------------
  for (const event of events) {
    if (superseded.has(event.id)) {
      pruned.push(event.id);
      continue;
    }

    // A deleted message keeps its tombstone and loses its body. The tombstone
    // is small and load-bearing; the body is the part that was megabytes.
    //
    // The `message.send` is dropped rather than blanked because an event
    // cannot be edited: its id is the hash of its contents and its signature
    // covers them, so a rewritten event is simply an invalid one.
    if (event.type === "message.send" && deleted.has(event.id)) {
      pruned.push(event.id);
      continue;
    }

    // Outlived what it asked for, or what this device is willing to keep.
    //
    // Only `message.send`. Everything else in the log is either a fact about
    // who is where — which does not stop being true — or a tombstone, which is
    // the smallest thing here and the one whose absence resurrects something.
    //
    // No tombstone is written for this and none is needed: the id goes into
    // `pruned`, which is what reconciliation reports as held, so a peer that
    // still has the message is told we have it rather than sent it back. Every
    // device reaches the same conclusion from the same signed bytes at the same
    // moment, so nobody has to be told anything.
    if (event.type === "message.send") {
      const due = dueAt(event, payloads.get(event.id) ?? {}, keepFor);
      if (due !== undefined && due <= now) {
        pruned.push(event.id);
        continue;
      }
    }

    keep.push(event);
  }

  return { keep, pruned };
}

/**
 * How much a compaction would save, as a fraction.
 *
 * Used to decide whether rewriting the log is worth the risk of rewriting the
 * log. Below a few per cent it plainly is not: the work is proportional to the
 * whole history, and the failure mode of getting it wrong is losing history
 * that cannot be fetched from anywhere.
 */
export function worthCompacting(events: readonly SignedEvent[]): boolean {
  if (events.length < 200) return false;

  const { pruned } = compact(events);
  return pruned.length >= 50 && pruned.length / events.length >= 0.1;
}
