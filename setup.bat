@echo off
setlocal EnableExtensions
title Jarvis Setup
cd /d "%~dp0"

echo(
echo   ============================================
echo      J A R V I S   -   full setup
echo   ============================================
echo(
echo   This installs EVERYTHING Jarvis can do:
echo     - Ollama models  : chat (llama3.1:8b), vision (qwen2.5vl:7b), embeddings
echo     - Action server  : PC control, screenshots, clipboard, agent (pip packages)
echo     - Voice input    : offline Whisper (faster-whisper)
echo     - Voice output   : XTTS-v2 hyper-real voices (own venv, ~2 GB + 1.8 GB model)
echo     - Image creation : Z-Image-Turbo (own venv + ~31 GB weights)
echo(
echo   Downloads are large (roughly 45-50 GB total). An NVIDIA GPU is strongly
echo   recommended for voices, vision and images. Safe to re-run anytime -
echo   finished steps are skipped.
echo(
pause

REM ---------------------------------------------------------------- prerequisites
where python >nul 2>nul
if errorlevel 1 (
  echo   [!] Python not found. Install Python 3.10+ from https://python.org
  echo       and tick "Add python.exe to PATH" during install. Then re-run setup.bat.
  pause & exit /b 1
)
where ollama >nul 2>nul
if errorlevel 1 (
  echo   [!] Ollama not found. Install it from https://ollama.com then re-run setup.bat.
  pause & exit /b 1
)
curl -s -o nul --max-time 2 http://127.0.0.1:11434/api/version
if errorlevel 1 (
  echo   [*] Starting Ollama ...
  start "Ollama" /min ollama serve
  timeout /t 4 >nul
)

REM ---------------------------------------------------------------- 1) models
echo(
echo   --- [1/5] Ollama models -----------------------------------------
call ollama pull llama3.1:8b
call ollama pull qwen2.5vl:7b
call ollama pull nomic-embed-text

REM ---------------------------------------------------------------- 2) pip extras
echo(
echo   --- [2/5] Action server + Whisper (pip) -------------------------
python -m pip install --upgrade pip >nul
python -m pip install -r "frontend\requirements.txt"
if errorlevel 1 echo   [!] pip step reported errors - PC control/STT may be limited.

REM ---------------------------------------------------------------- 3) XTTS voices
echo(
echo   --- [3/5] XTTS-v2 voices (tools\tts-venv) -----------------------
set "TTSVENV=frontend\tools\tts-venv"
if exist "%TTSVENV%\Scripts\python.exe" (
  echo   [ok] tts-venv already exists - skipping.
) else (
  python -m venv "%TTSVENV%"
  "%TTSVENV%\Scripts\python.exe" -m pip install --upgrade pip >nul
  echo   [*] Installing PyTorch (CUDA 12.4 wheels; falls back to CPU) ...
  "%TTSVENV%\Scripts\python.exe" -m pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124
  if errorlevel 1 "%TTSVENV%\Scripts\python.exe" -m pip install torch torchaudio
  echo   [*] Installing coqui-tts ...
  "%TTSVENV%\Scripts\python.exe" -m pip install coqui-tts
  if errorlevel 1 echo   [!] XTTS install failed - Jarvis will use the browser voice instead.
)

REM ---------------------------------------------------------------- 4) Z-Image venv
echo(
echo   --- [4/5] Z-Image-Turbo (tools\zimage-venv) ----------------------
set "ZIVENV=frontend\tools\zimage-venv"
if exist "%ZIVENV%\Scripts\python.exe" (
  echo   [ok] zimage-venv already exists - skipping.
) else (
  python -m venv "%ZIVENV%"
  "%ZIVENV%\Scripts\python.exe" -m pip install --upgrade pip >nul
  echo   [*] Installing PyTorch (CUDA 12.4 wheels; falls back to CPU) ...
  "%ZIVENV%\Scripts\python.exe" -m pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu124
  if errorlevel 1 "%ZIVENV%\Scripts\python.exe" -m pip install torch torchvision
  echo   [*] Installing diffusers + friends ...
  "%ZIVENV%\Scripts\python.exe" -m pip install diffusers transformers accelerate safetensors sentencepiece pillow "huggingface_hub[cli]"
  REM Z-Image needs ZImagePipeline; use the git version if the release doesn't have it yet.
  "%ZIVENV%\Scripts\python.exe" -c "from diffusers import ZImagePipeline" >nul 2>nul
  if errorlevel 1 (
    echo   [*] Release diffusers lacks ZImagePipeline - installing from GitHub ...
    "%ZIVENV%\Scripts\python.exe" -m pip install "git+https://github.com/huggingface/diffusers"
    "%ZIVENV%\Scripts\python.exe" -c "from diffusers import ZImagePipeline" >nul 2>nul
    if errorlevel 1 echo   [!] ZImagePipeline unavailable (git missing?) - image generation stays off.
  )
)

REM ---------------------------------------------------------------- 5) Z-Image weights
echo(
echo   --- [5/5] Z-Image-Turbo weights (~31 GB, %USERPROFILE%\Z-Image-Turbo) ---
if exist "%USERPROFILE%\Z-Image-Turbo\model_index.json" (
  echo   [ok] weights already present - skipping.
) else (
  "%ZIVENV%\Scripts\hf.exe" download Tongyi-MAI/Z-Image-Turbo --local-dir "%USERPROFILE%\Z-Image-Turbo"
  if errorlevel 1 echo   [!] Weight download failed - re-run setup.bat to resume it.
)

echo(
echo   ============================================
echo      Setup finished.
echo      Start Jarvis with:  Jarvis.bat
echo   ============================================
echo(
pause
