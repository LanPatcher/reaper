import { dialog, ipcMain } from "electron";

import { log } from "../native/diagnostics";
import * as duet from "./duet";
import * as llm from "./llm";
import * as store from "./store";
import type { AIFriend, AIMessage } from "./store";

/**
 * The IPC surface for local AI friends, mirroring the shape of
 * `src/p2p/bridge.ts`: `ipcMain.handle("localai:*")` for request/response, and
 * `event.sender.send("localai:*")` for the things that stream — tokens as they
 * are generated, a scene when it finishes, and load/generation status.
 *
 * Registered only on Windows for now (see `main.ts`); on every other platform
 * `window.localai.available()` returns false and the UI hides itself.
 */

/** A friend with its avatar resolved to a data URL, ready for the renderer. */
function friendForUi(f: AIFriend) {
  return { ...f, pfpUrl: store.pfpDataUrl(f.id) };
}

/** If a chat is empty and the character has a greeting, post it as the first
 *  message so the character opens the scene. Blank greeting = user speaks first. */
function seedGreetingIfEmpty(friend: AIFriend): void {
  if (store.history(friend.id).length === 0 && (friend.greeting ?? "").trim()) {
    store.appendMessage(friend.id, { role: "assistant", content: friend.greeting!.trim() });
  }
}

/** A message with its scene resolved to a data URL. */
function messageForUi(friendId: string, m: AIMessage) {
  return {
    ...m,
    sceneUrl: m.scene ? store.sceneDataUrl(friendId, m.scene) : undefined,
  };
}


/**
 * What the renderer last said was true of this device, per chat.
 *
 * The facts are gathered in the interface — it is the only side that knows the
 * friend code, who is connected and how many servers there are — and handed
 * over when a chat is opened. They are kept here because a session is rebuilt
 * behind the user's back in three places (a sheet edit, a restart, a
 * regenerate), and a rebuild that forgot them would quietly turn the assistant
 * back into a character that knows nothing.
 *
 * In memory only, and dropped when the chat closes: this is a snapshot of the
 * user's own state, and it has no business outliving the conversation it was
 * gathered for.
 */
const contexts = new Map<string, string>();

/**
 * A duet — two characters talking to each other — is a whole-session activity:
 * it drives the one model context turn by turn, so only one can run, and the
 * only control from outside a run is to ask it to stop. Both live here because
 * the stop request arrives on a different IPC call than the run it cancels.
 */
let duetRunning = false;
let duetCancelled = false;

export function registerLocalAIHandlers(): void {
  // Give a first-time user a couple of ready-made characters.
  store.seedDefaultsOnce();

  // ...and recognise one seeded before the built-in flag existed.
  store.markBuiltinsOnce();

  // Presence and readiness. `available` is what the UI checks to decide whether
  // to show the feature at all; `status` reports whether the bundled assets are
  // actually there, so a broken package fails loudly rather than silently.
  ipcMain.handle("localai:available", () => true);
  ipcMain.handle("localai:status", () => ({
    modelPresent: llm.isModelPresent(),
    imageReady: false, // image generation removed to keep the app small
  }));

  ipcMain.handle("localai:list", () => store.list().map(friendForUi));

  ipcMain.handle("localai:create", (_e, input: { name: string; characterSheet: string; greeting?: string; pfp?: string; settings?: Partial<AIFriend["settings"]> }) => {
    const friend = store.create({
      name: input.name,
      characterSheet: input.characterSheet,
      greeting: input.greeting,
      settings: input.settings,
    });
    if (input.pfp) store.setPfp(friend.id, input.pfp);
    return friendForUi(store.get(friend.id)!);
  });

  ipcMain.handle("localai:update", async (_e, id: string, patch: { name?: string; characterSheet?: string; greeting?: string; settings?: Partial<AIFriend["settings"]> }) => {
    const before = store.get(id);
    const after = store.update(id, patch);
    if (!after) throw new Error("no such friend");

    // A changed sheet has to take effect now, not next launch — so if this chat
    // is the one currently loaded, rebuild its session around the new persona,
    // carrying the existing transcript across.
    if (
      patch.characterSheet !== undefined &&
      before?.characterSheet !== patch.characterSheet &&
      llm.activeId() === id
    ) {
      try {
        await llm.openChat(after, store.history(id), undefined, contexts.get(id));
      } catch (error) {
        log("[localai] failed to reopen after sheet edit:", String(error));
      }
    }
    return friendForUi(after);
  });

  ipcMain.handle("localai:setPfp", (_e, id: string, dataUrl: string) => {
    const f = store.setPfp(id, dataUrl);
    if (!f) throw new Error("no such friend");
    return friendForUi(f);
  });

  ipcMain.handle("localai:delete", async (_e, id: string) => {
    if (llm.activeId() === id) await llm.closeChat(id);
    store.remove(id);
    return true;
  });

  // Open a chat: load the model (streaming status back), then hand over the
  // transcript with avatars and scenes resolved.
  ipcMain.handle("localai:openChat", async (event, id: string, context?: string) => {
    const friend = store.get(id);
    if (!friend) throw new Error("no such friend");

    // Only the built-in assistant is told anything about the device. A roleplay
    // character has no use for a friend code and would only work it into a
    // story, which is a strange thing to read and a worse thing to have written
    // into a transcript.
    if (friend.builtin === "assistant" && context) contexts.set(id, context);
    else contexts.delete(id);

    seedGreetingIfEmpty(friend);
    const messages = store.history(id);
    await llm.openChat(friend, messages, (s) =>
      event.sender.send("localai:status", { id, ...s }),
      contexts.get(id),
    );

    return {
      friend: friendForUi(friend),
      messages: messages.map((m) => messageForUi(id, m)),
    };
  });

  /**
   * Pick the folder a character may use.
   *
   * The system dialog, and only the system dialog. A path typed into a text box
   * is a path the user has not necessarily looked at; a folder chosen here is
   * one they navigated to and picked, which is the difference between granting
   * access and being talked into it.
   */
  ipcMain.handle("localai:chooseFolder", async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose a folder this character may read and write",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths.length) return "";
    return result.filePaths[0];
  });

  ipcMain.handle("localai:closeChat", async (_e, id: string) => {
    contexts.delete(id);
    await llm.closeChat(id);
    return true;
  });

  // Send a message and stream the reply. Tokens go out on `localai:token`; when
  // image generation is on for this friend, a scene follows on `localai:scene`.
  ipcMain.handle("localai:send", async (event, id: string, text: string) => {
    const friend = store.get(id);
    if (!friend) throw new Error("no such friend");

    store.appendMessage(id, { role: "user", content: text });
    const assistant = store.appendMessage(id, { role: "assistant", content: "" });

    // The placeholder above is what the stream fills in. If generating throws,
    // it has to go: a blank assistant message left in the transcript is shown as
    // an empty bubble and, worse, is handed back to the model as history — so
    // one failure teaches it that saying nothing is a valid turn.
    const dropPlaceholder = () => {
      try {
        store.popAssistant(id);
      } catch {
        /* nothing to remove */
      }
    };

    // The streamed chunks and the stored reply are deliberately allowed to
    // differ. Chunks are raw, because they have to arrive as they are generated
    // for the typing to look live; what is *kept* is the tidied version, and the
    // `done` event carries it so the UI replaces what it drew. Storing the raw
    // text instead would feed the model's own leaks back to it as history.
    let full = "";
    let reply: string;
    try {
      reply = await llm.prompt(
        id,
        text,
        { temperature: friend.settings.temperature, maxTokens: friend.settings.maxTokens },
        (chunk) => {
          full += chunk;
          event.sender.send("localai:token", { id, msgId: assistant.id, chunk });
        },
        (s) => event.sender.send("localai:status", { id, ...s }),
        friend,
        (note, ok) => event.sender.send("localai:action", { id, note, ok }),
      );
    } catch (error) {
      dropPlaceholder();
      throw error;
    }

    const content = reply || full;
    store.setMessageContent(id, assistant.id, content);
    event.sender.send("localai:done", { id, msgId: assistant.id, content });

    return { id: assistant.id, content };
  });

  // Restart a chat: wipe every message (and scene) but keep the friend, then
  // reopen a fresh session so the next reply starts from a clean slate.
  ipcMain.handle("localai:clearChat", async (event, id: string) => {
    const friend = store.get(id);
    if (!friend) throw new Error("no such friend");
    store.clearHistory(id);
    seedGreetingIfEmpty(friend); // re-post the greeting for the fresh chat
    const messages = store.history(id);
    await llm.openChat(friend, messages, (s) =>
      event.sender.send("localai:status", { id, ...s }),
      contexts.get(id),
    );
    return { messages: messages.map((m) => messageForUi(id, m)) };
  });

  // Regenerate the last reply: drop it, then re-run the prompt that produced it.
  ipcMain.handle("localai:regenerate", async (event, id: string) => {
    const friend = store.get(id);
    if (!friend) throw new Error("no such friend");

    const messages = store.history(id);
    if (!messages.length) return { id: "", content: "" };

    store.popAssistant(id);
    const remaining = store.history(id);
    const lastUserIndex = remaining.map((m) => m.role).lastIndexOf("user");
    if (lastUserIndex < 0) return { id: "", content: "" };
    const lastUser = remaining[lastUserIndex];

    // Rebuild the session primed with everything *before* that last user
    // message, so the model answers it fresh rather than being anchored to the
    // reply we just dropped.
    await llm.openChat(
      friend,
      remaining.slice(0, lastUserIndex),
      undefined,
      contexts.get(id),
    );

    const assistant = store.appendMessage(id, { role: "assistant", content: "" });
    let full = "";
    let reply: string;
    try {
      reply = await llm.prompt(
        id,
        lastUser.content,
        { temperature: friend.settings.temperature, maxTokens: friend.settings.maxTokens },
        (chunk) => {
          full += chunk;
          event.sender.send("localai:token", { id, msgId: assistant.id, chunk });
        },
        (s) => event.sender.send("localai:status", { id, ...s }),
        friend,
        (note, ok) => event.sender.send("localai:action", { id, note, ok }),
      );
    } catch (error) {
      // Same reasoning as `send`: the empty placeholder must not survive a
      // failure, or the next regenerate is answering a blank turn.
      try {
        store.popAssistant(id);
      } catch {
        /* nothing to remove */
      }
      throw error;
    }
    const content = reply || full;
    store.setMessageContent(id, assistant.id, content);
    event.sender.send("localai:done", { id, msgId: assistant.id, content });
    return { id: assistant.id, content };
  });

  // ---- two characters talking to each other (an experiment) ----------------
  //
  // Alternate two characters through the one model, streaming each line as it
  // is generated. The turn-taking itself lives in `duet.ts` and is tested
  // there; here we give it the two things that touch the model — prime a
  // speaker with what it has heard, and generate one reply — plus the events
  // the interface draws from. Nothing is written to either character's real
  // transcript: a duet is a sandbox, not a conversation the user had.
  ipcMain.handle(
    "localai:duetStart",
    async (
      event,
      opts: { aId: string; bId: string; opener: string; exchanges: number },
    ) => {
      if (duetRunning) throw new Error("a conversation is already running");
      const a = store.get(opts.aId);
      const b = store.get(opts.bId);
      if (!a || !b) throw new Error("pick two characters that exist");
      if (!llm.isModelPresent()) throw new Error("the model is not installed");

      duetRunning = true;
      duetCancelled = false;
      const send = (channel: string, payload: unknown) =>
        event.sender.send(channel, payload);

      // The id of the bubble currently being filled. Set when a turn starts,
      // used by the token and message events so the UI streams into the right
      // place, exactly as `send` does for a normal chat.
      let msgId = "";

      try {
        const transcript = await duet.runDuet(
          {
            a: { id: a.id, name: a.name },
            b: { id: b.id, name: b.name },
            opener: opts.opener ?? "",
            exchanges: opts.exchanges,
          },
          {
            prime: async (speakerId, history) => {
              const f = store.get(speakerId);
              if (!f) throw new Error("that character was removed mid-run");
              await llm.openChat(f, history, (st) =>
                send("localai:duetStatus", { speakerId, ...st }),
              );
            },
            reply: (speakerId, incoming, onChunk) => {
              const f = store.get(speakerId)!;
              return llm.prompt(
                speakerId,
                incoming,
                {
                  temperature: f.settings.temperature,
                  maxTokens: f.settings.maxTokens,
                },
                onChunk,
                (st) => send("localai:duetStatus", { speakerId, ...st }),
                f,
                (note, ok) =>
                  send("localai:duetAction", { speakerId, note, ok }),
              );
            },
            cancelled: () => duetCancelled,
            onTurnStart: (speakerId, turn) => {
              msgId = `${speakerId}-${turn}-${Date.now()}`;
              send("localai:duetTurn", {
                msgId,
                turn,
                speakerId,
                name: store.get(speakerId)?.name ?? "",
              });
            },
            onChunk: (speakerId, turn, chunk) =>
              send("localai:duetToken", { msgId, turn, speakerId, chunk }),
            onMessage: (m) =>
              send("localai:duetMessage", {
                msgId,
                turn: m.turn,
                speakerId: m.speakerId,
                name: store.get(m.speakerId)?.name ?? "",
                content: m.content,
              }),
          },
        );

        send("localai:duetDone", {
          count: transcript.length,
          cancelled: duetCancelled,
        });
        return { count: transcript.length, cancelled: duetCancelled };
      } catch (error) {
        send("localai:duetError", { message: String(error) });
        throw error;
      } finally {
        duetRunning = false;
        // Free the model: the duet commandeered the one session, so leave a
        // clean slate for the next normal chat to open from.
        try {
          await llm.unloadModel();
        } catch {
          /* best effort */
        }
      }
    },
  );

  // Ask a running duet to stop. It ends after the line in flight finishes —
  // a generation already under way is not interrupted mid-sentence.
  ipcMain.handle("localai:duetStop", () => {
    duetCancelled = true;
    return true;
  });
}

/** Free the model on quit. */
export async function shutdownLocalAI(): Promise<void> {
  await llm.unloadModel();
}
