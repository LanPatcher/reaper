/**
 * `?raw` imports.
 *
 * Vite substitutes the file's contents as a string at build time. Declared
 * here because the main process's tsconfig doesn't pull in Vite's client
 * types, which is where this normally comes from.
 */
declare module "*.html?raw" {
  const contents: string;
  export default contents;
}
