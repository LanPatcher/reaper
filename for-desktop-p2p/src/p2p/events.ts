import { createHash } from "node:crypto";

import type { Identity } from "./identity";
import { signDigest, userIdFromPublicKey, verifyDigest } from "./identity";

/**
 * The signed event model.
 *
 * Every change to the world — a message, a channel, a nickname, a join — is an
 * event signed by the device that produced it. Replaying the log in causal
 * order reconstructs state. There is no other source of truth.
 */

export interface EventContent {
  /** What kind of change this is, e.g. "message.send" */
  type: string;

  /** Community this belongs to */
  community: string;

  /** Author's user id */
  author: string;

  /**
   * Author's public key.
   *
   * Repeated on every event so verification needs no member directory: a peer
   * can check a signature the moment an event arrives, before it knows
   * anything about who sent it. That matters during sync, where events turn up
   * from people this device has never seen.
   *
   * It looks wasteful and effectively isn't — the value is byte-identical
   * across every event from one author, so the compressor in the log layer
   * collapses it to nearly nothing.
   */
  authorKey: string;

  /**
   * Ids of the events the author had already seen.
   *
   * These edges are what make ordering agree between peers without a clock
   * anyone trusts.
   */
  parents: string[];

  /** Lamport clock: one greater than the highest parent's */
  clock: number;

  /**
   * Wall-clock time, milliseconds.
   *
   * Advisory only — for display. Never used for ordering, because a peer with
   * a wrong clock (or a dishonest one) would otherwise be able to reorder
   * everyone's history.
   */
  timestamp: number;

  /**
   * This author's own counter, from one.
   *
   * Lets a whole log be described as "alice up to 412" instead of by listing
   * every hash — which is what makes a log summarisable in constant space, and
   * therefore what makes old history droppable at all. See `vector.ts`.
   *
   * Optional because it cannot be added retrospectively: an event's id is the
   * hash of its contents and its signature covers that hash, so numbering an
   * old event would invalidate it. Events written before this existed simply
   * do not have one, and are handled by id as they always were.
   */
  seq?: number;

  /** Type-specific body */
  payload: unknown;
}

export interface SignedEvent extends EventContent {
  /** Hash of the canonical content */
  id: string;

  /** Author's signature over `id` */
  signature: string;
}

/**
 * Deterministic JSON.
 *
 * Two peers must derive byte-identical bytes from the same event or their
 * hashes disagree and the DAG falls apart. `JSON.stringify` preserves
 * insertion order, which differs between a locally-constructed object and one
 * that came back from `JSON.parse`, so key order is forced here.
 *
 * Rejects the values JSON cannot round-trip rather than silently mangling
 * them: `undefined` disappears, and NaN and Infinity become null, either of
 * which would produce an event that fails to verify on arrival with no useful
 * explanation.
 */
export function canonicalise(value: unknown): string {
  if (value === null) return "null";

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`cannot canonicalise non-finite number: ${value}`);
    }
    return JSON.stringify(value);
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalise).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`)
      .join(",")}}`;
  }

  throw new Error(`cannot canonicalise value of type ${typeof value}`);
}

/**
 * Hash an event's content. This is its id.
 */
export function digestContent(content: EventContent): Buffer {
  return createHash("sha256").update(canonicalise(content), "utf8").digest();
}

/**
 * Build and sign an event.
 *
 * `heads` are the current tips of the local DAG — the events this device has
 * that nothing else references yet.
 */
export function createEvent(
  input: {
    type: string;
    community: string;
    payload: unknown;
    timestamp?: number;
    /** This author's next counter value. Omitted only by tests and old data. */
    seq?: number;
  },
  identity: Identity,
  heads: SignedEvent[] = [],
): SignedEvent {
  const content: EventContent = {
    type: input.type,
    community: input.community,
    author: identity.userId,
    authorKey: identity.publicKey,
    // Left off entirely when absent rather than written as undefined: the
    // canonical form skips undefined values, so an event without a counter
    // hashes exactly as it did before this field existed. Old and new clients
    // agree on the digest either way.
    ...(input.seq === undefined ? {} : { seq: input.seq }),
    // Sorted so the same set of heads always hashes the same way, whatever
    // order they were discovered in.
    parents: heads.map((head) => head.id).sort(),
    clock: heads.reduce((max, head) => Math.max(max, head.clock), 0) + 1,
    timestamp: input.timestamp ?? Date.now(),
    payload: input.payload,
  };

  const digest = digestContent(content);

  return {
    ...content,
    id: digest.toString("hex"),
    signature: signDigest(digest, identity),
  };
}

/**
 * Whether an event is authentic and internally consistent.
 *
 * Checks three things, and all three matter:
 *
 *  - the id genuinely is the hash of the content, so nothing was altered in
 *    flight and then re-labelled;
 *  - the signature verifies against the key embedded in the event;
 *  - the author id derives from that same key, which stops someone signing
 *    with their own key while claiming to be somebody else.
 */
export function verifyEvent(event: SignedEvent): boolean {
  const { id, signature, ...content } = event;

  let digest: Buffer;
  try {
    digest = digestContent(content as EventContent);
  } catch {
    return false;
  }

  if (digest.toString("hex") !== id) return false;

  if (userIdFromPublicKey(event.authorKey) !== event.author) return false;

  return verifyDigest(digest, signature, event.authorKey);
}

/**
 * Tips of the DAG — events nothing else claims as a parent.
 */
export function findHeads(events: SignedEvent[]): SignedEvent[] {
  const referenced = new Set<string>();
  for (const event of events) {
    for (const parent of event.parents) referenced.add(parent);
  }

  return events.filter((event) => !referenced.has(event.id));
}

/**
 * Order events so every peer independently reaches the same sequence.
 *
 * Causal order first: an event never appears before something it descends
 * from. Concurrent events — neither ancestor of the other, which is what two
 * people typing at once produces — are broken by Lamport clock and then by id.
 * The id tiebreak is arbitrary but *identical everywhere*, which is the only
 * property that matters; without it two peers would render the same history in
 * different orders.
 *
 * Parents that aren't present are treated as satisfied. During sync a device
 * routinely holds a fragment of history, and refusing to order anything until
 * the DAG is whole would mean showing nothing at all.
 */
export function causalSort(events: SignedEvent[]): SignedEvent[] {
  const byId = new Map(events.map((event) => [event.id, event]));

  const pending = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const event of events) {
    const known = event.parents.filter((parent) => byId.has(parent));
    pending.set(event.id, known.length);

    for (const parent of known) {
      const list = children.get(parent);
      if (list) list.push(event.id);
      else children.set(parent, [event.id]);
    }
  }

  const compare = (a: SignedEvent, b: SignedEvent) =>
    a.clock - b.clock || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  // Ready set kept sorted on every insertion. A heap would be asymptotically
  // better; at the scale this runs — one community's history, replayed at
  // startup — the constant factor of an array wins and the code stays legible.
  const ready = events.filter((event) => pending.get(event.id) === 0).sort(compare);
  const ordered: SignedEvent[] = [];

  while (ready.length > 0) {
    const next = ready.shift()!;
    ordered.push(next);

    for (const childId of children.get(next.id) ?? []) {
      const remaining = pending.get(childId)! - 1;
      pending.set(childId, remaining);

      if (remaining === 0) {
        const child = byId.get(childId)!;
        // Binary search for the insertion point rather than re-sorting.
        let lo = 0;
        let hi = ready.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (compare(ready[mid], child) < 0) lo = mid + 1;
          else hi = mid;
        }
        ready.splice(lo, 0, child);
      }
    }
  }

  // A cycle is impossible with honest peers, since parents are hashes of
  // events that already existed. It is reachable with a malicious one, so
  // whatever is left over is appended deterministically rather than dropped.
  if (ordered.length !== events.length) {
    const seen = new Set(ordered.map((event) => event.id));
    ordered.push(...events.filter((e) => !seen.has(e.id)).sort(compare));
  }

  return ordered;
}

/**
 * Merge incoming events into a local set, discarding anything that fails
 * verification, and return the result in causal order.
 */
export function mergeEvents(
  local: SignedEvent[],
  incoming: SignedEvent[],
): { events: SignedEvent[]; accepted: SignedEvent[]; rejected: SignedEvent[] } {
  const byId = new Map(local.map((event) => [event.id, event]));

  const accepted: SignedEvent[] = [];
  const rejected: SignedEvent[] = [];

  for (const event of incoming) {
    const existing = byId.get(event.id);

    if (existing) {
      // Already have this id. Usually a genuine duplicate — peers re-send
      // freely and that is normal and cheap to ignore.
      //
      // But an id is a hash of content, so an event carrying a known id and
      // *different* content is a forgery attempt: someone editing a message
      // and hoping the id gets it waved through. Keeping our copy already
      // defeats it, so this is not a hole. It is reported rather than skipped
      // because a peer doing this should be visible — silently dropping it
      // makes an attacker indistinguishable from a well-behaved node.
      //
      // Compared on canonical form rather than by verifying the signature,
      // which would mean re-verifying every duplicate in every sync round.
      if (canonicalise(existing) !== canonicalise(event)) {
        rejected.push(event);
      }

      continue;
    }

    if (!verifyEvent(event)) {
      rejected.push(event);
      continue;
    }

    byId.set(event.id, event);
    accepted.push(event);
  }

  return {
    events: causalSort([...byId.values()]),
    accepted,
    rejected,
  };
}
