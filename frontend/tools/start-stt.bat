@echo off
REM Oddvark - start the local speech recognition server (faster-whisper), port 7865.
REM Optional dependency:   pip install faster-whisper
REM For webm/ogg additionally ffmpeg on the PATH (WAV works without it).
REM The first /transcribe downloads the Whisper model automatically (~140 MB for "base").
REM Force CPU:            set STT_DEVICE=cpu   (or config.json -> whisper.device)
REM Different port:       set STT_PORT=7865
echo Starting STT server ... (first /transcribe downloads the Whisper model)
python "%~dp0stt-server.py"
pause
