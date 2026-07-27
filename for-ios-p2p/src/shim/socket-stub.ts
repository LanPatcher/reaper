/**
 * The native socket plugin, faked and scriptable.
 *
 * Used by `net.test.ts`. The plugin itself is Swift behind a WebView bridge and
 * cannot exist in Node, but almost nothing interesting about `net.ts` is in the
 * Swift — the interesting part is whether the JavaScript above it honours the
 * shape `node:net` promises, which the shared core calls freely.
 *
 * So this records what was asked of it and lets the test push events back, and
 * the shim is exercised for real rather than described.
 */

export interface Call {
  name: string;
  args: Record<string, unknown>;
}

/** Everything the shim asked the native side to do, in order. */
export const calls: Call[] = [];

type Handler = (event: Record<string, unknown>) => void;
const handlers = new Map<string, Handler>();

/** What the next `listen` should report. Zero means "no port", as a failure. */
let grant: number | undefined;

export function grantPort(port: number | undefined): void {
  grant = port;
}

/**
 * Clear what was recorded, and deliberately *not* the handlers.
 *
 * `net.ts` installs its listeners once behind a module-level flag, exactly as
 * it does on a device — so a reset that dropped them would leave every socket
 * created afterwards deaf, with no way to get them back. The first version of
 * this did drop them, and the symptom was a test hanging on a connection that
 * had been made successfully: the same shape of failure the suite exists to
 * catch, produced by the suite itself.
 */
export function reset(): void {
  calls.length = 0;
  grant = undefined;
}

/** Push an event up, the way the plugin bridge would. */
export function fire(event: string, payload: Record<string, unknown>): void {
  handlers.get(event)?.(payload);
}

export const Socket = {
  async connect(args: Record<string, unknown>) {
    calls.push({ name: "connect", args });

    // Answered on a later turn, like a bridge call — a `connect` that reported
    // success synchronously would hide ordering bugs the device would show.
    queueMicrotask(() => fire("connect", { id: args.id }));
    return {};
  },

  async send(args: Record<string, unknown>) {
    calls.push({ name: "send", args });
    return {};
  },

  async close(args: Record<string, unknown>) {
    calls.push({ name: "close", args });
    return {};
  },

  async listen(args: Record<string, unknown>) {
    calls.push({ name: "listen", args });

    const asked = Number(args.port ?? 0);
    return { port: grant ?? (asked || 51820) };
  },

  async stopListening() {
    calls.push({ name: "stopListening", args: {} });
    return {};
  },

  async addListener(event: string, handler: Handler) {
    handlers.set(event, handler);
    return { remove: async () => { handlers.delete(event); } };
  },
};
