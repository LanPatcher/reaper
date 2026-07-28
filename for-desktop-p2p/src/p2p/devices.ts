import { randomBytes } from "node:crypto";

/**
 * Which of your devices is allowed to answer at your address.
 *
 * ## Why this has to exist
 *
 * An onion address is a keypair. There is exactly one for an identity, and
 * two devices holding a copy of it both publish a descriptor for the same
 * address — so the directory keeps whichever published most recently and
 * peers reach one of them, unpredictably, changing over time. Messages arrive
 * at whichever device won the last race. Nothing errors; it simply becomes
 * unreliable in a way that looks like a flaky network.
 *
 * Tor offers no way to arbitrate that, so the arbitration is here: at any
 * moment exactly one device *holds* the address, and the others stay quiet.
 *
 * ## How holding works
 *
 * A claim is an event in the private index log:
 *
 *     { device, name, n, at }
 *
 * `n` is monotonic. The highest `n` wins, and its device is the holder. Taking
 * over is appending `n + 1`; nothing is revoked, because a device that has
 * been displaced may be offline and cannot be asked to give anything up.
 *
 * ## The tie
 *
 * Two devices that cannot see each other can both append `n + 1`. Without a
 * rule they would each believe they hold the address, which is exactly the
 * situation this exists to prevent — and worse than having no rule at all,
 * because both would think it had been resolved.
 *
 * So ties are broken by wall clock, and then by device id, which is arbitrary
 * but *identical on both sides*. Being right matters less here than both
 * devices reaching the same answer from the same events.
 */

export interface Claim {
  /** The install that made it. Not the user, and not the machine. */
  device: string;

  /** What to call it in a sentence like "signed in on Ray's phone". */
  name: string;

  /** Monotonic. Higher wins. */
  n: number;

  at: number;
}

/** The event type these are stored as, in the private index log. */
export const CLAIM = "device.claim";

/** Where one of your devices can be reached, whatever network it is on. */
export const SYNC = "device.sync";

/**
 * A device of yours, and the onion address it answers sync on.
 *
 * Not the account's address. That one is published by whichever device is
 * holding, so dialling it reaches the device that least needs reaching. Each
 * device publishes a second, private service purely so its siblings can find
 * it — which needs no port forwarding, works between continents, and is the
 * only reason a phone on mobile data can take the account over from a desktop
 * that is still switched on at home.
 */
export interface SyncAddress {
  device: string;
  name: string;
  onion: string;
  at: number;
}

export function isSyncAddress(value: unknown): value is SyncAddress {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<SyncAddress>;

  return typeof entry.device === "string" && entry.device.length > 0 &&
    typeof entry.onion === "string" &&
    /^[a-z2-7]{56}\.onion$/.test(entry.onion);
}

/**
 * The current address for each device, newest wins.
 *
 * An address changes when a device is reinstalled, so the roster is a log of
 * announcements rather than a set — and reading it means taking the latest per
 * device rather than all of them. Dialling a stale one costs a timeout, which
 * on Tor is expensive enough to be worth avoiding.
 */
export function roster(entries: readonly SyncAddress[]): SyncAddress[] {
  const latest = new Map<string, SyncAddress>();

  for (const entry of entries) {
    if (!isSyncAddress(entry)) continue;

    const held = latest.get(entry.device);
    if (!held || entry.at > held.at) latest.set(entry.device, entry);
  }

  return [...latest.values()].sort((a, b) => b.at - a.at);
}

/**
 * Everyone but this device — the ones worth dialling.
 *
 * Deduplicated by *address*, not by device id, and that is the fix for a real
 * complaint: the list showed devices that do not exist.
 *
 * Two ways a phantom gets in. An identity backup records the device it came
 * from under a placeholder id, because the file cannot know the real one — so
 * that entry and the genuine one are two rows for one machine. And a device
 * that regenerates its sync key leaves its old address behind, so the roster
 * accumulates addresses nothing answers at.
 *
 * Keyed by address and keeping the newest, both disappear: a real device is
 * whatever is currently reachable at an address, and an address is the only
 * part of this that is worth dialling.
 */
export function others(
  entries: readonly SyncAddress[],
  device: string,
): SyncAddress[] {
  const mine = new Set(
    roster(entries).filter((entry) => entry.device === device)
      .map((entry) => entry.onion),
  );

  const byAddress = new Map<string, SyncAddress>();

  for (const entry of roster(entries)) {
    if (entry.device === device) continue;

    // This device's own address, recorded under another id — which is exactly
    // what a restored backup produces when it is restored onto the machine it
    // was written on.
    if (mine.has(entry.onion)) continue;

    const held = byAddress.get(entry.onion);
    if (!held || entry.at > held.at) byAddress.set(entry.onion, entry);
  }

  return [...byAddress.values()].sort((a, b) => b.at - a.at);
}

/**
 * Forget an address that no longer answers.
 *
 * A device that has moved republishes, and the old row is then a row that
 * nothing will ever be at. Nothing removes events from a log, so this returns
 * the addresses worth dropping and the caller records a replacement.
 */
export function stale(
  entries: readonly SyncAddress[],
  device: string,
  failing: ReadonlySet<string>,
): SyncAddress[] {
  return others(entries, device).filter((entry) => failing.has(entry.onion));
}

/**
 * A fresh device id.
 *
 * Random rather than derived from anything about the machine. A hardware
 * identifier would be stable across reinstalls, which sounds useful until a
 * restored backup and the machine it was restored from are the same device as
 * far as this is concerned — and then neither can take the address from the
 * other.
 */
export function newDeviceId(): string {
  return randomBytes(16).toString("hex");
}

/** Whether something read out of the log is a usable claim. */
export function isClaim(value: unknown): value is Claim {
  if (!value || typeof value !== "object") return false;
  const claim = value as Partial<Claim>;

  return typeof claim.device === "string" && claim.device.length > 0 &&
    typeof claim.n === "number" && Number.isFinite(claim.n) &&
    typeof claim.at === "number" && Number.isFinite(claim.at);
}

/**
 * Whichever claim wins, or nothing if there are none.
 *
 * The comparison is written out rather than done with a sort so the order of
 * precedence is readable: `n`, then time, then id. All three are needed —
 * dropping any one of them leaves a case where two devices disagree.
 */
export function holder(claims: readonly Claim[]): Claim | undefined {
  let best: Claim | undefined;

  for (const claim of claims) {
    if (!isClaim(claim)) continue;
    if (!best) { best = claim; continue; }

    if (claim.n !== best.n) {
      if (claim.n > best.n) best = claim;
      continue;
    }

    if (claim.at !== best.at) {
      if (claim.at > best.at) best = claim;
      continue;
    }

    // Arbitrary, and deliberately so. What matters is that every device
    // computes the same arbitrary answer.
    if (claim.device > best.device) best = claim;
  }

  return best;
}

/** Whether this device is the one that should be publishing. */
export function holds(claims: readonly Claim[], device: string): boolean {
  const winner = holder(claims);

  // No claims at all means nobody has ever taken the address, which is the
  // state of an account that has only ever run on one device. Publishing is
  // right: refusing would leave a single-device user unreachable, waiting for
  // a hand-off that is never going to happen.
  return !winner || winner.device === device;
}

/**
 * The claim that takes the address for this device.
 *
 * `at` is passed in rather than read from the clock so this can be tested, and
 * so a caller that is replaying a hand-off can be explicit about when it
 * happened.
 */
export function claimFor(
  claims: readonly Claim[],
  device: string,
  name: string,
  at: number = Date.now(),
): Claim {
  const winner = holder(claims);
  return { device, name, n: (winner?.n ?? 0) + 1, at };
}

/**
 * What a device should be told about its own standing.
 *
 * Three states, and the middle one is the whole reason for the type. "Not
 * holding" is not an error and not a disconnection — the account is fine, the
 * history is there, and another device of yours is simply answering the door.
 * Presenting that as a network failure would send people looking for a problem
 * with their connection.
 */
export type Standing =
  /** This device holds the address and may publish. */
  | { state: "holding"; claim?: Claim }
  /** Another of your devices holds it. */
  | { state: "displaced"; by: Claim }
  /** No device has ever claimed it; publishing is right. */
  | { state: "unclaimed" };

export function standing(claims: readonly Claim[], device: string): Standing {
  const winner = holder(claims);
  if (!winner) return { state: "unclaimed" };
  if (winner.device === device) return { state: "holding", claim: winner };
  return { state: "displaced", by: winner };
}
