/**
 * `node:os`, reduced to the one thing the core asks it for.
 *
 * `bridge.ts` calls `hostname()` to give this install a default name — the
 * label that appears in "signed in on ___" on your other devices. A phone has
 * no hostname a WebView can read, so this answers with something a person
 * would recognise instead of with an empty string.
 *
 * Deliberately not "unknown". That name ends up in a sentence shown to the
 * user, and "signed in on unknown" reads like a fault rather than like a
 * device that has simply not been named yet.
 */

export function hostname(): string {
  return "iPhone";
}

export function platform(): string {
  return "ios";
}

export function tmpdir(): string {
  return "/tmp";
}

export function homedir(): string {
  return "/data";
}

export const EOL = "\n";

export default { hostname, platform, tmpdir, homedir, EOL };
