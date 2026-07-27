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
let wired = false;

function wire(): void {
  if (wired) return;
  wired = true;

  void Native.addListener("connect", ({ id }) => {
    sockets.get(id)?.opened();
  });

  void Native.addListener("data", ({ id, data }) => {
    sockets.get(id)?.receive(Buffer.from(data, "base64"));
  });

  void Native.addListener("close", ({ id }) => {
    sockets.get(id)?.closed();
  });

  void Native.addListener("error", ({ id, message }) => {
    sockets.get(id)?.failed(new Error(message));
  });

  // Inbound connections arrive with an id nothing has claimed yet. They are
  // handed to whichever server is listening — there is only ever one, since
  // this device hosts exactly one onion service.
  void Native.addListener("accept", ({ id }) => {
    if (!listening) return;

    const socket = new Socket(id);
    sockets.set(id, socket);
    listening.arrive(socket);
  });
}

let listening: Server | undefined;

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

  constructor(id?: string) {
    super();
    this.id = id ?? freshId();

    // An adopted inbound socket is already connected.
    if (id) this.#ready = true;

    wire();
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

  connect(port: number, host: string, onConnect?: () => void): this {
    this.#onConnect = onConnect;
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

    void Native.connect({ id: this.id, host, port, proxyPort }).catch(
      (error: Error) => this.failed(error),
    );

    return this;
  }

  write(data: Buffer | Uint8Array | string): boolean {
    if (this.#destroyed) return false;

    const bytes = typeof data === "string"
      ? Buffer.from(data, "utf8")
      : Buffer.from(data);

    if (!this.#ready) {
      this.#pending.push(bytes);
      return true;
    }

    void Native.send({ id: this.id, data: bytes.toString("base64") });
    return true;
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

  /** @internal */
  receive(bytes: Buffer): void {
    this.emit("data", bytes);
  }

  /** @internal */
  closed(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    sockets.delete(this.id);
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

  listen(port: number, _host?: string, onListening?: () => void): this {
    listening = this;

    void Native.listen({ port })
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
        onListening?.();
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

    if (listening === this) listening = undefined;

    void Native.stopListening().then(() => {
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
