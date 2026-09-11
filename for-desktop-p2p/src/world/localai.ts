import { contextBridge, ipcRenderer } from "electron";

/**
 * `window.localai` — the renderer's view of the on-device AI friends.
 *
 * Mirrors the handlers in `src/local-ai/bridge.ts`, the same way `world/p2p.ts`
 * mirrors the P2P bridge. Everything is async because it crosses into the main
 * process, where the model actually lives; the UI treats these like the network
 * calls they are replacing for these conversations — except nothing here ever
 * reaches a network.
 *
 * On any platform where the feature is not registered (everything but Windows,
 * for now), the `invoke`s reject; `available()` is the cheap check the UI uses
 * to hide itself entirely rather than catching failures one by one.
 */

export interface AIFriendUI {
  id: string;
  name: string;
  characterSheet: string;
  greeting?: string;
  /** Set on characters the app ships. "assistant" is the built-in helper. */
  builtin?: "assistant";
  pfp?: string;
  pfpUrl?: string;
  createdAt: number;
  settings: {
    imageGen: boolean;
    tts: boolean;
    imageStyle: string;
    temperature: number;
    ttsVoice?: string;
    maxTokens?: number;
    contextTokens?: number;
    autoCompact?: boolean;
    keepRecentMessages?: number;
    appearance?: string;
    sceneSource?: "auto" | "actions" | "reply";
    imageSteps?: number;
    imageWidth?: number;
    imageHeight?: number;
    imageNegative?: string;
    web?: boolean;
    folder?: string;
  };
}

export interface AIMessageUI {
  id: string;
  role: "user" | "assistant";
  content: string;
  scene?: string;
  sceneUrl?: string;
  ts: number;
}

contextBridge.exposeInMainWorld("localai", {
  /** False on platforms where the feature is not built. */
  available: async (): Promise<boolean> => {
    try {
      return await ipcRenderer.invoke("localai:available");
    } catch {
      return false;
    }
  },

  /** Whether the bundled model and image assets are actually present. */
  status: (): Promise<{ modelPresent: boolean; imageReady: boolean }> =>
    ipcRenderer.invoke("localai:status"),

  list: (): Promise<AIFriendUI[]> => ipcRenderer.invoke("localai:list"),

  create: (input: {
    name: string;
    characterSheet: string;
    greeting?: string;
    pfp?: string;
    settings?: Partial<AIFriendUI["settings"]>;
  }): Promise<AIFriendUI> => ipcRenderer.invoke("localai:create", input),

  update: (
    id: string,
    patch: {
      name?: string;
      characterSheet?: string;
      greeting?: string;
      settings?: Partial<AIFriendUI["settings"]>;
    },
  ): Promise<AIFriendUI> => ipcRenderer.invoke("localai:update", id, patch),

  setPfp: (id: string, dataUrl: string): Promise<AIFriendUI> =>
    ipcRenderer.invoke("localai:setPfp", id, dataUrl),

  delete: (id: string): Promise<boolean> =>
    ipcRenderer.invoke("localai:delete", id),

  /**
   * Load the model and return the friend plus its transcript.
   *
   * `context` is a plain-text list of things that are true on this device right
   * now — the user's friend code, their address, who is connected. Only the
   * built-in assistant is given it, and the main process enforces that rather
   * than trusting the caller. It never leaves the machine: the model is local,
   * and none of this reaches the event log or a peer.
   */
  openChat: (
    id: string,
    context?: string,
  ): Promise<{ friend: AIFriendUI; messages: AIMessageUI[] }> =>
    ipcRenderer.invoke("localai:openChat", id, context),

  /** Unload the model. */
  closeChat: (id: string): Promise<boolean> =>
    ipcRenderer.invoke("localai:closeChat", id),

  /**
   * Ask the user to pick the folder a character may use.
   *
   * Opens the system folder picker in the main process and returns the path
   * chosen, or "" if they cancelled. The renderer never types a path in: the
   * only folder a character can be given is one somebody deliberately chose in
   * a dialog they recognise.
   */
  chooseFolder: (): Promise<string> => ipcRenderer.invoke("localai:chooseFolder"),

  /**
   * What a character did while answering: a page it read, a file it wrote.
   *
   * Shown in the transcript. A capability the user cannot watch is one they
   * cannot judge, so every action a character takes is reported here whether it
   * succeeded or not.
   */
  onAction: (
    handler: (e: { id: string; note: string; ok: boolean }) => void,
  ): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, e: never) => handler(e);
    ipcRenderer.on("localai:action", listener);
    return () => ipcRenderer.removeListener("localai:action", listener);
  },

  /** Wipe all messages with a friend and start the chat over. Returns the
   *  fresh transcript, which includes the greeting again if one is set. */
  clearChat: (id: string): Promise<{ messages: AIMessageUI[] }> =>
    ipcRenderer.invoke("localai:clearChat", id),

  /** Send a message; the reply streams via onToken/onDone. */
  send: (id: string, text: string): Promise<{ id: string; content: string }> =>
    ipcRenderer.invoke("localai:send", id, text),

  regenerate: (id: string): Promise<{ id: string; content: string }> =>
    ipcRenderer.invoke("localai:regenerate", id),

  generateScene: (id: string, msgId: string): Promise<boolean> =>
    ipcRenderer.invoke("localai:generateScene", id, msgId),

  /** Reply tokens as they are generated. Returns an unsubscribe function. */
  onToken: (
    handler: (e: { id: string; msgId: string; chunk: string }) => void,
  ): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, e: never) => handler(e);
    ipcRenderer.on("localai:token", listener);
    return () => ipcRenderer.removeListener("localai:token", listener);
  },

  /** A reply finished streaming. Returns an unsubscribe function. */
  onDone: (
    handler: (e: { id: string; msgId: string; content: string }) => void,
  ): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, e: never) => handler(e);
    ipcRenderer.on("localai:done", listener);
    return () => ipcRenderer.removeListener("localai:done", listener);
  },

  /** Scene image progress: generating | ready (with dataUrl) | error. */
  onScene: (
    handler: (e: {
      id: string;
      msgId: string;
      state: "generating" | "ready" | "error";
      dataUrl?: string;
      message?: string;
    }) => void,
  ): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, e: never) => handler(e);
    ipcRenderer.on("localai:scene", listener);
    return () => ipcRenderer.removeListener("localai:scene", listener);
  },

  /** Model load / generation status. Returns an unsubscribe function. */
  onStatus: (
    handler: (e: {
      id: string;
      state: "idle" | "loading" | "ready" | "generating" | "error";
      message?: string;
    }) => void,
  ): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, e: never) => handler(e);
    ipcRenderer.on("localai:status", listener);
    return () => ipcRenderer.removeListener("localai:status", listener);
  },

  // ---- two characters talking to each other --------------------------------
  //
  // An experiment surface: hand two character ids and an opening line, and the
  // main process alternates them through the model, streaming each line back on
  // the `duet*` events below. Only one runs at a time; `duetStop` asks the
  // current one to end after the line in flight.

  /** Start a conversation between two characters. Lines stream via the
   *  onDuet* handlers; resolves with how many were produced. */
  duetStart: (opts: {
    aId: string;
    bId: string;
    opener: string;
    exchanges: number;
  }): Promise<{ count: number; cancelled: boolean }> =>
    ipcRenderer.invoke("localai:duetStart", opts),

  /** Ask the running conversation to stop. */
  duetStop: (): Promise<boolean> => ipcRenderer.invoke("localai:duetStop"),

  /** A new line is about to be generated: open a bubble for `msgId`. */
  onDuetTurn: (
    handler: (e: {
      msgId: string;
      turn: number;
      speakerId: string;
      name: string;
    }) => void,
  ): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, e: never) => handler(e);
    ipcRenderer.on("localai:duetTurn", listener);
    return () => ipcRenderer.removeListener("localai:duetTurn", listener);
  },

  /** Tokens for the current line, as they are generated. */
  onDuetToken: (
    handler: (e: {
      msgId: string;
      turn: number;
      speakerId: string;
      chunk: string;
    }) => void,
  ): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, e: never) => handler(e);
    ipcRenderer.on("localai:duetToken", listener);
    return () => ipcRenderer.removeListener("localai:duetToken", listener);
  },

  /** A line finished: replace the streamed text with the tidied final content. */
  onDuetMessage: (
    handler: (e: {
      msgId: string;
      turn: number;
      speakerId: string;
      name: string;
      content: string;
    }) => void,
  ): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, e: never) => handler(e);
    ipcRenderer.on("localai:duetMessage", listener);
    return () => ipcRenderer.removeListener("localai:duetMessage", listener);
  },

  /** What a speaker did mid-line: a page read, a file written. */
  onDuetAction: (
    handler: (e: { speakerId: string; note: string; ok: boolean }) => void,
  ): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, e: never) => handler(e);
    ipcRenderer.on("localai:duetAction", listener);
    return () => ipcRenderer.removeListener("localai:duetAction", listener);
  },

  /** Load / generation status during a run, tagged with whose turn it is. */
  onDuetStatus: (
    handler: (e: {
      speakerId: string;
      state: "idle" | "loading" | "ready" | "generating" | "error";
      message?: string;
    }) => void,
  ): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, e: never) => handler(e);
    ipcRenderer.on("localai:duetStatus", listener);
    return () => ipcRenderer.removeListener("localai:duetStatus", listener);
  },

  /** The run ended — reached the end, or was stopped. */
  onDuetDone: (
    handler: (e: { count: number; cancelled: boolean }) => void,
  ): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, e: never) => handler(e);
    ipcRenderer.on("localai:duetDone", listener);
    return () => ipcRenderer.removeListener("localai:duetDone", listener);
  },

  /** The run failed. */
  onDuetError: (
    handler: (e: { message: string }) => void,
  ): (() => void) => {
    const listener = (_: Electron.IpcRendererEvent, e: never) => handler(e);
    ipcRenderer.on("localai:duetError", listener);
    return () => ipcRenderer.removeListener("localai:duetError", listener);
  },
});
