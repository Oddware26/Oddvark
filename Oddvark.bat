@echo off
setlocal EnableExtensions
title Oddvark
cd /d "%~dp0"

echo(
echo   ============================================
echo      O D D V A R K   -   starting ...
echo   ============================================
echo(

REM --- 1) Ensure Ollama is available (the only hard requirement). -------------
where ollama >nul 2>nul
if errorlevel 1 (
  echo   [!] Ollama is not installed.
  echo       Please install it once from https://ollama.com, then pull a model:
  echo           ollama pull llama3.2
  echo(
  echo   After that, start this file again.
  echo(
  pause
  exit /b 1
)
curl -s -o nul --max-time 2 http://127.0.0.1:11434/api/version
if errorlevel 1 (
  echo   [*] Starting Ollama ...
  start "Ollama" /min ollama serve
)

REM --- 2) Full mode with Python (web search, PC control, voices) OR -----------
REM        core mode without extras: open index.html directly (only Ollama needed). --
where python >nul 2>nul
if not errorlevel 1 (
  echo   [*] Python found - starting the full experience ^(incl. web search, PC control^).
  echo(
  python "%~dp0frontend\start.py"
  goto :eof
)

echo   [i] Python not found - starting Oddvark in core mode.
echo       Chat, models, settings and history work fully.
echo       For web search / PC control / custom voices, install Python
echo       ^(https://python.org^) once later and start this file again.
echo(
echo   Waiting briefly for Ollama ...
set /a _o=0
:waitollama
curl -s -o nul --max-time 2 http://127.0.0.1:11434/api/version
if not errorlevel 1 goto ollama_ok
set /a _o+=1
if %_o% geq 20 goto ollama_ok
timeout /t 2 >nul
goto waitollama
:ollama_ok

start "" "%~dp0frontend\index.html"
echo(
echo   Oddvark has been opened in the browser. This window can be closed.
timeout /t 4 >nul
