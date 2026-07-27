import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor, configured for an app that is its own network.
 */
const config: CapacitorConfig = {
  appId: "chat.reaper.app",
  appName: "Reaper",
  webDir: "dist",

  ios: {
    // The WebView keeps its own background rather than flashing white between
    // launch image and first paint — which on a dark interface reads as a
    // fault every single time the app opens.
    backgroundColor: "#0d0e12",

    // Off. It scrolls the whole WebView when a list bounces, and the interface
    // has its own scrolling regions.
    scrollEnabled: false,

    // The whole point of this build is a peer-to-peer transport, and the
    // WebView is not the thing making the connections — the socket plugin is.
    // Left alone so nothing here quietly starts allowing plain HTTP.
    limitsNavigationsToAppBoundDomains: true,
  },

  server: {
    // Served from the bundle, never from a network address. A `url` here would
    // be a remote origin with access to every plugin, including the one
    // holding the private key.
    androidScheme: "https",
    iosScheme: "reaper",
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
