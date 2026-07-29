import { Buffer } from "buffer";

import { EventEmitter } from "../../../for-ios-p2p/src/shim/events";

/**
 * `node:net`, over a WebSocket to the relay.
 *
 * The same job the iOS shim does, against a different impossibility. There the
 * problem was that a WebView has no raw sockets and a native plugin supplied
 * them; here there is no plugin and no way to get one, because a browser
 * cannot open a TCP connection by any route a page can take. So every
 * connection is tunnelled to a machine that can — see `server/relay.mjs`, and
 * read the note at the top of it before deciding this build is for you.
 *
 * ## Reachable, and who holds the key
 *
 * A session is dialable: it publishes onion services of its own, so peers can
 * reach it rather than only being reached. That is what makes it a device
 * rather than a viewer — it can have a friend code, and it can be the one
 * *showing* a pairing code.
 *
 * The keys belong to the browser. They are kept here, in this session's own
 * storage, and handed to the relay when it registers them with Tor for as long
 * as the tab is open. The relay never writes one down: when a session has no
 * key yet, Tor makes one and it comes straight back here to be stored.
 *
 * That is the whole of the security argument for this arrangement, and it is
 * worth being exact about. An onion key *is* an identity. A relay that kept
 * them could be any of its visitors at any time, including when they are not
 * there. This one can only be a visitor while that visitor is connected and
 * has just handed it the key — a much smaller thing, and the smallest this
 * feature can be built out of.
 *
 * ## One socket, many connections
 *
 * Every connection shares one WebSocket, tagged by id. Browsers limit
 * concurrent connections per origin, and an account with a few devices and a
 * few peers passes that limit quickly — at which point new connections do not
 * fail, they *queue*, invisibly, and the app looks like it has hung.
 */

/** Where the relay is. Same origin as the page, so there is one name to trust. */
function relayUrl(): string {
  const secure = location.protocol === "https:";
  return `${secure ? "wss" : "ws"}://${location.host}/relay`;
}

/** How long to wait for the relay before giving up on a connection. */
const OPEN_TIMEOUT_MS = 45_000;

/** How long to wait before dialling the relay again after it drops. */
const RETRY_MS = 2_000;

type Control =
  | { t: "open"; id: string }
  | { t: "close"; id: string }
  | { t: "error"; id: string; message: string }
  | { t: "accept"; id: string; listener: string }
  | { t: "listening"; id: string; onion: string; key?: string }
  | { t: "unlistened"; id: string; message: string };

const sockets = new Map<string, Socket>();

/** Servers by the loopback port they were granted. */
const servers = new Map<number, Server>();

/** Servers by the name their onion service was published under. */
const listeners = new Map<string, Server>();

/** Publish requests waiting on the relay. */
const publishing = new Map<string, {
  resolve: (result: { onion: string; key?: string }) => void;
  reject: (error: Error) => void;
}>();

let link: WebSocket | undefined;
let opening: Promise<WebSocket> | undefined;

/**
 * Frame a payload for the relay: four bytes of id length, the id, the bytes.
 *
 * Binary rather than JSON with base64, which would add a third to every frame
 * on the one link carrying everything.
 */
function frame(id: string, payload: Uint8Array): ArrayBuffer {
  const name = new TextEncoder().encode(id);
  const out = new Uint8Array(4 + name.length + payload.length);
  new DataView(out.buffer).setUint32(0, name.length);
  out.set(name, 4);
  out.set(payload, 4 + name.length);
  return out.buffer;
}

function unframe(data: ArrayBuffer): { id: string; payload: Buffer } | undefined {
  if (data.byteLength < 4) return undefined;

  const view = new DataView(data);
  const length = view.getUint32(0);
  if (length > 512 || data.byteLength < 4 + length) return undefined;

  return {
    id: new TextDecoder().decode(new Uint8Array(data, 4, length)),
    payload: Buffer.from(new Uint8Array(data, 4 + length)),
  };
}

/**
 * The one connection to the relay, opened on demand and kept.
 *
 * Re-entrant: several sockets connecting at once must not each open their own
 * link, so the promise is shared while it is in flight.
 */
function connectRelay(): Promise<WebSocket> {
  if (link && link.readyState === WebSocket.OPEN) return Promise.resolve(link);
  if (opening) return opening;

  opening = new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(relayUrl());
    ws.binaryType = "arraybuffer";

    const settle = setTimeout(() => {
      ws.close();
      reject(new Error("the relay did not answer"));
    }, OPEN_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(settle);
      link = ws;
      opening = undefined;
      resolve(ws);
    };

    ws.onerror = () => {
      clearTimeout(settle);
      opening = undefined;
      reject(new Error("could not reach the relay"));
    };

    ws.onclose = () => {
      link = undefined;
      opening = undefined;

      // Everything it was carrying is gone with it. Told individually rather
      // than left to time out, because a socket waiting on a link that no
      // longer exists is the shape of hang this whole file exists to avoid.
      for (const socket of [...sockets.values()]) {
        socket.failed(new Error("the connection to the relay dropped"));
      }
      sockets.clear();
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const parsed = unframe(event.data);
        if (parsed) sockets.get(parsed.id)?.receive(parsed.payload);
        return;
      }

      let message: Control;
      try {
        message = JSON.parse(String(event.data)) as Control;
      } catch {
        return;
      }

      if (message.t === "listening") {
        publishing.get(message.id)?.resolve({ onion: message.onion, key: message.key });
        publishing.delete(message.id);
        return;
      }

      if (message.t === "unlistened") {
        publishing.get(message.id)?.reject(new Error(message.message));
        publishing.delete(message.id);
        return;
      }

      // Somebody dialled this session's address. The listener name says which
      // of its two services they reached — the pairing one or the transport —
      // and they speak different protocols, so a connection handed to the
      // wrong one is not misdelivered, it is destroyed.
      if (message.t === "accept") {
        const server = listeners.get(message.listener);
        if (!server) return;

        const socket = new Socket(message.id);
        sockets.set(message.id, socket);
        server.arrive(socket);
        return;
      }

      const socket = sockets.get(message.id);
      if (!socket) return;

      if (message.t === "open") socket.opened();
      else if (message.t === "close") socket.closed();
      else socket.failed(new Error(message.message || "the relay refused"));
    };
  });

  return opening;
}

let nextId = 0;

export class Socket extends EventEmitter {
  readonly id: string;

  #destroyed = false;
  #ready = false;
  #ended = false;
  #onConnect?: () => void;

  /**
   * Bytes written before the relay confirmed the connection.
   *
   * The core writes its greeting the instant a socket resolves, and over a
   * relay *and* a Tor circuit there is real time between asking and being
   * connected. Node buffers in that window; dropping those bytes would lose
   * the first frame of every conversation.
   */
  #pending: Buffer[] = [];

  /**
   * Bytes that arrived before anything was listening for them.
   *
   * Same hazard as the iOS shim, and the same fix. A caller resolves on
   * `connect` and attaches its `data` handler on the next line, so whatever
   * the far end sent immediately on accepting lands in between — which for the
   * pairing protocol is the greeting.
   */
  #held: Buffer[] = [];

  constructor(id?: string) {
    super();

    // An adopted inbound socket keeps the name the relay gave it and is
    // already connected; an outbound one names itself.
    this.id = id ?? `w-${Date.now().toString(36)}-${nextId++}`;
    if (id) this.#ready = true;
  }

  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }

  connect(port: number, host?: string | (() => void), onConnect?: () => void): this {
    const where = typeof host === "function" ? "" : (host ?? "");
    this.#onConnect = typeof host === "function" ? host : onConnect;

    sockets.set(this.id, this);

    void connectRelay().then(
      (ws) => {
        if (this.#destroyed) return;
        ws.send(JSON.stringify({ t: "open", id: this.id, host: where, port }));
      },
      (error: Error) => this.failed(error),
    );

    return this;
  }

  write(
    data: Buffer | Uint8Array | string,
    encoding?: BufferEncoding | ((error?: Error) => void),
    done?: (error?: Error) => void,
  ): boolean {
    const finished = typeof encoding === "function" ? encoding : done;
    const as = typeof encoding === "string" ? encoding : "utf8";

    if (this.#destroyed || this.#ended) {
      finished?.(new Error("socket is closed"));
      return false;
    }

    const bytes = typeof data === "string" ? Buffer.from(data, as) : Buffer.from(data);

    if (!this.#ready) {
      this.#pending.push(bytes);
      queueMicrotask(() => finished?.());
      return true;
    }

    this.#send(bytes);
    queueMicrotask(() => finished?.());
    return true;
  }

  #send(bytes: Buffer): void {
    if (!link || link.readyState !== WebSocket.OPEN) return;
    link.send(frame(this.id, bytes));
  }

  /**
   * Stop writing, but let what has been written go.
   *
   * There is no half-close through a relay, so this is as close as it gets:
   * refuse further writes, and give the queue a moment before releasing the
   * connection. `pair.ts` writes its refusal and then calls this, so the
   * moment is what carries the explanation.
   */
  end(data?: Buffer | string): void {
    if (this.#ended) return;
    if (data) this.write(data);
    this.#ended = true;

    setTimeout(() => this.destroy(), 250);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;

    sockets.delete(this.id);

    if (link && link.readyState === WebSocket.OPEN) {
      link.send(JSON.stringify({ t: "close", id: this.id }));
    }

    this.emit("close");
  }

  get destroyed(): boolean { return this.#destroyed; }

  // Signature matched to the shim's own `EventEmitter` rather than widened.
  // The base declares `(...args: never[]) => void`, which is what makes an
  // override with a wider parameter type an error — and this method exists
  // only to hand over held bytes, not to change the contract.
  on(event: string, listener: (...args: never[]) => void): this {
    super.on(event, listener);

    if (event === "data" && this.#held.length) {
      const waiting = this.#held;
      this.#held = [];
      queueMicrotask(() => { for (const chunk of waiting) this.emit("data", chunk); });
    }

    return this;
  }

  /** @internal */
  opened(): void {
    this.#ready = true;

    for (const chunk of this.#pending) this.#send(chunk);
    this.#pending = [];

    this.#onConnect?.();
    this.emit("connect");
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
    this.emit("close");
  }

  /** @internal */
  failed(error: Error): void {
    this.emit("error", error);
    this.closed();
  }
}

/**
 * Ports handed out to listeners.
 *
 * Loopback numbers, never bound to anything — a browser cannot bind a port,
 * and nothing here needs it to. They exist because the code above identifies a
 * listener by the port it was granted, and because Tor forwards this session's
 * services to the relay rather than to anything in this page.
 */
let nextPort = 49_000;

/**
 * A server, which is real in the only sense that matters.
 *
 * It cannot bind anything — no page can. What it can do is be the place
 * connections arrive when somebody dials this session's onion address: Tor
 * hands them to the relay, the relay tunnels them here tagged with which
 * service they reached, and this is what they are handed to.
 */
export class Server extends EventEmitter {
  #port = 0;
  #closed = false;

  constructor(private readonly handler?: (socket: Socket) => void) {
    super();
  }

  listen(_port: number, host?: string | (() => void), onListening?: () => void): this {
    const announce = typeof host === "function" ? host : onListening;

    this.#port = nextPort++;
    servers.set(this.#port, this);

    // On a later turn, matching Node: a caller that calls `listen` and then
    // attaches handlers on the following lines must not be re-entered before
    // it has finished setting itself up.
    setTimeout(() => {
      announce?.();
      this.emit("listening");
    }, 0);

    return this;
  }

  address(): { port: number; address: string; family: string } | null {
    return this.#port
      ? { port: this.#port, address: "127.0.0.1", family: "IPv4" }
      : null;
  }

  close(onClosed?: () => void): this {
    if (this.#closed) return this;
    this.#closed = true;

    servers.delete(this.#port);
    for (const [name, server] of listeners) {
      if (server === this) listeners.delete(name);
    }

    this.#port = 0;

    setTimeout(() => {
      onClosed?.();
      this.emit("close");
    }, 0);

    return this;
  }

  /** @internal — an inbound connection from the relay. */
  arrive(socket: Socket): void {
    this.handler?.(socket);
    this.emit("connection", socket);
  }
}

/**
 * Publish an onion service for the server on a given port.
 *
 * `name` distinguishes this session's two services — the pairing one and the
 * transport — and comes back on every inbound connection so it can be routed
 * to the right one. `key` is the one this session already has, if any; when it
 * is absent Tor makes one and it is returned to be stored.
 */
export async function publish(
  name: string,
  port: number,
  key?: string,
): Promise<{ onion: string; key?: string }> {
  const server = servers.get(port);
  if (!server) throw new Error(`nothing is listening on ${port}`);

  const ws = await connectRelay();
  listeners.set(name, server);

  return new Promise((resolve, reject) => {
    publishing.set(name, { resolve, reject });

    // Not indefinite. Tor can take a while to accept a service and the relay
    // may have no control port at all, and a promise nobody settles is the
    // shape of hang that stops a whole startup.
    setTimeout(() => {
      if (!publishing.has(name)) return;
      publishing.delete(name);
      reject(new Error("the relay did not publish an address"));
    }, 60_000);

    ws.send(JSON.stringify({ t: "listen", id: name, key }));
  });
}

/** Stop publishing one of this session's services. */
export function unpublish(name: string): void {
  listeners.delete(name);
  if (link && link.readyState === WebSocket.OPEN) {
    link.send(JSON.stringify({ t: "unlisten", id: name }));
  }
}

export function createServer(handler?: (socket: Socket) => void): Server {
  return new Server(handler);
}

/**
 * Whether the relay is reachable, for the interface to report.
 *
 * Deliberately not "is Tor ready" — that question belongs to the relay and a
 * browser session has no way to observe it. What a page can say is whether it
 * has a link to the machine that would know.
 */
export function relayReady(): boolean {
  return !!link && link.readyState === WebSocket.OPEN;
}

/** Bring the link up early, so the first dial is not also the first handshake. */
export function warmRelay(): void {
  void connectRelay().catch(() => {
    setTimeout(warmRelay, RETRY_MS);
  });
}

export default { Socket, Server, createServer };
