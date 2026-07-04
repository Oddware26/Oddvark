#!/usr/bin/env python3
"""Updates the model catalog for the Oddvark models page.

Fetches the complete Ollama library (https://ollama.com/library) and regenerates:
  - assets/js/models-catalog.js   (window.MODELS_CATALOG = {...}; -> loaded by models.html)
  - assets/models-catalog.json    (raw data)

Usage (in the frontend folder):  python tools/update-catalog.py
Requires only the Python standard library.
"""
import json
import re
import html as H
import urllib.request
from pathlib import Path

LIBRARY_URL = "https://ollama.com/library"
ROOT = Path(__file__).resolve().parent.parent  # .../frontend
JS_OUT = ROOT / "assets" / "js" / "models-catalog.js"
JSON_OUT = ROOT / "assets" / "models-catalog.json"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Oddvark catalog updater)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def strip(s):
    return H.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def parse(html_src):
    models = []
    for b in re.findall(r"<li x-test-model.*?</li>", html_src, re.DOTALL):
        nm = re.search(r'href="/library/([^"?]+)"', b)
        if not nm:
            continue
        d = re.search(r'<p class="[^"]*text-md">(.*?)</p>', b, re.DOTALL)
        models.append({
            "name": nm.group(1),
            "description": strip(d.group(1)) if d else "",
            "capabilities": [strip(x) for x in re.findall(r"x-test-capability[^>]*>(.*?)</span>", b, re.DOTALL)],
            "sizes": [strip(x) for x in re.findall(r"x-test-size[^>]*>(.*?)</span>", b, re.DOTALL)],
            "pulls": (lambda m: strip(m.group(1)) if m else "")(re.search(r"x-test-pull-count[^>]*>(.*?)</span>", b, re.DOTALL)),
            "updated": (lambda m: strip(m.group(1)) if m else "")(re.search(r"x-test-updated[^>]*>(.*?)</span>", b, re.DOTALL)),
        })
    return models


def main():
    print("Fetching", LIBRARY_URL, "…")
    models = parse(fetch(LIBRARY_URL))
    if not models:
        raise SystemExit("No models parsed – page structure may have changed.")
    data = {"source": "ollama.com/library", "count": len(models), "models": models}
    JSON_OUT.write_text(json.dumps(data, ensure_ascii=False, indent=0), encoding="utf-8")
    JS_OUT.write_text("window.MODELS_CATALOG = " + json.dumps(data, ensure_ascii=False) + ";", encoding="utf-8")
    print(f"OK – {len(models)} models written:")
    print(" ", JS_OUT)
    print(" ", JSON_OUT)


if __name__ == "__main__":
    main()
