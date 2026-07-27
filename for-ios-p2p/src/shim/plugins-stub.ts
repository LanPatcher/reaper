/**
 * The native plugins, absent.
 *
 * Used only by `scripts/shim.mjs`. The interop test compiles the desktop core
 * against the shims and makes it exchange events with a Node build of itself —
 * so it reaches `net.ts`, which imports the socket plugin, which cannot exist
 * outside a WebView.
 *
 * Nothing in that test opens a socket. What it checks is that ids, signatures,
 * keys and watermarks agree across the two builds, and all of that is decided
 * before a byte would move. So these stand in, and they throw rather than
 * pretending to work — a test that quietly exercised a fake socket would be
 * asserting something about the fake.
 */
const unavailable = (what: string) => () => {
  throw new Error(`${what} is not available outside the app`);
};

export const Socket = {
  connect: unavailable("Socket.connect"),
  send: unavailable("Socket.send"),
  close: unavailable("Socket.close"),
  listen: unavailable("Socket.listen"),
  stopListening: unavailable("Socket.stopListening"),
  addListener: async () => ({ remove: async () => {} }),
};

export const Tor = {
  start: unavailable("Tor.start"),
  stop: unavailable("Tor.stop"),
  status: unavailable("Tor.status"),
  addListener: async () => ({ remove: async () => {} }),
};

export const Keepalive = {
  start: async () => ({ running: false }),
  stop: async () => ({ running: false }),
  status: async () => ({ running: false }),
  addListener: async () => ({ remove: async () => {} }),
};
