#!/usr/bin/env bash
set -euo pipefail

# ===========================================================================
#  Build the Reaper desktop app as a Debian package (.deb).
#
#  Serverless build, same as build.bat's Windows target — the interface is
#  compiled into the main process bundle, so there is no web client to build
#  first. This only produces the .deb maker's output; the other Linux makers
#  (zip, flatpak) need extra tooling (flatpak-builder) this script does not
#  set up, and the Windows-only makers (Squirrel, AppX) are skipped
#  automatically by electron-forge on this platform regardless.
#
#  Usage:
#    ./build-linux.sh              build
#    ./build-linux.sh clean        wipe build artifacts first
#
#  Runs on a real Linux machine or inside WSL (Ubuntu/Debian) against this
#  same repo checkout — `dpkg-deb`/`fakeroot` are Linux tools with no Windows
#  equivalent, which is the one thing build.bat cannot do for you.
# ===========================================================================

cd "$(dirname "${BASH_SOURCE[0]}")"

echo
echo " Reaper - build (Linux / .deb)"
echo " =============================="
echo

# --- Prerequisites -----------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  echo " [X] Node.js is not installed, or not on PATH."
  echo "     Install Node 22 or newer — nvm is the easiest route on Linux:"
  echo "       curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  echo "       nvm install 22"
  exit 1
fi

NODE_VERSION="$(node --version)"
echo " [+] Node ${NODE_VERSION}"

# Same hard requirement as build.bat, and the same reason: pnpm 11 needs
# node:sqlite, which does not exist before Node 22.13, and fails with
# ERR_UNKNOWN_BUILTIN_MODULE rather than anything that names the real cause.
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo
  echo " [X] Node ${NODE_VERSION} is too old. This build needs Node 22.13 or newer."
  echo
  echo "     With nvm:"
  echo "       nvm install 22 && nvm alias default 22"
  exit 1
fi

# --- pnpm ----------------------------------------------------------------
#
# Pinned in package.json's "packageManager" field; corepack is what actually
# reads that and fetches the matching version, so there is no separate
# version to keep in step here.

if ! command -v corepack >/dev/null 2>&1; then
  echo " [X] corepack is not available. It ships with Node 16.9+ — reinstall"
  echo "     Node, or run: npm install -g corepack"
  exit 1
fi

echo " [*] Setting up pnpm via corepack..."
corepack enable >/dev/null 2>&1 || true
corepack prepare --activate >/dev/null

PNPM_VERSION="$(pnpm --version)"
echo " [+] pnpm ${PNPM_VERSION}"

# --- dpkg-deb / fakeroot ---------------------------------------------------
#
# What actually builds the .deb. electron-forge's maker shells out to these;
# without them the failure surfaces deep inside node_modules with a message
# that does not say "install this package".

if ! command -v dpkg-deb >/dev/null 2>&1 || ! command -v fakeroot >/dev/null 2>&1; then
  echo
  echo " [X] dpkg-deb and/or fakeroot are missing."
  echo "     On Debian/Ubuntu:  sudo apt-get install -y dpkg fakeroot"
  exit 1
fi

# --- Arguments ---------------------------------------------------------------

if [ "${1:-}" = "clean" ]; then
  echo
  echo " [*] Cleaning previous build..."
  rm -rf node_modules .vite out
fi

# --- Install -----------------------------------------------------------------

echo
echo " [*] Installing dependencies..."
pnpm install

# --- Tor -----------------------------------------------------------------
#
# Bundled from an existing system install rather than downloaded here — see
# scripts/vendor-tor.mjs for why. `apt install tor` is the equivalent of the
# Windows build's "get Tor Browser" step: a copy of tor a package manager
# you already trust has already verified, not a fresh download this script
# would be asking you to trust sight unseen.

if [ ! -f vendor/tor/tor ]; then
  echo
  echo " [*] Vendoring tor..."
  if ! command -v tor >/dev/null 2>&1; then
    echo
    echo " [X] No system tor found, and vendor/tor/ is empty."
    echo "     On Debian/Ubuntu:  sudo apt-get install -y tor"
    echo "     Then re-run this script."
    exit 1
  fi
  node scripts/vendor-tor.mjs
fi

# --- Build -----------------------------------------------------------------

echo
echo " [*] Building the .deb (this takes a few minutes)..."
# The maker's *registered* name, not its package name — electron-forge
# resolves --targets by matching against each configured maker's `.name`
# property ("deb" for MakerDeb). Passing the package name instead
# ("@electron-forge/maker-deb") fails that match silently and falls back to
# constructing a brand new, wholly unconfigured MakerDeb from scratch —
# every option in forge.config.ts (icon, categories, description) is
# discarded rather than erroring, so the build "succeeds" and produces a
# .deb with the library's generic defaults instead of this app's. Cost real
# time to track down since nothing about it looks like a failure.
pnpm exec electron-forge make --targets=deb

# --- Done ------------------------------------------------------------------

echo
echo " ====================================================="
echo "  Build complete."
echo
echo "  Package: out/make/deb/x64/"
echo
echo "  Serverless. On first run it asks for a username and"
echo "  creates a local keypair - no account, no password,"
echo "  no server to reach."
echo " ====================================================="
echo
