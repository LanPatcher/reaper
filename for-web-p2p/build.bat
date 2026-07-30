@echo off
setlocal enabledelayedexpansion

REM ===========================================================================
REM  Build the Reaper web client for Windows.
REM
REM  Unlike the desktop build, this one is server-backed: a browser tab cannot
REM  open sockets, touch a disk, or run Tor, so a small relay on the machine
REM  serving the page supplies those. This script builds the static client
REM  bundle only. See below for how to serve it.
REM
REM  Produces the static site under dist\.
REM
REM  Usage:
REM    build.bat                              install deps + build
REM    build.bat clean                        wipe node_modules and dist first
REM    build.bat serve                        build, then run the relay locally
REM
REM  Nothing here is npm-global or needs admin. Everything installs into the
REM  project's own node_modules.
REM ===========================================================================

cd /d "%~dp0"

echo.
echo  Reaper web - build
echo  ==========================
echo.

REM --- Prerequisites ---------------------------------------------------------

where node >nul 2>&1
if errorlevel 1 (
    echo  [X] Node.js is not installed, or not on PATH.
    echo      Install Node 20 or newer from https://nodejs.org
    echo        winget install OpenJS.NodeJS.LTS
    echo      Open a NEW terminal after installing, then re-run this script.
    goto :fail
)

for /f "tokens=*" %%v in ('node --version') do set "NODE_VERSION=%%v"
echo  [+] Node %NODE_VERSION%

REM Vite 6 drops Node 18 and refuses to run on anything below Node 20.19 / 22.12.
REM Continuing on an older Node fails deep inside the build with an opaque
REM error, so stop here with something actionable instead.
for /f "tokens=1 delims=." %%a in ("%NODE_VERSION%") do set "NODE_MAJOR=%%a"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
if %NODE_MAJOR% GEQ 20 goto :node_ok

echo.
echo  [X] Node %NODE_VERSION% is too old. This build needs Node 20.19 or newer.
echo.
echo      Upgrade with winget:
echo        winget install OpenJS.NodeJS.LTS
echo.
echo      Open a NEW terminal after installing, then re-run this script.
goto :fail

:node_ok

where npm >nul 2>&1
if errorlevel 1 (
    echo  [X] npm is not on PATH. It ships with Node - reinstall Node from
    echo      https://nodejs.org and open a new terminal.
    goto :fail
)

REM --- Arguments ---------------------------------------------------------------

set "ARG=%~1"

if /i "%ARG%"=="clean" (
    echo.
    echo  [*] Cleaning previous build...
    if exist node_modules rmdir /s /q node_modules
    if exist dist rmdir /s /q dist
)

REM --- Install ---------------------------------------------------------------
REM
REM Prefer `npm ci` when a lockfile is present: it is faster and installs the
REM exact locked versions. Fall back to `npm install` when there is no lockfile
REM (or when ci refuses because the lockfile is out of sync).

echo.
echo  [*] Installing dependencies...
if exist package-lock.json (
    call npm ci
    if errorlevel 1 (
        echo  [!] npm ci failed - falling back to npm install...
        call npm install
        if errorlevel 1 goto :fail
    )
) else (
    call npm install
    if errorlevel 1 goto :fail
)

REM --- Build -----------------------------------------------------------------

echo.
echo  [*] Building client bundle...
call npm run build
if errorlevel 1 goto :fail

if not exist dist\index.html (
    echo.
    echo  [X] Build reported success but dist\index.html is missing.
    goto :fail
)

REM --- Optional: serve -------------------------------------------------------

if /i "%ARG%"=="serve" (
    echo.
    echo  [*] Starting the relay on http://localhost:8080 ^(Ctrl+C to stop^)...
    echo.
    call npm run relay
    goto :end
)

REM --- Done ------------------------------------------------------------------

echo.
echo  =====================================================
echo   Build complete.
echo.
echo   Static client:  dist\
echo.
echo   A browser tab needs a relay for sockets, disk and
echo   Tor. To serve locally:
echo        build.bat serve
echo   or   npm run relay
echo.
echo   To deploy behind a real web server, see deploy\
echo   ^(nginx.conf, Caddyfile, reaper-web.service^).
echo  =====================================================
echo.

:end
REM Only pause when double-clicked from Explorer, so this stays usable in CI.
echo %CMDCMDLINE% | findstr /i /c:"%~nx0" >nul && pause
exit /b 0

:fail
echo.
echo  [X] Build failed.
echo.
echo %CMDCMDLINE% | findstr /i /c:"%~nx0" >nul && pause
exit /b 1
