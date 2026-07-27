import { Buffer } from "buffer";

/**
 * `node:zlib`, or the two functions of it this needs.
 *
 * ## Why it has to be Brotli specifically
 *
 * Compression here is not an implementation detail that each device may choose
 * for itself — it is part of two formats that have to agree:
 *
 *   - **The wire.** A frame carries a `FLAG_COMPRESSED` bit and, when it is
 *     set, Brotli follows. A desktop peer sets that bit on anything over 256
 *     bytes, so a phone that cannot decompress Brotli cannot read most of what
 *     it is sent. It would connect, reconcile, and receive nothing legible.
 *   - **The log.** Every frame on disk is Brotli inside AES-GCM. A phone that
 *     wrote its log some other way would produce something the desktop build
 *     cannot open, which matters the moment an identity is exported.
 *
 * Safari has `CompressionStream`, which does gzip and deflate and not Brotli,
 * and is a stream API where the callers are synchronous. So neither half of
 * that is usable.
 *
 * ## WebAssembly, loaded once
 *
 * `brotli-wasm` is the reference implementation compiled to WebAssembly. It is
 * about 400 KB and it is exact — the same encoder the desktop uses, so a frame
 * written on a phone is byte-identical to one written on a laptop.
 *
 * Instantiating WebAssembly is asynchronous and everything above this is not,
 * so it is loaded once at startup and used synchronously afterwards. `ready()`
 * has to have resolved before the first event is written; `boot.ts` awaits it
 * before anything else starts, and the accessors throw rather than silently
 * returning uncompressed data if that order is ever broken.
 */

interface BrotliModule {
  compress(input: Uint8Array, options?: { quality?: number }): Uint8Array;
  decompress(input: Uint8Array): Uint8Array;
}

let brotli: BrotliModule | undefined;
let loading: Promise<void> | undefined;

/**
 * Load the WebAssembly module.
 *
 * Idempotent, and safe to call from several places: the promise is kept, so
 * twenty callers during startup produce one instantiation.
 *
 * `loader` exists for the tests. `brotli-wasm` ships three entry points around
 * one WebAssembly binary — the browser one fetches the `.wasm` over HTTP, which
 * is correct in a WebView and impossible under Node — so the tests hand in the
 * Node entry point instead. It changes how the binary is obtained and nothing
 * about what it computes, which is what those tests are checking.
 */
export function ready(loader?: () => Promise<BrotliModule>): Promise<void> {
  if (brotli) return Promise.resolve();

  loading ??= (loader
    ? loader()
    : import("brotli-wasm").then(
        (module) => module.default as unknown as Promise<BrotliModule>,
      )
  ).then((instance) => {
    brotli = instance;
  });

  return loading;
}

/** Whether compression is available yet. */
export function isReady(): boolean {
  return !!brotli;
}

function module(): BrotliModule {
  if (!brotli) {
    // Deliberately loud. The alternative — falling back to storing things
    // uncompressed — would write frames that claim to be Brotli and are not,
    // and the corruption would only surface later, on another device.
    throw new Error(
      "brotli was used before it finished loading; await ready() during startup",
    );
  }
  return brotli;
}

/**
 * Node's options object, translated.
 *
 * The desktop passes `params` keyed by numeric constants — quality, size hint,
 * mode. Only quality changes the output in a way that matters, and Brotli is
 * self-describing on the way back, so a frame compressed at a different quality
 * still decompresses correctly. The rest is dropped rather than faked.
 */
export interface ZlibOptions {
  params?: Record<number, number>;
}

export const constants = {
  BROTLI_PARAM_QUALITY: 1,
  BROTLI_PARAM_SIZE_HINT: 2,
  BROTLI_PARAM_MODE: 3,
  BROTLI_MODE_TEXT: 1,
  BROTLI_MODE_GENERIC: 0,
} as const;

export function brotliCompressSync(
  input: Buffer | Uint8Array,
  options?: ZlibOptions,
): Buffer {
  const quality = options?.params?.[constants.BROTLI_PARAM_QUALITY];

  return Buffer.from(
    module().compress(
      new Uint8Array(input),
      quality === undefined ? undefined : { quality },
    ),
  );
}

export function brotliDecompressSync(input: Buffer | Uint8Array): Buffer {
  return Buffer.from(module().decompress(new Uint8Array(input)));
}
