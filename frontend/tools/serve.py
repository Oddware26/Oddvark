#!/usr/bin/env python
# Oddvark web server for development: serves the frontend/ directory WITH no-cache headers,
# so that changes to app.js/.css are visible immediately (no "hard reload" needed).
import http.server
import socketserver
import os

PORT = int(os.environ.get("PORT", "8000"))
HOST = os.environ.get("HOST", "127.0.0.1")
# tools/serve.py -> parent folder is frontend/
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # Explicitly mark every response as non-cacheable.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # keep quiet


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    with Server((HOST, PORT), Handler) as httpd:
        print("Oddvark Web (no-cache) at http://localhost:%d  -  root: %s" % (PORT, ROOT), flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
