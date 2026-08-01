import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor, configured for an app that is its own network.
 */
const config: CapacitorConfig = {
  appId: "chat.reaper.app",
  appName: "Reaper",
  webDir: "dist",

  android: {
    // The WebView keeps its own background rather than flashing white
    // between launch and first paint — which on a dark interface reads as a
    // fault every single time the app opens.
    backgroundColor: "#0d0e12",
  },

  server: {
    // Served from the bundle, never from a network address. A `url` here
    // would be a remote origin with access to every plugin, including the
    // one holding the private key.
    androidScheme: "https",
  },

  plugins: {
    CapacitorHttp: {
      // Nothing in this app makes HTTP requests. Turning the interceptor off
      // keeps `fetch` from being patched under the interface.
      enabled: false,
    },
  },
};

export default config;
