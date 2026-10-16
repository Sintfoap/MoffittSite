"""sintfoap login, logout and the dashboard, against a stand-in for the site (see src/cli.js)."""
import asyncio
import json
import os
import stat
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from sintfoap import site
from sintfoap.__main__ import plain


def dashboard_data(origin, **account):
    return {
        "site": origin,
        "user": {"username": "ryan", "display_name": "Ryan M", "admin": False},
        "apps": [{"name": "Drift", "blurb": "Your tasks.", "url": origin + "/todo/"}],
        "account": {"two_factor": True, "sessions": 2, "recovery_codes_left": 7, "email": None,
                    "email_confirmed": False, "setup_needed": None, "url": origin + "/account", **account},
    }


class FakeSite(BaseHTTPRequestHandler):
    """Just enough of the Worker: /login/cli/*, /logout."""
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

    def _signed_in(self):
        return self.headers.get("Cookie") == "__Host-sid=tok123" and self.state["session"]

    def do_POST(self):
        s = self.state
        n = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(n)
        if self.path == "/login/cli/start":
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
            return self._send(200, {"token": "tok123", "username": "ryan", "display_name": "Ryan M", "expires_in": 1})
        if self.path == "/logout":
            s["session"] = False
            self.send_response(303)
            self.send_header("Location", "/login")
            self.end_headers()
            return
        self._send(404)

    def do_GET(self):
        if not self._signed_in():
            return self._send(401, {"error": "not signed in"})
        if self.path == "/login/cli/me":
            return self._send(200, {"username": "ryan", "display_name": "Ryan M", "areas": ["todo"]})
        if self.path == "/login/cli/dashboard":
            return self._send(200, self.state["dashboard"])
        self._send(404)


@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", tempfile.mkdtemp())
    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeSite)
    origin = f"http://127.0.0.1:{srv.server_port}"
    FakeSite.state = {"polls": 0, "deny": False, "session": False, "dashboard": dashboard_data(origin)}
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield origin
    srv.shutdown()


def sign_in(origin):
    return site.login(origin, open_browser=False, say=lambda s: None, sleep=lambda s: None)


def test_login_waits_for_approval_and_saves_a_private_token(fake):
    said = []
    info = site.login(fake, open_browser=False, say=said.append, sleep=lambda s: None)
    assert info == {"site": fake, "token": "tok123", "username": "ryan"}
    assert "ABCD-EFGH" in said[0]
    assert FakeSite.state["polls"] == 3
    p = site.config_path()
    assert json.loads(p.read_text())["site"] == fake
    assert stat.S_IMODE(os.stat(p).st_mode) == 0o600
    assert site.whoami()["username"] == "ryan"


def test_refused_login_saves_nothing(fake):
    FakeSite.state["deny"] = True
    with pytest.raises(site.SiteError, match="refused"):
        sign_in(fake)
    assert site.load_login() is None


def test_logout_ends_the_session_and_forgets_it(fake):
    sign_in(fake)
    assert site.logout() == fake
    assert FakeSite.state["session"] is False
    assert site.load_login() is None
    assert site.logout() is None


def test_a_session_ended_on_the_site_says_how_to_sign_back_in(fake):
    sign_in(fake)
    FakeSite.state["session"] = False
    with pytest.raises(site.SignedOut, match="sintfoap login"):
        site.dashboard()


def test_site_addresses_must_be_https():
    assert site.clean_site("sintfoap.xyz/") == "https://sintfoap.xyz"
    with pytest.raises(site.SiteError):
        site.clean_site("http://sintfoap.xyz")


def test_plain_dashboard(fake, capsys):
    sign_in(fake)
    plain(site.dashboard())
    out = capsys.readouterr().out
    assert "Welcome, Ryan M" in out
    assert "Drift" in out and fake + "/todo/" in out
    assert "Two-factor is on" in out and "2 devices" in out and "7 recovery codes left" in out


def run_tui(test):
    pytest.importorskip("textual")
    from sintfoap.tui import Dashboard

    async def go():
        app = Dashboard()
        async with app.run_test(size=(100, 34)) as pilot:
            await pilot.pause()
            await test(app, pilot)
        return app
    return asyncio.run(go())


def test_terminal_dashboard_shows_the_cards_and_opens_them_in_the_browser_with_w(fake, monkeypatch):
    sign_in(fake)
    opened = []
    monkeypatch.setattr("webbrowser.open", opened.append)

    async def t(app, pilot):
        assert app.focused.id == "app-0"
        assert "Welcome, Ryan M" in str(app.query_one("#welcome").render())
        assert "7 recovery codes left" in str(app.query_one("#account").render())
        assert app.focused.page == "drift", "Drift opens in the terminal"
        await pilot.press("w")
        await pilot.press("down")
        assert app.focused.id == "account"
        await pilot.press("w")
        await pilot.press("r")
        await pilot.pause()
        assert app.focused.id == "account", "a refresh keeps your place"
    run_tui(t)
    assert opened == [fake + "/todo/", fake + "/account"]


def test_terminal_dashboard_points_unfinished_accounts_at_settings(fake):
    FakeSite.state["dashboard"] = {**dashboard_data(fake, setup_needed="set up two-factor"), "apps": []}
    sign_in(fake)

    async def t(app, pilot):
        assert "set up two-factor" in str(app.query_one("#notice").render())
        assert app.focused.id == "account"
    run_tui(t)


def test_terminal_dashboard_signs_out(fake):
    sign_in(fake)

    async def t(app, pilot):
        await pilot.press("o")
        await pilot.pause()
    app = run_tui(t)
    assert app.signed_out and site.load_login() is None
    assert FakeSite.state["session"] is False


def test_terminal_dashboard_closes_when_the_site_signed_it_out(fake):
    sign_in(fake)

    async def t(app, pilot):
        FakeSite.state["session"] = False
        await pilot.press("r")
        await pilot.pause()
    assert run_tui(t).signed_out


def test_terminal_dashboard_shows_today_and_the_account_checks(fake):
    data = dashboard_data(fake, recovery_codes_left=2, plugins_installed=1, email="r@x.test", email_confirmed=False)
    data["date"] = "Friday, October 16"
    data["today"] = {"late": [{"title": "Pay rent", "collection": "Home", "when": "2 days late", "start": "2026-10-14"}],
                     "due": [{"title": "Dentist", "collection": "Inbox", "when": "3 pm", "start": "2026-10-16T15:00"}],
                     "url": fake + "/todo/"}
    FakeSite.state["dashboard"] = data
    sign_in(fake)

    async def t(app, pilot):
        assert "FRIDAY, OCTOBER 16" in str(app.query_one("#kicker").render())
        assert ", Ryan" in str(app.query_one("#welcome").render())
        today = str(app.query_one("#today").render())
        assert today.index("Pay rent") < today.index("Dentist") and "2 days late" in today
        acct = str(app.query_one("#account").render())
        assert "1 plugin" in acct and "2 recovery codes left. Make new ones soon." in acct and "isn't confirmed" in acct
        await pilot.press("g")
        await pilot.press("s")
        await pilot.pause()
        assert type(app.screen).__name__ == "SettingsPage"
    run_tui(t)
