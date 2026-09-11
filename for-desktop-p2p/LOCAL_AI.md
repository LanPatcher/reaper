# Local AI characters (Windows) — setup & notes

A "friend" that is a small language model running entirely on this machine.
Nothing goes online or to peers, and nothing syncs to your other devices — it is
stored outside the P2P event log on purpose, in a different tree rather than
behind a flag on a shared one. Optional per-chat extra: text-to-speech, off by
default. Windows-only for now; other platforms hide the feature.

## The pieces

    src/local-ai/format.ts   the model's prompt format and sampling values
    src/local-ai/paths.ts    where the weights live, and this feature's data
    src/local-ai/store.ts    characters and transcripts, as plain JSON
    src/local-ai/llm.ts      loading, prompting, and tidying a reply
    src/local-ai/bridge.ts   the ipcMain surface  ->  src/world/localai.ts
    src/local-ai/prompt.test.ts  what the model is actually handed
    scripts/vendor-models.mjs    fetches the weights at build time

The interface lives in `src/local-ui/index.html`: characters appear in the
Direct messages list beside real friends with an **AI** tag, and are created
from the **AI character** tab of *Add a friend*.

## The model

**Qwen2.5-0.5B-Instruct, Q8_0** — 531 MB, Apache-2.0, 32K context.

It replaced TinyLlama-1.1B (551 MB), so the installer got no bigger — it is in
fact 20 MB smaller. Qwen2.5-1.5B at Q4_K_M was tried in between and pushed the
installer past its limit at 986 MB, which is why this is a smaller model at a
much lighter quantisation rather than a bigger one squeezed harder.

Fewer parameters and still a clear upgrade, because the parameter count was
never the main problem:

- TinyLlama was trained on a **2048-token** window, so a conversation fell out
  of its context after a few exchanges and it began answering from nothing.
  This holds 32K; the app uses 8K (`min(8192, trainContextSize)`).
- The old build was **Q3**, this one is **Q8_0** — near-lossless. A good part of
  what made TinyLlama incoherent was quantisation damage on top of the short
  window.
- Qwen2.5-Instruct follows instructions far more reliably than TinyLlama-Chat at
  any size, which is what keeps a character in character.

If the installer budget ever grows by ~250 MB, **Qwen2.5-1.5B-Instruct IQ3_M**
(777 MB) is the next rung and needs no other change — same family, same ChatML
format, so only the filename and URL move.

**Swapping the model means changing three things together**, and the last is the
one that is easy to forget:

1. `LLM_FILENAME` in `src/local-ai/paths.ts`
2. `LLM_FILE` and `LLM_URL` in `scripts/vendor-models.mjs`
3. the prompt format in `src/local-ai/format.ts`

A model handed another model's turn markers does not fail loudly — it drifts,
or goes silent. `prompt.test.ts` checks the prompt byte-for-byte against the
format the vendor documents, so get it wrong and the suite says so.

## One-time developer setup

1. Install the dependency. pnpm blocks native build scripts by default; the
   `pnpm.onlyBuiltDependencies` entry in package.json allows node-llama-cpp, but
   you may still need to approve it:

       pnpm install
       pnpm approve-builds        # if prompted, allow node-llama-cpp

2. Fetch the weights (~1 GB, once, on the build machine). They land in
   `vendor/models`, which is gitignored:

       pnpm run vendor:models

   The model is **required** — a fetch failure fails the build. Any other
   `.gguf` left in `vendor/models` from a previous build is deleted, so two
   models are never packaged at once. If the URL has moved, set `REAPER_LLM_URL`
   or drop the file in by hand; the name must match `LLM_FILENAME`:

       vendor/models/Qwen2.5-0.5B-Instruct-Q8_0.gguf

3. Run or build as normal — `vendor:models` is chained into `make`/`package`:

       pnpm start          # dev, reads straight out of vendor/models
       build.bat           # or build-all.bat desktop

   `pnpm start` after a model swap still needs `pnpm run vendor:models` first,
   or the app will correctly report that the model is not installed.

## How it behaves

- A character's row in Direct messages opens its chat. The model loads on open
  and unloads on leave, so an idle character costs nothing — watch RAM in Task
  Manager to confirm. The first open shows "Waking up…".
- The gear edits the character sheet, greeting and picture mid-conversation; the
  session is rebuilt so the next reply reflects the change. The trash icon
  deletes the character and its whole history.
- A character's opening greeting is folded into the system prompt rather than
  seeded as history, because the model's history has to begin with a user turn.
  Dropping it instead — which is what used to happen — left the model answering
  the first thing anybody said with no idea a scene had been set.
- The built-in **Reaper Assistant** is marked `builtin: "assistant"` in
  `friends.json` and is the only character handed live facts about the device:
  the user's friend code, ID, address, peer count and so on, gathered by
  `aiUserContext()` in the renderer when the chat opens. A roleplay character
  has no use for a friend code and would only work it into a story.
- Replies are tidied before they are stored (`cleanReply`): a leaked turn
  marker, a "Name:" script prefix, a recited character sheet. What is stored is
  fed back as history, so a leak left in the transcript compounds.
- An empty reply is treated as a fault rather than a message — it surfaces an
  error and removes the placeholder instead of leaving a blank bubble.

## Web and folder access

Off for every character until somebody turns them on, per character, under
**Web and folder access** in the character's settings.

- **Web** — the character can `SEARCH` and `FETCH`. Everything goes over Tor via
  `src/native/torFetch.ts`, the one place in the app that pulls bytes off the
  open web, so no site learns the user's address.
- **Folder** — one folder chosen in the system picker, which the character can
  `LIST`, `READ` and `WRITE`. Text files only. Nothing outside it is reachable:
  `..`, absolute paths and symlinks are all resolved and checked against the
  real root before anything opens. Every overwrite copies the previous version
  into `.reaper-backups` first, because a 0.5B model misreading an instruction
  is an ordinary event and must not be able to destroy work.

Tools are a line-based protocol parsed in `agent.ts`, not JSON function calls.
A 0.5B model cannot reliably emit well-formed JSON inside a wrapper format, and
one missing brace turns a tool call into a paragraph about tool calls. What it
can do reliably is start a line with a word.

The loop runs at most four rounds; every action is reported to the interface and
drawn in the transcript, so nothing happens that the user cannot see.

**The risk, stated plainly.** With both switched on these compose: a page the
character reads is untrusted text, and if it contains instructions the model
follows, it can be told to read a file and put what it found into the next
address it fetches. Nothing here prevents that in general — a model that can
both read your files and choose a URL has a channel out, and that is what
"browse freely" means. What the code does instead is bound the damage
(containment, backups, caps) and make it visible (the action lines). The
interface says so when both are on.

## Verify

1. Create a character, open it — "Waking up…", then replies stream in.
2. Leave the chat; RAM drops as the model unloads.
3. Hold a conversation of a dozen turns and check it still refers back to what
   was said early on. This is the thing the model was changed for.
4. Ask the Reaper Assistant for your friend code; it should quote the exact
   string from *Add a friend*.
5. Edit the sheet mid-chat → the next reply changes. Delete → character and
   files gone from `%APPDATA%/Reaper/local-ai`.
6. Privacy: with a second paired device online, confirm no new community or
   events appear and nothing about the character syncs.

## Things to check on Windows

- `node-llama-cpp`'s native load in a packaged build. It is a dependency
  (external in `vite.main.config.ts`) and `AutoUnpackNativesPlugin` is wired in
  `forge.config.ts` so the `.node` binaries unpack from the asar. If a packaged
  build cannot find the runtime, that is where to look.
- The log is the fastest way in: `%APPDATA%/Reaper/reaper.log`, and
  `[startup] packaged=` tells you whether you are running the build you think
  you are. A stale install is indistinguishable from a code bug from the outside.
