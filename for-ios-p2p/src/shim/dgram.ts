import { EventEmitter } from "./events";

/**
 * `node:dgram`, which a WebView does not have.
 *
 * `link.ts` uses UDP broadcast to find your other devices on the same network.
 * There is no UDP of any kind available to a Capacitor app without a native
 * plugin for it, and this build does not have one — the socket plugin speaks
 * TCP only.
 *
 * So this is not a working implementation and does not pretend to be one. It
 * binds nothing, sends nothing, and reports that on the `error` channel the
 * caller already listens to. The consequence on a phone is precise and small:
 * this device will not *discover* your other devices by broadcast. Everything
 * else about linking still works — it can be dialled by a device that found
 * it, it can be given an address by hand, and it reaches its own devices over
 * Tor exactly as it reaches anyone else.
 *
 * The alternative — a silent no-op — would leave the linking screen searching
 * forever with nothing to explain why, which is the failure this codebase has
 * spent the most time paying for.
 */

export class Socket extends EventEmitter {
  bind(_port?: number, ready?: () => void): this {
    // Reported asynchronously, because a caller that subscribes on the next
    // line would otherwise miss it.
    queueMicrotask(() => {
      this.emit(
        "error",
        new Error(
          "this device cannot search the local network — link it from your " +
            "other device, or connect over Tor",
        ),
      );
      ready?.();
    });

    return this;
  }

  setBroadcast(_on: boolean): void {
    throw new Error("no UDP on this platform");
  }

  send(
    _data: unknown,
    _offset?: number,
    _length?: number,
    _port?: number,
    _host?: string,
    done?: (error?: Error) => void,
  ): void {
    done?.(new Error("no UDP on this platform"));
  }

  close(): void {}
}

export function createSocket(_options?: unknown): Socket {
  return new Socket();
}

export default { createSocket, Socket };
