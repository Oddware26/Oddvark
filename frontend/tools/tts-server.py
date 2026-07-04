"""
Oddvark - local XTTS-v2 TTS server (hyper-realistic, multilingual, many voices).

Loads Coqui XTTS-v2 (coqui-tts) and exposes a small HTTP API that the
Oddvark frontend (file:// or http://localhost) calls via fetch:

  GET  /health   -> {"ready": bool, "error": str|null, "voices": int, "languages": [...]}
  GET  /voices   -> {"voices": [speakers...], "languages": [{code,label}...]}
  POST /speak     -> audio/wav (binary)
       Body: {"text": "...", "voice": "speaker name", "language": "de", "speed": 1.0,
              "speaker_wav": "data:audio/wav;base64,..."?}   # speaker_wav = voice cloning (optional)

Start:
  tools/start-tts.bat   (uses tools/tts-venv)

Requirements: coqui-tts + torch(CUDA) in tools/tts-venv (isolated).
XTTS-v2: 17 languages incl. German, ~58 built-in speakers, voice cloning from a ~6s sample.
"""
import io
import os
import json
import base64
import wave
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("COQUI_TOS_AGREED", "1")   # accept the license non-interactively
os.environ.setdefault("COQUI_TTS_NO_MECAB", "1")

HOST = os.environ.get("TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("TTS_PORT", "7862"))
MODEL = os.environ.get("TTS_MODEL", "tts_models/multilingual/multi-dataset/xtts_v2")
DEVICE = os.environ.get("TTS_DEVICE", "cuda")  # "cuda" or "cpu"

# Friendly language names for the codes supported by the model
LANG_LABELS = {
    "de": "Deutsch", "en": "English", "es": "Espanol", "fr": "Francais", "it": "Italiano",
    "pt": "Portugues", "pl": "Polski", "tr": "Turkce", "ru": "Russkij", "nl": "Nederlands",
    "cs": "Cestina", "ar": "Arabic", "zh-cn": "Chinese", "ja": "Japanese", "hu": "Magyar",
    "ko": "Korean", "hi": "Hindi",
}

tts = None
ready = False
load_err = None
voices = []
languages = []
sample_rate = 24000
gen_lock = threading.Lock()   # GPU-bound -> only one synthesis at a time


def load_model():
    global tts, ready, load_err, voices, languages, sample_rate
    try:
        import torch
        from TTS.api import TTS as CoquiTTS
        print("[tts] loading %s on %s ..." % (MODEL, DEVICE), flush=True)
        dev = DEVICE if (DEVICE != "cuda" or torch.cuda.is_available()) else "cpu"
        m = CoquiTTS(MODEL, progress_bar=False).to(dev)
        tts = m
        try:
            voices = list(m.synthesizer.tts_model.speaker_manager.name_to_id.keys())
        except Exception:
            voices = []
        try:
            languages = list(m.synthesizer.tts_model.config.languages)
        except Exception:
            languages = list(LANG_LABELS.keys())
        try:
            sample_rate = int(m.synthesizer.output_sample_rate)
        except Exception:
            sample_rate = 24000
        ready = True
        print("[tts] ready. %d voices, %d languages, %d Hz (%s)." % (len(voices), len(languages), sample_rate, dev), flush=True)
    except Exception as e:  # noqa: BLE001
        load_err = repr(e)
        print("[tts] LOAD ERROR:", e, flush=True)


def _wav_bytes(samples):
    """float list/np array (-1..1) -> 16-bit PCM WAV (stdlib, no extra deps)."""
    import numpy as np
    a = np.asarray(samples, dtype="float32")
    a = np.clip(a, -1.0, 1.0)
    pcm = (a * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


def _decode_wav_to_temp(data_url):
    """data:audio/...;base64,XXXX -> temp .wav path (for voice cloning)."""
    s = data_url or ""
    if "," in s and s.strip().startswith("data:"):
        s = s.split(",", 1)[1]
    raw = base64.b64decode(s)
    fd, path = tempfile.mkstemp(suffix=".wav")
    with os.fdopen(fd, "wb") as f:
        f.write(raw)
    return path


def synth(text, voice, language, speed, speaker_wav):
    kwargs = {"text": text, "language": language or "de", "split_sentences": True}
    try:
        if speed and float(speed) != 1.0:
            kwargs["speed"] = float(speed)
    except Exception:
        pass
    tmp = None
    if speaker_wav:
        tmp = _decode_wav_to_temp(speaker_wav)
        kwargs["speaker_wav"] = tmp
    elif voice and voice in voices:
        kwargs["speaker"] = voice
    elif voices:
        kwargs["speaker"] = voices[0]
    try:
        with gen_lock:
            wav = tts.tts(**kwargs)
        return _wav_bytes(wav)
    finally:
        if tmp:
            try: os.remove(tmp)
            except Exception: pass


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _wav(self, data):
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {"ready": ready, "error": load_err, "voices": len(voices),
                             "languages": [c for c in languages]})
        elif self.path.startswith("/voices"):
            langs = [{"code": c, "label": LANG_LABELS.get(c, c)} for c in languages]
            self._json(200, {"voices": voices, "languages": langs})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/speak"):
            self._json(404, {"error": "not found"})
            return
        if not ready:
            self._json(503, {"error": load_err or "model still loading - try again shortly."})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:  # noqa: BLE001
            self._json(400, {"error": "invalid body: " + repr(e)})
            return
        text = (data.get("text") or "").strip()
        if not text:
            self._json(400, {"error": "text missing"})
            return
        try:
            wav = synth(text, data.get("voice"), data.get("language"),
                        data.get("speed"), data.get("speaker_wav"))
            self._wav(wav)
        except Exception as e:  # noqa: BLE001
            self._json(500, {"error": repr(e)})

    def log_message(self, *args):
        return


if __name__ == "__main__":
    threading.Thread(target=load_model, daemon=True).start()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print("[tts] HTTP at http://%s:%d  (GET /health, GET /voices, POST /speak)" % (HOST, PORT), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
