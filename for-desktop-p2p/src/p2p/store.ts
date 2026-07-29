import { hkdfSync } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  type SignedEvent,
  causalSort,
  createEvent,
  findHeads,
  mergeEvents,
  verifyEvent,
} from "./events";
import type { Identity } from "./identity";
import { compact } from "./compact";
import { EventLog } from "./log";
import {
  droppableUpTo,
  missingFrom,
  nextSeq,
  summarise,
  type Floors,
  type Summary,
} from "./vector";

/**
 * A dropped event, reduced to the three fields that describe a log.
 *
 * Shaped like an event on purpose — `summarise` and `nextSeq` read exactly
 * these fields — but it has no payload, no parents and no signature, so it can
 * never be replayed or handed to a peer by accident.
 */
interface Stub {
  id: string;
  author: string;
  seq: number;
}

/** The bookkeeping a past compaction left behind. */
interface Ledger {
  __pruned?: string[];
  __floors?: Floors;
  __stubs?: [string, string, number][];
}

/**
 * A community's history on this device.
 *
 * Ties the three lower layers together: signed events (`events.ts`), durable
 * compressed storage (`log.ts`), and the device key (`identity.ts`). This is
 * the surface the IPC bridge will expose to the renderer, so it is deliberately
 * small — append, replay, merge.
 *
 * The full event set is held in memory. For a community of this size that is
 * the right call: a hundred thousand messages is a few tens of MB, and every
 * operation here — finding heads, ordering, deduplicating — needs the whole
 * DAG anyway. Paging it out would buy nothing until the history is very large,
 * at which point the fix is dropping old segments, not a more elaborate cache.
 */

/**
 * Derive the at-rest encryption key for a community's log.
 *
 * HKDF from the device private key rather than using it directly. Two reasons,
 * both about blast radius: a key should do one job, and deriving per community
 * means compromising one community's log doesn't hand over the others.
 *
 * Note this protects data at rest on this machine only. It is not the key
 * events are encrypted with in transit — that belongs to the transport layer,
 * and conflating the two would mean re-encrypting the whole log whenever
 * membership changed.
 */
function deriveLogKey(identity: Identity, community: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(identity.privateKey, "base64"),
      Buffer.from(community, "utf8"),
      Buffer.from("stoat-p2p-log-v1", "utf8"),
      32,
    ),
  );
}

export interface CommunityStoreOptions {
  /** Directory for this account's data */
  root: string;

  /** Community id */
  community: string;

  /** This device's identity */
  identity: Identity;

  /**
   * How many people this community holds.
   *
   * Only compaction reads it, and only to answer "would dropping these
   * join/leave events change who is in the room" — a question whose answer
   * depends entirely on whether the room was ever full. Defaulted to ten, and
   * a direct conversation holds two: computing that answer against the wrong
   * capacity is how a pair of events that *did* decide a seat gets collapsed.
   */
  capacity?: number;

  /**
   * Open a payload, for the one caller that has to look inside one.
   *
   * The store itself never does — an event is opaque to it, and that is the
   * right shape. Compaction is the exception: every rule it applies is about a
   * field *inside* a payload, and payloads are sealed. Injected rather than
   * imported so the store keeps no keys and a test can pass identity.
   */
  decrypt?: (payload: unknown) => unknown;
}

export class CommunityStore {
  readonly community: string;

  readonly #identity: Identity;
  /**
   * The log on disk.
   *
   * Not readonly: compaction rewrites the directory and hands back a fresh
   * handle, because the old one has been closed and its file descriptors point
   * at a directory that no longer exists.
   */
  #log: EventLog;
  readonly #dir: string;

  #events: SignedEvent[] = [];
  #ids = new Set<string>();

  /**
   * Ids of events this device deliberately dropped.
   *
   * Reconciliation compares sets of ids, so an event that is simply absent
   * reads as one that was never received — and a peer that still holds it will
   * send it back. Without this ledger, compacting a log would undo itself on
   * the next sync, and a deleted message would return from the dead.
   *
   * Kept as ids alone: small, and enough to answer the only question anybody
   * asks about them.
   */
  #pruned = new Set<string>();

  /**
   * Per author, how much of their history has been dropped on purpose.
   *
   * The counterpart to `#pruned` for the numbered path. A watermark is derived
   * from what is held, so discarding the oldest events would lower it and
   * invite a peer to send them straight back; the floor says "accounted for"
   * about events that are no longer here.
   */
  #floors: Floors = {};

  /**
   * Placeholders for numbered events that were dropped.
   *
   * A watermark is derived from the numbers held, so a hole punched in the
   * middle of an author's chain by compaction would drag the watermark back
   * below it — and the peer that still has the event would send it again, in
   * an endless round of dropping and re-fetching the same thing.
   *
   * These stand in for the missing numbers: enough to keep the arithmetic
   * honest, none of the payload that was the reason for dropping it. They are
   * folded into `#floors` and discarded as soon as a chain closes up beneath
   * them, so this does not grow the way the log it replaced did.
   */
  #stubs: Stub[] = [];

  /**
   * The tips of the DAG, and this author's next number.
   *
   * Both were recomputed from the whole log on *every* append — `findHeads`
   * builds a set of every parent id in the community, and `nextSeq` scans for
   * the highest number this device has spent. So sending one message walked a
   * hundred thousand events twice, and on iOS that walk happens on the thread
   * drawing the window, between pressing enter and the line appearing.
   *
   * Both are cheap to maintain instead. Appending makes the new event the only
   * head, because its parents are exactly the heads it displaced; and its
   * number is one more than the last. A merge can invalidate either — a
   * sibling device writes as the same author, so events of ours can arrive
   * from outside — so a merge simply drops them and the next reader pays once.
   */
  #headCache: SignedEvent[] | undefined;
  #nextSeqCache: number | undefined;

  readonly #capacity: number | undefined;
  readonly #decrypt: ((payload: unknown) => unknown) | undefined;

  constructor(options: CommunityStoreOptions) {
    this.community = options.community;
    this.#identity = options.identity;
    this.#capacity = options.capacity;
    this.#decrypt = options.decrypt;

    this.#dir = join(options.root, "communities", options.community);
    this.#log = new EventLog(
      this.#dir,
      deriveLogKey(options.identity, options.community),
    );
  }

  /**
   * Load history from disk.
   *
   * Events are re-verified on the way in. That looks paranoid for data this
   * device wrote itself, and it is worth the cost anyway: the log is also where
   * events received from peers land, so a bug in the sync path that admitted
   * something unsigned would otherwise become permanent and invisible.
   */
  open(): void {
    const loaded: SignedEvent[] = [];

    // Whatever was worked out about a previous contents of this store.
    this.#headCache = undefined;
    this.#nextSeqCache = undefined;

    try {
      this.#readInto(loaded);
    } catch (error) {
      // The log could not be decrypted.
      //
      // The at-rest key is derived from this device's private key, so this
      // means the identity changed — a lost or replaced key, or data copied
      // from another install. The old contents are unrecoverable by design:
      // there is no server holding a second copy, and the key that could read
      // them is gone.
      //
      // Throwing here took the whole app down before it could even offer a
      // username prompt. The directory is moved aside instead, so the bytes
      // survive if the original key ever turns up, and this community starts
      // empty rather than blocking startup.
      const aside = `${this.#dir}.unreadable-${Date.now()}`;
      try {
        renameSync(this.#dir, aside);
        // Recreate immediately. The log was constructed against this path and
        // keeps using it, so leaving it absent means the next flush fails with
        // ENOENT — which appends survive (they buffer) and close does not.
        mkdirSync(this.#dir, { recursive: true });
        console.warn(
          `[p2p] ${this.community}: log could not be decrypted (${(error as Error).message}). ` +
            `Moved to ${aside} and starting empty.`,
        );
      } catch (moveError) {
        console.error(`[p2p] ${this.community}: log unreadable and unmovable:`, moveError);
      }

      this.#events = [];
      this.#ids.clear();
      this.#pruned.clear();
      this.#floors = {};
      this.#stubs = [];
      return;
    }

    this.#events = causalSort(loaded);
  }

  #readInto(loaded: SignedEvent[]): void {
    for (const raw of this.#log.read()) {
      // The pruned ledger, written by a past compaction. Not an event, and
      // deliberately not shaped like one so it can never be mistaken for
      // something to replay or hand to a peer.
      const record = raw as Ledger;
      if (record.__pruned || record.__floors || record.__stubs) {
        for (const id of record.__pruned ?? []) this.#pruned.add(id);
        for (const [author, mark] of Object.entries(record.__floors ?? {})) {
          if (mark > (this.#floors[author] ?? 0)) this.#floors[author] = mark;
        }
        // Written as tuples rather than objects: there is one per dropped
        // event, and field names would be most of the bytes.
        for (const [id, author, seq] of record.__stubs ?? []) {
          this.#stubs.push({ id, author, seq });
        }
        continue;
      }

      const event = raw as SignedEvent;
      if (!verifyEvent(event)) {
        console.warn(`[p2p] discarding unverifiable stored event ${event?.id}`);
        continue;
      }

      if (this.#ids.has(event.id)) continue;

      this.#ids.add(event.id);
      loaded.push(event);
    }
  }

  /**
   * Append a locally-authored event.
   */
  append(type: string, payload: unknown): SignedEvent {
    // Numbered so this log can be described by watermark rather than by
    // listing every id it holds.
    // Counted over dropped events too. Reusing a number this device has
    // already spent would produce two different events claiming the same
    // place in the chain, and a peer would only ever learn about one.
    const seq =
      this.#nextSeqCache ??
      nextSeq(this.#accounted(), this.#identity.userId, this.#floors);

    const event = createEvent(
      {
        type,
        community: this.community,
        payload,
        seq,
      },
      this.#identity,
      this.heads(),
    );

    // The event just written is the only tip: it names every previous one as a
    // parent, so none of them is a tip any more, and nothing yet names it.
    this.#headCache = [event];
    this.#nextSeqCache = seq + 1;

    this.#ids.add(event.id);

    // Appended, not re-sorted.
    //
    // `createEvent` gives this event a Lamport clock one greater than the
    // highest of the current heads — and the highest clock in a DAG is always
    // held by a head, since anything with a child has a child with a greater
    // one. So this event's clock is strictly greater than every clock already
    // here, which is precisely the condition under which `causalSort` would
    // place it last: it is causally after everything it descends from, and it
    // wins the comparator against everything it does not.
    //
    // The old line sorted the entire history on every message sent. On a log
    // of any size that is a visible pause between pressing enter and the line
    // appearing, and on iOS it is the frame budget for the animation that is
    // supposed to be happening at the same moment.
    this.#events.push(event);
    this.#log.append(event);

    return event;
  }

  /**
   * Take in events from a peer, keeping the ones that verify.
   */
  merge(incoming: SignedEvent[]): { accepted: SignedEvent[]; rejected: SignedEvent[] } {
    const result = mergeEvents(this.#events, incoming);

    for (const event of result.accepted) {
      this.#ids.add(event.id);
      this.#log.append(event);
    }

    // Anything arriving can add a tip or bury one, and — since a sibling device
    // writes under the same author — can carry numbers this device thought it
    // had not spent. Both are worked out again on demand rather than here, so
    // a merge that nobody reads after costs nothing.
    if (result.accepted.length) {
      this.#headCache = undefined;
      this.#nextSeqCache = undefined;
    }

    this.#events = result.events;

    // Written out now rather than on the buffer's own schedule.
    //
    // Appends from this device can afford to wait — if they are lost the user
    // knows what they just typed. Events from a peer cannot: losing them means
    // asking for the same history again on the next connection, and a peer
    // that is killed rather than closed would re-download its whole backlog
    // every time. Over Tor that is the single most expensive thing the app
    // can do, and it looked exactly like sync being broken.
    if (result.accepted.length) this.#log.flush();

    return { accepted: result.accepted, rejected: result.rejected };
  }

  /**
   * Every event, in the order every peer agrees on.
   */
  events(): readonly SignedEvent[] {
    return this.#events;
  }

  /**
   * Current tips of the DAG. What a peer needs to work out what we're missing.
   */
  heads(): SignedEvent[] {
    return (this.#headCache ??= findHeads(this.#events));
  }

  /**
   * Whether an event id is already known — the primitive a sync round is
   * built from.
   */
  has(id: string): boolean {
    return this.#ids.has(id);
  }

  /**
   * Events this device holds that the peer does not.
   *
   * Deliberately takes the peer's *full* id set rather than just their heads.
   * Heads alone would be enough if histories only ever diverged at the tip,
   * but after a long partition both sides hold events scattered through the
   * DAG, and a heads-only comparison silently misses them.
   *
   * That makes this O(n) in history size per sync, which is fine at this scale
   * and is the honest starting point. If it ever isn't, the replacement is a
   * bloom filter or a hash tree over segments — not a cleverer use of heads.
   */
  missingFor(peerIds: Set<string>): SignedEvent[] {
    return this.#events.filter((event) => !peerIds.has(event.id));
  }

  /**
   * This log in the smallest honest form: a watermark per author, plus the ids
   * of anything the watermarks do not cover.
   */
  summary(): Summary {
    return summarise(this.#accounted(), this.#floors);
  }

  /**
   * Everything this log can speak for: what is held, plus placeholders for
   * what was deliberately dropped.
   *
   * Only ever used to describe the log — never to answer a peer, since a
   * placeholder is not an event and there is nothing to send.
   */
  #accounted(): readonly SignedEvent[] {
    if (!this.#stubs.length) return this.#events;
    return [...this.#events, ...(this.#stubs as unknown as SignedEvent[])];
  }

  /** What a peer lacks, given their summary. */
  missingForSummary(summary: Summary): SignedEvent[] {
    return missingFrom(this.#events, summary);
  }

  /**
   * Every id this device is finished with, held or dropped.
   *
   * Reconciliation asks "what do you have"; the honest answer includes what
   * was compacted away. Saying otherwise invites a peer to send it back, and
   * the whole point of dropping it was to stop storing it.
   */
  knownIds(): string[] {
    return [...this.#ids, ...this.#pruned];
  }

  /** Bytes on disk. */
  size(): number {
    return this.#log.size();
  }

  /**
   * Drop what the log no longer needs, and rewrite it.
   *
   * The riskiest operation in the store, so it is arranged to fail safely: a
   * fresh log is built beside the old one, read back, and checked against what
   * it was meant to contain. Only then is it swapped in. A crash at any point
   * before the swap leaves the original untouched; a crash during the swap
   * leaves one of the two complete directories in place.
   *
   * Returns what it did, or null when there was nothing worth doing.
   */
  compact(): { removed: number; before: number; after: number } | null {
    // With this community's real capacity and a way to read its payloads.
    // Without either, compaction is deciding what history to throw away from
    // behind a sealed envelope — see `CommunityStoreOptions`.
    const plan = compact(this.#events, this.#capacity, this.#decrypt);
    if (!plan.pruned.length) return null;

    const before = this.#log.size();
    const staging = `${this.#dir}.compacting`;
    const previous = `${this.#dir}.previous`;

    rmSync(staging, { recursive: true, force: true });

    const fresh = new EventLog(staging, deriveLogKey(this.#identity, this.community));
    for (const event of plan.keep) fresh.append(event);

    // Placeholders for the numbered events about to disappear, so the
    // watermarks this log reports do not fall back below them.
    const dropped = new Map(plan.pruned.map((id) => [id, true]));
    const stubs: Stub[] = [...this.#stubs];
    for (const event of this.#events) {
      if (!dropped.has(event.id)) continue;
      const seq = (event as { seq?: number }).seq;
      if (typeof seq === "number" && seq > 0) {
        stubs.push({ id: event.id, author: event.author, seq });
      }
    }

    // Then collapse what can be collapsed. Where a chain is unbroken beneath a
    // watermark, one number says what a list of placeholders was saying — so
    // the bookkeeping shrinks as history closes up, instead of accumulating a
    // permanent line per event ever dropped.
    const floors = droppableUpTo(
      summarise([...plan.keep, ...(stubs as unknown as SignedEvent[])], this.#floors),
    );
    for (const [author, mark] of Object.entries(this.#floors)) {
      if (mark > (floors[author] ?? 0)) floors[author] = mark;
    }
    const kept = stubs.filter((stub) => stub.seq > (floors[stub.author] ?? 0));

    // The ledger rides in the log itself, as an ordinary record. It has to
    // survive restarts for the same reason it exists at all.
    fresh.append({
      __pruned: [...this.#pruned, ...plan.pruned],
      __floors: floors,
      ...(kept.length
        ? { __stubs: kept.map((stub) => [stub.id, stub.author, stub.seq]) }
        : {}),
    });
    fresh.close();

    // Read it back before trusting it. Building a log and assuming it is
    // correct is exactly the assumption that loses a year of conversation.
    const check = new EventLog(staging, deriveLogKey(this.#identity, this.community));
    let recovered = 0;
    try {
      for (const raw of check.read()) {
        const record = raw as Ledger;
        if (record.__pruned || record.__floors || record.__stubs) continue;
        recovered++;
      }
    } catch {
      rmSync(staging, { recursive: true, force: true });
      return null;
    }

    if (recovered !== plan.keep.length) {
      rmSync(staging, { recursive: true, force: true });
      return null;
    }

    // Swap. The old directory is kept until the new one is in place.
    this.#log.close();
    rmSync(previous, { recursive: true, force: true });
    renameSync(this.#dir, previous);
    renameSync(staging, this.#dir);
    rmSync(previous, { recursive: true, force: true });

    // A closed log refuses appends, so without this the first thing anybody
    // said after reclaiming space threw — and the store was unusable until
    // the app was restarted. The directory it points at is the same one; only
    // the contents were replaced underneath it.
    this.#log = new EventLog(this.#dir, deriveLogKey(this.#identity, this.community));

    for (const id of plan.pruned) this.#pruned.add(id);
    this.#floors = floors;
    this.#stubs = kept;
    this.#events = plan.keep;
    this.#ids = new Set(plan.keep.map((e) => e.id));

    // The log is a different set of events now, and both of these described
    // the old one. Dropping the highest-numbered event this device wrote would
    // otherwise have it mint that number a second time.
    this.#headCache = undefined;
    this.#nextSeqCache = undefined;

    return { removed: plan.pruned.length, before, after: this.#log.size() };
  }

  /** Flush and close. */
  close(): void {
    this.#log.close();
  }
}
