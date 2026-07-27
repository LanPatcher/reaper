@echo off
setlocal enabledelayedexpansion

REM ===========================================================================
REM  Build the Reaper desktop app for Windows.
REM
REM  Serverless build. The interface is compiled into the main process bundle,
REM  so there is no web client to build first and nothing to point at a server.
REM
REM  Produces an installer under out\make\squirrel.windows\ and a portable zip
REM  under out\make\zip\.
REM
REM  Usage:
REM    build.bat                              build
REM    build.bat clean                        wipe build artifacts first
REM
REM  There is no server address to configure. Accounts are local keypairs and
REM  history lives in an encrypted log on this machine.
REM ===========================================================================

cd /d "%~dp0"

echo.
echo  Reaper - build
echo  =====================
echo.

REM --- Prerequisites ---------------------------------------------------------

set "PNPM_WANTED=11.17.0"

where node >nul 2>&1
if errorlevel 1 (
    echo  [X] Node.js is not installed, or not on PATH.
    echo      Install Node 22 or newer from https://nodejs.org
    goto :fail
)

for /f "tokens=*" %%v in ('node --version') do set NODE_VERSION=%%v
echo  [+] Node %NODE_VERSION%

REM Node version is a hard requirement, not a preference:
REM   - pnpm 11 refuses to run below Node 22.13 (it needs node:sqlite, which
REM     does not exist in Node 20, so it crashes with ERR_UNKNOWN_BUILTIN_MODULE)
REM   - corepack bundled with Node 20 and earlier fails signature verification
REM     against current npm registry keys
REM   - Electron 40 and the Vite toolchain both target modern Node
REM
REM Continuing on an old Node produces a cascade of confusing failures, so stop
REM here with something actionable instead.
for /f "tokens=1 delims=." %%a in ("%NODE_VERSION%") do set "NODE_MAJOR=%%a"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
if %NODE_MAJOR% GEQ 22 goto :node_ok

echo.
echo  [X] Node %NODE_VERSION% is too old. This build needs Node 22.13 or newer.
echo.
echo      pnpm 11 will not run on it at all - it requires the node:sqlite
echo      module, which Node 20 does not have.
echo.
echo      Upgrade with winget:
echo        winget install OpenJS.NodeJS.LTS
echo.
echo      Or download the LTS installer from https://nodejs.org
echo.
echo      If you need several Node versions side by side, use fnm:
echo        winget install Schniz.fnm
echo        fnm install 22
echo        fnm use 22
echo.
echo      Open a NEW terminal after installing, then re-run this script.
goto :fail

:node_ok

REM --- pnpm ------------------------------------------------------------------
REM
REM Getting pnpm onto PATH is the single most failure-prone step of this build,
REM for two reasons that compound:
REM
REM   1. If Node was installed system-wide, npm's global prefix is
REM      C:\Program Files\nodejs, which a normal user cannot write to. Any
REM      `npm install -g` or `corepack enable` then dies with EPERM.
REM   2. Corepack bundled with Node 20 and earlier validates package signatures
REM      against npm registry keys that have since been rotated, so it fails
REM      with "Cannot find matching keyid" even when it *can* write.
REM
REM So we try, in order: whatever is already on PATH, corepack with signature
REM checking disabled, and finally a private copy installed under LOCALAPPDATA
REM which needs no elevation at all.

set "PNPM_TOOLS=%LOCALAPPDATA%\stoat-build-tools"

where pnpm >nul 2>&1
if not errorlevel 1 goto :pnpm_ready

REM A private copy from a previous run. Kept flat rather than wrapped in a
REM parenthesised block, because PATH changes and errorlevel checks inside a
REM block are a well-known source of subtle batch bugs.
if not exist "%PNPM_TOOLS%\pnpm.cmd" goto :try_corepack
set "PATH=%PNPM_TOOLS%;%PATH%"
where pnpm >nul 2>&1
if not errorlevel 1 goto :pnpm_ready

:try_corepack
echo  [!] pnpm not found. Trying corepack...
REM Documented escape hatch for the rotated-keys failure above.
set "COREPACK_INTEGRITY_KEYS=0"
call corepack enable >nul 2>&1
call corepack prepare pnpm@%PNPM_WANTED% --activate >nul 2>&1
where pnpm >nul 2>&1
if not errorlevel 1 goto :pnpm_ready

REM Install into a user-writable directory. Deliberately not `npm install -g`
REM without a prefix: that targets the Node install directory and needs admin.
echo  [!] corepack unavailable. Installing a private copy of pnpm...
echo      Target: %PNPM_TOOLS%
if not exist "%PNPM_TOOLS%" mkdir "%PNPM_TOOLS%" >nul 2>&1
call npm install -g --prefix "%PNPM_TOOLS%" pnpm@%PNPM_WANTED%
if not exist "%PNPM_TOOLS%\pnpm.cmd" goto :pnpm_failed

REM setlocal scopes this, so the user's PATH is left alone.
set "PATH=%PNPM_TOOLS%;%PATH%"
where pnpm >nul 2>&1
if not errorlevel 1 goto :pnpm_ready

:pnpm_failed
echo.
echo  [X] Could not set up pnpm.
echo.
echo      Every automatic route failed. The usual cause is that npm's global
echo      prefix points at C:\Program Files\nodejs, which needs admin rights.
echo.
echo      Pick whichever of these you prefer:
echo.
echo      1. Official pnpm installer ^(no admin, recommended^).
echo         In PowerShell:
echo           Invoke-WebRequest https://get.pnpm.io/install.ps1 -UseBasicParsing ^| Invoke-Expression
echo         Then open a NEW terminal and re-run this script.
echo.
echo      2. Point npm somewhere you can write, then install normally:
echo           npm config set prefix "%%APPDATA%%\npm"
echo           npm install -g pnpm@%PNPM_WANTED%
echo         Make sure %%APPDATA%%\npm is on your PATH afterwards.
echo.
echo      3. Re-run this script from an Administrator terminal.
echo.
echo      Upgrading to Node 22 or newer also avoids the corepack half of this
echo      problem entirely.
goto :fail

:pnpm_ready
REM `where pnpm` only proves the shim exists. Confirm it actually runs before
REM continuing - a pnpm installed against the wrong Node version is present on
REM PATH but crashes on every invocation, which otherwise shows up much later
REM as a baffling install failure.
set "PNPM_VERSION="
for /f "tokens=*" %%v in ('pnpm --version 2^>nul') do set "PNPM_VERSION=%%v"

if not defined PNPM_VERSION (
    echo.
    echo  [X] pnpm is on PATH but will not run.
    echo.
    echo      Almost always a Node version mismatch. Run 'pnpm --version'
    echo      directly to see the real error.
    echo.
    echo      If it mentions node:sqlite or ERR_UNKNOWN_BUILTIN_MODULE, your
    echo      Node is too old - install Node 22.13 or newer, then delete
    echo      %PNPM_TOOLS% and re-run this script.
    goto :fail
)

echo  [+] pnpm %PNPM_VERSION%

REM --- Arguments ---------------------------------------------------------------

set "ARG=%~1"

if /i "%ARG%"=="clean" (
    echo.
    echo  [*] Cleaning previous build...
    if exist node_modules rmdir /s /q node_modules
    if exist .vite rmdir /s /q .vite
    if exist out rmdir /s /q out
)

REM --- No web client to build ---------------------------------------------------
REM
REM This is the serverless build. Its interface is compiled into the main
REM process bundle as a string (see src/native/clientProtocol.ts), so there is
REM no separate client to build, copy, or verify.
REM
REM The server-backed build does all of that here and it is deliberately gone:
REM building for-web would take twenty minutes to produce a Solid client that
REM expects an HTTP backend, which this app does not have and would never load.

echo.
echo  [*] Serverless build - no web client needed

REM --- Install ---------------------------------------------------------------

echo.
echo  [*] Installing dependencies...
call pnpm install
if errorlevel 1 goto :fail

REM --- Build -----------------------------------------------------------------

echo.
echo  [*] Building installer ^(this takes a few minutes^)...
call pnpm make
if errorlevel 1 goto :fail

REM --- Done ------------------------------------------------------------------

echo.
echo  =====================================================
echo   Build complete.
echo.
echo   Installer:  out\make\squirrel.windows\x64\
echo   Portable:   out\make\zip\win32\x64\
echo.
echo   Serverless. On first run it asks for a username
echo   and creates a local keypair - no account, no
echo   password, no server to reach.
echo  =====================================================
echo.

REM Only pause when double-clicked from Explorer, so this stays usable in CI.
echo %CMDCMDLINE% | findstr /i /c:"%~nx0" >nul && pause
exit /b 0

:fail
echo.
echo  [X] Build failed.
echo.
echo %CMDCMDLINE% | findstr /i /c:"%~nx0" >nul && pause
exit /b 1
