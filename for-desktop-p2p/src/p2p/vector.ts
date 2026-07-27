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
   * Two kinds live here: events written before sequence numbers existed, and
   * events sitting above a gap — if #7 arrived but #6 never did, the watermark
   * stops at 5 and #7 has to be named explicitly or it would be sent again on
   * every exchange.
   */
  extra: string[];
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
    byId.set(seq, event.id);
  }

  const vector: Record<string, number> = {};

  // Every author mentioned by either source. A floor with nothing held still
  // has to be reported, or the events it stands for would come back.
  const authors = new Set<string>([...held.keys(), ...Object.keys(floors)]);

  for (const author of authors) {
    const seen = held.get(author) ?? new Set<number>();
    const floor = floors[author] ?? 0;

    // Walk up from the floor for as long as the chain is unbroken.
    let mark = floor;
    while (seen.has(mark + 1)) mark++;

    vector[author] = mark;

    // Anything above the gap is held but not covered, so it is named.
    const byId = numbered.get(author);
    if (!byId) continue;
    for (const [seq, id] of byId) {
      if (seq > mark) extra.push(id);
    }
  }

  return { vector, extra };
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

  return events.filter((event) => {
    if (known.has(event.id)) return false;

    const seq = seqOf(event);
    // No number: the only thing that can be said about it is whether they
    // named it.
    if (seq === undefined) return true;

    return seq > (covered[event.author] ?? 0);
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
  return vector + extra;
}
