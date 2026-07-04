@echo off
REM Oddvark - start the Z-Image-Turbo image server (isolated venv, uses the global CUDA torch).
REM Default: sequential offload (~50s/image, runs on 12 GB). More VRAM/speed: set ZIMAGE_OFFLOAD=model
REM Override the model folder:                   set ZIMAGE_MODEL=D:\...\Z-Image-Turbo
echo Starting Z-Image server ... (first start downloads the model, takes ~1 min)
"%~dp0zimage-venv\Scripts\python.exe" "%~dp0zimage-server.py"
pause
