import { MakerAppX } from "@electron-forge/maker-appx";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerDebConfigOptions } from "@electron-forge/maker-deb/dist/Config";
import { MakerFlatpak } from "@electron-forge/maker-flatpak";
import { MakerFlatpakOptionsConfig } from "@electron-forge/maker-flatpak/dist/Config";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { PublisherGithub } from "@electron-forge/publisher-github";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// import { globSync } from "node:fs";

/**
 * The set of node_modules packages to ship in the packaged app: every
 * production dependency, transitively.
 *
 * Why compute this ourselves instead of letting Forge prune?
 *
 *   1. The @electron-forge/plugin-vite plugin excludes ALL of node_modules from
 *      the package (its ignore keeps only /.vite). node-llama-cpp is an
 *      external, native, ESM module resolved at runtime, so it MUST ship — the
 *      packaged app is useless without it. So we must override ignore.
 *   2. Forge's normal pruner (flora-colossus) then walks node_modules and
 *      throws on any dependency it cannot locate on disk — including packages
 *      pnpm legitimately skips on this platform (e.g. app-builder-lib's
 *      linux-only @malept/flatpak-bundler, pulled in by electron-builder, which
 *      this project uses only to build the zip). That crashes the build.
 *
 * Walking package.json ourselves and simply skipping anything not installed is
 * tolerant of those platform-skipped packages, and lets us keep exactly the
 * runtime closure (electron-builder and the other devDependencies never enter
 * it). Paired with `prune: false`, flora-colossus never runs.
 */
function productionClosure(): string[] {
  const projectDir = process.cwd();
  const stopAbove = dirname(projectDir);
  const readPj = (dir: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      return null;
    }
  };
  // Resolve a dependency the way Node does — nested node_modules first, walking
  // up to the project's own node_modules. This is what makes it correct under
  // pnpm's partially-nested layout (e.g. node-llama-cpp keeps some of its own
  // deps, like log-symbols, in its private node_modules, and those pull in
  // packages such as yoctocolors that a top-level-only scan never sees).
  const resolveDep = (fromDir: string, name: string): string | null => {
    let cur = fromDir;
    while (cur && cur.startsWith(stopAbove)) {
      const cand = join(cur, "node_modules", ...name.split("/"));
      if (existsSync(join(cand, "package.json"))) return cand;
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    const top = join(projectDir, "node_modules", ...name.split("/"));
    return existsSync(join(top, "package.json")) ? top : null;
  };
  // The huge CUDA backends (~300 MB) and the wrong-arch arm64 one are not worth
  // shipping — node-llama-cpp falls back to the Vulkan (GPU) or CPU backend,
  // both of which are kept. Dropping them keeps the installer small.
  const SKIP = new Set<string>([
    "@node-llama-cpp/win-x64-cuda",
    "@node-llama-cpp/win-x64-cuda-ext",
    "@node-llama-cpp/win-arm64",
  ]);
  const keep = new Set<string>();
  const root = readPj(projectDir);
  const queue = Object.keys((root?.dependencies as object) ?? {}).map((name) => ({
    name,
    from: projectDir,
  }));
  while (queue.length) {
    const { name, from } = queue.shift() as { name: string; from: string };
    if (SKIP.has(name)) continue;
    const dir = resolveDep(from, name);
    if (!dir || keep.has(dir)) continue;
    keep.add(dir);
    const pj = readPj(dir);
    if (!pj) continue;
    for (const d of [
      ...Object.keys((pj.dependencies as object) ?? {}),
      ...Object.keys((pj.optionalDependencies as object) ?? {}),
    ]) {
      queue.push({ name: d, from: dir });
    }
  }
  // Relative, POSIX-style directories. electron-packager's ignore receives
  // paths with forward slashes and a leading slash, even on Windows.
  return [...keep].map((d) => d.slice(projectDir.length + 1).split(/[\\/]/).join("/"));
}

const KEEP_DIRS = productionClosure();

/** Keep a "/node_modules/..." path iff it is inside — or an ancestor directory
 * of — a kept production package. */
function keepNodeModulesPath(file: string): boolean {
  const rel = file.replace(/^\/+/, "");
  if (rel === "" || rel === "node_modules") return true;
  for (const d of KEEP_DIRS) {
    if (rel === d || rel.startsWith(`${d}/`)) return true; // inside a kept package
    if (d.startsWith(`${rel}/`)) return true; // an ancestor dir — descend into it
  }
  return false;
}

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

/**
 * The local-AI assets, vendored by `npm run vendor:models`.
 *
 * Optional in the same way the client bundle is: a build without them packages
 * fine and simply has no working AI-friend feature (the UI reports the model as
 * missing). They are large — a couple of gigabytes — so a build that forgot the
 * vendor step should not fail, just ship without them. `./vendor/models` and
 * `./vendor/sd` land at `resources/models` and `resources/sd`, which is where
 * `src/local-ai/paths.ts` looks for them.
 */
const MODELS_DIR = "./vendor/models";
const SD_DIR = "./vendor/sd";

if (!existsSync(MODELS_DIR)) {
  console.warn(
    "\n  [!] vendor/models is missing — the AI-friend feature will show the\n" +
      "      model as not installed. Run:  npm run vendor:models\n",
  );
}

const extraResource = [
  ...(existsSync(CLIENT_DIST) ? [CLIENT_DIST] : []),
  ...(existsSync(TOR_DIR) ? [TOR_DIR] : []),
  ...(existsSync(MODELS_DIR) ? [MODELS_DIR] : []),
  ...(existsSync(SD_DIR) ? [SD_DIR] : []),
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

const ASSET_DIR = "assets/desktop";

/**
 * Build targets for the desktop app
 */
const makers: ForgeConfig["makers"] = [
  // Windows installer via Squirrel (Forge's built-in maker). Squirrel embeds
  // the whole app as a PE resource inside Setup.exe, which cannot exceed ~4 GB.
  // That was a problem while a multi-gigabyte image model was bundled (it
  // produced a broken "dummy update.exe"), but image generation has since been
  // removed, so the app is comfortably back under the limit and Squirrel works.
  new MakerSquirrel({
    name: STRINGS.name,
    authors: STRINGS.author,
    setupIcon: `${ASSET_DIR}/icon.ico`,
    description: STRINGS.description,
    exe: `${STRINGS.execName}.exe`,
    setupExe: `${STRINGS.execName}-setup.exe`,
    copyright: "Copyright (C) 2026 Ray",
  }),
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
        // A bare string here (what this used to be) only ever produces the
        // legacy /usr/share/pixmaps/reaper.png — electron-installer-debian's
        // copyLinuxIcons() takes the object-vs-string branch, and a single
        // pixmap is not what modern GNOME/Ubuntu actually looks up an app's
        // icon from. An object, one path per size, makes it install the
        // proper /usr/share/icons/hicolor/<size>/apps/reaper.png set
        // instead — the same set the flatpak maker above already uses, for
        // exactly the same reason.
        icon: {
          "16x16": `${ASSET_DIR}/hicolor/16x16.png`,
          "32x32": `${ASSET_DIR}/hicolor/32x32.png`,
          "64x64": `${ASSET_DIR}/hicolor/64x64.png`,
          "128x128": `${ASSET_DIR}/hicolor/128x128.png`,
          "256x256": `${ASSET_DIR}/hicolor/256x256.png`,
          "512x512": `${ASSET_DIR}/hicolor/512x512.png`,
        },
        // `tor` is a hard `Depends` — not just `recommends` — because the app
        // is unreachable without a working tor binary and vendoring one at
        // build time has proven to be a genuinely fragile step (it silently
        // no-ops if the build machine never ran `apt install tor` itself; see
        // `vendor-tor.mjs` and forge.config.ts's own TOR_DIR warning above).
        // `apt install`-ing `tor` alongside this package guarantees a real,
        // ABI-correct binary is on the system regardless of what the build
        // machine had — `bridge.ts`'s `torExecutable()` now falls back to
        // `/usr/bin/tor` if the bundled copy is missing, so this dependency
        // actually gets used, not just declared.
        //
        // Setting `depends` here replaces electron-installer-debian's own
        // computed list (filled in via lodash `_.defaults()`, which only
        // fills what's still unset) rather than adding to it — so the
        // Electron-required list is spelled out literally below and `tor`
        // appended, rather than declared alone. These come from
        // electron-installer-debian's own `dependencies.js` for the Electron
        // version this project currently pins (confirmed via `dpkg-deb -I`
        // against a real build) — hand-copied rather than required at
        // config-eval time, because `electron-installer-debian` is a
        // transitive dependency of `@electron-forge/maker-deb`, not a direct
        // one, and pnpm's strict node_modules layout correctly refuses to
        // resolve a bare `require()` of an undeclared package. Revisit this
        // list if the Electron major version changes.
        depends: [
          "libgtk-3-0",
          "libnotify4",
          "libnss3",
          "xdg-utils",
          "libatspi2.0-0",
          "libdrm2",
          "libgbm1",
          "libxcb-dri3-0",
          "kde-cli-tools | kde-runtime | trash-cli | libglib2.0-bin | gvfs-bin",
          "tor",
        ],
        // Still declared for the case where the bundled copy is the one that
        // ends up running: its own runtime libraries (libevent, libseccomp,
        // libgcrypt, ...) aren't pulled in by `Depends: tor` itself if that
        // resolves to a different tor build than expected. Two names per line
        // where Ubuntu's 24.04 time_t64 transition renamed the package
        // (libssl3 -> libssl3t64 etc.).
        recommends: [
          "pulseaudio | libasound2",
          "libssl3 | libssl3t64",
          "libevent-2.1-7 | libevent-2.1-7t64",
          "libsystemd0",
          "liblzma5",
          "libzstd1",
          "libseccomp2",
          "libcap2",
          "libgcrypt20",
          "liblz4-1",
          "libgpg-error0",
          "zlib1g",
        ],
      } as MakerDebConfigOptions,
    }),
  );
}

const config: ForgeConfig = {
  packagerConfig: {
    // The @electron-forge/plugin-vite plugin's default ignore drops ALL of
    // node_modules from the package (it keeps only /.vite). node-llama-cpp is an
    // external, native, ESM module loaded at runtime, so it must physically
    // ship. This custom ignore keeps the .vite build plus exactly the runtime
    // dependency closure (see productionClosure() above); everything else —
    // source, devDependencies, electron-builder's tree — is left out. Combined
    // with `prune: false`, Forge's flora-colossus pruner never runs (it crashes
    // on platform-skipped packages like app-builder-lib's linux-only
    // @malept/flatpak-bundler).
    prune: false,
    ignore: (file: string) => {
      if (!file) return false;
      if (file === "/package.json") return false;
      if (file.startsWith("/.vite")) return false;
      if (file === "/node_modules" || file.startsWith("/node_modules/"))
        return !keepNodeModulesPath(file);
      return true;
    },
    // node-llama-cpp and several of its dependencies are ESM and/or native, and
    // neither ESM resolution nor a .node dlopen works from inside an asar. So
    // the whole node_modules tree is unpacked to app.asar.unpacked (real files
    // on disk); the app's own code still lives in the asar.
    asar: {
      unpack: "**/node_modules/**",
    },
    name: STRINGS.name,
    executableName: STRINGS.execName,
    icon: `${ASSET_DIR}/icon`,
    // The local client and the Tor daemon. See the definitions above.
    extraResource,
  },
  rebuildConfig: {},
  makers,
  plugins: [
    // (Native-addon unpacking is handled by packagerConfig.asar.unpack above,
    // which also unpacks the node-llama-cpp ESM tree — AutoUnpackNativesPlugin
    // only handled .node files and left the ESM package stuck in the asar.)
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
