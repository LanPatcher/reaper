@echo off
setlocal enabledelayedexpansion

REM ===========================================================================
REM  Build the Reaper iOS app and fetch the IPA.
REM
REM  The compile itself happens on a hosted Mac, because Xcode is macOS-only
REM  and there is no cross-compiler. This starts that build, follows it, and
REM  downloads the result into build\.
REM
REM  Usage:
REM    build-ios.bat            build and download
REM    build-ios.bat status     what the last few builds did
REM    build-ios.bat test       run the shim tests locally, no Mac involved
REM    build-ios.bat clean      wipe node_modules and reinstall
REM ===========================================================================

cd /d "%~dp0"

echo.
echo  Reaper for iOS
echo  ==============
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo  [X] Node.js is not installed, or not on PATH.
    echo      Install Node 22 or newer from https://nodejs.org
    exit /b 1
)

if /i "%~1"=="clean" (
    echo  [+] Removing node_modules...
    if exist node_modules rmdir /s /q node_modules
    if exist package-lock.json del /q package-lock.json
    echo  [+] Reinstalling...
    call npm install
    if errorlevel 1 exit /b 1
    echo.
    echo  [+] Done.
    exit /b 0
)

REM --- dependencies ----------------------------------------------------------

if not exist node_modules (
    echo  [+] Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo  [X] npm install failed.
        exit /b 1
    )
)

REM esbuild ships its compiler as a separate per-platform package, picked by npm
REM from optionalDependencies at install time. A node_modules tree populated on
REM a different operating system - copied between machines, restored from a
REM backup, or installed from inside WSL against the Windows folder - therefore
REM has the wrong binary or none at all.
REM
REM It fails at the point of use with "The package @esbuild/win32-x64 could not
REM be found", which reads like a broken dependency rather than a tree that was
REM built somewhere else. Checked here, where it can be said plainly and fixed
REM without anybody having to work out what happened.
if exist node_modules (
    if not exist node_modules\@esbuild\win32-x64 (
        echo  [!] node_modules was not installed on this machine, so esbuild has
        echo      no Windows binary. Reinstalling.
        echo.
        rmdir /s /q node_modules
        if exist package-lock.json del /q package-lock.json
        call npm install
        if errorlevel 1 (
            echo  [X] npm install failed.
            exit /b 1
        )
        echo.
    )
)

if /i "%~1"=="status" (
    node scripts/remote-build.mjs --status
    exit /b %errorlevel%
)

if /i "%~1"=="test" (
    node scripts/shim.mjs
    exit /b %errorlevel%
)

REM The shim tests run here, on Windows, in a few seconds. They compare the
REM browser crypto and compression against Node's - which is what decides
REM whether a phone can talk to a desktop at all. Cheaper to find out now than
REM after a twenty-minute build on somebody else's Mac.
echo  [+] Checking the shims first...
call node scripts/shim.mjs
if errorlevel 1 (
    echo.
    echo  [X] The shim tests failed. Fix those before building - a phone that
    echo      cannot agree with a desktop about event ids will install fine
    echo      and never receive a message.
    exit /b 1
)

echo.
echo  [+] Starting the remote build...
echo.

node scripts/remote-build.mjs %*
exit /b %errorlevel%
