# Oddvark - local web search (DuckDuckGo, no API key), port 7863.
# Python standard library only (like serve.py): no venv, no dependencies.
#   GET /health           -> {"ok": true}
#   GET /search?q=..&n=8  -> {"results": [{"title","url","snippet"}, ...]}
# Sources: html.duckduckgo.com (primary), lite.duckduckgo.com (fallback).
import json
import re
import datetime
import html as htmllib
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 7863
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")


def _fetch(url, data=None, extra_headers=None):
    headers = {
        "User-Agent": UA,
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.7",
    }
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.read().decode("utf-8", "replace")


def _fetch_resp(url, extra_headers=None):
    # Like _fetch, but additionally returns the Link header (for HF cursor pagination).
    headers = {"User-Agent": UA, "Accept-Language": "en;q=0.9,de;q=0.7"}
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read().decode("utf-8", "replace"), r.headers.get("Link", "")


def _strip(s):
    return htmllib.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


def _unwrap(url):
    # DDG wraps target URLs as //duckduckgo.com/l/?uddg=<url-encoded>&rut=...
    if url.startswith("//"):
        url = "https:" + url
    m = re.search(r"[?&]uddg=([^&]+)", url)
    if m:
        url = urllib.parse.unquote(m.group(1))
    return url if url.startswith("http") else ""


def _search_html(q, n):
    body = _fetch("https://html.duckduckgo.com/html/?" +
                  urllib.parse.urlencode({"q": q, "kl": "de-de"}))
    out = []
    blocks = re.findall(
        r'<div[^>]+class="[^"]*result__body[^"]*".*?(?=<div[^>]+class="[^"]*result__body|\Z)',
        body, re.S)
    for block in blocks:
        a = re.search(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', block, re.S)
        if not a:
            continue
        url = _unwrap(htmllib.unescape(a.group(1)))
        if not url or "duckduckgo.com" in url:
            continue
        sn = re.search(r'class="result__snippet"[^>]*>(.*?)</a>', block, re.S)
        out.append({"title": _strip(a.group(2)), "url": url,
                    "snippet": _strip(sn.group(1)) if sn else ""})
        if len(out) >= n:
            break
    return out


def _search_lite(q, n):
    body = _fetch("https://lite.duckduckgo.com/lite/",
                  data=urllib.parse.urlencode({"q": q, "kl": "de-de"}).encode())
    out = []
    # Lite: table rows with <a rel="nofollow" href="...">title</a>, followed by a result-snippet cell.
    rows = re.split(r"<tr", body)
    cur = None
    for row in rows:
        a = re.search(r'<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', row, re.S)
        if a:
            url = _unwrap(htmllib.unescape(a.group(1)))
            cur = {"title": _strip(a.group(2)), "url": url, "snippet": ""} if url else None
            continue
        sn = re.search(r'class="result-snippet"[^>]*>(.*?)</td>', row, re.S)
        if sn and cur:
            cur["snippet"] = _strip(sn.group(1))
            out.append(cur)
            cur = None
            if len(out) >= n:
                break
    return out


def search(q, n):
    try:
        res = _search_html(q, n)
        if res:
            return res
    except Exception:
        pass
    return _search_lite(q, n)


# ---- Ollama library (ollama.com/search) paginated as compact JSON ---------
# Fetches ONE page (20 models) of the public Ollama search and parses the model cards.
# This lets the models page lazily load the ENTIRE library while scrolling, without bundling everything.
#
# IMPORTANT (determined by reverse engineering): ollama.com/search paginates via htmx.
#   - The page param is ?page=N (NOT ?p=N).
#   - Without the header "HX-Request: true", page >1 returns an EMPTY body.
#   - An empty query q="" returns only ~236 curated/recent models (≈ the bundled catalog);
#     with a real query q it searches the full community library (~10k) and paginates deep.
#   - Optional: c=<vision|tools|thinking|embedding|cloud> (capability), o=<newest|popular> (sort order).
def _ollama_library(q, page, cap="", order=""):
    try:
        p = max(1, int(page or 1))
    except (TypeError, ValueError):
        p = 1
    params = {"q": q or "", "page": p}
    if cap:
        params["c"] = cap
    if order:
        params["o"] = order
    url = "https://ollama.com/search?" + urllib.parse.urlencode(params)
    body = _fetch(url, extra_headers={"HX-Request": "true", "HX-Target": "searchresults"})
    out = []
    # Robust: split on the x-test-model markers (no </li> dependency).
    for chunk in re.split(r"x-test-model", body)[1:]:
        nm = re.search(r'href="/library/([^"]+)"', chunk)
        if not nm:
            continue
        pulls = re.search(r"x-test-pull-count[^>]*>([^<]+)", chunk)
        upd = re.search(r"x-test-updated[^>]*>([^<]+)", chunk)
        desc = re.search(r"<p[^>]*>(.*?)</p>", chunk, re.S)
        out.append({
            "name": nm.group(1),
            "description": _strip(desc.group(1)) if desc else "",
            "capabilities": [c.strip() for c in re.findall(r"x-test-capability[^>]*>([^<]+)", chunk)],
            "sizes": [s.strip() for s in re.findall(r"x-test-size[^>]*>([^<]+)", chunk)],
            "pulls": pulls.group(1).strip() if pulls else "",
            "updated": upd.group(1).strip() if upd else "",
            "source": "ollama",
        })
    return {"models": out, "page": p, "has_more": len(out) >= 20}


# ---- HuggingFace GGUF library (the actual ~ten thousand models) ---------
# ollama.com/search returns only the curated set. The REALLY large library is
# the GGUF repos on HuggingFace – Ollama can run any of them directly:
#     ollama run hf.co/<user>/<repo>
# The HF API is paginated (cursor via Link header, unlimited depth) and sorted by
# downloads, so the models page can stream it lazily while scrolling – nothing bundled.
# The HF API's CORS is restricted to huggingface.co -> access MUST go through this proxy.
_HF_SKIP_TAG = re.compile(
    r"^(i?q\d[\w.]*|f16|bf16|fp16|fp8|\d+-?bit|gguf|quantized|conversational|"
    r"text-generation-inference|autotrain_compatible|endpoints_compatible|"
    r"region:[\w-]+|license:[\w.\-]+|base_model:.*|dataset:.*|arxiv:.*|doi:.*|"
    r"safetensors|onnx|pytorch|transformers|en|imatrix)$", re.I)


def _hf_caps(tags, ptag):
    tags = [str(x).lower() for x in (tags or [])]
    ptag = (ptag or "").lower()
    caps = []
    if ptag in ("image-text-to-text", "image-to-text", "visual-question-answering") \
            or any(x in tags for x in ("multimodal", "image-text-to-text", "visual-question-answering")):
        caps.append("vision")
    if ptag in ("feature-extraction", "sentence-similarity") or "sentence-transformers" in tags:
        caps.append("embedding")
    if any(x in tags for x in ("function-calling", "tool-use", "tool-calling", "tools")):
        caps.append("tools")
    if any(x in tags for x in ("reasoning", "thinking", "chain-of-thought")):
        caps.append("thinking")
    return caps


def _hf_pulls(n):
    try:
        n = int(n)
    except (TypeError, ValueError):
        return ""
    if n >= 1_000_000:
        return ("%.1fM" % (n / 1_000_000)).replace(".0M", "M")
    if n >= 1_000:
        return ("%.1fK" % (n / 1_000)).replace(".0K", "K")
    return str(n)


def _hf_next_cursor(link):
    m = re.search(r'[?&]cursor=([^&>]+)[^>]*>;\s*rel="next"', link or "")
    return urllib.parse.unquote(m.group(1)) if m else ""


def _hf_ago(iso):
    # ISO timestamp -> compact relative value in the style of the ollama source ("3 months"),
    # which the client then renders as "{v} ago" / "vor {v}".
    if not iso:
        return ""
    try:
        dt = datetime.datetime.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S")
    except (ValueError, TypeError):
        return iso[:10]
    sec = (datetime.datetime.utcnow() - dt).total_seconds()
    if sec < 0:
        sec = 0
    day = sec / 86400
    if day >= 365:
        v = int(day / 365); return "%d year%s" % (v, "" if v == 1 else "s")
    if day >= 30:
        v = int(day / 30); return "%d month%s" % (v, "" if v == 1 else "s")
    if day >= 1:
        v = int(day); return "%d day%s" % (v, "" if v == 1 else "s")
    hr = sec / 3600
    if hr >= 1:
        v = int(hr); return "%d hour%s" % (v, "" if v == 1 else "s")
    return "just now"


def _hf_library(q, cursor):
    # Base URL is fixed (only huggingface.co) – the client controls just the query + opaque
    # cursor value, never the host. So no SSRF vector.
    # expand=... keeps the response lean (only the needed fields) AND returns lastModified.
    params = [
        ("filter", "gguf"), ("sort", "downloads"), ("direction", "-1"), ("limit", "24"),
        ("expand", "downloads"), ("expand", "lastModified"),
        ("expand", "pipeline_tag"), ("expand", "tags"),
    ]
    if q:
        params.append(("search", q))
    if cursor:
        params.append(("cursor", cursor))
    url = "https://huggingface.co/api/models?" + urllib.parse.urlencode(params)
    body, link = _fetch_resp(url)
    try:
        arr = json.loads(body)
    except ValueError:
        arr = []
    out = []
    for m in arr if isinstance(arr, list) else []:
        mid = m.get("id") or m.get("modelId")
        if not mid or "/" not in mid:
            continue
        tags = m.get("tags") or []
        ptag = m.get("pipeline_tag") or ""
        author = m.get("author") or mid.split("/")[0]
        label = mid.split("/")[-1]
        topics = [str(b) for b in tags if not _HF_SKIP_TAG.match(str(b))][:4]
        desc = "by " + author + (" · " + ptag if ptag else "")
        if topics:
            desc += " · " + ", ".join(topics)
        out.append({
            "name": "hf.co/" + mid,
            "label": label,
            "description": desc,
            "capabilities": _hf_caps(tags, ptag),
            "sizes": [],  # without a tag, Ollama automatically picks a quantization
            "pulls": _hf_pulls(m.get("downloads")),
            "updated": _hf_ago(m.get("lastModified")),
            "source": "huggingface",
        })
    return {"models": out, "next": _hf_next_cursor(link)}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/health":
            self._send(200, {"ok": True})
            return
        if u.path == "/search":
            qs = urllib.parse.parse_qs(u.query)
            q = (qs.get("q") or [""])[0].strip()
            try:
                n = max(1, min(10, int((qs.get("n") or ["8"])[0])))
            except ValueError:
                n = 8
            if not q:
                self._send(400, {"error": "q missing"})
                return
            try:
                self._send(200, {"results": search(q, n)})
            except Exception as e:
                self._send(502, {"error": str(e)})
            return
        if u.path == "/ollama_library":
            qs = urllib.parse.parse_qs(u.query)
            q = (qs.get("q") or [""])[0].strip()
            page = (qs.get("page") or ["1"])[0]
            cap = (qs.get("c") or [""])[0].strip()
            order = (qs.get("o") or [""])[0].strip()
            try:
                self._send(200, _ollama_library(q, page, cap, order))
            except Exception as e:
                self._send(502, {"error": str(e)})
            return
        if u.path == "/hf_library":
            qs = urllib.parse.parse_qs(u.query)
            q = (qs.get("q") or [""])[0].strip()
            cursor = (qs.get("cursor") or [""])[0]
            try:
                self._send(200, _hf_library(q, cursor))
            except Exception as e:
                self._send(502, {"error": str(e)})
            return
        self._send(404, {"error": "not found"})

    def log_message(self, fmt, *args):  # compact log
        print("[Search] " + (fmt % args))


if __name__ == "__main__":
    print("Oddvark web search server at http://127.0.0.1:%d (quit: Ctrl+C)" % PORT)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
