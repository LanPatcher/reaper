/**
 * Two characters, talking to each other.
 *
 * ## What this is for
 *
 * An experiment: point two AI characters at one another, give them an opening
 * line, and let them take turns for a while. Nothing here is part of a real
 * conversation with the user — it is a sandbox for watching two personas react
 * to each other.
 *
 * ## Why the loop lives here, injected, rather than in the bridge
 *
 * The turn-taking is the whole idea and the one thing worth testing on its own:
 * who speaks next, what each speaker is shown of what came before, when to stop.
 * The model itself cannot run in a unit test — it is two gigabytes of native
 * code and a real GPU — so the two things that touch it (`prime`, to load a
 * speaker with its history, and `reply`, to generate one turn) are passed in.
 * The test hands `runDuet` a `reply` that just echoes a canned line and checks
 * that the right speaker was primed with the right transcript each time; the
 * bridge hands it the real model. See `duet.test.ts`.
 *
 * ## The single-session constraint, and what it costs
 *
 * `llm.ts` keeps exactly one chat loaded at a time — opening a second disposes
 * the first. So two characters cannot both be resident; instead every turn
 * re-opens the speaker's side of the conversation, primed with everything said
 * so far. That is more work than a persistent pair of contexts would be (the
 * priming grows with the transcript), but it needs no change to how the model
 * is loaded, and for an experiment of a few dozen turns the cost is a beat
 * between messages, not a wall. `autoCompact` in `llm.openChat` keeps a long
 * run from overflowing the window.
 */

/** One line in the conversation, attributed to whoever said it. */
export interface DuetMessage {
  /** 0-based index in the exchange. */
  turn: number;
  /** The friend id of the speaker. */
  speakerId: string;
  content: string;
}

export interface DuetSpeaker {
  id: string;
  name: string;
}

export interface DuetOptions {
  /** The character who speaks first. */
  a: DuetSpeaker;
  /** The character who answers. */
  b: DuetSpeaker;
  /**
   * The line delivered to the first speaker to get things going — a topic, a
   * scenario, or the opening thing "said" to them. It is not itself shown as a
   * message; the first speaker's reply to it is the first line of the duet.
   */
  opener: string;
  /** How many messages to generate in total, across both speakers. */
  exchanges: number;
}

/** The two model-touching operations, injected so the loop can be tested. */
export interface DuetDeps {
  /**
   * Load `speakerId` ready to answer, primed with `history` — everything said
   * so far, from that speaker's point of view (its own lines as the assistant,
   * the other's as the user).
   */
  prime(speakerId: string, history: { role: "user" | "assistant"; content: string }[]): Promise<void>;
  /**
   * Generate one reply from the primed speaker, answering `incoming` (the line
   * just said to it). Chunks stream through `onChunk`; the whole reply is
   * returned.
   */
  reply(
    speakerId: string,
    incoming: string,
    onChunk: (chunk: string) => void,
  ): Promise<string>;
  /** Checked before each turn; return true to stop the duet early. */
  cancelled(): boolean;
  /** A whole message finished. */
  onMessage(message: DuetMessage): void;
  /** A turn is about to be generated — for a "X is typing…" hint. */
  onTurnStart?(speakerId: string, turn: number): void;
  /** A chunk arrived mid-generation, for live streaming. */
  onChunk?(speakerId: string, turn: number, chunk: string): void;
}

/** Sanity bounds on how long a run may be. One is pointless; a thousand is a
 *  runaway that fills an evening and a disk with the model talking to itself. */
export const MIN_EXCHANGES = 1;
export const MAX_EXCHANGES = 60;

export function clampExchanges(n: number): number {
  if (!Number.isFinite(n)) return MIN_EXCHANGES;
  return Math.max(MIN_EXCHANGES, Math.min(MAX_EXCHANGES, Math.floor(n)));
}

/**
 * The transcript as one speaker sees it: the speaker's own lines are the
 * assistant's, everyone else's are the user's. Blank lines are dropped so a
 * failed turn never becomes an empty history entry that teaches the model
 * saying nothing is a turn.
 */
export function perspective(
  speakerId: string,
  transcript: DuetMessage[],
): { role: "user" | "assistant"; content: string }[] {
  return transcript
    .filter((m) => m.content)
    .map((m) => ({
      role: m.speakerId === speakerId ? ("assistant" as const) : ("user" as const),
      content: m.content,
    }));
}

/** Whose turn it is at `turn`: A opens, then they alternate. */
export function speakerAt(turn: number, a: DuetSpeaker, b: DuetSpeaker): DuetSpeaker {
  return turn % 2 === 0 ? a : b;
}

/**
 * Run the exchange to the end (or until cancelled), one message at a time.
 *
 * Each turn: work out who speaks, prime them with everything before the line
 * they are answering, generate the reply, and hand it on as the next speaker's
 * incoming line. The opener is what the first speaker answers; from then on the
 * incoming line is simply whatever the other one just said.
 */
export async function runDuet(opts: DuetOptions, deps: DuetDeps): Promise<DuetMessage[]> {
  const total = clampExchanges(opts.exchanges);
  const transcript: DuetMessage[] = [];

  // What the current speaker is answering. For the first turn it is the opener;
  // after that it is the previous message, which is also the last entry in the
  // transcript — so the speaker's priming history is the transcript with that
  // last line removed (it arrives as `incoming`, not as history).
  let incoming = opts.opener ?? "";

  for (let turn = 0; turn < total; turn++) {
    if (deps.cancelled()) break;

    const speaker = speakerAt(turn, opts.a, opts.b);
    const history = perspective(speaker.id, transcript.slice(0, -1));

    await deps.prime(speaker.id, history);
    deps.onTurnStart?.(speaker.id, turn);

    const content = await deps.reply(speaker.id, incoming, (chunk) =>
      deps.onChunk?.(speaker.id, turn, chunk),
    );

    const message: DuetMessage = { turn, speakerId: speaker.id, content };
    transcript.push(message);
    deps.onMessage(message);

    incoming = content;
  }

  return transcript;
}
