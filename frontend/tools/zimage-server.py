"""
Oddvark – local Z-Image-Turbo image server.

Loads Z-Image-Turbo (diffusers ZImagePipeline) and exposes a small HTTP API that
the Oddvark frontend (file:// or http://localhost) calls via fetch:

  GET  /health            -> {"ready": bool, "error": str|null, "offload": str}
  POST /generate          -> {"image": "data:image/png;base64,..."}
       Body: {"prompt": "...", "steps": 9, "width": 1024, "height": 1024, "seed": 123?}

Start:
  python tools/zimage-server.py
  # For 12 GB VRAM, be more frugal if needed:  set ZIMAGE_OFFLOAD=sequential  (slower, but fits safely)

Requirements: torch (CUDA) + recent diffusers (with ZImagePipeline):
  pip install git+https://github.com/huggingface/diffusers
"""
import io
import os
import json
import base64
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Local model folder (downloaded via `hf download Tongyi-MAI/Z-Image-Turbo`).
# Set your own path via the ZIMAGE_MODEL environment variable; default: ~/Z-Image-Turbo.
MODEL_DIR = os.environ.get("ZIMAGE_MODEL", os.path.join(os.path.expanduser("~"), "Z-Image-Turbo"))
HOST = os.environ.get("ZIMAGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("ZIMAGE_PORT", "7861"))
# "sequential" = very frugal (~2.4 GB VRAM, runs on 12 GB; ~50 s/image) – default, verified on RTX 4070.
# "model" = enable_model_cpu_offload (faster, but needs ~13 GB+ -> OOM risk on 12 GB).
# "none" = everything on the GPU (only for >=24 GB).
OFFLOAD = os.environ.get("ZIMAGE_OFFLOAD", "sequential").lower()

pipe = None       # text -> image
edit_pipe = None  # image + prompt -> edited image (img2img), shares the weights with pipe
ready = False
load_err = None
gen_lock = threading.Lock()  # GPU-bound -> only one generation at a time


def load_model():
    global pipe, edit_pipe, ready, load_err
    try:
        import torch
        from diffusers import ZImagePipeline, ZImageImg2ImgPipeline
        print("[zimage] loading model from %s (offload=%s) …" % (MODEL_DIR, OFFLOAD), flush=True)
        p = ZImagePipeline.from_pretrained(
            MODEL_DIR,
            torch_dtype=torch.bfloat16,
            low_cpu_mem_usage=False,
        )
        if OFFLOAD == "sequential":
            p.enable_sequential_cpu_offload()
        elif OFFLOAD == "none":
            p.to("cuda")
        else:
            p.enable_model_cpu_offload()
        # Img2img pipeline from the same components -> no additional memory/download,
        # reuses p's modules (already hooked via offload).
        ep = ZImageImg2ImgPipeline(**p.components)
        pipe = p
        edit_pipe = ep
        ready = True
        print("[zimage] ready (text->image + image editing).", flush=True)
    except Exception as e:  # noqa: BLE001
        load_err = repr(e)
        print("[zimage] LOAD ERROR:", e, flush=True)


def _decode_image(data):
    """data:image/...;base64,XXXX  or plain base64 -> PIL.Image (RGB)."""
    from PIL import Image
    s = data or ""
    if "," in s and s.strip().startswith("data:"):
        s = s.split(",", 1)[1]
    raw = base64.b64decode(s)
    return Image.open(io.BytesIO(raw)).convert("RGB")


def _fit_size(img, target=1024, mult=16):
    """Scale to ~target (longer side), keep the aspect ratio, round dimensions to multiples of mult."""
    w, h = img.size
    scale = float(target) / float(max(w, h))
    nw = max(mult, int(round(w * scale / mult)) * mult)
    nh = max(mult, int(round(h * scale / mult)) * mult)
    from PIL import Image
    return img.resize((nw, nh), Image.LANCZOS)


def edit(prompt, image, strength, steps):
    init = _fit_size(_decode_image(image))
    with gen_lock:
        out = edit_pipe(
            prompt=prompt,
            image=init,
            strength=strength,
            num_inference_steps=steps,
            guidance_scale=0.0,
        ).images[0]
    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def generate(prompt, steps, width, height, seed):
    import torch
    gen = None
    if seed is not None:
        try:
            gen = torch.Generator("cuda").manual_seed(int(seed))
        except Exception:
            gen = None
    with gen_lock:
        image = pipe(
            prompt=prompt,
            height=height,
            width=width,
            num_inference_steps=steps,
            guidance_scale=0.0,  # Turbo: guidance 0
            generator=gen,
        ).images[0]
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send(200, {"ready": ready, "error": load_err, "offload": OFFLOAD})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        is_gen = self.path.startswith("/generate")
        is_edit = self.path.startswith("/edit")
        if not (is_gen or is_edit):
            self._send(404, {"error": "not found"})
            return
        if not ready:
            self._send(503, {"error": load_err or "model still loading – please try again shortly."})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:  # noqa: BLE001
            self._send(400, {"error": "invalid body: " + repr(e)})
            return
        prompt = (data.get("prompt") or "").strip()
        if not prompt:
            self._send(400, {"error": "prompt missing"})
            return
        try:
            if is_edit:
                image = data.get("image")
                if not image:
                    self._send(400, {"error": "image missing"})
                    return
                strength = float(data.get("strength") or 0.72)
                steps = int(data.get("steps") or 12)
                b64 = edit(prompt, image, strength, steps)
            else:
                steps = int(data.get("steps") or 9)
                width = int(data.get("width") or 1024)
                height = int(data.get("height") or 1024)
                seed = data.get("seed", None)
                b64 = generate(prompt, steps, width, height, seed)
            self._send(200, {"image": "data:image/png;base64," + b64})
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": repr(e)})

    def log_message(self, *args):  # quiet server
        return


if __name__ == "__main__":
    threading.Thread(target=load_model, daemon=True).start()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print("[zimage] HTTP at http://%s:%d  (POST /generate, POST /edit, GET /health)" % (HOST, PORT), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
