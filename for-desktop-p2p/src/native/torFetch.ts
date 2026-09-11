import { connect as tlsConnect } from "node:tls";

import { socksConnect } from "../p2p/tor";

/**
 * One HTTPS GET, over Tor, with a ceiling on what it will read.
 *
 * The single place in the app that pulls bytes off the open web. Everything
 * that wants to — link previews, and the tools an AI character can be given —
 * comes through here, so there is one answer to "how does this app talk to a
 * website" and one place to change it.
 *
 * Deliberately not `fetch`. Node's fetch has no notion of a SOCKS proxy, and a
 * request that quietly went out over the ordinary network would defeat the
 * point of the app: the host would learn the user's real address. Going through
 * `socksConnect` is what keeps that from being possible by accident.
 *
 * Redirects are not followed here. Whether a redirect may be followed depends
 * on what the caller is doing — a preview will only follow one to a host on its
 * allowlist — so the decision belongs to them, not to the transport.
 */

export interface TorResponse {
  status: number;
  location?: string;
  type?: string;
  body: Buffer;
  /** True when the read stopped at `maxBytes` rather than at the end. */
  truncated: boolean;
}

export interface TorGetOptions {
  accept?: string;
  maxBytes?: number;
  timeoutMs?: number;
}

export function torGet(href: string, options: TorGetOptions = {}): Promise<TorResponse> {
  const accept = options.accept ?? "*/*";
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 45_000;

  return new Promise((resolve, reject) => {
    const url = new URL(href);
    if (url.protocol !== "https:") {
      reject(new Error("only https is fetched"));
      return;
    }

    let settled = false;
    const once = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    void (async () => {
      let raw;
      try {
        raw = await socksConnect(url.hostname, 443);
      } catch (error) {
        once(() => reject(error));
        return;
      }

      const socket = tlsConnect({ socket: raw, servername: url.hostname });
      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;

      const timer = setTimeout(() => {
        once(() => {
          socket.destroy();
          reject(new Error("timed out"));
        });
      }, timeoutMs);

      const done = (fn: () => void) => {
        clearTimeout(timer);
        once(fn);
      };

      const finish = () => {
        const buffer = Buffer.concat(chunks);
        const split = buffer.indexOf("\r\n\r\n");
        if (split < 0) {
          reject(new Error("no response"));
          return;
        }

        const head = buffer.subarray(0, split).toString("latin1");
        const [statusLine, ...headerLines] = head.split("\r\n");
        const header = (name: string) => {
          const found = headerLines.find((l) => l.toLowerCase().startsWith(name + ":"));
          return found ? found.slice(name.length + 1).trim() : undefined;
        };

        resolve({
          status: Number(statusLine.split(" ")[1]) || 0,
          location: header("location"),
          type: header("content-type"),
          body: buffer.subarray(split + 4),
          truncated,
        });
      };

      socket.on("secureConnect", () => {
        // Nothing that identifies this reader: no cookies, no referrer. The
        // point is to look like any other client behind an exit node.
        socket.write(
          `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
            `Host: ${url.host}\r\n` +
            "User-Agent: Mozilla/5.0\r\n" +
            `Accept: ${accept}\r\n` +
            "Accept-Encoding: identity\r\n" +
            "Connection: close\r\n\r\n",
        );
      });

      socket.on("data", (chunk: Buffer) => {
        total += chunk.length;
        chunks.push(chunk);

        // Counted as it arrives rather than trusting Content-Length, which the
        // server chooses and can lie about. Stopping early is a truncated
        // answer, not a failure — a page whose first 200 KB were readable is
        // still worth reading.
        if (total > maxBytes) {
          truncated = true;
          done(() => {
            socket.destroy();
            finish();
          });
        }
      });

      socket.on("error", (error) => done(() => reject(error)));
      socket.on("close", () => done(finish));
    })();
  });
}
