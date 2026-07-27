/**
 * The desktop interface, inlined at build time.
 *
 * Resolved by the `reaper-interface` plugin in `vite.config.ts`, which reads
 * `for-desktop-p2p/src/local-ui/index.html` and hands it over as a string.
 *
 * Inlined rather than fetched because the WebView loads from a custom scheme
 * with no origin to fetch relative to — and because a file that is part of the
 * bundle cannot go missing at runtime.
 */
declare module "./interface" {
  const html: string;
  export default html;
}
