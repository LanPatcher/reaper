import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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
 * other end is one of yours. That is proved with an HMAC over a nonce each side
 * chooses. No handshake ordering, no derived stream state: a greeting either
 * carries a valid proof or it does not.
 *
 * ## Two credentials, and why there are two
 *
 * There used to be one: a pairing password, typed by the user, kept in a file
 * next to the private key, and good forever on every device that had it. Three
 * things were wrong with that, and all three were things people actually hit.
 *
 * It could not be revoked. A QR code sealed with it stayed valid until the
 * password was changed — the "ten minutes" in the interface was a `setTimeout`
 * that hid the picture, and a photograph of that picture worked a week later.
 *
 * It was a file, and on iOS files are written through a debounced flush. Set a
 * password, force-quit before the flush, and the next launch reports no
 * password set — which is the "the password becomes invalid after a restart"
 * that this replaces.
 *
 * And it was the same secret for the first link and for every routine sync
 * afterwards, so the thing that had to be typed on a phone in a hurry was also
 * the thing standing between anybody who learned it and the whole account.
 *
 * So there are two now, with nothing in common but the shape of the proof:
 *
 *   - **A one-time invite.** Minted when the user asks for a code, held only in
 *     memory, carrying its own session id and a hard expiry sealed inside the
 *     QR. It is consumed by the first device that links with it and it does not
 *     survive a restart. This is the only credential a device that has never
 *     been linked can offer, and it is the only one it ever needs.
 *
 *   - **The account secret.** Derived from the account's own private key, which
 *     both devices hold *because* they linked. Nothing is typed, nothing is
 *     stored, and it is available to exactly the set of devices that already
 *     have everything it protects. Routine syncs use this.
 *
 * A greeting names which one it is using. Everything else is identical.
 *
 * ## What that buys, in the failures it removes
 *
 * Every routine sync after the first now authorises with something neither
 * device has to remember and neither user has to type. That is the whole of
 * the "my devices stopped syncing and I did not change anything" class of
 * report: there is no longer a stored credential that can go missing, differ
 * between two machines, or be half-written when the app was killed.
 *
 * And a code that has been used, replaced, or outlived its ten minutes is
 * *absent* rather than merely stale — the lookup fails, and the refusal says
 * to show a new one, which is the only thing that will actually help.
 */

/** Length prefix plus one flag byte, exactly as the chat transport frames. */
const HEADER = 5;

/** Bodies above this are compressed. Below it, Brotli costs more than it saves. */
const COMPRESS_OVER = 1024;

const FLAG_COMPRESSED = 1;

/** Nothing legitimate approaches this; it bounds a corrupt length field. */
const MAX_FRAME = 16 * 1024 * 1024;

/**
 * Events per `give`.
 *
 * Large enough that the per-message overhead disappears, small enough that
 * handling one does not monopolise the thread.
 *
 * That second half is not a nicety on a phone. There the core and the
 * interface are the same JavaScript context, so verifying a batch's signatures
 * and decompressing its frames happens on the thread that also has to draw —
 * and a batch is one task, which nothing can interrupt. Four hundred events
 * was long enough to miss frames, visibly, for as long as a sync lasted.
 *
 * A hundred costs four times as many messages on an already-open circuit,
 * which is nothing, and quarters the longest a repaint can be blocked.
 */
const BATCH = 100;

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

/**
 * The protocol this build speaks.
 *
 * Sent in the greeting and checked before anything else, because two devices
 * running different builds is a completely different problem from two devices
 * disagreeing about a password — and until this existed, it presented as the
 * latter. An older build sends messages this one does not expect, in an order
 * it does not expect, and every guard here reported that as though the peer
 * were trying to skip authorisation.
 *
 * Bumped whenever the shape of anything below changes. Three is the first
 * version where a greeting names which credential it is using.
 */
const PROTOCOL = 3;

/** How long a socket may sit idle before it is assumed dead. */
const IDLE_MS = 120_000;

/**
 * How long a minted invite is good for.
 *
 * Long enough to find your other device, unlock it, open the app and get
 * through a Tor circuit — which on a cold phone is genuinely a couple of
 * minutes. Short enough that a code left on an unattended screen stops being
 * an invitation.
 *
 * Enforced by the device that minted it, from its own clock. The expiry sealed
 * into the QR is a courtesy to the scanning device so it can say "ask for a new
 * one" without spending a circuit to be told the same thing.
 */
export const INVITE_TTL_MS = 10 * 60 * 1000;

/* ---- what a pairing invite contains ------------------------------------- */

/**
 * The payload behind a QR code.
 *
 * Deliberately tiny. A QR code holds a few hundred bytes before it becomes
 * dense enough that a phone camera struggles, and the invite has to survive
 * being photographed off a screen at an angle in bad light. So it carries the
 * address to dial, the id of the invite it belongs to, and when it stops being
 * good — and nothing else. No keys, no history, no identity material.
 * Everything of substance arrives over the connection the address opens.
 */
export interface Invite {
  /** Where to reach the device that produced this. */
  onion: string;

  /** What to call it while the pairing is in progress. */
  name: string;

  /** Salt for the password, so the same password gives a different key twice. */
  salt: string;

  /**
   * Which invite this is, as lower-case hex.
   *
   * The scanning device names it in its greeting and the device that minted it
   * looks it up. That lookup is the whole of revocation: an invite that has
   * been consumed, replaced, expired or lost to a restart is simply not there,
   * and the answer is a refusal that says so rather than a password mismatch.
   */
  session: string;

  /**
   * When this stops being accepted, in milliseconds since the epoch.
   *
   * Sealed inside the code rather than only remembered by the minting device,
   * so the scanning device can say "this code has expired, ask for a new one"
   * without spending a Tor circuit to find out. The minting device checks it
   * again anyway — a client-side check is a courtesy, not a control.
   */
  expiresAt: number;
}

/** Everything the interface needs to put a fresh invite on screen. */
export interface Minted {
  /** The text a QR code carries. */
  code: string;

  /**
   * Typed on the other device, and generated rather than chosen.
   *
   * A user-chosen password had to be stored to be useful twice, and being
   * stored is what made it outlive the moment it was for. This one exists for
   * one link, is never written down by either device, and is forgotten with
   * the invite.
   */
  password: string;

  session: string;
  expiresAt: number;
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
 * ## Why this is as small as it is
 *
 * The QR encoder in the interface is byte mode only and stops at version 6,
 * which is 134 bytes. That is not a lot, and the first version of this did not
 * fit: it carried the onion address as the 56-character text people are used
 * to seeing, plus the device name, plus separators, in base64 — and produced a
 * 175-character string the encoder refused outright.
 *
 * Three things came out of it, in order of how much they saved:
 *
 *   - **The address is stored as its 35 raw bytes**, not its 56-character
 *     spelling. Those characters are base32 of exactly those bytes plus a
 *     checksum and a version byte that can be recomputed, so writing them out
 *     costs 21 bytes to say nothing.
 *
 *   - **The device name is gone.** It was never needed here: the greeting
 *     carries it, and by the time there is anything to label the two devices
 *     are already talking. It was in the code purely so the scanning device
 *     could say who it was about to link to, which it can now say a second
 *     later with better information.
 *
 *   - **No separators and a two-character prefix**, rather than four
 *     dot-delimited fields.
 *
 * What is left is 58 bytes — a salt, the address, an expiry, a session id and a
 * tag — which is 93 characters of base32 and fits inside version 5.
 *
 * It is encrypted rather than merely signed, because an onion address is a
 * routable location and a QR code is displayed on a screen in whatever room
 * you are standing in. A photograph of it from across a café should yield
 * nothing at all, not merely nothing usable.
 */

/** Raw bytes of a v3 address: 32 of key, 2 of checksum, 1 of version. */
const ADDRESS_BYTES = 35;

const SALT_BYTES = 5;
const TAG_BYTES = 8;

/** Unix seconds, big-endian. Four bytes is good until 2106. */
const EXPIRY_BYTES = 4;

/** Enough that guessing one is not a strategy; short enough to fit. */
const SESSION_BYTES = 6;

const BODY_BYTES = ADDRESS_BYTES + EXPIRY_BYTES + SESSION_BYTES;

/** Five bytes is exactly eight base32 characters, with nothing left over. */
const PASSWORD_BYTES = 5;

/**
 * How much clock difference between two devices to tolerate.
 *
 * Phones and desktops disagree by seconds routinely and by minutes when one has
 * been asleep. Refusing a code because the scanning device thinks it is four
 * minutes later than the device that minted it would be a failure with no cause
 * a user could find, so the check is deliberately loose at both ends — the
 * minting device checks it too, against its own clock, which is the one that
 * actually decides.
 */
const CLOCK_SKEW_MS = 120_000;

/** A fresh session id, as lower-case hex. */
export function newSession(): string {
  return randomBytes(SESSION_BYTES).toString("hex");
}

/**
 * The passphrase for one invite, in the shape somebody has to type.
 *
 * Forty bits, which is far past what is reachable: a guess has to arrive over
 * a Tor circuit, against a session id the guesser does not have, within ten
 * minutes, and every attempt costs a scrypt.
 *
 * Eight unbroken characters, with no grouping. It was written `ABCD-EFGH`
 * on the theory that a break makes it easier to transcribe, and on a phone
 * that is simply one more thing to type — the keyboard has to be switched to
 * get at the hyphen, and it carries no information. `foldPassword` still
 * strips one if somebody types it out of habit.
 */
export function newPassword(): string {
  return toBase32(randomBytes(PASSWORD_BYTES));
}

/**
 * What the user typed, as the thing that was generated.
 *
 * Applied on both sides, so the key derives the same whatever shape it arrives
 * in. The two folds are the only substitutions that can be made safely: the
 * alphabet above has no `0` and no `1`, so anybody who typed one meant the
 * letter it looks like. Nothing else is guessed at — folding `8` to `B` would
 * be helpful right up until an invite legitimately contains an `8`, which this
 * alphabet cannot, but a future one might.
 */
export function foldPassword(text: string): string {
  return text
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/0/g, "O")
    .replace(/1/g, "I");
}

/**
 * Seal an invite into the text a QR code carries.
 *
 * Takes the salt rather than choosing one, because the device that shows the
 * code has to be able to derive the same key again when somebody links with it
 * — and a salt generated in here and thrown away would leave it unable to.
 * That is not hypothetical: it is exactly the shape of the bug where a code
 * scanned perfectly and then failed to authorise.
 */
export function sealInvite(
  invite: Omit<Invite, "name"> & { name?: string },
  password: string,
): string {
  const address = fromBase32(invite.onion.replace(/\.onion$/i, ""));

  if (!address || address.length !== ADDRESS_BYTES) {
    throw new Error("that is not a v3 onion address");
  }

  const session = Buffer.from(invite.session ?? "", "hex");

  if (session.length !== SESSION_BYTES) {
    throw new Error(`a session id is ${SESSION_BYTES} bytes of hex`);
  }

  const salt = fromBase32(invite.salt ?? "");

  if (!salt || salt.length !== SALT_BYTES) {
    throw new Error(`a salt is ${SALT_BYTES} bytes of base32`);
  }

  const seconds = Math.floor(invite.expiresAt / 1000);

  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 0xffffffff) {
    throw new Error("that expiry cannot be represented");
  }

  const expiry = Buffer.alloc(EXPIRY_BYTES);
  expiry.writeUInt32BE(seconds);

  const key = inviteKey(password, invite.salt);

  const body = Buffer.concat([address, expiry, session]);
  const pad = keystream(key, body.length);
  for (let at = 0; at < body.length; at++) body[at] ^= pad[at];

  // Over the salt as well as the body, so a code cannot be re-salted to turn a
  // wrong-password answer into a not-an-invite one.
  const tag = createHmac("sha256", key)
    .update(salt).update(body)
    .digest().subarray(0, TAG_BYTES);

  return "R2" + toBase32(Buffer.concat([salt, body, tag]));
}

/**
 * Mint a fresh invite: a code, the passphrase that opens it, and an expiry.
 *
 * Everything is generated here and nothing is written anywhere. The caller
 * keeps it in memory for as long as the code is on screen — see `PairService`
 * — which is what makes revocation and "gone after a restart" the same
 * mechanism rather than two.
 */
export function mintInvite(
  onion: string,
  ttlMs = INVITE_TTL_MS,
  now = Date.now(),
): Minted & { salt: string } {
  const salt = toBase32(randomBytes(SALT_BYTES));
  const session = newSession();
  const password = newPassword();
  const expiresAt = now + ttlMs;

  const code = sealInvite({ onion, salt, session, expiresAt }, password);

  return { code, password, session, salt, expiresAt };
}

/**
 * Read a QR code back, or explain why it cannot be read.
 *
 * The failures are told apart on purpose, because each has a different answer
 * and giving the wrong one is how somebody concludes the feature is broken:
 *
 *   - **not-an-invite** — the camera caught something else, or the code is from
 *     a build that speaks the old format. Scan again, or update.
 *   - **wrong-password** — the code is fine. Type the password again.
 *   - **expired** — both are fine and neither will help. Ask the other device
 *     for a new code.
 *
 * Telling someone to rescan a perfectly good code, or to re-type a perfectly
 * good password, was the previous behaviour for two of these three.
 */
export function openInvite(
  code: string,
  password: string,
  now = Date.now(),
): { ok: true; invite: Invite } | { ok: false; reason: "not-an-invite" | "wrong-password" | "expired" } {
  // Case-insensitive and space-tolerant: a scanner returns what was encoded,
  // but somebody reading it off a screen will not hold shift for ninety
  // characters and may well break it into groups.
  const text = code.trim().replace(/\s+/g, "").toUpperCase();

  if (!text.startsWith("R2")) return { ok: false, reason: "not-an-invite" };

  const raw = fromBase32(text.slice(2));
  if (!raw || raw.length < SALT_BYTES + BODY_BYTES + TAG_BYTES) {
    return { ok: false, reason: "not-an-invite" };
  }

  const salt = raw.subarray(0, SALT_BYTES);
  const body = raw.subarray(SALT_BYTES, SALT_BYTES + BODY_BYTES);
  const given = raw.subarray(SALT_BYTES + BODY_BYTES, SALT_BYTES + BODY_BYTES + TAG_BYTES);

  const key = inviteKey(password, toBase32(salt));

  const want = createHmac("sha256", key)
    .update(salt).update(body)
    .digest().subarray(0, TAG_BYTES);

  if (!timingSafeEqual(want, given)) return { ok: false, reason: "wrong-password" };

  const plain = Buffer.from(body);
  const pad = keystream(key, plain.length);
  for (let at = 0; at < plain.length; at++) plain[at] ^= pad[at];

  // The version byte is the one part of the address that is fixed, so it is
  // worth checking: a tag that verifies against a body that is not an address
  // means the format changed, not that the password was wrong.
  if (plain[ADDRESS_BYTES - 1] !== 3) return { ok: false, reason: "not-an-invite" };

  const expiresAt = plain.readUInt32BE(ADDRESS_BYTES) * 1000;

  // Reported before dialling. The device that minted this checks it again
  // against its own clock and that check is the one that decides; this one only
  // saves a Tor circuit and two minutes of waiting to be told the same thing.
  if (now > expiresAt + CLOCK_SKEW_MS) return { ok: false, reason: "expired" };

  return {
    ok: true,
    invite: {
      onion: toBase32(plain.subarray(0, ADDRESS_BYTES)).toLowerCase() + ".onion",
      // Deliberately empty. The greeting carries the real one, and inventing a
      // placeholder here would mean the interface showed a name that was never
      // the device's.
      name: "",
      salt: toBase32(salt),
      session: plain.subarray(ADDRESS_BYTES + EXPIRY_BYTES).toString("hex"),
      expiresAt,
    },
  };
}

/**
 * Key material the length of a payload.
 *
 * The password is the only secret and the salt makes it single-use, so a
 * stream built by iterating the HMAC is enough for a payload this size — and
 * it avoids the 28 bytes of nonce and tag that GCM would add to something that
 * has to fit in a photograph.
 */
function keystream(key: Buffer, length: number): Buffer {
  const pad = Buffer.alloc(length);
  let block = key;

  for (let at = 0; at < length; at += 32) {
    block = createHmac("sha256", key).update(block).digest();
    block.copy(pad, at, 0, Math.min(32, length - at));
  }

  return pad;
}

/**
 * Stretch the passphrase.
 *
 * scrypt rather than a plain hash, because this is the only thing standing
 * between a scanned code and an account. N is kept at 2^14 rather than
 * something larger: it has to run on a phone, and an invite passphrase is
 * typed once during a deliberate act with the two devices in the same room,
 * lives ten minutes, and is worth far less than a stored password would be.
 */
function inviteKey(password: string, salt: string): Buffer {
  // Both halves are folded rather than taken as typed. The salt arrives back
  // as whatever a user copied out of a code, and the password as whatever they
  // read off another screen — so a code entered in lower case, or with the
  // grouping dash left in, has to derive the same key, because a person
  // transcribing eight characters is not going to reproduce the punctuation.
  return scryptSync(foldPassword(password), `reaper-pair.${salt.toUpperCase()}`, 32, {
    N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
  });
}

/**
 * The key routine syncs authorise with.
 *
 * Not stretched, and deliberately: the input is an account's private key, so
 * there is nothing to guess and nothing a work factor would protect. What it
 * has to be is *identical on every device holding this account and derivable
 * on none other*, which a hash of the key material with a fixed label already
 * is.
 *
 * The label matters more than it looks. Without it the same bytes would be
 * usable as a proof somewhere else that also hashes the private key, and the
 * whole point of this value is that it means one thing.
 */
function accountKey(secret: string): Buffer {
  return createHash("sha256").update("reaper-pair.account\u0000").update(secret).digest();
}

/* ---- the wire ------------------------------------------------------------ */

/**
 * Which of the two credentials a greeting is authorising with.
 *
 * Named on the wire rather than inferred, because the two are indistinguishable
 * from the proof alone — an HMAC that does not verify looks the same whichever
 * key was meant — and "wrong password" and "this device is not linked to that
 * account" send somebody to do completely different things.
 */
export type Credential = "invite" | "account";

/**
 * How much of the account a session is for.
 *
 * ## Why the first one carries almost nothing
 *
 * Linking used to transfer everything in one go: the private index, every
 * server's whole log, every direct conversation, and every avatar, banner and
 * server icon — and only then did the device that was being linked find out
 * who it was. On an account of any age that is minutes of a Tor circuit, with
 * a setup screen on the other end of it and nothing to say why.
 *
 * That is the wrong order. Being signed in needs the account key and the
 * private index, and nothing else: the index is what names the user, so the
 * moment it lands the device stops being a stranger and can show itself as
 * whoever it is. Messages are what the app is *for*, but not one of them is
 * needed to get in, and making the door wait on them is what turned a link
 * into an ordeal.
 *
 *   - **identity** — the account, and the communities `essential()` names.
 *     Small, fixed, and the same size on a fresh account as on a five-year-old
 *     one. This is what a QR code buys, and what a takeover needs to settle a
 *     claim.
 *
 *   - **messages** — every server and conversation, and no pictures at all.
 *     What the scheduled pass does, in the background, from a device that is
 *     already signed in and already usable. This is the one that runs often,
 *     so it is the one that must not carry anything it does not have to.
 *
 *   - **everything** — the above plus the pictures: profile picture, banner
 *     and server icons. Nothing else has ever crossed a pairing — message
 *     attachments are excluded at a level below this, because they can be
 *     gigabytes and can be fetched from whoever sent them — so "everything"
 *     is a much smaller word here than it sounds. Run occasionally, because a
 *     face that is a few minutes out of date has cost nobody anything.
 *
 * Named in the greeting and adopted by the answering side, because both ends
 * have to agree: a session where one side offers three communities and the
 * other offers thirty is not a small sync, it is a large one with a confused
 * side.
 */
export type Scope = "identity" | "messages" | "everything";

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
      /** Absent on builds older than this one, which is itself the signal. */
      v?: number;
      device: string;
      name: string;
      onion: string;
      nonce: string;
      proof: string;
      communities: string[];

      /**
       * Which credential this side is using, once it knows.
       *
       * Absent in exactly one message: the opening greeting of the side that
       * answered the connection, which is sent before it has heard anything and
       * therefore before there is anything to name. Every greeting that carries
       * a proof carries this too.
       */
      cred?: Credential;

      /** Which invite, when `cred` is `invite`. */
      session?: string;

      /**
       * How much of the account this session is for.
       *
       * Travels with `cred` and for the same reason: it is decided by the side
       * that dialled, and the side that answered adopts it rather than
       * choosing its own. Two ends disagreeing about scope is not a smaller
       * sync — it is a full one where one side has stopped listening.
       */
      scope?: Scope;
    }
  /** Refused, with a reason worth showing someone. */
  | { t: "no"; why: string }
  /**
   * I have no account yet — send me yours.
   *
   * Sent by a device that has been linked but has never had an identity of its
   * own, which is every device on its first pairing. Without this the whole
   * feature does not work: the logs arrive, the claims arrive, and the device
   * still has no private key, so it cannot be the account and sits on the
   * setup screen with a synced copy of an account it cannot open.
   */
  | { t: "whoami" }
  /**
   * The account itself: the signing key, and the key to the onion address.
   *
   * Only ever sent to a device that has proved the pairing credential, and only
   * when it asks. It travels inside a Tor circuit to an address that device
   * learned from a code shown on this screen — so the transport is already
   * authenticated and encrypted, and this adds no second envelope over it.
   *
   * The onion key rides along because an account *is* its address: without it
   * the linked device would come up as the same identity at a different
   * address, and every friend code anyone has for you would stop working.
   */
  | { t: "iam"; identity: string; onionKey?: string }
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

/* ---- invites, while they are live --------------------------------------- */

/** One minted invite, as the device that showed it remembers it. */
interface Live {
  session: string;
  password: string;
  salt: string;
  expiresAt: number;
}

/**
 * The codes this device is currently offering.
 *
 * In memory and nowhere else, which is the entire revocation story:
 *
 *   - **Used** — removed when a pairing that presented it finishes.
 *   - **Replaced** — showing a new code drops the old one, because two live
 *     codes on one screen is a state no user asked for and cannot see.
 *   - **Expired** — swept on every lookup, so an expired code is *absent* by
 *     the time anything asks about it rather than present-and-stale.
 *   - **Restarted** — the map goes with the process.
 *
 * Every one of those turns into the same answer at the far end: this code is
 * not valid, show a new one. That is the answer the user needed in all four
 * cases and got in none of them.
 */
class Invites {
  readonly #live = new Map<string, Live>();

  /**
   * Only ever one.
   *
   * Minting drops whatever came before. The interface shows a single code at a
   * time, so a second live invite could only be one somebody had walked away
   * from — and leaving that usable is the thing the ten-minute expiry exists to
   * stop, only worse because nothing on screen refers to it.
   */
  add(entry: Live): void {
    this.#live.clear();
    this.#live.set(entry.session, entry);
  }

  find(session: string, now = Date.now()): Live | undefined {
    this.#sweep(now);
    return this.#live.get(session);
  }

  /** Forget one code, or all of them. */
  revoke(session?: string): void {
    if (session === undefined) this.#live.clear();
    else this.#live.delete(session);
  }

  list(now = Date.now()): Live[] {
    this.#sweep(now);
    return [...this.#live.values()];
  }

  #sweep(now: number): void {
    for (const [session, entry] of this.#live) {
      if (entry.expiresAt <= now) this.#live.delete(session);
    }
  }
}

/* ---- what the surrounding app has to provide ----------------------------- */

export interface PairHooks {
  /** This install. Not the user and not the machine. */
  device: string;

  /** What to call this device in a sentence. */
  name: string;

  /** This device's own sync address, so the peer can reach back. */
  onion(): string;

  /**
   * Something every device holding this account can derive, and nothing else
   * can.
   *
   * The account's private key, in practice. Returns undefined on a device that
   * has no account yet — which is not a failure but the ordinary state of the
   * device being linked, and is why an invite exists at all.
   */
  accountSecret(): string | undefined;

  communities(): string[];

  /**
   * The communities a device needs before it can be signed in at all.
   *
   * The private index, in practice — it is what carries the username, so a
   * device that has the account key and this can show itself as its owner and
   * stop looking like a fresh install. Everything else is what the app is for
   * rather than what it needs to open.
   *
   * Deliberately a hook rather than a constant in here: which log names the
   * user is the surrounding app's business, and `pair.ts` has managed not to
   * know it so far.
   */
  essential(): string[];

  summary(community: string): Summary;
  missingForSummary(community: string, summary: Summary): SignedEvent[];
  merge(community: string, events: SignedEvent[]): number;

  pictureIds(): string[];
  readPicture(id: string): Buffer | undefined;
  writePicture(id: string, bytes: Buffer): void;

  /**
   * This device's account, ready to be handed to a sibling, if it has one.
   *
   * May be asynchronous. On iOS the onion key lives behind a native call, and
   * forcing it to be synchronous there meant a promise being serialised into
   * the message where a key belonged — an account that arrived looking
   * complete and could not publish at the address it named.
   *
   * Returns undefined on a device that has nothing to give, which is how two
   * fresh devices pairing avoid handing each other empty accounts.
   */
  identity?(): PromiseLike<Account | undefined> | Account | undefined;

  /** Whether this device still needs an account of its own. */
  needsIdentity?(): boolean;

  /**
   * Take on the account that arrived.
   *
   * Called once, on a device that asked for it. Everything after this — the
   * logs, the pictures — is the same account's history, so this has to land
   * before any of it is useful.
   */
  adoptIdentity?(account: Account): PromiseLike<void> | void;

  /** Is this device the one currently answering at the account address. */
  holding(): boolean;

  /** Has the user asked to move the account address to this device. */
  wants(): boolean;

  /** The highest claim number this device knows about. */
  claimN(): number;

  /**
   * A line for the log.
   *
   * Optional, and the reason it exists is that a pairing which simply goes
   * quiet is otherwise unreadable from either end. A connection can be open,
   * carry nothing, and time out two minutes later, and neither device can say
   * whether it sent a greeting, received one, or was never reached at all —
   * which is three different faults presented as one silence.
   */
  trace?(line: string): void;

  /** A peer has proved itself; remember where it is and what it is called. */
  learn(peer: { device: string; name: string; onion: string }): void;

  /** The peer holds the address and this device asked for it. Give way. */
  yield(peer: { device: string; name: string }): void;

  /** The peer asked for the address and this device holds it. */
  asked(peer: { device: string; name: string }): void;
}

/** An account, as it travels between two of your devices. */
export interface Account {
  identity: string;
  onionKey?: string;
}

export interface PairResult {
  device: string;
  name: string;
  onion: string;
  events: number;
  pictures: number;

  /** Whether this device took on the account during this pairing. */
  adopted?: boolean;
  communities: number;
  done: boolean;

  /** What this pass was for, which decides what "done" means. */
  scope?: Scope;
}

/** How a dialling session says what it is doing and what with. */
type Offer = { scope: Scope } & (
  | { cred: "invite"; session: string; key: Buffer }
  | { cred: "account"; key: Buffer }
);

/* ---- the session --------------------------------------------------------- */

/**
 * One connection, in both directions at once.
 *
 * There is no dialler and no listener here; there is no `first` flag and no
 * lead. Whichever side opened the socket, both do the identical thing: greet,
 * then react. A session finishes when both ends have said `done`, which is the
 * only piece of sequencing in the whole protocol and is a pair of booleans
 * rather than an order.
 *
 * The one asymmetry is which side *chooses* the credential, and it is not a
 * step in the exchange: the side that dialled knows what it scanned or which
 * account it holds, and says so in every greeting it sends. The side that
 * answered adopts whatever it is told and says the same thing back. Neither
 * waits for the other to speak first.
 */
class Session {
  readonly #socket: Socket;
  readonly #hooks: PairHooks;
  readonly #invites: Invites;
  readonly #reader = new FrameReader();

  /** Ours, sent in the greeting, and what the peer must sign. */
  readonly #nonce = randomBytes(16).toString("hex");

  /**
   * The credential in force, once it is known.
   *
   * Set at construction on the side that dialled and on the first greeting on
   * the side that answered. Until it is set there is nothing to verify a proof
   * against, and a proof arriving before it is a peer that never said what it
   * was doing.
   */
  #cred?: Credential;
  #session?: string;
  #key?: Buffer;

  /**
   * How much of the account this session is for.
   *
   * Set at construction on the side that dialled and adopted from the first
   * credential-bearing greeting on the side that answered. Undefined until
   * then, which only matters to the answering side and only before it has
   * heard anything.
   */
  #scope?: Scope;

  /**
   * Whether the invite in force was looked up in *this* device's book.
   *
   * Only that device may consume it — the scanning side holds the same code but
   * has no book to remove it from, and marking it used there would mean the
   * code stayed live on the device that is actually showing it.
   */
  #minted = false;

  /**
   * How far this session got.
   *
   * Kept purely so that a connection dying early can say *where* it died.
   * "That device closed the connection" was the only thing this could report
   * for a long time, and it covers a refused password, a crash in a hook, a
   * Tor circuit collapsing and a peer that was never listening — four
   * different problems with four different answers, presented identically.
   */
  #stage: "opening" | "greeted" | "authorised" | "transferring" = "opening";

  /**
   * Whether this side has answered the peer's nonce with a proof.
   *
   * The greeting exchange used to depend on seeing the peer's *first* greeting
   * — the one with an empty proof — because that is what triggered the reply.
   * If that particular message was missed for any reason, this side never sent
   * a proof, the peer never authorised, and both sat waiting until the idle
   * timer fired two minutes later. A connection that is open, carrying
   * nothing, going nowhere.
   *
   * Keyed on having answered rather than on which greeting arrived: any
   * greeting carries a nonce, so any greeting is enough to reply to, and the
   * exchange converges from whichever ones actually turn up.
   */
  #answered = false;

  #authorised = false;
  #saidDone = false;
  #heardDone = false;
  #settled = false;

  /** Communities still expecting an `end`. */
  readonly #open = new Set<string>();

  /**
   * Messages that arrived before this side finished authorising the peer.
   *
   * ## Why these are kept rather than refused
   *
   * Authorisation is not simultaneous. Each side verifies the *other's* proof,
   * and reaching that point takes as long as scrypt takes — which on a phone
   * and a desktop is not the same length of time. So the faster side finishes,
   * decides the connection is good, and starts sending, while the slower side
   * is still deriving a key.
   *
   * Refusing that traffic is what "the device sent data before proving the
   * password" was: a guard that assumed anything arriving before authorisation
   * must be an attempt to skip it. It is not — it is the ordinary case, and it
   * happens on nearly every pairing between two devices of different speeds.
   *
   * That guard was also a contradiction. The whole point of this protocol is
   * that no message is ever "expected", and a rule that some messages may only
   * arrive after others is an ordering assumption wearing a different hat. It
   * is the same mistake the old protocol was built on, reintroduced in the
   * replacement.
   *
   * So they are held instead, and nothing is *acted on* until the proof
   * verifies — which is what the guard was actually protecting. If the proof
   * never verifies, these are dropped unread along with the connection.
   */
  readonly #pending: Wire[] = [];

  /** Pictures asked for and not yet arrived. */
  readonly #chasing = new Set<string>();

  /**
   * Whether this device has asked for an account and not yet received one.
   *
   * ## Why nothing may be written while this is true
   *
   * A community log is encrypted at rest with a key derived from this device's
   * private key — see `deriveLogKey`. That is a good property and it has one
   * sharp consequence: events written before the account arrives are encrypted
   * under the key this device is about to stop having.
   *
   * Nothing in this protocol is ordered, so `iam` arrives whenever it arrives,
   * and the `give` messages carrying the account's history routinely arrive
   * first. They were merged immediately, sealed under the throwaway key
   * generated on first launch, and then the account replaced that key. On the
   * next start the log would not decrypt, `open` moved it aside as unreadable
   * and started empty — so a device that had just been handed an account came
   * up with no profile in it and offered to create one.
   *
   * What that looked like from outside is worth writing down, because it is
   * not obviously one bug: the link "failed", the user made a new account, and
   * then friends from the *linked* account appeared in it — because the key
   * really had been adopted, and the next background sync refetched the index
   * under the right key. Trying to add the linked account as a friend then
   * reported it as the same identity, which it was.
   *
   * So arrivals are held rather than merged. This is the same mechanism as
   * `#pending` above and the same reasoning: not an expectation about what
   * comes next, just a refusal to *act* on something before acting on it is
   * safe.
   */
  #awaitingIdentity = false;

  /**
   * Events that arrived before the account did.
   *
   * Bounded, because a peer that never answers `whoami` must not be able to
   * spend this device's memory. The limit is far above anything the pass that
   * asks for an identity can produce — that pass carries the private index and
   * nothing else.
   */
  readonly #deferred: Wire[] = [];

  readonly #result: PairResult = {
    device: "", name: "", onion: "",
    events: 0, pictures: 0, communities: 0, done: false, adopted: false,
  };

  #resolve!: (value: PairResult) => void;
  #reject!: (error: Error) => void;
  #timer?: NodeJS.Timeout;

  constructor(socket: Socket, hooks: PairHooks, invites: Invites, offer?: Offer) {
    this.#socket = socket;
    this.#hooks = hooks;
    this.#invites = invites;

    if (offer) {
      this.#cred = offer.cred;
      this.#key = offer.key;
      this.#scope = offer.scope;
      if (offer.cred === "invite") this.#session = offer.session;
    }
  }

  run(): Promise<PairResult> {
    return new Promise<PairResult>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;

      this.#socket.setNoDelay(true);
      this.#touch();

      this.#hooks.trace?.("session opened");

      this.#socket.on("data", (chunk: Buffer) => {
        this.#touch();
        this.#hooks.trace?.(`<< ${chunk.length} bytes`);

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
        if (this.#result.done) { this.#settle(); return; }

        // Named by stage, because the answer differs completely between them.
        this.#fail({
          opening:
            "that device accepted the connection but never said anything — " +
            "it may be starting up, or the address may point at something else",
          greeted:
            "that device stopped after the greeting, before the code was " +
            "accepted — the code may have already been used or run out, so " +
            "show a new one on the other device",
          authorised:
            "that device disconnected just after linking, before sending " +
            "anything",
          transferring:
            "that device disconnected part-way through the transfer",
        }[this.#stage]);
      });

      // Immediately, and without waiting for anything. This is the part the
      // old protocol got wrong: there is nothing to wait for.
      this.#greet("");
    });
  }

  /** A greeting, with or without a proof, naming whatever this side knows. */
  #greet(proof: string): void {
    this.#send({
      t: "hello",
      v: PROTOCOL,
      device: this.#hooks.device,
      name: this.#hooks.name,
      onion: this.#hooks.onion(),
      nonce: this.#nonce,
      proof,
      communities: this.#hooks.communities(),
      cred: this.#cred,
      session: this.#session,
      scope: this.#scope,
    });
  }

  /**
   * Settle on a key from what the peer said it was using.
   *
   * Returns a refusal to send, or nothing when a key was found. Only ever
   * reached on the side that answered the connection — the side that dialled
   * brought its own.
   */
  #adoptCredential(msg: Wire & { t: "hello" }): string | undefined {
    if (!msg.cred) {
      return "that device did not say how it was authorising — it may be " +
        "running an older version of Reaper";
    }

    // Adopted alongside the credential, and before anything is offered. The
    // dialling side decides what this session is for; this side follows, or
    // the two spend a fast pass exchanging a slow one's worth of summaries.
    this.#scope = msg.scope ?? "everything";

    if (msg.cred === "account") {
      const secret = this.#hooks.accountSecret?.();

      if (!secret) {
        // Not a refusal of the peer — a statement about this device. A phone
        // that has never been linked has no account secret and cannot be
        // synced with; it has to be linked with a code first, and saying so is
        // the difference between a solvable problem and a mystery.
        return "this device has no account yet — link it with a pairing code first";
      }

      this.#cred = "account";
      this.#key = accountKey(secret);
      return undefined;
    }

    const live = this.#invites.find(msg.session ?? "");

    if (!live) {
      // The single most useful sentence in this file. Used, replaced, expired
      // and lost-to-a-restart all arrive here, and all four have one answer.
      return "that pairing code is no longer valid — show a new code on the " +
        "other device and scan it again";
    }

    this.#cred = "invite";
    this.#session = live.session;
    this.#key = inviteKey(live.password, live.salt);
    this.#minted = true;
    return undefined;
  }

  /**
   * The greeting is sent before the peer's nonce is known, so the proof cannot
   * be in it. It is sent as its own message the moment their nonce arrives —
   * which keeps the greeting unordered like everything else, at the cost of
   * one extra message that costs nothing on an already-open circuit.
   */
  #handle(msg: Wire): void {
    this.#hooks.trace?.(`<- ${msg.t}`);

    switch (msg.t) {
      case "hello": {
        // Before anything else, because a version mismatch makes every other
        // check meaningless — and reporting it as a credential problem sends
        // somebody to re-type a password that was never wrong.
        const theirs = msg.v ?? 0;

        if (theirs !== PROTOCOL) {
          const older = theirs < PROTOCOL;

          this.#fail(
            older
              ? "that device is running an older version of Reaper — update it and try again"
              : "this device is running an older version of Reaper — update it and try again",
          );
          return;
        }

        // The opening greeting from the answering side carries no credential,
        // and must not be treated as a peer that failed to name one.
        if (!this.#key && (msg.cred || msg.proof)) {
          const refusal = this.#adoptCredential(msg);

          // `#fail` writes the reason to the wire itself. Sending one here as
          // well put two `no` frames back to back, which a peer reading them
          // out of a single TCP chunk has to split correctly to see either —
          // and the second one carries nothing the first did not.
          if (refusal) { this.#fail(refusal); return; }
        }

        // Answer any greeting that has not been answered, whether or not it
        // carried a proof of its own. Waiting specifically for the empty one
        // is what turned a single missed message into a deadlock.
        if (!this.#answered && msg.nonce && this.#key) {
          this.#answered = true;
          this.#result.device = msg.device;
          this.#result.name = msg.name || "a device";
          this.#result.onion = msg.onion || "";
          this.#stage = "greeted";

          this.#greet(
            createHmac("sha256", this.#key)
              .update(`${this.#hooks.device}:${msg.nonce}`)
              .digest("hex"),
          );

          // Falls through rather than returning when this greeting also
          // carried a proof: one message can both ask and answer, and treating
          // it as only an ask is the other half of the same deadlock.
          if (!msg.proof) return;
        }

        if (!msg.proof) return;

        if (!this.#key) {
          // A proof against nothing. Reachable only from a peer that sent one
          // without ever naming a credential, which the check above refuses —
          // kept because the alternative is an exception inside a handler.
          this.#fail("that device sent a proof without saying what it was proving");
          return;
        }

        const expect = createHmac("sha256", this.#key)
          .update(`${msg.device}:${this.#nonce}`)
          .digest("hex");

        if (msg.proof.length !== expect.length ||
            !timingSafeEqual(Buffer.from(msg.proof), Buffer.from(expect))) {
          // Named by which credential was in force. "Wrong passphrase" and
          // "different account" send somebody to do entirely different things,
          // and the proof alone cannot tell them apart — a failed HMAC looks
          // identical either way, which is exactly why the greeting says which
          // key it meant.
          this.#fail(
            this.#cred === "invite"
              ? "that passphrase does not match the one shown on the other device"
              : "that is a different account",
          );
          return;
        }

        // One authorisation per session.
        //
        // A second valid greeting is not an attack and not a fault — a peer
        // that answered twice, or a greeting duplicated by a relay, is enough
        // — but acting on it twice is. Everything below re-adds every
        // community to `#open`, and the `end` that closed each of them the
        // first time has already been sent and will not be sent again. The
        // session would then sit waiting for messages nobody is going to
        // write, and time out two minutes later having transferred everything
        // successfully.
        if (this.#authorised) return;

        this.#authorised = true;
        this.#stage = "authorised";
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

        // What this session is actually for. Both sides compute this from the
        // same scope and the same hooks, so they offer the same set — which is
        // the property that makes a small sync small rather than lopsided.
        const scope = this.#scope ?? "everything";
        this.#result.scope = scope;

        // Offer everything in scope at once rather than one community at a
        // time. There is no ordering to preserve — each `have` names its own
        // community.
        const mine = scope === "identity"
          ? new Set(this.#hooks.essential())
          : new Set([...this.#hooks.communities(), ...msg.communities, PICTURES]);

        this.#result.communities = mine.size;

        for (const community of mine) {
          this.#open.add(community);
          this.#send({ t: "have", community, summary: this.#hooks.summary(community) });
        }

        // Before anything else that matters: a device with no account cannot
        // do anything with the history that follows. Sent in every scope,
        // because it is the entire point of the smallest one.
        // Who asks, and who answers.
        //
        // Structural, and deliberately not inferred from anything. The device
        // that showed the code looked that invite up in its own book — that is
        // what `#minted` means — so it is the device somebody is standing in
        // front of, signed in, choosing to link another one. The device that
        // scanned is the one being linked. There is no ambiguity to resolve
        // and nothing to guess at.
        //
        // It was guessed at, and that is what broke linking: the giving side
        // decided whether it had an account by looking for a username claim in
        // its own index, and when that lookup came back false — for any reason
        // at all — it answered `whoami` with nothing. The scanning device then
        // adopted nothing, kept the throwaway key it had generated on first
        // launch, and sat on the setup screen. Worse, the index *did* sync, so
        // the claims arrived and the phone cheerfully reported being signed in
        // on the other device: every symptom of a link that worked, except the
        // one that mattered.
        if (this.#hooks.needsIdentity?.() && !this.#minted) {
          this.#open.add("@identity");

          // Set before the ask, not after the answer. Everything that arrives
          // from here until `iam` has been applied is held rather than written,
          // because writing it would seal it under a key this device is about
          // to replace.
          this.#awaitingIdentity = true;
          this.#send({ t: "whoami" });
        }

        // Pictures only when they were asked for. This is the one part of a
        // sync whose size does not shrink once both sides have caught up — a
        // list of every avatar, on every pass, to establish that nothing has
        // changed — so the pass that runs every few minutes does not do it.
        if (scope === "everything") {
          this.#send({ t: "pics", ids: this.#hooks.pictureIds() });
        }

        // Anything that arrived while this side was still deriving its key.
        // Drained here, in arrival order, now that acting on it is safe.
        const held = this.#pending.splice(0, this.#pending.length);
        for (const early of held) this.#handle(early);

        this.#maybeDone();
        return;
      }

      case "no":
        this.#fail(msg.why || "that device refused");
        return;

      default:
        // Everything below needs the peer to have proved itself. Reaching here
        // unauthorised is not a protocol slip to be tolerated — it is someone
        // who found the address trying to skip the credential.
        if (!this.#authorised) {
          // Bounded, so a peer that never proves itself cannot use this to
          // spend memory. The limit is far above anything an honest opening
          // exchange produces — a claim, a summary per community, and a
          // picture list.
          if (this.#pending.length >= 256) {
            this.#fail("that device sent too much before proving the code");
            return;
          }

          this.#pending.push(msg);
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
        this.#stage = "transferring";

        // Held, not dropped. See `#awaitingIdentity`: merging now would write
        // this account's history to disk under the key this device is about to
        // stop having, and it would be unreadable by the time anything looked
        // for it.
        if (this.#awaitingIdentity) { this.#hold(msg); return; }

        this.#result.events += this.#hooks.merge(msg.community, msg.events);
        return;

      case "end":
        this.#open.delete(msg.community);
        this.#maybeDone();
        return;

      case "pics": {
        // A peer offering pictures in a scope that did not ask for them is
        // either out of step or a build that predates scopes. Ignored rather
        // than acted on: fetching them would quietly turn the fast pass back
        // into the slow one, which is the failure this exists to prevent and
        // would be invisible from here.
        if ((this.#scope ?? "everything") !== "everything") {
          this.#hooks.trace?.("ignoring an offer of pictures — this pass is not for them");
          return;
        }

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
        // Same reason as `give`. A picture is written through the blob store
        // rather than the log, but a device still waiting for its account has
        // no settled place to put anything.
        if (this.#awaitingIdentity) { this.#hold(msg); return; }

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

      case "whoami": {
        // Declined only by a device that is itself waiting for one.
        //
        // Read off this session rather than out of a log, and that distinction
        // is the whole repair. `#awaitingIdentity` is true exactly when *this*
        // device sent `whoami` — a fact about what happened on this connection
        // a moment ago, which cannot come back wrong. The previous version
        // asked a heuristic whether this device had an account worth sending,
        // and when the heuristic said no, the device answered "I have none" to
        // the one question linking exists to answer.
        //
        // A device showing a code can never be in this state: it does not ask,
        // because `#minted` says it is the one being linked *from*. So the
        // ordinary flow — signed in on one screen, scanning on the other —
        // gives unconditionally, whatever any log search would have said.
        if (this.#awaitingIdentity) {
          this.#hooks.trace?.("asked for an account while waiting for one — declining");
          this.#send({ t: "iam", identity: "" });
          return;
        }

        // Resolved rather than read, because on iOS the onion key comes back
        // from a native call. Nothing waits on this: the protocol has no
        // ordering, so an answer that arrives three messages later is as good
        // as one that arrives immediately.
        void Promise.resolve(this.#hooks.identity?.()).then(
          (account) => {
            if (!account) {
              // Nothing to give. Said rather than ignored, so the asking device
              // stops waiting for it — two devices that both have nothing would
              // otherwise sit until the idle timer.
              this.#send({ t: "iam", identity: "" });
              return;
            }

            this.#send({ t: "iam", identity: account.identity, onionKey: account.onionKey });
          },
          (error: Error) => {
            this.#hooks.trace?.(`could not read this device's account: ${error.message}`);
            this.#send({ t: "iam", identity: "" });
          },
        );

        return;
      }

      case "iam": {
        this.#open.delete("@identity");

        if (!msg.identity) {
          // Nothing to take on. The peer is a device with no account of its
          // own, which is two fresh devices meeting. Whatever was held is
          // written under the key this device already had, which is the right
          // one — there is no replacement coming.
          this.#hooks.trace?.("that device has no account to share");
          this.#settleIdentity();
          this.#maybeDone();
          return;
        }

        void Promise.resolve(
          this.#hooks.adoptIdentity?.({
            identity: msg.identity,
            onionKey: msg.onionKey,
          }),
        ).then(
          () => {
            this.#result.adopted = true;

            // Only now. Everything held above is written from here on with the
            // account's own key, which is the key that will still be here when
            // somebody next opens the app.
            this.#settleIdentity();
            this.#maybeDone();
          },
          (error: Error) => {
            this.#fail(`could not take on the account: ${error.message}`);
          },
        );

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
   * Hold an arrival until this device knows which key to seal it with.
   *
   * Bounded. A peer that answers `whoami` with silence must not be able to
   * grow this without limit — and the honest thing when the limit is reached
   * is to give up rather than to start writing under a key that is about to be
   * replaced, which is the failure being prevented.
   */
  #hold(message: Wire): void {
    if (this.#deferred.length >= 4096) {
      this.#fail(
        "that device kept sending history without ever sending the account — " +
        "nothing could be saved, so nothing was",
      );
      return;
    }

    this.#deferred.push(message);
  }

  /**
   * The account question is settled; write what was waiting on it.
   *
   * Drained in arrival order through the ordinary handler, so there is one
   * code path for an event that waited and an event that did not.
   */
  #settleIdentity(): void {
    if (!this.#awaitingIdentity) return;
    this.#awaitingIdentity = false;

    const held = this.#deferred.splice(0, this.#deferred.length);
    if (held.length) {
      this.#hooks.trace?.(`writing ${held.length} message(s) held for the account`);
    }

    for (const message of held) this.#handle(message);
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

      // Spent, and only now.
      //
      // Deliberately not at the moment the proof verified. A code burnt on
      // authorisation is gone even when the transfer that followed it failed
      // — so a link interrupted by a dropped circuit would leave the user
      // holding a code that no longer works and no indication why. This way a
      // failed attempt can simply be retried, and only a link that actually
      // completed uses the code up.
      if (this.#minted && this.#session) {
        this.#invites.revoke(this.#session);
        this.#hooks.trace?.("that pairing code has been used and is now spent");
      }

      this.#socket.end();
      this.#settle();
    }
  }

  #send(message: Wire): void {
    if (this.#socket.destroyed) {
      this.#hooks.trace?.(`-> ${message.t} dropped: socket already closed`);
      return;
    }

    this.#hooks.trace?.(`-> ${message.t}`);
    this.#socket.write(frame(message));
  }

  #touch(): void {
    if (this.#timer) clearTimeout(this.#timer);

    // Restarted by traffic rather than set once for the whole session. A large
    // account over a slow circuit takes as long as it takes; silence is the
    // thing worth giving up on.
    this.#timer = setTimeout(() => {
      // Named by stage, like the close is. "Timed out" alone cannot tell
      // "nothing ever arrived" from "it stopped halfway", and those have
      // different causes.
      this.#fail(
        this.#stage === "opening"
          ? "timed out: the connection opened but that device never sent anything — " +
            "it may not be running the pairing service on the address published"
          : `timed out after ${this.#stage}`,
      );
    }, IDLE_MS);
  }

  #settle(): void {
    if (this.#settled) return;
    this.#settled = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#resolve(this.#result);
  }

  /**
   * Give up, and say so to both sides.
   *
   * The `no` is the part worth having. Without it a session that failed here —
   * a hook that threw, a code that did not match, a frame that would not parse
   * — simply stopped writing, and the peer learned only that a socket had
   * closed. Both devices then reported "the other one hung up", which is true
   * of exactly one of them and useless on both.
   *
   * Sent before destroying, and only when this side has not already refused,
   * so the reason survives the trip.
   */
  #fail(why: string): void {
    if (this.#settled) return;
    this.#settled = true;
    if (this.#timer) clearTimeout(this.#timer);

    if (!this.#socket.destroyed) {
      try {
        this.#socket.write(frame({ t: "no", why }));

        // Half-close rather than destroy, so the bytes just written are
        // actually flushed — `destroy` discards anything still buffered, which
        // is how the explanation kept getting lost.
        // Guarded, because this runs inside the handler for something that
        // has already gone wrong. A platform whose socket lacks `end` — as the
        // iOS shim did — turns every failure into a crash *in the reporting*,
        // which is strictly worse than the failure being reported.
        if (typeof this.#socket.end === "function") this.#socket.end();
        else this.#socket.destroy();

        // But not indefinitely. A peer that has already gone will never
        // acknowledge the close, and a half-closed socket waiting for it is an
        // open handle that keeps the process alive. Given a moment to flush,
        // then dropped; the timer is unref'd so it is never itself the reason
        // anything stays up.
        const shut = setTimeout(() => this.#socket.destroy(), 250);
        shut.unref?.();
      } catch {
        // Nothing to be done; the message below is still reported locally.
      }
    }

    this.#reject(new Error(why));
  }
}

/* ---- the service --------------------------------------------------------- */

/**
 * Listens for siblings, runs a session over any socket handed to it, and holds
 * whatever invites are currently on screen.
 *
 * It does not dial. Opening a Tor circuit belongs to the code that knows what
 * an onion address is, and keeping that out of here is what lets the same
 * class run on a phone, where the socket comes from a native plugin.
 */
export class PairService extends EventEmitter {
  readonly #hooks: PairHooks;
  readonly #invites = new Invites();
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
      this.answer(socket)
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

  /**
   * Run an answering session over a socket somebody else accepted.
   *
   * The side that answers never chooses a credential — it adopts whatever the
   * dialling side names, which is why this takes nothing but the socket. Used
   * by `open` above, and by the tests that put a phone's socket on one end of
   * a real connection without going through a server.
   */
  answer(socket: Socket): Promise<PairResult> {
    return new Session(socket, this.#hooks, this.#invites).run();
  }

  /**
   * Offer a fresh code, dropping whatever was offered before.
   *
   * The passphrase is returned so the interface can show it. It is never
   * written down, never reused, and is gone the moment the invite is revoked,
   * used or expires.
   */
  mint(onion: string, ttlMs = INVITE_TTL_MS): Minted {
    const minted = mintInvite(onion, ttlMs);

    this.#invites.add({
      session: minted.session,
      password: minted.password,
      salt: minted.salt,
      expiresAt: minted.expiresAt,
    });

    return {
      code: minted.code,
      password: minted.password,
      session: minted.session,
      expiresAt: minted.expiresAt,
    };
  }

  /** Withdraw one code, or every code this device is offering. */
  revoke(session?: string): void {
    this.#invites.revoke(session);
  }

  /** Which codes are still live, for an interface that has to say so. */
  offering(): { session: string; expiresAt: number }[] {
    return this.#invites.list().map(({ session, expiresAt }) => ({ session, expiresAt }));
  }

  /**
   * Link to a device using a code scanned or pasted here.
   *
   * The socket is dialled by the caller — see `pairOverTor` — because opening
   * a Tor circuit is not this class's business on either platform.
   */
  join(socket: Socket, invite: Invite, password: string): Promise<PairResult> {
    return new Session(socket, this.#hooks, this.#invites, {
      cred: "invite",
      session: invite.session,
      key: inviteKey(password, invite.salt),

      // The account and the index, and nothing else.
      //
      // This is the pass somebody is watching. Everything the app is *for*
      // arrives afterwards, in the background, from a device that is by then
      // signed in and usable — and it arrives quickly, because the thing that
      // used to make it slow was doing it before letting anybody in.
      scope: "identity",
    }).run();
  }

  /**
   * Catch up with a device already linked to this account.
   *
   * Needs no code and no typing, because both devices hold the account — which
   * is the whole reason the first link hands the identity over.
   */
  sync(socket: Socket, scope: Scope = "messages"): Promise<PairResult> {
    const secret = this.#hooks.accountSecret();

    if (!secret) {
      // Refused here rather than on the wire, because there is nothing to say
      // to the peer: this device has no account, so it has nothing to prove
      // and nothing to sync. It needs linking with a code first.
      socket.destroy();

      return Promise.reject(new Error(
        "this device is not linked to an account yet — scan a pairing code from " +
        "one of your other devices first",
      ));
    }

    return new Session(socket, this.#hooks, this.#invites, {
      cred: "account",
      key: accountKey(secret),
      scope,
    }).run();
  }

  async close(): Promise<void> {
    this.#invites.revoke();

    const server = this.#server;
    if (!server) return;

    this.#server = undefined;
    this.#port = undefined;

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
