import { scrypt } from "@noble/hashes/scrypt.js";

/**
 * Key derivation, off the thread that draws.
 *
 * Scrypt at the parameters this app ships — N = 32768, r = 8 — is thirty-two
 * megabytes of allocation and tens of thousands of block-mixing rounds. In a
 * WebView that runs on the same thread as the interface, so for the whole of
 * it the app paints nothing, answers nothing, and looks to the system exactly
 * like an app that has stopped.
 *
 * The obvious fix is `scryptAsync`, and it is not one. It yields with an empty
 * `await`, which drains the microtask queue and returns to the same task —
 * timers do not run, frames are not drawn, and the thread is held just as
 * firmly as by the synchronous version. `crypto.test.ts` measures this: with
 * `scryptAsync`, a four-millisecond interval fires zero times across the whole
 * derivation.
 *
 * A worker is a real answer rather than a smaller version of the problem. The
 * work happens somewhere else entirely and the interface is free throughout.
 *
 * Deliberately tiny, and deliberately not sharing anything with the rest of
 * the shim: everything it needs arrives in the message, so there is no module
 * state to get wrong and nothing to initialise before it can answer.
 */

interface Request {
  id: number;
  passphrase: Uint8Array;
  salt: Uint8Array;
  keylen: number;
  N: number;
  r: number;
  p: number;
}

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, passphrase, salt, keylen, N, r, p } = event.data;

  try {
    const key = scrypt(passphrase, salt, { N, r, p, dkLen: keylen });

    // Transferred rather than copied. The key is small enough that it hardly
    // matters, and it costs nothing to be right about.
    (self as unknown as Worker).postMessage({ id, key }, [key.buffer]);
  } catch (error) {
    (self as unknown as Worker).postMessage({
      id,
      error: (error as Error).message,
    });
  }
};
