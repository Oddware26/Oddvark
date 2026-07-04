@echo off
REM Oddvark - start the local XTTS-v2 TTS server (isolated venv tts-venv).
REM First start downloads the XTTS-v2 model (~1.8 GB) and then loads it onto the GPU at launch.
REM Force CPU:            set TTS_DEVICE=cpu
REM Different port:       set TTS_PORT=7862
echo Starting TTS server ... (first start downloads the XTTS-v2 model, takes a while)
"%~dp0tts-venv\Scripts\python.exe" "%~dp0tts-server.py"
pause
