import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";

/**
 * Tor integration: reachability without port forwarding.
 *
 * Each peer runs an onion service. Both sides make *outbound* connections into
 * the Tor network and meet inside it, so NAT never applies and nothing has to
 * be configured on a router. This is how Quiet, Briar and Session all achieve
 * "it just works" — and it is the only approach that needs neither forwarding
 * nor a rendezvous server.
 *
 * ## What Tor can and cannot carry
 *
 * TCP only. There is no UDP over Tor, which means the usual media path for
 * voice is unavailable — audio travels over the same stream as everything
 * else, as `audio` frames in transport.ts.
 *
 * An earlier version negotiated a direct peer-to-peer media path over Tor and
 * sent audio outside it, which gave conversational latency. That was dropped
 * deliberately: a direct media path reveals each caller's IP to the other, and
 * the point of this transport is that no address is ever exposed. Voice is
 * turn-taking as a result. That is the trade, made knowingly.
 */

/** Where Tor's SOCKS proxy listens. */
export const SOCKS_PORT = 9250;

/** Where Tor's control port listens. */
const CONTROL_PORT = 9251;

/**
 * How long to wait for a hidden-service descriptor to actually be accepted
 * by the network, once its address is known.
 *
 * Generous, and deliberately much longer than `SOCKS_BOOT_MS`: publishing a
 * descriptor needs a *bootstrapped* client with working circuits, which is
 * usually tens of seconds behind the SOCKS port opening and can be worse on
 * a slow network. This is the number that decides how long "still
 * publishing" is allowed to mean before it is reported as a real failure.
 */
const PUBLISH_TIMEOUT_MS = 120000;

/**
 * How long to wait for a peer before giving up on this attempt.
 *
 * Generous, because a Tor circuit to an onion service legitimately takes
 * tens of seconds — but finite, which is the part that was missing.
 */
const SOCKS_TIMEOUT_MS = 45000;

/**
 * How long to give tor to open that port at startup.
 *
 * Binding a loopback port is immediate; what is actually being waited on is
 * the process starting, reading its torrc and getting far enough to listen —
 * which on a cold machine with a slow disk is seconds, not milliseconds. Well
 * short of the bootstrap, which happens after this and which nothing here
 * blocks on.
 */
const SOCKS_BOOT_MS = 30000;

export interface TorOptions {
  /** Directory for Tor's state and the onion service key. */
  dataDir: string;

  /**
   * Path to the `tor` executable.
   *
   * Shipped with the app: `npm run vendor:tor` copies it into `vendor/tor/`,
   * and Forge packages that as `resources/tor/`. There is no fallback if it is
   * missing — every other route to a peer was removed on purpose, so an app
   * without Tor cannot reach anyone.
   */
  torPath: string;

  /** Local port the onion service forwards to. */
  targetPort: number;

  /**
   * Local port the *sync* service forwards to, if there is one.
   *
   * One tor process, two hidden services. Running a second copy of tor for the
   * second address was the obvious arrangement and it cannot work: the SOCKS
   * and control ports below are fixed, so the second process fails to bind,
   * exits immediately, and never publishes anything. The symptom was a sync
   * address that was permanently "still being published" — no address to copy,
   * no code to scan, and nothing on screen suggesting a process had died.
   *
   * tor hosts as many services as it is given directories for, which is what
   * the iOS client already does.
   */
  syncPort?: number;

  /**
   * Which of this device's two services this is.
   *
   * "account" is the address in a friend code — the one exactly one of your
   * devices publishes at a time. "sync" is this device's own address, which
   * only your other devices dial and which is published unconditionally.
   *
   * The desktop keeps them apart by data directory and does not need to be
   * told. iOS does: there, Tor is a single linked-in client publishing both
   * services at once, so the shim has to know which address it is being asked
   * for rather than inferring it from a path it does not own.
   */
  role?: "account" | "sync";

  /**
   * Whether to publish the account address as well as the sync one.
   *
   * False on a device that another of your devices has taken the address from.
   * The sync service stays up regardless — see `#torrc`.
   */
  account?: boolean;
}

export class TorService extends EventEmitter {
  #process: ChildProcess | undefined;
  #options: TorOptions;
  #onionAddress: string | undefined;
  #syncAddress: string | undefined;

  /**
   * The control connection used only to learn when a descriptor has
   * genuinely been accepted by the network — see `#confirmPublication`.
   * Nothing about carrying traffic depends on it; a device that never
   * manages to open it still works, it just never resolves the "confirmed"
   * side of the wait and eventually reports that honestly instead of lying
   * about it sooner.
   */
  #control: Socket | undefined;

  /**
   * Addresses tor has told us, over the control port, that it actually
   * uploaded a descriptor for — as opposed to `#onionAddress`/`#syncAddress`,
   * which only mean the *key* exists and says what the address would be.
   * Bare, without the `.onion` suffix, matching the control protocol's own
   * `HSAddress` field.
   */
  #uploaded = new Set<string>();

  /** Whether the *account* address specifically has been confirmed reachable. */
  #accountConfirmed = false;

  /** Whether the account address has been confirmed genuinely published. */
  get published(): boolean {
    return this.#accountConfirmed;
  }

  /**
   * Publish the account address, or stop publishing it.
   *
   * Restarts tor, because its configuration is read once at startup. The sync
   * service survives that: its key is on disk, so it comes back at the same
   * address, and the only thing that changes is whether the account descriptor
   * is offered alongside it.
   */
  async setAccount(publish: boolean): Promise<void> {
    if ((this.#options.account !== false) === publish) return;

    this.#options.account = publish;
    if (!this.running) return;

    this.stop();
    await this.start();
  }

  constructor(options: TorOptions) {
    super();
    this.#options = options;
  }

  /** `<56 chars>.onion`, once the service is published. */
  get address(): string | undefined {
    return this.#onionAddress;
  }

  /**
   * Where this device's *own* devices reach it.
   *
   * A second service with its own key. Separate from the address above because
   * exactly one device publishes that one at a time — so dialling it reaches
   * whichever device is already holding, which is precisely the one that does
   * not need to be reached.
   *
   * Published a little after the first, so this is undefined for a while after
   * `start` resolves. Watched rather than waited for: a device that can be
   * reached by its friends before it can be reached by its own laptop is a
   * perfectly ordinary state.
   */
  get syncAddress(): string | undefined {
    return this.#syncAddress;
  }

  get running(): boolean {
    return !!this.#process && !this.#process.killed;
  }

  /**
   * Start Tor, and do not return until it can carry an outbound connection.
   *
   * Two things are waited for, in this order, and the order is the point:
   *
   *   1. **The SOCKS port**, always. This is what makes the process a client,
   *      and it is what every dial goes through — including the dial that
   *      links a brand-new device, which happens before this app has an
   *      account, an address, or anything to publish. Waiting for it here is
   *      what lets the rest of the app treat "Tor is up" as meaning "you can
   *      reach somebody".
   *
   *   2. **The account address**, but only when the account service is
   *      actually configured. This used to be waited for unconditionally, so a
   *      client-only Tor — the one linking starts — sat for the full sixty
   *      seconds on a hostname file for a service its own configuration did not
   *      contain, and then threw. A minute of nothing, followed by an error
   *      about publishing, on the one code path where publishing is not
   *      wanted.
   *
   * Publication to the directory authorities takes a further few seconds after
   * the hostname appears; peers may not be able to reach the address the
   * instant this resolves.
   */
  async start(): Promise<string | undefined> {
    if (!existsSync(this.#options.torPath)) {
      throw new Error(
        `tor not found at ${this.#options.torPath}\n` +
          `Run "npm run vendor:tor" to install it. Without it this app ` +
          `cannot reach any peer — there is no direct-connection fallback.`,
      );
    }

    const dataDir = this.#options.dataDir;
    const serviceDir = join(dataDir, "onion");
    mkdirSync(serviceDir, { recursive: true, mode: 0o700 });

    /**
     * The client half, which is never conditional.
     *
     * SOCKS, the control port and the data directory are what make this a Tor
     * *client* — the thing every outbound connection goes through. They have
     * nothing to do with which services are published, and separating them
     * from the service lines below is not tidiness.
     *
     * These three used to be in the same array as the hidden-service lines,
     * and a device that was not publishing its account address emptied that
     * array — all of it. The result was a tor with no `SocksPort`, which falls
     * back to 9050, while `socksConnect` dials the 9250 configured here. Every
     * outbound connection was refused, and the app reported the only thing it
     * could see: Tor has not opened its SOCKS port.
     *
     * That is the state a brand-new device is in for its entire life up to the
     * moment it links — `ensureTorClient` starts Tor with `account: false`
     * precisely because there is no account to publish yet — so the one path
     * that had to work before anything else was the one path guaranteed not to.
     */
    const lines = [
      `SocksPort ${SOCKS_PORT}`,
      `ControlPort ${CONTROL_PORT}`,
      `DataDirectory ${join(dataDir, "state")}`,
      // The control port exists so this process can find out when a
      // descriptor actually publishes — see `#confirmPublication` below —
      // and without this line tor opens it with no authentication at all,
      // which it warns about for good reason: any other local process could
      // connect and reconfigure it. `CookieAuthentication` makes the only
      // thing that can authenticate the thing that can already read this
      // device's own Tor state directory.
      "CookieAuthentication 1",
    ];

    // Whether the *account* service is offered at all.
    //
    // A device that is not holding the address must not publish a descriptor
    // for it, or two devices answer at one address and peers reach whichever
    // published most recently. But it must go on publishing its **sync**
    // address, and that distinction is the whole of this method: they are two
    // services in one tor process, and withdrawing one used to mean stopping
    // the process, which took the other with it.
    //
    // What that cost was not small. A displaced device had no sync address, so
    // it could not be dialled by its sibling, could not show a pairing code,
    // and could not be reached to hand the account back — which is precisely
    // when reaching it matters most. Sync worked in one direction only, and the
    // "signed in elsewhere" screen had no way to resolve itself.
    if (this.#options.account) {
      lines.push(`HiddenServiceDir ${serviceDir}`);
      // Port 80 on the onion maps to our local listener, so peers dial a
      // plain address with no port on the end of it.
      lines.push(`HiddenServicePort 80 127.0.0.1:${this.#options.targetPort}`);
    }


    // The second service, for this device's own devices.
    //
    // These two lines are an ordered pair, and so are the two above: tor
    // applies each `HiddenServicePort` to whichever `HiddenServiceDir`
    // preceded it. Interleaving them, or sorting the file, silently points
    // both services at one port.
    const syncDir = join(dataDir, "sync");

    if (this.#options.syncPort) {
      mkdirSync(syncDir, { recursive: true, mode: 0o700 });
      lines.push(`HiddenServiceDir ${syncDir}`);
      lines.push(`HiddenServicePort 80 127.0.0.1:${this.#options.syncPort}`);
    }

    // Nothing here browses the web; refusing exit traffic avoids carrying
    // anyone else's.
    lines.push("ExitRelay 0");

    const torrc = join(dataDir, "torrc");
    writeFileSync(torrc, lines.join("\n"), { mode: 0o600 });

    this.#process = spawn(this.#options.torPath, ["-f", torrc], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.#process.stdout?.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (line) this.emit("log", line);
    });

    // Tor itself writes its own log to the file below, via `Log ... file`,
    // so stdout is normally near-empty — but a dynamic linker failure (a
    // missing shared library the binary was built against, which the
    // packaged app's own dependency list does not necessarily cover; see
    // forge.config.ts) prints straight to stderr and exits before tor's
    // logging even starts. Unread until now, which meant that exact
    // failure — the binary existing but refusing to run — was invisible:
    // `waitForSocks` just timed out after 30 seconds with no clue why.
    this.#process.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (line) this.emit("log", `[stderr] ${line}`);
    });

    this.#process.on("error", (error) => {
      this.emit("log", `tor could not be started: ${error.message}`);
    });

    this.#process.on("exit", (code, signal) => {
      this.emit(
        "log",
        `tor exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
      );
      this.#process = undefined;
      this.#onionAddress = undefined;
    });

    // Before anything about addresses. A tor that has not opened SOCKS cannot
    // carry the dial that linking is, and every second spent waiting for a
    // descriptor first is a second the thing that actually matters is not
    // being waited for.
    await waitForSocks(SOCKS_BOOT_MS);
    this.emit("log", `socks is accepting connections on ${SOCKS_PORT}`);

    // Best-effort and backgrounded: nothing that carries traffic depends on
    // this connection existing, only on knowing when a descriptor has
    // actually gone out — see `#confirmPublication`.
    void this.#connectControl();

    // The sync service publishes on its own schedule, usually a few seconds
    // behind. Watched in the background rather than waited for, so nothing
    // that needs the first address is held up by the second.
    if (this.#options.syncPort) void this.#watchSync(join(syncDir, "hostname"));

    // Client-only: there is no account descriptor to wait for, because none
    // was configured. Returning here is what makes linking on a fresh device
    // take seconds rather than time out after a minute.
    if (!this.#options.account) return undefined;

    const hostnameFile = join(serviceDir, "hostname");
    const address = (await waitForFile(hostnameFile, 60000)).trim();

    this.#onionAddress = address;
    this.emit("ready", address);

    // The file above only proves the address was *derived* from the key —
    // tor writes it the moment the service directory is read, which needs
    // no network at all. Whether anyone can actually reach it is a separate
    // question, answered only once the control port reports the descriptor
    // was genuinely accepted somewhere. Confirmed in the background so
    // `start()` keeps resolving as soon as the address is known, same as
    // before; callers that need to know reachability watch `"published"` or
    // poll `.published` instead of trusting `"ready"` to mean it.
    void this.#confirmPublication(address).then((confirmed) => {
      if (confirmed) {
        this.#accountConfirmed = true;
        this.emit("published", address);
        this.emit("log", `onion service confirmed reachable: ${address}`);
      } else {
        this.emit(
          "log",
          `onion service address is ${address}, but publication was not ` +
            `confirmed within ${Math.round(PUBLISH_TIMEOUT_MS / 1000)}s`,
        );
      }
    });

    return address;
  }

  async #watchSync(hostnameFile: string): Promise<void> {
    try {
      const found = (await waitForFile(hostnameFile, 120000)).trim();
      this.#syncAddress = found;
      this.emit("sync", found);

      const confirmed = await this.#confirmPublication(found);
      this.emit(
        "log",
        confirmed
          ? `sync service confirmed reachable: ${found}`
          : `sync service address is ${found}, but publication was not ` +
              `confirmed within ${Math.round(PUBLISH_TIMEOUT_MS / 1000)}s`,
      );
    } catch {
      // Given up on quietly. A device with no sync address still works — it
      // simply has to be the one that dials rather than the one that answers.
      this.emit("log", "the sync service did not publish an address");
    }
  }

  // ---- confirming publication, over the control port -----------------------
  //
  // A hidden-service directory produces a `hostname` file the instant tor
  // reads the key — no network involved, since the address is just the
  // public key spelled out in base32. Treating that file as "published" (the
  // .onion equivalent of "online") was the mistake here for a long time: it
  // reported an address as reachable up to a minute before the network
  // actually had a route to it, so anything that tried to connect based on
  // that message failed, and looked from the outside like publishing simply
  // never happened. This is only real evidence: tor's own `HS_DESC UPLOADED`
  // control event, which it emits once a descriptor has actually been
  // accepted by an HSDir.

  /**
   * Open the control connection and start watching for descriptor uploads.
   *
   * Idempotent. Best-effort: a failure here is reported through the normal
   * log, and every `#confirmPublication` wait still resolves — honestly, to
   * "not confirmed" — via its own timeout rather than hanging on a
   * connection that is never coming.
   */
  async #connectControl(): Promise<void> {
    if (this.#control) return;

    const socket = new Socket();
    this.#control = socket;

    const lines: string[] = [];
    let notifyLine: (() => void) | undefined;
    let buffer = "";

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");

      let index: number;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        // An asynchronous event, not a reply to something sent below.
        if (line.startsWith("650")) {
          this.#handleControlEvent(line);
          continue;
        }

        lines.push(line);
        notifyLine?.();
      }
    });

    socket.on("close", () => {
      if (this.#control === socket) this.#control = undefined;
    });
    // Swallowed deliberately: the connect attempt below has its own
    // listener, and every later write on a socket that has already errored
    // is a no-op, not a second failure to report.
    socket.on("error", () => {});

    const nextLine = (): Promise<string> => {
      const existing = lines.shift();
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve) => {
        notifyLine = () => {
          const line = lines.shift();
          if (line !== undefined) {
            notifyLine = undefined;
            resolve(line);
          }
        };
      });
    };

    try {
      // Written by tor at startup because `CookieAuthentication 1` is in the
      // torrc above. 32 arbitrary bytes, not text — read as a buffer, not
      // through `waitForFile`, which would corrupt it at the first byte that
      // is not valid UTF-8.
      const cookiePath = join(this.#options.dataDir, "state", "control_auth_cookie");
      const cookie = await waitForFileBuffer(cookiePath, 10000);

      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.connect(CONTROL_PORT, "127.0.0.1", () => {
          socket.removeListener("error", reject);
          resolve();
        });
      });

      socket.write(`AUTHENTICATE ${cookie.toString("hex")}\r\n`);
      const authReply = await nextLine();
      if (!authReply.startsWith("250")) {
        throw new Error(`authentication refused: ${authReply}`);
      }

      socket.write("SETEVENTS HS_DESC\r\n");
      const eventsReply = await nextLine();
      if (!eventsReply.startsWith("250")) {
        throw new Error(`could not subscribe to HS_DESC events: ${eventsReply}`);
      }
    } catch (error) {
      this.emit(
        "log",
        `control port unavailable, publication will not be confirmed: ${(error as Error).message}`,
      );
      socket.destroy();
      if (this.#control === socket) this.#control = undefined;
    }
  }

  /**
   * `650 HS_DESC UPLOADED <address> <AuthType> <HsDir> ...` is the one line
   * this is watching for. `<address>` arrives without the `.onion` suffix,
   * matching the control protocol's own `HSAddress` field — everything this
   * is compared against is normalised the same way, in `#confirmPublication`.
   */
  #handleControlEvent(line: string): void {
    const parts = line.split(" ");
    if (parts[1] !== "HS_DESC" || parts[2] !== "UPLOADED") return;

    const address = (parts[3] ?? "").toLowerCase().replace(/\.onion$/, "");
    if (!address) return;

    this.#uploaded.add(address);
    this.emit("_uploaded", address);
  }

  /**
   * Wait until the control port reports this specific address was actually
   * uploaded, or give up after `PUBLISH_TIMEOUT_MS`.
   *
   * `"_uploaded"` is internal — emitted on this same `EventEmitter` rather
   * than a separate one because the class already is one, and a second
   * pub/sub mechanism next to the first would be one more thing to keep in
   * step for no benefit here.
   */
  async #confirmPublication(fullAddress: string): Promise<boolean> {
    await this.#connectControl();

    const bare = fullAddress.toLowerCase().replace(/\.onion$/, "");
    if (this.#uploaded.has(bare)) return true;

    return new Promise((resolve) => {
      const onUploaded = (address: string) => {
        if (address !== bare) return;
        clearTimeout(timer);
        this.removeListener("_uploaded", onUploaded);
        resolve(true);
      };

      const timer = setTimeout(() => {
        this.removeListener("_uploaded", onUploaded);
        resolve(false);
      }, PUBLISH_TIMEOUT_MS);

      this.on("_uploaded", onUploaded);
    });
  }

  stop(): void {
    this.#process?.kill();
    this.#process = undefined;
    this.#onionAddress = undefined;
    this.#syncAddress = undefined;
    this.#control?.destroy();
    this.#control = undefined;
    this.#uploaded.clear();
    this.#accountConfirmed = false;
  }
}

// ---- the address, as something that can be moved ---------------------------
//
// An onion address is not stored anywhere. It *is* a public key, written down
// in base32 — which is why nobody can assign you one and why nobody can take
// yours away. The consequence is the part that matters here: the only copy of
// it in existence is the private key in the service directory, and a device
// that does not have that key cannot be that address, no matter what else it
// holds.
//
// That is why these functions exist. The identity export carries the signing
// key, which preserves who you are in the log — but a friend code contains the
// *address*, and every code you have ever handed out points at this key. An
// import without it produces an account that is recognisably you to anyone
// already connected and unreachable to everyone else, which is the same as
// unusable.

/**
 * A hidden service's identity: the three files tor keeps in its service
 * directory.
 *
 * Carried as base64 because this travels inside a JSON bundle. The two key
 * files are not raw keys — tor prefixes each with a 32-byte tag naming the
 * format, and a file without it is rejected at startup.
 */
export interface OnionKey {
  /** `hs_ed25519_secret_key`: 32-byte tag, then 64 bytes of expanded key. */
  secret: string;
  /** `hs_ed25519_public_key`: 32-byte tag, then the 32-byte key. */
  public: string;
  /** `<56 chars>.onion`, which is that public key encoded. */
  hostname: string;
}

const SECRET_TAG = "== ed25519v1-secret: type0 ==";
const PUBLIC_TAG = "== ed25519v1-public: type0 ==";

/** Where tor keeps the service key, given its data directory. */
export function onionDir(dataDir: string): string {
  return join(dataDir, "onion");
}

/** The tag tor writes at the head of a key file, padded to 32 bytes. */
function tag(text: string): Buffer {
  const padded = Buffer.alloc(32);
  padded.write(text, "ascii");
  return padded;
}

/**
 * The address a public key spells.
 *
 * Version 3 onion addresses are `base32(key ‖ checksum ‖ version)`, where the
 * checksum is the first two bytes of `SHA3-256(".onion checksum" ‖ key ‖
 * version)`. Computed here rather than trusting the `hostname` file, so a
 * bundle whose files do not agree with each other is caught while it can still
 * be refused — instead of being written out and discovered when tor declines
 * to start with the app already halfway through replacing an identity.
 */
export function onionAddress(publicKey: Buffer): string {
  if (publicKey.length !== 32) {
    throw new Error("an onion public key is 32 bytes");
  }

  const version = Buffer.from([0x03]);
  const checksum = createHash("sha3-256")
    .update(Buffer.concat([Buffer.from(".onion checksum", "ascii"), publicKey, version]))
    .digest()
    .subarray(0, 2);

  return base32(Buffer.concat([publicKey, checksum, version])) + ".onion";
}

/**
 * RFC 4648 base32, lower case, unpadded.
 *
 * Written out because the input is always 35 bytes — exactly seven groups of
 * five — so none of the padding cases a general implementation exists to
 * handle can arise, and a dependency for eleven lines is a poor trade in the
 * one function that decides whether an address is right.
 */
function base32(bytes: Buffer): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";

  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Read this device's service key, if it has one.
 *
 * Absent is a normal answer, not an error: tor may never have been started, or
 * may not have finished publishing. The caller decides what that means — for a
 * backup it means the bundle carries no address, which is worth saying out
 * loud rather than failing over.
 */
export function readOnionKey(dataDir: string): OnionKey | undefined {
  const dir = onionDir(dataDir);

  const secret = join(dir, "hs_ed25519_secret_key");
  const publicKey = join(dir, "hs_ed25519_public_key");
  const hostname = join(dir, "hostname");

  if (!existsSync(secret) || !existsSync(publicKey)) return undefined;

  // The file is read when it says something, and the address is computed when
  // it does not.
  //
  // Existing and being empty is a real state, not a hypothetical one: tor
  // creates the service directory and writes the hostname at slightly
  // different moments, and an export taken in that window would otherwise
  // record a key with no address beside it. The key is what decides the
  // address, so there is never a reason to report not knowing it.
  const written = existsSync(hostname)
    ? readFileSync(hostname, "utf8").trim()
    : "";

  const address = written || onionAddress(readFileSync(publicKey).subarray(32));

  return {
    secret: readFileSync(secret).toString("base64"),
    public: readFileSync(publicKey).toString("base64"),
    hostname: address,
  };
}

/**
 * Check a service key without writing anything.
 *
 * Separate from writing on purpose. Importing an identity is destructive — it
 * closes every store and overwrites the keystore — and a bundle that turns out
 * to be malformed *after* that has left the device with no identity at all.
 * So the whole of the validation happens first, and the write that follows
 * cannot fail on anything this would have caught.
 *
 * Returns the address the key actually spells, which is not necessarily the
 * one written in the bundle.
 */
export function checkOnionKey(key: OnionKey): string {
  const secret = Buffer.from(key.secret ?? "", "base64");
  const publicKey = Buffer.from(key.public ?? "", "base64");

  if (secret.length !== 96 || !secret.subarray(0, 32).equals(tag(SECRET_TAG))) {
    throw new Error("the onion secret key in that file is not in tor's format");
  }

  if (publicKey.length !== 64 || !publicKey.subarray(0, 32).equals(tag(PUBLIC_TAG))) {
    throw new Error("the onion public key in that file is not in tor's format");
  }

  const address = onionAddress(publicKey.subarray(32));

  // A mismatch means the files were assembled from different services, and
  // restoring them would produce a device that publishes at one address while
  // telling everyone it is at another.
  if (key.hostname && key.hostname.trim().toLowerCase() !== address) {
    throw new Error("that file's onion key and address do not match each other");
  }

  return address;
}

/**
 * Install a service key, so this device answers at that address.
 *
 * tor reads the directory once at startup, so this takes effect on the next
 * start and not before — which is why importing an identity asks for a
 * restart.
 *
 * The permissions are a precondition rather than a precaution: tor refuses to
 * use a service directory that is readable by anyone else, and the refusal is
 * reported as a startup failure with no obvious cause.
 */
export function writeOnionKey(dataDir: string, key: OnionKey): string {
  const address = checkOnionKey(key);
  const dir = onionDir(dataDir);

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  writeFileSync(join(dir, "hs_ed25519_secret_key"), Buffer.from(key.secret, "base64"), { mode: 0o600 });
  writeFileSync(join(dir, "hs_ed25519_public_key"), Buffer.from(key.public, "base64"), { mode: 0o600 });
  writeFileSync(join(dir, "hostname"), address + "\n", { mode: 0o600 });

  return address;
}

/**
 * Which Tor is bundled, by asking it.
 *
 * Deliberately a report and not an update.
 *
 * Automatically downloading and executing a replacement would make this the
 * highest-value thing in the app to compromise: every byte the user sends
 * passes through it, and a substituted binary would deanonymise them silently
 * and completely. The current build takes Tor from a Tor Browser install the
 * user already obtained and verified, which keeps that trust decision with
 * them and out of a background task.
 *
 * So this establishes the fact — what version is here — and leaves the
 * judgement to a human who can check a signature.
 */
export function torVersion(torPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (!existsSync(torPath)) { resolve(undefined); return; }

    let output = "";
    const probe = spawn(torPath, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });

    probe.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    probe.on("error", () => resolve(undefined));

    probe.on("close", () => {
      // "Tor version 0.4.8.12." — the number is what matters.
      const found = /Tor version ([0-9][0-9a-z.-]*)/i.exec(output);
      resolve(found ? found[1].replace(/\.$/, "") : undefined);
    });

    // A binary that will not answer in a few seconds is not going to.
    setTimeout(() => { try { probe.kill(); } catch { /* gone */ } resolve(undefined); }, 5000)
      .unref?.();
  });
}

/**
 * Compare two dotted versions.
 *
 * Returns negative when `a` is older. Written out rather than pulled in
 * because the shape here is fixed and a dependency for eight lines of
 * comparison is a poor trade in something this security-sensitive.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const right = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Poll for a file Tor writes when it is ready.
 *
 * Polling rather than watching because Tor creates the directory and the file
 * separately, and a watcher registered on a directory that does not exist yet
 * silently never fires.
 */
/**
 * Wait until Tor's SOCKS port accepts a connection.
 *
 * Asked by opening one and dropping it, rather than by reading a log line or
 * trusting an elapsed timer. Those two were the alternatives and both are
 * indirect: a log line means tor *said* it opened a port, and an elapsed timer
 * means nothing at all. Opening the port is the same act the next caller is
 * about to perform, so a success here is the only kind of evidence that
 * transfers.
 *
 * Cheap enough to poll at this rate: it is a loopback connect against a port
 * on the same machine, and it stops the first time it works.
 */
async function waitForSocks(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const probe = new Socket();
      let answered = false;

      const settle = (ok: boolean) => {
        if (answered) return;
        answered = true;
        probe.destroy();
        resolve(ok);
      };

      probe.setTimeout(2000, () => settle(false));
      probe.once("error", () => settle(false));
      probe.connect(SOCKS_PORT, "127.0.0.1", () => settle(true));
    });

    if (open) return;

    if (Date.now() > deadline) {
      throw new Error(
        `tor did not open its SOCKS port on ${SOCKS_PORT} within ${timeoutMs}ms`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (existsSync(path)) {
      const contents = readFileSync(path, "utf8");
      if (contents.trim()) return contents;
    }

    if (Date.now() > deadline) {
      throw new Error(`tor did not publish an onion service within ${timeoutMs}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Poll for a file to exist and be non-empty, returning its raw bytes.
 *
 * Used for the control auth cookie, which is 32 arbitrary bytes — reading it
 * as text the way `waitForFile` does would corrupt any byte that is not
 * valid UTF-8, silently, rather than fail loudly.
 */
async function waitForFileBuffer(path: string, timeoutMs: number): Promise<Buffer> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (existsSync(path)) {
      const contents = readFileSync(path);
      if (contents.length > 0) return contents;
    }

    if (Date.now() > deadline) {
      throw new Error(`the control auth cookie did not appear within ${timeoutMs}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Open a TCP connection to `host:port` through Tor's SOCKS5 proxy.
 *
 * Written by hand rather than pulled from a package because the subset needed
 * here is small and fixed: no authentication, one command, and hostnames are
 * passed through for Tor to resolve. That last part is essential — resolving
 * a .onion locally is impossible, and resolving a normal hostname locally
 * would leak the lookup outside Tor.
 */
export function socksConnect(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let stage: "greeting" | "connect" = "greeting";

    // Tor will happily spend minutes on a peer that is simply not running,
    // and without a bound the dial loop stalls on the first offline contact
    // and never reaches anyone after them. Failing fast and retrying on the
    // next pass is strictly better than waiting.
    const timer = setTimeout(
      () => fail(`timed out connecting to ${host}`),
      SOCKS_TIMEOUT_MS,
    );

    const fail = (message: string) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(message));
    };

    socket.once("error", (error) => fail(error.message));

    socket.connect(SOCKS_PORT, "127.0.0.1", () => {
      // Greeting: SOCKS5, one method, "no authentication".
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    socket.on("data", (chunk) => {
      if (stage === "greeting") {
        if (chunk[0] !== 0x05 || chunk[1] !== 0x00) {
          fail("tor socks refused the no-auth greeting");
          return;
        }

        const name = Buffer.from(host, "utf8");
        const request = Buffer.alloc(7 + name.length);
        request[0] = 0x05; // version
        request[1] = 0x01; // CONNECT
        request[2] = 0x00; // reserved
        request[3] = 0x03; // address type: domain name
        request[4] = name.length;
        name.copy(request, 5);
        request.writeUInt16BE(port, 5 + name.length);

        stage = "connect";
        socket.write(request);
        return;
      }

      if (chunk[1] !== 0x00) {
        fail(`tor could not reach ${host}: socks status ${chunk[1]}`);
        return;
      }

      // Connected. Hand the raw socket back; from here it is an ordinary
      // stream and the existing framing applies unchanged.
      clearTimeout(timer);
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      resolve(socket);
    });
  });
}
