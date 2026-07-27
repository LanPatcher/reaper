import { MakerAppX } from "@electron-forge/maker-appx";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerFlatpak } from "@electron-forge/maker-flatpak";
import { MakerFlatpakOptionsConfig } from "@electron-forge/maker-flatpak/dist/Config";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { PublisherGithub } from "@electron-forge/publisher-github";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

import { existsSync } from "node:fs";

// import { globSync } from "node:fs";

/**
 * The built web client, if it has been copied in.
 *
 * electron-packager fails outright on a missing extraResource path, so this is
 * conditional: packaging without a bundle still succeeds and the app falls
 * back to a remote client at runtime. build.bat always populates it.
 */
const CLIENT_DIST = "./client-dist";

/**
 * The Tor daemon, vendored by `npm run vendor:tor`.
 *
 * Not optional in the way the client bundle is: every connection this app
 * makes goes through Tor, and all direct-address paths were removed on
 * purpose. A build without it packages successfully and then cannot reach a
 * single peer, so the absence is called out loudly at package time rather
 * than discovered later.
 */
const TOR_DIR = "./vendor/tor";

if (!existsSync(TOR_DIR)) {
  console.warn(
    "\n  [!] vendor/tor is missing — the packaged app will not be able to\n" +
      "      connect to anything. Run:  npm run vendor:tor\n",
  );
}

const extraResource = [
  ...(existsSync(CLIENT_DIST) ? [CLIENT_DIST] : []),
  ...(existsSync(TOR_DIR) ? [TOR_DIR] : []),
];

/**
 * Names baked into the packages.
 *
 * `name` is load-bearing on Windows: Squirrel uses it as the NuGet package id,
 * the install directory under `%LocalAppData%`, and the key it matches an
 * installed app against. It said "Stoat" for as long as this was a fork, which
 * meant an app called Mayhem installing itself into a folder called Stoat and
 * appearing under that name in Add/Remove Programs.
 *
 * Changing it is a one-way door for anyone already running a build: Squirrel
 * will not recognise the new package as an update to the old one, so the first
 * Reaper-named release has to be installed over the top rather than updated
 * into. That is the right trade to make once, now, rather than never.
 */
const STRINGS = {
  author: "Ray",
  name: "Reaper",
  execName: "reaper",
  description: "Serverless, end-to-end encrypted chat over Tor.",
};

/**
 * Where releases are served from.
 *
 * Only used for the setup icon Squirrel shows while installing, which it
 * fetches over the network rather than reading out of the package. Everything
 * else about updates is decided at runtime — see `src/native/updates.ts`.
 */
const RELEASE_URL = process.env.REAPER_UPDATE_URL ?? "";

const ASSET_DIR = "assets/desktop";

/**
 * Build targets for the desktop app
 */
const makers: ForgeConfig["makers"] = [
  new MakerSquirrel({
    name: STRINGS.name,
    authors: STRINGS.author,
    // Fetched over the network by the installer. Pointing it at the upstream
    // project meant the install progress window showed somebody else's logo;
    // pointing it nowhere is better than that, and pointing it at your own
    // release host is better still.
    ...(RELEASE_URL ? { iconUrl: `${RELEASE_URL.replace(/\/+$/, "")}/icon.ico` } : {}),
    // todo: loadingGif
    setupIcon: `${ASSET_DIR}/icon.ico`,
    description: STRINGS.description,
    exe: `${STRINGS.execName}.exe`,
    setupExe: `${STRINGS.execName}-setup.exe`,
    copyright: "Copyright (C) 2026 Ray",
  }),
  new MakerZIP({}),
  new MakerFlatpak({
    options: {
      id: "chat.stoat.StoatDesktop",
      description: STRINGS.description,
      productName: STRINGS.name,
      productDescription: STRINGS.description,
      runtimeVersion: "25.08",
      icon: {
        "16x16": `${ASSET_DIR}/hicolor/16x16.png`,
        "32x32": `${ASSET_DIR}/hicolor/32x32.png`,
        "64x64": `${ASSET_DIR}/hicolor/64x64.png`,
        "128x128": `${ASSET_DIR}/hicolor/128x128.png`,
        "256x256": `${ASSET_DIR}/hicolor/256x256.png`,
        "512x512": `${ASSET_DIR}/hicolor/512x512.png`,
      } as unknown,
      categories: ["Network"],
      modules: [
        // use the latest zypak -- Electron sandboxing for Flatpak
        {
          name: "zypak",
          sources: [
            {
              type: "git",
              url: "https://github.com/refi64/zypak",
              tag: "v2025.09",
            },
          ],
        },
      ],
      finishArgs: [
        // default arguments found by running
        // DEBUG=electron-installer-flatpak* pnpm make
        "--socket=fallback-x11",
        "--socket=wayland",
        "--share=ipc",
        "--share=network",
        "--device=dri",
        "--device=all",
        "--socket=pulseaudio",
        "--filesystem=xdg-run/pipewire-0",
        "--filesystem=xdg-videos:ro",
        "--filesystem=xdg-pictures:ro",
        "--filesystem=xdg-download",
        "--filesystem=xdg-run/speech-dispatcher",
        "--talk-name=org.freedesktop.ScreenSaver",
        "--talk-name=org.freedesktop.Notifications",
        "--talk-name=org.kde.StatusNotifierWatcher",
        "--talk-name=com.canonical.AppMenu.Registrar",
        "--talk-name=com.canonical.indicator.application",
        "--talk-name=com.canonical.Unity",
        "--env=XCURSOR_PATH=/run/host/user-share/icons:/run/host/share/icons",
        "--env=ELECTRON_TRASH=gio",
        "--env=TMPDIR=xdg-run/app/chat.stoat.StoatDesktop",
      ],
      files: [],
    } as MakerFlatpakOptionsConfig,
  }),
];

// skip these makers in CI/CD
if (!process.env.PLATFORM) {
  makers.push(
    // must be manually built (freezes CI process)
    // not much use in being published anyhow
    new MakerAppX({
      certPass: "",
      packageExecutable: `app\\${STRINGS.execName}.exe`,
      publisher: "CN=B040CC7E-0016-4AF5-957F-F8977A6CFA3B",
    }),
    // testing purposes
    new MakerDeb({
      options: {
        productName: STRINGS.name,
        productDescription: STRINGS.description,
        categories: ["Network"],
        icon: `${ASSET_DIR}/icon.png`,
      },
    }),
  );
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: STRINGS.name,
    executableName: STRINGS.execName,
    icon: `${ASSET_DIR}/icon`,
    // The local client and the Tor daemon. See the definitions above.
    extraResource,
  },
  rebuildConfig: {},
  makers,
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  publishers: [
    new PublisherGithub({
      repository: {
        owner: "stoatchat",
        name: "for-desktop",
      },
    }),
  ],
};

export default config;
