import { registerPlugin } from "@capacitor/core";

/**
 * One HTTPS GET over Tor, for link previews.
 *
 * The bridge normally registers the "Preview" plugin by name itself, so this
 * package exists mainly to carry the Android native module that `cap sync`
 * discovers. The registration is exported here too for anything that prefers to
 * import it directly.
 *
 * Redirects are not followed here — that is an allowlist decision the caller
 * makes — and only https is fetched. `socksPort` is Tor's loopback SOCKS port
 * from the Tor plugin's status; the connect is addressed by domain name so Tor,
 * not the device, resolves the host.
 */
export interface PreviewPlugin {
  httpGet(options: {
    url: string;
    socksPort: number;
    accept?: string;
    maxBytes?: number;
  }): Promise<{
    status: number;
    type?: string;
    location?: string;
    body: string;
    truncated: boolean;
  }>;
}

export const Preview = registerPlugin<PreviewPlugin>("Preview", {
  web: () => ({
    httpGet: async () => {
      throw new Error("link previews need the app, not a browser");
    },
  }),
});
