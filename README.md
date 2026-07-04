# 🤖 Jarvis

**Your own AI assistant that lives on your PC. Chat, talk, see, and act — 100% local, powered by [Ollama](https://ollama.com).**

Jarvis pairs a polished chat interface with a fully local AI backend. It chats and speaks with hyper-real offline voices, sees your screen, opens apps, runs commands, builds entire websites live in a side code panel, searches the web, generates images, and completes multi-step tasks on your machine — always asking before it does anything risky.

🔒 **100% local processing. No cloud, no API keys, no subscriptions, no telemetry. Your data never leaves your machine.**

<p align="center">
  <a href="https://discord.gg/VSe7CpmJWG"><img src="https://img.shields.io/badge/Discord-join_the_Oddware_community-5865F2?logo=discord&logoColor=white" alt="Join the Oddware community on Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-a3be8c" alt="MIT license"></a>
  <a href="https://ollama.com"><img src="https://img.shields.io/badge/powered_by-Ollama-222222" alt="Powered by Ollama"></a>
</p>

<p align="center">
  <img src="docs/images/chat.png" alt="Jarvis — a fully local AI chat with Markdown-rich answers" width="90%">
</p>

---

## Why Jarvis?

- 🔒 **Your data stays yours** — every model runs locally through Ollama. All helper servers bind to `127.0.0.1` only. No account, no cloud, no data harvesting. This is non-negotiable.
- 🛠️ **A real work beast, not just a chatbot** — it opens your apps, types for you, reads system info, runs commands, creates files and whole websites, and works through multi-step PC tasks autonomously. Anything risky asks first.
- 🖥️ **It can actually see** — screenshot + a local vision model answer questions about what's on your screen.
- 🎙️ **Voice in, voice out — fully offline** — Whisper speech-to-text and XTTS-v2 hyper-real voices, with a "Hey Jarvis" wake word. No cloud transcription, ever.
- 🎨 **Local image generation** — Z-Image-Turbo renders images right on your GPU.
- 📚 **Models are a first-class feature** — a built-in library of 236+ Ollama models with one-click install, plus **Scan my PC**: it reads your real hardware and recommends the models that actually fit.

---

## 🚀 Install Jarvis

### 1. Install the prerequisites

| Requirement | Where | Note |
| --- | --- | --- |
| [Ollama](https://ollama.com) | all platforms | runs the AI models |
| [Python 3.10+](https://python.org) | all platforms | on Windows, tick **"Add python.exe to PATH"** |

### 2. Get Jarvis

Click the green **Code** button above → **Download ZIP** (then extract), or:

```bash
git clone https://github.com/Oddware26/Jarvis.git
```

### 3. Set it up — one command

| Platform | Do this |
| --- | --- |
| **Windows** | Run **`setup.bat`** once — it installs everything (details below) |
| **macOS / Linux** | Follow the [manual setup](#macos-linux-setup) — same steps as commands |

`setup.bat` installs **all** features in one go and is safe to re-run (finished steps are skipped):
- Ollama models: `llama3.1:8b` (chat + tools), `qwen2.5vl:7b` (screen vision), `nomic-embed-text` (Knowledge/RAG)
- Python packages for PC control, screenshots, clipboard, the autonomous agent, and Whisper voice input
- The XTTS-v2 voice environment (~2 GB; the 1.8 GB voice model downloads on first use)
- The Z-Image environment plus the ~31 GB Z-Image-Turbo weights

> Plan for roughly **45–50 GB** of downloads in total. You can start chatting as soon as the first model is pulled — the heavy steps only power voices, vision, and images.

### 4. Start Jarvis

```bat
Jarvis.bat
```

All services launch automatically and Jarvis opens at **http://localhost:8000** — just start typing, or press the mic and talk.

---

## 💻 System requirements

| | VRAM | Recommended models |
| --- | --- | --- |
| **Most users** | 8 GB+ | `llama3.1:8b` + `qwen2.5vl:7b` *(what `setup.bat` installs)* |
| **Better quality** | 12–16 GB | `qwen3:14b` or `deepseek-r1:14b` for chat |
| **High-end** | 24 GB+ | `qwen3:32b` for chat, `qwen2.5vl:32b` for vision |

Not sure? Open the **Models** page and hit **Scan my PC** — it reads your CPU, RAM, GPU and VRAM, recommends the best-fitting models, and can run a live tokens/sec benchmark.

~50 GB free disk covers the default install. An NVIDIA GPU is strongly recommended for vision, voices, and image generation; chat alone is happy on far less.

---

## ✨ Features

**Chat & UI**
- Clean, fast, modern interface — dark theme, collapsible sidebar, streaming responses
- Rich Markdown: tables, task lists, and syntax-highlighted code
- **Effort slider** (Faster ↔ Genius) that genuinely changes behavior — toggling the model's "thinking" and answer style
- Live **code streaming** into a side panel — watch files and websites render as they're written
- Chat history with search & sort ("Recently used"), persisted across restarts
- English by default, with a one-click **German** toggle
- Custom dropdowns throughout — no clunky native selects

<p align="center">
  <img src="docs/images/code-panel.png" alt="Live code streaming into a side code panel" width="49%">&nbsp;
  <img src="docs/images/models.png" alt="Built-in models library with one-click install" width="49%">
</p>

<p align="center">
  <img src="docs/images/modes.png" alt="Agentic modes — Accept changes, Plan mode, Run without asking, Auto" width="88%">
</p>

<p align="center">
  <img src="docs/images/genius.png" alt="Effort slider — dial from Faster all the way to Genius" width="88%">
</p>

**Models**
- Built-in **Models library** — browse and one-click-install a curated catalog of 236+ Ollama models
- **Scan my PC** — hardware-matched model recommendations with an optional live benchmark
- Streams the full HuggingFace GGUF library on scroll

**Agentic "work beast" abilities**
- 🖥️ **See your screen** — screenshot + a local vision model describes it or answers questions
- 🚀 Open apps & websites, type text, control media & volume, read system info
- 🛠️ Run shell commands and create files or entire websites (rendered live in the side code panel)
- 🌐 Local web search (DuckDuckGo) and page reading
- 🤝 Autonomously complete multi-step PC tasks
- 🔊 Offline speech-to-text (Whisper), hyper-real local voices (XTTS), and local image generation (Z-Image)
- ✅ **Confirm-before-risky** — delete, shutdown, send email, or run command always ask first

<p align="center">
  <img src="docs/images/websearch.png" alt="Local DuckDuckGo web search with a sources pill" width="49%">&nbsp;
  <img src="docs/images/specs.png" alt="Reading real system info through the action server" width="49%">
</p>

<p align="center">
  <img src="docs/images/confirm.png" alt="Confirm-before-risky — a shutdown request always asks first" width="72%">
</p>

<p align="center">
  <img src="docs/images/plusmenu.png" alt="Composer menu — create images, search the web, attach files" width="88%">
</p>

---

## 🕹️ Using it

- **Pick a model** — the model dropdown shows every model you've pulled with Ollama.
- **Effort slider** — drag toward *Smarter* (up to **Genius**) for deeper reasoning, or *Faster* for quick answers.
- **Customize & Knowledge** — set your profile in *Customize* and drop reference documents into *Knowledge*. Both persist across restarts.
- **Talk to it** — press the mic and speak, or enable the "Hey Jarvis" wake word. Answers can be read aloud with XTTS voices.
- **Models page** — browse the catalog, one-click-install, and **Scan my PC** for hardware-matched picks.
- **German** — toggle the language in settings; English is the default.

---

## ⚙️ Configuration

Configuration is optional — Jarvis runs fine with defaults. For email sending (SMTP), app/domain whitelists, the Whisper model size, or a bigger vision model:

```bash
cp frontend/config.example.json frontend/config.json   # then edit it
```

Useful keys: `app_whitelist`, `allowed_domains`, `smtp`, `confirm_required`, `whisper` (model size/device), `vision_model` (e.g. `qwen2.5vl:32b` on big GPUs), `workspace_dir`.

> `config.json` is **gitignored** — your secrets stay out of version control. `config.example.json` is the safe template.

---

<a id="macos-linux-setup"></a>
<details>
<summary><b>🐧 macOS / Linux setup</b></summary>

Same steps as `setup.bat`, by hand:

```bash
# 1) Base: install Ollama (ollama.com) and Python 3.10+, then:
ollama pull llama3.1:8b && ollama pull qwen2.5vl:7b && ollama pull nomic-embed-text
pip install -r frontend/requirements.txt

# 2) XTTS voices (own venv)
python3 -m venv frontend/tools/tts-venv
frontend/tools/tts-venv/bin/pip install torch torchaudio coqui-tts

# 3) Z-Image image generation (own venv + ~31 GB weights)
python3 -m venv frontend/tools/zimage-venv
frontend/tools/zimage-venv/bin/pip install torch torchvision diffusers transformers \
    accelerate safetensors sentencepiece pillow "huggingface_hub[cli]"
frontend/tools/zimage-venv/bin/hf download Tongyi-MAI/Z-Image-Turbo --local-dir ~/Z-Image-Turbo

# 4) Start everything
python3 frontend/start.py
```

If `from diffusers import ZImagePipeline` fails, your diffusers release predates Z-Image support — install it from GitHub: `pip install "git+https://github.com/huggingface/diffusers"`.

</details>

<details>
<summary><b>🔌 What runs where / ports</b></summary>

All of this is installed by `setup.bat` and started by `Jarvis.bat` / `start.py`:

| Service | Port | Needed for |
| --- | --- | --- |
| **Ollama** | `11434` | Chat, all model inference |
| App server (`serve.py`) | `8000` | Serving the app so mic permission sticks |
| Web search (`search-server.py`) | `7863` | Local DuckDuckGo search & page reading |
| Action server (`action-server.py`) | `7864` | PC & browser control, screen vision, files |
| Speech-to-text (`stt-server.py`) | `7865` | Offline voice input (Whisper) |
| Text-to-speech (`tts-server.py`) | `7862` | Hyper-real local voices (XTTS) |
| Image generation (`zimage-server.py`) | `7861` | Local image generation (Z-Image) |

All servers bind to `127.0.0.1` only. The action server is loopback-only by design.

</details>

<details>
<summary><b>🩺 Troubleshooting</b></summary>

- **Stuck on "Connecting…" / no response** — Ollama isn't running. Start it (launch the Ollama app, or run `ollama serve`) and reload.
- **"Failed to fetch" when opening `index.html` directly** — a `file://` page is blocked by Ollama's CORS policy. Always start via `Jarvis.bat` / `python frontend/start.py` (serves from `localhost`), or allow it once with `setx OLLAMA_ORIGINS "*"` and restart Ollama.
- **No models in the dropdown** — `setup.bat` hasn't pulled them yet. Run it, or `ollama pull llama3.1:8b`, then refresh.
- **Microphone doesn't work** — the mic needs a real origin, not `file://`. Start via `Jarvis.bat` / `python frontend/start.py` so the app is served at `http://localhost:8000`, then allow mic access.
- **Two tabs open** — that's fine; Jarvis handles multiple tabs and shares the same local storage.
- **A feature is missing** — its install step probably failed. Re-run `setup.bat` (finished steps are skipped) and check the action server's `GET /capabilities`.
- **Screen vision answers oddly / errors** — pull the vision model (`ollama pull qwen2.5vl:7b`) or set a bigger one in `frontend/config.json` (`"vision_model": "qwen2.5vl:32b"`).

</details>

---

## 🚧 Known limitations

Jarvis is young and built in the open — issues and ideas are very welcome!

- Primary development happens on **Windows**. macOS/Linux use the manual setup and are less battle-tested.
- Voices, vision, and image generation really want an **NVIDIA GPU** — they run on CPU, just slowly.
- Some helper-server console windows still print German status text (being translated).

---

## 🔒 Privacy & safety

- **100% local.** All inference runs through Ollama on your machine. No cloud calls, no telemetry.
- **Loopback only.** Every helper server binds to `127.0.0.1`, so only local processes can reach them.
- **Confirm before risky actions.** Deleting files, powering off, sending email, or running commands always prompt for a quick confirmation first.
- **Sandboxed file work.** File operations default to a workspace folder; sensitive paths require confirmation.

---

## 📄 License

MIT © 2026 [Oddware](https://github.com/Oddware26) — free for everyone, forever. See [`LICENSE`](LICENSE).

Built on local, open-source models via [Ollama](https://ollama.com), with Whisper, XTTS, and Z-Image powering the speech and image features. Bundles the [Rubik](https://github.com/googlefonts/rubik) and [OpenDyslexic](https://opendyslexic.org) fonts (SIL Open Font License) and [Hugeicons Free](https://hugeicons.com) icons (MIT) — full attributions in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). Your data stays on your machine.

## 💬 Community & support

Join the **Oddware** Discord — get help, show what you built with Jarvis, and shape what comes next:

<p align="center">
  <a href="https://discord.gg/VSe7CpmJWG"><img src="https://discord.com/api/guilds/1523026404944380154/widget.png?style=banner2" alt="Join the Oddware Discord server"></a>
</p>

Prefer GitHub? [Report an issue](https://github.com/Oddware26/Jarvis/issues) — bug reports, feature ideas, and contributions are all welcome.
