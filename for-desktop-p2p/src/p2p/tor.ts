import { spawn, type ChildProcess } from "node:child_process";
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
 * How long to wait for a peer before giving up on this attempt.
 *
 * Generous, because a Tor circuit to an onion service legitimately takes
 * tens of seconds — but finite, which is the part that was missing.
 */
const SOCKS_TIMEOUT_MS = 45000;

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
}

export class TorService extends EventEmitter {
  #process: ChildProcess | undefined;
  #options: TorOptions;
  #onionAddress: string | undefined;

  constructor(options: TorOptions) {
    super();
    this.#options = options;
  }

  /** `<56 chars>.onion`, once the service is published. */
  get address(): string | undefined {
    return this.#onionAddress;
  }

  get running(): boolean {
    return !!this.#process && !this.#process.killed;
  }

  /**
   * Start Tor and publish an onion service.
   *
   * Resolves once the hostname file exists, which is Tor's signal that the
   * service descriptor has been generated. Publication to the directory
   * authorities takes a further few seconds; peers may not be able to reach
   * the address immediately.
   */
  async start(): Promise<string> {
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

    const torrc = join(dataDir, "torrc");
    writeFileSync(
      torrc,
      [
        `SocksPort ${SOCKS_PORT}`,
        `ControlPort ${CONTROL_PORT}`,
        `DataDirectory ${join(dataDir, "state")}`,
        `HiddenServiceDir ${serviceDir}`,
        // Port 80 on the onion maps to our local listener, so peers dial a
        // stable well-known port and never learn the local one.
        `HiddenServicePort 80 127.0.0.1:${this.#options.targetPort}`,
        // Nothing here browses the web; refusing exit traffic avoids carrying
        // anyone else's.
        "ExitRelay 0",
      ].join("\n"),
      { mode: 0o600 },
    );

    this.#process = spawn(this.#options.torPath, ["-f", torrc], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.#process.stdout?.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (line) this.emit("log", line);
    });

    this.#process.on("exit", (code) => {
      this.emit("log", `tor exited with code ${code}`);
      this.#process = undefined;
      this.#onionAddress = undefined;
    });

    const hostnameFile = join(serviceDir, "hostname");
    const address = await waitForFile(hostnameFile, 60000);

    this.#onionAddress = address.trim();
    this.emit("ready", this.#onionAddress);

    return this.#onionAddress;
  }

  stop(): void {
    this.#process?.kill();
    this.#process = undefined;
    this.#onionAddress = undefined;
  }
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
