@echo off
setlocal enabledelayedexpansion

REM ===========================================================================
REM  Build the Reaper Android app locally and produce an installable APK.
REM
REM  Unlike iOS this needs no remote Mac: Android builds fully on this
REM  machine with just a JDK and the Android SDK (Gradle reads
REM  android\local.properties for the SDK location on its own). This installs
REM  npm dependencies if needed, runs the shim tests, builds the web bundle,
REM  syncs it into the Capacitor project, and runs Gradle.
REM
REM  Usage:
REM    build-android.bat            debug build   -> build\app-debug.apk
REM    build-android.bat release    release build (unsigned) -> build\app-release-unsigned.apk
REM    build-android.bat install    debug build, then install onto a connected device/emulator
REM    build-android.bat run        install, then launch the app
REM    build-android.bat test       run the shim tests only, no Gradle
REM    build-android.bat clean      wipe node_modules, dist, and the Gradle build output
REM ===========================================================================

cd /d "%~dp0"

echo.
echo  Reaper for Android
echo  ==================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo  [X] Node.js is not installed, or not on PATH.
    echo      Install Node 22 or newer from https://nodejs.org
    exit /b 1
)

if /i "%~1"=="clean" (
    echo  [+] Removing node_modules, dist, and the Gradle build output...
    if exist node_modules rmdir /s /q node_modules
    if exist package-lock.json del /q package-lock.json
    if exist dist rmdir /s /q dist
    if exist android\app\build rmdir /s /q android\app\build
    if exist android\build rmdir /s /q android\build
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

REM esbuild ships its compiler as a separate per-platform package, picked by
REM npm from optionalDependencies at install time. A node_modules tree
REM populated on a different OS - copied between machines, restored from a
REM backup, or installed from inside WSL against the Windows folder -
REM therefore has the wrong binary or none at all, and the vite build fails
REM deep inside with a message that reads like a broken dependency rather
REM than a tree that was built somewhere else. Checked here, where it can be
REM said plainly and fixed without anybody having to work out what happened.
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

if /i "%~1"=="test" (
    call npm run shim:test
    exit /b %errorlevel%
)

REM The shim tests run here, in a few seconds. They compare the browser
REM crypto and compression against Node's - which is what decides whether a
REM phone can talk to a desktop at all. Cheaper to find out now than after a
REM Gradle build.
echo  [+] Checking the shims first...
call npm run shim:test
if errorlevel 1 (
    echo.
    echo  [X] The shim tests failed. Fix those before building - a phone that
    echo      cannot agree with a desktop about event ids will install fine
    echo      and never receive a message.
    exit /b 1
)

echo.
echo  [+] Building the web bundle...
call npm run build
if errorlevel 1 (
    echo  [X] vite build failed.
    exit /b 1
)

echo  [+] Syncing into the Capacitor project...
call npx cap sync android
if errorlevel 1 (
    echo  [X] cap sync failed.
    exit /b 1
)

set "GRADLE_TASK=assembleDebug"
set "APK_SUBPATH=app\build\outputs\apk\debug\app-debug.apk"
set "APK_NAME=app-debug.apk"

if /i "%~1"=="release" (
    set "GRADLE_TASK=assembleRelease"
    if exist "%~dp0android\keystore.properties" (
        set "APK_SUBPATH=app\build\outputs\apk\release\app-release.apk"
        set "APK_NAME=app-release.apk"
    ) else (
        set "APK_SUBPATH=app\build\outputs\apk\release\app-release-unsigned.apk"
        set "APK_NAME=app-release-unsigned.apk"
    )
)

echo  [+] Running Gradle (%GRADLE_TASK%)...
echo.
REM Called by full path, not a bare filename - some shells this script may
REM run under (CI runners, sandboxed terminals) disable cmd's normal
REM "search the current directory first" behavior, and a bare `gradlew.bat`
REM then resolves against PATH alone and fails with "not recognized" despite
REM the file being right there.
pushd "%~dp0android"
call "%~dp0android\gradlew.bat" %GRADLE_TASK%
set "GRADLE_RESULT=%errorlevel%"
popd

if not "%GRADLE_RESULT%"=="0" (
    echo.
    echo  [X] Gradle build failed.
    exit /b 1
)

if not exist "%~dp0build" mkdir "%~dp0build"
copy /y "%~dp0android\%APK_SUBPATH%" "%~dp0build\%APK_NAME%" >nul

echo.
echo  [+] Built build\%APK_NAME%

if /i "%~1"=="release" (
    if exist "%~dp0android\keystore.properties" (
        echo.
        echo  [+] Signed and ready to install or upload.
    ) else (
        echo.
        echo  [!] This APK is unsigned - Android will refuse to install it as-is.
        echo      Generate android\keystore.properties ^(see build.gradle for the
        echo      format^) and rebuild, or sign it by hand with apksigner.
    )
    exit /b 0
)

REM --- adb, for install/run only ----------------------------------------------
REM
REM The build above never needed this - Gradle reads android\local.properties
REM for the SDK location on its own. Only handing the APK to a device does.

set "ADB=adb"
if defined ANDROID_HOME if exist "%ANDROID_HOME%\platform-tools\adb.exe" set "ADB=%ANDROID_HOME%\platform-tools\adb.exe"
if defined ANDROID_SDK_ROOT if exist "%ANDROID_SDK_ROOT%\platform-tools\adb.exe" set "ADB=%ANDROID_SDK_ROOT%\platform-tools\adb.exe"

if /i "%~1"=="install" (
    echo.
    echo  [+] Installing onto a connected device or emulator...
    "%ADB%" install -r "%~dp0build\%APK_NAME%"
    if errorlevel 1 (
        echo  [X] Install failed - is a device or emulator connected? ^("%ADB%" devices^)
        echo      If adb is not on PATH, set ANDROID_HOME first.
        exit /b 1
    )
    exit /b 0
)

if /i "%~1"=="run" (
    echo.
    echo  [+] Installing and launching...
    "%ADB%" install -r "%~dp0build\%APK_NAME%"
    if errorlevel 1 (
        echo  [X] Install failed - is a device or emulator connected? ^("%ADB%" devices^)
        echo      If adb is not on PATH, set ANDROID_HOME first.
        exit /b 1
    )
    "%ADB%" shell monkey -p chat.reaper.app -c android.intent.category.LAUNCHER 1 >nul
    exit /b 0
)

exit /b 0
