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
function device(name: string, password: string, onion: string) {
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

    learn: (peer) => { learned.push(peer); },
    yield: () => {},
    asked: () => {},
  };

  return { id, name, logs, pictures, learned, hooks };
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
  const onion = "a".repeat(56) + ".onion";
  const code = sealInvite({ onion, name: "Ray's desktop" }, "hunter2");

  ck("an invite fits in a QR code", code.length < 200, `${code.length} chars`);
  ck("and does not contain the address in the clear", !code.includes(onion));

  const opened = openInvite(code, "hunter2");
  ck("the right password opens it", opened.ok);
  ck("and gets the address back", opened.ok && opened.invite.onion === onion);
  ck("and the name", opened.ok && opened.invite.name === "Ray's desktop");

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

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
