import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { createServer as createTcp, Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

import { createSecureContext } from "node:tls";

import { WebSocketServer } from "ws";

import { control } from "./control.mjs";

/**
 * The bridge between a browser tab and Tor.
 *
 * ## What this is, said plainly
 *
 * A browser cannot open a TCP socket. Not from JavaScript, not from
 * WebAssembly, not with any permission a user can grant. So a web page cannot
 * run Tor, cannot dial an onion address, and cannot be one of these peers on
 * its own — and anything that lets it be is a machine in the middle. This is
 * that machine.
 *
 * It is worth being exact about what that costs, because the rest of this
 * project exists to avoid it:
 *
 *   - **It does not store anything.** No account, no key, no message, no log.
 *     Nothing is written to disk here at all; the only state is a map of open
 *     sockets, and it dies with the process.
 *   - **It cannot read anything.** Every byte through it is already inside the
 *     app's own encryption, which is end to end between accounts and does not
 *     depend on the transport. A relay operator sees ciphertext.
 *   - **It can see who talks to whom, and when.** The visitor's IP address on
 *     one side, the onion address on the other, and the timing of both. That
 *     is precisely what Tor is in this app to hide, and a browser session
 *     gives it up. There is no version of this that does not.
 *
 * So this is for people who want the app in a browser and have decided that
 * trade is acceptable, on a domain they trust. It is not, and should not be
 * presented as, the same thing as running the desktop or phone build.
 *
 * ## Outbound only, deliberately
 *
 * There is no way to ask this to *listen* for anybody. A browser session
 * dials: it reaches its own devices to sync, and it reaches peers to talk.
 * Nobody dials it.
 *
 * That is a real limitation and it is also the point. Being reachable would
 * mean an onion service, an onion service means a private key, and the only
 * place that key could live is here — on the relay, for every visitor. A relay
 * that holds no keys cannot impersonate anybody no matter who runs it or what
 * happens to it. A relay that holds keys is an account server wearing a
 * different hat.
 */

/** Where Tor's SOCKS proxy is, on the machine running this. */
const SOCKS_HOST = process.env.REAPER_SOCKS_HOST ?? "127.0.0.1";
const SOCKS_PORT = Number(process.env.REAPER_SOCKS_PORT ?? 9050);

const HOST = process.env.HOST ?? "0.0.0.0";

/**
 * TLS, when this is the whole webserver rather than something behind one.
 *
 * Both paths point at ordinary PEM files, which is what certbot writes:
 *
 *   REAPER_TLS_CERT=/etc/letsencrypt/live/hytlands.com/fullchain.pem
 *   REAPER_TLS_KEY=/etc/letsencrypt/live/hytlands.com/privkey.pem
 *
 * ## Why this is not optional in practice
 *
 * A browser withholds most of what this app needs outside a secure context.
 * `crossOriginIsolated` is refused, so the isolation headers this serves do
 * nothing; notifications and the app badge are unavailable; and any future use
 * of `crypto.subtle` would fail outright. On plain HTTP the page loads and is
 * quietly a lesser client.
 *
 * And the page decides its own socket scheme from `location.protocol`, so
 * HTTPS and WSS arrive together or not at all. There is no half-way state to
 * get stuck in, which is the one merciful part of this.
 */
/**
 * The certificate, found rather than configured.
 *
 * If `cert/cert.cer` and `cert/key.key` are sitting next to this, they are the
 * certificate — no environment variables, no second command to remember.
 *
 * That is not a convenience. The alternative shipped for a day and cost an
 * evening: `npm run serve` started on plain HTTP port 8080 while a perfectly
 * good certificate sat in the folder, and there was nothing on screen to
 * suggest the *command* was the problem rather than the network. Anything that
 * quietly does the lesser thing when the greater one is available and obvious
 * is a trap, however well documented.
 *
 * The environment variables still win when given, for a certificate kept
 * somewhere else.
 */
const FOUND_CERT = resolve(process.cwd(), "cert/cert.cer");
const FOUND_KEY = resolve(process.cwd(), "cert/key.key");
const FOUND_CHAIN = resolve(process.cwd(), "cert/chain.crt");

const found = existsSync(FOUND_CERT) && existsSync(FOUND_KEY);

const TLS_CERT = process.env.REAPER_TLS_CERT ?? (found ? FOUND_CERT : undefined);
const TLS_KEY = process.env.REAPER_TLS_KEY ?? (found ? FOUND_KEY : undefined);

/**
 * Intermediates, when the certificate file holds only the leaf.
 *
 * A `.cer` from a commercial issuer usually does. Browsers on a desktop often
 * paper over the gap because they have the intermediate cached from some other
 * site, which is exactly what makes this worth naming: it works on the machine
 * you tested from and fails on a phone, on a fresh browser, and for anybody
 * who has not happened to visit another Sectigo site recently.
 *
 * Not needed when `REAPER_TLS_PFX` is used — a PKCS#12 bundle carries the
 * chain with it, which is most of why it is the easier of the two.
 */
const TLS_CHAIN =
  process.env.REAPER_TLS_CHAIN ?? (existsSync(FOUND_CHAIN) ? FOUND_CHAIN : undefined);

/**
 * A PKCS#12 bundle: key, certificate and chain in one file.
 *
 * What a `.pfx` is, and the reason it is offered here as an alternative rather
 * than as an afterthought — it removes the two ways this goes wrong by hand,
 * which are pairing a key with the wrong certificate and omitting the chain.
 */
const TLS_PFX = process.env.REAPER_TLS_PFX;
const TLS_PFX_PASSPHRASE = process.env.REAPER_TLS_PFX_PASSPHRASE;

/** Where the built client lives, when this is also serving it. */
const STATIC = process.env.REAPER_STATIC
  ? resolve(process.env.REAPER_STATIC)
  : resolve(process.cwd(), "dist");

/**
 * How many sockets one browser tab may hold open.
 *
 * A session talks to its own devices and to whichever peers it is currently
 * exchanging with; a dozen is generous. The limit is not about fairness
 * between visitors — it is about one page, buggy or hostile, being unable to
 * turn this into a port scanner.
 */
const SOCKETS_PER_SESSION = 24;

/** Nothing legitimate approaches this. It bounds a corrupt length field. */
const MAX_FRAME = 16 * 1024 * 1024;

/**
 * Only onion addresses.
 *
 * The single most important line in this file. Without it this is an open
 * proxy: any page on the internet could point a WebSocket at it and use it to
 * reach anything the host can reach — including its own loopback services and
 * anything else on the network it sits in.
 *
 * v3 only, because that is all this app has ever spoken, and matched whole
 * rather than searched for.
 */
const ONION = /^[a-z2-7]{56}\.onion$/;

function isReachable(host) {
  return typeof host === "string" && ONION.test(host.trim().toLowerCase());
}

/* ---- SOCKS5, the subset Tor implements ----------------------------------- */

/**
 * Open a connection to an onion address through Tor.
 *
 * The address is handed over as a *name* rather than resolved here — that is
 * both the only way an onion address can work and what keeps the destination
 * out of this machine's DNS.
 */
function socksConnect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let stage = "greeting";
    let settled = false;

    const fail = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(why));
    };

    const timer = setTimeout(() => fail(`timed out reaching ${host}`), 45_000);

    socket.once("error", (error) => fail(error.message));

    socket.connect(SOCKS_PORT, SOCKS_HOST, () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    socket.on("data", (chunk) => {
      if (stage === "greeting") {
        if (chunk[0] !== 0x05 || chunk[1] !== 0x00) {
          fail("the local Tor refused a no-auth SOCKS greeting");
          return;
        }

        const name = Buffer.from(host, "utf8");
        const request = Buffer.alloc(7 + name.length);
        request[0] = 0x05;
        request[1] = 0x01;
        request[2] = 0x00;
        request[3] = 0x03;
        request[4] = name.length;
        name.copy(request, 5);
        request.writeUInt16BE(port, 5 + name.length);

        stage = "connect";
        socket.write(request);
        return;
      }

      if (chunk[1] !== 0x00) {
        fail(`could not reach ${host}: socks status ${chunk[1]}`);
        return;
      }

      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // Hand back a plain stream. Everything above this speaks the app's own
      // framing and neither knows nor cares that a proxy was involved.
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      resolve(socket);
    });
  });
}

/* ---- the page itself ----------------------------------------------------- */

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",

  // Served with its own type or the browser ignores it, and the app installs
  // with a generic icon and no name.
  ".webmanifest": "application/manifest+json",
};

/**
 * Serve the built client from the same origin as the socket.
 *
 * The same origin on purpose: the page and the bridge it talks to are one
 * thing, so there is one name to trust rather than two, and no cross-origin
 * grant for anybody to be tricked into.
 */
function serve(request, response) {
  const asked = decodeURIComponent((request.url ?? "/").split("?")[0]);

  // Everything that is not a file is the app. It is a single page and its
  // routing is internal, so a deep link has to arrive at the same HTML.
  const wanted = asked === "/" || !extname(asked) ? "/index.html" : asked;

  // Resolved and then checked to still be inside the root. `..` in a URL is
  // the oldest trick there is and it works against anything that only
  // inspects the string.
  const file = join(STATIC, normalize(wanted));

  if (!file.startsWith(STATIC)) {
    response.writeHead(403).end("no");
    return;
  }

  try {
    if (!statSync(file).isFile()) throw new Error("not a file");

    response.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",

      // The page holds an account key in IndexedDB, so it must be the only
      // thing that can reach it. These are the headers that make that true —
      // and the cross-origin isolation pair is also what a WebAssembly build
      // needs for shared memory, which brotli may want later.
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    }).end(readFileSync(file));
  } catch {
    response.writeHead(404).end("not found");
  }
}

/**
 * The server, over TLS when it has been given a certificate.
 *
 * One object either way, so everything below — the WebSocket upgrade, the
 * listen, the logging — is written once and does not care.
 */
const secure = Boolean(TLS_PFX || (TLS_CERT && TLS_KEY));

/**
 * Where to listen.
 *
 * 443 when there is a certificate, 8080 when there is not — because the port
 * and the scheme are one decision, not two. Serving a domain on 443 needs
 * either a capability, a unit file that grants one, or root; `deploy/` covers
 * all three.
 */
const PORT = Number(process.env.PORT ?? (secure ? 443 : 8080));

/**
 * Read the certificate material fresh.
 *
 * A function rather than a value, because certificates are renewed in place
 * and a long-running process otherwise serves whatever it read at startup
 * until somebody restarts it — which is a site that quietly expires while the
 * renewal that fixed it sits on disk, unread.
 */
function credentials() {
  if (TLS_PFX) {
    return {
      pfx: readFileSync(TLS_PFX),
      ...(TLS_PFX_PASSPHRASE ? { passphrase: TLS_PFX_PASSPHRASE } : {}),
    };
  }

  return {
    cert: readFileSync(TLS_CERT),
    key: readFileSync(TLS_KEY),

    // Node wants the intermediates separately when they are not already in the
    // certificate file. Given as an array so a bundle containing several is
    // handled the same as one containing one.
    ...(TLS_CHAIN ? { ca: [readFileSync(TLS_CHAIN)] } : {}),
  };
}

const http = secure
  ? createHttps(
      {
        ...credentials(),

        /**
         * Re-read per handshake, so a renewal takes effect without a restart.
         *
         * `createSecureContext` and not the plain options object, which is the
         * whole of a bug worth remembering. Node's `SNICallback` wants a
         * `SecureContext`; handing it `{ cert, key }` fails inside the
         * handshake and the socket is closed with nothing written — which the
         * browser reports as `ERR_CONNECTION_CLOSED`, from a server that
         * started cleanly and is plainly listening.
         *
         * It survived testing because SNI is only sent for a *hostname*. Every
         * check was against `127.0.0.1`, so this callback never ran once. The
         * first request from a real domain was the first time it did.
         */
        SNICallback: (_name, done) => {
          try {
            done(null, createSecureContext(credentials()));
          } catch (error) {
            done(error);
          }
        },
      },
      serve,
    )
  : createHttp(serve);

/* ---- one WebSocket per tab, many sockets inside it ----------------------- */

/**
 * Framing, matching what the browser side writes.
 *
 * One WebSocket carries every connection a session has, tagged by an id the
 * page chooses. A socket each would be simpler and would also mean a dozen
 * TLS handshakes for one page, and browsers cap concurrent sockets per origin
 * in ways that would silently stall the app once a busy account opened enough
 * of them.
 *
 * Control messages are JSON text; payloads are binary with a four-byte id
 * length in front. Keeping bytes out of JSON matters: base64 would add a third
 * again to every frame, on a link that is already carrying everything.
 */
function frame(id, payload) {
  const name = Buffer.from(id, "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(name.length, 0);
  return Buffer.concat([head, name, payload]);
}

function unframe(data) {
  if (data.length < 4) return undefined;

  const length = data.readUInt32BE(0);
  if (length > 512 || data.length < 4 + length) return undefined;

  return {
    id: data.subarray(4, 4 + length).toString("utf8"),
    payload: data.subarray(4 + length),
  };
}

const sockets = new WebSocketServer({ server: http, path: "/relay" });

sockets.on("connection", (ws, request) => {
  /** Everything this tab has open, by the id it gave. */
  const open = new Map();

  /** Onion services published for this tab, by the listener id it gave. */
  const published = new Map();

  /**
   * A local listener for one onion service.
   *
   * Bound to loopback on a port the system chooses. Tor is told to forward the
   * service to it, so every connection arriving here is one somebody made to
   * this session's address — which is what lets it be handed to the browser
   * tagged with the listener it belongs to.
   */
  function createInbound(listenerId) {
    let settle;
    const bound = new Promise((resolve, reject) => { settle = { resolve, reject }; });

    const server = createTcp((socket) => {
      if (ws.readyState !== ws.OPEN) { socket.destroy(); return; }

      const id = `in-${randomUUID()}`;
      open.set(id, socket);
      socket.setNoDelay(true);

      socket.on("data", (chunk) => {
        if (ws.readyState === ws.OPEN) ws.send(frame(id, chunk), { binary: true });
      });

      socket.on("close", () => { open.delete(id); say({ t: "close", id }); });
      socket.on("error", (error) => {
        open.delete(id);
        say({ t: "error", id, message: error.message });
      });

      // Announced before any bytes are forwarded, so the browser has somewhere
      // to put them. The reverse order loses the greeting, which for the
      // pairing protocol is the whole first message.
      say({ t: "accept", id, listener: listenerId });
    });

    server.once("error", (error) => settle.reject(error));
    server.listen(0, "127.0.0.1", () => settle.resolve(server.address().port));

    return { server, bound };
  }

  async function unpublish(listenerId) {
    const held = published.get(listenerId);
    if (!held) return;

    published.delete(listenerId);
    held.server?.close();

    if (held.onion) await control.delOnion(held.onion);
  }

  const say = (message) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };

  const drop = (id) => {
    const socket = open.get(id);
    if (!socket) return;
    open.delete(id);
    socket.destroy();
  };

  ws.on("message", (data, binary) => {
    if (binary) {
      const parsed = unframe(Buffer.from(data));
      if (!parsed) return;

      const socket = open.get(parsed.id);
      if (socket && !socket.destroyed) socket.write(parsed.payload);
      return;
    }

    let message;
    try {
      message = JSON.parse(Buffer.from(data).toString("utf8"));
    } catch {
      return;
    }

    if (message?.t === "close") {
      drop(String(message.id ?? ""));
      return;
    }

    /**
     * Publish an onion service for this session.
     *
     * The key comes from the browser when it has one, and is generated by Tor
     * and handed back when it does not. Either way it is never written down
     * here — see `control.mjs`.
     *
     * A local listener per service rather than one shared: it is how an
     * inbound connection is attributed. Tor forwards to a port, so a port per
     * service is the only thing that says which session and which of its two
     * addresses a connection arrived for. Sharing one would mean guessing, and
     * handing a pairing connection to the chat transport is not a misdelivery
     * that fails gracefully — the frame header is read as a length prefix and
     * the socket dies.
     */
    if (message?.t === "listen") {
      const id = String(message.id ?? "");
      if (!id || published.has(id)) return;

      // Reserved before anything awaits, so two `listen` messages for the same
      // id cannot both proceed while Tor is thinking.
      published.set(id, { onion: undefined, server: undefined });

      void (async () => {
        try {
          const inbound = createInbound(id);
          const port = await inbound.bound;

          const service = await control.addOnion(
            port,
            typeof message.key === "string" && message.key ? message.key : undefined,
          );

          const held = published.get(id);
          if (!held || ws.readyState !== ws.OPEN) {
            inbound.server.close();
            await control.delOnion(service.onion);
            published.delete(id);
            return;
          }

          held.onion = service.onion;
          held.server = inbound.server;

          say({
            t: "listening",
            id,
            onion: service.onion,

            // Only when Tor made one. The browser stores it and sends it back
            // next time, which is what makes the address survive a refresh.
            key: service.key,
          });
        } catch (error) {
          published.delete(id);
          say({ t: "unlistened", id, message: error.message });
        }
      })();

      return;
    }

    if (message?.t === "unlisten") {
      void unpublish(String(message.id ?? ""));
      return;
    }

    if (message?.t !== "open") return;

    const id = String(message.id ?? "");
    const host = String(message.host ?? "").trim().toLowerCase();
    const port = Number(message.port ?? 0);

    if (!id || open.has(id)) return;

    // The check that keeps this from being an open proxy. Refused before a
    // socket is created, so a page cannot even use the timing to probe.
    if (!isReachable(host)) {
      say({ t: "error", id, message: "only onion addresses can be reached from here" });
      return;
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      say({ t: "error", id, message: "that is not a port" });
      return;
    }

    if (open.size >= SOCKETS_PER_SESSION) {
      say({ t: "error", id, message: "too many connections open for one session" });
      return;
    }

    // Held immediately, so a second `open` with the same id cannot race this
    // one while the circuit is still building.
    open.set(id, new Socket());

    socksConnect(host, port).then(
      (socket) => {
        // The tab gave up while Tor was still working. Nothing to hand it to.
        if (!open.has(id) || ws.readyState !== ws.OPEN) {
          socket.destroy();
          open.delete(id);
          return;
        }

        open.set(id, socket);
        socket.setNoDelay(true);

        socket.on("data", (chunk) => {
          if (ws.readyState === ws.OPEN) ws.send(frame(id, chunk), { binary: true });
        });

        socket.on("close", () => {
          open.delete(id);
          say({ t: "close", id });
        });

        socket.on("error", (error) => {
          open.delete(id);
          say({ t: "error", id, message: error.message });
        });

        say({ t: "open", id });
      },
      (error) => {
        open.delete(id);
        say({ t: "error", id, message: error.message });
      },
    );
  });

  const shut = () => {
    for (const socket of open.values()) socket.destroy();
    open.clear();

    // The address goes with the tab. Nothing stays published for a session
    // that is not there to answer — a descriptor pointing at a closed port is
    // worse than no descriptor, because peers keep trying it.
    for (const id of [...published.keys()]) void unpublish(id);
  };

  ws.on("close", shut);
  ws.on("error", shut);

  // Nothing about the visitor is recorded. The address is used to answer and
  // then forgotten with the connection — there is no log to leak, because
  // there is no log.
  void request;
});

/**
 * Frames larger than this are refused rather than buffered.
 *
 * The app's own reader has the same bound. Enforcing it here as well means a
 * page cannot make this hold sixteen megabytes per socket while it decides
 * whether to send the rest.
 */
sockets.options.maxPayload = MAX_FRAME;

/**
 * Port 80, which exists only to point at 443.
 *
 * Somebody typing `hytlands.com` gets http first — browsers differ on when
 * they try https unprompted, and the ones that do not simply fail against a
 * closed port. That reads as the site being down.
 *
 * Only when serving TLS, and never as somewhere the app is actually reachable:
 * the page holds an account key and decides its own socket scheme from
 * `location.protocol`, so a session that began on http would try to open an
 * insecure WebSocket from a page that must not have one. A redirect and
 * nothing else.
 */
if (secure && process.env.REAPER_NO_REDIRECT !== "1") {
  createHttp((request, response) => {
    const host = String(request.headers.host ?? "").split(":")[0];

    response.writeHead(301, {
      location: `https://${host}${request.url ?? "/"}`,
    }).end();
  }).listen(80, HOST, () => {
    console.log("  http :80  redirects to https");
  }).on("error", (error) => {
    // Not fatal. Port 80 being taken, or unavailable to this user, costs a
    // convenience — the site still works for anyone who arrives on https.
    console.warn(`  http :80  unavailable (${error.message}) — no redirect`);
  });
}

http.listen(PORT, HOST, () => {
  console.log(`reaper web relay on ${HOST}:${PORT} (${secure ? "https" : "http"})`);
  console.log(`  serving   ${STATIC}`);
  console.log(`  tor socks ${SOCKS_HOST}:${SOCKS_PORT}`);
  console.log("  storing   nothing");

  if (!secure) {
    console.log("");
    console.log("  Not serving TLS. A browser withholds notifications, the app");
    console.log("  badge and cross-origin isolation outside a secure context, so");
    console.log("  this is a lesser client until it has a certificate — either");
    console.log("  set REAPER_TLS_CERT and REAPER_TLS_KEY, or put this behind a");
    console.log("  proxy that terminates TLS. See deploy/ for both.");
  }
});
