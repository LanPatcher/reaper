import { existsSync } from "node:fs";

import { log } from "../native/diagnostics";
import * as agent from "./agent";
import { CHATML_FORMAT, SAMPLING, STOP_MARKERS } from "./format";
import { llmModelPath } from "./paths";
import type { AIFriendSettings } from "./store";

/**
 * The local language model, wrapped so the rest of the app never sees
 * `node-llama-cpp` directly.
 *
 * ## Loaded only while a chat is open
 *
 * A 3B model is a couple of gigabytes of RAM (more with a GPU), so it is loaded
 * lazily — the first time a chat is opened — and disposed the moment that chat
 * is closed. An idle friend in the list costs nothing. The cost of that promise
 * is a few seconds of "waking up" when a chat is opened cold, which the UI shows
 * rather than hides.
 *
 * ## Why dynamic import
 *
 * `node-llama-cpp` is ESM-only and this bundle is CommonJS, so it cannot be
 * `require`d. `await import(...)` is the supported bridge — and it happens to
 * align perfectly with lazy loading, since the module (and the native binary it
 * carries) is only pulled in when a model is actually wanted.
 */

export type Chunk = (text: string) => void;

export type StatusState =
  | "idle"
  | "loading"
  | "ready"
  | "generating"
  | "error";

export type Status = (s: { state: StatusState; message?: string }) => void;

// node-llama-cpp's chat history shape: system/user turns carry `text`, but a
// model turn carries a `response` array — NOT `text`. Getting this wrong makes
// its internals throw "modelResponse is not iterable" on the next prompt.
type ChatHistoryItem =
  | { type: "system"; text: string }
  | { type: "user"; text: string }
  | { type: "model"; response: string[] };

// The module and the llama instance are shared for the process lifetime; the
// heavyweight model and per-chat context are what come and go.
let modPromise: Promise<unknown> | undefined;
let mod: {
  getLlama: () => Promise<unknown>;
  LlamaChatSession: new (opts: unknown) => unknown;
  TemplateChatWrapper: new (opts: unknown) => unknown;
};
let llamaInstance: { loadModel: (o: unknown) => Promise<unknown> } | undefined;
let model:
  | {
      createContext: (o?: unknown) => Promise<unknown>;
      dispose?: () => Promise<void> | void;
      trainContextSize?: number;
    }
  | undefined;

let active:
  | { id: string; context: { getSequence: () => unknown; dispose?: () => void }; session: { prompt: (t: string, o?: unknown) => Promise<string>; setChatHistory?: (h: ChatHistoryItem[]) => void } }
  | undefined;

async function llama() {
  if (!modPromise) {
    modPromise = (async () => {
      mod = (await import("node-llama-cpp")) as never;
      llamaInstance = (await mod.getLlama()) as never;
    })();
  }
  await modPromise;
  return llamaInstance!;
}

/** The chat format, and what ends a turn. Both live in `./format`, which has
 *  no imports so the test can check them against a real wrapper. */
function chatWrapper(): unknown {
  return new mod.TemplateChatWrapper(CHATML_FORMAT);
}

const STOP = STOP_MARKERS;

/** Whether the bundled model file is actually present on disk. */
export function isModelPresent(): boolean {
  try {
    return existsSync(llmModelPath());
  } catch {
    return false;
  }
}

/** The id of the chat whose session is currently live, if any. */
export function activeId(): string | undefined {
  return active?.id;
}

async function ensureModel(status?: Status) {
  if (model) return model;
  status?.({ state: "loading", message: "Loading model…" });
  const l = await llama();
  model = (await l.loadModel({ modelPath: llmModelPath() })) as never;
  return model!;
}

/**
 * The system prompt.
 *
 * ## Short, with no quotable furniture in it
 *
 * The previous version wrapped the user's sheet in a labelled block —
 * `--- Character sheet ---` — and surrounded it with instructions about staying
 * in character and never mentioning instructions. On a large model that reads
 * as framing. On a 1.1B it reads as *content*, and the most likely continuation
 * of "here is a character sheet" is another character sheet: the model reprinted
 * the whole thing at the user, delimiter and all. Mentioning instructions is
 * what put instructions in scope.
 *
 * So there is no label, no delimiter, and nothing about what not to do beyond
 * the one line that stops the model writing the user's half. The sheet is
 * stated as fact in the second person, which is the form a small model is most
 * likely to simply continue from rather than quote.
 *
 * This is a private, local, uncensored roleplay by design — the model belongs
 * to the person running it and answers only to them.
 */
export function buildSystemPrompt(
  friend: {
    name: string;
    characterSheet: string;
    settings?: Partial<AIFriendSettings>;
  },
  opening?: string,
  context?: string,
): string {
  const sheet = (friend.characterSheet ?? "").trim();
  const facts = (context ?? "").trim();
  const abilities = agent.toolPrompt({
    web: !!friend.settings?.web,
    folder: friend.settings?.folder ?? "",
  });

  return [
    `You are ${friend.name}.`,
    sheet,
    facts
      ? "These things are true on this computer right now. They are the only " +
        "way you can know them, so use them as written and quote them exactly " +
        "when you are asked:\n" + facts
      : "",
    abilities,
    opening
      ? `You have already said this, and the conversation continues from it:\n${opening}`
      : "",
    // With tools in scope this line has to be written carefully, because the
    // obvious version quietly cancels them: "write one or two short paragraphs"
    // is an instruction to produce prose, and a command line is not prose. Told
    // both, a small model obeys the last thing it read and writes a paragraph
    // about searching instead of searching. So when there are abilities, the
    // command case is stated first and the prose case is the fallback.
    abilities
      ? `Reply as ${friend.name}, in your own voice. If what the user wants ` +
        "needs one of the commands above, the whole of your reply is that " +
        "command line and nothing else - no sentence before it and none after. " +
        "Otherwise answer in one or two short paragraphs and then stop. Never " +
        "write the user's lines for them."
      : `Reply as ${friend.name}, in your own voice, to what the user just said. ` +
        "Write one or two short paragraphs and then stop. Never write the user's " +
        "lines for them.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function toHistory(
  system: string,
  messages: { role: string; content: string }[],
): ChatHistoryItem[] {
  const h: ChatHistoryItem[] = [{ type: "system", text: system }];
  for (const m of messages) {
    if (!m.content) continue;
    if (m.role === "assistant") h.push({ type: "model", response: [m.content] });
    else h.push({ type: "user", text: m.content });
  }
  return h;
}

/**
 * Open a chat: ensure the model is loaded, then build a fresh context and
 * session seeded with the character sheet and any prior transcript.
 *
 * Called again (with the same id) after the sheet is edited, so a persona
 * change takes effect on the very next reply rather than the next launch.
 */
export async function openChat(
  friend: {
    id: string;
    name: string;
    characterSheet: string;
    settings?: Partial<AIFriendSettings>;
  },
  messages: { role: string; content: string }[],
  status?: Status,
  // Deliberately not called `context`: that name already belongs to the llama
  // context a few lines down, and a parameter sharing it is shadowed by the
  // `const` rather than shadowing it — so the system prompt would have been
  // handed a context object where a string was meant.
  facts?: string,
): Promise<void> {
  await ensureModel(status);

  if (active) {
    try {
      active.context.dispose?.();
    } catch {
      /* best effort */
    }
    active = undefined;
  }

  const settings = friend.settings ?? {};
  const trained = model!.trainContextSize ?? 4096;
  // A large window by default so a chat can run long; capped by what the model
  // was trained for. node-llama-cpp shifts out the oldest tokens automatically
  // when even this fills, so a conversation never hard-stops.
  const want = settings.contextTokens ?? Math.min(8192, trained);
  const contextSize = Math.max(512, Math.min(want, trained));
  const context = (await model!.createContext({ contextSize })) as never as {
    getSequence: () => unknown;
    dispose?: () => void;
  };

  // Compaction: if the transcript is long, summarise the oldest turns into a
  // single note and keep only the most recent verbatim, so the model stays
  // coherent over a long history without blowing the context. Falls back to the
  // full transcript if summarising fails.
  let seed = messages;
  const keepRecent = settings.keepRecentMessages ?? 30;
  if ((settings.autoCompact ?? true) && messages.length > keepRecent) {
    const older = messages.slice(0, messages.length - keepRecent);
    const recent = messages.slice(messages.length - keepRecent);
    const summary = await summarise(older, status).catch(() => "");
    seed = summary
      ? [
          { role: "user", content: `[Summary of earlier events, for context: ${summary}]` },
          ...recent,
        ]
      : recent;
  }

  // The greeting, carried into the system prompt rather than thrown away.
  //
  // The model's history has to begin with a user turn, and a character's
  // opening line is an assistant message with nothing before it — so these used
  // to be dropped. That is a much larger loss than it looks: for both characters
  // the app ships with, the greeting is the *only* message until somebody types,
  // so the model answered the first thing it was ever told with no idea a scene
  // had been set. The Game Master, asked to "walk forward", had never been told
  // there was a forest; it replied by describing the game it had been asked to
  // run, which is the correct completion of a prompt with no story in it.
  //
  // Folding the opening into the system prompt keeps it out of the history while
  // leaving the model in possession of it.
  const opening: string[] = [];
  while (seed.length && seed[0].role === "assistant") {
    if (seed[0].content) opening.push(seed[0].content);
    seed = seed.slice(1);
  }

  const system = buildSystemPrompt(
    friend,
    opening.join("\n\n").slice(0, 1200),
    facts,
  );
  const session = new mod.LlamaChatSession({
    contextSequence: context.getSequence(),
    chatWrapper: chatWrapper(),
    systemPrompt: system,
  }) as never as {
    prompt: (t: string, o?: unknown) => Promise<string>;
    setChatHistory?: (h: ChatHistoryItem[]) => void;
  };

  if (seed.length && typeof session.setChatHistory === "function") {
    try {
      session.setChatHistory(toHistory(system, seed));
    } catch (error) {
      log("[localai] setChatHistory failed, continuing fresh:", String(error));
    }
  }

  active = { id: friend.id, context, session };
  status?.({ state: "ready" });
}

/**
 * Compress a run of older messages into a few sentences of notes, using the
 * already-loaded model on a throwaway context. Best-effort: any failure returns
 * an empty string and the caller keeps the raw transcript instead.
 */
async function summarise(
  messages: { role: string; content: string }[],
  status?: Status,
): Promise<string> {
  if (!model || !messages.length) return "";
  status?.({ state: "loading", message: "Compacting memory…" });
  const transcript = messages
    .filter((m) => m.content)
    .map((m) => `${m.role === "assistant" ? "Character" : "User"}: ${m.content}`)
    .join("\n")
    .slice(-6000);
  if (!transcript) return "";

  const trained = model.trainContextSize ?? 4096;
  const ctx = (await model.createContext({
    contextSize: Math.min(4096, trained),
  })) as never as { getSequence: () => unknown; dispose?: () => void };
  try {
    const s = new mod.LlamaChatSession({
      contextSequence: ctx.getSequence(),
      chatWrapper: chatWrapper(),
      systemPrompt:
        "You compress roleplay transcripts into concise third-person notes. Output only the notes.",
    }) as never as { prompt: (t: string, o?: unknown) => Promise<string> };
    const out = await s.prompt(
      "Summarise the key events, relationships, and the current situation in these earlier messages as compact notes (3–5 sentences) so the story can continue consistently:\n\n" +
        transcript,
      { temperature: 0.3, maxTokens: 220 },
    );
    return out.trim();
  } finally {
    try {
      ctx.dispose?.();
    } catch {
      /* best effort */
    }
  }
}

/**
 * Turn the current story moment into a Stable Diffusion prompt.
 *
 * The model already knows the character and the conversation, so it can write a
 * concrete visual description even when the reply itself is pure dialogue — far
 * better scene relevance than scraping words out of the reply text. Runs on a
 * throwaway context so it never pollutes the chat history, and is best-effort:
 * any failure returns "" and the caller falls back to text extraction.
 */
export async function describeScene(
  friend: {
    name: string;
    characterSheet: string;
    settings?: Partial<AIFriendSettings>;
  },
  reply: string,
  recent: { role: string; content: string }[],
): Promise<string> {
  if (!model || !reply.trim()) return "";
  const trained = model.trainContextSize ?? 4096;
  const ctx = (await model.createContext({
    contextSize: Math.min(4096, trained),
  })) as never as { getSequence: () => unknown; dispose?: () => void };
  try {
    const s = new mod.LlamaChatSession({
      contextSequence: ctx.getSequence(),
      chatWrapper: chatWrapper(),
      systemPrompt:
        "You convert a story moment into ONE Stable Diffusion image prompt. " +
        "Output only comma-separated visual tags — the subject and their " +
        "appearance and clothing, their action or pose, the setting, and the " +
        "lighting or mood. Third person, concrete and visual. No dialogue, no " +
        "quotation marks, no sentences, no names of speakers, no preamble.",
    }) as never as { prompt: (t: string, o?: unknown) => Promise<string> };

    const appearance = (friend.settings?.appearance ?? "").trim();
    const sheet = (friend.characterSheet ?? "").trim().slice(0, 400);
    const convo = recent
      .filter((m) => m.content)
      .slice(-4)
      .map((m) => `${m.role === "assistant" ? friend.name : "User"}: ${m.content}`)
      .join("\n")
      .slice(-1200);

    const ask = [
      `Character: ${friend.name}.`,
      appearance
        ? `Fixed appearance (always include): ${appearance}.`
        : sheet
          ? `Character notes: ${sheet}.`
          : "",
      convo ? `Recent conversation:\n${convo}` : "",
      `Depict this latest moment:\n${reply.slice(0, 600)}`,
      "Image prompt (comma-separated visual tags only):",
    ]
      .filter(Boolean)
      .join("\n\n");

    const out = await s.prompt(ask, { temperature: 0.4, maxTokens: 90 });
    return out
      .replace(/^[^:]*:\s*/, "") // drop any "Image prompt:" style prefix
      .replace(/["\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } finally {
    try {
      ctx.dispose?.();
    } catch {
      /* best effort */
    }
  }
}

function escapeRe(s: string): string {
  return String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Tidy a finished reply.
 *
 * Small models leak. They open with the turn marker they were meant to be
 * answering, they address themselves by name as though writing a script, and —
 * with a character sheet fresh in the context — they start reciting it. None of
 * that is worth showing, and none of it is worth storing either, because
 * whatever is stored is fed back as history and teaches the next reply to do
 * the same thing. A leak left in the transcript compounds.
 *
 * Conservative on purpose: everything here removes a prefix or truncates at a
 * marker, and a reply that turns out to be nothing but furniture is returned
 * unchanged rather than blanked. Nothing rewrites what the character said.
 */
export function cleanReply(name: string, sheet: string, text: string): string {
  let out = String(text ?? "");

  // A turn marker the model wrote itself, and everything after it: that is the
  // model having carried on into somebody else's turn.
  for (const marker of STOP) {
    const at = out.indexOf(marker);
    if (at >= 0) out = out.slice(0, at);
  }

  out = out.trim();

  // "Name:" or "Assistant:" at the very start — a script direction, not speech.
  if (name) {
    out = out.replace(new RegExp(`^${escapeRe(name)}\\s*:\\s*`, "i"), "").trim();
  }
  out = out.replace(/^(?:assistant|ai|bot)\s*:\s*/i, "").trim();

  // A block header the old prompt taught it to write.
  out = out.replace(/^-{2,}\s*character sheet\s*-{2,}\s*/i, "").trim();

  // The sheet, recited back. Matched on a decent run of its opening rather than
  // the whole thing, since a model paraphrases as it copies.
  const opening = String(sheet ?? "").trim().slice(0, 60);
  if (opening.length >= 24) {
    const at = out.indexOf(opening);
    if (at >= 0) out = out.slice(0, at).trim();
  }

  return out || String(text ?? "").trim();
}

/**
 * Generate a reply, streaming chunks as they arrive. Returns the full text.
 *
 * Sampling comes from `./format`, which carries the values this particular
 * model ships with rather than a guess. The temperature the user chose for a
 * character is honoured, only capped — see `SAMPLING.maxTemperature`.
 */
export async function prompt(
  id: string,
  text: string,
  opts: { temperature: number; maxTokens?: number },
  onChunk: Chunk,
  status?: Status,
  friend?: {
    name: string;
    characterSheet: string;
    settings?: Partial<AIFriendSettings>;
  },
  onAction?: (note: string, ok: boolean) => void,
): Promise<string> {
  if (!active || active.id !== id) {
    throw new Error("that chat is not open");
  }

  const caps = {
    web: !!friend?.settings?.web,
    folder: friend?.settings?.folder ?? "",
  };

  // A character with nothing to do but talk takes the short path, which is
  // every character unless somebody turned something on.
  if (!caps.web && !caps.folder) {
    return generate(id, text, opts, onChunk, status, friend);
  }

  return runWithTools(id, text, opts, onChunk, status, friend, caps, onAction);
}

/**
 * Talk, act, talk again.
 *
 * The model answers; if the answer is a command, it is carried out and the
 * result handed back as the next turn, and it answers again. Bounded, because a
 * small model that has decided to search will otherwise search forever — and
 * because every round is a full generation, so the cost of a runaway is
 * measured in minutes.
 *
 * The commands themselves are never shown. What the user sees is a line saying
 * what happened, then the reply that came after it.
 */
const MAX_ROUNDS = 4;

/**
 * How many times a reply may be sent back for another go.
 *
 * Separate from the round budget on purpose. A round is a tool call and costs a
 * network fetch; a nudge is a re-ask and costs one generation, and spending the
 * tool budget on re-asks is how a model that stumbles once ends up unable to
 * finish. Each kind of stumble is also nudged at most once — a model that
 * apologises through two identical reminders will apologise through a third,
 * and the user is better served by seeing what it actually said.
 */
const MAX_NUDGES = 2;

async function runWithTools(
  id: string,
  text: string,
  opts: { temperature: number; maxTokens?: number },
  onChunk: Chunk,
  status: Status | undefined,
  friend:
    | { name: string; characterSheet: string; settings?: Partial<AIFriendSettings> }
    | undefined,
  caps: { web: boolean; folder: string },
  onAction?: (note: string, ok: boolean) => void,
): Promise<string> {
  let turn = text;
  let spoken = "";
  let rounds = 0;
  let nudges = 0;
  let ran = false;

  // Which stumbles have already been answered, so each is answered once.
  const spent = new Set<string>();

  /** Send the last reply back for another go, if that is still allowed. */
  const nudge = (kind: string, message: string, note: string): boolean => {
    if (spent.has(kind) || nudges >= MAX_NUDGES) return false;
    spent.add(kind);
    nudges++;
    status?.({ state: "loading", message: note });
    turn = message;
    return true;
  };

  while (rounds < MAX_ROUNDS) {
    // Only the final words are streamed. An intermediate reply is usually "let
    // me look that up", and streaming each one would show the user the model
    // talking to itself.
    const raw = await generate(id, turn, opts, () => undefined, status, friend);

    const commands = agent.parseCommands(raw);
    const said = agent.stripCommands(raw);

    if (!commands.length) {
      // Nothing has run yet: the model was asked for something and produced
      // words instead of a command. Three shapes of that are worth one re-ask
      // each, because all three are the model being wrong about what it can do
      // rather than about the answer.
      if (!ran) {
        // It apologised for being unable while holding the command that does
        // it. See agent.looksLikeRefusal / agent.NUDGE.
        if (agent.looksLikeRefusal(raw) && nudge("refusal", agent.NUDGE, "thinking…")) {
          continue;
        }
        // It said it was searching. Saying so is not doing so, and this is the
        // failure that looks most like success — the user sees "Searching for
        // …" and waits for a result that was never asked for. See
        // agent.looksLikeNarration / agent.NUDGE_NARRATION.
        if (
          agent.looksLikeNarration(raw) &&
          nudge("narration", agent.NUDGE_NARRATION, "thinking…")
        ) {
          continue;
        }
        // It wrote out a result it never fetched. Before any command has run
        // there is nothing a URL could have come from, so one in the text can
        // only be invented. See agent.looksLikeUnbackedResult.
        if (
          caps.web &&
          agent.looksLikeUnbackedResult(raw) &&
          nudge("fabrication", agent.NUDGE_FABRICATION, "checking…")
        ) {
          continue;
        }
      } else if (
        // A result did come back and the model apologised at it. This is the
        // failure the user actually hits once the tools work: the fetch
        // succeeded, the answer is sitting in the context, and the reply is
        // "I'm sorry, but I cannot assist with that." It needs the opposite
        // instruction to the one above — read what you have, do not go again.
        agent.looksLikeRefusal(raw) &&
        nudge("answer", agent.NUDGE_ANSWER, "reading…")
      ) {
        continue;
      }

      // Whatever came before a command was "let me look that up", so it is
      // dropped once there is a real answer to show instead, and kept only as
      // a fallback when the model ran a tool and then said nothing at all.
      const reply = said || spoken || raw.trim();
      onChunk(reply);
      return reply;
    }

    if (said && !ran) spoken = spoken ? spoken + "\n\n" + said : said;

    // `normalize` rescues the right tool addressed the wrong way — a FETCH
    // handed a description, a SEARCH handed a search URL — before the status
    // line and the result turn are built from it, so all three agree on what
    // actually ran. See agent.normalize.
    const command = agent.normalize(commands[0]);
    rounds++;
    ran = true;
    status?.({ state: "loading", message: `${command.name.toLowerCase()}…` });

    const result = await agent.run(command, caps);
    onAction?.(result.note, result.ok);
    log("[aitools]", command.name, command.arg, result.ok ? "ok" : "failed");

    // The original request goes back with the result. Without it a small model
    // reaches the end of a page of search results having forgotten what it was
    // looking for, and answers the last thing it read instead.
    turn = agent.resultTurn(command, result, text);
  }

  // Out of rounds. Whatever it managed to say is better than nothing, and
  // saying so is better than pretending the answer is complete.
  const reply =
    (spoken || "I looked into that but could not finish.") +
    "\n\n(I stopped after several steps.)";
  onChunk(reply);
  return reply;
}

/** One generation, with no tools involved. */
async function generate(
  id: string,
  text: string,
  opts: { temperature: number; maxTokens?: number },
  onChunk: Chunk,
  status?: Status,
  friend?: {
    name: string;
    characterSheet: string;
    settings?: Partial<AIFriendSettings>;
  },
): Promise<string> {
  if (!active || active.id !== id) {
    throw new Error("that chat is not open");
  }
  status?.({ state: "generating" });
  try {
    const temperature = Math.min(
      SAMPLING.maxTemperature,
      Math.max(0, opts.temperature ?? SAMPLING.defaultTemperature),
    );
    const out = await active.session.prompt(text, {
      temperature,
      maxTokens: opts.maxTokens,
      topK: SAMPLING.topK,
      topP: SAMPLING.topP,
      minP: SAMPLING.minP,
      repeatPenalty: { ...SAMPLING.repeatPenalty },
      customStopTriggers: STOP,
      trimWhitespaceSuffix: true,
      onTextChunk: (c: string) => onChunk(c),
    });
    const reply = cleanReply(friend?.name ?? "", friend?.characterSheet ?? "", out);

    // Nothing at all came back. That is a fault in how the model was prompted
    // rather than something it chose to say, and storing it as an empty message
    // hides the fault twice over: the chat shows a blank bubble, and the blank
    // is fed back as history next time. Say so instead.
    if (!reply.trim()) {
      log("[localai] the model returned an empty reply");
      status?.({ state: "error", message: "The model returned nothing." });
      throw new Error("the model returned nothing — try sending that again");
    }

    status?.({ state: "ready" });
    return reply;
  } catch (error) {
    status?.({ state: "error", message: String(error) });
    throw error;
  }
}

/** Close a chat and free the model. */
export async function closeChat(id: string): Promise<void> {
  if (active && active.id === id) {
    active = undefined;
  }
  await unloadModel();
}

/** Dispose everything. Safe to call at any time, including on quit. */
export async function unloadModel(): Promise<void> {
  try {
    active?.context.dispose?.();
  } catch {
    /* best effort */
  }
  active = undefined;
  if (model) {
    try {
      await model.dispose?.();
    } catch {
      /* best effort */
    }
    model = undefined;
  }
}
