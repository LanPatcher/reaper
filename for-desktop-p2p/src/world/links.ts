import { contextBridge, ipcRenderer } from "electron";

/**
 * `window.links` — previews for links in messages.
 *
 * There is exactly one call, and it deliberately does very little: the renderer
 * hands over a URL and gets back either a `data:` URL or a reason. It cannot
 * fetch anything itself — the page's CSP forbids every remote origin, which is
 * what stops a message from revealing a reader's IP address just by being
 * displayed — and it is not trusted to have decided the URL was acceptable
 * either. The main process re-checks it against the allowlist and fetches it
 * over Tor. See `src/native/links.ts` and `src/native/remote.ts`.
 */
contextBridge.exposeInMainWorld("links", {
  /**
   * Fetch a preview image over Tor.
   *
   * Never throws for an ordinary refusal or a network failure — those come back
   * as `{ ok: false, error }`, because both are common and neither is a fault
   * in the caller.
   */
  preview: (
    url: string,
  ): Promise<{ ok: boolean; dataUrl?: string; bytes?: number; error?: string }> =>
    ipcRenderer.invoke("links:preview", url),
});
