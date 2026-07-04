@echo off
setlocal EnableExtensions
title Oddvark - start EVERYTHING
cd /d "%~dp0"

echo(
echo ==================================================
echo    O D D V A R K   -   starting all services
echo ==================================================
echo(
echo  Services:  Ollama 11434 . TTS 7862 . Z-Image 7861 . Search 7863 . STT 7865 . Actions 7864 . Web 8000
echo  Cross-platform also works:  python start.py
echo  Each service runs in its OWN window.
echo  Simply comment out anything you don't want below with REM.
echo(

REM =====================================================================
REM  1) Ollama  (LLM backend, http://localhost:11434)
REM =====================================================================
curl -s -o nul --max-time 2 http://127.0.0.1:11434/api/version
if errorlevel 1 (
  echo [1/6] Starting Ollama ...
  start "Oddvark - Ollama" ollama serve
) else (
  echo [1/6] Ollama is already running.
)

REM =====================================================================
REM  2) TTS / XTTS-v2  (hyper-realistic voices, http://localhost:7862)
REM     First start downloads the model (~1.8 GB) - takes a while.
REM =====================================================================
curl -s -o nul --max-time 2 http://127.0.0.1:7862/health
if errorlevel 1 (
  if exist "%~dp0tools\tts-venv\Scripts\python.exe" (
    echo [2/6] Starting TTS server ... first start downloads the model
    start "Oddvark - TTS (XTTS)" "%~dp0tools\start-tts.bat"
  ) else (
    echo [2/6] TTS skipped ^(tools\tts-venv missing^).
  )
) else (
  echo [2/6] TTS server is already running.
)

REM =====================================================================
REM  3) Z-Image  (image generation, http://localhost:7861)
REM =====================================================================
curl -s -o nul --max-time 2 http://127.0.0.1:7861/health
if errorlevel 1 (
  if exist "%~dp0tools\zimage-venv\Scripts\python.exe" (
    echo [3/6] Starting Z-Image server ... first start downloads the model
    start "Oddvark - Z-Image" "%~dp0tools\start-zimage.bat"
  ) else (
    echo [3/6] Z-Image skipped ^(tools\zimage-venv missing^).
  )
) else (
  echo [3/6] Z-Image server is already running.
)

REM =====================================================================
REM  4) Web search  (local DuckDuckGo search for /web + web_search tool, port 7863)
REM =====================================================================
curl -s -o nul --max-time 2 http://127.0.0.1:7863/health
if errorlevel 1 (
  echo [4/6] Starting web search server on http://127.0.0.1:7863 ...
  start "Oddvark - Web search" cmd /k python "%~dp0tools\search-server.py"
) else (
  echo [4/6] Web search server is already running.
)

REM =====================================================================
REM  Whisper STT  (local offline speech recognition, port 7865; needs faster-whisper)
REM =====================================================================
curl -s -o nul --max-time 2 http://127.0.0.1:7865/health
if errorlevel 1 (
  echo [STT] Starting Whisper server on http://127.0.0.1:7865 ...
  start "Oddvark - STT" cmd /k python "%~dp0tools\stt-server.py"
) else (
  echo [STT] Whisper server is already running.
)

REM =====================================================================
REM  5) Actions  (PC/file/browser/vision access for the chat, port 7864)
REM     Full access with confirmation for risky actions. Only 127.0.0.1.
REM =====================================================================
curl -s -o nul --max-time 2 http://127.0.0.1:7864/health
if errorlevel 1 (
  echo [5/6] Starting actions server on http://127.0.0.1:7864 ...
  start "Oddvark - Actions" cmd /k python "%~dp0tools\action-server.py"
) else (
  echo [5/6] Actions server is already running.
)

REM =====================================================================
REM  6) Web server (frontend) + browser  (http://localhost:8000)
REM     Via localhost instead of file:// Chrome remembers the mic permission.
REM =====================================================================
curl -s -o nul --max-time 2 http://127.0.0.1:8000/index.html
if errorlevel 1 (
  echo [6/6] Starting web server on http://localhost:8000 ^(No-Cache^) ...
  start "Oddvark - Web" /d "%~dp0" cmd /k python "%~dp0tools\serve.py"
) else (
  echo [6/6] Web server is already running.
)

REM =====================================================================
REM  Wait for readiness FIRST, THEN open the browser (otherwise the page
REM  loads before Ollama responds -> "Failed to fetch" / Connection refused).
REM =====================================================================
echo(
echo  Waiting for Ollama (max. ~60s, first start takes a while) ...
set /a _o=0
:waitollama
curl -s -o nul --max-time 2 http://127.0.0.1:11434/api/version
if not errorlevel 1 goto ollama_ok
set /a _o+=1
if %_o% geq 30 ( echo  Ollama isn't responding yet - opening anyway ^(reload the page later^). & goto ollama_ok )
timeout /t 2 >nul
goto waitollama
:ollama_ok

echo  Waiting for web server ...
set /a _w=0
:waitweb
curl -s -o nul --max-time 2 http://127.0.0.1:8000/index.html
if not errorlevel 1 goto web_ok
set /a _w+=1
if %_w% geq 20 goto web_ok
timeout /t 1 >nul
goto waitweb
:web_ok

echo  All set - opening Oddvark in the browser ...
start "" http://localhost:8000/index.html

echo(
echo ==================================================
echo  Done. All services run in their own windows.
echo  To stop: close the respective windows.
echo ==================================================
echo(
echo  This window can be closed.
pause >nul
