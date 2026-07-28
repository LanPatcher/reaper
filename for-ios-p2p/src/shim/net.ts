import { Socket as Native } from "@reaper/socket";

import { Buffer } from "buffer";

import { EventEmitter } from "./events";

/**
 * `node:net`, over the native socket plugin.
 *
 * This is the shim that lets `transport.ts` — the real one, the same file the
 * desktop ships — compile and run on a phone. Everything else was already
 * portable; sockets were the one thing a WebView simply does not have.
 *
 * ## What the transport actually uses
 *
 * A deliberately small surface, which is why this is tractable:
 *
 *   - `new Socket()`, `.connect(port, host, cb)`, `.write()`, `.destroy()`,
 *     `.setNoDelay()`, and `on("data" | "close" | "error")`.
 *   - `createServer(handler)`, `.listen(port, host, cb)`, `.address()`,
 *     `.close()`, and `on("error")`.
 *
 * Nothing streams, nothing pipes, nothing uses back-pressure. The transport
 * length-prefixes its own frames and does its own buffering, so this only has
 * to move bytes and report what happened.
 *
 * ## Where the bytes go
 *
 * The native side owns the connections and names them by id; JSON is all that
 * crosses the bridge, so payloads are base64. One set of plugin listeners is
 * installed here and demultiplexed by id, rather than one per socket — the
 * bridge charges for listeners, and a busy device has dozens of sockets.
 *
 * ## Addresses
 *
 * Every outbound connection goes through Tor's SOCKS proxy, and the proxy port
 * is not known until Tor has bootstrapped. `setProxyPort` is how `boot.ts`
 * tells this module, and connecting before that is refused rather than
 * attempted — a socket opened to port 0 fails in a way that reads as the peer
 * being unreachable rather than as Tor not being ready yet.
 */

/** Tor's SOCKS port, once it has one. Zero means Tor is not up. */
let proxyPort = 0;

export function setProxyPort(port: number): void {
  proxyPort = port;
}

export function proxyReady(): boolean {
  return proxyPort > 0;
}

// ---- one set of listeners, demultiplexed by id ------------------------------

const sockets = new Map<string, Socket>();

/**
 * Bytes that arrived for a socket this side had not registered yet.
 *
 * The native side accepts a connection and can deliver its first data event in
 * the same turn, before the `accept` handler here has put the new `Socket` in
 * the map. `sockets.get(id)?.receive(...)` then discards it — silently,
 * because the optional call has nothing to report.
 *
 * What gets discarded is the *first* frame, which in the device link is the
 * greeting. The exchange then continues one message out of step and fails with
 * "expected a device link greeting and got proof" — an error about the second
 * message, describing the loss of the first.
 *
 * Held here instead and handed over when the socket appears. Bounded, because
 * an id that never registers must not accumulate: a peer that vanishes between
 * accept and registration is a leak otherwise.
 */
const early = new Map<string, Buffer[]>();
const EARLY_LIMIT = 64 * 1024;

let wired = false;

function wire(): void {
  if (wired) return;
  wired = true;

  void Native.addListener("connect", ({ id }) => {
    sockets.get(id)?.opened();
  });

  void Native.addListener("data", ({ id, data }) => {
    const bytes = Buffer.from(data, "base64");
    const socket = sockets.get(id);

    if (socket) { socket.receive(bytes); return; }

    // Not registered yet — see `early`. Kept rather than dropped.
    const waiting = early.get(id) ?? [];
    const held = waiting.reduce((total, chunk) => total + chunk.length, 0);

    if (held + bytes.length > EARLY_LIMIT) return;

    waiting.push(bytes);
    early.set(id, waiting);
  });

  void Native.addListener("close", ({ id }) => {
    sockets.get(id)?.closed();
  });

  void Native.addListener("error", ({ id, message }) => {
    sockets.get(id)?.failed(new Error(message));
  });

  // Inbound connections arrive with an id nothing has claimed yet, and the
  // port they landed on says which service they were meant for.
  //
  // There used to be a single `listening` server and this handed every
  // accepted connection to it, on the reasoning that the device hosts one
  // onion service. It hosts two: the account address forwards to the chat
  // transport, and the sync address — the one a pairing code points at —
  // forwards to the pairing service. Binding the second replaced the first, so
  // the sync address forwarded to a port nothing was listening on and this
  // phone could not be linked *to* at all. Only the direction where the phone
  // dialled out ever worked, which is exactly how it was reported.
  void Native.addListener("accept", ({ id, port }) => {
    const server = servers.get(port) ?? only();

    if (!server) return;

    const socket = new Socket(id);
    sockets.set(id, socket);
    server.arrive(socket);
  });
}

/** Every bound server, by the loopback port Tor forwards to. */
const servers = new Map<number, Server>();

/**
 * The one server, when there is exactly one.
 *
 * A fallback for an accept that names no port — an older build of the native
 * plugin, or the browser stub. With a single listener there is no ambiguity to
 * resolve, and refusing the connection would break the common case to be
 * strict about the rare one. With two listeners and no port there is no honest
 * answer, so the connection is dropped rather than guessed at: handing pairing
 * frames to the chat transport produces a corrupt-length error two layers
 * away from the cause.
 */
function only(): Server | undefined {
  return servers.size === 1 ? [...servers.values()][0] : undefined;
}

/**
 * Which port to actually ask for, given the one the caller asked for.
 *
 * Almost always the same one. The exception is the case that made linking look
 * as though it had half worked.
 *
 * Linking calls `location.reload()`, because the page has to come back up as
 * the account it was just given. That restarts the JavaScript and everything
 * in it — including the record of which loopback ports the two services are
 * on. It does *not* restart Tor, which is a library in the same process, and
 * `TorService.start` returns early when it is already running, so Tor cannot
 * be told about new ports either. It goes on forwarding both onion services to
 * the ports from before the reload.
 *
 * So a fresh page that asks for "any port" gets two nothing points at. The
 * phone can still dial out, and is unreachable to every device that tries to
 * dial *it*, until the app is force-quit — which presents as a link that
 * worked, followed by a desktop reporting that none of your devices answered.
 *
 * The listeners themselves survive the reload, so what this does is find them
 * again. Asked fresh each time rather than cached: there are two of these per
 * launch, the call is a bridge round-trip against an array of two numbers, and
 * a cache would need invalidating at exactly the moment this exists to handle.
 */
async function wanted(port: number): Promise<number> {
  // A specific port was asked for. Nothing to work out.
  if (port !== 0) return port;

  let bound: number[];

  try {
    bound = (await Native.listeningPorts()).ports ?? [];
  } catch {
    // An older native build without the method, or the browser stub. Binding
    // something new is the previous behaviour and remains correct on a first
    // launch, which is the only case those two ever see.
    return 0;
  }

  // The first one this context has not already claimed. `boot.ts` opens the
  // pairing listener before the transport on every run, so taking them in the
  // order they were bound puts each service back where Tor is sending it.
  return bound.find((one) => !servers.has(one)) ?? 0;
}

let nextId = 0;
function freshId(): string {
  return `out-${Date.now().toString(36)}-${nextId++}`;
}

// ---- sockets ----------------------------------------------------------------

export class Socket extends EventEmitter {
  readonly id: string;

  #destroyed = false;
  #onConnect?: () => void;

  /**
   * Bytes written before the connection was ready.
   *
   * `connect` resolves when the request has been *made*, not when the peer has
   * answered — a Tor circuit takes seconds — so the transport can reasonably
   * write before then. Node buffers in that window and so does this; dropping
   * those bytes would lose the hello frame, and the connection would sit open
   * with each side waiting for the other to speak.
   */
  #pending: Buffer[] = [];
  #ready = false;

  /**
   * Bytes received before anything was listening for them.
   *
   * `receive` emits a `data` event, and an event emitted with no listener goes
   * nowhere. That window is real and routinely hit: `socksConnect` resolves on
   * the `connect` event, and only *then* does the caller attach its `data`
   * handler — so anything the far end sent immediately on accepting, which for
   * the device link is its greeting, is emitted into an empty room.
   *
   * The exchange then runs one message out of step and fails with "expected a
   * device link greeting and got proof": an error naming the second message,
   * caused by the loss of the first.
   *
   * Node does not have this problem because a socket is paused until it is
   * read from. This is the same idea, done the smallest way that fits: hold
   * what arrives, hand it over the moment somebody subscribes.
   */
  #held: Buffer[] = [];

  /** Set by `end`, so writes after it are refused rather than queued. */
  #ended = false;

  constructor(id?: string) {
    super();
    this.id = id ?? freshId();

    // An adopted inbound socket is already connected.
    if (id) this.#ready = true;

    wire();

    if (!id) return;

    // Anything that arrived before this object existed.
    //
    // Delivered on a later turn, because the caller has not had a chance to
    // subscribe yet — emitting synchronously from a constructor means emitting
    // to nobody, which is the same loss by a different route.
    const waiting = early.get(id);
    if (!waiting || !waiting.length) return;

    early.delete(id);

    queueMicrotask(() => {
      for (const chunk of waiting) this.receive(chunk);
    });
  }

  /** Node returns `this` so calls can be chained; the transport relies on it. */
  setNoDelay(_enable?: boolean): this {
    // Set natively when the connection is created — see `TcpSockets.swift`.
    // Accepted here so the call site is identical on both platforms.
    return this;
  }

  setKeepAlive(_enable?: boolean, _delay?: number): this {
    return this;
  }

  /**
   * `connect(port, host, cb)` — or `connect(port, cb)`, which Node also
   * accepts.
   *
   * The overload is not decoration. See `Server.listen` below for what it
   * costs to leave one out.
   */
  connect(
    port: number,
    host?: string | (() => void),
    onConnect?: () => void,
  ): this {
    const where = typeof host === "function" ? "127.0.0.1" : (host ?? "127.0.0.1");
    this.#onConnect = typeof host === "function" ? host : onConnect;

    sockets.set(this.id, this);

    if (!proxyReady()) {
      // Refused rather than attempted. Without this the failure is a socket
      // error against port 0, which reads as "that peer is unreachable" when
      // the truth is that this device is not on the network yet.
      queueMicrotask(() => {
        this.failed(new Error("Tor is not ready — no SOCKS port yet"));
      });
      return this;
    }

    void Native.connect({ id: this.id, host: where, port, proxyPort }).catch(
      (error: Error) => this.failed(error),
    );

    return this;
  }

  /**
   * `write(data)`, `write(data, cb)`, and `write(data, encoding, cb)`.
   *
   * The transport sends with `socket.write(frame, () => undefined)` and does
   * not act on the callback — which is exactly why accepting it matters. A
   * callback that is silently dropped costs nothing until the day something
   * waits on it, and then it costs a frozen app with no error in it.
   */
  write(
    data: Buffer | Uint8Array | string,
    encoding?: BufferEncoding | ((error?: Error) => void),
    done?: (error?: Error) => void,
  ): boolean {
    const finished = typeof encoding === "function" ? encoding : done;
    const as = typeof encoding === "string" ? encoding : "utf8";

    if (this.#destroyed) {
      finished?.(new Error("socket is closed"));
      return false;
    }

    const bytes = typeof data === "string"
      ? Buffer.from(data, as)
      : Buffer.from(data);

    if (!this.#ready) {
      this.#pending.push(bytes);

      // Called now rather than when the connection opens. Node calls it once
      // the write is handed to the socket, and buffering here is this shim's
      // business, not the caller's.
      queueMicrotask(() => finished?.());
      return true;
    }

    void Native.send({ id: this.id, data: bytes.toString("base64") })
      .then(() => finished?.())
      .catch((error: Error) => finished?.(error));

    return true;
  }

  /**
   * Stop writing, but let what has been written go.
   *
   * The distinction from `destroy` matters and its absence here caused a real
   * failure. Code that gives up on a connection wants to send *why* first, and
   * `destroy` discards anything still buffered — so the explanation is thrown
   * away and the peer sees only a closed socket.
   *
   * There was no `end` on this class at all, so that code crashed instead,
   * inside its own error handler, replacing every pairing failure with
   * "this.#socket.end is not a function" and destroying the message it was
   * trying to deliver.
   *
   * The native side has no half-close, so this is as close as it gets: refuse
   * further writes, and let the flush already in flight complete before the
   * connection goes.
   */
  end(data?: Buffer | string): void {
    if (this.#ended) return;
    this.#ended = true;

    if (data) this.write(data);

    // A moment for the native queue to drain, then release the handle. Unref'd
    // where the runtime supports it so this can never be the reason a process
    // stays alive.
    const done = setTimeout(() => this.destroy(), 250);
    (done as unknown as { unref?: () => void }).unref?.();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;

    sockets.delete(this.id);
    void Native.close({ id: this.id });

    // Node emits `close` for a locally destroyed socket, and the transport
    // relies on it to drop the peer. The native side will also report one; the
    // `#destroyed` guard makes the second a no-op.
    this.emit("close");
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  // ---- called by the demultiplexer ------------------------------------------

  /** @internal */
  opened(): void {
    this.#ready = true;

    for (const chunk of this.#pending) {
      void Native.send({ id: this.id, data: chunk.toString("base64") });
    }
    this.#pending = [];

    this.#onConnect?.();
    this.emit("connect");
  }

  /**
   * Subscribing to `data` collects whatever already arrived.
   *
   * On a later turn rather than inline: a caller that attaches a handler and
   * then sets up state on the next line would otherwise be re-entered before
   * it was ready.
   */
  on(event: string, listener: (...args: unknown[]) => void): this {
    super.on(event, listener);

    if (event === "data" && this.#held.length) {
      const waiting = this.#held;
      this.#held = [];

      queueMicrotask(() => {
        for (const chunk of waiting) this.emit("data", chunk);
      });
    }

    return this;
  }

  /** @internal */
  receive(bytes: Buffer): void {
    if (this.listenerCount("data") === 0) {
      this.#held.push(bytes);
      return;
    }

    this.emit("data", bytes);
  }

  /** @internal */
  closed(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    sockets.delete(this.id);
    early.delete(this.id);
    this.emit("close");
  }

  /** @internal */
  failed(error: Error): void {
    this.emit("error", error);
    this.closed();
  }
}

// ---- listening --------------------------------------------------------------

export class Server extends EventEmitter {
  #port = 0;
  #closed = false;

  constructor(private readonly handler?: (socket: Socket) => void) {
    super();
    wire();
  }

  /**
   * `listen(port, host, cb)` — and `listen(port, cb)`, which is the one that
   * mattered.
   *
   * Node accepts the callback in either position. This did not, and the
   * omission cost a build cycle and an evening: `transport.ts` calls
   *
   *     this.#server.listen(port, () => resolve(this.port!));
   *
   * so the callback arrived where a hostname was expected, `onListening` was
   * undefined, and `onListening?.()` did nothing at all. The optional-call
   * operator turned a wrong argument into silence.
   *
   * Downstream, `transport.listen` never resolved, `netStart` never returned,
   * and `boot()` never settled — so the app sat on "Starting Tor" for ever.
   * Nothing threw and nothing rejected, because from every layer's point of
   * view it was still waiting for a perfectly reasonable thing.
   *
   * The lesson generalises past this one method: a shim for somebody else's
   * interface has to accept everything the callers actually use, and the
   * callers are the shared core, which was written against Node and uses
   * Node's overloads freely. Supporting the tidy signature and quietly
   * dropping the rest is how a shim passes review and hangs on a device.
   */
  listen(
    port: number,
    host?: string | (() => void),
    onListening?: () => void,
  ): this {
    const announce = typeof host === "function" ? host : onListening;

    void wanted(port)
      .then((asked) => Native.listen({ port: asked }))
      .then(({ port: bound }) => {
        // A port of zero is not a port. `transport.listen` resolves with
        // `this.port!` — read straight off `address()` — so a zero here means
        // `address()` returns null, the non-null assertion reads `.port` of
        // null, and the TypeError is thrown inside a `.then` that nobody
        // catches. The promise never settles and startup stops there for good.
        //
        // Reported as an error instead, which the transport already listens
        // for and turns into a rejection.
        if (!bound) {
          this.emit("error", new Error("the system granted no port"));
          return;
        }

        this.#port = bound;

        // Registered under the port that was granted, not the one asked for.
        // `listen(0)` — which both callers use — means "choose one", so the
        // requested port is zero and filing it under that would put every
        // server in the same slot.
        servers.set(bound, this);

        announce?.();
        this.emit("listening");
      })
      .catch((error: Error) => this.emit("error", error));

    return this;
  }

  /**
   * Node returns `{ port }` for a TCP server, or null before it is listening.
   * The transport reads `.port` off it to report which one it got.
   */
  address(): { port: number; address: string; family: string } | null {
    return this.#port
      ? { port: this.#port, address: "127.0.0.1", family: "IPv4" }
      : null;
  }

  close(onClosed?: () => void): this {
    if (this.#closed) return this;
    this.#closed = true;

    const bound = this.#port;
    if (bound) servers.delete(bound);

    // Named, or this closes the other service as well. The pairing listener
    // and the chat transport are both open for the whole life of the app, and
    // either one shutting down used to take both with it.
    void Native.stopListening({ port: bound }).then(() => {
      onClosed?.();
      this.emit("close");
    });

    return this;
  }

  /** @internal */
  arrive(socket: Socket): void {
    this.handler?.(socket);
    this.emit("connection", socket);
  }
}

export function createServer(handler?: (socket: Socket) => void): Server {
  return new Server(handler);
}

export default { Socket, Server, createServer };
