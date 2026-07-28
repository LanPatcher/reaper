/**
 * The scrypt worker, absent.
 *
 * Used only by the test builds. `?worker&inline` is a bundler instruction, and
 * the tests are compiled with esbuild, which knows nothing about it — so the
 * specifier is pointed here instead.
 *
 * The constructor throws, which is the honest answer: there is no worker in
 * Node. `crypto.ts` catches that and derives the key on the calling thread,
 * which is correct in a test runner where nothing is waiting to draw a frame,
 * and which is the same path a device takes if its worker cannot start.
 */
export default class MissingWorker {
  constructor() {
    throw new Error("no workers outside the app");
  }
}
