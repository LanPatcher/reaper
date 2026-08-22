@echo off
setlocal enabledelayedexpansion

REM ===========================================================================
REM  Build EVERY Reaper target and drop all the artifacts into one folder.
REM
REM  This does not reimplement any build - it calls each sub-project's own
REM  build script (the ones that already work) and then copies the result
REM  into a single output folder (Deploy\ by default).
REM
REM  Targets and what lands in Deploy\:
REM    desktop  ->  reaper-setup.exe        (Windows installer, via pnpm make)
REM    android  ->  app-debug.apk           (built locally with the Android SDK)
REM    web      ->  reaper-web.zip          (the static dist\ site, zipped)
REM    ios      ->  Reaper-unsigned.ipa     (compiled on a hosted Mac; needs
REM                                          CM_API_TOKEN and CM_APP_ID set)
REM
REM  Usage:
REM    build-all.bat                     build all four
REM    build-all.bat desktop android     build only those listed
REM    build-all.bat clean               clean, then build all four
REM    build-all.bat desktop clean       clean, then build only desktop
REM
REM  Override the output folder by setting DEPLOY_DIR first, e.g.:
REM    set DEPLOY_DIR=C:\Users\catoa\Desktop\out
REM    build-all.bat
REM
REM  Nothing here stops on the first failure: every selected target is
REM  attempted, and a summary at the end says which ones produced a file.
REM  iOS in particular is expected to be skipped on machines without the
REM  Codemagic tokens - that does not fail the rest of the run.
REM ===========================================================================

cd /d "%~dp0"
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

if defined DEPLOY_DIR (set "DEPLOY=%DEPLOY_DIR%") else (set "DEPLOY=%ROOT%\Deploy")

REM --- Parse arguments -------------------------------------------------------

set "DO_DESKTOP="
set "DO_ANDROID="
set "DO_WEB="
set "DO_IOS="
set "CLEAN="
set "ANY_SELECTED="

:parse_args
if "%~1"=="" goto parsed_args
if /i "%~1"=="clean"   ( set "CLEAN=clean"      & shift & goto parse_args )
if /i "%~1"=="desktop" ( set "DO_DESKTOP=1" & set "ANY_SELECTED=1" & shift & goto parse_args )
if /i "%~1"=="android" ( set "DO_ANDROID=1" & set "ANY_SELECTED=1" & shift & goto parse_args )
if /i "%~1"=="web"     ( set "DO_WEB=1"     & set "ANY_SELECTED=1" & shift & goto parse_args )
if /i "%~1"=="ios"     ( set "DO_IOS=1"     & set "ANY_SELECTED=1" & shift & goto parse_args )
echo  [!] Ignoring unknown option: %~1
shift
goto parse_args
:parsed_args

REM No target named means "all of them".
if not defined ANY_SELECTED (
    set "DO_DESKTOP=1"
    set "DO_ANDROID=1"
    set "DO_WEB=1"
    set "DO_IOS=1"
)

REM --- Status, filled in as we go ("skipped" until a target actually runs) ----

set "R_DESKTOP=skipped"
set "R_ANDROID=skipped"
set "R_WEB=skipped"
set "R_IOS=skipped"

echo.
echo  ===========================================================
echo   Reaper - build everything
echo  ===========================================================
echo   Output folder:  %DEPLOY%
if defined CLEAN echo   Clean build:    yes
echo  ===========================================================

if not exist "%DEPLOY%" mkdir "%DEPLOY%" >nul 2>&1
if not exist "%DEPLOY%" (
    echo.
    echo  [X] Could not create the output folder: %DEPLOY%
    goto summary
)

REM ===========================================================================
REM  DESKTOP  (Windows installer)
REM ===========================================================================
if not defined DO_DESKTOP goto after_desktop

echo.
echo  -----------------------------------------------------------
echo   [1] Desktop  (for-desktop-p2p)
echo  -----------------------------------------------------------
if not exist "%ROOT%\for-desktop-p2p\build.bat" (
    echo  [X] for-desktop-p2p\build.bat not found - skipping.
    set "R_DESKTOP=missing script"
    goto after_desktop
)

REM Windows commonly locks last build's app.asar (antivirus scanning it, or a
REM running Reaper), and forge then dies with "EBUSY ... unlink app.asar" when
REM it tries to replace it. Removing the stale package dir first means there is
REM nothing to unlink, which avoids the error in the common case.
if exist "%ROOT%\for-desktop-p2p\out\Reaper-win32-x64" (
    rmdir /s /q "%ROOT%\for-desktop-p2p\out\Reaper-win32-x64" >nul 2>&1
)

call "%ROOT%\for-desktop-p2p\build.bat" %CLEAN%
if not errorlevel 1 goto desktop_copy

REM One automatic retry: the EBUSY lock is usually a brief antivirus scan
REM window, so a short wait plus a fresh package dir often gets through.
echo.
echo  [!] Desktop build failed. This is usually a transient file lock on
echo      app.asar (antivirus, or a running Reaper). Retrying once in 5s...
echo      If it fails again, close any running Reaper and exclude this folder
echo      from Windows Defender, then run:  build-all.bat desktop
timeout /t 5 /nobreak >nul
if exist "%ROOT%\for-desktop-p2p\out\Reaper-win32-x64" (
    rmdir /s /q "%ROOT%\for-desktop-p2p\out\Reaper-win32-x64" >nul 2>&1
)
call "%ROOT%\for-desktop-p2p\build.bat"
if errorlevel 1 (
    echo  [X] Desktop build failed twice.
    set "R_DESKTOP=build FAILED (app.asar locked - see note above)"
    goto after_desktop
)

:desktop_copy
set "DESK_SRC=%ROOT%\for-desktop-p2p\out\make\squirrel.windows\x64\reaper-setup.exe"
if exist "%DESK_SRC%" (
    copy /y "%DESK_SRC%" "%DEPLOY%\reaper-setup.exe" >nul
    if errorlevel 1 ( set "R_DESKTOP=built, COPY FAILED" ) else ( set "R_DESKTOP=OK -> reaper-setup.exe" )
) else (
    REM Fall back to the portable zip if the installer isn't where we expect.
    set "DESK_ZIP="
    for /f "delims=" %%z in ('dir /b /o-d "%ROOT%\for-desktop-p2p\out\make\zip\win32\x64\*.zip" 2^>nul') do (
        if not defined DESK_ZIP set "DESK_ZIP=%%z"
    )
    if defined DESK_ZIP (
        copy /y "%ROOT%\for-desktop-p2p\out\make\zip\win32\x64\!DESK_ZIP!" "%DEPLOY%\!DESK_ZIP!" >nul
        set "R_DESKTOP=OK -> !DESK_ZIP! (installer not found, used portable zip)"
    ) else (
        echo  [X] Build succeeded but no installer or zip was found under out\make.
        set "R_DESKTOP=built, no artifact found"
    )
)
:after_desktop

REM ===========================================================================
REM  ANDROID  (APK)
REM ===========================================================================
if not defined DO_ANDROID goto after_android

echo.
echo  -----------------------------------------------------------
echo   [2] Android  (for-android-p2p)
echo  -----------------------------------------------------------
if not exist "%ROOT%\for-android-p2p\build-android.bat" (
    echo  [X] for-android-p2p\build-android.bat not found - skipping.
    set "R_ANDROID=missing script"
    goto after_android
)

REM The android script wipes and reinstalls on "clean"; otherwise no arg does
REM a normal debug build -> build\app-debug.apk.
if defined CLEAN call "%ROOT%\for-android-p2p\build-android.bat" clean
call "%ROOT%\for-android-p2p\build-android.bat"
if errorlevel 1 (
    echo  [X] Android build failed.
    set "R_ANDROID=build FAILED"
    goto after_android
)

set "APK_SRC=%ROOT%\for-android-p2p\build\app-debug.apk"
if exist "%APK_SRC%" (
    copy /y "%APK_SRC%" "%DEPLOY%\app-debug.apk" >nul
    if errorlevel 1 ( set "R_ANDROID=built, COPY FAILED" ) else ( set "R_ANDROID=OK -> app-debug.apk" )
) else (
    echo  [X] Build succeeded but build\app-debug.apk was not found.
    set "R_ANDROID=built, no artifact found"
)
:after_android

REM ===========================================================================
REM  WEB  (static site -> zip)
REM ===========================================================================
if not defined DO_WEB goto after_web

echo.
echo  -----------------------------------------------------------
echo   [3] Web  (for-web-p2p)
echo  -----------------------------------------------------------
if not exist "%ROOT%\for-web-p2p\build.bat" (
    echo  [X] for-web-p2p\build.bat not found - skipping.
    set "R_WEB=missing script"
    goto after_web
)

call "%ROOT%\for-web-p2p\build.bat" %CLEAN%
if errorlevel 1 (
    echo  [X] Web build failed.
    set "R_WEB=build FAILED"
    goto after_web
)

if exist "%ROOT%\for-web-p2p\dist\index.html" (
    REM The web output is a folder, not a single file. Zip it so one artifact
    REM lands in Deploy alongside the others.
    if exist "%DEPLOY%\reaper-web.zip" del /q "%DEPLOY%\reaper-web.zip" >nul 2>&1
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "Compress-Archive -Path '%ROOT%\for-web-p2p\dist\*' -DestinationPath '%DEPLOY%\reaper-web.zip' -Force" >nul 2>&1
    if exist "%DEPLOY%\reaper-web.zip" (
        set "R_WEB=OK -> reaper-web.zip"
    ) else (
        echo  [X] Could not zip the web dist folder.
        set "R_WEB=built, zip FAILED"
    )
) else (
    echo  [X] Build succeeded but for-web-p2p\dist\index.html was not found.
    set "R_WEB=built, no artifact found"
)
:after_web

REM ===========================================================================
REM  iOS  (remote Mac build -> IPA)
REM ===========================================================================
if not defined DO_IOS goto after_ios

echo.
echo  -----------------------------------------------------------
echo   [4] iOS  (for-ios-p2p)
echo  -----------------------------------------------------------
if not exist "%ROOT%\for-ios-p2p\build-ios.bat" (
    echo  [X] for-ios-p2p\build-ios.bat not found - skipping.
    set "R_IOS=missing script"
    goto after_ios
)

if not defined CM_API_TOKEN goto ios_no_tokens
if not defined CM_APP_ID goto ios_no_tokens
goto ios_build

:ios_no_tokens
echo  [!] Skipping iOS: CM_API_TOKEN and/or CM_APP_ID are not set.
echo      iOS compiles on a hosted Mac (Codemagic). Set both, in a terminal:
echo        setx CM_API_TOKEN "..."
echo        setx CM_APP_ID "..."
echo      then open a NEW terminal and re-run with:  build-all.bat ios
set "R_IOS=skipped (no Codemagic tokens)"
goto after_ios

:ios_build
call "%ROOT%\for-ios-p2p\build-ios.bat"
if errorlevel 1 (
    echo  [X] iOS build failed.
    set "R_IOS=build FAILED"
    goto after_ios
)

set "IPA_SRC="
for /f "delims=" %%i in ('dir /b /o-d "%ROOT%\for-ios-p2p\build\*.ipa" 2^>nul') do (
    if not defined IPA_SRC set "IPA_SRC=%%i"
)
if defined IPA_SRC (
    copy /y "%ROOT%\for-ios-p2p\build\!IPA_SRC!" "%DEPLOY%\!IPA_SRC!" >nul
    if errorlevel 1 ( set "R_IOS=built, COPY FAILED" ) else ( set "R_IOS=OK -> !IPA_SRC!" )
) else (
    echo  [X] No new .ipa was produced. The remote Mac build did not finish -
    echo      check the Codemagic error above (a 403 means the token or app id
    echo      lacks access to that app; a 404 means the app id is wrong).
    set "R_IOS=no IPA (remote build did not produce one)"
)
:after_ios

REM ===========================================================================
REM  Summary
REM ===========================================================================
:summary
echo.
echo  ===========================================================
echo   Summary  (everything is in %DEPLOY%)
echo  ===========================================================
echo    desktop : !R_DESKTOP!
echo    android : !R_ANDROID!
echo    web     : !R_WEB!
echo    ios     : !R_IOS!
echo  ===========================================================
echo.
echo  Contents of the output folder:
dir /b "%DEPLOY%" 2>nul
echo.

REM Only pause when double-clicked from Explorer, so this stays usable in CI.
echo %CMDCMDLINE% | findstr /i /c:"%~nx0" >nul && pause
exit /b 0
