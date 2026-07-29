import { createHash, randomBytes } from "node:crypto";
import { createServer, Socket } from "node:net";

import type { SignedEvent } from "./events";
import {
  INVITE_TTL_MS,
  PICTURES,
  PairService,
  foldPassword,
  mintInvite,
  openInvite,
  sealInvite,
  type PairHooks,
} from "./pair";
import { summarise, type Summary } from "./vector";

/**
 * Pairing two of your own devices.
 *
 * The previous protocol passed every test in its own file and failed every
 * time on a real phone, so the tests that matter most here are the ones that
 * make the transport behave badly on purpose:
 *
 *   - **A connection that batches**, because Tor hands over whatever is ready
 *     in one piece and the old reader could not survive a message boundary
 *     falling anywhere but where it expected.
 *   - **A connection that splits every write into single bytes**, which is the
 *     same fault from the other side and the one a length-prefixed reader is
 *     supposed to be immune to.
 *   - **Both directions**, from each end, because a QR code is shown by one
 *     device and scanned by the other and the sync after it has to work
 *     starting from either.
 *
 * And, since the credential was split in two, the states an invite can be in.
 * Used, replaced, expired and lost-to-a-restart all have to produce a refusal
 * that says to show a new code — that sentence is the entire user-visible
 * difference between this design and the password file it replaced.
 */

let failures = 0;
const ck = (name: string, ok: boolean, extra = "") => {
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (extra ? "  " + extra : ""));
  if (!ok) failures++;
};

let counter = 0;
function event(body: string): SignedEvent {
  counter++;
  return {
    id: createHash("sha256").update(body + counter).digest("hex"),
    author: "someone",
    community: "@index",
    type: "note",
    body: { text: body },
    at: 1000 + counter,
    parents: [],
    sig: "x",
  } as unknown as SignedEvent;
}

/** A real v3 address: 32 bytes of key, 2 of checksum, then the version byte. */
function address(): string {
  const raw = Buffer.concat([randomBytes(34), Buffer.from([3])]);
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  let bits = 0, value = 0, spelled = "";
  for (const byte of raw) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { spelled += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }

  return spelled.toLowerCase() + ".onion";
}

/** A device, in memory, with just enough behind it to be synced. */
function device(name: string, onion: string, hasAccount = true) {
  let account: string | undefined = hasAccount ? `{"userId":"u-${name}"}` : undefined;
  let adoptedKey: string | undefined;
  const logs = new Map<string, SignedEvent[]>();
  const pictures = new Map<string, Buffer>();
  const learned: { device: string; name: string; onion: string }[] = [];

  const id = randomBytes(8).toString("hex");

  const hooks: PairHooks = {
    device: id,
    name,
    onion: () => onion,

    // The account itself, which is what every sync after the first authorises
    // with. Two devices holding the same account derive the same secret and
    // nothing is typed or stored to make that true.
    accountSecret: () => account,

    communities: () => [...logs.keys()],

    // What the real bridge returns: the private index, which is what names the
    // user and therefore what a device needs before it can be signed in.
    essential: () => ["@index"],

    summary: (community) => summarise(logs.get(community) ?? []),

    missingForSummary: (community, summary) => {
      const held = logs.get(community) ?? [];
      const have = new Set(Object.keys(summary?.extra ?? {}));
      return held.filter((e) => !have.has(e.id));
    },

    merge: (community, events) => {
      const held = logs.get(community) ?? [];
      const seen = new Set(held.map((e) => e.id));
      let added = 0;

      for (const e of events) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        held.push(e);
        added++;
      }

      logs.set(community, held);
      return added;
    },

    pictureIds: () => [...pictures.keys()],
    readPicture: (pid) => pictures.get(pid),
    writePicture: (pid, bytes) => { pictures.set(pid, bytes); },

    holding: () => false,
    wants: () => false,
    claimN: () => 0,

    identity: () => account ? { identity: account, onionKey: "AAEC" } : undefined,
    needsIdentity: () => !account,
    adoptIdentity: (given) => { account = given.identity; adoptedKey = given.onionKey; },

    learn: (peer) => { learned.push(peer); },
    yield: () => {},
    asked: () => {},
  };

  return {
    id, name, logs, pictures, learned, hooks,
    get account() { return account; },
    get adoptedKey() { return adoptedKey; },
  };
}

/**
 * A relay that mangles the stream without changing its contents.
 *
 * `batch` holds everything for a fixed tick and forwards it as one write, the
 * way a Tor circuit does. `drip` does the opposite and forwards one byte at a
 * time. A correct reader cannot tell either of them from a direct connection.
 */
async function relay(port: number, mode: "batch" | "drip"): Promise<number> {
  const server = createServer((near) => {
    const far = new Socket();
    far.connect(port, "127.0.0.1");

    const pump = (from: Socket, to: Socket) => {
      let held: Buffer[] = [];

      from.on("data", (chunk: Buffer) => {
        if (mode === "drip") {
          for (const byte of chunk) to.write(Buffer.from([byte]));
          return;
        }
        held.push(chunk);
      });

      const tick = mode === "batch"
        ? setInterval(() => {
            if (!held.length) return;
            const batch = Buffer.concat(held);
            held = [];
            to.write(batch);
          }, 20)
        : undefined;

      from.on("error", () => {});
      from.on("close", () => {
        setTimeout(() => { if (tick) clearInterval(tick); to.end(); }, 80);
      });
    };

    pump(near, far);
    pump(far, near);
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  return (server.address() as { port: number }).port;
}

async function connect(port: number): Promise<Socket> {
  const socket = new Socket();

  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(port, "127.0.0.1", () => resolve());
  });

  return socket;
}

/* ---- the invite ---------------------------------------------------------- */

{
  const onion = address();
  const minted = mintInvite(onion);
  const code = minted.code;

  // The interface's encoder is byte mode and stops at version 6 — 134 bytes.
  // A sealed invite is 58 bytes of payload, which is 93 characters of base32
  // plus the two-character prefix, and fits inside version 5 with room left.
  //
  // The bound used to say 80, which is version 4, and no invite this format
  // has ever produced was that short. It went unnoticed because this file was
  // not in the test runner — so the one assertion guarding the size of the
  // thing a phone camera has to read was failing silently for as long as it
  // had existed.
  ck("an invite fits inside a version 5 QR code", code.length <= 106, `${code.length} chars`);
  ck(
    "and stays inside the QR alphanumeric set, so it scans at low density",
    /^[0-9A-Z $%*+\-.\/:]+$/.test(code),
    code.slice(0, 24),
  );
  ck(
    "and survives being typed in lower case",
    openInvite(code.toLowerCase(), minted.password).ok,
  );
  ck("and does not contain the address in the clear", !code.includes(onion));

  const opened = openInvite(code, minted.password);
  ck("the passphrase it was minted with opens it", opened.ok);
  ck("and gets the address back", opened.ok && opened.invite.onion === onion);
  ck(
    "and the session id, which is what makes it revocable",
    opened.ok && opened.invite.session === minted.session,
  );
  ck(
    "and leaves the name to the greeting rather than inventing one",
    opened.ok && opened.invite.name === "",
  );
  ck(
    "and tolerates spaces from someone reading it aloud",
    openInvite(code.slice(0, 20) + " " + code.slice(20), minted.password).ok,
  );

  // The passphrase is shown grouped and typed back by a human. Every plausible
  // transcription of it has to derive the same key, or the failure lands on a
  // person who copied it correctly.
  ck(
    "the passphrase has no punctuation to mistype",
    !minted.password.includes("-"),
    minted.password,
  );
  ck(
    "and a dash typed out of habit is ignored",
    openInvite(code, `${minted.password.slice(0, 4)}-${minted.password.slice(4)}`).ok,
  );
  ck(
    "and it works in lower case",
    openInvite(code, minted.password.toLowerCase()).ok,
  );
  ck(
    "and with a zero typed where the letter O belongs",
    openInvite(code, minted.password.replace(/O/g, "0")).ok,
  );
  ck(
    "and a one where the letter I belongs",
    openInvite(code, minted.password.replace(/I/g, "1")).ok,
  );
  ck(
    "and the passphrase itself has no ambiguous characters in it",
    /^[A-Z2-7]{8}$/.test(minted.password),
    minted.password,
  );

  const wrong = openInvite(code, "AAAAAAAA");
  ck("a different passphrase does not open it", !wrong.ok);
  ck(
    "and says so, rather than blaming the camera",
    wrong.ok !== true && wrong.reason === "wrong-password",
  );

  const junk = openInvite("https://example.com", minted.password);
  ck(
    "something that is not an invite is told apart from a bad passphrase",
    junk.ok !== true && junk.reason === "not-an-invite",
  );

  // Told apart from both of the above, because neither answer helps: the code
  // is genuine and the passphrase is right, and the only thing that works is a
  // new code from the other device.
  const old = mintInvite(onion, INVITE_TTL_MS, Date.now() - INVITE_TTL_MS - 600_000);
  const lapsed = openInvite(old.code, old.password);
  ck(
    "a code that has run out says so before a circuit is spent on it",
    lapsed.ok !== true && lapsed.reason === "expired",
  );

  const again = mintInvite(onion);
  ck("two invites for the same address look nothing alike", again.code !== code);
  ck("and carry different session ids", again.session !== minted.session);
  ck("and different passphrases", again.password !== minted.password);

  // The salt has to survive the round trip, or the device showing the code
  // cannot derive the key it sealed with. Sealing with a salt generated inside
  // `sealInvite` and thrown away is the shape of bug where a code scans
  // perfectly and then fails to authorise.
  const resealed = sealInvite(
    { onion, salt: minted.salt, session: minted.session, expiresAt: minted.expiresAt },
    minted.password,
  );
  ck("sealing the same invite twice is deterministic", resealed === code);

  ck("folding a passphrase is idempotent",
     foldPassword(foldPassword(minted.password)) === foldPassword(minted.password));
}

/* ---- pairing ------------------------------------------------------------- */

/**
 * One pairing, over a connection that behaves as badly as the mode says.
 *
 * `reversed` swaps which device shows the code, because a QR code is shown by
 * one device and scanned by the other and both arrangements have to work.
 */
async function pairs(mode: "direct" | "batch" | "drip", reversed: boolean) {
  const desktop = device("Ray's desktop", "d".repeat(56) + ".onion");
  const phone = device("Ray's phone", "p".repeat(56) + ".onion");

  // Already linked, which is the state this exercises: the full pass, with
  // everything in it, over a connection doing its worst. The *first* link is
  // deliberately tiny and is covered above; this is the one that has volume to
  // mangle, and volume is what a length-prefixed reader has to survive.
  phone.hooks.accountSecret = () => desktop.hooks.accountSecret();

  desktop.logs.set("@index", [event("a friend"), event("a server")]);
  desktop.logs.set("srv_one", [event("a message")]);
  phone.logs.set("@index", [event("something only the phone has")]);

  const avatar = randomBytes(3_000);
  const avatarId = createHash("sha256").update(avatar).digest("hex");
  desktop.pictures.set(avatarId, avatar);
  desktop.logs.set(PICTURES, [event("an avatar")]);

  // Either device can start a sync, so run it from each end.
  const [listens, dials] = reversed ? [desktop, phone] : [phone, desktop];

  const listener = new PairService(listens.hooks);
  const direct = await listener.open();
  const port = mode === "direct" ? direct : await relay(direct, mode);

  let result;
  let failed = "";

  try {
    result = await new PairService(dials.hooks)
      .sync(await connect(port), "everything");
  } catch (error) {
    failed = (error as Error).message;
  }

  const label = `${mode}${reversed ? ", reversed" : ""}`;

  ck(`syncs over a ${label} connection`, !failed, failed);
  ck(`  and both sides finish`, Boolean(result?.done));

  ck(
    `  and the private index converged`,
    (phone.logs.get("@index") ?? []).length === 3 &&
      (desktop.logs.get("@index") ?? []).length === 3,
    `${(phone.logs.get("@index") ?? []).length} / ${(desktop.logs.get("@index") ?? []).length}`,
  );

  ck(
    `  and the server came across`,
    (phone.logs.get("srv_one") ?? []).length === 1,
  );

  ck(`  and the avatar did too`, phone.pictures.has(avatarId));

  ck(
    `  and each learned where the other is`,
    desktop.learned.some((p) => p.onion === phone.hooks.onion()) &&
      phone.learned.some((p) => p.onion === desktop.hooks.onion()),
    `${desktop.learned.length} / ${phone.learned.length}`,
  );

  await listener.close();
}

for (const mode of ["direct", "batch", "drip"] as const) {
  await pairs(mode, false);
}

// Either device can start a sync, so run it the other way round too.
await pairs("batch", true);

/**
 * And the first link survives the same transport.
 *
 * Small, but not trivially small — it still carries an account, an index and a
 * frame boundary that can fall anywhere. A reader that only works on a direct
 * connection would pass every assertion above and fail on the one pass a user
 * actually watches.
 */
{
  const desktop = device("desktop", "d".repeat(56) + ".onion");
  const fresh = device("phone", "p".repeat(56) + ".onion", false);

  desktop.logs.set("@index", [event("a friend")]);

  const listener = new PairService(desktop.hooks);
  const direct = await listener.open();
  const port = await relay(direct, "drip");

  const minted = listener.mint(address());
  const opened = openInvite(minted.code, minted.password);

  let failed = "";
  let result;

  try {
    if (opened.ok !== true) throw new Error("the minted code did not open");
    result = await new PairService(fresh.hooks)
      .join(await connect(port), opened.invite, minted.password);
  } catch (error) {
    failed = (error as Error).message;
  }

  ck("a first link survives a connection delivering one byte at a time", !failed, failed);
  ck("  and completes", Boolean(result?.done));
  ck("  and the account arrived", fresh.account === desktop.account);

  await listener.close();
}

/* ---- what the first link is allowed to carry ----------------------------- */

/**
 * The link that somebody is watching carries the account and nothing else.
 *
 * This is the difference between a link that takes seconds and one that takes
 * minutes, and the minutes were being spent in the worst possible place: the
 * device being linked sat on a setup screen, with no name and no account,
 * while every server's entire history and every avatar came across a Tor
 * circuit — none of which is needed to be signed in, and all of which is
 * useless until you are.
 *
 * So the first pass carries the account key and the private index, because the
 * index is what names the user. Everything else follows on the schedule, from
 * a device that by then is signed in and usable.
 */
{
  const desktop = device("desktop", "d".repeat(56) + ".onion");
  const fresh = device("phone", "p".repeat(56) + ".onion", false);

  desktop.logs.set("@index", [event("a friend"), event("a server joined")]);
  desktop.logs.set("srv_big", [event("one"), event("two"), event("three")]);
  desktop.logs.set("dm_someone", [event("hello")]);

  const avatar = randomBytes(2_000);
  const avatarId = createHash("sha256").update(avatar).digest("hex");
  desktop.pictures.set(avatarId, avatar);

  const listener = new PairService(desktop.hooks);
  const port = await listener.open();
  const minted = listener.mint(address());
  const opened = openInvite(minted.code, minted.password);

  const result = opened.ok === true
    ? await new PairService(fresh.hooks)
        .join(await connect(port), opened.invite, minted.password)
    : undefined;

  ck("the first link completes", Boolean(result?.done));
  ck("  and it is an identity pass", result?.scope === "identity", String(result?.scope));

  ck("  the account came across", fresh.account === desktop.account);
  ck(
    "  and the index, which is what names the user",
    (fresh.logs.get("@index") ?? []).length === 2,
    `${(fresh.logs.get("@index") ?? []).length}`,
  );

  // The whole point. None of this is needed to be signed in, so none of it is
  // allowed to stand between the user and being signed in.
  ck(
    "  but no server history",
    !(fresh.logs.get("srv_big") ?? []).length,
    `${(fresh.logs.get("srv_big") ?? []).length} events`,
  );
  ck(
    "  and no direct conversations",
    !(fresh.logs.get("dm_someone") ?? []).length,
  );
  ck("  and no pictures at all", fresh.pictures.size === 0, `${fresh.pictures.size}`);

  await listener.close();

  // And now the background passes, in the order the app runs them.
  const second = new PairService(desktop.hooks);
  const port2 = await second.open();

  await new PairService(fresh.hooks).sync(await connect(port2), "messages");

  ck("the messages pass brings the servers", (fresh.logs.get("srv_big") ?? []).length === 3,
     `${(fresh.logs.get("srv_big") ?? []).length}`);
  ck("  and the conversations", (fresh.logs.get("dm_someone") ?? []).length === 1);
  ck("  and still no pictures", fresh.pictures.size === 0, `${fresh.pictures.size}`);

  await new PairService(fresh.hooks).sync(await connect(port2), "everything");

  ck("the occasional pass brings the pictures", fresh.pictures.has(avatarId));

  await second.close();
}

/**
 * Nothing is written to disk before this device knows whose disk it is.
 *
 * A community log is encrypted at rest with a key derived from the device's
 * private key. So an event merged *before* the account arrives is sealed under
 * the throwaway key generated on first launch — and the account replaces that
 * key moments later, leaving the log unreadable. On the next start it is moved
 * aside as corrupt and the device comes up empty, holding the right identity
 * and none of its history.
 *
 * That failure is very hard to read from outside, because the device is not
 * broken in any way it can report: the link succeeded, the key is right, and
 * the interface offers to create an account because as far as it can tell
 * there is not one. Accepting writes a second profile signed by the linked
 * account's own key — at which point adding the original as a friend reports
 * it as yourself, which is the symptom that finally gave it away.
 *
 * Nothing here can see an encryption key, so the property is asserted the way
 * it actually matters: the account must be in place before the first event
 * lands, whatever order the messages arrive in.
 */
{
  const desktop = device("desktop", "d".repeat(56) + ".onion");
  const fresh = device("phone", "p".repeat(56) + ".onion", false);

  desktop.logs.set("@index", [event("a friend"), event("a username")]);

  // When each thing happened, in the order it happened.
  const order: string[] = [];

  const merge = fresh.hooks.merge;
  fresh.hooks.merge = (community, events) => {
    order.push("merge");
    return merge(community, events);
  };

  const adopt = fresh.hooks.adoptIdentity!;
  fresh.hooks.adoptIdentity = (given) => {
    order.push("adopt");
    return adopt(given);
  };

  const listener = new PairService(desktop.hooks);
  const port = await listener.open();
  const minted = listener.mint(address());
  const opened = openInvite(minted.code, minted.password);

  const result = opened.ok === true
    ? await new PairService(fresh.hooks)
        .join(await connect(port), opened.invite, minted.password)
    : undefined;

  ck("a first link completes", Boolean(result?.done));
  ck("  and the account arrived", Boolean(fresh.account));

  ck(
    "  and nothing was written before it did",
    order.length > 0 && order[0] === "adopt" && order.indexOf("merge") > 0,
    order.join(" → ") || "nothing happened",
  );

  ck(
    "  and the history still arrived, held rather than dropped",
    (fresh.logs.get("@index") ?? []).length === 2,
    `${(fresh.logs.get("@index") ?? []).length} events`,
  );

  await listener.close();
}

/**
 * The device showing the code hands over its account. Always.
 *
 * ## Why this is asserted so bluntly
 *
 * Because the alternative shipped. The giving side decided whether it had an
 * account worth sending by searching its own index for a username claim, and
 * when that search came back false it answered "I have no account" — to the
 * one question this entire feature exists to answer.
 *
 * Nothing about that failure is visible from the outside. The index still
 * syncs, so the claims arrive and the scanning device reports being signed in
 * on the other one. It just never becomes the account: it keeps the throwaway
 * key it generated on first launch and sits on the setup screen, having
 * apparently succeeded.
 *
 * So which device gives is structural now — the one that minted the invite,
 * which is the one whose screen the code is on — and this pins it by making
 * the log search wrong on purpose. `needsIdentity` lies, `identity` is
 * available, and the account must still cross.
 */
{
  const desktop = device("desktop", "d".repeat(56) + ".onion");
  const fresh = device("phone", "p".repeat(56) + ".onion", false);

  desktop.logs.set("@index", [event("a username claim")]);

  // The heuristic that used to gate this, broken in the direction that broke
  // linking: this device believes it has nothing to give.
  desktop.hooks.needsIdentity = () => true;

  const listener = new PairService(desktop.hooks);
  const port = await listener.open();
  const minted = listener.mint(address());
  const opened = openInvite(minted.code, minted.password);

  const result = opened.ok === true
    ? await new PairService(fresh.hooks)
        .join(await connect(port), opened.invite, minted.password)
    : undefined;

  ck("the link completes", Boolean(result?.done));
  ck(
    "and the scanning device is given the account",
    fresh.account === desktop.account,
    `${fresh.account} vs ${desktop.account}`,
  );
  ck("and says so, rather than leaving the caller to guess", result?.adopted === true);

  // And the device showing the code never asks for one, however confused it is
  // about its own state — it is the one somebody is signed in on.
  ck(
    "and the device showing the code did not adopt anything itself",
    desktop.account === '{"userId":"u-desktop"}',
    String(desktop.account),
  );

  await listener.close();
}

/**
 * And the holding does not apply to a device that already has an account.
 *
 * It never asks for one, so there is nothing to wait for and no reason to
 * delay a single event.
 */
{
  const one = device("one", "d".repeat(56) + ".onion");
  const two = device("two", "p".repeat(56) + ".onion");

  two.hooks.accountSecret = () => one.hooks.accountSecret();
  one.logs.set("@index", [event("something new")]);

  const listener = new PairService(two.hooks);
  const port = await listener.open();

  const result = await new PairService(one.hooks).sync(await connect(port), "messages");

  ck("a device that already has an account syncs without waiting", Boolean(result?.done));
  ck("  and the events arrived", (two.logs.get("@index") ?? []).length === 1);
  ck("  and nothing was adopted", !result?.adopted);

  await listener.close();
}

/* ---- syncing afterwards, with nothing typed ------------------------------ */

/**
 * The second half of the whole design.
 *
 * Once two devices share an account they share the secret derived from it, so
 * every sync after the first needs no code, no passphrase and nothing stored.
 * This is what removes the entire class of "they stopped syncing and I did not
 * change anything" — there is no longer a credential that can go missing on
 * one device and not the other.
 */
{
  const one = device("laptop", "l".repeat(56) + ".onion");
  const two = device("phone", "p".repeat(56) + ".onion");

  // The same account on both, which is what a completed link leaves behind.
  two.hooks.accountSecret = () => one.hooks.accountSecret();

  one.logs.set("@index", [event("added since the link")]);

  const listener = new PairService(one.hooks);
  const port = await listener.open();

  let failed = "";
  let result;

  try {
    result = await new PairService(two.hooks).sync(await connect(port));
  } catch (error) {
    failed = (error as Error).message;
  }

  ck("two linked devices sync with no code and no typing", !failed, failed);
  ck("  and it completes", Boolean(result?.done));
  ck("  and the events crossed", (two.logs.get("@index") ?? []).length === 1);
  ck(
    "  without any invite being involved",
    listener.offering().length === 0,
  );

  await listener.close();
}

/**
 * And a device holding a *different* account cannot.
 *
 * The account secret is the credential, so this is the same check as "is this
 * one of my devices" — and it has to fail closed.
 */
{
  const mine = device("mine", "m".repeat(56) + ".onion");
  const stranger = device("stranger", "t".repeat(56) + ".onion");

  const listener = new PairService(mine.hooks);
  const port = await listener.open();

  let failed = "";
  try {
    await new PairService(stranger.hooks).sync(await connect(port));
  } catch (error) {
    failed = (error as Error).message;
  }

  ck("a different account is refused", Boolean(failed), failed);
  ck("  and says it is a different account, not a bad password",
     /different account/i.test(failed), failed);
  ck("  and nothing crossed", (stranger.logs.get("@index") ?? []).length === 0);

  await listener.close();
}

/**
 * A device with no account cannot sync at all, and is told why.
 *
 * This is the state of every phone before its first link, and the answer is
 * not "try again" — it is "scan a code". Reported without a circuit being
 * opened, because there is nothing on the other end that could help.
 */
{
  const fresh = device("fresh", "f".repeat(56) + ".onion", false);
  const other = device("other", "o".repeat(56) + ".onion");

  const listener = new PairService(other.hooks);
  const port = await listener.open();

  let failed = "";
  try {
    await new PairService(fresh.hooks).sync(await connect(port));
  } catch (error) {
    failed = (error as Error).message;
  }

  ck("a device with no account is told to use a code", /pairing code/i.test(failed), failed);

  await listener.close();
}

/* ---- an invite is one use, and revocable -------------------------------- */

/**
 * The property the old password file could not have.
 *
 * A code stops working when it is used, when it is replaced, when it runs out,
 * and when the app restarts — and all four arrive at the far end as the same
 * refusal, because all four have the same answer.
 */
{
  const shows = device("desktop", "d".repeat(56) + ".onion");
  const listener = new PairService(shows.hooks);
  const port = await listener.open();

  const first = listener.mint(address());
  ck("a minted code is on offer", listener.offering().length === 1);

  // Minting a second drops the first. Two live codes is a state the interface
  // cannot show and nobody asked for — the second one would only ever be a
  // code somebody had walked away from.
  const second = listener.mint(address());
  ck("minting again replaces it rather than adding one",
     listener.offering().length === 1 &&
     listener.offering()[0].session === second.session);

  const stale = openInvite(first.code, first.password);
  let refused = "";

  try {
    if (stale.ok !== true) throw new Error("the first code did not open");
    const scanner = device("phone", "p".repeat(56) + ".onion", false);
    await new PairService(scanner.hooks).join(
      await connect(port), stale.invite, first.password,
    );
  } catch (error) {
    refused = (error as Error).message;
  }

  ck("a replaced code is refused", Boolean(refused), refused);
  ck(
    "  and the refusal says to show a new one",
    /no longer valid/i.test(refused) && /new code/i.test(refused),
    refused,
  );
  ck(
    "  and does not blame the passphrase, which was right",
    !/passphrase|password/i.test(refused),
    refused,
  );

  // Now use the live one, and watch it be spent.
  //
  // Waiting on the *listener's* own event rather than on the dialling promise.
  // The code is consumed by the device that minted it, when its side of the
  // session finishes — which is a moment after the dialling side resolves, so
  // asking immediately reads the state one step too early. That is a race in
  // the test rather than in the code, and it reported a spent code as still on
  // offer.
  const live = openInvite(second.code, second.password);
  let used = "";

  const spent = new Promise<void>((done) => { listener.once("paired", () => done()); });

  try {
    if (live.ok !== true) throw new Error("the second code did not open");
    const scanner = device("phone", "p".repeat(56) + ".onion", false);
    await new PairService(scanner.hooks).join(
      await connect(port), live.invite, second.password,
    );
    await spent;
  } catch (error) {
    used = (error as Error).message;
  }

  ck("the live code links", !used, used);
  ck("  and is spent afterwards", listener.offering().length === 0);

  // The same code again. It scanned, it opened, the passphrase was right — and
  // it is gone, because a one-time invite is one time.
  let twice = "";

  try {
    if (live.ok !== true) throw new Error("unreachable");
    const scanner = device("another", "a".repeat(56) + ".onion", false);
    await new PairService(scanner.hooks).join(
      await connect(port), live.invite, second.password,
    );
  } catch (error) {
    twice = (error as Error).message;
  }

  ck("and using it a second time is refused", /no longer valid/i.test(twice), twice);

  await listener.close();
}

/**
 * Revoking by hand, which is what closing the dialog does.
 */
{
  const shows = device("desktop", "d".repeat(56) + ".onion");
  const listener = new PairService(shows.hooks);
  const port = await listener.open();

  const minted = listener.mint(address());
  listener.revoke(minted.session);

  ck("a revoked code is no longer offered", listener.offering().length === 0);

  const opened = openInvite(minted.code, minted.password);
  let refused = "";

  try {
    if (opened.ok !== true) throw new Error("the code did not open");
    const scanner = device("phone", "p".repeat(56) + ".onion", false);
    await new PairService(scanner.hooks).join(
      await connect(port), opened.invite, minted.password,
    );
  } catch (error) {
    refused = (error as Error).message;
  }

  ck("and it is refused on the wire too", /no longer valid/i.test(refused), refused);

  await listener.close();
}

/**
 * A failed link does *not* spend the code.
 *
 * Deliberate, and the opposite of what burning it on authorisation would do.
 * A circuit that drops half way through a transfer is common enough on a
 * phone, and a user whose link failed once should be able to press the button
 * again rather than walk back to the other device for a fresh code.
 */
{
  const shows = device("desktop", "d".repeat(56) + ".onion");
  const listener = new PairService(shows.hooks);
  const port = await listener.open();

  const minted = listener.mint(address());
  const opened = openInvite(minted.code, minted.password);

  // Dial, then hang up before the exchange can finish.
  const socket = await connect(port);
  const scanner = device("phone", "p".repeat(56) + ".onion", false);
  const attempt = new PairService(scanner.hooks)
    .join(socket, opened.ok === true ? opened.invite : ({} as never), minted.password)
    .catch(() => undefined);

  setTimeout(() => { socket.destroy(); }, 15);
  await attempt;
  await new Promise<void>((done) => { setTimeout(done, 60); });

  ck(
    "a link that broke off leaves the code usable",
    listener.offering().length === 1,
    JSON.stringify(listener.offering()),
  );

  await listener.close();
}

/* ---- one side slower than the other -------------------------------------- */

/**
 * A pairing where the two devices authorise at different times.
 *
 * Each side verifies the *other's* proof, and reaching that point takes as long
 * as scrypt takes — which on a phone and a desktop is not the same length of
 * time. The faster side finishes, decides the connection is good, and starts
 * sending. The slower side is still deriving, and used to treat that traffic as
 * an attempt to skip the credential.
 *
 * Both machines here run at the same speed, so the difference is introduced
 * deliberately: one side's relay delays everything travelling towards it, which
 * has exactly the effect of that side being slow to authorise.
 */
async function lopsided() {
  const slow = device("Ray's phone", "p".repeat(56) + ".onion");
  const fast = device("Ray's desktop", "d".repeat(56) + ".onion");

  // Two devices already linked, running the full pass — the one with enough
  // in it for the faster side to get well ahead while the slower is still
  // deriving a key.
  slow.hooks.accountSecret = () => fast.hooks.accountSecret();

  fast.logs.set("@index", [event("a friend"), event("a server")]);
  fast.logs.set("srv_one", [event("a message")]);

  const picture = randomBytes(2_000);
  const pictureId = createHash("sha256").update(picture).digest("hex");
  fast.pictures.set(pictureId, picture);

  const listener = new PairService(slow.hooks);
  const direct = await listener.open();

  // Delay only what travels towards the listener, so its greeting is answered
  // long before it has read the answer — the far side authorises first and
  // starts sending while this one is still catching up.
  const { createServer: make, Socket: Sock } = await import("node:net");

  const skewed = make((near) => {
    const far = new Sock();
    far.connect(direct, "127.0.0.1");

    near.on("data", (c: Buffer) => { setTimeout(() => far.write(c), 120); });
    far.on("data", (c: Buffer) => { near.write(c); });

    near.on("error", () => {});
    far.on("error", () => {});
    near.on("close", () => { setTimeout(() => far.end(), 300); });
    far.on("close", () => { setTimeout(() => near.end(), 300); });
  });

  await new Promise<void>((done) => skewed.listen(0, "127.0.0.1", () => done()));
  const port = (skewed.address() as { port: number }).port;

  let failed = "";
  let result;

  try {
    result = await new PairService(fast.hooks)
      .sync(await connect(port), "everything");
  } catch (error) {
    failed = (error as Error).message;
  }

  ck("a device that authorises later is not accused of skipping the code", !failed, failed);
  ck("  and the pairing still completes", Boolean(result?.done));
  ck(
    "  and the early messages were kept, not dropped",
    (slow.logs.get("@index") ?? []).length === 2 &&
      (slow.logs.get("srv_one") ?? []).length === 1,
    `${(slow.logs.get("@index") ?? []).length} / ${(slow.logs.get("srv_one") ?? []).length}`,
  );
  ck("  including the picture", slow.pictures.has(pictureId));

  skewed.close();
  await listener.close();
}

await lopsided();

/* ---- a failure that explains itself -------------------------------------- */

/**
 * The side that refuses has to say so.
 *
 * This is the difference between a bug that takes ten minutes and one that
 * takes a week. When a session gave up it used to stop writing and close, so
 * the peer saw a socket end and reported "that device closed the connection" —
 * a sentence that covers a refused credential, a crash in a hook, a dead
 * circuit and a listener that was never there, and distinguishes none of them.
 *
 * Now the reason is written to the wire before the socket goes, and the
 * assertion is that the *dialling* side ends up holding the *answering* side's
 * explanation.
 */
{
  const mine = device("mine", "m".repeat(56) + ".onion", false);

  // A device offering no codes at all refuses everything, which is one of the
  // states that used to be indistinguishable from a network failure.
  const noCode = device("theirs", "t".repeat(56) + ".onion");

  const listener = new PairService(noCode.hooks);
  const port = await listener.open();

  // A code minted somewhere else, so the session id means nothing here. This
  // is exactly the state after a restart: the QR still scans and the device
  // that showed it has forgotten every invite it ever made.
  const elsewhere = mintInvite(address());
  const opened = openInvite(elsewhere.code, elsewhere.password);

  let why = "";
  try {
    if (opened.ok !== true) throw new Error("the code did not open");
    await new PairService(mine.hooks)
      .join(await connect(port), opened.invite, elsewhere.password);
  } catch (error) {
    why = (error as Error).message;
  }

  ck("a refusal reaches the other device", Boolean(why), why);
  ck(
    "and carries the reason rather than just the disconnection",
    /no longer valid/i.test(why) && !/closed the connection/i.test(why),
    why,
  );

  await listener.close();
}

/**
 * And when there is genuinely nothing to say, the stage is.
 *
 * A peer that accepts a connection and then vanishes cannot explain itself, so
 * the message has to be built from what this side observed. Naming the stage
 * turns one sentence into four, each with a different answer.
 */
{
  const mine = device("mine", "m".repeat(56) + ".onion");

  // Accepts, says nothing, hangs up — a listener on the right port speaking
  // the wrong protocol, or an app still starting.
  const mute = createServer((socket) => { setTimeout(() => socket.destroy(), 60); });
  await new Promise<void>((done) => mute.listen(0, "127.0.0.1", () => done()));
  const port = (mute.address() as { port: number }).port;

  let why = "";
  try {
    await new PairService(mine.hooks).sync(await connect(port));
  } catch (error) {
    why = (error as Error).message;
  }

  ck(
    "a silent peer is reported as silent, not as a refusal",
    /never said anything/.test(why),
    why,
  );

  mute.close();
}

/* ---- a device with no account of its own --------------------------------- */

/**
 * A fresh device has to come away with the account, not just its history.
 *
 * This is the whole point of linking and it was missing. Pairing carried the
 * event logs and the pictures, and deliberately carried "no keys, no identity
 * material" — which was defensible while a separate export/import existed to
 * move the account. That was removed, and nothing replaced it.
 *
 * The result was a phone that synced everything, showed the right claims, knew
 * which device was answering, and sat on the setup screen — holding a complete
 * copy of an account it had no key to open.
 *
 * The onion key travels too. An account *is* its address: without it the
 * linked device comes up as the same identity somewhere else entirely, and
 * every friend code anybody holds for you stops working.
 */
{
  const desktop = device("Ray's desktop", "d".repeat(56) + ".onion");
  const fresh = device("Ray's phone", "p".repeat(56) + ".onion", false);

  desktop.logs.set("@index", [event("a friend")]);

  ck("a new device starts with no account", !fresh.account);

  // The signed-in device shows the code; the new one scans it.
  //
  // That is the only arrangement the app offers, and it is worth pinning here
  // rather than in prose: `pairInvite` lives behind Settings, which a device
  // with no account cannot reach — its setup screen offers pasting and
  // scanning and nothing else. Tests that had it the other way round were
  // describing a flow that does not exist, and they went on passing while the
  // real one was broken.
  const listener = new PairService(desktop.hooks);
  const port = await listener.open();
  const minted = listener.mint(address());
  const opened = openInvite(minted.code, minted.password);

  ck("the signed-in device offers a code", opened.ok);

  const result = opened.ok === true
    ? await new PairService(fresh.hooks)
        .join(await connect(port), opened.invite, minted.password)
    : undefined;

  ck("the pairing completes", Boolean(result?.done));
  ck("and the new device now has the account", Boolean(fresh.account), String(fresh.account));
  ck(
    "  which is the same account, not a new one",
    fresh.account === desktop.account,
    `${fresh.account} vs ${desktop.account}`,
  );
  ck("  and the onion key came with it", fresh.adoptedKey === "AAEC");
  ck("  and the history arrived too", (fresh.logs.get("@index") ?? []).length === 1);

  // And from here on it can sync without a code, because it now derives the
  // same account secret as its sibling.
  ck(
    "  and it can now authorise as the account",
    fresh.hooks.accountSecret() === desktop.hooks.accountSecret(),
  );

  await listener.close();
}

/**
 * And a device that already has an account never replaces it.
 *
 * Receiving a second identity would silently discard the first, and every
 * event this device had already signed would stop verifying against the key
 * that replaced it.
 */
{
  const one = device("one", "d".repeat(56) + ".onion");
  const two = device("two", "p".repeat(56) + ".onion");

  const before = two.account;

  const listener = new PairService(two.hooks);
  const port = await listener.open();
  const minted = listener.mint(address());
  const opened = openInvite(minted.code, minted.password);

  if (opened.ok === true) {
    await new PairService(one.hooks).join(await connect(port), opened.invite, minted.password);
  }

  ck("a device that already has an account keeps it", two.account === before);

  await listener.close();
}

/* ---- a greeting that goes missing ---------------------------------------- */

/**
 * The exchange has to converge even if the opening greeting is never seen.
 *
 * A pairing that opens a connection, carries nothing and times out two minutes
 * later is the hardest failure to read, because both devices are behaving
 * correctly by their own lights and neither has anything to report. The way to
 * get there used to be a single missed message: this side replied with a proof
 * only when it saw a greeting with an *empty* proof, so if that one greeting
 * was dropped, no proof was ever sent, the peer never authorised, and both
 * waited for each other.
 *
 * Dropping it deliberately here. The exchange must still finish.
 */
{
  const listens = device("Ray's phone", "p".repeat(56) + ".onion");
  const dials = device("Ray's desktop", "d".repeat(56) + ".onion");

  dials.logs.set("@index", [event("a friend")]);

  const listener = new PairService(listens.hooks);
  const direct = await listener.open();
  const minted = listener.mint(address());
  const opened = openInvite(minted.code, minted.password);

  // Swallows the first message travelling towards the dialling side — its
  // peer's opening greeting — and passes everything after it through.
  const lossy = createServer((near) => {
    const far = new Socket();
    far.connect(direct, "127.0.0.1");

    let dropped = false;

    near.on("data", (c: Buffer) => far.write(c));
    far.on("data", (c: Buffer) => {
      if (!dropped) { dropped = true; return; }
      near.write(c);
    });

    near.on("error", () => {});
    far.on("error", () => {});
    near.on("close", () => { setTimeout(() => far.end(), 200); });
    far.on("close", () => { setTimeout(() => near.end(), 200); });
  });

  await new Promise<void>((done) => lossy.listen(0, "127.0.0.1", () => done()));
  const port = (lossy.address() as { port: number }).port;

  let failed = "";
  let result;

  try {
    if (opened.ok !== true) throw new Error("the minted code did not open");
    result = await new PairService(dials.hooks)
      .join(await connect(port), opened.invite, minted.password);
  } catch (error) {
    failed = (error as Error).message;
  }

  ck("a lost opening greeting does not deadlock the exchange", !failed, failed);
  ck("  and the pairing still completes", Boolean(result?.done));
  ck(
    "  and the events still crossed",
    (listens.logs.get("@index") ?? []).length === 1,
  );

  lossy.close();
  await listener.close();
}

/* ---- two devices on different builds -------------------------------------- */

/**
 * A version mismatch has to say it is a version mismatch.
 *
 * Everything else in this protocol assumes both ends agree on what the
 * messages are. When they do not — one device updated, the other not — the
 * older one sends things the newer one has no case for, in an order it does
 * not expect, and every guard fires. Before this check existed the result was
 * "that device sent data before proving the password": an accusation about
 * security, pointing at a credential that was correct, for a problem that is
 * fixed by installing an update.
 */
{
  const mine = device("mine", "m".repeat(56) + ".onion");

  const listener = new PairService(mine.hooks);
  const port = await listener.open();
  listener.mint(address());

  // A peer speaking something else: a greeting with no version, which is what
  // every build before this one sends.
  const socket = await connect(port);

  const body = Buffer.from(JSON.stringify({
    t: "hello", device: "old", name: "an older build",
    onion: "o".repeat(56) + ".onion", nonce: "x", proof: "", communities: [],
  }), "utf8");

  const header = Buffer.alloc(5);
  header.writeUInt32BE(body.length, 0);
  socket.write(Buffer.concat([header, body]));

  const said = await new Promise<string>((done) => {
    socket.on("data", (chunk: Buffer) => {
      try {
        const msg = JSON.parse(chunk.subarray(5).toString("utf8")) as { t: string; why?: string };
        if (msg.t === "no") done(msg.why ?? "");
      } catch { /* the greeting, not the refusal */ }
    });
    setTimeout(() => done(""), 3000);
  });

  ck("an older build is told it is an older build", /older version/.test(said), said);
  ck(
    "and is not accused of getting the code wrong",
    !/password|passphrase|code/i.test(said),
    said,
  );

  socket.destroy();
  await listener.close();
}

/**
 * A peer that proves nothing and names no credential is refused.
 *
 * The greeting has to say which of the two credentials it is using, because
 * the two are indistinguishable from a failed HMAC — and answering "wrong
 * password" to a device that is not linked at all sends somebody to check a
 * passphrase that was never involved.
 */
{
  const mine = device("mine", "m".repeat(56) + ".onion");

  const listener = new PairService(mine.hooks);
  const port = await listener.open();

  const socket = await connect(port);

  const body = Buffer.from(JSON.stringify({
    t: "hello", v: 3, device: "nameless", name: "no credential",
    onion: "o".repeat(56) + ".onion", nonce: "x",
    proof: "0".repeat(64), communities: [],
  }), "utf8");

  const header = Buffer.alloc(5);
  header.writeUInt32BE(body.length, 0);
  socket.write(Buffer.concat([header, body]));

  const said = await new Promise<string>((done) => {
    socket.on("data", (chunk: Buffer) => {
      try {
        const msg = JSON.parse(chunk.subarray(5).toString("utf8")) as { t: string; why?: string };
        if (msg.t === "no") done(msg.why ?? "");
      } catch { /* the greeting, not the refusal */ }
    });
    setTimeout(() => done(""), 3000);
  });

  ck("a greeting that names no credential is refused", Boolean(said), said);

  socket.destroy();
  await listener.close();
}

/**
 * A greeting that arrives twice does not restart the exchange.
 *
 * A relay that duplicates a frame, or a peer that answers twice, is not a
 * fault worth abandoning a sync over — but acting on it twice is. Everything
 * after authorisation re-opens every community, and the `end` that closed each
 * of them has already been sent and will not be sent again. The session then
 * waits for messages nobody is going to write and times out two minutes later
 * having already transferred everything.
 */
{
  const listens = device("phone", "p".repeat(56) + ".onion");
  const dials = device("desktop", "d".repeat(56) + ".onion");

  dials.logs.set("@index", [event("a friend")]);

  const listener = new PairService(listens.hooks);
  const direct = await listener.open();
  const minted = listener.mint(address());
  const opened = openInvite(minted.code, minted.password);

  // Everything travelling towards the dialling side is sent twice.
  const echo = createServer((near) => {
    const far = new Socket();
    far.connect(direct, "127.0.0.1");

    near.on("data", (c: Buffer) => far.write(c));
    far.on("data", (c: Buffer) => { near.write(c); near.write(c); });

    near.on("error", () => {});
    far.on("error", () => {});
    near.on("close", () => { setTimeout(() => far.end(), 200); });
    far.on("close", () => { setTimeout(() => near.end(), 200); });
  });

  await new Promise<void>((done) => echo.listen(0, "127.0.0.1", () => done()));
  const port = (echo.address() as { port: number }).port;

  let failed = "";
  let result;

  try {
    if (opened.ok !== true) throw new Error("the minted code did not open");
    result = await new PairService(dials.hooks)
      .join(await connect(port), opened.invite, minted.password);
  } catch (error) {
    failed = (error as Error).message;
  }

  ck("a duplicated greeting does not deadlock the exchange", !failed, failed);
  ck("  and the pairing still completes", Boolean(result?.done));

  echo.close();
  await listener.close();
}

/* ---- what the sync address forwards to ----------------------------------- */

/**
 * The published address has to point at *this* protocol, and the credential
 * has to have no file behind it.
 *
 * Checked as source text, which is normally worth little — but both properties
 * are wiring facts that exist nowhere else and cannot be reached from a test,
 * and getting either wrong is not a subtle failure mode. The first one shipped:
 * the sync onion was configured to forward to a second, older service, so every
 * attempt reached a listener speaking a different protocol, which read the frame
 * header as its own length prefix and closed the socket. The user saw "that
 * device closed the connection" and nothing else.
 */
{
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const source = readFileSync(join(process.cwd(), "src/p2p/bridge.ts"), "utf8");

  // Anchored on the *netStart* block specifically. Searching from the top of
  // the file finds `role: "account"` inside the client-only Tor that linking
  // starts, which sits earlier and made this slice run backwards.
  const from = source.indexOf("let forSync = 0;");
  const configured = source.slice(from, source.indexOf("new TorService(", from));

  ck(
    "the sync address forwards to the pairing service",
    configured.includes("await openPair()"),
  );

  ck(
    "and the superseded link service is gone entirely",
    !source.includes("new LinkService("),
  );

  ck(
    "so there is only one listener an onion can reach",
    source.split("new PairService(").length - 1 >= 1 &&
      !/openLink\(\)/.test(source),
  );

  // Whether this device needs an account cannot be "does a key exist".
  //
  // A key always exists: `registerP2PHandlers` generates one on first launch so
  // the setup screen has a user id to show. So `!identity` was permanently
  // false, `whoami` was never sent, and a device that had just been linked
  // never asked for the account it was linked to — it copied every message and
  // every friend and stayed the throwaway identity it had made a minute
  // earlier. The link worked and left you as somebody else.
  ck(
    "a device asks for the account on whether it is set up, not on whether a key exists",
    /needsIdentity: \(\) => !claimed\(\)/.test(source) &&
      !/needsIdentity: \(\) => !identity/.test(source),
  );

  // And handing one *out* is not gated on that search, or on any search.
  //
  // It was, and that is what broke linking: the device showing the code
  // decided whether it had an account worth sending by looking for a username
  // claim in its own index, and a false answer there meant it told the
  // scanning device it had no account at all. Nothing downstream could tell
  // that apart from a device that genuinely had none.
  ck(
    "and handing the account over is not gated on a log search",
    !/!identity \|\| !claimed\(\)/.test(source),
  );

  // The file that could not be revoked and did not survive a force-quit. Its
  // absence is the fix for three separate reports, so it is worth a test that
  // fails if anything ever writes one again.
  //
  // Matched on code rather than on the string, because the comment explaining
  // why the file is gone necessarily names it — and a test that cannot tell an
  // explanation from an implementation fails on the documentation of its own
  // fix.
  ck(
    "no pairing password is written to disk",
    !/function passwordFile/.test(source) &&
      !/setPairPassword/.test(source) &&
      !/writeFileSync\([^)]*password/i.test(source),
  );

  // And the Tor client half of the configuration is never conditional on
  // publishing an account address. Emptying it is what left a brand-new device
  // with SOCKS on tor's default port while everything here dialled 9250.
  const tor = readFileSync(join(process.cwd(), "src/p2p/tor.ts"), "utf8");

  ck(
    "the SOCKS port is configured whether or not an account is published",
    !/lines\.length = 0/.test(tor) &&
      tor.indexOf("SocksPort") < tor.indexOf("if (this.#options.account)"),
  );
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
