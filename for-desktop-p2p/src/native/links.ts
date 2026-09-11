/**
 * Which links may be shown, and how a URL is read safely.
 *
 * ## Why an allowlist rather than a blocklist
 *
 * A message is written by somebody else. Rendering a link puts their text on
 * this screen, and rendering its *content* fetches whatever they name — so the
 * question is never "is this URL bad" but "do I already know what this host
 * serves". A blocklist answers the first question and is wrong the moment
 * somebody registers a new domain. This answers the second, and is wrong only
 * in the safe direction: an unknown host is shown as a plain link, and nothing
 * is fetched.
 *
 * ## Why the renderer cannot simply fetch it
 *
 * The page's CSP is `default-src 'none'`, deliberately: a remote image in a
 * message would be fetched by Chromium over the ordinary network, so anybody
 * could learn a reader's real IP by sending them a message linking to a host
 * they control — and it would happen on render, before the reader did
 * anything. That is the exact thing this app exists to prevent.
 *
 * So previews are fetched in the main process, through Tor, and handed back as
 * a `data:` URL, which the CSP already allows. See `fetchPreview` in
 * `./remote.ts`. This module is the part both sides agree on, and is
 * deliberately free of imports so the renderer's copy can be checked against it
 * (`src/local-ui/links.test.ts`).
 */

/**
 * Hosts whose content may be shown inline.
 *
 * Matched on a label boundary — `youtube.com` matches `www.youtube.com` and
 * never `youtube.com.example.net`. Kept flat and alphabetical so a diff is
 * obvious in review, because adding a line here is a security decision.
 */
export const TRUSTED_HOSTS: readonly string[] = [
  "cdn.discordapp.com",
  "encrypted-tbn0.gstatic.com",
  "i.imgur.com",
  "i.redd.it",
  "i.ytimg.com",
  "lh3.googleusercontent.com",
  "media.discordapp.net",
  "media.tenor.com",
  "upload.wikimedia.org",
  "youtu.be",
  "youtube.com",
];

/** What a host is called when it is named to the reader. */
export const TRUSTED_NAMES: Readonly<Record<string, string>> = {
  "cdn.discordapp.com": "Discord",
  "encrypted-tbn0.gstatic.com": "Google",
  "i.imgur.com": "Imgur",
  "i.redd.it": "Reddit",
  "i.ytimg.com": "YouTube",
  "lh3.googleusercontent.com": "Google",
  "media.discordapp.net": "Discord",
  "media.tenor.com": "Tenor",
  "upload.wikimedia.org": "Wikimedia",
  "youtu.be": "YouTube",
  "youtube.com": "YouTube",
};

/**
 * Characters that make displayed text disagree with what it says.
 *
 * Control characters, the bidirectional overrides and isolates, and the
 * invisible spaces and joiners. A right-to-left override inside a hostname
 * reverses what the eye reads while the bytes stay as they are; a zero-width
 * space inside "youtube.com" is a different string that draws identically.
 *
 * Spelled as escapes rather than as the characters themselves. A source file
 * containing them is subject to the very trick this is here to catch, and a
 * reviewer cannot see what they are looking at.
 */
export const DECEPTIVE = new RegExp(
  "[" +
    "\\u0000-\\u001F\\u007F-\\u009F" + // C0 and C1 controls
    "\\u00AD" + // soft hyphen
    "\\u200B-\\u200F" + // zero-width set, LRM, RLM
    "\\u202A-\\u202E" + // bidi embedding and override
    "\\u2060-\\u2064" + // word joiner, invisible operators
    "\\u2066-\\u2069" + // bidi isolates
    "\\uFEFF" + // zero-width no-break space
    "]",
);

export interface SafeUrl {
  /** The URL, re-serialised from the parse rather than echoed back. */
  href: string;
  host: string;
  path: string;
  /** True only for a host on the list above, over https, with no surprises. */
  trusted: boolean;
  /** Who serves it, when trusted. */
  name?: string;
}

/**
 * Whether `host` is `domain` or a subdomain of it.
 *
 * The label boundary is the whole point. `endsWith(domain)` alone calls
 * `notyoutube.com` a match, and a substring test calls `youtube.com.evil.net`
 * one — both are how a link that reads as familiar goes somewhere else.
 */
export function hostMatches(host: string, domain: string): boolean {
  if (host === domain) return true;
  return host.endsWith("." + domain);
}

export function hostIsTrusted(host: string): boolean {
  return TRUSTED_HOSTS.some((domain) => hostMatches(host, domain));
}

function trustedNameFor(host: string): string | undefined {
  const domain = TRUSTED_HOSTS.find((d) => hostMatches(host, d));
  return domain ? TRUSTED_NAMES[domain] : undefined;
}

/**
 * Read a URL, or refuse it.
 *
 * Everything here rejects a URL that would *display* as one thing and *go* to
 * another. In order: text that cannot be trusted to render as it reads; a
 * scheme that is not the web; credentials before the host, so that
 * `https://youtube.com@evil.example/` goes to evil.example while reading as
 * YouTube; and a hostname that is not plain ASCII, which is how "apple.com"
 * with a Cyrillic first letter is a different domain that draws identically.
 *
 * A refusal is not a judgement about the destination. It only means the link
 * cannot be shown as itself, so it stays the plain text it arrived as.
 */
export function parseSafeUrl(raw: string): SafeUrl | null {
  if (!raw || DECEPTIVE.test(raw)) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;

  const host = url.hostname.toLowerCase();

  // Punycode, or anything that is not a plain hostname. `new URL` has already
  // encoded a Unicode domain to "xn--...", so this catches the homograph after
  // the conversion rather than trying to spot it beforehand.
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  if (host.startsWith("xn--") || host.includes(".xn--")) return null;

  // Only the default port, and only over https. A familiar name on an odd port
  // is not the service that name refers to.
  const trusted = url.protocol === "https:" && !url.port && hostIsTrusted(host);

  return {
    href: url.toString(),
    host,
    path: url.pathname + url.search,
    trusted,
    name: trusted ? trustedNameFor(host) : undefined,
  };
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

/** The video id in a YouTube link, if it is one. */
export function youTubeId(link: SafeUrl): string | null {
  const ok = (v: string | null | undefined) =>
    v && /^[A-Za-z0-9_-]{11}$/.test(v) ? v : null;

  if (hostMatches(link.host, "youtu.be")) {
    return ok(link.path.split("?")[0].replace(/^\//, ""));
  }

  if (hostMatches(link.host, "youtube.com")) {
    const [pathname, query = ""] = link.path.split("?");
    if (pathname === "/watch") return ok(new URLSearchParams(query).get("v"));
    if (pathname.startsWith("/embed/")) return ok(pathname.slice(7).split("/")[0]);
    if (pathname.startsWith("/shorts/")) return ok(pathname.slice(8).split("/")[0]);
  }

  return null;
}

/**
 * The picture that stands for a link, if there is one.
 *
 * A YouTube page cannot be shown — an iframe is a remote origin, which the CSP
 * refuses and which would leak an IP anyway — but its thumbnail is an ordinary
 * image on a host already on the list, so that is what is shown. Everything
 * else is only ever its own bytes.
 *
 * Returns a URL to fetch, never content. Nothing here touches the network.
 */
export function previewFor(link: SafeUrl): string | null {
  if (!link.trusted) return null;

  const id = youTubeId(link);
  if (id) return "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg";

  // The query is dropped before the extension test on purpose: Discord signs
  // its attachment URLs, and the signature is not part of the file name.
  const path = link.path.split("?")[0];
  if (IMAGE_EXT.test(path)) return link.href;

  return null;
}
