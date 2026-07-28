import { createHash, randomBytes } from "node:crypto";
import { createServer, Socket } from "node:net";

import type { SignedEvent } from "./events";
import { openInvite, PairService, sealInvite, type PairHooks, PICTURES } from "./pair";
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

/** A device, in memory, with just enough behind it to be synced. */
function device(name: string, password: string, onion: string, hasAccount = true) {
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
    password: () => password,

    communities: () => [...logs.keys()],
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

async function dial(service: PairService, port: number) {
  const socket = new Socket();

  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(port, "127.0.0.1", () => resolve());
  });

  return service.adopt(socket);
}

/* ---- the invite ---------------------------------------------------------- */

{
  // A real v3 address: 32 bytes of key, 2 of checksum, then the version byte 3.
  const raw = Buffer.concat([randomBytes(34), Buffer.from([3])]);
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, spelled = "";
  for (const byte of raw) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { spelled += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  const onion = spelled.toLowerCase() + ".onion";
  const code = sealInvite({ onion, name: "Ray's desktop" }, "hunter2");

  // The interface's encoder is byte mode and stops at version 6 — 134 bytes.
  // Version 4 is 80, and staying inside it keeps the grid coarse enough for a
  // phone camera to read off a screen across a desk.
  ck("an invite fits a version 4 QR code", code.length <= 80, `${code.length} chars`);
  ck(
    "and stays inside the QR alphanumeric set, so it scans at low density",
    /^[0-9A-Z $%*+\-.\/:]+$/.test(code),
    code.slice(0, 24),
  );
  ck(
    "and survives being typed in lower case",
    openInvite(code.toLowerCase(), "hunter2").ok,
  );
  ck("and does not contain the address in the clear", !code.includes(onion));

  const opened = openInvite(code, "hunter2");
  ck("the right password opens it", opened.ok);
  ck("and gets the address back", opened.ok && opened.invite.onion === onion);
  ck(
    "and leaves the name to the greeting rather than inventing one",
    opened.ok && opened.invite.name === "",
  );
  ck(
    "and tolerates spaces from someone reading it aloud",
    openInvite(code.slice(0, 20) + " " + code.slice(20), "hunter2").ok,
  );

  const wrong = openInvite(code, "hunter3");
  ck("the wrong password does not", !wrong.ok);
  ck(
    "and says so, rather than blaming the camera",
    !wrong.ok && wrong.reason === "wrong-password",
  );

  const junk = openInvite("https://example.com", "hunter2");
  ck(
    "something that is not an invite is told apart from a bad password",
    !junk.ok && junk.reason === "not-an-invite",
  );

  const again = sealInvite({ onion, name: "Ray's desktop" }, "hunter2");
  ck("the same invite twice looks different", again !== code);
}

/* ---- pairing ------------------------------------------------------------- */

async function pairs(mode: "direct" | "batch" | "drip", reversed: boolean) {
  const password = "correct horse";

  const desktop = device("Ray's desktop", password, "d".repeat(56) + ".onion");
  const phone = device("Ray's phone", password, "p".repeat(56) + ".onion");

  desktop.logs.set("@index", [event("a friend"), event("a server")]);
  desktop.logs.set("srv_one", [event("a message")]);
  phone.logs.set("@index", [event("something only the phone has")]);

  const avatar = randomBytes(3_000);
  const avatarId = createHash("sha256").update(avatar).digest("hex");
  desktop.pictures.set(avatarId, avatar);
  desktop.logs.set(PICTURES, [event("an avatar")]);

  // Whoever listens, the other one dials — and it is swapped for half the runs,
  // because a QR code is shown by one device and scanned by the other.
  const [listens, dials] = reversed ? [desktop, phone] : [phone, desktop];

  const listener = new PairService(listens.hooks);
  const direct = await listener.open();
  const port = mode === "direct" ? direct : await relay(direct, mode);

  let result;
  let failed = "";

  try {
    result = await dial(new PairService(dials.hooks), port);
  } catch (error) {
    failed = (error as Error).message;
  }

  const label = `${mode}${reversed ? ", reversed" : ""}`;

  ck(`pairs over a ${label} connection`, !failed, failed);
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

// The scanner is not always the same device, so run it the other way round too.
await pairs("batch", true);

/* ---- refusing ------------------------------------------------------------ */

{
  const mine = device("mine", "correct horse", "m".repeat(56) + ".onion");
  const theirs = device("theirs", "a different password", "t".repeat(56) + ".onion");

  const listener = new PairService(mine.hooks);
  const port = await listener.open();

  let failed = "";
  try {
    await dial(new PairService(theirs.hooks), port);
  } catch (error) {
    failed = (error as Error).message;
  }

  ck("a wrong password is refused", Boolean(failed), failed);
  ck("and nothing crossed", (theirs.logs.get("@index") ?? []).length === 0);

  await listener.close();
}

/* ---- one side slower than the other -------------------------------------- */

/**
 * A pairing where the two devices authorise at different times.
 *
 * Worth stating plainly: this does **not** reproduce the reported failure. It
 * passes with the guard that produced that message and without it, because TCP
 * preserves order and a current build only sends past the greeting once it has
 * verified a proof. The guard was unreachable between two devices running this
 * code — which is itself the finding, and is why a version check now exists.
 *
 * What it does establish is that authorising at different times is harmless,
 * which is the property the queueing is there to provide.
 *
 * Each side verifies the *other's* proof, and reaching that point takes as long
 * as scrypt takes — which on a phone and a desktop is not the same length of
 * time. The faster side finishes, decides the connection is good, and starts
 * sending. The slower side is still deriving, and used to treat that traffic as
 * an attempt to skip the password.
 *
 * Both machines here run at the same speed, so the difference is introduced
 * deliberately: one side's relay delays everything travelling towards it, which
 * has exactly the effect of that side being slow to authorise.
 */
async function lopsided() {
  const password = "correct horse";

  const slow = device("Ray's phone", password, "p".repeat(56) + ".onion");
  const fast = device("Ray's desktop", password, "d".repeat(56) + ".onion");

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
    result = await dial(new PairService(fast.hooks), port);
  } catch (error) {
    failed = (error as Error).message;
  }

  ck("a device that authorises later is not accused of skipping the password", !failed, failed);
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
 * a sentence that covers a refused password, a crash in a hook, a dead circuit
 * and a listener that was never there, and distinguishes none of them.
 *
 * Now the reason is written to the wire before the socket goes, and the
 * assertion is that the *dialling* side ends up holding the *answering* side's
 * explanation.
 */
{
  const mine = device("mine", "correct horse", "m".repeat(56) + ".onion");
  const noPassword = device("theirs", "", "t".repeat(56) + ".onion");

  // A device with no pairing password set refuses everything, which is one of
  // the states that used to be indistinguishable from a network failure.
  noPassword.hooks.password = () => undefined;

  const listener = new PairService(noPassword.hooks);
  const port = await listener.open();

  let why = "";
  try {
    await dial(new PairService(mine.hooks), port);
  } catch (error) {
    why = (error as Error).message;
  }

  ck("a refusal reaches the other device", Boolean(why), why);
  ck(
    "and carries the reason rather than just the disconnection",
    /password/i.test(why) && !/closed the connection/i.test(why),
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
  const mine = device("mine", "correct horse", "m".repeat(56) + ".onion");

  // Accepts, says nothing, hangs up — a listener on the right port speaking
  // the wrong protocol, or an app still starting.
  const mute = createServer((socket) => { setTimeout(() => socket.destroy(), 60); });
  await new Promise<void>((done) => mute.listen(0, "127.0.0.1", () => done()));
  const port = (mute.address() as { port: number }).port;

  let why = "";
  try {
    await dial(new PairService(mine.hooks), port);
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
  const password = "correct horse";

  const desktop = device("Ray's desktop", password, "d".repeat(56) + ".onion");
  const fresh = device("Ray's phone", password, "p".repeat(56) + ".onion", false);

  desktop.logs.set("@index", [event("a friend")]);

  ck("a new device starts with no account", !fresh.account);

  const listener = new PairService(fresh.hooks);
  const port = await listener.open();

  const result = await dial(new PairService(desktop.hooks), port);

  ck("the pairing completes", Boolean(result?.done));
  ck("and the new device now has the account", Boolean(fresh.account), String(fresh.account));
  ck(
    "  which is the same account, not a new one",
    fresh.account === desktop.account,
    `${fresh.account} vs ${desktop.account}`,
  );
  ck("  and the onion key came with it", fresh.adoptedKey === "AAEC");
  ck("  and the history arrived too", (fresh.logs.get("@index") ?? []).length === 1);

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
  const password = "correct horse";

  const one = device("one", password, "d".repeat(56) + ".onion");
  const two = device("two", password, "p".repeat(56) + ".onion");

  const before = two.account;

  const listener = new PairService(two.hooks);
  const port = await listener.open();

  await dial(new PairService(one.hooks), port);

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
  const password = "correct horse";

  const listens = device("Ray's phone", password, "p".repeat(56) + ".onion");
  const dials = device("Ray's desktop", password, "d".repeat(56) + ".onion");

  dials.logs.set("@index", [event("a friend")]);

  const listener = new PairService(listens.hooks);
  const direct = await listener.open();

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
    result = await dial(new PairService(dials.hooks), port);
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
 * security, pointing at a password that was correct, for a problem that is
 * fixed by installing an update.
 */
{
  const mine = device("mine", "correct horse", "m".repeat(56) + ".onion");

  const listener = new PairService(mine.hooks);
  const port = await listener.open();

  // A peer speaking something else: a greeting with no version, which is what
  // every build before this one sends.
  const socket = new Socket();
  await new Promise<void>((done) => { socket.connect(port, "127.0.0.1", () => done()); });

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
    "and is not accused of skipping the password",
    !/password/i.test(said),
    said,
  );

  socket.destroy();
  await listener.close();
}

/* ---- what the sync address forwards to ----------------------------------- */

/**
 * The published address has to point at *this* protocol.
 *
 * Checked as source text, which is normally worth little — but the property is
 * a wiring fact that exists nowhere else and cannot be reached from a test, and
 * getting it wrong is not a subtle failure mode. It shipped: the sync onion was
 * configured to forward to a second, older service, so every attempt reached a
 * listener speaking a different protocol, which read the frame header as its
 * own length prefix and closed the socket. The user saw "that device closed the
 * connection" and nothing else, because from this side that is all it was.
 *
 * So: one listener, and the address forwards to it.
 */
{
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const source = readFileSync(join(process.cwd(), "src/p2p/bridge.ts"), "utf8");

  const configured = source.slice(
    source.indexOf("let forSync = 0;"),
    source.indexOf("role: \"account\""),
  );

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
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
