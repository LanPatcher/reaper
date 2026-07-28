/**
 * The scrypt worker, inlined at build time.
 *
 * `?worker&inline` asks the bundler to compile the worker and embed it as a
 * blob rather than emitting a second file. That is not a preference: this app
 * is served from a custom scheme inside a WebView, and a worker fetched from a
 * separate URL across that scheme fails to load — which is the same reason
 * `build.rollupOptions.output.inlineDynamicImports` is set. A blob has no URL
 * to get wrong.
 */
declare module "*?worker&inline" {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}

/**
 * A stylesheet as text.
 *
 * `?inline` gives the CSS as a string instead of injecting a `<style>` at load
 * time. `main.ts` needs that because it replaces the whole document head when
 * it swaps in the interface — an injected style is thrown away by that, which
 * is what removed the entire phone layout and made the sidebar, the window
 * controls and every touch target wrong at once.
 */
declare module "*.css?inline" {
  const css: string;
  export default css;
}
