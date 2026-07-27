import { registerPlugin } from "@capacitor/core";

/**
 * Raw TCP, which a WebView does not otherwise have.
 *
 * Sockets are named by id rather than returned as objects: nothing but JSON
 * crosses the bridge, so the native side keeps the connections and this side
 * keeps the names. Payloads are base64 for the same reason — the bridge has no
 * representation for bytes, and a JSON array of numbers would be about four
 * times the size of the frame it carries.
 *
 * Connecting resolves as soon as the attempt has been made. The result arrives
 * as an event, because a connection through Tor can take twenty seconds and a
 * promise held open that long is indistinguishable from a hang.
 */

export interface SocketEvent {
  id: string;
}

export interface SocketData extends SocketEvent {
  /** Base64. May be any fraction of a frame, or several — it is a stream. */
  data: string;
}

export interface SocketError extends SocketEvent {
  message: string;
}

export interface SocketPlugin {
  /**
   * Open a connection to an onion address through the local SOCKS5 proxy.
   *
   * The host is never resolved on this device: it is handed to Tor as a name,
   * which is both the only way an onion address can work and what keeps the
   * destination out of the system resolver.
   */
  connect(options: {
    id: string;
    host: string;
    port: number;
    proxyPort?: number;
  }): Promise<void>;

  send(options: { id: string; data: string }): Promise<void>;
  close(options: { id: string }): Promise<void>;

  /** Accept connections on loopback, which is where Tor forwards them. */
  listen(options: { port?: number }): Promise<{ port: number }>;
  stopListening(): Promise<void>;

  addListener(event: "connect", handler: (e: SocketEvent) => void): Promise<Handle>;
  addListener(event: "accept", handler: (e: SocketEvent) => void): Promise<Handle>;
  addListener(event: "data", handler: (e: SocketData) => void): Promise<Handle>;
  addListener(event: "close", handler: (e: SocketEvent) => void): Promise<Handle>;
  addListener(event: "error", handler: (e: SocketError) => void): Promise<Handle>;
}

export interface Handle {
  remove(): Promise<void>;
}

export const Socket = registerPlugin<SocketPlugin>("Socket", {
  // Deliberately not a working implementation. A browser cannot open a TCP
  // socket, and pretending otherwise — proxying through a WebSocket, say —
  // would make the dev server behave in a way the device never will.
  web: () => ({
    connect: async () => {
      throw new Error("TCP is not available in a browser");
    },
    send: async () => {},
    close: async () => {},
    listen: async () => ({ port: 0 }),
    stopListening: async () => {},
    addListener: async () => ({ remove: async () => {} }),
  }),
});
