import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { app, ipcMain } from "electron";

import { log } from "../native/diagnostics";
import type { SignedEvent } from "./events";
import type { Identity } from "./identity";
import { loadOrCreateIdentity } from "./identity";
import { ElectronKeystore } from "./keystore";
import { randomBytes } from "node:crypto";

import { IDENTITY_KDF, packBundle, unpackBundle } from "./backup-bundle";
import { agree, deriveKey, isSealed, open as openSealed, seal } from "./crypto";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";

import { BlobStore, blobId } from "./blobs";
import {
  CLAIM,
  type Claim,
  SYNC,
  type SyncAddress,
  claimFor,
  holder,
  holds,
  isClaim,
  isSyncAddress,
  newDeviceId,
  others,
  roster,
  standing,
} from "./devices";
import { WORTH_SYNCING, type LinkProgress } from "./link";
import {
  openInvite, PairService, PICTURES as PAIR_PICTURES,
  type Invite, type PairResult, type Scope,
} from "./pair";
import { CommunityStore } from "./store";
import {
  TorService,
  checkOnionKey,
  compareVersions,
  readOnionKey,
  socksConnect,
  torVersion,
  writeOnionKey,
  type OnionKey,
} from "./tor";
import { Transport, resetWireStats, wireStats } from "./transport";

/**
 * IPC surface between the P2P core and the renderer.
 *
 * The renderer is a browser context served over `stoat://`. It has no
 * filesystem and no sockets, so everything below the UI lives here in the main
 * process and is reached by message passing.
 *
 * The API is deliberately narrow — open, append, list, merge. Resisting the
 * urge to expose `CommunityStore` wholesale matters: every method added here is
 * one the renderer can be compromised into calling, and the renderer is the
 * part of an Electron app that runs untrusted-ish content.
 *
 * Note what is *not* exposed: the private key. Signing happens on this side of
 * the boundary and only the public identity crosses it.
 */

const CHANNEL = {
  identity: "p2p:identity",
  open: "p2p:open",
  append: "p2p:append",
  events: "p2p:events",
  heads: "p2p:heads",
  merge: "p2p:merge",
  stats: "p2p:stats",
  close: "p2p:close",
  netStart: "p2p:netStart",
  netConnect: "p2p:netConnect",
  netPeers: "p2p:netPeers",
  netInfo: "p2p:netInfo",
  netSignal: "p2p:netSignal",
  netAudio: "p2p:netAudio",
  netAnnounce: "p2p:netAnnounce",
  setKey: "p2p:setKey",
  dmKey: "p2p:dmKey",
  wrapKey: "p2p:wrapKey",
  unwrapKey: "p2p:unwrapKey",
  exportCommunity: "p2p:exportCommunity",
  importCommunity: "p2p:importCommunity",
  netFocus: "p2p:netFocus",
  communities: "p2p:communities",
  netDrop: "p2p:netDrop",
  sharedWith: "p2p:sharedWith",
  compact: "p2p:compact",
  netTune: "p2p:netTune",
  torStatus: "p2p:torStatus",
  netLog: "p2p:netLog",
  netStats: "p2p:netStats",
  netStatsReset: "p2p:netStatsReset",
  deviceInfo: "p2p:deviceInfo",
  deviceName: "p2p:deviceName",
  deviceTakeOver: "p2p:deviceTakeOver",
  linkOpen: "p2p:linkOpen",
  syncDevices: "p2p:syncDevices",
  syncWith: "p2p:syncWith",
  pairInvite: "p2p:pairInvite",
  pairRevoke: "p2p:pairRevoke",
  pairJoin: "p2p:pairJoin",
  pairSync: "p2p:pairSync",
  putBlob: "p2p:putBlob",
  getBlob: "p2p:getBlob",
  hasBlob: "p2p:hasBlob",
  wantBlob: "p2p:wantBlob",
  sweepBlobs: "p2p:sweepBlobs",
  forgetBlob: "p2p:forgetBlob",
} as const;

/** Events pushed to the renderer when the log changes. */
export const P2P_EVENT = "p2p:event";

/** Peer list changed. */
export const P2P_PEERS = "p2p:peers";

/** A requested file finished arriving. */
export const P2P_BLOB = "p2p:blob";

/** Voice signalling from a peer. */
export const P2P_SIGNAL = "p2p:signal";

/** A peer confirmed it now holds these events. */
export const P2P_DELIVERED = "p2p:delivered";

/** A peer refused a community, and said why. */
export const P2P_REFUSED = "p2p:refused";

/** Audio frame from a peer. */
export const P2P_AUDIO = "p2p:audio";

/**
 * Something changed about this device's standing, or about linking.
 *
 * One channel rather than three, because the interface reacts to all of it in
 * the same place: the overlay that says another device is answering, and the
 * linking screen. Splitting them would mean three subscriptions that always
 * have to be kept consistent with each other.
 */
export const P2P_DEVICES = "p2p:devices";

// How the backup file is sealed, and the key derivation behind it, now live in
// `backup-bundle.ts` — where they can be run by a test rather than only by
// Electron. `IDENTITY_KDF` is re-exported through this module's imports so the
// parameters have exactly one home.

let identity: Identity | undefined;
let transport: Transport | undefined;
let tor: TorService | undefined;
/**
 * This device's own view — its friends, servers, groups and preferences.
 *
 * Named here as well as in the renderer because the backup has to reach it
 * from the main process. The leading "@" keeps it out of `isShareable`, so it
 * is never offered to a peer.
 */
/**
 * The oldest Tor this build is happy with.
 *
 * Not "the newest that exists" — that would need a network lookup at startup
 * and would flag people who are perfectly safe. This is the version known to
 * be sound when the app was built; older than it earns a warning.
 */
const TOR_KNOWN_GOOD = "0.4.8.10";

const INDEX = "@index";

/**
 * Where profile pictures are kept.
 *
 * Private, like the index — the leading "@" keeps it out of `isShareable` — and
 * named to match the renderer, which is the only other place it appears.
 */
const AVATARS = "@avatars";

/**
 * Communities worth actively reconciling right now.
 *
 * Set by the renderer: whatever is open, plus anything still waiting for its
 * first sync. Empty means "everything", which is the correct behaviour before
 * the renderer has said otherwise and after it goes away.
 *
 * Direct conversations and groups are never suppressed — they are small, and
 * a friend request arriving is the one thing that cannot wait for the user to
 * go looking for it.
 */
let focused: Set<string> | undefined;

/** Recent transport events, so the UI can explain a connection. */
const netLog: { at: number; line: string }[] = [];

function reconciles(community: string): boolean {
  if (!focused || focused.size === 0) return true;
  if (community.startsWith("dm") || community.startsWith("g")) return true;
  return focused.has(community);
}

const stores = new Map<string, CommunityStore>();

/**
 * Payload encryption keys, by community.
 *
 * Held only in memory. They are re-derived at startup: DM keys from X25519
 * agreement, community keys from the invite the user pasted, which the
 * renderer supplies from its own (device-encrypted) index. Keeping them out of
 * a second on-disk store means there is one place a key can leak from, not two.
 */
const payloadKeys = new Map<string, Buffer>();

/**
 * File bytes, one store per community, kept beside the logs.
 *
 * Encrypted with the same key as that community's payloads. A file is exactly
 * as sensitive as the message that carries it, so it would be odd for one to
 * be protected at rest and the other not.
 */
const blobStores = new Map<string, BlobStore>();

/**
 * How many people a community holds, by kind.
 *
 * Everyone connects to everyone, so the connection count grows with the
 * square of the membership: ten people is forty-five circuits across the
 * group, each with its own keepalive and its own copy of every message.
 */
function capacityOf(community: string): number {
  if (community.startsWith("dm")) return 2;
  if (community.startsWith("g")) return 5;
  return 10;
}

/**
 * Who counts as a member, decided identically on every device.
 *
 * The first N distinct authors in causal order. Causal order is already
 * deterministic — Lamport clock, then event id as the tiebreak — so every
 * client replaying the same log arrives at the same list, in the same
 * sequence, without anyone being asked.
 *
 * That is what turns a capacity limit from advice into something enforced. A
 * modified client can put itself in a full community's log, but it cannot
 * make honest clients agree it belongs there: it sorts after the tenth member
 * on every machine, so every machine ignores it and none of them serve it.
 */
/**
 * The last answer `membersOf` gave, per community.
 *
 * ## Why this is not an optimisation
 *
 * `membersOf` walks a community's whole log. `servesPeer` calls it, and
 * `servesPeer` is asked on every offer, every `have`, every `give` and every
 * `push` — so a single incoming message replayed the entire history of the
 * community it arrived in, and a peer offering twenty communities replayed
 * twenty logs before a byte was exchanged.
 *
 * On a desktop that is the main process wasting power on a thread nobody is
 * drawing from. On iOS the core and the interface are the same JavaScript
 * context, so it is the thread that has to produce the next frame — which is
 * exactly the "the app locks up while syncing" report, and why it gets worse
 * the more history there is.
 *
 * Keyed on how many events the log holds. Membership is a pure function of the
 * log, so the count changing is the only thing that can change the answer —
 * events are never removed except by compaction, which lowers it. A key
 * arriving can change it too, and `installPayloadKey` drops the entry for that.
 */
const memberCache = new Map<string, { count: number; members: Set<string> }>();

/**
 * Event types whose *payload* membership actually needs.
 *
 * The rest are decided by author and type alone. That distinction is worth
 * naming because reading it wrong is what made this loop expensive: it
 * decrypted every event in the log — an AES-GCM open and a Brotli inflate each
 * — to answer a question that all but a handful of them contribute nothing to.
 */
const MEMBERSHIP_PAYLOAD_TYPES = new Set([
  "community.owner",
  "member.kick",
  "member.ban",
  "member.unban",
  "member.readmit",
]);

function membersOf(community: string): Set<string> {
  const members = new Set<string>();
  const banned = new Set<string>();

  /**
   * People the owner removed, who have not come back.
   *
   * A kick is a removal, not a wall — that is what separates it from a ban.
   * But "not a wall" was doing too much work: removal frees a slot, and the
   * rule at the bottom of this loop hands a free slot to whoever writes next,
   * so the person just removed was re-admitted by their own next message. The
   * eviction lasted about as long as it took them to type.
   *
   * The fix is to require the return to be deliberate. Carrying on talking
   * does not undo a kick; rejoining does, and rejoining says so with an
   * explicit `member.join`. So a kick holds against everything already in
   * flight, and an invite still gets somebody back in without the owner having
   * to be awake for it.
   */
  const evicted = new Set<string>();
  const cap = capacityOf(community);

  let owner: string | undefined;

  let events: readonly SignedEvent[];
  try {
    events = storeFor(community).events();
  } catch {
    // No log yet; nobody is over capacity by definition.
    return members;
  }

  const cached = memberCache.get(community);
  if (cached && cached.count === events.length) return cached.members;

  try {
    // One pass in causal order. Joining and leaving are both just events, so
    // they are applied in the order everyone agrees on and every device ends
    // up with the same set — including which people a departure made room for.
    for (const event of events) {
      // Decrypted only where the answer depends on it — see
      // `MEMBERSHIP_PAYLOAD_TYPES`. This used to open every event in the log,
      // and this loop runs on every frame a peer sends.
      const payload = MEMBERSHIP_PAYLOAD_TYPES.has(event.type)
        ? (decryptPayload(community, event.payload) as { userId?: string } | null)
        : null;

      if (event.type === "community.owner") {
        owner = (payload?.userId as string) || event.author;
      }

      // Leaving is self-signed: nobody needs permission to go, and nobody
      // else can announce a departure on your behalf, because the signature
      // is the identity.
      if (event.type === "member.leave") {
        members.delete(event.author);
        continue;
      }

      // Removal is the owner's to declare. A kick frees the slot and can be
      // undone by rejoining; a ban also bars the door.
      if (event.type === "member.kick" || event.type === "member.ban") {
        if (owner && event.author === owner && payload?.userId) {
          members.delete(payload.userId);
          evicted.add(payload.userId);
          if (event.type === "member.ban") banned.add(payload.userId);
        }
        continue;
      }

      if (event.type === "member.unban" || event.type === "member.readmit") {
        if (owner && event.author === owner && payload?.userId) {
          banned.delete(payload.userId);
          evicted.delete(payload.userId);
        }
        continue;
      }

      // Coming back. Self-signed, like leaving — nobody needs permission to
      // walk back through a door they were given the key to, and holding an
      // invite is what having the key means here.
      //
      // A ban is different and still refused: that door was locked, not shut.
      if (event.type === "member.join") {
        if (!banned.has(event.author)) {
          evicted.delete(event.author);
          if (!members.has(event.author) && members.size < cap) {
            members.add(event.author);
          }
        }
        continue;
      }

      // Leaving of one's own accord is not an eviction, so it does not bar a
      // return: somebody who left a conversation can come back by writing in
      // it, exactly as before.
      if (banned.has(event.author)) continue;
      if (evicted.has(event.author)) continue;
      if (members.has(event.author)) continue;

      // A free slot — whether from the start or because somebody left — is
      // taken by whoever writes next. That is what makes a departure actually
      // give the room back rather than retiring the place permanently.
      if (members.size < cap) members.add(event.author);
    }
  } catch {
    // A log that cannot be walked says nothing about who belongs. Deliberately
    // not cached: the next call should try again rather than inherit a partial
    // answer for as long as the event count happens to stay the same.
    return members;
  }

  memberCache.set(community, { count: events.length, members });
  return members;
}

/**
 * Whether this device should exchange anything with a peer for a community.
 *
 * Refusing to serve is the other half of refusing to accept. Discarding an
 * intruder's events keeps them out of the conversation; declining to send
 * them ours keeps them from reading it, which is the part that actually
 * costs them something.
 */
function servesPeer(community: string, peerUserId: string | undefined): boolean {
  if (!peerUserId) return true;               // not yet identified
  if (!isShareable(community)) return false;

  // Only communities already held are judged.
  //
  // This is asked for every community a peer offers, including ones this
  // device has never heard of — and `storeFor` creates what it opens, so the
  // check was quietly making a directory for every community every peer
  // mentioned. It also has nothing to say about them: a community with no log
  // has no members to be over capacity.
  if (!stores.has(community) && !knownCommunities().includes(community)) return true;

  const members = membersOf(community);
  // An empty or unknown community cannot judge anyone — this is also the
  // ordinary case for a first sync, where refusing would prevent the very
  // exchange that establishes who the members are.
  if (members.size === 0) return true;
  if (members.size < capacityOf(community)) return true;

  return members.has(peerUserId);
}

// ---- this device, and which of yours holds the address ----------------------

interface DeviceRecord {
  id: string;
  name: string;
}

let device: DeviceRecord | undefined;
let pair: PairService | undefined;

/**
 * Whether the user has asked to move the account address to this device.
 *
 * Not a claim. A claim is written only once the device currently holding the
 * address has agreed to give it up; this is the request that gets sent during
 * a pairing session. The two are separate because a device that is switched
 * off cannot be argued with, and writing a claim without agreement is how two
 * devices came to answer at one address with neither of them wrong.
 */
let wantsAddress = false;

/**
 * Where the renderer can be reached from outside a handler.
 *
 * Linking and losing the address are both things that happen *to* the app
 * rather than because it was asked, so they need a way to tell the window
 * about it. Captured from whichever call came in most recently, which is the
 * same window in every case — this app has one.
 */
let viewer: Electron.WebContents | undefined;

function deviceFile(): string {
  return join(root(), "device.json");
}

/**
 * This install's id and name.
 *
 * Created on first use and never regenerated. It is not carried in an identity
 * export on purpose: a restored backup is a *different* device, and if it
 * inherited the id it could not take the address from the machine it was
 * restored from — the two would be indistinguishable to the ledger.
 */
function thisDevice(): DeviceRecord {
  if (device) return device;

  try {
    const read = JSON.parse(readFileSync(deviceFile(), "utf8")) as DeviceRecord;
    if (read && typeof read.id === "string" && read.id) {
      device = { id: read.id, name: read.name || defaultDeviceName() };
      return device;
    }
  } catch {
    // First run, or a file that says nothing usable. Either way, make one.
  }

  device = { id: newDeviceId(), name: defaultDeviceName() };
  writeDevice(device);
  return device;
}

function writeDevice(record: DeviceRecord): void {
  device = record;
  try {
    writeFileSync(deviceFile(), JSON.stringify(record), { mode: 0o600 });
  } catch (error) {
    log("[p2p]", `could not record this device: ${String(error)}`);
  }
}

function defaultDeviceName(): string {
  // The machine's name, because it is the one label the user already
  // recognises. Falls back to something honest rather than to "unknown", which
  // would appear in a sentence like "signed in on unknown".
  try {
    return hostname() || `this ${process.platform} device`;
  } catch {
    return `this ${process.platform} device`;
  }
}

/**
 * Whether an index event was written by this account.
 *
 * ## Why the index needs an author check at all
 *
 * `@index` is private and never offered to a peer, so for a long time nothing
 * else could put anything in it. Linking a device changed that, and in the one
 * way that matters: the device being linked has a *throwaway* identity when the
 * pairing starts. It generated a key on first launch so the setup screen could
 * show an id, and `netStart` runs before any of that is resolved — which writes
 * a `device.claim` and a `device.sync` into that throwaway index.
 *
 * Those then travel. The pairing session offers `@index` in both directions, so
 * the phone hands its throwaway claim to the desktop, which merges it (it
 * verifies perfectly well — it is a real event, correctly signed by a real key
 * that simply is not this account's).
 *
 * And then the desktop honours it. Both claims sit at `n = 1`, the tie is
 * broken by wall clock, the phone's is newer — so the phone "holds" the address
 * and the desktop stops publishing it. Linking a second device silently took
 * the account address away from the machine the user was sitting at, over an
 * event written before that device was part of the account at all.
 *
 * A claim signed by a key that is not this account's is not this account's
 * claim. Same for an address. Nothing legitimate is excluded: claims learned
 * from a sibling are re-signed by `addClaim` on the way in, so they carry this
 * account's signature like everything else.
 */
function ours(event: SignedEvent): boolean {
  return !!identity && event.author === identity.userId;
}

/** Every claim recorded in the private index log. */
function claimsHeld(): Claim[] {
  try {
    return storeFor(INDEX).events()
      .filter((event) => event.type === CLAIM && ours(event))
      .map((event) => decryptPayload(INDEX, event.payload))
      .filter(isClaim);
  } catch {
    return [];
  }
}

/** Record a claim, unless this device already has that exact one. */
function addClaim(claim: Claim): void {
  if (!isClaim(claim)) return;

  const known = claimsHeld();
  if (known.some((held) => held.device === claim.device && held.n === claim.n)) return;

  try {
    storeFor(INDEX).append(CLAIM, claim);
  } catch (error) {
    log("[p2p]", `could not record a device claim: ${String(error)}`);
  }
}

function deviceInfo() {
  const me = thisDevice();
  const claims = claimsHeld();

  return {
    device: me.id,
    name: me.name,
    standing: standing(claims, me.id),
    claims: claims.sort((a, b) => b.n - a.n),
    // Named for what the interface has always called it. The service behind
    // it is `PairService` now; the question being asked — "can another of my
    // devices reach this one" — did not change.
    linking: !!pair?.port,
    linkPort: pair?.port ?? 0,
    onion: tor?.address,

    // Where your other devices reach this one. Shown so it can be typed or
    // scanned on a device that has never met this one — after that the roster
    // carries it and nobody has to look at it again.
    syncOnion: syncAddressNow(),
    known: others(syncAddresses(), me.id),
  };
}

function announceDevices(extra: Record<string, unknown> = {}): void {
  try {
    viewer?.send(P2P_DEVICES, { ...deviceInfo(), ...extra });
  } catch {
    // The window has gone. Nothing to tell.
  }
}

/**
 * Publish the onion service, but only if this device is the one that should.
 *
 * The alternative — publishing always and letting Tor sort it out — is what
 * this whole mechanism exists to avoid. Tor does not sort it out; it keeps the
 * newest descriptor, so two devices take turns being reachable and neither is
 * reliably so.
 */
async function publishIfHolding(): Promise<string | undefined> {
  if (!tor) return undefined;

  const me = thisDevice();

  if (!holds(claimsHeld(), me.id)) {
    // Withdraw the account address, keep the sync address.
    //
    // This used to call `tor.stop()`, which stops the whole process — and the
    // process hosts both hidden services. So a displaced device lost its sync
    // address too, and with it the ability to be dialled by its sibling, to
    // show a pairing code, or to be reached in order to hand the account back.
    // That is the answer to "each device has its own sync address, so why does
    // syncing only go one way": the displaced one had stopped publishing.
    log("[tor]", "another of your devices holds the address — publishing sync only");
    await tor.setAccount(false);
    return undefined;
  }

  // Got what it asked for, so stop asking.
  //
  // ## The ping-pong this ends
  //
  // `wantsAddress` is the request the Reconnect button records. It was cleared
  // in the two places that *grant* it — `take`, and the holder's `yield` — and
  // in neither of the places where this device *receives* it. So a device that
  // asked once, and was given the address by a sibling yielding, went on
  // asking for it forever.
  //
  // That is invisible with one device and vicious with two. `claim` is
  // exchanged in every pairing greeting, and the rule on the other side is "if
  // they want it and I hold it, hand it over". Once both devices had asked at
  // some point in their lives, every sync between them moved the address:
  // A yields to B, five minutes later B yields back to A, forever. Each swap
  // writes a claim into the index, and — because exactly one device answers at
  // the account address — each swap moves where the user's friends can reach
  // them. From outside it reads as the two devices fighting over the
  // conversation, which is precisely what they are doing.
  //
  // Holding is the end of the request, so this is where it belongs: every path
  // that can change who holds — startup, repair, take-over, a completed sync,
  // and answering one — passes through here.
  if (wantsAddress) {
    wantsAddress = false;
    log("[p2p]", "this device now holds the account address");
  }

  // Holding again: make sure the account service is offered.
  await tor.setAccount(true);

  if (tor.running) return tor.address;

  try {
    const onion = await tor.start();

    // Two outcomes, and they used to be logged as one. On a desktop `start`
    // does not return until tor has written its hostname file, so an address
    // is always there. On a phone Tor is a library that publishes on its own
    // schedule, so this returns before there is one — and the log said "onion
    // service published: undefined", which reads as a failure and is not one.
    log("[tor]", onion
      ? `onion service published: ${onion}`
      : "tor is up; the account address will be published shortly");

    return onion;
  } catch (error) {
    log("[tor]", (error as Error).message);
    return undefined;
  }
}

// ---- reaching your own devices from anywhere --------------------------------
//
// The local network is the fast path and not the general one. Two devices in
// different places still have to converge — that is the difference between an
// identity that works across your devices and one that works across your
// devices while they are in the same room.
//
// So each device publishes a *second* onion service, used only by its
// siblings. Its address goes in the private index log, which syncs, so every
// device learns where every other device is. A fresh install gets the first
// address from the identity backup it was restored from, which is enough to
// make contact once; after that the roster keeps itself.
//
// Onion services need no port forwarding and no fixed address, so this works
// from mobile data, behind carrier NAT, from another country.

/** The port the link server is listening on, for Tor to forward to. */
let syncPort = 0;

/**
 * Syncs already in flight, keyed by address.
 *
 * By address rather than by device id, and that is the whole point of the
 * change. A sync started by scanning a code does not know which device it is
 * dialling yet — it has an address and nothing else — so it used the placeholder
 * id "unknown", which collides with nothing and therefore guarded nothing.
 *
 * The automatic pass and the scan could then open two sessions to the same
 * device at the same moment. Both are valid; the pair that finishes second
 * finds the far end already mid-exchange and fails the handshake. So the data
 * arrived *and* the button reported "that is not a Reaper device link" — a
 * failure that was real, about a second connection nobody asked for.
 */
const syncing = new Set<string>();

/**
 * What `syncOverTor` says when it declines because one is already running.
 *
 * Named rather than written twice, because a caller has to be able to tell it
 * apart from a real failure. `repairAddress` in particular reads any failure as
 * "the holder is not there" and takes the account address — and this
 * "failure" means the exact opposite: there is a live session to that device
 * happening right now.
 *
 * The two overlap easily. The five-minute pass, the debounce after a change and
 * a repair check all dial the same siblings, so one of them finding another
 * already in flight is ordinary. Before this was distinguished, that produced
 * two devices taking the address off each other while they were mid-sync.
 */
const ALREADY_SYNCING = "already syncing with that device";

function syncAddresses(): SyncAddress[] {
  try {
    return storeFor(INDEX).events()
      // Signed by this account, for the same reason claims are — see `ours`.
      // An address announced by a device's throwaway key is an address that
      // belonged to somebody who was not yet part of this account.
      .filter((event) => event.type === SYNC && ours(event))
      .map((event) => decryptPayload(INDEX, event.payload))
      .filter(isSyncAddress);
  } catch {
    return [];
  }
}

/** Announce where this device can be reached, if it has moved. */
function recordSyncAddress(onion: string): void {
  const me = thisDevice();
  const known = roster(syncAddresses()).find((entry) => entry.device === me.id);

  if (known && known.onion === onion && known.name === me.name) return;

  try {
    storeFor(INDEX).append(SYNC, {
      device: me.id, name: me.name, onion, at: Date.now(),
    });
  } catch (error) {
    log("[link]", `could not record this device's sync address: ${String(error)}`);
  }
}

/**
 * This device's sync address, if Tor has published it yet.
 *
 * There is no separate service to start any more. A second `TorService` was
 * the obvious way to get a second address and it could never have worked: the
 * SOCKS and control ports are fixed, so a second tor process fails to bind and
 * exits at once. The result was a sync address that was permanently "still
 * publishing" — nothing to copy, nothing to scan, and no sign that a process
 * had died.
 *
 * One tor, two hidden services, exactly as the iOS client does it.
 */
function syncAddressNow(): string | undefined {
  return tor?.syncAddress;
}

/**
 * Sync with one of your devices over Tor.
 *
 * Files are left out. They are the large part by far, they can be fetched from
 * whoever sent them, and pushing an attachment store through three relays to
 * save a request that may never be made is a poor trade for both devices and
 * for the network. Conversations, friends, servers, group chats and the outbox
 * cannot be fetched from anywhere else, so those always travel.
 */
async function syncOverTor(
  entry: SyncAddress,
  scope: Scope = "messages",
): Promise<LinkProgress> {
  if (syncing.has(entry.onion)) {
    throw new Error(ALREADY_SYNCING);
  }

  syncing.add(entry.onion);

  try {
    const result = await syncWithSibling(entry.onion, scope);

    log("[pair]", `synced with ${result.name || entry.name} (${scope}): `
      + `${result.events} events, ${result.pictures} pictures`);

    await publishIfHolding();

    // The shape the interface has always been handed. Pairing counts pictures
    // where the link counted files, and they are the same number — pictures
    // are the only files that cross.
    const progress: LinkProgress = {
      device: result.device,
      name: result.name || entry.name,
      events: result.events,
      files: result.pictures,
      communities: result.communities,
      done: result.done,
    };

    announceDevices({ synced: progress });
    return progress;
  } catch (error) {
    // Thrown on, with what actually happened. This used to swallow the error
    // and return undefined, and the caller turned that into "that device did
    // not answer" — one of about six things it could have been, and the only
    // one that is not actionable.
    const why = (error as Error).message;
    log("[pair]", `could not sync with ${entry.name}: ${why}`);
    throw new Error(why);
  } finally {
    syncing.delete(entry.onion);
  }
}

/**
 * Take the account address when nobody is actually using it.
 *
 * ## Why this replaces asking
 *
 * Exactly one device answers at an account address at a time. That constraint
 * is real and cannot be relaxed: an onion address is a public key, so two
 * devices publishing descriptors for it means the directory keeps whichever
 * spoke last and peers reach an arbitrary one. Messages land on one device and
 * not the other, and nothing errors.
 *
 * What was wrong was not the constraint but the *question*. A device that was
 * not holding put a screen in front of the user asking whether to take over —
 * from a device that was very often switched off, at which point the polite
 * request went nowhere and the screen stayed. The user pressed a button that
 * appeared to do nothing, then a second button to insist, and then restarted
 * the app because the address still had not moved.
 *
 * Nobody has the information to answer that question except this code, and it
 * can find out by asking: reach the holder, or fail to. So it asks the holder
 * rather than the user.
 *
 * Being displaced never stopped a device *sending* — it dials its peers
 * directly and the outbox drains to whoever is connected. What it stopped was
 * receiving, because peers dial the account address and arrive wherever that
 * is. An address stranded on a device that is off is precisely a mailbox
 * nobody empties, and repairing that without being asked is the whole point.
 *
 * ## What stops two devices taking it at once
 *
 * Nothing, in the moment. Two devices that cannot reach each other will both
 * conclude the holder is gone and both take it. That is survivable and
 * self-correcting rather than a hole: a claim carries a number, the higher one
 * wins, and the first sync between them settles it. A brief overlap costs far
 * less than an address stranded indefinitely, which is what the polite version
 * produced.
 */
async function repairAddress(): Promise<void> {
  const me = thisDevice();
  const claims = claimsHeld();

  // Already ours, or nobody has ever taken it — `holds` treats an empty ledger
  // as this device's, which is right for an account that has only run here.
  if (holds(claims, me.id)) return;

  const winner = holder(claims);
  if (!winner) return;

  const known = roster(syncAddresses()).find((entry) => entry.device === winner.device);

  const take = async (why: string) => {
    log("[p2p]", `taking the account address: ${why}`);
    addClaim(claimFor(claimsHeld(), me.id, me.name));
    wantsAddress = false;

    await publishIfHolding();
    announceDevices();
  };

  // It holds the address and this device has no idea where it is, so there is
  // nothing to ask. That happens when a claim arrives from a device whose sync
  // address never did.
  if (!known) {
    await take(`${winner.name || "the holder"} is not in the roster`);
    return;
  }

  try {
    await syncOverTor(known, "identity");

    // It answered, so it is alive and holding, and this device is displaced for
    // a good reason. Nothing to repair.
  } catch (error) {
    const why = (error as Error).message;

    // A session to that device is already running, which is the strongest
    // possible evidence that it is there. Taking the address off a device this
    // one is mid-conversation with is the opposite of repairing anything — and
    // it happened often, because the scheduled pass, the debounce after a
    // change and this check all dial the same siblings.
    if (why === ALREADY_SYNCING) {
      log("[p2p]", `${known.name || "the holder"} is mid-sync — leaving the address where it is`);
      return;
    }

    await take(`${known.name || "the holder"} did not answer — ${why}`);
  }
}

/**
 * Try every other device of yours, in turn.
 *
 * `failures` is filled in when the caller passes one. Every failure is logged
 * regardless, but a log is not where somebody who pressed Sync is looking —
 * and "none of your 2 other devices answered" was, for a long time, the only
 * thing they were told. That sentence covers a device that is switched off, a
 * device that has not finished linking, an address nothing answers at any
 * more, and a device holding a different account, and it is actionable for
 * exactly none of them.
 */
async function syncAllDevices(
  failures?: { name: string; error: string }[],
  scope: Scope = "messages",
): Promise<LinkProgress[]> {
  const done: LinkProgress[] = [];

  for (const entry of others(syncAddresses(), thisDevice().id)) {
    try {
      done.push(await syncOverTor(entry, scope));
    } catch (error) {
      // A device being switched off is the ordinary case and must not stop the
      // others being tried.
      failures?.push({ name: entry.name, error: (error as Error).message });
    }
  }

  return done;
}

// ---- keeping the devices level, without being asked -------------------------
//
// Two schedules, because the two cases want different things.
//
// A *periodic* pass catches everything eventually and costs one Tor circuit
// every few minutes. It is what makes an account that is left alone on two
// machines converge without anybody thinking about it.
//
// A pass *after a change* is what makes it feel immediate — adding a friend on
// a desktop and finding them on a phone a minute later, rather than after
// whenever the timer next fires. It is debounced, because joining a server
// writes several events in a row and each one should not be its own circuit.

/** How often to catch up with no prompting at all. */
const SYNC_EVERY_MS = 5 * 60 * 1000;

/**
 * How many of those passes go by between one that also carries pictures.
 *
 * Every sixth, so half an hour. Profile pictures, banners and server icons are
 * the only files that cross a pairing at all — message attachments never do —
 * and they change about as often as people change their minds about their
 * avatar, which is to say rarely. Asking about them every five minutes costs a
 * list of every picture on the account, in both directions, to establish that
 * nothing has happened.
 *
 * A face that is twenty minutes out of date has cost nobody anything. A
 * conversation that is twenty minutes out of date is a broken app, which is
 * why messages are not on this schedule.
 */
const PICTURES_EVERY = 6;

/** How long to let a burst of changes settle before acting on it. */
const SYNC_SETTLE_MS = 20 * 1000;

/**
 * ...and how long a burst of *typing* settles for.
 *
 * Longer, and — unlike the one above — it does not restart when another
 * message arrives. That difference is the whole design: joining a server
 * writes several index events in a row and should produce one sync after the
 * last of them, whereas a conversation is a stream with no last message, and a
 * timer that restarts on every one would never fire while anybody was talking.
 */
const MESSAGE_SETTLE_MS = 30 * 1000;

let syncTimer: ReturnType<typeof setInterval> | undefined;
let syncSoon: ReturnType<typeof setTimeout> | undefined;
let messageSoon: ReturnType<typeof setTimeout> | undefined;
let passes = 0;

/**
 * Whether the user has already been told, this session, that a change would
 * be worth syncing.
 *
 * Once. Somebody adding six friends in a row is doing one thing, and six
 * notifications about it is a worse experience than none — the second and
 * later ones carry no information and train people to dismiss the first.
 */
let recommended = false;

/**
 * This device wrote a message, so its siblings are now behind.
 *
 * ## The asymmetry this fixes
 *
 * Everything *arriving* reaches both of a user's devices already: a friend
 * broadcasts to every peer connected to them, and both devices dial out
 * regardless of which one holds the account address. Everything *sent* reaches
 * only the device it was typed on and the person it was addressed to.
 *
 * The sibling then had two ways to find out, and both are slow: the five-minute
 * pass, or reconciling with the recipient, who re-offers an unchanged id set
 * only every four minutes. So a conversation held on a desktop showed up on the
 * phone as the other half of it — their replies, promptly, with nothing in
 * between. That reads as the two devices competing for the conversation rather
 * than sharing it.
 *
 * A sibling sync is a Tor circuit and a summary per community in both
 * directions, so this is deliberately not immediate. Half a minute after the
 * talking stops is the difference between "a moment behind" and "minutes
 * behind", and the cost is bounded by the fact that the timer does not restart.
 */
function wroteSomethingSiblingsWant(): void {
  // One is already coming. Deliberately not rescheduled — see
  // `MESSAGE_SETTLE_MS`.
  if (messageSoon) return;

  // Checked after the cheap guard above, because it reads the whole index and
  // this is called on the path that appends a message.
  if (!others(syncAddresses(), thisDevice().id).length) return;

  messageSoon = setTimeout(() => {
    messageSoon = undefined;

    void syncAllDevices(undefined, "messages")
      .then((done) => {
        if (done.some((one) => one.events > 0)) announceDevices();
      })
      .catch((error: Error) => log("[p2p]", error.message));
  }, MESSAGE_SETTLE_MS);
}

function startSyncSchedule(): void {
  if (syncTimer) return;

  syncTimer = setInterval(() => {
    if (!others(syncAddresses(), thisDevice().id).length) return;

    // Messages nearly always; pictures occasionally. See `PICTURES_EVERY`.
    passes += 1;
    const scope: Scope = passes % PICTURES_EVERY === 0 ? "everything" : "messages";

    void syncAllDevices(undefined, scope).then(async (done) => {
      if (done.some((one) => one.events > 0 || one.files > 0)) announceDevices();

      // The regular check. A device holding the address can be switched off at
      // any moment, and the account is unreachable from that moment until
      // somebody notices — so this is what notices.
      await repairAddress();
    }).catch((error: Error) => log("[p2p]", error.message));
  }, SYNC_EVERY_MS);

  // Left running while the app is, and not unref'd: this is a background task
  // the user is relying on, not a nicety that should let the process exit.
}

/**
 * Something changed that another device would want.
 *
 * Does two things, and they are separate on purpose. It schedules a sync,
 * which handles it silently if the other device is reachable. And it tells the
 * interface *once* per session, so that if the other device is switched off —
 * which is the only case where this matters — the user finds out from a small
 * note rather than from their phone being wrong tomorrow.
 */
function changedSomethingWorthSyncing(): void {
  // Nothing to sync with. A single-device account should never see any of
  // this, and checking here rather than in the interface means the interface
  // cannot get it wrong.
  if (!others(syncAddresses(), thisDevice().id).length) return;

  if (syncSoon) clearTimeout(syncSoon);
  syncSoon = setTimeout(() => {
    syncSoon = undefined;
    void syncAllDevices().then((done) => {
      // Quietly, when it worked. The point of doing this automatically is that
      // nobody has to be told about it.
      if (done.length) {
        recommended = false;
        announceDevices();
      }
    });
  }, SYNC_SETTLE_MS);

  if (recommended) return;
  recommended = true;

  announceDevices({ recommend: true });
}

/**
 * The secret every device holding this account can derive, and no other can.
 *
 * The account's own signing key, which is exactly the property wanted: a
 * device has it if and only if it has already been linked, because being
 * linked is how it got the key. `pair.ts` hashes it with a label before it
 * goes anywhere near the wire, so this value itself is never sent.
 *
 * ## Why there is no longer a file here
 *
 * There was one — `pair-password`, holding whatever the user typed — and it
 * was the source of three separate reports that read as different bugs:
 *
 *   - "The password stops working after a restart." On iOS that file is
 *     written through a debounced flush, so setting a password and force-
 *     quitting inside that window lost it, and the next launch reported no
 *     password set with no way to tell that from never having set one.
 *
 *   - "It says the password is wrong and it is not." Two devices each holding
 *     their own copy of a secret that has to match is a state that can differ,
 *     and once it differed nothing on either screen said which one was stale.
 *
 *   - "The code I made last week still works." The password was the only thing
 *     sealing an invite, so a code could not be revoked without changing it.
 *
 * All three are the same fault: a long-lived credential kept in two places.
 * Deriving it removes the file, the copies, and the possibility of drift.
 */
function accountSecret(): string | undefined {
  // An unclaimed key is not an account. See `claimed` below.
  return claimed() ? identity?.privateKey : undefined;
}

/**
 * Delete the pairing password left behind by an earlier version.
 *
 * Nothing reads it any more, which is exactly why it should not still be
 * there: it is a password in plain text, in the same directory as the private
 * key, that the user has no way to see or clear and no longer has any reason
 * to have. A credential nothing uses is not harmless — it is one that can only
 * ever leak.
 *
 * Best effort and silent. A file that will not delete is not worth failing
 * startup over, and there is nothing the user could do about it anyway.
 */
function forgetOldPairPassword(): void {
  try {
    rmSync(join(root(), "pair-password"), { force: true });
  } catch {
    // Read-only directory, or a permission the app does not have. The file is
    // inert either way.
  }
}

/**
 * Whether the key on this device is an account somebody is actually using.
 *
 * ## Why this is not `Boolean(identity)`
 *
 * It was, and that single expression is why linking appeared to work and left
 * the phone as a different person.
 *
 * `registerP2PHandlers` calls `loadOrCreateIdentity` before anything else, so
 * a brand-new install *always* has a key — it is generated on first launch so
 * the setup screen can show the user id it is offering them. `identity` is
 * therefore never undefined, `needsIdentity` was never true, `whoami` was
 * never sent, and the device being linked never asked for the account it had
 * just been linked to. It synced every message, every friend and every server,
 * signed by somebody it was not, and carried on as the throwaway identity it
 * had generated sixty seconds earlier.
 *
 * What actually separates a set-up device from a fresh one is the same thing
 * the interface uses to decide whether to show the setup screen: whether this
 * key has ever claimed a username. Reading the same fact in both places is the
 * point — the two cannot disagree about whether this device has an account.
 *
 * Memoised in one direction only. Claiming is permanent, so a `true` never
 * needs re-checking; a `false` does, because the whole purpose of this is to
 * notice the moment it stops being false.
 */
let everClaimed = false;

/**
 * Whether this device still needs to be handed an account.
 *
 * The inverse of `claimed`, named separately because the two are asked in
 * opposite situations and reading `!claimed()` at a call site reads as a
 * double negative about a heuristic.
 *
 * Used only to decide whether to *ask* and whether an answer was needed —
 * never to decide whether to give. A false positive here costs a `whoami` that
 * is answered and ignored; the same mistake on the giving side cost the entire
 * feature.
 */
function needsAccount(): boolean {
  return !claimed();
}

function claimed(): boolean {
  if (everClaimed) return true;
  if (!identity) return false;

  try {
    everClaimed = storeFor(INDEX).events().some(
      (event) =>
        event.author === identity?.userId &&
        (event.type === "profile.update" || event.type === "username.claim"),
    );
  } catch {
    // No index on disk yet, which is as unclaimed as a device gets.
    return false;
  }

  return everClaimed;
}

/**
 * The pairing service.
 *
 * The only thing the sync onion forwards to, and that is the point. There was
 * briefly a second service on a second port speaking an older protocol, and
 * because the onion was still published pointing at that one, every pairing
 * attempt died as "that device closed the connection" — the far end read a
 * frame header it did not recognise as a length prefix and destroyed the
 * socket. One address, one protocol, one listener.
 */
async function openPair(): Promise<number> {
  if (pair?.port) return pair.port;

  const me = thisDevice();

  const service = new PairService({
    device: me.id,
    name: me.name,

    onion: () => tor?.syncAddress ?? "",

    // Straight to the same log the rest of the core writes to, so a failed
    // attempt leaves a record on *both* devices rather than only on whichever
    // one happened to raise the error.
    trace: (line) => log("[pair]", line),
    accountSecret: () => accountSecret(),

    communities: () => {
      const dir = join(root(), "communities");
      const onDisk = existsSync(dir)
        ? readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
        : [];

      return [...new Set([...onDisk, ...stores.keys(), INDEX])];
    },

    /**
     * What a device needs before it can be signed in.
     *
     * The private index and nothing else. It carries the username claim, which
     * is the fact the interface reads to decide whether to show the setup
     * screen — so the moment this lands the device stops being a stranger.
     * It also carries the friends list, the server list and the claims, all of
     * which are metadata rather than history, and all of which are small.
     *
     * What it does not carry is a single message. Those are the whole point of
     * the app and none of them are needed to get into it.
     */
    essential: () => [INDEX],

    summary: (community) => storeFor(community).summary(),
    missingForSummary: (community, summary) =>
      [...storeFor(community).missingForSummary(summary)],

    merge: (community, events) => {
      const result = storeFor(community).merge(events);

      if (result.accepted.length) {
        try {
          viewer?.send(P2P_EVENT, community, result.accepted.map(forRenderer));
        } catch { /* window gone */ }
      }

      return result.accepted.length;
    },

    pictureIds: () => blobsFor(PAIR_PICTURES).ids(),
    readPicture: (id) => blobsFor(PAIR_PICTURES).read(id),
    writePicture: (id, bytes) => { blobsFor(PAIR_PICTURES).accept(id, bytes); },

    /**
     * The account, for a sibling that has none.
     *
     * Serialised as JSON rather than as an encrypted bundle: the only path it
     * takes is a Tor circuit to an address the peer learned from a code shown
     * on this screen, after proving the pairing password. That is already an
     * authenticated, encrypted channel to a device the user just authorised by
     * hand, and wrapping it again would only add a second passphrase to get
     * wrong.
     */
    identity: async () => {
      // Whatever this device has, whenever it is asked.
      //
      // It used to refuse unless `claimed()` said this key had a username in
      // the index, on the reasoning that two fresh devices should not swap
      // throwaway keys. The reasoning was fine and the mechanism was not: it
      // made handing over an account depend on a *search of a log*, and when
      // that search came back false the device silently answered "I have no
      // account" to the one question the whole feature exists to answer.
      //
      // Nothing here can tell a false negative from a real one, which is
      // exactly why it should not be deciding. `pair.ts` decides now, and it
      // decides on something it cannot be wrong about: only the device that
      // minted the invite — the one whose screen the code is on — is ever
      // asked for an account in the first place.
      if (!identity) return undefined;

      let onionKey: string | undefined;

      try {
        // The *data* directory, not the service directory inside it.
        // `readOnionKey` appends `onion` itself — see `onionDir` — so passing
        // the service directory looked for `tor/onion/onion`, found nothing,
        // and returned undefined every time. The linked device then came up as
        // the right account at a brand-new address, which is the failure where
        // every friend code anybody holds for you silently stops working.
        //
        // Serialised as JSON because an onion key is three files, not one
        // blob. It used to be sent as `readOnionKey(...)?.toString("base64")`
        // — `toString` on an object, so the wire carried the seven characters
        // "[object Object]" and the far end refused it as malformed, at which
        // point the address was lost anyway but with an error to show for it.
        const key = await readOnionKey(join(root(), "tor"));
        if (key) onionKey = JSON.stringify(key);
      } catch {
        // An account with no published address yet. The identity is still
        // worth sending; the address can be republished from the key it
        // derives.
      }

      return { identity: JSON.stringify(identity), onionKey };
    },

    /**
     * Whether this device is still waiting for an account.
     *
     * True until this device's key has claimed a username, which is the same
     * question the interface asks before showing the setup screen. Once it has
     * claimed one it never asks again — receiving a second account would
     * silently replace the first, and every event this device had already
     * signed would stop verifying against the key that replaced it.
     */
    needsIdentity: () => !claimed(),

    adoptIdentity: async (account) => {
      const arrived = JSON.parse(account.identity) as Identity;

      if (!arrived?.privateKey || !arrived?.userId) {
        throw new Error("that account arrived incomplete");
      }

      // Checked here as well as in `needsIdentity`, because the two are read at
      // different moments and only this one is destructive. Between them sits a
      // whole session over a slow circuit.
      if (claimed()) {
        throw new Error("this device already has an account of its own");
      }

      new ElectronKeystore().save(arrived);
      identity = arrived;

      // Every open log was constructed around the key that has just been
      // replaced — `CommunityStore` takes the identity once, at construction,
      // and signs everything it appends with it. Left in place, the device
      // would adopt the account and then go on writing as the throwaway key it
      // was supposed to have stopped being, which is the same failure as never
      // adopting at all except harder to see.
      //
      // Closed rather than dropped, so buffered appends reach disk first.
      for (const store of stores.values()) store.close();
      stores.clear();

      // And everything else that was derived from the key just replaced.
      //
      // These are all in-memory caches keyed by community, and every one of
      // them was computed with the throwaway identity: the direct-conversation
      // keys came from X25519 agreement against a private key that is now
      // gone, the blob stores were opened with those keys, and the decrypted
      // payloads were read through them. Leaving any of it in place means the
      // adopted account reading its own history through a stranger's keys —
      // which fails silently, as messages that will not open, until a restart
      // rebuilds them correctly. Exactly the class of bug this pairing path
      // has produced twice before.
      payloadKeys.clear();
      pastKeys.clear();
      decrypted.clear();
      blobStores.clear();
      memberCache.clear();
      communityDirs = undefined;

      // Claiming is memoised in one direction; the account that just arrived is
      // a different key, so the memo has to go with it.
      everClaimed = false;

      // The address travels with the account, or every friend code anybody
      // holds for this user stops working.
      //
      // Not fatal if it fails. An account at a new address is a real loss and
      // worth a line in the log, but it is an account — refusing the whole
      // pairing over it would leave the device with no identity at all, which
      // is strictly worse.
      if (account.onionKey) {
        try {
          await writeOnionKey(join(root(), "tor"), JSON.parse(account.onionKey) as OnionKey);
          log("[pair]", "took on the account's onion address as well");
        } catch (error) {
          log("[pair]", `could not take on the onion key: ${String(error)}`);
        }
      }

      log("[pair]", `took on account ${arrived.userId}`);
    },

    holding: () => holds(claimsHeld(), thisDevice().id),
    wants: () => wantsAddress,
    claimN: () => holder(claimsHeld())?.n ?? 0,

    /**
     * Remember a sibling.
     *
     * Written only from a session that proved the password, which is the fix
     * for a roster that filled with addresses nothing ever answered at: a
     * failed or half-finished attempt now leaves no trace at all.
     *
     * ## Only when it is news
     *
     * This is called on every authorised session, by both sides. With the
     * scheduled pass running every five minutes and two devices each writing a
     * record per pass, the private index gained something like six hundred
     * events a day that all said the same thing.
     *
     * That is not merely wasted disk. The index is scanned in full by
     * `claimsHeld`, `syncAddresses` and `deviceInfo`, which run on every tor
     * event and every sync; it is the log carried on every pairing; and once it
     * is large enough to be worth compacting, it is also large enough that a
     * fork in it is expensive. An append-only log grows on purpose — it should
     * not grow to say nothing.
     *
     * `recordSyncAddress` has always had this check for this device's own
     * address. This is the same check, for the other end.
     */
    learn: (peer) => {
      const known = roster(syncAddresses()).find((entry) => entry.device === peer.device);

      if (known && known.onion === peer.onion && known.name === peer.name) return;

      storeFor(INDEX).append(SYNC, {
        device: peer.device,
        name: peer.name,
        onion: peer.onion,
        at: Date.now(),
      });

      try { viewer?.send("p2p:devices", syncAddresses()); } catch { /* window gone */ }
    },

    yield: (peer) => {
      // The peer asked for the account address and this device has it. Step
      // aside by appending a claim in their name, which both sides can read.
      addClaim(claimFor(claimsHeld(), peer.device, peer.name));
      wantsAddress = false;
    },

    asked: (peer) => {
      try { viewer?.send("p2p:deviceAsked", peer); } catch { /* window gone */ }
    },
  });

  pair = service;

  // Both outcomes go to the log.
  //
  // A session this device *answers* used to fail silently: the dialling device
  // saw an error and this one saw nothing at all, so half the evidence for
  // every failed pairing was thrown away at the moment it was produced. Whether
  // it worked is worth a line too — "nothing appeared in the log" is otherwise
  // indistinguishable between "no attempt reached me" and "one did and died".
  service.on("paired", (result: PairResult) => {
    log("[pair]", `${result.name || "a device"} linked: ${result.events} events, ${result.pictures} pictures`);

    // Claims arrive in a session this device *answered* just as readily as in
    // one it dialled — the greeting carries them in both directions. Only the
    // dialling path acted on them, though: `syncOverTor` ends with a
    // `publishIfHolding` and this ended with nothing.
    //
    // So a device that gave the address up by being asked for it went on
    // publishing anyway, until its own scheduled pass came round some minutes
    // later. For that window two devices answered at one address, produced by
    // the button whose entire purpose is to make sure exactly one does.
    void publishIfHolding()
      .then(() => announceDevices())
      .catch((error: Error) => log("[tor]", error.message));
  });

  service.on("failed", (why: string) => {
    log("[pair]", `an attempt to link failed: ${why}`);

    try { viewer?.send("p2p:pairFailed", why); } catch { /* window gone */ }
  });

  return service.open();
}

/**
 * Make sure Tor is running as a *client*, whether or not there is an account.
 *
 * Tor is normally brought up by `netStart`, which the interface calls once it
 * has an account to run. Linking is the one thing that has to work *before*
 * that: a new device has no identity, sits on the setup screen, and its whole
 * purpose in that moment is to reach a sibling and be given one.
 *
 * So on a fresh phone, scanning a code and pressing Link dialled through a Tor
 * that had never been started, and the honest answer came back — "Tor has not
 * opened its SOCKS port yet". Correct, and useless: nothing was ever going to
 * start it.
 *
 * Started with the account service switched off, because there is no account
 * to publish yet. The sync service still goes up, so this device can be
 * dialled back the moment it has an identity worth reaching.
 */
async function ensureTorClient(): Promise<void> {
  const forSync = await openPair();

  if (!tor) {
    tor = new TorService({
      dataDir: join(root(), "tor"),
      torPath: torExecutable(),

      // Nothing to forward to yet: the chat transport is not listening, and
      // with `account: false` the account service is not configured at all.
      targetPort: forSync,
      syncPort: forSync,
      role: "account",
      account: false,
    });

    // Both, and both matter on this path more than on any other.
    //
    // This is the Tor a device runs while it has no account, so it is the one
    // running during the single most reported failure in the app — and until
    // now it was also the only one with nothing listening to it. A link that
    // went wrong left no record of what tor had said about it, and the address
    // this device publishes for its siblings arrived nowhere.
    tor.on("log", (line: string) => log("[tor]", line));

    tor.on("sync", (address: string) => {
      log("[pair]", `this device can be reached for sync at ${address}`);

      // Only once there is an account to write it into. On a device still
      // waiting to be linked there is no identity to sign an index event with,
      // and the address is carried in the greeting anyway — the sibling learns
      // it from the pairing itself, which is the whole point of `learn`.
      if (identity) recordSyncAddress(address);
      announceDevices();
    });
  }

  if (!tor.running) {
    log("[pair]", "starting Tor so this device can reach the other one");
    await tor.start();
  }
}

/**
 * A circuit to one of your devices, with the pairing service up behind it.
 *
 * Both directions matter here. The socket is the outbound half; `openPair`
 * being awaited first is the inbound half, and it is not incidental — the two
 * sessions on a pairing are peers, and this device has to be answerable for
 * the same reasons the other one does.
 */
async function dialSibling(onion: string): Promise<{ socket: Socket; service: PairService }> {
  await ensureTorClient();

  const socket = await socksConnect(onion, 80);
  return { socket, service: pair! };
}

/**
 * Link to a device from a code scanned or pasted on this one.
 *
 * The only path that uses an invite. Everything after the first successful
 * link goes through `syncWithSibling` instead, which needs no code, no typing
 * and nothing stored.
 */
async function joinWithInvite(invite: Invite, password: string): Promise<PairResult> {
  const { socket, service } = await dialSibling(invite.onion);
  return service.join(socket, invite, password);
}

/**
 * Catch up with a device that already shares this account.
 *
 * `messages` by default, which is every conversation and no pictures — the
 * shape the scheduled pass wants, because it is the one that runs most often
 * and the picture list is the part whose cost does not fall once both sides
 * have caught up.
 */
async function syncWithSibling(
  onion: string,
  scope: Scope = "messages",
): Promise<PairResult> {
  const { socket, service } = await dialSibling(onion);
  return service.sync(socket, scope);
}

function blobsFor(community: string): BlobStore {
  let store = blobStores.get(community);
  if (!store) {
    store = new BlobStore(join(root(), "blobs", encodeURIComponent(community)));
    blobStores.set(community, store);
  }
  // Re-applied on every access: the key can be installed or rotated long after
  // the store was first created.
  store.setKey(payloadKeys.get(community));
  return store;
}

/**
 * Fields that must stay readable by a relay.
 *
 * A peer forwarding an event has to know which community it belongs to and be
 * able to verify the signature, or it cannot route or validate anything. Only
 * `payload` is hidden — the part that actually says something.
 */
/**
 * Event types that are never encrypted.
 *
 * A direct conversation's key comes from X25519 agreement, which needs the
 * other person's public key. Only the side that scanned a friend code has it —
 * so if the handshake itself were encrypted, the recipient could not read the
 * request that carries the key they need to read it. A deadlock: requests
 * arrived unreadable and accepts were written with no key, so neither side
 * ever saw the other's state and both sat on "pending" forever.
 *
 * These carry no secrets. "Someone wants to be friends, here is their public
 * key and display name" is exactly what a relay would learn from the traffic
 * pattern anyway.
 */
const PLAINTEXT_TYPES = new Set([
  "friend.request",
  "friend.accept",
  "friend.decline",
]);

function encryptPayload(community: string, type: string, payload: unknown): unknown {
  if (PLAINTEXT_TYPES.has(type)) return payload;
  const key = payloadKeys.get(community);
  return key ? seal(payload, key) : payload;
}

/**
 * Keys this community *used* to use, newest first.
 *
 * ## Why rotation needs a memory
 *
 * Removing somebody rotates the community key, which is what stops them
 * reading anything written afterwards. It is the achievable half of "remove
 * this person" and it is right.
 *
 * What it also did was lock everybody else out of the *past*. Only one key was
 * held per community, so the moment a rotation landed, every message sealed
 * under the previous one stopped opening — on the device that performed the
 * rotation as much as on everyone else's. It was invisible for a while,
 * because the decrypted-payload cache still had the plaintext; it appeared on
 * the next restart, as a server whose entire history before the last kick read
 * as unreadable, with nothing to say why.
 *
 * A key that has been superseded is still perfectly good for reading. It is
 * only useless for *writing*, which is the property rotation actually needs.
 * So the current key is what seals, and every key ever held is what opens.
 *
 * Bounded, because it is tried in order on a miss and a community that rotates
 * on every membership change would otherwise grow an unbounded list to try.
 * Eight covers any realistic history; past that, the oldest messages are the
 * ones that go, which is the right end to lose from.
 */
const pastKeys = new Map<string, Buffer[]>();

const PAST_KEYS_KEPT = 8;

function decryptPayload(community: string, payload: unknown): unknown {
  if (!isSealed(payload)) return payload;

  const key = payloadKeys.get(community);

  if (key) {
    const opened = openSealed(payload, key);
    if (opened !== undefined) return opened;
  }

  // Newest first: a log is read from the bottom far more often than the top,
  // so the most recently superseded key is the likeliest to be the right one.
  for (const older of pastKeys.get(community) ?? []) {
    const opened = openSealed(payload, older);
    if (opened !== undefined) return opened;
  }

  return { undecryptable: true };
}

/**
 * Install a payload key, and forget anything decrypted without it.
 *
 * ## Why every key install has to go through here
 *
 * `forRenderer` caches by event id, which is sound — an event is a hash of
 * itself and cannot change. What *can* change is the key, and a key arriving
 * late is the ordinary case rather than an edge one: the whole of a linked
 * device's history is merged and handed to the interface *before* the index it
 * arrived in has been read, so at that moment there is no key for any of it.
 * Every one of those events was decrypted to `{ undecryptable: true }` and that
 * answer was cached.
 *
 * `setKey` cleared the cache for exactly this reason. `dmKey` and `unwrapKey`
 * did not, and between them they cover every direct conversation and every
 * rekeyed server — so a freshly linked device showed the right conversations
 * full of messages it claimed it could not read, and stayed that way until the
 * app was relaunched and the cache started empty. That is the other half of
 * "you have to restart for the sync to show".
 *
 * Scoped to the community rather than clearing everything, because the two
 * callers below run once per friend at startup and dropping the whole cache
 * each time would re-decrypt every open log per friend.
 */
function installPayloadKey(community: string, key: Buffer): void {
  const existing = payloadKeys.get(community);

  // Nothing changed, so nothing cached can be wrong.
  if (existing && existing.equals(key)) return;

  payloadKeys.set(community, key);

  // The one being displaced is kept, for reading. See `pastKeys`.
  if (existing) {
    const older = pastKeys.get(community) ?? [];
    if (!older.some((k) => k.equals(existing))) {
      older.unshift(existing);
      if (older.length > PAST_KEYS_KEPT) older.length = PAST_KEYS_KEPT;
      pastKeys.set(community, older);
    }
  }

  forgetDecrypted(community);
}

/** Drop cached plaintext for one community. */
function forgetDecrypted(community: string): void {
  for (const [id, event] of decrypted) {
    if (event.community === community) decrypted.delete(id);
  }

  // Membership is read out of decrypted payloads too — who the owner is, who
  // was kicked — so a key that changes what can be read changes that answer.
  memberCache.delete(community);
}

/**
 * Communities this device knows about.
 *
 * Read from disk rather than from the open-store map: a peer may want to sync
 * something the user has not opened in the UI this session, and refusing to
 * offer it would make history quietly incomplete.
 */
/**
 * Communities that are private to this device and must never be offered to a
 * peer.
 *
 * `@index` holds the servers this account has joined, its friend list, its
 * blocks and its preferences. It was being listed like any other community,
 * so peers synced it — which merged their joined-servers and friend entries
 * into this account's own list (servers appearing twice, the user appearing on
 * their own friends list) and, far worse, handed the entire friend list to
 * everyone who connected.
 *
 * Matched by prefix rather than exact name so future private logs cannot be
 * added without opting into the same protection.
 */
const PRIVATE_PREFIX = "@";

/**
 * The last directory listing, and when it was taken.
 *
 * `knownCommunities` reads the disk. It is also asked by `servesPeer` and
 * `refusal` for every community a peer names, on every offer and every batch
 * of events — so an ordinary sync round performed dozens of synchronous
 * directory listings, and on iOS the "filesystem" is a virtual one in the same
 * JavaScript context as the interface. That is a frame dropped per listing.
 *
 * A short window rather than a permanent cache with invalidation everywhere: a
 * community appears when a directory is created, and `storeFor` is the only
 * thing that creates one, so that is the single place a stale answer is
 * cleared. The timer covers anything that manages to arrive some other way.
 */
let communityDirs: { at: number; names: string[] } | undefined;

const COMMUNITY_DIRS_TTL_MS = 3000;

function knownCommunities(): string[] {
  const now = Date.now();
  if (communityDirs && now - communityDirs.at < COMMUNITY_DIRS_TTL_MS) {
    return communityDirs.names;
  }

  const dir = join(root(), "communities");

  const names = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith(PRIVATE_PREFIX))
    : [];

  communityDirs = { at: now, names };
  return names;
}

/** Whether a peer may sync this community at all. */
function isShareable(community: string): boolean {
  return !community.startsWith(PRIVATE_PREFIX);
}

/**
 * The id of the direct conversation between two people.
 *
 * Both user ids sorted, so each side derives the same value independently and
 * a conversation exists before either has agreed to anything. Must match
 * `dmIdFor` in the client exactly — they are two halves of one convention.
 */
function dmIdFor(a: string, b: string): string {
  return "dm" + [a, b].sort().join("").slice(0, 24);
}

/**
 * Whether to accept a community we have never seen, offered by a peer.
 *
 * Only a direct conversation between us and that specific peer. Because the id
 * is derived from the two user ids, this is checkable locally — the peer
 * cannot name a conversation it is not part of, and cannot push arbitrary
 * communities onto this device.
 *
 * Without this, a first friend request could never arrive: it lives in a
 * conversation the recipient has not heard of, and sync only exchanged
 * communities both sides already held.
 */
function acceptsCommunity(community: string, peerUserId: string | undefined): boolean {
  if (!identity || !peerUserId) return false;
  if (!isShareable(community)) return false;
  return community === dmIdFor(identity.userId, peerUserId);
}

/**
 * Where the bundled Tor executable lives.
 *
 * Packaged builds get it beside the asar via `extraResource`; an unpackaged
 * run reads it from the project directory so `pnpm start` works without
 * repackaging. Absent, onion addressing is off and the app cannot reach
 * anyone — which is the intended failure, not a silent fallback to direct
 * connections.
 */
function torExecutable(): string {
  const name = process.platform === "win32" ? "tor.exe" : "tor";

  // One location per build type, populated by `npm run vendor:tor`. Probing
  // for a Tor Browser install was tempting and wrong: it works on the machine
  // that happens to have one and silently produces an unreachable app
  // everywhere else, which is the worst kind of build difference.
  return app.isPackaged
    ? join(process.resourcesPath, "tor", name)
    : join(app.getAppPath(), "vendor", "tor", name);
}

/**
 * Root directory for this device's data.
 */
function root(): string {
  return join(app.getPath("userData"), "p2p");
}

/**
 * Names this app has had, newest last.
 *
 * Electron derives `userData` from `productName`, so every rename silently
 * points the app at a fresh empty directory — the identity key and every
 * community still on disk, just somewhere it no longer looks. It presents as
 * being asked to choose a username again with all history gone, which is
 * alarming, entirely recoverable, and has now happened twice.
 *
 * Kept as a list rather than a single previous name so a device that skipped a
 * release still finds its data. Somebody upgrading straight from the Stoat
 * fork to Reaper has never had a Mayhem directory.
 */
const PREVIOUS_NAMES = ["stoat-desktop", "Mayhem"];

/**
 * Carry data over from a previous product name.
 *
 * Runs once: if the current directory already has data, nothing is touched.
 * Copied rather than moved, so a failure halfway leaves the old copy intact
 * and the worst case is disk rather than loss.
 */
function migrateFromPreviousName(): void {
  const current = app.getPath("userData");
  if (existsSync(join(current, "p2p"))) return;

  // Newest first, so a device that has both takes the more recent one.
  for (const name of [...PREVIOUS_NAMES].reverse()) {
    const previous = join(dirname(current), name);
    if (!existsSync(join(previous, "p2p"))) continue;

    try {
      cpSync(join(previous, "p2p"), join(current, "p2p"), { recursive: true });
      log("[migrate]", `carried data over from ${previous}`);
    } catch (error) {
      log("[migrate]", `could not copy from ${previous}: ${(error as Error).message}`);
    }
    return;
  }
}

/**
 * Open a community, reusing the instance if it is already open.
 *
 * Reading a log twice into two independent stores would let them diverge in
 * memory while writing to the same files, so the map is a correctness measure
 * rather than a cache.
 */
function storeFor(community: string): CommunityStore {
  const existing = stores.get(community);
  if (existing) return existing;

  if (!identity) throw new Error("p2p: identity not initialised");

  const store = new CommunityStore({
    root: root(),
    community,
    identity,

    // Both only ever read by compaction, and both are the difference between
    // it working and it quietly doing nothing. See `CommunityStoreOptions`.
    capacity: capacityOf(community),
    decrypt: (payload) => decryptPayload(community, payload),
  });
  store.open();
  stores.set(community, store);

  // A community that did not exist a moment ago now does, and the cached
  // listing above would otherwise not say so for a few seconds — during which
  // a peer offering it would be told this device has never heard of it.
  communityDirs = undefined;

  return store;
}

/**
 * Everything the renderer is allowed to see about an event.
 *
 * Currently the whole event — payloads are not yet encrypted in transit, so
 * there is nothing to withhold. Kept as an explicit function because that
 * changes: once channel keys land, decryption happens here and the renderer
 * receives plaintext it could not have obtained itself.
 */
/**
 * Events already decrypted, by id.
 *
 * ## Why this is worth the memory
 *
 * Opening a server hands the interface that community's whole log, and every
 * payload in it is sealed — so every message is an AES-GCM open and a Brotli
 * decompress. Doing that once is the cost of reading your messages. Doing it
 * again every time somebody switches tabs is not, and that is what was
 * happening: `loadCommunity` asks for the entire log on each switch, so moving
 * between two servers re-decrypted both of them, in full, on every move.
 *
 * On a desktop that runs in the main process, on a different thread from the
 * one drawing the window, and it merely wastes power. On iOS the core and the
 * interface are the same JavaScript context, so it is the thread that has to
 * produce the next frame — which is exactly the lag on changing channels.
 *
 * An event is immutable and identified by a hash of itself, so a decrypted
 * copy can never go stale. The only thing that can change the answer is a
 * community *key* arriving after the fact, and `setKey` clears this for that
 * reason.
 */
const decrypted = new Map<string, SignedEvent>();

/**
 * Roughly a large account's worth of messages.
 *
 * Bounded because this is a cache and not a second copy of the database. The
 * eviction is deliberately crude — drop the oldest quarter when full — because
 * anything cleverer would need per-entry bookkeeping on the hot path to avoid
 * a cost that only appears once the limit is reached.
 */
const DECRYPTED_LIMIT = 40_000;

function forRenderer(event: SignedEvent): SignedEvent {
  const held = decrypted.get(event.id);
  if (held) return held;

  // Decryption happens here, on the main-process side of the boundary, so the
  // renderer only ever handles plaintext it could not have obtained itself.
  const payload = decryptPayload(event.community, event.payload);

  const plain = {
    ...event,
    payload: payload as never,
  };

  // A failure with no key to blame is never cached.
  //
  // "I could not read this" is not a property of the event, it is a property of
  // what this device held at the moment it asked — and for a community with no
  // key at all, that is a state which lasts seconds. A linked device merges an
  // entire history and reads the index that unlocks it immediately afterwards;
  // caching the answer from in between turned that gap into a permanent one,
  // survivable only by restarting.
  //
  // `installPayloadKey` drops this community's entries when a key arrives, so
  // this is belt to that brace — but it is the brace that holds if some future
  // caller sets a key without going through it. Costs nothing: with no key,
  // `decryptPayload` returns before doing any cryptography at all.
  //
  // A failure *with* a key is different — it is a real, stable answer about an
  // event sealed under something this device does not have — so it is cached.
  if (
    (payload as { undecryptable?: boolean })?.undecryptable &&
    !payloadKeys.has(event.community) &&
    !pastKeys.get(event.community)?.length
  ) {
    return plain;
  }

  if (decrypted.size >= DECRYPTED_LIMIT) {
    // Map iterates in insertion order, so this drops the least recently
    // *added* rather than the least recently used. Good enough: the working
    // set is whatever community is open, and that is what was added last.
    let drop = Math.floor(DECRYPTED_LIMIT / 4);
    for (const id of decrypted.keys()) {
      decrypted.delete(id);
      if (--drop <= 0) break;
    }
  }

  decrypted.set(event.id, plain);
  return plain;
}

export function registerP2PHandlers(): void {
  // Before the keystore is touched, or it writes a new identity into the
  // empty directory and the old one is stranded for good.
  migrateFromPreviousName();

  identity = loadOrCreateIdentity(new ElectronKeystore());

  forgetOldPairPassword();

  // Public identity only. The private key never crosses this boundary.
  ipcMain.handle(CHANNEL.identity, () => ({
    userId: identity!.userId,
    publicKey: identity!.publicKey,
    // Public half only. Peers need it to derive a shared key with us.
    encPublicKey: identity!.encPublicKey,
  }));

  ipcMain.handle(CHANNEL.open, (_, community: string) => {
    const store = storeFor(community);
    return { events: store.events().length, bytes: store.size() };
  });

  ipcMain.handle(
    CHANNEL.append,
    (event, community: string, type: string, payload: unknown) => {
      const store = storeFor(community);
      const created = store.append(type, encryptPayload(community, type, payload));

      // Tell the renderer immediately rather than making it poll. The same
      // notification is what an event arriving from a peer will use, so the UI
      // has one code path for "something happened" regardless of origin.
      event.sender.send(P2P_EVENT, community, [forRenderer(created)]);

      // Your other devices care about some of this.
      //
      // Only the private index log, and only the handful of kinds another
      // device would notice the absence of — see `WORTH_SYNCING`. Read
      // receipts and window sizes change constantly and are nobody's business
      // but this machine's, and syncing on every append would keep a Tor
      // circuit permanently busy to no purpose.
      if (community === INDEX && WORTH_SYNCING.has(type)) {
        viewer = event.sender;
        changedSomethingWorthSyncing();
      }

      // ...and they care about what was actually said, which the list above
      // deliberately does not cover because none of it lives in the index.
      //
      // Narrow on purpose. Read marks, typing state and presence all pass
      // through here too and none of them is worth a circuit; what a sibling
      // notices the absence of is the half of a conversation that was typed
      // somewhere else. See `wroteSomethingSiblingsWant`.
      if (isShareable(community) &&
          (type === "message.send" || type === "message.delete")) {
        wroteSomethingSiblingsWant();
      }

      // Push straight to connected peers. Anyone offline picks it up from the
      // id exchange next time they connect, so this is a latency optimisation
      // rather than the delivery mechanism.
      if (isShareable(community)) {
        // Worked out from the plaintext, here, because this is the only place
        // it is still readable — one line later it is sealed, and a relay
        // could not tell a mention from any other message even if it wanted
        // to. Everyone named gets the push regardless of what they follow.
        const mentions = Array.isArray((payload as { mentions?: unknown })?.mentions)
          ? ((payload as { mentions: string[] }).mentions)
          : [];

        transport?.broadcast(community, [created], mentions);
      }

      return forRenderer(created);
    },
  );

  ipcMain.handle(CHANNEL.events, (_, community: string, type?: string) => {
    const events = storeFor(community).events();
    const filtered = type ? events.filter((e) => e.type === type) : events;
    return filtered.map(forRenderer);
  });

  ipcMain.handle(CHANNEL.heads, (_, community: string) =>
    storeFor(community).heads().map((head) => head.id),
  );

  ipcMain.handle(
    CHANNEL.merge,
    (event, community: string, incoming: SignedEvent[]) => {
      const store = storeFor(community);
      const result = store.merge(incoming);

      if (result.accepted.length > 0) {
        event.sender.send(P2P_EVENT, community, result.accepted.map(forRenderer));
      }

      return {
        accepted: result.accepted.length,
        rejected: result.rejected.length,
      };
    },
  );

  ipcMain.handle(CHANNEL.stats, (_, community: string) => {
    const store = storeFor(community);

    // Everything this community costs, not just its log.
    //
    // The figure used to be the compressed size of the event log alone, which
    // for a conversation full of photographs was the small half — attachments
    // live outside the log by design, so the number shown was reliably a
    // fraction of what was actually on the disk. Somebody deciding whether to
    // leave a server deserves the real total.
    const log = store.size();
    const files = blobsFor(community).size();

    return {
      userId: identity!.userId,
      events: store.events().length,
      heads: store.heads().length,
      // Kept as `bytes` for the log alone, since existing callers mean that.
      bytes: log,
      log,
      files,
      total: log + files,
    };
  });

  ipcMain.handle(CHANNEL.netStart, async (event, port: number) => {
    if (transport) return { port: transport.port, peers: transport.peers() };

    transport = new Transport(identity!.userId, {
      communities: knownCommunities,
      // Each of these is checked independently. The community list is not a
      // permission — a peer can name any id it likes, and asking for `@index`
      // directly would otherwise be answered.
      // Held *or* deliberately dropped. A compacted event is still something
      // this device is finished with, and reporting only what is on disk would
      // invite peers to send the dropped ones back.
      idsFor: (community) =>
        isShareable(community) ? storeFor(community).knownIds() : [],
      missingFor: (community, peerIds) =>
        isShareable(community) ? storeFor(community).missingFor(peerIds) : [],

      // The compact form of the same two questions. Offered only to peers that
      // said they understand it; everyone else keeps the id list above.
      summaryFor: (community) =>
        isShareable(community)
          ? storeFor(community).summary()
          : { vector: {}, extra: [] },

      missingForSummary: (community, summary) =>
        isShareable(community)
          ? storeFor(community).missingForSummary(summary)
          : [],
      accepts: acceptsCommunity,

      // Served only for communities this device shares at all. Ids travel
      // inside messages, so knowing one is not evidence of anything; being in
      // the conversation is.
      serves: servesPeer,
      reconciles,

      blobFor: (community, blob) =>
        isShareable(community) ? blobsFor(community).read(blob) : undefined,

      blobDone: (community, blob, data) => {
        if (!isShareable(community)) return;

        // Checked against the id that was asked for. The id came from a signed
        // event, so content that hashes to it is content the author put there
        // — which is what makes fetching a file from an untrusted peer safe.
        if (!blobsFor(community).accept(blob, data)) {
          log("[p2p]", `discarded ${blob.slice(0, 12)}: contents did not match its id`);
          return;
        }

        event.sender.send(P2P_BLOB, community, blob);
      },

      merge: (community, incoming) => {
        // Nothing taken and nothing held. Shaped like every other answer,
        // because the transport reads `held` off it — a bare `0` was relying
        // on the defensive read at the far end to avoid a crash that would
        // have presented as the *peer* being malformed.
        if (!isShareable(community)) return { accepted: 0, held: [] };
        const store = storeFor(community);
        const result = store.merge(incoming);

        // Reported, because a rejection is invisible from the other end: the
        // sender sees an event the peer does not list and offers it again on
        // every pass. A connection that keeps re-sending the same history is
        // usually this, and without a line in the log there is nothing to
        // point at.
        if (result.rejected.length) {
          log(
            "[p2p]",
            `${community}: refused ${result.rejected.length} event(s) — ` +
              `bad signature, or an id whose contents did not match`,
          );
          netLog.push({
            at: Date.now(),
            line: `refused ${result.rejected.length} event(s) in ${community}`,
          });
        }

        if (result.accepted.length > 0) {
          // Same channel the UI already listens on for local writes, so a
          // message from a peer and one typed here take an identical path.
          event.sender.send(P2P_EVENT, community, result.accepted.map(forRenderer));
        }

        // Everything now held out of what was offered — not only what was new.
        // The sender is asking "did this arrive", and an event they sent twice
        // arrived the first time.
        const offered = new Set(incoming.map((e) => e.id));
        const held = store.events()
          .map((e) => e.id)
          .filter((id) => offered.has(id));

        return { accepted: result.accepted.length, held };
      },

      /**
       * Why a peer is being refused.
       *
       * Deliberately coarse. "You are not in this" is enough for the other
       * side to stop retrying and repair its own state, and anything more
       * specific would be describing a membership list to somebody who has
       * just been told they are not on it.
       */
      refusal: (community, peerUserId) => {
        if (!peerUserId) return undefined;
        if (!isShareable(community)) return undefined;
        if (!stores.has(community) && !knownCommunities().includes(community)) {
          return "unknown";
        }

        const members = membersOf(community);
        if (members.size === 0) return undefined;
        return members.has(peerUserId) ? undefined : "not-a-member";
      },
    }, {
      // So a friend can tell this machine from the other one signed into the
      // same account. Without it they look like one peer that keeps opening a
      // second connection, and the duplicate rule closes one of them.
      device: thisDevice().id,
    });

    transport.on("delivered", (to: string, community: string, ids: string[]) =>
      event.sender.send(P2P_DELIVERED, to, community, ids),
    );
    transport.on("refused", (from: string, community: string, reason: string) =>
      event.sender.send(P2P_REFUSED, from, community, reason),
    );

    transport.on("peers", (peers) => event.sender.send(P2P_PEERS, peers));
    transport.on("signal", (from: string, data: unknown) =>
      event.sender.send(P2P_SIGNAL, from, data),
    );
    transport.on("audio", (channel: string, from: string, seq: number, frame: string) =>
      event.sender.send(P2P_AUDIO, channel, from, seq, frame),
    );
    transport.on("log", (line: string) => {
      log("[p2p]", line);
      // Kept for the Waiting tab. "It connected then vanished" is impossible
      // to act on; "peer went quiet — dropping" or "dropping duplicate
      // connection" says which of several quite different things happened.
      netLog.push({ at: Date.now(), line });
      if (netLog.length > 200) netLog.shift();
    });

    const listening = await transport.listen(port || 0);
    log("[p2p]", `listening on ${listening}`);

    // Publish an onion service pointing at that listener. Everything reaches
    // this device through Tor; the local port is never exposed and never
    // shared.
    //
    // LAN multicast used to run here and has been removed deliberately. It
    // worked, but it announced a local IP on the network — one fallback that
    // reveals an address undoes the property the rest of this design exists
    // to provide.
    // The device link listens before Tor is configured, because Tor has to be
    // told which local port its *second* service forwards to and it reads its
    // configuration once. Failing here is survivable: without a sync address
    // this device can still dial its siblings, it simply cannot be dialled.
    let forSync = 0;
    try {
      // Forwarding this to the *old* link service is what produced "that
      // device closed the connection" on every attempt: the address was
      // published pointing at a protocol the other end no longer speaks, so a
      // phone's frame header was read as the link's length prefix, came out
      // as garbage, and the socket was destroyed before a word was understood.
      // Two protocols reachable at one address is a bug waiting to be written,
      // which is why there is now only one.
      forSync = await openPair();
    } catch (error) {
      log("[link]", `no device link on this device: ${String(error)}`);
    }

    // Replace any client-only Tor started for linking.
    //
    // `ensureTorClient` brings Tor up before an account exists, with the
    // account service off and `targetPort` pointing at the pairing service —
    // because there is no chat transport listening yet. Leaving that instance
    // in place once there *is* one would eventually publish the account
    // address in front of the pairing protocol, which is the same "two
    // protocols, one address" fault that made every link fail. So it is
    // stopped and rebuilt against the real listener.
    if (tor?.running) {
      log("[tor]", "restarting with the chat transport in place");
      tor.stop();
    }

    tor = new TorService({
      dataDir: join(root(), "tor"),
      torPath: torExecutable(),
      targetPort: listening,
      syncPort: forSync,
      role: "account",
      account: true,
    });

    // A device that publishes has a claim on record, always.
    //
    // `holds` treats an empty ledger as "nobody has ever taken this address",
    // which is right for an account that has only ever run in one place — and
    // it means a device that has never claimed anything competes silently.
    // Two such devices both publish, both believe they are entitled to, and
    // neither has anything to compare against when they eventually meet.
    //
    // Writing one on first publish gives every device a position in the order,
    // so the first sync between them can actually decide something.
    if (!claimsHeld().length) {
      const me = thisDevice();
      addClaim(claimFor([], me.id, me.name));
      log("[p2p]", "recorded this device as the one holding the address");
    }

    // The sync address arrives a few seconds after the first one.
    tor.on("sync", (address: string) => {
      log("[link]", `this device can be reached for sync at ${address}`);
      recordSyncAddress(address);
      announceDevices();
    });

    tor.on("log", (line: string) => log("[tor]", line));

    // Published only if this device is the one that should be.
    //
    // Starting Tor unconditionally is what the app used to do, and it is wrong
    // the moment an identity exists on more than one machine: both publish a
    // descriptor for the same address, the directory keeps the newer one, and
    // which device a peer reaches changes without warning. Nothing errors.
    // Messages simply arrive somewhere else.
    //
    // A device that is not holding stays outbound-only. It can still read
    // everything and still reach people it dials; what it does not do is claim
    // to be the place to answer.
    const onion = await publishIfHolding();

    if (!onion) {
      const state = standing(claimsHeld(), thisDevice().id);
      if (state.state === "displaced") {
        log("[tor]", `${state.by.name} holds this account's address`);
      }
    }

    announceDevices();

    // The sync service, and a first pass at catching up.
    //
    // Deliberately not awaited. Publishing a second onion service takes as
    // long as the first, and startup has no business waiting on it — the app
    // is fully usable meanwhile, and everything this produces arrives as an
    // event.
    void (async () => {
      // What the other devices did while this one was closed, in the order it
      // becomes useful.
      //
      // Messages first, and on their own. On a device that has just been
      // linked this is everything it does not yet have — every conversation
      // and every server — and it is what somebody who has just signed in is
      // waiting to see. The link itself deliberately carried none of it: it
      // carried the account and the index, so the user was let in within
      // seconds, and this is the pass that fills the app underneath them.
      await syncAllDevices(undefined, "messages");
      announceDevices();

      // And take the address if whoever holds it is not actually there. Done
      // after the catch-up so the claims being judged are the current ones
      // rather than whatever this device remembered from last time.
      await repairAddress();

      // Then the pictures, once. Faces and server icons are the last thing
      // worth waiting on and the first thing that is noticed missing, so they
      // are fetched promptly but never ahead of a message.
      await syncAllDevices(undefined, "everything");
      announceDevices();

      // And from here on, without being asked.
      startSyncSchedule();
    })().catch((error: Error) => log("[link]", error.message));

    return { port: listening, peers: [], onion };
  });

  ipcMain.handle(CHANNEL.netConnect, async (_, address: string) => {
    if (!transport) throw new Error("networking not started");
    await transport.connect(address);
    return transport.peers();
  });

  ipcMain.handle(CHANNEL.netPeers, () => transport?.peers() ?? []);

  ipcMain.handle(CHANNEL.netSignal, (_, to: string, data: unknown) =>
    transport?.signal(to, data) ?? false,
  );

  ipcMain.handle(CHANNEL.netAudio, (_, channel: string, seq: number, frame: string) => {
    transport?.sendAudio(channel, seq, frame);
  });

  /**
   * Install a community's payload key, from an invite.
   */
  ipcMain.handle(CHANNEL.setKey, (_, community: string, keyBase64: string) => {
    // A key arriving changes the answer for every event of this community that
    // has already been read — they were handed over sealed, because there was
    // nothing to open them with.
    //
    // Scoped to the community now rather than clearing the whole cache. The
    // interface calls this once per community it holds, at startup and again
    // whenever a key is learned, and each of those was throwing away every
    // other community's plaintext — so opening a server and then joining a
    // second one re-decrypted the first from scratch.
    if (!keyBase64) {
      payloadKeys.delete(community);
      forgetDecrypted(community);
      return false;
    }

    const key = Buffer.from(keyBase64, "base64");
    if (key.length !== 32) return false;

    installPayloadKey(community, key);
    return true;
  });

  /**
   * Derive and install the key for a direct conversation.
   *
   * Both sides compute the same value from their own private key and the
   * other's public one, so there is nothing to transmit and nothing to
   * intercept.
   */
  ipcMain.handle(
    CHANNEL.dmKey,
    (_, community: string, theirEncPublicKey: string) => {
      if (!identity?.encPrivateKey || !theirEncPublicKey) return false;

      try {
        const secret = agree(identity.encPrivateKey, theirEncPublicKey);
        // Through `installPayloadKey`, so anything already read as
        // undecryptable stops being so. This is the one that mattered: every
        // direct conversation on a freshly linked device arrives before the
        // index that carries the key to it.
        installPayloadKey(community, deriveKey(secret, community));
        return true;
      } catch (error) {
        log("[e2ee]", `could not derive key for ${community}: ${(error as Error).message}`);
        return false;
      }
    },
  );

  /**
   * Wrap a fresh community key for each member.
   *
   * Rotation is what makes removal mean anything here. Nothing can claw back
   * events someone already holds — but a new key they never receive locks them
   * out of everything written afterwards, which is the achievable half of
   * "remove this person".
   *
   * One wrap per member, each using a key agreed with that member alone, so
   * the rotation event can be published in the open.
   */
  ipcMain.handle(
    CHANNEL.wrapKey,
    (_, community: string, members: { userId: string; ek: string }[]) => {
      if (!identity?.encPrivateKey) return null;

      const fresh = randomBytes(32);
      const wrapped: Record<string, unknown> = {};

      for (const member of members) {
        if (!member.ek) continue;
        try {
          const shared = deriveKey(
            agree(identity.encPrivateKey, member.ek),
            `rekey:${community}`,
          );
          wrapped[member.userId] = seal({ key: fresh.toString("base64") }, shared);
        } catch {
          // A member whose key we cannot use is simply left out; they will
          // ask again rather than block the rotation for everyone else.
        }
      }

      // The key being replaced is kept for reading, or this device would seal
      // the rotation event and immediately lose the ability to open everything
      // written before it.
      installPayloadKey(community, fresh);
      return { wrapped, key: fresh.toString("base64") };
    },
  );

  /**
   * Open a rotation addressed to us and install the new key.
   */
  ipcMain.handle(
    CHANNEL.unwrapKey,
    (_, community: string, fromEk: string, envelope: unknown) => {
      if (!identity?.encPrivateKey || !fromEk || !envelope) return null;

      try {
        const shared = deriveKey(
          agree(identity.encPrivateKey, fromEk),
          `rekey:${community}`,
        );
        const opened = openSealed(envelope as never, shared) as { key?: string };
        if (!opened?.key) return null;

        // A rotation is precisely a moment when what was readable and what was
        // not both change, so the cached answers for this community go.
        installPayloadKey(community, Buffer.from(opened.key, "base64"));
        return opened.key;
      } catch {
        return null;
      }
    },
  );

  ipcMain.handle(CHANNEL.netAnnounce, () => {
    transport?.announce();
  });

  // ---- server export --------------------------------------------------
  //
  // A community *is* its log, so exporting one is exporting the events. Every
  // channel, message, role, ban, rename and profile is already in there,
  // signed by whoever wrote it, and merging them back reconstructs the server
  // exactly — no schema to keep in step, and nothing to forget.
  //
  // Attachment bytes are the exception, because they were deliberately moved
  // out of the log. Small ones ride along so avatars and screenshots work
  // immediately; large ones are left out and fetched from peers on demand,
  // which is the same path any member uses. The message still shows the file
  // with its name, size and Download button either way — the metadata is in
  // the event, and only the bytes are missing.

  /** Below this a file travels with the bundle; above it, only its id does. */
  const EXPORT_BLOB_MAX = 512 * 1024;

  /** And a ceiling on the lot, so a busy server does not produce a huge file. */
  const EXPORT_BLOB_BUDGET = 16 * 1024 * 1024;

  ipcMain.handle(
    CHANNEL.exportCommunity,
    (_, community: string, seeds: string[] = []) => {
      if (!isShareable(community)) throw new Error("that conversation cannot be exported");

      const store = storeFor(community);
      const events = store.events();
      if (!events.length) throw new Error("nothing to export — this server is empty");

      // Blobs are found by reading the file references out of the events
      // rather than by listing the directory, so an export carries only what
      // this community actually refers to.
      const blobs: Record<string, string> = {};
      let budget = EXPORT_BLOB_BUDGET;
      let skipped = 0;

      const files = blobsFor(community);
      for (const event of events) {
        const payload = decryptPayload(community, event.payload) as {
          files?: { blob?: string; size?: number }[];
        } | null;
        if (!payload || !payload.files) continue;

        for (const f of payload.files) {
          if (!f.blob || blobs[f.blob]) continue;
          if ((f.size ?? 0) > EXPORT_BLOB_MAX) { skipped++; continue; }

          const data = files.read(f.blob);
          if (!data) { skipped++; continue; }
          if (data.length > budget) { skipped++; continue; }

          budget -= data.length;
          blobs[f.blob] = data.toString("base64");
        }
      }

      const key = payloadKeys.get(community);
      const bundle = {
        reaper: "server",
        v: 1,
        id: community,
        // The key travels, which makes the file the secret exactly as an
        // invite code is. Anyone holding it can read the server; anyone
        // without it cannot, including peers that relay the events.
        key: key ? key.toString("base64") : "",
        seeds,
        at: Date.now(),
        events,
        blobs,
        skipped,
      };

      // Brotli, at a quality worth paying for once. This is a file written
      // deliberately, not a frame on a hot path, and event logs are extremely
      // repetitive JSON — the same keys and the same author key on every line.
      const packed = brotliCompressSync(Buffer.from(JSON.stringify(bundle), "utf8"), {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 9,
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        },
      });

      return {
        data: packed.toString("base64"),
        events: events.length,
        files: Object.keys(blobs).length,
        skipped,
        bytes: packed.length,
      };
    },
  );

  ipcMain.handle(CHANNEL.importCommunity, (_, base64: string) => {
    let bundle: {
      reaper?: string;
      /** What the marker used to be called. Server exports predate the rename. */
      mayhem?: string;
      id?: string;
      key?: string;
      seeds?: string[];
      events?: SignedEvent[];
      blobs?: Record<string, string>;
    };

    try {
      bundle = JSON.parse(
        brotliDecompressSync(Buffer.from(base64, "base64")).toString("utf8"),
      );
    } catch {
      throw new Error("that file is not a Reaper server export, or it is damaged");
    }

    // Both markers accepted. An export made before the rename is still a
    // perfectly good server and refusing it would strand every invite already
    // handed out.
    const marker = bundle.reaper ?? bundle.mayhem;
    if (marker !== "server" || !bundle.id || !bundle.events) {
      throw new Error("that file is not a Reaper server export");
    }
    if (!isShareable(bundle.id)) throw new Error("that export names a private conversation");

    // The key first: without it the payloads merge fine but read as
    // undecryptable, and the server would import looking empty.
    if (bundle.key) installPayloadKey(bundle.id, Buffer.from(bundle.key, "base64"));

    const store = storeFor(bundle.id);
    // Signatures are checked here as they are for anything off the network.
    // A bundle is no more trusted than a peer — it is a peer's log in a file.
    const result = store.merge(bundle.events);

    let files = 0;
    if (bundle.blobs) {
      const target = blobsFor(bundle.id);
      for (const [id, data] of Object.entries(bundle.blobs)) {
        if (target.accept(id, Buffer.from(data, "base64"))) files++;
      }
    }

    log("[p2p]", `imported ${bundle.id}: ${result.accepted.length} events, ${files} files`);

    return {
      id: bundle.id,
      key: bundle.key || "",
      seeds: bundle.seeds || [],
      accepted: result.accepted.length,
      rejected: result.rejected.length,
      files,
    };
  });

  /**
   * Say which communities are worth reconciling.
   *
   * Live writes still reach every community — a `push` is sent to everyone
   * regardless — so messages continue to arrive for servers left in the
   * background. What stops is the periodic full comparison of id sets, which
   * is the part that scales badly with both history and server count.
   */
  /**
   * Every community whose log this device holds.
   *
   * Not the same as the list the interface shows. A community stays on disk
   * after it is left — an append-only log is not deleted — and the difference
   * between the two is exactly where an unfinished departure hides.
   */
  ipcMain.handle(CHANNEL.communities, () => knownCommunities());

  /**
   * Communities this device and a peer are both members of.
   *
   * Answered from the logs rather than from the interface's idea of who is
   * where, because the interface only knows about communities it has opened.
   * The question being asked is "is there any reason left to talk to this
   * person", and getting it wrong by looking in too few places means hanging
   * up on somebody there was still a conversation with.
   *
   * Direct conversations are included: two people who are no longer friends
   * still share the log of what they said, and whether that counts as a reason
   * to stay connected is the renderer's decision, not this one's.
   */
  ipcMain.handle(CHANNEL.sharedWith, (_, userId: string) => {
    if (!identity || !userId) return [];

    const shared: string[] = [];

    for (const community of knownCommunities()) {
      if (!isShareable(community)) continue;

      const members = membersOf(community);
      // An empty log says nothing about anybody. Counting it as shared would
      // pin a connection open on the strength of a directory existing.
      if (members.size === 0) continue;
      if (!members.has(identity.userId)) continue;
      if (!members.has(userId)) continue;

      shared.push(community);
    }

    return shared;
  });

  /**
   * Reclaim space from every community held on disk.
   *
   * Rewriting a log is the most destructive thing this app can do to itself —
   * there is no server holding a second copy — so it happens only when asked,
   * only where there is a real saving to be had, and each store verifies its
   * replacement before swapping it in.
   */
  ipcMain.handle(CHANNEL.compact, () => {
    let removed = 0;
    let before = 0;
    let after = 0;

    for (const community of [...knownCommunities(), INDEX]) {
      try {
        const store = storeFor(community);
        const size = store.size();
        const result = store.compact();
        if (!result) continue;

        removed += result.removed;
        before += size;
        after += store.size();
        log("[p2p]", `${community}: dropped ${result.removed} dead event(s)`);
      } catch (error) {
        // One community failing is not a reason to leave the rest bloated.
        log("[p2p]", `${community}: could not compact — ${(error as Error).message}`);
      }
    }

    return { removed, before, after };
  });

  /** Close any connection to a peer. They may dial again; this is not a ban. */
  ipcMain.handle(CHANNEL.netDrop, (_, userId: string) =>
    transport?.drop(userId) ?? false,
  );

  ipcMain.handle(CHANNEL.netFocus, (_, communities: string[]) => {
    focused = new Set(communities || []);

    // Peers are told, so they stop sending live writes for anything not in
    // the set. Suppressing our own asking saves one side of the exchange;
    // this saves the other, which is the larger half in a busy server.
    //
    // Direct conversations and groups are added unconditionally: they are
    // never suppressed locally, and leaving them out of the declaration would
    // stop peers pushing the one thing that must not wait.
    const declared = new Set(focused);
    for (const community of knownCommunities()) {
      if (community.startsWith("dm") || community.startsWith("g")) {
        declared.add(community);
      }
    }

    transport?.declareFocus([...declared]);

    // ...and immediately offer our id sets for whatever just came into focus.
    //
    // Reconciliation only happens when somebody offers, and the offers used to
    // be made once per connection, at `hello`. Suppressing background
    // communities turned that into a hole: a peer connects while a server is
    // in the background and is offered nothing for it, and opening the server
    // afterwards changed what we *would* offer without ever offering it. The
    // result was a conversation that showed live messages but had a gap
    // exactly where the connection was being established.
    //
    // Announcing here closes it: a change of focus is a reason to compare
    // notes again, and it is the only moment at which the answer changes.
    transport?.announce();
  });

  /** Frame and byte counters per wire type, plus current rates and peer RTTs. */
  /**
   * Shaping and call focus.
   *
   * Both are advisory in the sense that they only govern what this device
   * sends: there is nobody to ask for a slower stream, and asking a peer to
   * send less is what the focus declaration already does.
   */
  ipcMain.handle(
    CHANNEL.netTune,
    (
      _,
      options: {
        bytesPerSecond?: number;
        inboundBytesPerSecond?: number;
        callFocus?: boolean;
      },
    ) => {
      transport?.configure(options || {});
    },
  );

  /**
   * What Tor is bundled, and whether it looks behind.
   *
   * The comparison point is compiled in rather than fetched. Asking a server
   * "what is current" over the network, at startup, before Tor is up, would
   * leak that this app is running and would be trivially spoofable — which is
   * a poor way to decide whether to trust the binary carrying everything else.
   * A build knows what was current when it was made; anything newer than that
   * is fine, anything older is worth mentioning.
   */
  ipcMain.handle(CHANNEL.torStatus, async () => {
    const path = torExecutable();
    const version = await torVersion(path);

    return {
      path,
      version,
      // Bumped when this app is released. Deliberately conservative: warning
      // about a version that merely is not the newest would train people to
      // ignore the warning.
      expected: TOR_KNOWN_GOOD,
      stale: !!version && compareVersions(version, TOR_KNOWN_GOOD) < 0,
    };
  });

  ipcMain.handle(CHANNEL.netLog, () => netLog.slice(-60));

  ipcMain.handle(CHANNEL.netStats, () => ({
    ...wireStats(),
    peers: (transport?.peers() ?? []).map((p) => ({
      userId: p.userId, inbound: p.inbound, rtt: p.rtt,
    })),
  }));

  ipcMain.handle(CHANNEL.netStatsReset, () => {
    resetWireStats();
  });

  // ---- account backup ---------------------------------------------------
  //
  // There is no server, so there is no account to recover — the private key
  // *is* the account. Lose it and the identity is gone permanently, with no
  // reset to fall back on. That makes an export less of a convenience than a
  // basic requirement of the design.
  //
  // The bundle carries the key and this device's own index: the friends list,
  // the servers joined, profile and preferences. Community history is left
  // out deliberately. It re-syncs from peers on its own, it is the large part
  // by far, and a backup that takes minutes to write is a backup people stop
  // making. The index cannot re-sync from anywhere, which is exactly why it
  // has to travel.
  //
  // And it carries the onion service key, which is the part that was missing.
  // A friend code is `{ id, name, address, encryption key }` — the *address*
  // is in there, and the address is a public key held only in tor's service
  // directory. Restoring the signing key alone produces an account that is
  // still recognisably you in the log and that nobody can open a connection
  // to: every code handed out before points at a device that no longer
  // answers. Peers already connected relearn the new address from a
  // `peer.address` event, which is no help at all for the people who have not
  // spoken to you yet, and they are exactly the ones a friend code is for.
  //
  // The cost is stated rather than hidden: two devices holding one service key
  // both publish a descriptor for the same address, and tor resolves that by
  // whichever published last. So this is a restore, not a duplicate, and the
  // interface says so.



  // ---- your own devices -------------------------------------------------
  //
  // An identity has one onion address, because an onion address *is* a
  // keypair. Two devices holding it both publish, and peers reach whichever
  // published last — so the account works, unpredictably, in a way that reads
  // as a bad connection. See `devices.ts` for how one of them is chosen.
  //
  // Everything below exists to make that survivable rather than to pretend it
  // is not true: a device knows whether it holds the address, can take it
  // over, and can copy the whole account across the local network first, so
  // that taking over does not mean starting from nothing.

  ipcMain.handle(CHANNEL.deviceInfo, (event) => {
    viewer = event.sender;
    return deviceInfo();
  });

  ipcMain.handle(CHANNEL.deviceName, (_, name: string) => {
    const trimmed = String(name ?? "").trim().slice(0, 60);
    if (!trimmed) throw new Error("a device needs a name");

    writeDevice({ ...thisDevice(), name: trimmed });
    return deviceInfo();
  });

  /**
   * Take the address for this device.
   *
   * This is the Reconnect button, and it is also what an identity import does
   * on the way in. Deliberately the same act: both mean "answer here from now
   * on", and having two ways to express that would eventually mean two
   * different results.
   */
  ipcMain.handle(CHANNEL.deviceTakeOver, async (event, force?: boolean) => {
    viewer = event.sender;

    /**
     * Take the address without asking.
     *
     * The polite path below needs the other device to be reachable, and there
     * is a case where it never will be: it is switched off, lost, wiped, or
     * simply not coming back. Without a way through, the "signed in elsewhere"
     * screen is permanent and the account is stranded on a device that no
     * longer exists.
     *
     * Offered only after the request has been tried and nothing answered, so
     * it is a deliberate second step rather than the easy first one.
     */
    if (force) {
      const me = thisDevice();
      addClaim(claimFor(claimsHeld(), me.id, me.name));
      wantsAddress = false;

      await publishIfHolding();
      announceDevices();

      log("[pair]", "took the account address without the other device agreeing");
      return deviceInfo();
    }

    // Asked for, not taken.
    //
    // A device that is already publishing keeps the address — it has live
    // connections and a descriptor in the directory, and a number written into
    // a ledger somewhere else does not change either. So this records the
    // request and the next sync settles it: the holder stops, and only then
    // does this device start.
    //
    // The previous arrangement wrote a higher claim and started publishing
    // immediately, which is how two devices came to answer at one address with
    // neither of them wrong.
    wantsAddress = true;
    announceDevices();

    // The smallest pass there is, because settling a claim needs nothing else.
    //
    // Claims are exchanged in the greeting, before a single community is
    // offered, so the holder has already agreed by the time anything else
    // would have been transferred. This used to run a full sync — every
    // server, every conversation, every picture — to establish one boolean,
    // and the button that resolves "signed in on another device" sat on
    // "Copying across and taking over…" for as long as that took. Whatever is
    // new arrives on the schedule a moment later, from a device that is by
    // then the one answering.
    const settled = await syncAllDevices(undefined, "identity");

    if (settled.length) {
      // The other device gave it up during that exchange.
      const device = thisDevice();
      addClaim(claimFor(claimsHeld(), device.id, device.name));
      wantsAddress = false;

      await publishIfHolding();
    } else {
      // Nobody answered. The request stands and the next sync carries it,
      // rather than this device seizing an address somebody may still be
      // using.
      log("[p2p]", "no other device answered — the address stays where it is");
    }

    announceDevices();

    // And telling the device that just lost it.
    //
    // This was the missing half. Taking the address over wrote a claim into
    // *this* device's index and stopped there, so the other device carried on
    // believing it held the address and carried on publishing — two devices
    // answering at once, which is the exact situation the claim exists to
    // prevent, produced by the button that is supposed to resolve it.
    //
    // Not awaited: the other device may be switched off, and a hand-over that
    // hangs until it answers would be worse than one that completes now and
    // propagates when it can. The scheduled pass carries it either way.
    return deviceInfo();
  });

  ipcMain.handle(CHANNEL.linkOpen, async (event) => {
    viewer = event.sender;
    return { port: await openPair() };
  });

  ipcMain.handle(CHANNEL.syncDevices, async (event) => {
    viewer = event.sender;

    // Nothing to sync *with* is not the same as nothing to sync.
    //
    // The roster only gains a device once a sync has succeeded — that is when
    // the two exchange claims and addresses. So on a device that has never
    // completed one, this found nobody to dial, reported zero events, and the
    // interface said "already up to date" about an account it had never
    // compared against anything.
    const known = others(syncAddresses(), thisDevice().id);

    if (!known.length) {
      throw new Error(
        "this device has not been linked to any of your others yet — " +
        "scan or paste the sync address from the other device first",
      );
    }

    // Everything, because somebody asked for it by name. The scheduled passes
    // keep messages current on their own and pictures current every half hour;
    // pressing Sync is what somebody does when they do not want to wait for
    // either, so it is the one pass that fetches the lot.
    const failures: { name: string; error: string }[] = [];
    const done = await syncAllDevices(failures, "everything");
    announceDevices();

    if (!done.length) {
      // What each one actually said, rather than the fact that none of them
      // worked. The reasons differ from each other far more often than they
      // agree — one device switched off and one half-way through linking is a
      // completely different situation from two dead addresses — and only the
      // reason tells anybody what to do next.
      throw new Error(
        failures.length
          ? failures.map((one) => `${one.name}: ${one.error}`).join("\n")
          : `none of your ${known.length} other device(s) answered — ` +
            "they have to be running for a sync to happen",
      );
    }

    return {
      devices: done.length,
      events: done.reduce((total, one) => total + one.events, 0),
    };
  });

  /**
   * Sync with a device at an address given by hand.
   *
   * The way in for a device that is not in the roster yet — the address shown
   * on the other device, typed or scanned. Everything after this is automatic,
   * because both ends record each other on the way through.
   */
  /**
   * Produce a code for the other device to scan, and the passphrase for it.
   *
   * Both are generated here, both live only in this process, and asking again
   * replaces them — so there is never more than one live code and never a code
   * that outlives the window it was shown in.
   *
   * Needs Tor to be up, for two separate reasons that used to be one confusing
   * one. The sync address has to exist, because that is what the code points
   * at; and the client has to be usable, because the device scanning this will
   * be dialling straight back into it. Starting it here rather than waiting to
   * be asked is what makes the first code appear on a cold app at all.
   */
  ipcMain.handle(CHANNEL.pairInvite, async (event) => {
    viewer = event.sender;

    // Brings Tor up as a client and opens the listener, both idempotent. On a
    // device with no account this is the only thing that ever starts Tor —
    // `netStart` needs an identity and there is not one yet.
    await ensureTorClient();

    const onion = tor?.syncAddress;

    if (!onion) {
      throw new Error(
        "Tor has not published this device's address yet — this takes a minute " +
        "or two from a cold start. Leave this open and it will appear.",
      );
    }

    const me = thisDevice();
    const minted = pair!.mint(onion);

    log("[pair]", `offering a pairing code, good until ${new Date(minted.expiresAt).toISOString()}`);

    return {
      code: minted.code,
      password: minted.password,
      session: minted.session,
      expiresAt: minted.expiresAt,
      onion,
      name: me.name,
    };
  });

  /**
   * Withdraw a code before it expires.
   *
   * Called when the dialog closes and when the user asks for a new one, so a
   * code stops being usable the moment it stops being on screen. Without this
   * the ten-minute expiry was the only limit, and closing the window left a
   * live invite behind with nothing to show it existed.
   */
  ipcMain.handle(CHANNEL.pairRevoke, async (event, session?: string) => {
    viewer = event.sender;

    // Deliberately not opening the service. Nothing to revoke on a device
    // where it was never started, and starting it here would mean the act of
    // cancelling a code could bring up a listener.
    pair?.revoke(session ? String(session) : undefined);
    return { offering: pair?.offering() ?? [] };
  });

  /**
   * Join an account from a code scanned or pasted on this device.
   *
   * Nothing is stored. The passphrase opens the code, authorises the one
   * session, and is forgotten — every sync after this authorises with the
   * account itself, which this device is about to be given.
   */
  ipcMain.handle(CHANNEL.pairJoin, async (event, code: string, password: string) => {
    viewer = event.sender;

    const opened = openInvite(String(code ?? ""), String(password ?? ""));

    // Three failures with three different answers. Collapsing them is how
    // somebody ends up re-typing a passphrase that was never wrong, or
    // rescanning a code that scanned perfectly.
    const REFUSALS: Record<string, string> = {
      "wrong-password":
        "That passphrase does not match the code. Check it against the other device.",
      "not-an-invite":
        "That is not a Reaper pairing code. Scan the square code on your other device, " +
        "or paste the line of letters underneath it.",
      expired:
        "That code has run out. Ask the other device for a new one — codes last ten minutes.",
    };

    if (opened.ok !== true) {
      return { ok: false, error: REFUSALS[opened.reason] ?? "That code could not be read." };
    }

    try {
      const result = await joinWithInvite(opened.invite, String(password));

      // Checked before anybody is told this worked.
      //
      // The interface reloads on `ok`, because the page has to come back up as
      // the account it was just given — and if the account is not actually
      // there, what it comes back up as is a setup screen offering to make a
      // new one. That is not a cosmetic failure: accepting the offer writes a
      // second profile signed by the *linked* account's key, which is how a
      // device ends up holding the right identity while showing the wrong
      // person, and how adding the original as a friend reports it as
      // yourself.
      //
      // `claimed` asks exactly what the interface will ask a second later: is
      // there a username claim in the index, signed by the key this device now
      // holds. Anything else is reported as a failure the user can retry,
      // which is far better than a success they have to unpick.
      // What actually happened, not a second opinion about it.
      //
      // This used to re-run `claimed()` — the same log search the giving side
      // was using — so a device that had been handed nothing and a device that
      // had been handed everything could produce the same answer, and the
      // message said the account had arrived in both cases.
      //
      // `adopted` is set by the session itself, at the moment it takes an
      // account on. It cannot be true unless one was received and written.
      if (!result.adopted && needsAccount()) {
        return {
          ok: false,
          error:
            "That device did not send its account. Make sure it is signed in, " +
            "then show a new code and try again.",
        };
      }

      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  /** Sync every sibling this device knows about. */
  ipcMain.handle(CHANNEL.pairSync, async (event) => {
    viewer = event.sender;

    const me = thisDevice();
    const done: PairResult[] = [];
    const failed: { name: string; error: string }[] = [];

    for (const entry of others(syncAddresses(), me.id)) {
      try {
        done.push(await syncWithSibling(entry.onion, "everything"));
      } catch (error) {
        failed.push({ name: entry.name, error: (error as Error).message });
      }
    }

    return { done, failed };
  });

  ipcMain.handle(CHANNEL.syncWith, async (event, onion: string) => {
    viewer = event.sender;

    // A sync the user asked for takes precedence over one that was merely due.
    // Cancelling the pending pass stops the two racing each other to the same
    // address, which is how a working sync came to report a handshake failure.
    if (syncSoon) clearTimeout(syncSoon);
    syncSoon = undefined;

    const address = String(onion ?? "").trim().toLowerCase()
      .replace(/^\w+:\/\//, "").split("/")[0];

    if (!/^[a-z2-7]{56}\.onion$/.test(address)) {
      throw new Error("that is not a sync address");
    }

    // Whatever went wrong travels to the interface unchanged. There is no
    // useful generic message for this: the person is standing in front of both
    // devices and can act on "connection refused" or "wrong account", and can
    // do nothing at all with "did not answer".
    return syncOverTor(
      { device: "unknown", name: address.slice(0, 8), onion: address, at: Date.now() },
      "everything",
    );
  });

  ipcMain.handle(CHANNEL.putBlob, (_, community: string, base64: string) => {
    const data = Buffer.from(base64, "base64");
    const ref = blobsFor(community).write(data);
    return { id: ref.id, size: ref.size };
  });

  /** Bytes this device holds, or null. Never fetches. */
  ipcMain.handle(CHANNEL.getBlob, (_, community: string, id: string) => {
    const data = blobsFor(community).read(id);
    return data ? data.toString("base64") : null;
  });

  ipcMain.handle(CHANNEL.hasBlob, (_, community: string, id: string) =>
    blobsFor(community).has(id),
  );

  /**
   * Ask peers for a file.
   *
   * Deliberately separate from `getBlob`: the whole point is that reading what
   * is already here and pulling something over the network are different acts,
   * and only the second one should ever happen because someone chose it.
   */
  ipcMain.handle(CHANNEL.wantBlob, (_, community: string, id: string) => {
    if (blobsFor(community).has(id)) return true;
    if (!/^[a-f0-9]{64}$/.test(id)) return false;
    transport?.requestBlob(community, id);
    return false;
  });

  /**
   * Who attached what, per community.
   *
   * Shared by the sweep and the single-file delete, because they have to agree
   * about ownership and two readings of the same log is how they would stop
   * agreeing.
   *
   * The payload has to be decrypted to be read at all. That is not an
   * optimisation — `message.send` is sealed whenever the community has a key,
   * so the raw event carries `{ e: 1, n, c, t }` and `payload.files` is simply
   * absent. Reading it raw is why the sweep found nothing to clear and why the
   * single-file delete believed no file had ever been sent from this device:
   * one failed closed and did nothing, the other failed *open* and would have
   * deleted the last copy of something.
   */
  function attachmentsIn(community: string): {
    mine: Set<string>;
    others: Map<string, { size: number; author: string }>;
  } {
    const mine = new Set<string>();
    const others = new Map<string, { size: number; author: string }>();
    const me = identity?.userId;

    let events: readonly SignedEvent[];
    try {
      events = storeFor(community).events();
    } catch {
      return { mine, others };
    }

    for (const event of events) {
      if (event.type !== "message.send") continue;

      const payload = decryptPayload(community, event.payload) as {
        files?: { blob?: string; size?: number }[];
      } | undefined;

      for (const file of payload?.files ?? []) {
        if (!file.blob) continue;

        if (event.author === me) mine.add(file.blob);
        else if (!others.has(file.blob)) {
          others.set(file.blob, { size: file.size ?? 0, author: event.author });
        }
      }
    }

    return { mine, others };
  }

  /**
   * Whether somebody who holds this file is reachable right now.
   *
   * The point of deleting a file is that it can be fetched again. That is only
   * true while somebody who has it is online — and in a network with no server,
   * "somebody" is a specific person who may not have opened the app in a month.
   * Deleting the last reachable copy is not reclaiming space, it is losing the
   * file, and nothing would say so until it was wanted.
   *
   * Conservative in the direction that costs disk rather than data: a peer is
   * counted if they are connected and share this community. They might have
   * dropped the file themselves, which cannot be known without asking, and
   * asking every peer about every file before a sweep would be slower than the
   * sweep is worth.
   */
  function someoneHasIt(community: string, author: string): boolean {
    const peers = transport?.peers() ?? [];

    // The author, if they are here. The strongest case: they wrote the
    // message, so they had the bytes.
    if (peers.some((peer) => peer.userId === author)) return true;

    // Otherwise anybody else in the community, who will have replicated it if
    // they ever opened the conversation.
    const members = membersOf(community);
    return peers.some(
      (peer) =>
        !!peer.userId &&
        peer.userId !== identity?.userId &&
        members.has(peer.userId),
    );
  }

  /**
   * Delete downloaded files that are somebody else's and over the limit.
   *
   * Runs in the main process rather than the renderer because deciding what to
   * keep means reading and decrypting every community's log, and shipping all
   * of that across the IPC boundary to make a yes-or-no decision per file would
   * be most of the work for none of the benefit.
   *
   * Three rules, in order:
   *
   *   1. **A file this device sent is never touched.** Once it is gone from
   *      here it may be gone everywhere — there is no server holding a second
   *      copy — so the one category of file this device is uniquely
   *      responsible for is the category it must not delete.
   *   2. **Only files above the size the reader set.** That is exactly the
   *      file they said they did not want fetched.
   *   3. **Only while somebody who has it is reachable.** Otherwise it is not
   *      being reclaimed, it is being lost.
   *
   * `force` overrides the third rule, and only that one. It is what the user
   * pressing delete on a specific file means: they have been told nobody else
   * is online and they want it gone anyway. It never overrides the first.
   *
   * Avatars, icons and anything not attached to a message are left alone: they
   * are small, they are referenced by things always on screen, and re-fetching
   * them is what makes faces disappear.
   *
   * `dryRun` answers "how much would this free" without freeing it.
   */
  ipcMain.handle(
    CHANNEL.sweepBlobs,
    (_, maxBytes: number, dryRun: boolean, force?: boolean) => {
      let files = 0;
      let bytes = 0;

      // Files that would have gone but for nobody being online to re-supply
      // them. Reported so the interface can say so rather than showing a
      // sweep that mysteriously freed less than it offered to.
      let stranded = 0;
      let strandedBytes = 0;

      for (const community of knownCommunities()) {
        const { mine, others } = attachmentsIn(community);
        const blobs = blobsFor(community);

        for (const [blob, { size, author }] of others) {
          // A file somebody else also sent from this device stays. The same
          // bytes can be attached by two people — content addressing means one
          // copy — and being ours is the stronger claim.
          if (mine.has(blob)) continue;
          if (size <= maxBytes) continue;
          if (!blobs.has(blob)) continue;

          if (!force && !someoneHasIt(community, author)) {
            stranded++;
            strandedBytes += size;
            continue;
          }

          files++;
          bytes += size;
          if (!dryRun) blobs.forget(blob);
        }
      }

      return { files, bytes, stranded, strandedBytes };
    },
  );

  /**
   * Drop a single downloaded file.
   *
   * Used by the view-driven mode, which fetches a large attachment while it is
   * being looked at and lets it go afterwards, and by the delete button on an
   * individual file.
   *
   * Refuses anything this device sent, and that decision is made here rather
   * than left to the caller — a caller that gets it wrong destroys the only
   * copy, and there is no way to notice until somebody asks for the file.
   *
   * Also refuses when nobody who has it is reachable, unless `force`. The
   * view-driven path never forces: dropping a file the moment it scrolls out
   * of view is only reasonable while it can be fetched back.
   */
  ipcMain.handle(
    CHANNEL.forgetBlob,
    (_, community: string, blob: string, force?: boolean) => {
      if (!/^[a-f0-9]{64}$/.test(blob)) {
        return { dropped: false, reason: "not a file id" };
      }

      const { mine, others } = attachmentsIn(community);

      if (mine.has(blob)) {
        return { dropped: false, reason: "sent from this device" };
      }

      const held = others.get(blob);

      if (held && !force && !someoneHasIt(community, held.author)) {
        return { dropped: false, reason: "nobody online has a copy" };
      }

      blobsFor(community).forget(blob);
      return { dropped: true };
    },
  );

  ipcMain.handle(CHANNEL.netInfo, () => ({
    onion: tor?.address,
    torRunning: tor?.running ?? false,
    peers: transport?.peers() ?? [],
  }));

  ipcMain.handle(CHANNEL.close, (_, community: string) => {
    stores.get(community)?.close();
    stores.delete(community);
  });
}

/**
 * Flush every open log.
 *
 * Appends are buffered so a batch compresses usefully, which means up to a
 * couple of seconds of messages live only in memory at any moment. Without
 * this they would be lost on quit — the one case where the buffering that
 * makes storage efficient would otherwise cost data.
 */
export function shutdownP2P(): void {
  tor?.stop();
  tor = undefined;
  transport?.stop();
  transport = undefined;
  for (const store of stores.values()) store.close();
  stores.clear();
}
