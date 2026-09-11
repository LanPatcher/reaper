import { ipcMain } from "electron";

import { fetchPreview } from "./remote";

/**
 * The IPC surface for link previews: one call, one answer.
 *
 * Narrow on purpose. This is the only route by which anything a peer wrote can
 * cause a network request, so the smaller it is the less there is to get wrong.
 * Nothing the renderer sends is trusted — `fetchPreview` re-parses the URL and
 * re-checks it against the allowlist before it opens a circuit.
 */
export function registerLinkHandlers(): void {
  ipcMain.handle("links:preview", async (_e, url: string) => {
    if (typeof url !== "string" || url.length > 2048) {
      return { ok: false, error: "that is not a link" };
    }

    try {
      return await fetchPreview(url);
    } catch (error) {
      // A failure here is ordinary — an exit that refuses, a host that is down.
      // It is reported rather than thrown, because a rejected invoke in the
      // renderer is an exception in the middle of drawing a message.
      return { ok: false, error: (error as Error).message || String(error) };
    }
  });
}
