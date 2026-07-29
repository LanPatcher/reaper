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

  /**
   * Answering, and answering *asynchronously*, because the real one does.
   *
   * This threw, and the throw was synchronous — `unavailable` returns a plain
   * function, not an async one. `shim/tor.ts` calls it as
   * `void Tor.status().then(...)`, so the exception escaped before `.then`
   * existed, propagated out of the watcher, out of `TorService.start`, and was
   * caught by `publishIfHolding` as a failure to publish.
   *
   * The startup test therefore never reached the code after that call, and
   * `startNetwork` passed while the real app sat on "Starting Tor" for two and
   * a half minutes — the exact freeze this suite exists to catch, hidden by a
   * stub that failed earlier and differently from the thing it stands in for.
   *
   * A stub that is unavailable should report being unavailable the way the
   * real plugin would: a resolved status saying nothing is running.
   */
  status: async () => ({
    running: false,
    bootstrapped: false,
    socksPort: 0,
    onion: null,
    syncOnion: null,
    error: "not iOS",
  }),

  // Answering rather than throwing, because the interop test compiles the
  // desktop `bridge.ts`, and its identity export asks for the service key on
  // every call. A throw here would fail an export for want of an address,
  // which is precisely the outcome that code is written to avoid.
  exportKey: async () => ({ secret: "", public: "", hostname: "" }),
  importKey: unavailable("Tor.importKey"),

  addListener: async () => ({ remove: async () => {} }),
};

export const Scanner = {
  scan: unavailable("Scanner.scan"),
};

/**
 * Notifications, absent but answering.
 *
 * Reports no permission rather than throwing, for the same reason `Tor.status`
 * does: the code that calls it is a background path reacting to a message
 * arriving, and a throw there would fail the *message handling* rather than
 * the notification — turning a missing banner into a lost event.
 */
export const Notify = {
  request: async () => ({ granted: false, asked: true }),
  permission: async () => ({ granted: false, asked: true }),
  show: async () => {},
  clear: async () => {},
  badge: async () => {},
  addListener: async () => ({ remove: async () => {} }),
};

export const Keepalive = {
  start: async () => ({ running: false }),
  stop: async () => ({ running: false }),
  status: async () => ({ running: false }),
  addListener: async () => ({ remove: async () => {} }),
};
