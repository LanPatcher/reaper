import { app } from "electron";

import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the bundled model files and the native image binary live, and where
 * this feature keeps its purely-local data.
 *
 * ## Bundled assets
 *
 * The model weights and the stable-diffusion binary are vendored at build time
 * (see `scripts/vendor-models.mjs`) and packaged by Forge exactly the way the
 * Tor daemon is: `extraResource: ["./vendor/models", "./vendor/sd"]` lands them
 * at `resources/models` and `resources/sd` in a packaged build, and they are
 * read straight out of `vendor/` during `npm start`. This mirrors the resolver
 * for Tor in `src/p2p/bridge.ts` so there is one convention on disk, not two.
 *
 * ## Local data
 *
 * Everything a friend is — its sheet, its avatar, every message, every scene —
 * lives under a directory of its own inside the OS user-data path, entirely
 * separate from the P2P event store. That separation is the whole privacy
 * guarantee of a "local" friend: nothing here is ever appended to the synced
 * event log, announced to a peer, or carried by a device link. It is a
 * different tree, not a flag on a shared one, so there is no code path by which
 * it could accidentally leave the machine.
 */

/**
 * The single SLM this feature ships.
 *
 * Qwen2.5-0.5B-Instruct at Q8_0: 531 MB, which is *smaller* than the
 * TinyLlama-1.1B build it replaced (551 MB), so the installer got no bigger.
 * The 1.5B at Q4_K_M was tried in between and pushed the installer past its
 * limit at 986 MB — hence a smaller model at a much lighter quantisation
 * rather than a bigger one squeezed harder.
 *
 * Fewer parameters and still a clear upgrade, because the parameter count was
 * never the main problem. TinyLlama was trained on a 2048-token window, so a
 * conversation fell out of its context after a few exchanges and it began
 * answering from nothing — which reads as a model that cannot follow the
 * thread, because it cannot. This one holds 32K, of which the app uses 8K.
 * Q8_0 is also near-lossless, where the old build was Q3: most of what made
 * TinyLlama incoherent was quantisation damage on top of the short window.
 *
 * If the installer budget ever grows by ~250 MB, Qwen2.5-1.5B-Instruct at
 * IQ3_M (777 MB) is the next rung up and needs no other change — same family,
 * same ChatML format.
 *
 * Swapping the model means changing three things together, and the last is the
 * one that is easy to forget: this filename, the URL in
 * `scripts/vendor-models.mjs`, and the prompt format in `./format.ts`. A model
 * given another model's turn markers does not fail loudly — see the note there.
 */
export const LLM_FILENAME = "Qwen2.5-0.5B-Instruct-Q8_0.gguf";

/** SDXL-Turbo weights for the optional scene generator. Much stronger prompt
 *  adherence than the old SD 2.1 model; meant for the Vulkan/GPU sd-cli build. */
export const SD_MODEL_FILENAME = "sd_xl_turbo_1.0_fp16.safetensors";

/** The fp16-fixed SDXL VAE. Without it, SDXL in fp16 renders black/garbled
 *  images, so it is passed to sd-cli via --vae when present. */
export const SD_VAE_FILENAME = "sdxl_vae.safetensors";

/** The stable-diffusion.cpp CLI. Windows is all v1 ships. Upstream renamed the
 * binary from sd.exe to sd-cli.exe (it ships beside stable-diffusion.dll). */
export const SD_BINARY = process.platform === "win32" ? "sd-cli.exe" : "sd-cli";

function resourceDir(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(app.getAppPath(), "vendor", name);
}

export function llmModelPath(): string {
  return join(resourceDir("models"), LLM_FILENAME);
}

export function sdModelPath(): string {
  return join(resourceDir("models"), SD_MODEL_FILENAME);
}

export function sdVaePath(): string {
  return join(resourceDir("models"), SD_VAE_FILENAME);
}

export function sdBinaryPath(): string {
  return join(resourceDir("sd"), SD_BINARY);
}

/** The feature's data root, created on first use. */
export function dataDir(): string {
  const dir = join(app.getPath("userData"), "local-ai");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function friendsFile(): string {
  return join(dataDir(), "friends.json");
}

export function chatsDir(): string {
  const dir = join(dataDir(), "chats");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function pfpDir(): string {
  const dir = join(dataDir(), "pfp");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function scenesDir(id: string): string {
  const dir = join(dataDir(), "scenes", id);
  mkdirSync(dir, { recursive: true });
  return dir;
}
