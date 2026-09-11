import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";

import { log } from "../native/diagnostics";
import { sdBinaryPath, sdModelPath, sdVaePath } from "./paths";

/**
 * Optional scene images, via a vendored `stable-diffusion.cpp` binary.
 *
 * Off by default and for good reason: an SD-Turbo image is a second or two on a
 * capable GPU and the better part of a minute on CPU. The binary is spawned as
 * a child process — the same "vendor a native tool and shell out to it" pattern
 * the app already uses for Tor — so a long or wedged render can never block the
 * main event loop or the model.
 *
 * Requests are serialised. Two SD runs at once would fight over the same VRAM
 * and be slower than doing them in turn, and a chat only ever needs the newest
 * scene anyway.
 */

let queue: Promise<unknown> = Promise.resolve();

/** Whether both the binary and the weights are present. */
export function isImageReady(): boolean {
  try {
    return existsSync(sdBinaryPath()) && existsSync(sdModelPath());
  } catch {
    return false;
  }
}

export interface GenerateOptions {
  steps?: number;
  width?: number;
  height?: number;
  negative?: string;
  /** CPU threads. Defaults to all cores — the single biggest speed lever on a
   *  CPU-only build, since sd-cli otherwise leaves most of the machine idle. */
  threads?: number;
}

export function generate(prompt: string, opts?: GenerateOptions): Promise<Buffer> {
  const run = () => runOnce(prompt, opts);
  // Chain onto the queue whether the previous job resolved or rejected, so one
  // failed render does not stall every one after it.
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

function runOnce(prompt: string, opts?: GenerateOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!isImageReady()) {
      reject(new Error("the image model or binary is not installed"));
      return;
    }

    const out = join(tmpdir(), `reaper-scene-${randomUUID()}.png`);
    const threads = Math.max(1, opts?.threads ?? cpus().length);

    // SD-Turbo is a distilled, few-step model: cfg-scale 1 and a handful of
    // steps is the whole point of it. Euler is the sampler it was trained for.
    // `--threads` is set explicitly to use the whole CPU — without it sd-cli is
    // far slower than the machine is capable of.
    const args = [
      "-m",
      sdModelPath(),
      "-p",
      prompt,
      "-o",
      out,
      "--steps",
      String(opts?.steps ?? 2),
      "--cfg-scale",
      "1",
      "-H",
      String(opts?.height ?? 512),
      "-W",
      String(opts?.width ?? 512),
      "--sampling-method",
      "euler",
      "--threads",
      String(threads),
    ];
    // SDXL in fp16 needs the fixed VAE or it outputs black images.
    const vae = sdVaePath();
    if (existsSync(vae)) args.push("--vae", vae);
    if (opts?.negative) args.push("-n", opts.negative);

    let stderr = "";
    const child = spawn(sdBinaryPath(), args, { windowsHide: true });

    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (error) => {
      log("[localai] sd spawn failed:", String(error));
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0 || !existsSync(out)) {
        reject(new Error(`image generation failed (exit ${code}): ${stderr.slice(-300)}`));
        return;
      }
      try {
        const buf = readFileSync(out);
        rmSync(out, { force: true });
        resolve(buf);
      } catch (error) {
        reject(error as Error);
      }
    });
  });
}
