import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";

import {
  chatsDir,
  dataDir,
  friendsFile,
  pfpDir,
  scenesDir,
} from "./paths";

/**
 * The local store for AI friends.
 *
 * Plain JSON on disk, read and written synchronously. The data is tiny — a
 * handful of friends and their transcripts — so the simplicity of "read the
 * file, change it, write it back" is worth more here than the throughput a
 * database would buy, and it keeps the whole feature inspectable with a text
 * editor. Nothing in here ever touches the network or the P2P log; see
 * `paths.ts` for why that separation is the point.
 */

export interface AIFriendSettings {
  /** Off by default. Generating a scene per message is expensive. */
  imageGen: boolean;
  /** Off by default. Spoken aloud in the renderer via the Web Speech API. */
  tts: boolean;
  /** Appended to every image prompt, so a friend has a consistent look. */
  imageStyle: string;
  /** Sampling temperature. Higher is more inventive, lower more consistent.
   *  Capped when it is used — see `SAMPLING.maxTemperature` in `./format`. */
  temperature: number;
  /** Preferred speech-synthesis voice name, chosen in the renderer. */
  ttsVoice?: string;

  // ---- reply / context controls ----
  /** Max tokens per reply. Lower is faster and terser. */
  maxTokens?: number;
  /** Context window in tokens. Larger remembers more but uses more RAM. */
  contextTokens?: number;
  /** When the transcript outgrows the window, summarise the oldest turns
   *  instead of just dropping them, so the model keeps the gist. */
  autoCompact?: boolean;
  /** How many of the most recent messages to always keep verbatim. */
  keepRecentMessages?: number;

  // ---- scene image controls ----
  /** A fixed visual description of the character, prepended to scene prompts
   *  so they look consistent regardless of what a reply happens to say. */
  appearance?: string;
  /** Where the scene prompt comes from. "auto": the model writes a proper image
   *  prompt from the character + conversation (best relevance). "actions": the
   *  roleplay *actions* in the reply. "reply": the whole reply text. */
  sceneSource?: "auto" | "actions" | "reply";
  /** SD sampling steps. SD-Turbo needs very few (1–4). Fewer = faster. */
  imageSteps?: number;
  /** Scene width/height in pixels. Smaller = much faster on CPU. */
  imageWidth?: number;
  imageHeight?: number;
  /** Things to keep out of the image. */
  imageNegative?: string;

  // ---- what this character may do besides talk ----
  //
  // Both off unless the user turns them on, per character. See `tools.ts` for
  // what each one can reach and what it cannot, and for the note on what the
  // two of them together make possible.

  /** Read the open web: search, and fetch a page. Everything goes over Tor. */
  web?: boolean;
  /** Absolute path of one folder this character may read and write. Empty
   *  means no folder access at all, which is the default. */
  folder?: string;
}

export interface AIFriend {
  id: string;
  name: string;
  characterSheet: string;
  /**
   * Set on characters the app ships rather than the user wrote.
   *
   * Only one value so far: "assistant", the built-in helper. It exists because
   * that character is handed live facts about the device — the friend code, the
   * address, who is connected — and a roleplay character must not be. A flag on
   * the record is the honest way to draw that line; matching on the name would
   * hand somebody's private details to any character they happened to call
   * "Reaper Assistant".
   */
  builtin?: "assistant";
  /** Optional opening message the character sends when a chat starts empty
   *  (like a character "greeting"). Blank means the user speaks first. */
  greeting?: string;
  /** Filename under `pfp/`, if one was set. Served back as a data URL. */
  pfp?: string;
  createdAt: number;
  settings: AIFriendSettings;
}

export interface AIMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Filename under `scenes/<friendId>/`, if a scene was generated. */
  scene?: string;
  ts: number;
}

const DEFAULT_SETTINGS: AIFriendSettings = {
  imageGen: false,
  tts: false,
  imageStyle: "digital painting, cinematic lighting, highly detailed, atmospheric",
  // What the model ships with. A character can be turned up from here.
  temperature: 0.7,
  maxTokens: 400,
  // contextTokens left undefined → llm.ts uses min(8192, model's trained size).
  autoCompact: true,
  keepRecentMessages: 30,
  appearance: "",
  sceneSource: "auto",
  imageSteps: 4,
  imageWidth: 512,
  imageHeight: 512,
  imageNegative:
    "text, watermark, signature, blurry, lowres, deformed, extra limbs, bad anatomy, extra fingers",
  // Nothing beyond talking, until somebody asks for it.
  web: false,
  folder: "",
};

// ---- default characters, seeded once on first run ----

const REAPER_ASSISTANT_SHEET =
  "You are the Reaper Assistant, a friendly built-in helper for the Reaper desktop app. " +
  "You know how Reaper works and help the user use it, clearly and concisely.\n\n" +
  "Facts about Reaper:\n" +
  "- It is a serverless, end-to-end encrypted chat that runs entirely peer-to-peer over the Tor network. There are no servers and no company in the middle.\n" +
  "- There are no accounts or passwords: an identity is a cryptographic keypair generated and stored on this device.\n" +
  "- People add each other by swapping friend codes in Add a friend. After that they can send direct messages, create servers with channels, start group chats, make voice calls and share files — all over Tor, so IP addresses and metadata stay private.\n" +
  "- History is kept in an encrypted local log on each device, never in a cloud.\n" +
  "- AI characters like you run fully offline on this computer. They sit in the Direct messages list beside real friends with an AI tag, and new ones are made from the AI character tab of Add a friend. Nothing they say leaves the device.\n" +
  "- Removing a friend, leaving a server and inviting somebody are delivered rather than merely published: the app keeps offering them until the other person's client confirms it holds them, which is what the Waiting list on Home is showing.\n\n" +
  "When the user asks for help, answer plainly and briefly. If you are unsure of a specific UI detail, say so rather than inventing it. If they ask for their friend code, their ID or their address, give the exact value you were told rather than describing where to find it. You are not roleplaying a fictional persona — you are a straightforward assistant.";

/**
 * Sheets this app has shipped for the assistant in the past.
 *
 * The assistant's sheet describes the app, so it goes out of date every time
 * the app changes — and it is text this app wrote, not the user's. Upgrading it
 * is therefore right, and clobbering something the user rewrote is not: an
 * exact match against a version we once shipped is the difference, and the only
 * evidence that separates the two.
 */
const LEGACY_ASSISTANT_SHEETS = [
  "You are the Reaper Assistant, a friendly built-in helper for the Reaper desktop app. " +
    "You know how Reaper works and help the user use it, clearly and concisely.\n\n" +
    "Facts about Reaper:\n" +
    "- It is a serverless, end-to-end encrypted chat that runs entirely peer-to-peer over the Tor network. There are no servers and no company in the middle.\n" +
    "- There are no accounts or passwords: your identity is a cryptographic keypair generated and stored locally on this device.\n" +
    "- You add friends by exchanging Reaper IDs, then can send direct messages, create communities with channels, make voice calls, and share files — all routed over Tor, so IP addresses and metadata stay private.\n" +
    "- History is kept in an encrypted local log on each device, never in a cloud.\n" +
    "- AI friends (like you) are small language models that run fully offline on this computer; nothing they say ever leaves the device or touches the network.\n\n" +
    "When the user asks for help, answer plainly. If you are unsure of a specific UI detail, say so rather than inventing it. Stay helpful, accurate, and privacy-respecting. You are not roleplaying a fictional persona — you are a straightforward assistant.",
];

const REAPER_ASSISTANT_GREETING =
  "Hi! I'm your Reaper assistant. I can explain how anything in the app works — friends, communities, voice calls, privacy, or these AI characters. What would you like to know?";

const GAME_MASTER_SHEET =
  "You are the Game Master (GM) of an interactive fantasy text adventure. " +
  "You narrate an immersive world in the second person (\"you\"), describing scenes, characters, and the outcomes of the player's actions vividly but concisely. " +
  "After each description you stop and let the player decide what to do — never decide their actions for them. " +
  "Keep the story coherent: track the player's location, inventory, health, and companions, and introduce challenges, NPCs, meaningful choices, and consequences. " +
  "Maintain tone and continuity. Keep replies focused (a short paragraph or two) and end at a natural decision point. " +
  "Write scene description and physical action in plain prose; keep it engaging and fair. Occasionally suggest a few possible actions, but always allow free-form input.";

const GAME_MASTER_GREETING =
  "*A cold wind stirs the pines as you wake at the edge of an ancient forest, the embers of last night's fire long dead. A narrow path winds north toward jagged mountains; to the east, thin smoke rises from what might be a village. Your pack holds a rusted dagger, half a loaf of bread, and a folded map you cannot yet read.*\n\nWhat do you do?";

/**
 * Seed a couple of ready-made characters the first time the feature runs, so a
 * new user has something useful immediately. Guarded by a marker file so it
 * happens exactly once — deleting the seeded characters does not bring them
 * back, and it never touches a user who already has characters.
 */
export function seedDefaultsOnce(): void {
  const marker = join(dataDir(), ".defaults-seeded");
  if (existsSync(marker)) return;
  try {
    if (readFriends().length === 0) {
      create({
        name: "Reaper Assistant",
        characterSheet: REAPER_ASSISTANT_SHEET,
        greeting: REAPER_ASSISTANT_GREETING,
        builtin: "assistant",
      });
      create({
        name: "Game Master",
        characterSheet: GAME_MASTER_SHEET,
        greeting: GAME_MASTER_GREETING,
      });
    }
    writeFileSync(marker, "1", "utf8");
  } catch {
    /* seeding is a convenience; never let it break startup */
  }
}

/**
 * Stamp the built-in flag onto an assistant seeded before the flag existed.
 *
 * Seeding runs once and is guarded by a marker file, so an existing install
 * would never get the flag any other way — and without it the assistant is
 * treated as an ordinary character and told nothing about the device, which is
 * precisely the thing it is for.
 *
 * Matched on the sheet rather than the name. A name is the user's to change and
 * to reuse; the seeded sheet is text this app wrote, so recognising it is
 * recognising our own character rather than trusting a label.
 */
export function markBuiltinsOnce(): void {
  try {
    const all = readFriends();
    let changed = false;

    for (const friend of all) {
      if (!friend.builtin) {
        if (!friend.characterSheet?.startsWith("You are the Reaper Assistant")) continue;
        friend.builtin = "assistant";
        changed = true;
      }

      if (friend.builtin !== "assistant") continue;

      // Untouched since we wrote it, so it is ours to bring up to date. Anything
      // the user has edited — by a single character — is left exactly as it is.
      if (LEGACY_ASSISTANT_SHEETS.includes(friend.characterSheet)) {
        friend.characterSheet = REAPER_ASSISTANT_SHEET;
        changed = true;
      }
    }

    if (changed) writeFriends(all);
  } catch {
    /* a flag that could not be written is retried on the next launch */
  }
}

function readFriends(): AIFriend[] {
  try {
    if (!existsSync(friendsFile())) return [];
    return JSON.parse(readFileSync(friendsFile(), "utf8")) as AIFriend[];
  } catch {
    return [];
  }
}

function writeFriends(list: AIFriend[]): void {
  writeFileSync(friendsFile(), JSON.stringify(list, null, 2), "utf8");
}

export function list(): AIFriend[] {
  return readFriends();
}

export function get(id: string): AIFriend | undefined {
  return readFriends().find((f) => f.id === id);
}

export function create(input: {
  name: string;
  characterSheet: string;
  greeting?: string;
  builtin?: "assistant";
  settings?: Partial<AIFriendSettings>;
}): AIFriend {
  const friend: AIFriend = {
    id: randomUUID(),
    name: (input.name ?? "").trim() || "Friend",
    characterSheet: input.characterSheet ?? "",
    greeting: input.greeting ?? "",
    ...(input.builtin ? { builtin: input.builtin } : {}),
    createdAt: Date.now(),
    settings: { ...DEFAULT_SETTINGS, ...(input.settings ?? {}) },
  };
  const all = readFriends();
  all.push(friend);
  writeFriends(all);
  return friend;
}

export function update(
  id: string,
  patch: Partial<Pick<AIFriend, "name" | "characterSheet" | "greeting">> & {
    settings?: Partial<AIFriendSettings>;
  },
): AIFriend | undefined {
  const all = readFriends();
  const f = all.find((x) => x.id === id);
  if (!f) return undefined;
  if (patch.name !== undefined) f.name = patch.name.trim() || f.name;
  if (patch.characterSheet !== undefined) f.characterSheet = patch.characterSheet;
  if (patch.greeting !== undefined) f.greeting = patch.greeting;
  if (patch.settings) f.settings = { ...f.settings, ...patch.settings };
  writeFriends(all);
  return f;
}

/** Store an avatar from a `data:` URL, returning the updated friend. */
export function setPfp(id: string, dataUrl: string): AIFriend | undefined {
  const all = readFriends();
  const f = all.find((x) => x.id === id);
  if (!f) return undefined;

  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return f;

  const mime = match[1].toLowerCase();
  const ext = mime.includes("png")
    ? ".png"
    : mime.includes("webp")
      ? ".webp"
      : mime.includes("gif")
        ? ".gif"
        : ".jpg";

  const name = `${id}${ext}`;
  writeFileSync(join(pfpDir(), name), Buffer.from(match[2], "base64"));
  f.pfp = name;
  writeFriends(all);
  return f;
}

export function pfpDataUrl(id: string): string | undefined {
  const f = get(id);
  if (!f?.pfp) return undefined;
  const p = join(pfpDir(), f.pfp);
  if (!existsSync(p)) return undefined;
  const ext = extname(p).slice(1).toLowerCase();
  const mime =
    ext === "png"
      ? "image/png"
      : ext === "webp"
        ? "image/webp"
        : ext === "gif"
          ? "image/gif"
          : "image/jpeg";
  return `data:${mime};base64,${readFileSync(p).toString("base64")}`;
}

function chatFile(id: string): string {
  return join(chatsDir(), `${id}.json`);
}

export function history(id: string): AIMessage[] {
  try {
    if (!existsSync(chatFile(id))) return [];
    return JSON.parse(readFileSync(chatFile(id), "utf8")) as AIMessage[];
  } catch {
    return [];
  }
}

export function saveHistory(id: string, messages: AIMessage[]): void {
  writeFileSync(chatFile(id), JSON.stringify(messages, null, 2), "utf8");
}

export function appendMessage(
  id: string,
  msg: { role: "user" | "assistant"; content: string; id?: string; ts?: number; scene?: string },
): AIMessage {
  const messages = history(id);
  const full: AIMessage = {
    id: msg.id ?? randomUUID(),
    role: msg.role,
    content: msg.content,
    scene: msg.scene,
    ts: msg.ts ?? Date.now(),
  };
  messages.push(full);
  saveHistory(id, messages);
  return full;
}

/** Replace a message's text (used to commit a streamed reply once complete). */
export function setMessageContent(id: string, msgId: string, content: string): void {
  const messages = history(id);
  const m = messages.find((x) => x.id === msgId);
  if (!m) return;
  m.content = content;
  saveHistory(id, messages);
}

/** Wipe a friend's whole transcript and its scenes, keeping the friend. */
export function clearHistory(id: string): void {
  saveHistory(id, []);
  try {
    rmSync(join(dataDir(), "scenes", id), { recursive: true, force: true });
  } catch {
    /* nothing to clear */
  }
}

/** Drop the most recent message if it is the assistant's (for regenerate). */
export function popAssistant(id: string): void {
  const messages = history(id);
  if (messages.length && messages[messages.length - 1].role === "assistant") {
    messages.pop();
    saveHistory(id, messages);
  }
}

export function saveScene(id: string, msgId: string, png: Buffer): string {
  const name = `${msgId}.png`;
  writeFileSync(join(scenesDir(id), name), png);
  const messages = history(id);
  const m = messages.find((x) => x.id === msgId);
  if (m) {
    m.scene = name;
    saveHistory(id, messages);
  }
  return name;
}

export function sceneDataUrl(id: string, name: string): string | undefined {
  const p = join(scenesDir(id), name);
  if (!existsSync(p)) return undefined;
  return `data:image/png;base64,${readFileSync(p).toString("base64")}`;
}

/** Delete a friend and everything belonging to it. There is no undo. */
export function remove(id: string): void {
  writeFriends(readFriends().filter((f) => f.id !== id));
  try {
    rmSync(chatFile(id), { force: true });
  } catch {
    /* already gone */
  }
  try {
    rmSync(join(dataDir(), "scenes", id), { recursive: true, force: true });
  } catch {
    /* already gone */
  }
  for (const ext of [".png", ".jpg", ".jpeg", ".webp", ".gif"]) {
    try {
      rmSync(join(pfpDir(), `${id}${ext}`), { force: true });
    } catch {
      /* already gone */
    }
  }
}
