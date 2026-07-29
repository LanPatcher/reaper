import { readFileSync } from "node:fs";
import { Socket } from "node:net";

/**
 * Tor's control port, which is how a session gets an address.
 *
 * ## Why this exists
 *
 * A browser session used to be outbound-only: it dialled its devices and its
 * peers, and none of them could dial it. That is a coherent design and it is
 * not the one that was asked for — being reachable is what makes a device a
 * device. It can have a friend code, it can be the one *showing* a pairing
 * code, and a peer with something to say can say it rather than waiting to be
 * asked.
 *
 * Tor can create onion services at runtime, over this port, with `ADD_ONION`.
 * That is the whole mechanism.
 *
 * ## Who holds the key
 *
 * The client does. This never generates a key it keeps: a session sends the
 * key it already has, and this registers it for as long as that session is
 * open. When a session has no key yet, Tor makes one and it is handed straight
 * back to the browser to store — the relay does not write it anywhere.
 *
 * That distinction is the entire security argument for this arrangement. An
 * onion key *is* an identity, so a relay that kept them could be any of its
 * visitors at any time, including when they are not there. This one can only
 * be a visitor while that visitor is connected and has just handed over the
 * key themselves — which is a much smaller thing, and it is the smallest thing
 * this feature can be built out of.
 *
 * Services are registered without `Flags=Detach`, so Tor drops them when this
 * control connection closes. A relay that restarts leaves nothing published.
 */

const HOST = process.env.REAPER_CONTROL_HOST ?? "127.0.0.1";
const PORT = Number(process.env.REAPER_CONTROL_PORT ?? 9051);

/**
 * How Tor is told who we are.
 *
 * Cookie authentication by default, which is what Debian and Ubuntu configure:
 * Tor writes a random file readable by its own group, and anything that can
 * read it is by definition already on the machine. `REAPER_CONTROL_PASSWORD`
 * covers a `HashedControlPassword` setup instead.
 */
const COOKIE = process.env.REAPER_CONTROL_COOKIE ?? "/run/tor/control.authcookie";
const PASSWORD = process.env.REAPER_CONTROL_PASSWORD;

/**
 * One connection, held open for the life of the process.
 *
 * Held rather than opened per request because the services live exactly as long
 * as the connection that created them. A control connection per `ADD_ONION`
 * would publish an address and withdraw it in the same breath.
 */
export class TorControl {
  #socket;
  #ready;
  #buffer = "";

  /** Replies, in order. Tor answers requests in the order it received them. */
  #waiting = [];

  /** Every service this process has registered, so they can be withdrawn. */
  #services = new Set();

  connect() {
    if (this.#ready) return this.#ready;

    this.#ready = new Promise((resolve, reject) => {
      const socket = new Socket();
      this.#socket = socket;

      socket.setEncoding("utf8");
      socket.on("data", (chunk) => this.#read(chunk));

      socket.once("error", (error) => {
        this.#ready = undefined;
        reject(new Error(
          `could not reach Tor's control port at ${HOST}:${PORT} — ` +
          `${error.message}. Add "ControlPort ${PORT}" and ` +
          `"CookieAuthentication 1" to your torrc and reload Tor.`,
        ));
      });

      socket.on("close", () => {
        // Everything registered through it is gone with it, whether or not
        // anybody noticed. Cleared so a reconnect does not try to withdraw
        // services that no longer exist.
        this.#services.clear();
        this.#ready = undefined;

        for (const pending of this.#waiting.splice(0)) {
          pending.reject(new Error("the control connection closed"));
        }
      });

      socket.connect(PORT, HOST, () => {
        this.#authenticate().then(() => resolve(this), reject);
      });
    });

    return this.#ready;
  }

  async #authenticate() {
    if (PASSWORD) {
      await this.#send(`AUTHENTICATE "${PASSWORD.replace(/"/g, '\\"')}"`);
      return;
    }

    let cookie;

    try {
      cookie = readFileSync(COOKIE).toString("hex");
    } catch (error) {
      throw new Error(
        `could not read Tor's control cookie at ${COOKIE} (${error.message}). ` +
        `The relay's user needs to be in Tor's group — on Debian and Ubuntu ` +
        `that is "usermod -aG debian-tor <user>" — or set ` +
        `REAPER_CONTROL_PASSWORD to match a HashedControlPassword in torrc.`,
      );
    }

    await this.#send(`AUTHENTICATE ${cookie}`);
  }

  /**
   * Publish an onion service forwarding to a local port.
   *
   * `key` is an existing `ED25519-V3:<base64>` when the session has one, and
   * absent when it does not — in which case Tor makes one and it is returned
   * for the browser to keep. Either way this process does not store it.
   */
  async addOnion(localPort, key) {
    await this.connect();

    const what = key ? key : "NEW:ED25519-V3";
    const reply = await this.#send(`ADD_ONION ${what} Port=80,127.0.0.1:${localPort}`);

    const id = /ServiceID=([a-z2-7]{56})/i.exec(reply);
    if (!id) throw new Error(`Tor did not return a service id: ${reply.trim()}`);

    this.#services.add(id[1]);

    return {
      onion: `${id[1]}.onion`,

      // Only present when Tor generated one. A session that supplied its own
      // key gets nothing back, because nothing new exists to tell it about.
      key: /PrivateKey=(ED25519-V3:[^\r\n]+)/i.exec(reply)?.[1],
    };
  }

  /** Stop publishing. Safe to call for something already gone. */
  async delOnion(onion) {
    const id = String(onion ?? "").replace(/\.onion$/i, "");
    if (!id || !this.#services.has(id)) return;

    this.#services.delete(id);

    try {
      await this.#send(`DEL_ONION ${id}`);
    } catch {
      // The connection went, which withdrew it anyway.
    }
  }

  #send(line) {
    return new Promise((resolve, reject) => {
      if (!this.#socket || this.#socket.destroyed) {
        reject(new Error("the control connection is not open"));
        return;
      }

      this.#waiting.push({ resolve, reject });
      this.#socket.write(`${line}\r\n`);
    });
  }

  /**
   * Read replies, which are line-based and multi-line.
   *
   * Tor marks continuation with `250-` and the final line with `250 `. Anything
   * that does not start 2xx is a refusal and is raised as one — the alternative
   * is a caller parsing a service id out of an error message.
   */
  #read(chunk) {
    this.#buffer += chunk;

    for (;;) {
      // A complete reply ends with a line whose fourth character is a space.
      const match = /^(\d{3}) [^\r\n]*\r?\n/m.exec(this.#buffer);
      if (!match) return;

      const end = match.index + match[0].length;
      const reply = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end);

      const pending = this.#waiting.shift();
      if (!pending) continue;

      if (match[1].startsWith("2")) pending.resolve(reply);
      else pending.reject(new Error(`Tor refused: ${reply.trim()}`));
    }
  }
}

export const control = new TorControl();
