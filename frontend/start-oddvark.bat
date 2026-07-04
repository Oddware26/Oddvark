@echo off
REM Start Oddvark via http://localhost.
REM IMPORTANT for microphone/wake word: with file:// Chrome forgets the mic permission and keeps
REM asking again. Via http://localhost Chrome remembers the permission permanently
REM (click "Allow while visiting the site" once -> never asked again).
cd /d "%~dp0"
echo Starting local server on http://localhost:8000 ...
start "" python -m http.server 8000
timeout /t 1 >nul
start "" http://localhost:8000/index.html
echo Server is running. Keep this window open. To stop: close the window.
