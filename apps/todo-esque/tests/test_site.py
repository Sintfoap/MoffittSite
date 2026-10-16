"""drift login and RemoteStore against a stand-in for the site's API (see src/cli.js)."""
import json
import os
import stat
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from drift import site


class FakeSite(BaseHTTPRequestHandler):
    """Just enough of the Worker: /login/cli/*, /logout and /todo/api/tasks."""
    state: dict = {}

    def log_message(self, *a):
        pass

    def _send(self, status, body=None):
        raw = json.dumps(body).encode() if body is not None else b""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n)) if n else {}

    def _signed_in(self):
        return self.headers.get("Cookie") == "__Host-sid=tok123" and self.state["session"]

    def do_POST(self):
        s, b = self.state, self._body()
        if self.path == "/login/cli/start":
            s["name"] = b.get("name")
            return self._send(200, {"device_code": "dev", "user_code": "ABCD-EFGH", "interval": 1, "expires_in": 600,
                                    "verification_uri": "http://x/login/cli",
                                    "verification_uri_complete": "http://x/login/cli?code=ABCD-EFGH"})
        if self.path == "/login/cli/token":
            s["polls"] += 1
            if s["polls"] < 3:
                return self._send(400, {"error": "authorization_pending"})
            if s["deny"]:
                return self._send(400, {"error": "access_denied"})
            s["session"] = True
            return self._send(200, {"token": "tok123", "username": "ryan", "display_name": "Ryan", "expires_in": 1})
        if self.path == "/logout":
            s["session"] = False
            self.send_response(303)
            self.send_header("Location", "/login")
            self.end_headers()
            return
        if not self._signed_in():
            return self._send(401, {"error": "not signed in"})
        if self.path == "/todo/api/tasks":
            if not b.get("title"):
                return self._send(400, {"error": "title is required"})
            tid = f"t_{len(s['tasks']):04d}aa"
            s["tasks"][tid] = {"id": tid, "title": b["title"], "done": False, "priority": b.get("priority", 0),
                               "due": b.get("due"), "project": b.get("project", ""), "tags": b.get("tags", []),
                               "order": 1, "deleted": False, "updated": "x"}
            return self._send(201, s["tasks"][tid])
        self._send(404, {"error": "not found"})

    def do_GET(self):
        if not self._signed_in():
            return self._send(401, {"error": "not signed in"})
        if self.path == "/login/cli/me":
            return self._send(200, {"username": "ryan", "display_name": "Ryan", "areas": ["todo"]})
        if self.path == "/todo/api/tasks":
            return self._send(200, {"tasks": [t for t in self.state["tasks"].values() if not t["deleted"]]})
        self._send(404)

    def _change(self, changes):
        tid = self.path.rsplit("/", 1)[1]
        if not self._signed_in():
            return self._send(401, {"error": "not signed in"})
        t = self.state["tasks"].get(tid)
        if not t:
            return self._send(404, {"error": "not found"})
        t.update(changes)
        self._send(200, t)

    def do_PATCH(self):
        self._change(self._body())

    def do_DELETE(self):
        self._change({"deleted": True})


@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", tempfile.mkdtemp())
    FakeSite.state = {"polls": 0, "deny": False, "session": False, "tasks": {}}
    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeSite)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


def test_login_waits_for_approval_and_saves_a_private_token(fake):
    said = []
    info = site.login(fake, open_browser=False, say=said.append, sleep=lambda s: None)
    assert info["username"] == "ryan" and info["token"] == "tok123"
    assert "ABCD-EFGH" in said[0]
    assert FakeSite.state["polls"] == 3
    p = site.config_path()
    assert json.loads(p.read_text())["site"] == fake
    assert stat.S_IMODE(os.stat(p).st_mode) == 0o600
    assert site.whoami()["username"] == "ryan"


def test_refused_login_saves_nothing(fake):
    FakeSite.state["deny"] = True
    with pytest.raises(site.SiteError, match="refused"):
        site.login(fake, open_browser=False, say=lambda s: None, sleep=lambda s: None)
    assert site.load_login() is None


def test_remote_store_reads_and_writes_the_site_list(fake):
    site.login(fake, open_browser=False, say=lambda s: None, sleep=lambda s: None)
    store = site.RemoteStore.from_login()
    seen = []
    store.subscribe(lambda: seen.append(1))
    t = store.quick_add("Buy oat milk #groceries +home !2")
    assert (t.title, t.project, t.tags, t.priority) == ("Buy oat milk", "home", ["groceries"], 2)
    assert store.toggle(t.id).done is True
    store.delete(t.id)
    assert store.tasks() == []
    assert store.update(t.id, deleted=False).title == "Buy oat milk"     # undo
    assert [x.title for x in store.tasks()] == ["Buy oat milk"]
    assert seen, "listeners hear about changes"
    assert store.stats()["user"] == "ryan"


def test_signed_out_session_says_how_to_sign_back_in(fake):
    site.login(fake, open_browser=False, say=lambda s: None, sleep=lambda s: None)
    store = site.RemoteStore.from_login()
    FakeSite.state["session"] = False
    with pytest.raises(site.SignedOut, match="drift login"):
        store.refresh()


def test_logout_ends_the_session_and_forgets_it(fake):
    site.login(fake, open_browser=False, say=lambda s: None, sleep=lambda s: None)
    assert site.logout() == fake
    assert FakeSite.state["session"] is False
    assert site.load_login() is None
    assert site.logout() is None


def test_site_addresses_must_be_https():
    assert site.clean_site("sintfoap.xyz/") == "https://sintfoap.xyz"
    with pytest.raises(site.SiteError):
        site.clean_site("http://sintfoap.xyz")


def test_terminal_ui_runs_on_the_site_list(fake):
    textual = pytest.importorskip("textual")
    import asyncio
    from drift.tui import DriftApp
    site.login(fake, open_browser=False, say=lambda s: None, sleep=lambda s: None)
    store = site.RemoteStore.from_login()

    async def go():
        app = DriftApp(store)
        async with app.run_test(size=(110, 32)) as pilot:
            await pilot.press("a")
            await pilot.press(*"Water plants #home")
            await pilot.press("enter")
            await pilot.pause()
            assert any(t.title == "Water plants" for t in store.tasks())
            assert "ryan" in str(app.query_one("#status").render())
            # a dropped session shows an error instead of crashing the app
            FakeSite.state["session"] = False
            await pilot.press("escape")
            app.query_one("#tasks").focus()
            await pilot.press("space")
            await pilot.pause()
            assert any("drift login" in n.message for n in app._notifications)
    asyncio.run(go())
