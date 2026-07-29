import type { SignedEvent } from "./events";

/**
 * Summarising a log by watermark instead of by listing every id.
 *
 * ## The problem this solves
 *
 * Reconciliation asks "what do you have?" and treats anything missing from the
 * answer as something to send. That makes absence mean exactly one thing:
 * *never received*. There is no way to say *had it, discarded it* — so nothing
 * can ever be forgotten, because a peer who still holds it will helpfully send
 * it back. A log can only grow.
 *
 * It is also expensive in the other direction. The answer is every id this
 * device holds, and ids are hashes, so the list is incompressible and grows
 * with history. In a busy community that exchange is measured in megabytes,
 * repeated on every connection.
 *
 * ## The idea
 *
 * Each author numbers their own events: 1, 2, 3. A log can then be described
 * as "I have alice up to 412" rather than by naming four hundred hashes. That
 * is a *watermark*, and a watermark says nothing about whether alice's #5 is
 * still on disk — so it can be thrown away and the claim remains true.
 *
 * One author is one device here: importing an identity is destructive, so
 * nobody writes two chains at once. That assumption is what makes a single
 * counter per author sound, and it is worth stating because it is the thing
 * that would break if accounts ever spanned devices.
 *
 * ## What about everything already written?
 *
 * Events written before this existed have no number, and cannot be given one:
 * an event's id is the hash of its contents and its signature covers that
 * hash, so adding a field to an old event invalidates it. There is no
 * migration that could work, by construction — not for want of trying.
 *
 * So they keep the old treatment: listed by id, exactly as before. The
 * important part is that this set is *finite and closed*. No new events join
 * it, so the expensive path stops growing the moment a peer upgrades, and
 * shrinks as old history ages out.
 */

/** What a device holds, in the smallest form that is still honest. */
export interface Summary {
  /**
   * Per author, the highest sequence number below which everything is
   * accounted for — held, or deliberately dropped.
   *
   * "Accounted for" rather than "held" is the whole point. A peer is told not
   * to bother sending these, whether or not they are still on disk.
   */
  vector: Record<string, number>;

  /**
   * Ids held that the vector does not cover.
   *
   * Three kinds live here: events written before sequence numbers existed,
   * events sitting above a gap — if #7 arrived but #6 never did, the watermark
   * stops at 5 and #7 has to be named explicitly or it would be sent again on
   * every exchange — and every event of an author whose chain has forked.
   */
  extra: string[];

  /**
   * Per author, the id of the event sitting exactly at their watermark.
   *
   * ## The assumption this exists to check
   *
   * A watermark means "I have everything from this author up to N". That is
   * only a statement about *this device's* numbering, and it is sound exactly
   * as long as one author is one chain.
   *
   * Linking a device broke that. Two devices holding one account both write as
   * the same author, and each numbers from what it holds — so a desktop and a
   * phone that are both used while apart mint their own #1, #2, #3. When they
   * meet, the phone says "I have you up to 3" and the desktop believes it,
   * skips its own first three messages, and they are lost to the phone
   * permanently. Not delayed — never sent, because every later exchange makes
   * the same claim. It is silent on both screens, and it is exactly the shape
   * of "things another client never picks up while it was offline".
   *
   * One hash per author is enough to catch it: if the peer's event at N is not
   * the one we have at N, the two chains are not the same chain, and the
   * watermark for that author cannot be trusted. See `missingFrom`.
   *
   * Optional, so a peer that does not send one is treated exactly as before.
   */
  tips?: Record<string, string>;
}

/**
 * How much of an author's chain has been deliberately discarded.
 *
 * Persisted by the store. Without it, forgetting is self-defeating: the
 * watermark is derived from what is held, so dropping the oldest events would
 * lower the watermark and invite a peer to send them back.
 */
export type Floors = Record<string, number>;

/** The sequence number an event carries, if it has one. */
function seqOf(event: SignedEvent): number | undefined {
  const value = (event as { seq?: unknown }).seq;
  return typeof value === "number" && value > 0 ? value : undefined;
}

/**
 * Describe a log.
 *
 * `floors` names what has been dropped on purpose; anything else is worked out
 * from the events themselves.
 */
export function summarise(
  events: readonly SignedEvent[],
  floors: Floors = {},
): Summary {
  // Sequence numbers held, per author.
  const held = new Map<string, Set<number>>();
  const extra: string[] = [];
  const numbered = new Map<string, Map<number, string>>();

  /**
   * Numbers where this author has two different events, per author.
   *
   * Proof that the chain was written from more than one place, which is what
   * linking a device makes possible. At an ambiguous number a watermark means
   * nothing, so the watermark stops *below the first one* and everything from
   * there up is named by id — the treatment events from before numbering
   * already get.
   *
   * Stopping at the first collision rather than abandoning the author entirely
   * matters for the index log, which is both the one most likely to fork (both
   * devices write to it constantly) and the one synced most often. A fork at
   * message five thousand should cost five ids, not five thousand.
   */
  const ambiguous = new Map<string, Set<number>>();

  for (const event of events) {
    const seq = seqOf(event);

    if (seq === undefined) {
      // From before numbering. Named individually, forever.
      extra.push(event.id);
      continue;
    }

    let seen = held.get(event.author);
    if (!seen) { seen = new Set(); held.set(event.author, seen); }
    seen.add(seq);

    let byId = numbered.get(event.author);
    if (!byId) { byId = new Map(); numbered.set(event.author, byId); }

    const already = byId.get(seq);

    if (already === undefined) {
      byId.set(seq, event.id);
      continue;
    }

    if (already === event.id) continue;

    let clashes = ambiguous.get(event.author);
    if (!clashes) { clashes = new Set(); ambiguous.set(event.author, clashes); }
    clashes.add(seq);
  }

  const vector: Record<string, number> = {};
  const tips: Record<string, string> = {};

  // Every author mentioned by either source. A floor with nothing held still
  // has to be reported, or the events it stands for would come back.
  const authors = new Set<string>([...held.keys(), ...Object.keys(floors)]);

  for (const author of authors) {
    const seen = held.get(author) ?? new Set<number>();
    const clashes = ambiguous.get(author);
    const floor = floors[author] ?? 0;

    // Walk up from the floor for as long as the chain is unbroken *and* every
    // number on the way means exactly one event.
    let mark = floor;
    while (seen.has(mark + 1) && !clashes?.has(mark + 1)) mark++;

    vector[author] = mark;

    const byId = numbered.get(author);
    if (!byId) continue;

    // What the peer can check the watermark against. Unambiguous by
    // construction: the walk above stopped before the first number that is not.
    const tip = byId.get(mark);
    if (tip) tips[author] = tip;
  }

  // Everything the watermarks do not cover, named. One pass over the events
  // rather than over `numbered`, because `numbered` keeps one id per number
  // and a collision is precisely the case where that is not all of them.
  for (const event of events) {
    const seq = seqOf(event);
    if (seq === undefined) continue;         // already named above
    if (seq > (vector[event.author] ?? 0)) extra.push(event.id);
  }

  return { vector, extra, tips };
}

/**
 * What a peer is missing, given their summary.
 *
 * Deliberately generous at the edges: an event that *might* be missing is
 * sent. Sending something twice costs bandwidth; not sending it costs a
 * message, and the two are not comparable.
 */
export function missingFrom(
  events: readonly SignedEvent[],
  summary: Summary,
): SignedEvent[] {
  const covered = summary.vector ?? {};
  const known = new Set(summary.extra ?? []);
  const tips = summary.tips ?? {};

  /**
   * Authors whose watermark provably does not mean what it says.
   *
   * Their claim is "everything from this author up to N". We hold an event at
   * N and it is not the one they named — so their 1..N and our 1..N are
   * different events, and skipping ours on the strength of that number would
   * lose every one of them. This is the case neither side can see locally: two
   * devices that were used apart each hold one clean chain, and the collision
   * only exists in the comparison.
   */
  const contradicted = new Set<string>();

  /**
   * Numbers where *our* copy holds two different events, per author.
   *
   * The other half of the same fault, and the half that repairs it. Once a
   * device holds both chains, its own numbering is ambiguous at those points —
   * so a peer's watermark cannot speak for them, however clean the peer's copy
   * looks, and those events are offered regardless of it.
   *
   * Only those. Numbers that mean one event are still covered by the
   * watermark, which is what keeps a repaired pair from re-offering the whole
   * shared prefix on every pass.
   */
  const ambiguous = new Map<string, Set<number>>();
  const seenSeq = new Map<string, Map<number, string>>();

  for (const event of events) {
    const seq = seqOf(event);
    if (seq === undefined) continue;

    let byId = seenSeq.get(event.author);
    if (!byId) { byId = new Map(); seenSeq.set(event.author, byId); }

    const already = byId.get(seq);

    if (already === undefined) byId.set(seq, event.id);
    else if (already !== event.id) {
      let clashes = ambiguous.get(event.author);
      if (!clashes) { clashes = new Set(); ambiguous.set(event.author, clashes); }
      clashes.add(seq);
    }

    const theirs = tips[event.author];
    if (theirs && seq === covered[event.author] && theirs !== event.id) {
      contradicted.add(event.author);
    }
  }

  return events.filter((event) => {
    if (known.has(event.id)) return false;

    const seq = seqOf(event);
    // No number: the only thing that can be said about it is whether they
    // named it.
    if (seq === undefined) return true;

    if (contradicted.has(event.author)) return true;

    if (seq > (covered[event.author] ?? 0)) return true;

    return ambiguous.get(event.author)?.has(seq) ?? false;
  });
}

/**
 * The next sequence number for an author, given what is held.
 *
 * Counts from the highest known rather than from the number held, so a device
 * that has dropped old history still numbers its next event correctly.
 */
export function nextSeq(
  events: readonly SignedEvent[],
  author: string,
  floors: Floors = {},
): number {
  let highest = floors[author] ?? 0;

  for (const event of events) {
    if (event.author !== author) continue;
    const seq = seqOf(event);
    if (seq !== undefined && seq > highest) highest = seq;
  }

  return highest + 1;
}

/**
 * How far each author's history could be dropped without breaking the summary.
 *
 * Everything at or below a watermark is expressible as a floor, so it can go.
 * This does not decide whether it *should* — that is a retention policy, and
 * it belongs with the people who know how much disk they want to spend.
 */
export function droppableUpTo(summary: Summary): Floors {
  return { ...summary.vector };
}

/**
 * Whether two summaries agree about everything.
 *
 * Used to skip an exchange entirely: if a peer's summary matches the one they
 * were last sent, there is nothing new to say.
 */
export function sameSummary(a: Summary, b: Summary): boolean {
  const av = a.vector ?? {};
  const bv = b.vector ?? {};

  const keys = new Set([...Object.keys(av), ...Object.keys(bv)]);
  for (const key of keys) {
    if ((av[key] ?? 0) !== (bv[key] ?? 0)) return false;
  }

  const ax = [...(a.extra ?? [])].sort();
  const bx = [...(b.extra ?? [])].sort();
  if (ax.length !== bx.length) return false;
  for (let i = 0; i < ax.length; i++) if (ax[i] !== bx[i]) return false;

  return true;
}

/**
 * Roughly how many bytes a summary costs on the wire.
 *
 * The reason this exists at all is size, so it is worth being able to measure
 * rather than assert.
 */
export function summarySize(summary: Summary): number {
  const vector = Object.keys(summary.vector ?? {}).length * 40;
  const extra = (summary.extra ?? []).length * 66;
  const tips = Object.keys(summary.tips ?? {}).length * 66;
  return vector + extra + tips;
}
