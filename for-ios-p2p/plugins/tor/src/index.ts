import { registerPlugin } from "@capacitor/core";

/**
 * An embedded Tor client.
 *
 * Two things come out of it, and the second is the one that makes a
 * peer-to-peer app possible on a phone at all:
 *
 *   - A **SOCKS port** on loopback, which `@reaper/socket` dials through. This
 *     is how the device reaches other people.
 *   - An **onion address**, published by Tor, which is how other people reach
 *     the device. A phone has no routable address and no port anybody can open;
 *     the onion service is what gives it one.
 *
 * Nothing here is fast. Bootstrapping a circuit takes seconds on a good
 * network and minutes on a bad one, and publishing a service descriptor takes
 * longer again — so `start` resolves as soon as Tor is launched and everything
 * after that arrives as events.
 */

export type TorState =
  /** Launched, no circuit yet. */
  | "starting"
  /** Building a circuit. `percent` says how far. */
  | "bootstrapping"
  /** A circuit exists, so outbound connections work. `socksPort` is set. */
  | "ready"
  /** The onion service is published. `onion` is set, and peers can reach us. */
  | "published"
  | "stopped"
  | "failed";

export interface TorEvent {
  state: TorState;
  percent?: number;
  summary?: string;
  socksPort?: number;
  onion?: string;
  error?: string;
}

export interface TorStatus {
  running: boolean;
  /** Whether a circuit exists. Outbound works from here; inbound may not yet. */
  bootstrapped: boolean;
  /** Loopback port to dial through. Zero until `ready`. */
  socksPort: number;
  /**
   * This device's address, once the descriptor is published.
   *
   * Null while Tor is still working, which is a different thing from being
   * unreachable — worth distinguishing in the interface, because the first
   * resolves itself and the second does not.
   */
  onion: string | null;
  error?: string | null;
}

export interface TorPlugin {
  /**
   * Start Tor, and publish an onion service forwarding to `localPort`.
   *
   * `localPort` is where `@reaper/socket` is listening. Tor builds circuits
   * back to it, so a peer connecting to the onion address ends up on that
   * socket — which is the whole arrangement.
   */
  start(options: { localPort: number }): Promise<{ running: boolean }>;

  stop(): Promise<{ running: boolean }>;
  status(): Promise<TorStatus>;

  addListener(
    event: "tor",
    handler: (e: TorEvent) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

export const Tor = registerPlugin<TorPlugin>("Tor", {
  // Deliberately not a working implementation, and not a silent one either.
  // A browser cannot run Tor, so a dev server that pretended otherwise would
  // behave in a way the device never will.
  web: () => ({
    start: async () => {
      throw new Error("Tor is not available in a browser");
    },
    stop: async () => ({ running: false }),
    status: async () => ({
      running: false,
      bootstrapped: false,
      socksPort: 0,
      onion: null,
      error: "not iOS",
    }),
    addListener: async () => ({ remove: async () => {} }),
  }),
});
