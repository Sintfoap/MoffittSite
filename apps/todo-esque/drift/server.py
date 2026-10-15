"""
Drift web bridge — a tiny stdlib HTTP server over a Store.

    GET    /                    the web UI
    GET    /api/tasks           all tasks + projects + tags + stats
    POST   /api/tasks           {"text": "quick add #tag ^fri"} or explicit fields
    PATCH  /api/tasks/<id>      {"done": true, "title": "…"}
    DELETE /api/tasks/<id>
    GET    /api/events          Server-Sent Events; "change" whenever the vault changes

The server is just another node: it writes to its own log, and it notices
edits made by the TUI, the CLI or synced devices by watching the vault.
"""
from __future__ import annotations

import json
import os
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from .core import Store

WEB = Path(__file__).resolve().parent.parent / "web" / "index.html"


def snapshot(store: Store) -> dict:
    return {
        "tasks": [t.to_dict() for t in store.tasks()],
        "projects": store.projects(),
        "tags": store.tags(),
        "stats": store.stats(),
    }


def make_handler(store: Store, token: str | None, subscribers: list):
    class H(BaseHTTPRequestHandler):
        server_version = "Drift/1.0"

        def log_message(self, *a):  # quiet
            pass

        def end_headers(self):
            # lets a copy of the web UI hosted elsewhere talk to this server
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
            super().end_headers()

        def do_OPTIONS(self):
            self.send_response(204)
            self.end_headers()

        # ── helpers ──
        def _auth(self) -> bool:
            if not token:
                return True
            q = urlparse(self.path).query
            if f"token={token}" in q.split("&"):
                return True
            if self.headers.get("Authorization") == f"Bearer {token}":
                return True
            self._json({"error": "unauthorized"}, 401)
            return False

        def _json(self, obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}") if n else {}

        def _tid(self, path: str) -> str:
            return path.rstrip("/").rsplit("/", 1)[-1]

        # ── routes ──
        def do_GET(self):
            path = urlparse(self.path).path
            if path in ("/", "/index.html"):
                body = WEB.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if not self._auth():
                return
            if path == "/api/tasks":
                store.refresh()
                return self._json(snapshot(store))
            if path == "/api/events":
                return self._sse()
            self._json({"error": "not found"}, 404)

        def do_POST(self):
            if not self._auth():
                return
            if urlparse(self.path).path != "/api/tasks":
                return self._json({"error": "not found"}, 404)
            b = self._body()
            try:
                if "text" in b:
                    t = store.quick_add(b["text"])
                else:
                    title = b.pop("title", "")
                    t = store.add(title, **b)
                self._json(t.to_dict(), 201)
            except (KeyError, ValueError) as e:
                self._json({"error": str(e)}, 400)

        def do_PATCH(self):
            if not self._auth():
                return
            try:
                t = store.update(self._tid(urlparse(self.path).path), **self._body())
                self._json(t.to_dict())
            except KeyError as e:
                self._json({"error": f"unknown {e}"}, 404)
            except ValueError as e:
                self._json({"error": str(e)}, 400)

        def do_DELETE(self):
            if not self._auth():
                return
            try:
                store.delete(self._tid(urlparse(self.path).path))
                self._json({"ok": True})
            except KeyError:
                self._json({"error": "not found"}, 404)

        def _sse(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            q: queue.Queue = queue.Queue()
            subscribers.append(q)
            try:
                self.wfile.write(f"event: hello\ndata: {store.version}\n\n".encode())
                self.wfile.flush()
                while True:
                    try:
                        v = q.get(timeout=15)
                        msg = f"event: change\ndata: {v}\n\n"
                    except queue.Empty:
                        msg = ": ping\n\n"
                    self.wfile.write(msg.encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                if q in subscribers:
                    subscribers.remove(q)

    return H


def serve(store: Store, host: str = "127.0.0.1", port: int = 7878,
          token: str | None = None) -> None:
    token = token or os.environ.get("DRIFT_TOKEN")
    subscribers: list[queue.Queue] = []

    def notify():
        for q in list(subscribers):
            q.put(store.version)

    store.subscribe(notify)
    store.watch()
    httpd = ThreadingHTTPServer((host, port), make_handler(store, token, subscribers))
    httpd.daemon_threads = True
    url = f"http://{host}:{port}/" + (f"?token={token}" if token else "")
    print(f"  ◆ Drift web  →  {url}")
    print(f"    vault: {store.vault}   node: {store.node}")
    if host in ("0.0.0.0", "::") and not token:
        print("    ⚠  listening on all interfaces without --token")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
