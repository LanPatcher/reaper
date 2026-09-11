import { log } from "./diagnostics";
import { hostIsTrusted, parseSafeUrl } from "./links";
import { torGet } from "./torFetch";

/**
 * Fetch a preview image, through Tor, for the renderer to show.
 *
 * ## Why this exists at all
 *
 * The renderer is not allowed to fetch anything: its CSP is `default-src
 * 'none'`. That is not caution, it is the product — a remote image in a message
 * would be loaded by Chromium over the ordinary network, so sending somebody a
 * link to a host you control would tell you their real IP the moment the
 * message drew on their screen. No allowlist fixes that, because the leak is in
 * the fetch, not in the destination.
 *
 * So the fetch happens here, over the same Tor circuit everything else uses,
 * and the bytes come back as a `data:` URL — which the CSP already permits.
 * The reader's address is never exposed, and the host learns only that some Tor
 * exit asked for a file.
 *
 * ## What it will not do
 *
 * The renderer is not trusted to have checked anything. Every URL is re-parsed
 * and re-checked against the allowlist here, redirects are followed only to
 * hosts that pass the same test, only images are accepted, and the response is
 * abandoned the moment it grows past `MAX_BYTES`. A caller asking for anything
 * else gets an error, not bytes.
 */

/** Enough for a photograph, far short of enough to hurt. */
const MAX_BYTES = 8 * 1024 * 1024;

/** Redirects are common on image CDNs, and a chain is a way to hide a target. */
const MAX_REDIRECTS = 3;

const ALLOWED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
];

export interface PreviewResult {
  ok: boolean;
  /** `data:image/png;base64,...`, ready to put straight into an `img`. */
  dataUrl?: string;
  bytes?: number;
  error?: string;
}

/**
 * Fetch `href` if — and only if — it is an image on a host we already trust.
 *
 * Every check is repeated on every hop. A redirect is the server choosing where
 * this goes next, so it is exactly as untrusted as the original message was.
 */
export async function fetchPreview(href: string): Promise<PreviewResult> {
  let target = href;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const link = parseSafeUrl(target);
    if (!link || !link.trusted || !hostIsTrusted(link.host)) {
      return { ok: false, error: "that link is not one this app will fetch" };
    }

    let response;
    try {
      response = await torGet(link.href, {
        accept: "image/*",
        maxBytes: MAX_BYTES,
      });
    } catch (error) {
      const message = (error as Error).message || String(error);
      log("[preview]", link.host, "failed:", message);
      // Named plainly, because the usual cause is real and worth knowing: a
      // good many CDNs refuse Tor exits outright.
      return {
        ok: false,
        error: `could not reach ${link.host} over Tor (${message})`,
      };
    }

    if (response.status >= 300 && response.status < 400 && response.location) {
      target = new URL(response.location, link.href).toString();
      continue;
    }

    if (response.status !== 200) {
      return {
        ok: false,
        error: `${link.host} answered ${response.status}`,
      };
    }

    const type = (response.type || "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.includes(type)) {
      return { ok: false, error: `that is not an image (${type || "unknown"})` };
    }

    // A half-read image is a broken image, so a read that stopped at the cap
    // is reported as too large rather than shown as corruption.
    if (response.truncated || response.body.length > MAX_BYTES) {
      return { ok: false, error: "that image is too large to show" };
    }

    log("[preview]", link.host, `${response.body.length} bytes over Tor`);

    return {
      ok: true,
      bytes: response.body.length,
      dataUrl: `data:${type};base64,${response.body.toString("base64")}`,
    };
  }

  return { ok: false, error: "too many redirects" };
}
