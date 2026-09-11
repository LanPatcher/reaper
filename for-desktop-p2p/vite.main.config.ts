import { defineConfig } from "vite";

// https://vitejs.dev/config
//
// `node-llama-cpp` is a native, ESM-only module loaded lazily with `import()`
// in the main process. It must stay external — bundling it would sever it from
// the platform `.node` binaries it resolves at runtime — so it is marked
// external here (alongside its scoped platform packages) rather than pulled
// into the main bundle. Everything else keeps Forge's defaults.
export default defineConfig({
  build: {
    rollupOptions: {
      external: [/^node-llama-cpp$/, /^@node-llama-cpp\//],
    },
  },
});
