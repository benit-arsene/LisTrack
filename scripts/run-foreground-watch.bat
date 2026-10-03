@echo off
REM LisTrack Windows Desktop - foreground-application detector (PoC).
REM LOCAL DEVELOPMENT ONLY. No network, no storage, no telemetry.
REM Collects ONLY executable identity + foreground state + timestamps.
REM Does NOT collect window contents, keystrokes, screenshots, URLs,
REM passwords, clipboard, microphone, camera, files, or message contents.

setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0foreground-watch.ps1"
endlocal