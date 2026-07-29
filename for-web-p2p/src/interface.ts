/**
 * The desktop's interface, replaced at build time.
 *
 * There is deliberately nothing real in this file. `vite.config.ts` resolves
 * the specifier `./interface` before it ever reaches disk and hands over the
 * contents of `for-desktop-p2p/src/local-ui/index.html` instead — the same
 * file the desktop ships, not a copy of it.
 *
 * A stub rather than a `.d.ts` declaration, because a declaration for a
 * *relative* specifier is not something TypeScript can be made to believe: it
 * resolves `./interface` by looking for the file, and the honest way to have
 * the file exist for the type checker while the bundler substitutes it is to
 * write one.
 *
 * If this string ever reaches a browser, the build plugin did not run and the
 * page will say so rather than rendering nothing.
 */
export default "" as string;
