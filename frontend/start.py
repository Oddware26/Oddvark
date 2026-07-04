#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Oddvark – cross-platform launcher (Windows / macOS / Linux).

Starts all local services and opens Oddvark in the browser. Nothing is hardcoded to a
specific machine – just clone the repo and run `python start.py`.

    python start.py

Services (each in its own process; missing ones are skipped):
    Ollama        11434  LLM backend            (must be installed: https://ollama.com)
    Web search    7863   tools/search-server.py (stdlib – always runs)
    Actions       7864   tools/action-server.py (PC / file / browser / vision access)
    STT (Whisper) 7865   tools/stt-server.py    (local; needs `pip install faster-whisper`)
    TTS (XTTS)    7862   tools/tts-server.py    (only if tools/tts-venv exists)
    Z-Image       7861   tools/zimage-server.py (only if tools/zimage-venv exists)
    Web           8000   tools/serve.py         (frontend)

To quit: close this window (Ctrl+C) – the services run as child processes and are
terminated along with it.
"""
import os
import sys
import time
import shutil
import socket
import subprocess
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable or "python"
CHILDREN = []


def port_open(port, host="127.0.0.1", timeout=0.4):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def spawn(title, args, cwd=None):
    """Starts a child process in its own window (Windows) or normally (POSIX)."""
    try:
        if os.name == "nt":
            flags = subprocess.CREATE_NEW_CONSOLE  # separate window per service
            p = subprocess.Popen(args, cwd=cwd or HERE, creationflags=flags)
        else:
            p = subprocess.Popen(args, cwd=cwd or HERE)
        CHILDREN.append(p)
        print("  [start] %s" % title)
        return p
    except Exception as e:
        print("  [skipped] %s (%r)" % (title, e))
        return None


def start_service(title, port, args, needed=True, cwd=None):
    if port and port_open(port):
        print("  [running]  %s (port %d)" % (title, port))
        return
    if not needed:
        print("  [missing]  %s – skipped" % title)
        return
    spawn(title, args, cwd=cwd)


def has_venv_python(venv_dir):
    """Path to the python in the venv, or None."""
    cand = [os.path.join(venv_dir, "Scripts", "python.exe"),
            os.path.join(venv_dir, "bin", "python")]
    for c in cand:
        if os.path.isfile(c):
            return c
    return None


def main():
    tools = os.path.join(HERE, "tools")
    print("=" * 54)
    print("   O D D V A R K   –   starting services")
    print("=" * 54)

    # 1) Ollama (only start it if installed and not already running)
    if port_open(11434):
        print("  [running]  Ollama (11434)")
    elif shutil.which("ollama"):
        spawn("Ollama 11434", ["ollama", "serve"])
    else:
        print("  [missing]  Ollama not found – please install: https://ollama.com")

    # 2) Core servers (pure stdlib – always run)
    start_service("Web search 7863", 7863, [PY, os.path.join(tools, "search-server.py")])
    start_service("Actions 7864", 7864, [PY, os.path.join(tools, "action-server.py")])
    start_service("STT/Whisper 7865", 7865, [PY, os.path.join(tools, "stt-server.py")])

    # 3) Optional model servers (only if their venv exists)
    tts_py = has_venv_python(os.path.join(tools, "tts-venv"))
    if tts_py and not port_open(7862):
        spawn("TTS/XTTS 7862", [tts_py, os.path.join(tools, "tts-server.py")])
    elif port_open(7862):
        print("  [running]  TTS (7862)")
    else:
        print("  [missing]  TTS (tools/tts-venv) – browser voice will be used")

    zi_py = has_venv_python(os.path.join(tools, "zimage-venv"))
    if zi_py and not port_open(7861):
        spawn("Z-Image 7861", [zi_py, os.path.join(tools, "zimage-server.py")])
    elif port_open(7861):
        print("  [running]  Z-Image (7861)")
    else:
        print("  [missing]  Z-Image (tools/zimage-venv) – image generation disabled")

    # 4) Web server (frontend)
    start_service("Web 8000", 8000, [PY, os.path.join(tools, "serve.py")])

    # 5) Wait for the web server, then open the browser
    print("-" * 54)
    print("  Waiting for web server (http://localhost:8000) …")
    for _ in range(40):
        if port_open(8000):
            break
        time.sleep(0.5)
    url = "http://localhost:8000/index.html"
    print("  Opening Oddvark: %s" % url)
    try:
        webbrowser.open(url)
    except Exception:
        pass

    print("=" * 54)
    print("  Done. Services are running. To quit: Ctrl+C or close the window.")
    print("  Tip: microphone button in the chat = talk; 'Hey Jarvis' as the wake word.")
    print("=" * 54)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("\n  Stopping services …")
        for p in CHILDREN:
            try:
                p.terminate()
            except Exception:
                pass


if __name__ == "__main__":
    main()
