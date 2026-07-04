# -*- coding: utf-8 -*-
# Jarvis - lokaler "Aktions-Server": gibt dem Sprachassistenten echten PC-/Browser-/Vision-Zugriff.
# Port 7864, bindet NUR an 127.0.0.1 (loopback). ThreadingHTTPServer, reine stdlib im Kern.
#
# SICHERHEIT / AUTH:
#   - Der Server lauscht ausschliesslich auf 127.0.0.1. Es gibt bewusst KEIN Token-/Passwort-Auth,
#     weil nur lokale Prozesse (das Jarvis-Frontend auf http://localhost:8000) ihn erreichen koennen.
#     Wer lokalen Zugriff hat, koennte diese Aktionen ohnehin selbst ausfuehren.
#   - "Confirm-by-default": riskante Aktionen (delete/move/overwrite/power/run_code/send_email/
#     browser_act/organize/close_app/unbekannte open_app/agent_task) werden NICHT ungefragt
#     ausgefuehrt. Erste Anfrage ohne "confirm":true liefert {"needs_confirm":true, ...,"token":...};
#     erst eine zweite Anfrage mit "confirm":true (oder gueltigem "token") fuehrt aus.
#   - Browser-Aktionen nur gegen die Domain-Allowlist aus config.json (fnmatch, Wildcards).
#   - Jede ausgefuehrte Aktion wird geloggt (In-Memory + tools/action-log.jsonl), Secrets maskiert.
#
# OPTIONALE FAEHIGKEITEN (jeweils try/except; Feature degradiert sauber wenn Lib fehlt):
#   psutil    -> volle system_info / network_info      (pip install psutil)
#   Pillow    -> Screenshots + Skalierung              (pip install pillow)   [ODER mss]
#   mss       -> schnelle Screenshots                  (pip install mss)
#   pyautogui -> Maus/Tastatur + agent_task            (pip install pyautogui)
#   pyperclip -> Zwischenablage (Fallback: clip.exe / powershell Get-Clipboard)
#   pygetwindow -> Fensterliste (optional)
#
# ENDPUNKTE: siehe do_GET / do_POST unten. GET /capabilities listet, was verfuegbar ist.
#
# Konfiguration: frontend/config.json (Struktur siehe config.example.json). KEINE Secrets im Code.

import os
import io
import re
import sys
import json
import time
import shlex
import base64
import shutil
import socket
import secrets
import fnmatch
import pathlib
import ipaddress
import platform
import subprocess
import threading
import webbrowser
import html as htmllib
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("JARVIS_ACTION_PORT", "7864"))
VISION_MODEL = os.environ.get("JARVIS_VISION_MODEL", "qwen2.5vl:7b")  # ggf. via config.json "vision_model" ueberschrieben (s. u.)
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

_HERE = os.path.dirname(os.path.abspath(__file__))
_FRONTEND = os.path.dirname(_HERE)
CONFIG_PATH = os.path.join(_FRONTEND, "config.json")
LOG_FILE = os.path.join(_HERE, "action-log.jsonl")

IS_WIN = (os.name == "nt")
if IS_WIN:
    import ctypes  # Media-Keys / Lautstaerke / LockWorkStation (stdlib)

# ---------------------------------------------------------------------------
# Optionale Libs
# ---------------------------------------------------------------------------
def _try(name):
    try:
        __import__(name)
        return True
    except Exception:
        return False

_HAS_PSUTIL = _try("psutil")
_HAS_PIL = _try("PIL")
_HAS_MSS = _try("mss")
_HAS_PYAUTOGUI = _try("pyautogui")
_HAS_PYPERCLIP = _try("pyperclip")
_HAS_PYGETWINDOW = _try("pygetwindow")

if _HAS_PSUTIL:
    import psutil  # noqa: E402

# ---------------------------------------------------------------------------
# Konfiguration
# ---------------------------------------------------------------------------
DEFAULT_CONFIG = {
    "app_whitelist": {
        "Rechner": "calc.exe",
        "Editor": "notepad.exe",
        "Explorer": "explorer.exe",
        "Browser": "cmd /c start \"\" \"https://www.google.com\"",
    },
    # Leere Liste = KEINE Domain-Einschränkung (nur öffentliche Hosts, SSRF-Schutz bleibt).
    # Nur füllen, wenn das server-seitige Lesen/Automatisieren bewusst auf bestimmte Domains
    # beschränkt werden soll. Das bloße ÖFFNEN einer Website (open_url) ist NIE eingeschränkt.
    "allowed_domains": [],
    "smtp": {"host": "", "port": 587, "user": "", "password": "", "from": "", "tls": True},
    "confirm_required": ["delete", "move", "overwrite", "power", "run_code", "send_email"],
    # Arbeitsordner fuer Datei-Erstellung / Projekt-Scaffolding / Ausfuehrung. Relative Pfade
    # der neuen Endpunkte sind IMMER relativ zu diesem Ordner (Pfad-Traversal-Schutz).
    "workspace_dir": os.path.join(os.path.expanduser("~"), "JarvisWorkspace"),
    # Timeout (Sekunden) fuer run_command / run_file.
    "run_timeout_sec": 60,
}


def load_config():
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # tiefe Kopie der Defaults
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            user = json.load(f)
        for k, v in (user or {}).items():
            cfg[k] = v
        print("[Aktion] config.json geladen: %s" % CONFIG_PATH)
    except FileNotFoundError:
        print("[Aktion] keine config.json - nutze Defaults (siehe config.example.json)")
    except Exception as e:
        print("[Aktion] config.json fehlerhaft (%r) - nutze Defaults" % e)
    return cfg


CONFIG = load_config()
# Vision-Modell: Umgebungsvariable schlaegt config.json schlaegt Default (qwen2.5vl:7b).
if not os.environ.get("JARVIS_VISION_MODEL") and CONFIG.get("vision_model"):
    VISION_MODEL = str(CONFIG["vision_model"])
APP_WHITELIST = CONFIG.get("app_whitelist", {})
ALLOWED_DOMAINS = CONFIG.get("allowed_domains", [])
SMTP = CONFIG.get("smtp", {})
CONFIRM_REQUIRED = set(CONFIG.get("confirm_required", []))

# Arbeitsordner (Workspace) fuer Datei-/Projekt-/Ausfuehrungs-Aktionen.
WORKSPACE_DIR = os.path.abspath(os.path.expanduser(
    CONFIG.get("workspace_dir") or os.path.join(os.path.expanduser("~"), "JarvisWorkspace")))
try:
    RUN_TIMEOUT = int(CONFIG.get("run_timeout_sec") or 60)
except Exception:
    RUN_TIMEOUT = 60
try:
    os.makedirs(WORKSPACE_DIR, exist_ok=True)
except Exception as _e:
    print("[Aktion] Workspace konnte nicht angelegt werden (%r): %s" % (_e, WORKSPACE_DIR))
else:
    print("[Aktion] Workspace: %s" % WORKSPACE_DIR)

# Python-Interpreter fuer run_file (laufender Interpreter, cross-platform).
_PYTHON = sys.executable or ("python" if IS_WIN else "python3")

# ---------------------------------------------------------------------------
# Confirm-Gate (Confirm-by-default)
# ---------------------------------------------------------------------------
PENDING = {}          # token -> {"label","summary","ts"}
PENDING_TTL = 300.0   # Sekunden, die ein ausgestellter Bestaetigungs-Token gilt


def need_confirm(label, data, summary, force=False):
    """Gibt ein needs_confirm-Dict zurueck, falls Bestaetigung noetig und noch nicht erteilt;
    sonst None (=> Aktion darf laufen). force=True erzwingt die Bestaetigung unabhaengig von der
    config-Liste (harte Sicherheitsschranke fuer wirklich gefaehrliche Aktionen)."""
    required = force or (label in CONFIRM_REQUIRED)
    if not required:
        return None
    if data.get("confirm") is True:
        return None
    tok = data.get("token")
    if tok:
        rec = PENDING.pop(tok, None)
        if rec and rec.get("label") == label and (time.time() - rec["ts"]) < PENDING_TTL:
            return None
    token = secrets.token_urlsafe(18)
    PENDING[token] = {"label": label, "summary": summary, "ts": time.time()}
    # alte Tokens aufraeumen
    if len(PENDING) > 200:
        now = time.time()
        for k in [k for k, r in PENDING.items() if now - r["ts"] > PENDING_TTL]:
            PENDING.pop(k, None)
    return {"needs_confirm": True, "action": label, "summary": summary, "token": token}


# ---------------------------------------------------------------------------
# Domain-Allowlist
# ---------------------------------------------------------------------------
def normalize_url(url):
    """Schemelose Eingaben (z. B. 'nike.com') zu einer https-URL machen.
    Vorhandene Schemata (http:, file:, javascript:, mailto: …) bleiben unangetastet,
    damit is_web_url() sie sauber ablehnen kann."""
    u = (url or "").strip()
    if not u:
        return ""
    if re.match(r'^[a-zA-Z][a-zA-Z0-9+.\-]*:', u):   # hat bereits ein Schema
        return u
    if u.startswith("//"):                            # protokoll-relativ
        return "https:" + u
    return "https://" + u                             # schemelos -> https


def is_private_host(host):
    """True für lokale/private/interne Hosts (SSRF-Schutz beim server-seitigen Lesen)."""
    if not host:
        return True
    h = host.lower().strip("[]")
    if h == "localhost" or h.endswith(".local") or h.endswith(".internal") or h.endswith(".lan"):
        return True
    try:
        ip = ipaddress.ip_address(h)
        return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast
    except ValueError:
        return False  # normaler öffentlicher Hostname (keine IP)


def is_web_url(url):
    """Nur http/https zulassen (blockiert file:, javascript:, data: …)."""
    try:
        pr = urllib.parse.urlparse(url)
    except Exception:
        return False
    return pr.scheme in ("http", "https") and bool(pr.hostname)


def domain_allowed(url):
    # Leere Allowlist = keine Domain-Einschränkung (der SSRF-Schutz greift separat).
    if not ALLOWED_DOMAINS:
        return True
    try:
        host = (urllib.parse.urlparse(url).hostname or "").lower()
    except Exception:
        return False
    if not host:
        return False
    for pat in ALLOWED_DOMAINS:
        p = str(pat).lower().strip()
        if not p:
            continue
        if fnmatch.fnmatch(host, p):
            return True
        if p.startswith("*."):
            base = p[2:]
            if host == base:
                return True
        else:
            # blanke Domain deckt auch ihre Subdomains ab
            if host == p or fnmatch.fnmatch(host, "*." + p):
                return True
    return False


# ---------------------------------------------------------------------------
# Aktions-Log (Secrets maskiert)
# ---------------------------------------------------------------------------
LOG = []
_SENS = ("pass", "pwd", "secret", "token", "key", "credential")


def _mask(obj):
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            kl = str(k).lower()
            if any(s in kl for s in _SENS):
                out[k] = "***"
            elif kl == "content" and isinstance(v, str):
                out[k] = "<%d Zeichen>" % len(v)           # Datei-Inhalt nie voll loggen
            elif kl == "files" and isinstance(v, list):
                out[k] = "<%d Datei(en)>" % len(v)         # Projekt-Dateien: nur Anzahl
            else:
                out[k] = _mask(v)
        return out
    if isinstance(obj, (list, tuple)):
        return [_mask(x) for x in list(obj)[:20]]
    if isinstance(obj, str):
        return obj if len(obj) <= 300 else obj[:300] + " ...(gekuerzt)"
    return obj


def log_action(action, args, status):
    entry = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "action": action,
             "status": status, "args": _mask(args or {})}
    LOG.append(entry)
    if len(LOG) > 500:
        del LOG[0]
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass
    return entry


# ---------------------------------------------------------------------------
# Kleine Helfer
# ---------------------------------------------------------------------------
def _local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def _fetch_text(url, timeout=12):
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Accept-Language": "de-DE,de;q=0.9,en;q=0.7"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    enc = "utf-8"
    ct = r.headers.get("Content-Type", "") if hasattr(r, "headers") else ""
    m = re.search(r"charset=([\w-]+)", ct or "", re.I)
    if m:
        enc = m.group(1)
    return raw.decode(enc, "replace")


def _html_to_text(body, limit=4000):
    title = ""
    mt = re.search(r"<title[^>]*>(.*?)</title>", body, re.S | re.I)
    if mt:
        title = htmllib.unescape(re.sub(r"\s+", " ", mt.group(1))).strip()
    body = re.sub(r"(?is)<(script|style|noscript|template)[^>]*>.*?</\1>", " ", body)
    body = re.sub(r"(?i)<br\s*/?>", "\n", body)
    body = re.sub(r"(?i)</(p|div|li|h[1-6]|tr)>", "\n", body)
    text = htmllib.unescape(re.sub(r"<[^>]+>", " ", body))
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text).strip()
    if len(text) > limit:
        text = text[:limit] + " ...(gekuerzt)"
    return title, text


def grab_png(max_width=1280):
    """Screenshot des Primaerbildschirms als PNG-Bytes (auf max_width skaliert, spart Tokens)."""
    if _HAS_PIL:
        from PIL import ImageGrab, Image
        img = ImageGrab.grab()
        if img.width > max_width:
            h = int(img.height * max_width / img.width)
            img = img.resize((max_width, h), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    if _HAS_MSS:
        import mss
        import mss.tools
        with mss.mss() as sct:
            shot = sct.grab(sct.monitors[1])
            return mss.tools.to_png(shot.rgb, shot.size)
    raise RuntimeError("Kein Screenshot moeglich - weder Pillow noch mss installiert.")


def ollama_vision(question, b64_png, timeout=300):
    payload = {
        "model": VISION_MODEL,
        "stream": False,
        "messages": [{"role": "user",
                      "content": question or "Beschreibe praezise, was auf dem Bildschirm zu sehen ist.",
                      "images": [b64_png]}],
    }
    req = urllib.request.Request(OLLAMA_URL.rstrip("/") + "/api/chat",
                                 data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        resp = json.loads(r.read().decode("utf-8", "replace"))
    return (resp.get("message") or {}).get("content", "")


# ---------------------------------------------------------------------------
# Windows: Media-Keys / Lautstaerke / Power
# ---------------------------------------------------------------------------
VK = {
    "mute": 0xAD, "voldown": 0xAE, "volup": 0xAF,
    "next": 0xB0, "prev": 0xB1, "playpause": 0xB3, "stop": 0xB2,
}


def _tap_vk(vk):
    KEYEVENTF_KEYUP = 0x0002
    ctypes.windll.user32.keybd_event(vk, 0, 0, 0)
    ctypes.windll.user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)


def set_volume(level):
    """Absolute Lautstaerke 0..100 - stdlib-only via VK-Tasten (Schrittweite ~2%, daher ungefaehr)."""
    if not IS_WIN:
        raise RuntimeError("set_volume nur unter Windows implementiert.")
    level = max(0, min(100, int(level)))
    for _ in range(50):        # sicher auf 0 herunter
        _tap_vk(VK["voldown"])
    for _ in range(round(level / 2.0)):  # jeder Schritt hebt um ~2 %
        _tap_vk(VK["volup"])
    return {"ok": True, "level_approx": level, "note": "approx. (VK-Schrittweite ~2%)"}


def do_power(action):
    if not IS_WIN:
        raise RuntimeError("Power-Aktionen nur unter Windows implementiert.")
    a = (action or "").lower()
    if a == "lock":
        ctypes.windll.user32.LockWorkStation()
    elif a == "sleep":
        subprocess.Popen(["rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"])
    elif a == "restart":
        subprocess.Popen(["shutdown", "/r", "/t", "0"])
    elif a == "shutdown":
        subprocess.Popen(["shutdown", "/s", "/t", "0"])
    elif a == "hibernate":
        subprocess.Popen(["shutdown", "/h"])
    else:
        raise ValueError("unbekannte power-Aktion: %r" % action)
    return {"ok": True, "action": a}


# ---------------------------------------------------------------------------
# pyautogui-Wrapper
# ---------------------------------------------------------------------------
def _pg():
    if not _HAS_PYAUTOGUI:
        raise RuntimeError("pyautogui nicht installiert (pip install pyautogui).")
    import pyautogui
    pyautogui.FAILSAFE = True   # Maus in Ecke oben-links bricht ab
    return pyautogui


def do_mouse(data):
    pg = _pg()
    act = (data.get("action") or "move").lower()
    x, y = data.get("x"), data.get("y")
    if act == "move":
        pg.moveTo(x, y, duration=0.15) if x is not None else None
    elif act == "click":
        pg.click(x, y) if x is not None else pg.click()
    elif act == "double":
        pg.doubleClick(x, y) if x is not None else pg.doubleClick()
    elif act == "right":
        pg.rightClick(x, y) if x is not None else pg.rightClick()
    elif act == "scroll":
        pg.scroll(int(data.get("amount") or -300))
    else:
        raise ValueError("unbekannte mouse-Aktion: %r" % act)
    return {"ok": True, "action": act}


# ---------------------------------------------------------------------------
# Systeminfo
# ---------------------------------------------------------------------------
def system_info():
    info = {
        "hostname": socket.gethostname(),
        "local_ip": _local_ip(),
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "platform": platform.platform(),
        "python": platform.python_version(),
        "cpu_count": os.cpu_count(),
    }
    # Disk (Systemlaufwerk) - stdlib
    try:
        du = shutil.disk_usage(os.path.abspath(os.sep))
        info["disk"] = {"free_gb": round(du.free / 1e9, 1), "total_gb": round(du.total / 1e9, 1),
                        "used_pct": round(100.0 * (du.total - du.free) / du.total, 1)}
    except Exception:
        pass
    if _HAS_PSUTIL:
        info["cpu_percent"] = psutil.cpu_percent(interval=0.3)
        vm = psutil.virtual_memory()
        info["ram"] = {"used_gb": round(vm.used / 1e9, 1), "total_gb": round(vm.total / 1e9, 1),
                       "percent": vm.percent}
        try:
            bat = psutil.sensors_battery()
            if bat is not None:
                info["battery"] = {"percent": round(bat.percent), "plugged": bool(bat.power_plugged)}
        except Exception:
            pass
    else:
        info["note"] = "psutil nicht installiert - CPU%/RAM/Akku nicht verfuegbar (pip install psutil)."
    return info


def network_info():
    out = {"hostname": socket.gethostname(), "local_ip": _local_ip(), "interfaces": {}}
    if _HAS_PSUTIL:
        try:
            for name, addrs in psutil.net_if_addrs().items():
                ips = [a.address for a in addrs if getattr(a, "family", None) == socket.AF_INET]
                if ips:
                    out["interfaces"][name] = ips
        except Exception:
            pass
    else:
        out["note"] = "psutil fehlt - nur Hostname/lokale IP. Speedtest bewusst weggelassen (keine Lib)."
    return out


def hardware_scan():
    """Hardware-Profil fuer Modell-Empfehlungen (read-only): CPU, RAM, GPU/VRAM.
    Genutzt vom "PC scannen"-Button auf models.html, um passende LLM-Groessen/Quants zu bestimmen."""
    hw = {"platform": platform.platform()}
    # CPU (stdlib + optional psutil)
    cpu = {"name": platform.processor() or platform.machine(),
           "arch": platform.machine(),
           "cores_logical": os.cpu_count()}
    if _HAS_PSUTIL:
        try:
            cpu["cores_physical"] = psutil.cpu_count(logical=False)
            f = psutil.cpu_freq()
            if f and f.max:
                cpu["max_mhz"] = round(f.max)
        except Exception:
            pass
    hw["cpu"] = cpu
    # RAM
    if _HAS_PSUTIL:
        try:
            vm = psutil.virtual_memory()
            hw["ram"] = {"total_gb": round(vm.total / 2 ** 30, 1),
                         "available_gb": round(vm.available / 2 ** 30, 1)}
        except Exception:
            pass
    if "ram" not in hw:
        hw["note"] = "psutil fehlt - RAM unbekannt (pip install psutil)."
    # GPU/VRAM degrade-clean: 1) nvidia-smi (echte VRAM-Zahlen), 2) Windows-CIM nur als Namens-
    # Fallback (Win32_VideoController.AdapterRAM ist signed-32-bit und wrappt >4 GB -> keine Groesse).
    gpus = []
    flags = subprocess.CREATE_NO_WINDOW if IS_WIN else 0
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,memory.used,driver_version",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10, creationflags=flags)
        if out.returncode == 0:
            for line in out.stdout.strip().splitlines():
                parts = [x.strip() for x in line.split(",")]
                if len(parts) >= 3:
                    try:
                        total = float(parts[1])
                        used = float(parts[2])
                    except ValueError:
                        continue
                    gpus.append({"name": parts[0], "vendor": "nvidia",
                                 "vram_gb": round(total / 1024, 1),
                                 "vram_free_gb": round(max(0.0, total - used) / 1024, 1),
                                 "driver": parts[3] if len(parts) > 3 else ""})
    except Exception:
        pass
    if not gpus and IS_WIN:
        try:
            out = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"],
                capture_output=True, text=True, timeout=15, creationflags=flags)
            for line in out.stdout.strip().splitlines():
                n = line.strip()
                if not n:
                    continue
                vend = ("nvidia" if re.search(r"nvidia|geforce|quadro|rtx|gtx", n, re.I)
                        else "amd" if re.search(r"amd|radeon", n, re.I)
                        else "intel" if re.search(r"intel|arc|iris|uhd", n, re.I) else "unknown")
                gpus.append({"name": n, "vendor": vend})
        except Exception:
            pass
    hw["gpus"] = gpus
    hw["vram_gb"] = max([g.get("vram_gb", 0) for g in gpus] or [0])
    return hw


# ---------------------------------------------------------------------------
# Dateien
# ---------------------------------------------------------------------------
def list_dir(path):
    path = os.path.abspath(os.path.expanduser(path or os.path.expanduser("~")))
    if not os.path.isdir(path):
        raise FileNotFoundError("kein Verzeichnis: %s" % path)
    entries = []
    for name in sorted(os.listdir(path)):
        full = os.path.join(path, name)
        try:
            is_dir = os.path.isdir(full)
            entries.append({"name": name, "type": "dir" if is_dir else "file",
                            "size": (os.path.getsize(full) if not is_dir else None)})
        except Exception:
            entries.append({"name": name, "type": "?", "size": None})
    return {"path": path, "entries": entries}


def search_files(root, query, limit):
    root = os.path.abspath(os.path.expanduser(root or os.path.expanduser("~")))
    q = (query or "").lower()
    limit = max(1, min(500, int(limit or 50)))
    hits = []
    for dirpath, dirnames, filenames in os.walk(root):
        for fn in filenames:
            if not q or q in fn.lower():
                full = os.path.join(dirpath, fn)
                try:
                    hits.append({"path": full, "name": fn, "size": os.path.getsize(full)})
                except Exception:
                    hits.append({"path": full, "name": fn, "size": None})
                if len(hits) >= limit:
                    return {"root": root, "query": query, "results": hits, "truncated": True}
    return {"root": root, "query": query, "results": hits, "truncated": False}


def organize_folder(path):
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isdir(path):
        raise FileNotFoundError("kein Verzeichnis: %s" % path)
    moved = 0
    for name in os.listdir(path):
        full = os.path.join(path, name)
        if not os.path.isfile(full):
            continue
        ext = (os.path.splitext(name)[1].lstrip(".") or "ohne_endung").lower()
        sub = os.path.join(path, ext.upper())
        os.makedirs(sub, exist_ok=True)
        try:
            shutil.move(full, os.path.join(sub, name))
            moved += 1
        except Exception:
            pass
    return {"ok": True, "path": path, "moved": moved}


def file_op(op, src, dst):
    op = (op or "").lower()
    src = os.path.abspath(os.path.expanduser(src or ""))
    if not os.path.exists(src):
        raise FileNotFoundError("Quelle fehlt: %s" % src)
    if op == "delete":
        if os.path.isdir(src):
            shutil.rmtree(src)
        else:
            os.remove(src)
        return {"ok": True, "op": "delete", "src": src}
    dst = os.path.abspath(os.path.expanduser(dst or ""))
    if not dst:
        raise ValueError("dst fehlt fuer op=%s" % op)
    if op == "move":
        shutil.move(src, dst)
    elif op == "copy":
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
    else:
        raise ValueError("unbekannte op: %r" % op)
    return {"ok": True, "op": op, "src": src, "dst": dst}


def clipboard_get():
    if _HAS_PYPERCLIP:
        import pyperclip
        return pyperclip.paste()
    if IS_WIN:
        try:
            out = subprocess.run(["powershell", "-NoProfile", "-Command", "Get-Clipboard"],
                                 capture_output=True, text=True, timeout=10)
            return out.stdout.rstrip("\r\n")
        except Exception as e:
            raise RuntimeError("Zwischenablage nicht lesbar: %r" % e)
    raise RuntimeError("pyperclip nicht installiert.")


def clipboard_set(text):
    text = text or ""
    if _HAS_PYPERCLIP:
        import pyperclip
        pyperclip.copy(text)
        return True
    if IS_WIN:
        p = subprocess.Popen("clip", stdin=subprocess.PIPE, shell=True)
        p.communicate(input=text.encode("utf-16le"))
        return True
    raise RuntimeError("pyperclip nicht installiert.")


# ---------------------------------------------------------------------------
# Workspace: Datei-Erstellung / Projekt-Scaffolding / Ausfuehrung
# ---------------------------------------------------------------------------
def _is_within(path, base):
    """True, wenn 'path' innerhalb von 'base' liegt (beide werden absolut gemacht).
    Auf Windows liefert commonpath bei verschiedenen Laufwerken eine ValueError -> False."""
    try:
        ap = os.path.abspath(path)
        ab = os.path.abspath(base)
        return os.path.commonpath([ap, ab]) == ab
    except Exception:
        return False


def resolve_path(path):
    """Loest 'path' zu einem absoluten Pfad auf. Rueckgabe (abspath, sensibel).
    - RELATIVE Pfade sind relativ zum Workspace; ein Ausbruch via '..' wird abgelehnt
      (ValueError -> Pfad-Traversal-Schutz). sensibel=False.
    - ABSOLUTE Pfade (C:\\..., /home/...) sind erlaubt, gelten aber IMMER als sensibel
      (sensibel=True -> die aufrufende Aktion verlangt dann eine Bestaetigung),
      ausser sie liegen zufaellig innerhalb des Workspace."""
    raw = (path or "").strip()
    if not raw:
        raise ValueError("kein Pfad angegeben")
    expanded = os.path.expanduser(raw)
    if os.path.isabs(expanded):
        ap = os.path.abspath(expanded)
        return ap, (not _is_within(ap, WORKSPACE_DIR))
    ap = os.path.abspath(os.path.join(WORKSPACE_DIR, expanded))
    if not _is_within(ap, WORKSPACE_DIR):
        raise ValueError("Pfad-Traversal ausserhalb des Workspace ist nicht erlaubt: %s" % raw)
    return ap, False


def _file_url(path):
    """Absoluter Pfad -> file://-URL (cross-platform via pathlib)."""
    try:
        return pathlib.Path(os.path.abspath(path)).as_uri()
    except Exception:
        return "file://" + os.path.abspath(path).replace("\\", "/")


def _open_default(target):
    """Datei/Ordner im Standardprogramm bzw. http(s)-URL im Browser oeffnen (OS-abhaengig)."""
    if re.match(r'^https?://', str(target), re.I):
        (os.startfile(target) if IS_WIN else webbrowser.open(target))
        return
    if IS_WIN:
        os.startfile(target)                       # noqa: fuer .html/.exe = Standardhandler
    elif sys.platform == "darwin":
        subprocess.Popen(["open", target])
    else:
        subprocess.Popen(["xdg-open", target])


def _write_text_file(ap, content):
    """Schreibt Text (UTF-8), legt fehlende Ordner an, gibt geschriebene Byte-Anzahl zurueck."""
    content = "" if content is None else (content if isinstance(content, str) else str(content))
    parent = os.path.dirname(ap)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(ap, "w", encoding="utf-8", newline="") as f:
        f.write(content)
    return len(content.encode("utf-8"))


def list_workspace(sub):
    """Ordnerinhalt (Dateien + Ordner mit Groesse) im Workspace auflisten."""
    ap = resolve_path(sub)[0] if (sub or "").strip() else WORKSPACE_DIR
    if not os.path.isdir(ap):
        raise FileNotFoundError("kein Verzeichnis: %s" % ap)
    entries = []
    for name in sorted(os.listdir(ap)):
        full = os.path.join(ap, name)
        try:
            is_dir = os.path.isdir(full)
            entries.append({"name": name, "type": "dir" if is_dir else "file",
                            "size": (None if is_dir else os.path.getsize(full))})
        except Exception:
            entries.append({"name": name, "type": "?", "size": None})
    return {"dir": ap, "entries": entries}


def create_project(proj_dir, files, do_open):
    """Legt mehrere Dateien unter proj_dir an. Gibt {ok,dir,files,[open_path,open_url,opened]} zurueck.
    Wenn eine index.html dabei ist und do_open, wird sie im Standardbrowser geoeffnet."""
    os.makedirs(proj_dir, exist_ok=True)
    written = []
    index_html = None
    for item in (files or []):
        if not isinstance(item, dict):
            continue
        rel = (item.get("path") or "").strip()
        if not rel:
            continue
        target = os.path.abspath(os.path.join(proj_dir, os.path.expanduser(rel)))
        if not _is_within(target, proj_dir):
            raise ValueError("Datei-Pfad verlaesst das Projektverzeichnis: %s" % rel)
        b = _write_text_file(target, item.get("content"))
        written.append({"path": target, "bytes": b})
        if os.path.basename(target).lower() == "index.html" and index_html is None:
            index_html = target
    result = {"ok": True, "dir": proj_dir, "files": written}
    if index_html:
        result["open_path"] = index_html
        result["open_url"] = _file_url(index_html)
        if do_open:
            try:
                _open_default(index_html)
                result["opened"] = result["open_url"]
            except Exception as e:
                result["open_error"] = repr(e)
    return result


def _dec(b, limit=8000):
    """subprocess-Ausgabe (bytes) dekodieren + auf ~8000 Zeichen kuerzen."""
    if b is None:
        return ""
    s = b.decode("utf-8", "replace") if isinstance(b, (bytes, bytearray)) else str(b)
    if len(s) > limit:
        s = s[:limit] + " ...(gekuerzt)"
    return s


def run_command(command, cwd, timeout):
    """Befehl per Shell ausfuehren (cross-platform shell=True). stdout/stderr gekuerzt + returncode."""
    try:
        proc = subprocess.run(command, shell=True, cwd=cwd, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        return {"ok": False, "timeout": True, "returncode": None, "cwd": cwd,
                "stdout": _dec(getattr(e, "stdout", b"")), "stderr": _dec(getattr(e, "stderr", b"")),
                "note": "Timeout nach %s s" % timeout}
    return {"ok": (proc.returncode == 0), "returncode": proc.returncode, "cwd": cwd,
            "stdout": _dec(proc.stdout), "stderr": _dec(proc.stderr)}


def _shquote(s):
    """Argument fuer shell=True quoten (Windows: doppelte Anfuehrungszeichen; POSIX: shlex)."""
    s = str(s)
    if IS_WIN:
        return '"' + s.replace('"', '') + '"'
    return shlex.quote(s)


def run_file_cmd(ap, args):
    """Baut aus Dateiendung + args den Ausfuehrungs-Befehl. Rueckgabe (cmd, kind).
    kind: 'run' (ausfuehren via run_command) | 'open' (im Standardprogramm) | 'html' (Browser)."""
    ext = os.path.splitext(ap)[1].lower()
    if not isinstance(args, (list, tuple)):
        args = [] if args in (None, "") else [args]
    argstr = " ".join(_shquote(a) for a in args)
    if ext in (".html", ".htm"):
        return None, "html"
    if ext == ".py":
        cmd = "%s %s %s" % (_shquote(_PYTHON), _shquote(ap), argstr)
    elif ext == ".js":
        cmd = "node %s %s" % (_shquote(ap), argstr)
    elif ext == ".sh":
        cmd = "bash %s %s" % (_shquote(ap), argstr)
    elif ext in (".bat", ".cmd") and IS_WIN:
        cmd = "%s %s" % (_shquote(ap), argstr)
    else:
        return None, "open"
    return cmd.strip(), "run"


# ---------------------------------------------------------------------------
# Apps starten / beenden
# ---------------------------------------------------------------------------
def _launch(cmd):
    subprocess.Popen(cmd, shell=True)


def open_app_known(target):
    _launch(target)
    return {"ok": True, "launched": target}


def close_app(name):
    if IS_WIN:
        image = APP_WHITELIST.get(name, name)
        image = os.path.basename(str(image).split()[0]) if image else name
        if not image.lower().endswith(".exe"):
            image = image + ".exe"
        r = subprocess.run(["taskkill", "/IM", image, "/F"], capture_output=True, text=True)
        ok = (r.returncode == 0)
        return {"ok": ok, "image": image, "detail": (r.stdout or r.stderr).strip()}
    else:
        r = subprocess.run(["pkill", "-f", name], capture_output=True, text=True)
        return {"ok": r.returncode == 0, "name": name}


# ---------------------------------------------------------------------------
# Agent-Loop (Sehen -> Handeln -> Verifizieren)
# ---------------------------------------------------------------------------
def _agent_execute(action, args):
    action = (action or "").lower()
    args = args or {}
    if action == "mouse":
        return do_mouse(args)
    if action == "type":
        _pg().typewrite(str(args.get("text", "")), interval=0.02)
        return {"ok": True}
    if action == "hotkey":
        _pg().hotkey(*[str(k) for k in (args.get("keys") or [])])
        return {"ok": True}
    if action == "press":
        _pg().press(str(args.get("key", "")))
        return {"ok": True}
    if action == "open_app":
        tgt = APP_WHITELIST.get(args.get("name"))
        if not tgt:
            return {"ok": False, "error": "app nicht in whitelist"}
        return open_app_known(tgt)
    if action in ("done", "wait", "none"):
        return {"ok": True, "noop": action}
    return {"ok": False, "error": "unbekannte agent-Aktion: %r" % action}


def agent_task(goal, max_steps):
    if not _HAS_PYAUTOGUI:
        raise RuntimeError("agent_task braucht pyautogui (pip install pyautogui).")
    max_steps = max(1, min(12, int(max_steps or 6)))
    deadline = time.time() + 120.0   # hartes Zeitlimit
    steps = []
    for i in range(max_steps):
        if time.time() > deadline:
            steps.append({"step": i, "aborted": "zeitlimit"})
            break
        b64 = base64.b64encode(grab_png()).decode("ascii")
        prompt = (
            "Du steuerst einen Windows-PC per Maus/Tastatur. Ziel: %s\n"
            "Analysiere den Screenshot und plane GENAU EINE naechste Aktion.\n"
            "Antworte NUR mit JSON, ohne Erklaerung, in dieser Form:\n"
            "{\"action\":\"mouse|type|hotkey|press|open_app|done\",\"args\":{...},"
            "\"done\":false,\"reason\":\"kurz\"}\n"
            "Fuer mouse: args {\"action\":\"click|double|right|move|scroll\",\"x\":123,\"y\":456}. "
            "Wenn das Ziel erreicht ist: action \"done\", done true." % goal
        )
        try:
            content = ollama_vision(prompt, b64, timeout=180)
        except Exception as e:
            steps.append({"step": i, "error": "vision: %r" % e})
            break
        m = re.search(r"\{.*\}", content, re.S)
        plan = {}
        if m:
            try:
                plan = json.loads(m.group(0))
            except Exception:
                plan = {}
        if not plan:
            steps.append({"step": i, "raw": content[:400], "error": "kein JSON-Plan"})
            break
        rec = {"step": i, "action": plan.get("action"), "args": _mask(plan.get("args")),
               "reason": plan.get("reason")}
        log_action("agent_step", rec, "ok")
        if plan.get("done") or (plan.get("action") == "done"):
            rec["result"] = "done"
            steps.append(rec)
            break
        try:
            rec["result"] = _agent_execute(plan.get("action"), plan.get("args"))
        except Exception as e:
            rec["result"] = {"ok": False, "error": repr(e)}
            steps.append(rec)
            break
        steps.append(rec)
        time.sleep(0.6)  # UI Zeit geben zu reagieren
    return {"ok": True, "goal": goal, "steps": steps}


# ---------------------------------------------------------------------------
# E-Mail (stdlib smtplib) - optional, nur wenn smtp konfiguriert
# ---------------------------------------------------------------------------
def send_email(to, subject, body):
    host = SMTP.get("host")
    if not host:
        raise RuntimeError("SMTP nicht konfiguriert (config.json -> smtp.host).")
    import smtplib
    from email.message import EmailMessage
    msg = EmailMessage()
    msg["From"] = SMTP.get("from") or SMTP.get("user") or ""
    msg["To"] = to
    msg["Subject"] = subject or ""
    msg.set_content(body or "")
    port = int(SMTP.get("port") or 587)
    with smtplib.SMTP(host, port, timeout=30) as s:
        if SMTP.get("tls", True):
            s.starttls()
        if SMTP.get("user"):
            s.login(SMTP["user"], SMTP.get("password", ""))
        s.send_message(msg)
    return {"ok": True, "to": to}


# ---------------------------------------------------------------------------
# capabilities
# ---------------------------------------------------------------------------
def capabilities():
    return {
        "platform": platform.platform(),
        "os": os.name,
        "python": platform.python_version(),
        "vision_model": VISION_MODEL,
        "libs": {
            "psutil": _HAS_PSUTIL, "pillow": _HAS_PIL, "mss": _HAS_MSS,
            "pyautogui": _HAS_PYAUTOGUI, "pyperclip": _HAS_PYPERCLIP,
            "pygetwindow": _HAS_PYGETWINDOW,
        },
        "features": {
            "system_info": True,
            "hardware": True,   # /hardware: CPU/RAM/GPU-Scan fuer Modell-Empfehlungen
            "screenshot": _HAS_PIL or _HAS_MSS,
            "mouse_keyboard": _HAS_PYAUTOGUI,
            "clipboard": _HAS_PYPERCLIP or IS_WIN,
            "media_keys": IS_WIN,
            "power": IS_WIN,
            "vision": _HAS_PIL or _HAS_MSS,   # braucht zusaetzlich laufendes Ollama
            "agent_task": _HAS_PYAUTOGUI and (_HAS_PIL or _HAS_MSS),
            "email": bool(SMTP.get("host")),
            "file_ops": True,     # write_file/read_file/list_workspace/create_project/open_path
            "run": True,          # run_command/run_file
        },
        "allowed_domains": ALLOWED_DOMAINS,
        "app_whitelist": list(APP_WHITELIST.keys()),
        "confirm_required": sorted(CONFIRM_REQUIRED),
        "workspace_dir": WORKSPACE_DIR,
        "run_timeout_sec": RUN_TIMEOUT,
    }


# ---------------------------------------------------------------------------
# HTTP-Handler
# ---------------------------------------------------------------------------
SKIP_LOG = {"/health", "/capabilities", "/log"}


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")

    def _send(self, code, obj):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        try:
            self.wfile.write(raw)
        except Exception:
            pass

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    # ---- GET ----
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        p = u.path

        def one(k, d=None):
            return (qs.get(k) or [d])[0]

        try:
            if p == "/health":
                return self._send(200, {"ok": True})
            if p == "/capabilities":
                return self._send(200, capabilities())
            if p == "/log":
                n = max(1, min(500, int(one("n", "50"))))
                return self._send(200, {"log": LOG[-n:]})
            if p == "/system_info":
                r = system_info()
                self._logged(p, dict(qs), r)
                return self._send(200, r)
            if p == "/hardware":
                r = hardware_scan()
                self._logged(p, dict(qs), r)
                return self._send(200, r)
            if p == "/network_info":
                r = network_info()
                self._logged(p, dict(qs), r)
                return self._send(200, r)
            if p == "/screenshot":
                png = grab_png()
                data_url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
                self._logged(p, {}, {"bytes": len(png)})
                return self._send(200, {"image": data_url, "bytes": len(png)})
            if p == "/list_dir":
                r = list_dir(one("path"))
                self._logged(p, dict(qs), r)
                return self._send(200, r)
            if p == "/search_files":
                r = search_files(one("root"), one("query"), one("limit", "50"))
                self._logged(p, dict(qs), r)
                return self._send(200, r)
            if p == "/clipboard":
                r = {"text": clipboard_get()}
                self._logged(p, {}, r)
                return self._send(200, r)
            if p == "/list_workspace":
                r = list_workspace(one("path"))
                self._logged(p, dict(qs), r)
                return self._send(200, r)
            return self._send(404, {"error": "nicht gefunden: %s" % p})
        except Exception as e:
            self._logged(p, dict(qs), {"error": repr(e)})
            return self._send(500, {"error": repr(e)})

    # ---- POST ----
    def do_POST(self):
        p = urllib.parse.urlparse(self.path).path
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            data = json.loads(raw or b"{}")
            if not isinstance(data, dict):
                data = {}
        except Exception as e:
            return self._send(400, {"error": "ungueltiger JSON-Body: %r" % e})

        try:
            code, obj = self._route_post(p, data)
        except Exception as e:
            obj = {"error": repr(e)}
            code = 500
        self._logged(p, data, obj)
        return self._send(code, obj)

    def _route_post(self, p, data):
        # ---- Apps ----
        if p == "/open_app":
            name = data.get("name")
            # case-insensitive Whitelist-Lookup
            target = APP_WHITELIST.get(name)
            if target is None:
                for k, v in APP_WHITELIST.items():
                    if k.lower() == str(name or "").lower():
                        target = v
                        break
            if target:
                return 200, open_app_known(target)
            g = need_confirm("open_app", data,
                             "I would launch the unknown app '%s' (best effort)." % name,
                             force=True)
            if g:
                return 200, g
            _launch(str(name))
            return 200, {"ok": True, "launched": name, "note": "best-effort (not in whitelist)"}

        if p == "/close_app":
            name = data.get("name")
            g = need_confirm("close_app", data, "I would force-quit the app '%s' (taskkill /F)." % name,
                             force=True)
            if g:
                return 200, g
            return 200, close_app(name)

        # ---- System / Media / Power ----
        if p == "/set_volume":
            return 200, set_volume(data.get("level"))
        if p == "/media_key":
            key = (data.get("key") or "").lower()
            if key not in VK:
                return 400, {"error": "unbekannte media_key: %r" % key, "valid": list(VK.keys())}
            if not IS_WIN:
                return 400, {"error": "media_key nur unter Windows."}
            _tap_vk(VK[key])
            return 200, {"ok": True, "key": key}
        if p == "/power":
            action = data.get("action")
            g = need_confirm("power", data, "I would run '%s' now." % action, force=True)
            if g:
                return 200, g
            return 200, do_power(action)

        # ---- Maus / Tastatur ----
        if p == "/mouse":
            if not _HAS_PYAUTOGUI:
                return 200, {"error": "pyautogui nicht installiert", "hint": "pip install pyautogui"}
            return 200, do_mouse(data)
        if p == "/type":
            if not _HAS_PYAUTOGUI:
                return 200, {"error": "pyautogui nicht installiert", "hint": "pip install pyautogui"}
            _pg().typewrite(str(data.get("text", "")), interval=0.02)
            return 200, {"ok": True}
        if p == "/hotkey":
            if not _HAS_PYAUTOGUI:
                return 200, {"error": "pyautogui nicht installiert", "hint": "pip install pyautogui"}
            _pg().hotkey(*[str(k) for k in (data.get("keys") or [])])
            return 200, {"ok": True}
        if p == "/press":
            if not _HAS_PYAUTOGUI:
                return 200, {"error": "pyautogui nicht installiert", "hint": "pip install pyautogui"}
            _pg().press(str(data.get("key", "")))
            return 200, {"ok": True}

        # ---- Dateien ----
        if p == "/open_file":
            path = os.path.abspath(os.path.expanduser(data.get("path") or ""))
            if not os.path.exists(path):
                return 404, {"error": "Datei fehlt: %s" % path}
            (os.startfile(path) if IS_WIN else subprocess.Popen(["xdg-open", path]))
            return 200, {"ok": True, "opened": path}
        if p == "/open_folder":
            path = os.path.abspath(os.path.expanduser(data.get("path") or ""))
            if not os.path.isdir(path):
                return 404, {"error": "Ordner fehlt: %s" % path}
            (os.startfile(path) if IS_WIN else subprocess.Popen(["xdg-open", path]))
            return 200, {"ok": True, "opened": path}
        if p == "/organize_folder":
            g = need_confirm("move", data,
                             "I would sort the files in '%s' into subfolders by extension."
                             % data.get("path"), force=True)
            if g:
                return 200, g
            return 200, organize_folder(data.get("path"))
        if p == "/file_op":
            op = (data.get("op") or "").lower()
            label = {"delete": "delete", "move": "move", "copy": "overwrite"}.get(op, op)
            summary = {"delete": "I would delete '%s'." % data.get("src"),
                       "move": "I would move '%s' to '%s'." % (data.get("src"), data.get("dst")),
                       "copy": "I would copy '%s' to '%s'." % (data.get("src"), data.get("dst"))
                       }.get(op, "I would perform the file operation '%s'." % op)
            g = need_confirm(label, data, summary, force=True)
            if g:
                return 200, g
            return 200, file_op(op, data.get("src"), data.get("dst"))
        if p == "/clipboard":
            clipboard_set(data.get("text", ""))
            return 200, {"ok": True}

        # ---- Workspace: Datei-Erstellung / Projekt / Ausfuehrung ----
        if p == "/write_file":
            try:
                ap, sensitive = resolve_path(data.get("path"))
            except ValueError as e:
                return 400, {"error": str(e)}
            overwrite = bool(data.get("overwrite"))
            exists = os.path.exists(ap)
            if exists and not overwrite:
                return 409, {"error": "File already exists; overwrite:true required.", "path": ap}
            if sensitive or (exists and overwrite):
                where = "outside the workspace " if sensitive else ""
                extra = " (overwrites the existing file)" if exists else ""
                g = need_confirm("write_file", data,
                                 "I would write the file %s'%s'%s." % (where, ap, extra),
                                 force=True)
                if g:
                    return 200, g
            b = _write_text_file(ap, data.get("content"))
            return 200, {"ok": True, "path": ap, "bytes": b}

        if p == "/read_file":
            try:
                ap, _sensitive = resolve_path(data.get("path"))
            except ValueError as e:
                return 400, {"error": str(e)}
            if not os.path.isfile(ap):
                return 404, {"error": "Datei fehlt: %s" % ap}
            limit = 200 * 1024
            with open(ap, "rb") as f:
                raw = f.read(limit + 1)
            truncated = len(raw) > limit
            text = raw[:limit].decode("utf-8", "replace")
            return 200, {"content": text, "path": ap, "bytes": len(raw[:limit]),
                         "truncated": truncated}

        if p == "/create_project":
            name = (data.get("name") or "").strip()
            if not name:
                return 400, {"error": "kein Projektname angegeben"}
            files = data.get("files")
            if not isinstance(files, list) or not files:
                return 400, {"error": "keine Dateien angegeben (files:[{path,content}])"}
            try:
                proj_dir, sensitive = resolve_path(name)
            except ValueError as e:
                return 400, {"error": str(e)}
            if sensitive:
                g = need_confirm("create_project", data,
                                 "I would create a project OUTSIDE the workspace at '%s' "
                                 "(%d file(s))." % (proj_dir, len(files)), force=True)
                if g:
                    return 200, g
            return 200, create_project(proj_dir, files, bool(data.get("open", True)))

        if p == "/run_command":
            command = str(data.get("command") or "")
            if not command.strip():
                return 400, {"error": "kein Befehl angegeben"}
            cwd_raw = data.get("cwd")
            try:
                cwd = resolve_path(cwd_raw)[0] if cwd_raw else WORKSPACE_DIR
            except ValueError as e:
                return 400, {"error": str(e)}
            if not os.path.isdir(cwd):
                cwd = WORKSPACE_DIR
            g = need_confirm("run_command", data,
                             "I would run the command: %s  (in %s)" % (command, cwd),
                             force=True)
            if g:
                return 200, g
            return 200, run_command(command, cwd, RUN_TIMEOUT)

        if p == "/run_file":
            try:
                ap, _sensitive = resolve_path(data.get("path"))
            except ValueError as e:
                return 400, {"error": str(e)}
            if not os.path.isfile(ap):
                return 404, {"error": "Datei fehlt: %s" % ap}
            cmd, kind = run_file_cmd(ap, data.get("args"))
            if kind == "html":
                _open_default(ap)   # .html nur im Browser oeffnen (kein "ausfuehren", kein Confirm)
                return 200, {"ok": True, "opened": ap, "url": _file_url(ap)}
            if kind == "open":
                g = need_confirm("run_file", data,
                                 "I would open/run '%s' with its default program." % ap,
                                 force=True)
                if g:
                    return 200, g
                _open_default(ap)
                return 200, {"ok": True, "opened": ap}
            g = need_confirm("run_file", data,
                             "I would run the file: %s" % cmd, force=True)
            if g:
                return 200, g
            cwd = os.path.dirname(ap) or WORKSPACE_DIR
            return 200, run_command(cmd, cwd, RUN_TIMEOUT)

        if p == "/open_path":
            raw = (data.get("path") or "").strip()
            if not raw:
                return 400, {"error": "kein Pfad angegeben"}
            if re.match(r'^https?://', raw, re.I):
                _open_default(raw)
                return 200, {"ok": True, "opened": raw}
            try:
                ap, _sensitive = resolve_path(raw)
            except ValueError as e:
                return 400, {"error": str(e)}
            if not os.path.exists(ap):
                return 404, {"error": "Pfad fehlt: %s" % ap}
            _open_default(ap)
            return 200, {"ok": True, "opened": ap}

        # ---- Browser ----
        if p == "/open_url":
            # Eine Website im EIGENEN Browser öffnen ist harmlos -> keine Allowlist, nur http/https.
            url = normalize_url(data.get("url") or "")
            if not is_web_url(url):
                return 200, {"error": "keine gueltige Web-Adresse (nur http/https)", "url": url}
            (os.startfile(url) if IS_WIN else webbrowser.open(url))
            return 200, {"ok": True, "opened": url}
        if p == "/browse_page":
            # Server-seitiges Lesen: öffentliche Hosts (SSRF-Schutz) + optionale Allowlist.
            url = normalize_url(data.get("url") or "")
            if not is_web_url(url) or is_private_host(urllib.parse.urlparse(url).hostname):
                return 200, {"error": "URL nicht erlaubt (nur oeffentliche http/https-Adressen)", "url": url}
            if not domain_allowed(url):
                return 200, {"error": "domain not allowed", "url": url, "allowed": ALLOWED_DOMAINS}
            try:
                body = _fetch_text(url)
            except Exception as e:
                return 502, {"error": "fetch fehlgeschlagen: %r" % e}
            title, text = _html_to_text(body)
            return 200, {"title": title, "text": text, "url": url}
        if p == "/browser_act":
            url = normalize_url(data.get("url") or "")
            if not is_web_url(url) or is_private_host(urllib.parse.urlparse(url).hostname):
                return 200, {"error": "URL nicht erlaubt (nur oeffentliche http/https-Adressen)", "url": url}
            if not domain_allowed(url):
                return 200, {"error": "domain not allowed", "url": url}
            g = need_confirm("browser_act", data,
                             "I would interact with '%s' (%d write steps)."
                             % (url, len(data.get("steps") or [])), force=True)
            if g:
                return 200, g
            # Ehrlicher Platzhalter: schreibende CDP-Steuerung ist Phase 2, nicht gefaket.
            return 501, {"error": "browser_act (schreibende Interaktion) ist noch nicht implementiert.",
                         "phase": 2,
                         "hinweis": "Geplant via Chrome DevTools Protocol (headed Chrome mit "
                                    "--remote-debugging-port). Nutze bis dahin open_url + browse_page.",
                         "received_steps": data.get("steps")}

        # ---- Vision & Agent ----
        if p == "/see_screen":
            try:
                png = grab_png()
            except Exception as e:
                return 200, {"error": repr(e)}
            b64 = base64.b64encode(png).decode("ascii")
            try:
                answer = ollama_vision(data.get("question"), b64, timeout=int(data.get("timeout") or 300))
            except Exception as e:
                return 502, {"error": "Ollama nicht erreichbar oder Fehler: %r" % e,
                             "model": VISION_MODEL}
            return 200, {"answer": answer, "model": VISION_MODEL}
        if p == "/agent_task":
            g = need_confirm("agent_task", data,
                             "I would work autonomously on this PC (max %s steps), goal: %s"
                             % (data.get("max_steps") or 6, data.get("goal")), force=True)
            if g:
                return 200, g
            return 200, agent_task(data.get("goal"), data.get("max_steps"))

        # ---- E-Mail ----
        if p == "/send_email":
            g = need_confirm("send_email", data,
                             "I would send an email to '%s' (subject: %s)."
                             % (data.get("to"), data.get("subject")), force=True)
            if g:
                return 200, g
            return 200, send_email(data.get("to"), data.get("subject"), data.get("body"))

        return 404, {"error": "nicht gefunden: %s" % p}

    # ---- Logging-Helfer ----
    def _logged(self, path, data, obj):
        if path in SKIP_LOG:
            return
        if isinstance(obj, dict) and obj.get("needs_confirm"):
            status = "needs_confirm"
        elif isinstance(obj, dict) and obj.get("error"):
            status = "error"
        else:
            status = "ok"
        log_action(path, data, status)

    def log_message(self, fmt, *args):
        print("[Aktion] " + (fmt % args))


def main():
    print("Jarvis Aktions-Server auf http://%s:%d  (Beenden: Strg+C)" % (HOST, PORT))
    caps = capabilities()["libs"]
    print("[Aktion] Libs: " + ", ".join("%s=%s" % (k, v) for k, v in caps.items()))
    print("[Aktion] Log-Datei: %s" % LOG_FILE)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
