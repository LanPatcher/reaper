import { contextBridge, ipcRenderer } from "electron";

/**
 * `window.p2p` — the renderer's view of the local event store.
 *
 * Mirrors the handlers in `src/p2p/bridge.ts`. Everything is async, because
 * every call crosses a process boundary; the UI has to treat these the way it
 * treats network calls today, which is convenient, since that is exactly what
 * they are replacing.
 */

export interface P2PIdentity {
  userId: string;
  publicKey: string;
  encPublicKey?: string;
}

export interface P2PEvent {
  id: string;
  type: string;
  community: string;
  author: string;
  authorKey: string;
  parents: string[];
  clock: number;
  timestamp: number;
  payload: unknown;
  signature: string;
}

contextBridge.exposeInMainWorld("p2p", {
  /** This device's public identity. */
  identity: (): Promise<P2PIdentity> => ipcRenderer.invoke("p2p:identity"),

  /** Load a community's history from disk. */
  open: (community: string): Promise<{ events: number; bytes: number }> =>
    ipcRenderer.invoke("p2p:open", community),

  /** Author a new event. */
  append: (community: string, type: string, payload: unknown): Promise<P2PEvent> =>
    ipcRenderer.invoke("p2p:append", community, type, payload),

  /** Every event, in the order every peer agrees on. Optionally by type. */
  events: (community: string, type?: string): Promise<P2PEvent[]> =>
    ipcRenderer.invoke("p2p:events", community, type),

  /** Current tips of the DAG. */
  heads: (community: string): Promise<string[]> =>
    ipcRenderer.invoke("p2p:heads", community),

  /** Take in events from elsewhere. Unverifiable ones are discarded. */
  merge: (
    community: string,
    events: P2PEvent[],
  ): Promise<{ accepted: number; rejected: number }> =>
    ipcRenderer.invoke("p2p:merge", community, events),

  /** Counts and on-disk size. */
  stats: (
    community: string,
  ): Promise<{ userId: string; events: number; heads: number; bytes: number }> =>
    ipcRenderer.invoke("p2p:stats", community),

  /** Flush and release a community. */
  close: (community: string): Promise<void> =>
    ipcRenderer.invoke("p2p:close", community),

  /** Start listening for peers. Port 0 asks the OS for a free one. */
  netStart: (port?: number): Promise<{ port: number; peers: unknown[] }> =>
    ipcRenderer.invoke("p2p:netStart", port ?? 0),

  /** Dial a peer by onion address. */
  netConnect: (address: string): Promise<unknown[]> =>
    ipcRenderer.invoke("p2p:netConnect", address),

  /** Install a community's payload key (base64, 32 bytes). */
  setKey: (community: string, key: string): Promise<boolean> =>
    ipcRenderer.invoke("p2p:setKey", community, key),

  /** Derive the key for a direct conversation from the peer's public key. */
  dmKey: (community: string, theirEncPublicKey: string): Promise<boolean> =>
    ipcRenderer.invoke("p2p:dmKey", community, theirEncPublicKey),

  /** Mint a new community key, wrapped for each member. */
  wrapKey: (
    community: string,
    members: { userId: string; ek: string }[],
  ): Promise<{ wrapped: Record<string, unknown>; key: string } | null> =>
    ipcRenderer.invoke("p2p:wrapKey", community, members),

  /** Open a rotation addressed to us. Returns the new key, or null. */
  unwrapKey: (
    community: string,
    fromEk: string,
    envelope: unknown,
  ): Promise<string | null> =>
    ipcRenderer.invoke("p2p:unwrapKey", community, fromEk, envelope),

  /** Tell connected peers which communities we now hold. */
  netAnnounce: (): Promise<void> => ipcRenderer.invoke("p2p:netAnnounce"),

  /**
   * A whole server in one compressed file.
   *
   * The log is the server, so this is the events — channels, messages, roles,
   * bans, names, icons — plus the community key and any small attachments.
   * Large files are left out and fetched from peers on demand; the message
   * still shows them with a Download button either way.
   */
  exportCommunity: (
    community: string,
    seeds: string[],
  ): Promise<{ data: string; events: number; files: number; skipped: number; bytes: number }> =>
    ipcRenderer.invoke("p2p:exportCommunity", community, seeds),

  /** Merge a server bundle. Signatures are verified, as for any peer. */
  importCommunity: (
    data: string,
  ): Promise<{
    id: string; key: string; seeds: string[];
    accepted: number; rejected: number; files: number;
  }> => ipcRenderer.invoke("p2p:importCommunity", data),

  /**
   * Which communities are worth actively reconciling.
   *
   * Whatever is open, plus anything still waiting for a first sync. Live
   * writes still reach everything; what stops is the periodic comparison of
   * full id sets, which is what scales badly with server count and history.
   */
  netFocus: (communities: string[]): Promise<void> =>
    ipcRenderer.invoke("p2p:netFocus", communities),

  /** Every community held on disk, including ones already left. */
  communities: (): Promise<string[]> => ipcRenderer.invoke("p2p:communities"),

  /** Communities both this device and a peer belong to. */
  sharedWith: (userId: string): Promise<string[]> =>
    ipcRenderer.invoke("p2p:sharedWith", userId),

  /** Drop superseded events from every stored log. Returns what it reclaimed. */
  compact: (): Promise<{ removed: number; before: number; after: number }> =>
    ipcRenderer.invoke("p2p:compact"),

  /** Close the connection to a peer there is no longer a reason to hold. */
  netDrop: (userId: string): Promise<boolean> =>
    ipcRenderer.invoke("p2p:netDrop", userId),

  /**
   * A peer confirmed it holds these events.
   *
   * The only positive evidence in the protocol that something arrived. Used to
   * retire delivery obligations, which is the difference between "we sent it"
   * and "they have it".
   */
  onDelivered: (
    handler: (to: string, community: string, ids: string[]) => void,
  ): (() => void) => {
    const listener = (
      _: Electron.IpcRendererEvent, to: string, community: string, ids: string[],
    ) => handler(to, community, ids);
    ipcRenderer.on("p2p:delivered", listener);
    return () => ipcRenderer.removeListener("p2p:delivered", listener);
  },

  /** A peer refused a community, with a reason worth acting on. */
  onRefused: (
    handler: (from: string, community: string, reason: string) => void,
  ): (() => void) => {
    const listener = (
      _: Electron.IpcRendererEvent, from: string, community: string, reason: string,
    ) => handler(from, community, reason);
    ipcRenderer.on("p2p:refused", listener);
    return () => ipcRenderer.removeListener("p2p:refused", listener);
  },

  /**
   * Frames and bytes moved, split by wire message type.
   *
   * Sizes are on-the-wire: after compression, including the header — what Tor
   * actually carries, which is often half what the message looks like in
   * memory.
   */
  netStats: (): Promise<{
    out: Record<string, { frames: number; bytes: number }>;
    in: Record<string, { frames: number; bytes: number }>;
    dropped: { frames: number; bytes: number };
    rateOut: number;
    rateIn: number;
    peers: { userId?: string; inbound: boolean; rtt?: number }[];
  }> => ipcRenderer.invoke("p2p:netStats"),

  netStatsReset: (): Promise<void> => ipcRenderer.invoke("p2p:netStatsReset"),

  /**
   * Outbound shaping, and whether a call currently has the floor.
   *
   * `bytesPerSecond` of zero means no limit. Call focus holds back
   * reconciliation and file transfer without dropping any connection, so
   * somebody joining the call mid-way is still noticed.
   */
  netTune: (options: { bytesPerSecond?: number; callFocus?: boolean }): Promise<void> =>
    ipcRenderer.invoke("p2p:netTune", options),

  /**
   * Which Tor is bundled, and whether it is behind the version this build
   * expects. Reports only — nothing is downloaded or replaced automatically.
   */
  torStatus: (): Promise<{
    path: string; version?: string; expected: string; stale: boolean;
  }> => ipcRenderer.invoke("p2p:torStatus"),

  /** Recent transport events — connections, drops, and why. */
  netLog: (): Promise<{ at: number; line: string }[]> =>
    ipcRenderer.invoke("p2p:netLog"),

  /**
   * Everything needed to be this person again, encrypted under a passphrase.
   *
   * There is no server, so there is no account to recover — the private key
   * *is* the account.
   */
  exportIdentity: (passphrase: string): Promise<string> =>
    ipcRenderer.invoke("p2p:exportIdentity", passphrase),

  /** Replace this device's identity. Destructive; confirm first. */
  importIdentity: (bundle: string, passphrase: string): Promise<{ userId: string }> =>
    ipcRenderer.invoke("p2p:importIdentity", bundle, passphrase),

  /** Store attachment bytes locally; the message quotes the id it returns. */
  putBlob: (community: string, base64: string): Promise<{ id: string; size: number }> =>
    ipcRenderer.invoke("p2p:putBlob", community, base64),

  /** Bytes already held, or null. Never touches the network. */
  getBlob: (community: string, id: string): Promise<string | null> =>
    ipcRenderer.invoke("p2p:getBlob", community, id),

  hasBlob: (community: string, id: string): Promise<boolean> =>
    ipcRenderer.invoke("p2p:hasBlob", community, id),

  /**
   * Ask peers for a file. Resolves true if it was already here.
   *
   * Separate from `getBlob` on purpose — reading what is on disk and pulling
   * something over Tor are different acts, and only the second should happen
   * because someone chose it.
   */
  wantBlob: (community: string, id: string): Promise<boolean> =>
    ipcRenderer.invoke("p2p:wantBlob", community, id),

  /**
   * Delete downloaded files over `maxBytes` that this device did not send.
   *
   * Anything attached to a message written here is never touched: there is no
   * server holding a spare copy, so it may be the only one left.
   */
  sweepBlobs: (
    maxBytes: number,
    dryRun?: boolean,
    force?: boolean,
  ): Promise<{
    files: number;
    bytes: number;
    /** Would have gone, but nobody who has them is online to re-supply them. */
    stranded: number;
    strandedBytes: number;
  }> =>
    ipcRenderer.invoke("p2p:sweepBlobs", maxBytes, !!dryRun, !!force),

  /**
   * Drop one downloaded file.
   *
   * Refuses anything sent from this device, always. Refuses anything nobody
   * online holds a copy of, unless `force` — which is what a person pressing
   * delete on a specific file means, having been told.
   */
  forgetBlob: (
    community: string,
    id: string,
    force?: boolean,
  ): Promise<{ dropped: boolean; reason?: string }> =>
    ipcRenderer.invoke("p2p:forgetBlob", community, id, !!force),

  /** Subscribe to files finishing. Returns an unsubscribe function. */
  onBlob: (handler: (community: string, id: string) => void): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, community: string, id: string) =>
      handler(community, id);
    ipcRenderer.on("p2p:blob", listener);
    return () => ipcRenderer.removeListener("p2p:blob", listener);
  },

  /** Send an Opus frame to everyone in a call. */
  netAudio: (channel: string, seq: number, frame: string): Promise<void> =>
    ipcRenderer.invoke("p2p:netAudio", channel, seq, frame),

  /** Subscribe to incoming audio. Returns an unsubscribe function. */
  onAudio: (
    handler: (channel: string, from: string, seq: number, frame: string) => void,
  ): (() => void) => {
    const listener = (
      _: Electron.IpcRendererEvent,
      channel: string,
      from: string,
      seq: number,
      frame: string,
    ) => handler(channel, from, seq, frame);
    ipcRenderer.on("p2p:audio", listener);
    return () => ipcRenderer.removeListener("p2p:audio", listener);
  },

  /** This device's onion address and Tor status. */
  netInfo: (): Promise<{
    onion?: string;
    torRunning: boolean;
    peers: { userId?: string; address: string; inbound: boolean }[];
  }> => ipcRenderer.invoke("p2p:netInfo"),

  /** Send voice signalling to a peer. False if they are not connected. */
  netSignal: (to: string, data: unknown): Promise<boolean> =>
    ipcRenderer.invoke("p2p:netSignal", to, data),

  /** Subscribe to voice signalling. Returns an unsubscribe function. */
  onSignal: (handler: (from: string, data: unknown) => void): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, from: string, data: unknown) =>
      handler(from, data);
    ipcRenderer.on("p2p:signal", listener);
    return () => ipcRenderer.removeListener("p2p:signal", listener);
  },

  /** Currently connected peers. */
  netPeers: (): Promise<unknown[]> => ipcRenderer.invoke("p2p:netPeers"),

  /** Subscribe to peer list changes. Returns an unsubscribe function. */
  onPeers: (handler: (peers: unknown[]) => void): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, peers: unknown[]) =>
      handler(peers);
    ipcRenderer.on("p2p:peers", listener);
    return () => ipcRenderer.removeListener("p2p:peers", listener);
  },

  /**
   * Subscribe to new events.
   *
   * Fires for locally-authored events as well as ones arriving from peers, so
   * the UI needs no separate path for "my message" versus "their message" —
   * both are just events landing in the log.
   *
   * Returns an unsubscribe function.
   */
  onEvent: (
    handler: (community: string, events: P2PEvent[]) => void,
  ): (() => void) => {
    const listener = (
      _: Electron.IpcRendererEvent,
      community: string,
      events: P2PEvent[],
    ) => handler(community, events);

    ipcRenderer.on("p2p:event", listener);
    return () => ipcRenderer.removeListener("p2p:event", listener);
  },

  // ---- your own devices ------------------------------------------------
  //
  // An identity has exactly one onion address, so exactly one device can
  // answer at it. These are how the interface finds out which one that is,
  // takes it over, and copies the account across first.

  /** Who this device is, and whether it currently holds the address. */
  deviceInfo: (): Promise<DeviceInfo> => ipcRenderer.invoke("p2p:deviceInfo"),

  /** Rename this device. Shown to you, on your other devices. */
  deviceName: (name: string): Promise<DeviceInfo> =>
    ipcRenderer.invoke("p2p:deviceName", name),

  /** Answer here from now on. This is the Reconnect button. */
  deviceTakeOver: (): Promise<DeviceInfo> => ipcRenderer.invoke("p2p:deviceTakeOver"),

  /** Start listening for, and announcing to, your other devices. */
  linkOpen: (): Promise<{ port: number }> => ipcRenderer.invoke("p2p:linkOpen"),

  /** Stop. Nothing is announced on the network once this returns. */
  linkClose: (): Promise<boolean> => ipcRenderer.invoke("p2p:linkClose"),

  /** Devices of yours heard from in the last few seconds. */
  linkPeers: (): Promise<LinkPeer[]> => ipcRenderer.invoke("p2p:linkPeers"),

  /** Copy the whole account to or from the device at this address. */
  linkTo: (host: string, port: number): Promise<LinkProgress> =>
    ipcRenderer.invoke("p2p:linkTo", host, port),

  /**
   * Anything that changes about your devices.
   *
   * One subscription rather than three: losing the address, a device
   * appearing on the network and a sync finishing are all reacted to in the
   * same place, and separate channels would be three things to keep in step.
   */
  onDevices: (handler: (info: DeviceInfo) => void): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, info: DeviceInfo) => handler(info);
    ipcRenderer.on("p2p:devices", listener);
    return () => ipcRenderer.removeListener("p2p:devices", listener);
  },
});

interface Claim {
  device: string;
  name: string;
  n: number;
  at: number;
}

interface DeviceInfo {
  device: string;
  name: string;
  standing:
    | { state: "holding"; claim?: Claim }
    | { state: "displaced"; by: Claim }
    | { state: "unclaimed" };
  claims: Claim[];
  linking: boolean;
  linkPort: number;
  onion?: string;

  /** Present only on the event that reports one. */
  synced?: LinkProgress;
  failed?: string;
}

interface LinkPeer {
  host: string;
  port: number;
  name: string;
  device: string;
  at: number;
}

interface LinkProgress {
  device: string;
  name: string;
  events: number;
  files: number;
  communities: number;
  done: boolean;
}
