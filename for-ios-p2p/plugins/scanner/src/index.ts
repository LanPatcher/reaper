import { registerPlugin } from "@capacitor/core";

/**
 * A QR reader, using the camera and the system's own detector.
 *
 * Native rather than a JavaScript decoder over `getUserMedia`, and that is the
 * smaller choice as well as the better one: `AVCaptureMetadataOutput` is about
 * eighty lines of Swift and is what every other app on the device uses, while
 * a JS decoder means bundling an image-processing library and hand-rolling the
 * frame loop, the focus behaviour and the orientation handling.
 *
 * It exists for one thing — pairing two of your own devices. A desktop shows
 * its sync address as a code; typing sixty-two base32 characters on a phone
 * without a mistake is not a reasonable thing to ask of anyone.
 */

export interface ScannerPlugin {
  /**
   * Open the camera and resolve with the first code seen.
   *
   * Resolves with `null` when the user backs out, which is an ordinary outcome
   * and not an error — a rejection there would have every call site writing a
   * `catch` that has to work out whether anything actually went wrong.
   *
   * Rejects if there is no camera or permission was refused, which are things
   * worth telling somebody about.
   */
  scan(): Promise<{ text: string | null }>;
}

export const Scanner = registerPlugin<ScannerPlugin>("Scanner", {
  // A browser has no camera bridge, and pretending otherwise would make the
  // dev server behave in a way the device never will.
  web: () => ({
    scan: async () => {
      throw new Error("scanning needs the app, not a browser");
    },
  }),
});
