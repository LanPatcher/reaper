import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

/**
 * Fetch the local-AI assets and stage them for packaging.
 *
 *   npm run vendor:models
 *
 * This mirrors `vendor-tor.mjs`: it fills `vendor/models` and `vendor/sd` so
 * Forge's `extraResource` can bundle them into the app. The decision was to
 * ship the model inside the installer, so it is fetched here at build time —
 * once, on the build machine — rather than by the app at runtime. The end user
 * never downloads anything and the feature never touches the network.
 *
 * The three assets:
 *   - the SLM (a ~2 GB GGUF),
 *   - SD-Turbo weights for the optional scene generator,
 *   - the `stable-diffusion.cpp` Windows binary.
 *
 * Every URL can be overridden with an environment variable, and anything
 * already present is left alone, so a build behind a mirror — or one where a
 * public URL has moved — is a matter of setting a variable or dropping the file
 * in by hand, not editing this script. Filenames must match the constants in
 * `src/local-ai/paths.ts`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, "..");
const modelsDir = join(project, "vendor", "models");
const sdDir = join(project, "vendor", "sd");

// Keep these in lockstep with src/local-ai/paths.ts.
// Qwen2.5-0.5B-Instruct Q8_0 is 531 MB — smaller than the 551 MB TinyLlama
// build it replaced, so the installer did not grow. The 1.5B at Q4_K_M (986 MB)
// was tried and pushed the installer over its limit; keep an eye on this number.
const LLM_FILE = "Qwen2.5-0.5B-Instruct-Q8_0.gguf";
const SD_MODEL_FILE = "sd_xl_turbo_1.0_fp16.safetensors";
const SD_VAE_FILE = "sdxl_vae.safetensors";
// stable-diffusion.cpp's Windows release ships the CLI as sd-cli.exe (alongside
// stable-diffusion.dll), not sd.exe — the executable was renamed upstream.
const SD_BIN_FILE = "sd-cli.exe";

// Old CPU-era SD 2.1 model, superseded by SDXL-Turbo. Remove it if present so a
// stale 2 GB file isn't packaged into resources alongside the new one.
const OLD_SD_MODEL_FILE = "sd-v2-1-turbo-q8_0.gguf";

// Apache-2.0, so it can be redistributed inside the installer. Qwen publishes
// its own GGUFs too (Qwen/Qwen2.5-0.5B-Instruct-GGUF) if this repository ever
// moves; the filenames there are lower-case, so LLM_FILE has to change with it.
const LLM_URL =
  process.env.REAPER_LLM_URL ??
  "https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q8_0.gguf?download=true";

// SDXL-Turbo (official, ungated). Strong prompt adherence, one/few-step 512px
// generation — fast on a GPU via the Vulkan sd-cli build below.
const SD_MODEL_URL =
  process.env.REAPER_SD_MODEL_URL ??
  "https://huggingface.co/stabilityai/sdxl-turbo/resolve/main/sd_xl_turbo_1.0_fp16.safetensors?download=true";

// The fp16-fixed SDXL VAE. SDXL in fp16 renders black images without it.
const SD_VAE_URL =
  process.env.REAPER_SD_VAE_URL ??
  "https://huggingface.co/madebyollin/sdxl-vae-fp16-fix/resolve/main/sdxl_vae.safetensors?download=true";

// A release zip of stable-diffusion.cpp that contains sd.exe and its DLLs.
// leejet tags releases with a commit hash, so there is no stable
// "latest/download/<fixed-name>" URL — resolveSdBinUrl() asks the GitHub API
// for the current AVX2 asset. REAPER_SD_BIN_URL overrides it entirely (e.g. to
// point at a CUDA/Vulkan build, or a local mirror). The pinned value is only a
// fallback for when the API is unreachable.
// The Vulkan (GPU) build — fast on any modern GPU. Falls back to this pinned
// asset if the GitHub API can't be reached.
const SD_BIN_URL_PINNED =
  "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-709-92a3b73/sd-master-92a3b73-bin-win-vulkan-x64.zip";

async function resolveSdBinUrl() {
  if (process.env.REAPER_SD_BIN_URL) return process.env.REAPER_SD_BIN_URL;
  try {
    const res = await fetch(
      "https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest",
      { headers: { "User-Agent": "reaper-build", Accept: "application/vnd.github+json" } },
    );
    if (res.ok) {
      const rel = await res.json();
      const asset = (rel.assets || []).find((a) => /bin-win-vulkan-x64\.zip$/i.test(a.name));
      if (asset?.browser_download_url) return asset.browser_download_url;
    }
  } catch {
    /* offline or rate-limited — fall back to the pinned URL */
  }
  return SD_BIN_URL_PINNED;
}

function human(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

async function download(url, target, label) {
  if (existsSync(target) && statSync(target).size > 1_000_000) {
    console.log(`  [=] ${label} already present (${human(statSync(target).size)})`);
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  console.log(`  [>] ${label}`);
  console.log(`      ${url}`);

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`${label}: HTTP ${response.status} ${response.statusText}`);
  }

  const tmp = `${target}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tmp));
  const { renameSync } = await import("node:fs");
  renameSync(tmp, target);
  console.log(`      -> ${target} (${human(statSync(target).size)})`);
}

/** Pull sd.exe out of a release zip, cross-platform. */
async function downloadSdBinary() {
  const target = join(sdDir, SD_BIN_FILE);
  if (existsSync(target) && statSync(target).size > 100_000) {
    console.log(`  [=] ${SD_BIN_FILE} already present (${human(statSync(target).size)})`);
    return;
  }

  mkdirSync(sdDir, { recursive: true });
  const zip = join(sdDir, "sd-bin.zip");
  const url = await resolveSdBinUrl();
  await download(url, zip, "stable-diffusion.cpp (zip)");

  console.log("  [*] extracting stable-diffusion.cpp ...");
  const ok =
    process.platform === "win32"
      ? spawnSync(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${sdDir}' -Force`,
          ],
          { stdio: "inherit" },
        ).status === 0
      : spawnSync("unzip", ["-o", zip, "-d", sdDir], { stdio: "inherit" }).status === 0;

  if (!ok) {
    throw new Error(
      `could not unzip ${zip}. Extract its contents by hand into ${sdDir}.`,
    );
  }

  const { readdirSync, renameSync } = await import("node:fs");

  // sd-cli.exe needs the DLLs shipped beside it (stable-diffusion.dll), so the
  // whole payload has to end up flat in sdDir — not just the exe. The zip
  // usually unpacks into a single subfolder; if so, hoist every file out of it.
  const found = findFile(sdDir, SD_BIN_FILE, readdirSync);
  if (!found) {
    throw new Error(`${SD_BIN_FILE} was not found after extracting ${zip}`);
  }
  const foundDir = dirname(found);
  if (foundDir !== sdDir) {
    for (const entry of readdirSync(foundDir)) {
      renameSync(join(foundDir, entry), join(sdDir, entry));
    }
    rmSync(foundDir, { recursive: true, force: true });
  }

  if (!existsSync(target)) {
    throw new Error(`${SD_BIN_FILE} was not found after extracting ${zip}`);
  }

  rmSync(zip, { force: true });
  console.log(`      -> ${target} (${human(statSync(target).size)}) + runtime DLLs`);
}

function findFile(root, name, readdirSync) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name, readdirSync);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return undefined;
}

async function main() {
  console.log("\n  Vendoring local-AI assets\n");

  // Image generation was removed to keep the app small enough to ship as an
  // installer, so no SD assets are fetched. Clean up anything an earlier build
  // left behind so it isn't packaged: the whole vendor/sd directory and any old
  // image model / VAE files sitting in vendor/models.
  try {
    rmSync(sdDir, { recursive: true, force: true });
  } catch {
    /* nothing there */
  }
  for (const stale of [SD_MODEL_FILE, SD_VAE_FILE, OLD_SD_MODEL_FILE]) {
    try {
      const p = join(modelsDir, stale);
      if (existsSync(p)) {
        rmSync(p, { force: true });
        console.log(`  [-] removed unused image asset ${stale}`);
      }
    } catch {
      /* leave it be */
    }
  }
  // Remove any other language model left from a previous build (e.g. a larger
  // quant) so two models aren't packaged and the installer doesn't blow past
  // its size limit.
  try {
    for (const f of readdirSync(modelsDir)) {
      if (f.toLowerCase().endsWith(".gguf") && f !== LLM_FILE) {
        rmSync(join(modelsDir, f), { force: true });
        console.log(`  [-] removed old model ${f}`);
      }
    }
  } catch {
    /* models dir may not exist yet */
  }

  // Only the language model is vendored now, and it is required.
  const jobs = [
    { required: true, run: () => download(LLM_URL, join(modelsDir, LLM_FILE), `language model (${LLM_FILE})`) },
  ];

  const required = [];
  const optional = [];
  for (const job of jobs) {
    try {
      await job.run();
    } catch (error) {
      (job.required ? required : optional).push(error.message);
      console.error(`  [X] ${error.message}`);
    }
  }

  console.log("");

  if (optional.length) {
    console.warn(
      "  [!] Optional image-generation assets were not fetched, so scene\n" +
        "      images will be unavailable in this build (the feature stays\n" +
        "      off and the toggle is disabled). To enable them, set\n" +
        "      REAPER_SD_MODEL_URL / REAPER_SD_VAE_URL / REAPER_SD_BIN_URL or\n" +
        "      drop the files into vendor/models and vendor/sd by hand, then\n" +
        "      re-run. Filenames must match src/local-ai/paths.ts:\n" +
        `      ${SD_MODEL_FILE}, ${SD_VAE_FILE}, ${SD_BIN_FILE}\n`,
    );
  }

  if (required.length) {
    console.error(
      "  The language model could not be fetched and it is required. The URL\n" +
        "  may have moved — set REAPER_LLM_URL or drop the file into\n" +
        `  vendor/models by hand (must be named ${LLM_FILE}), then re-run.\n`,
    );
    process.exit(1);
  }

  console.log("  Done. Present assets are packaged into resources/models and resources/sd.\n");
}

await main();
