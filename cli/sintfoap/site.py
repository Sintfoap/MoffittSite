"""
Talking to sintfoap.xyz: signing in, signing out, and reading the dashboard.

Signing in never asks for a password here. The site shows a code, you approve
it in a browser where you're signed in (two-factor included), and the site
hands back a session token (see src/cli.js). It's kept in
~/.config/sintfoap/login.json, readable only by you. Stdlib only.
"""
from __future__ import annotations

import json
import os
import socket
import stat
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any, Callable

from . import __version__

DEFAULT_SITE = "https://sintfoap.xyz"
USER_AGENT = f"sintfoap-cli/{__version__} ({socket.gethostname()[:40]})"
COOKIE = "__Host-sid"


class SiteError(Exception):
    pass


class SignedOut(SiteError):
    def __init__(self, msg: str = "not signed in; run  sintfoap login"):
        super().__init__(msg)


# ─────────────────────────────── saved login ────────────────────────────────

def config_path() -> Path:
    base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "sintfoap" / "login.json"


def load_login() -> dict | None:
    """{site, token, username} from the last `sintfoap login`, or None."""
    try:
        data = json.loads(config_path().read_text())
    except (OSError, ValueError):
        return None
    return data if data.get("site") and data.get("token") else None


def save_login(data: dict) -> None:
    p = config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    # Created private from the start, so the token is never briefly readable by others.
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(fd, "w") as fh:
        json.dump(data, fh, indent=2)
    os.chmod(p, stat.S_IRUSR | stat.S_IWUSR)


def forget_login() -> None:
    try:
        config_path().unlink()
    except FileNotFoundError:
        pass


def clean_site(site: str | None) -> str:
    site = (site or os.environ.get("SINTFOAP_SITE") or DEFAULT_SITE).strip().rstrip("/")
    if "://" not in site:
        site = "https://" + site
    if not site.startswith(("https://", "http://localhost", "http://127.0.0.1")):
        raise SiteError("the site address must start with https://")
    return site


# ──────────────────────────────── HTTP ──────────────────────────────────────

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # /logout answers with a redirect to the sign-in page; there's nothing to follow.
    def redirect_request(self, *a, **k):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def call(site: str, method: str, path: str, body: Any = None, token: str | None = None,
         timeout: float = 15) -> tuple[int, Any]:
    """One request. Returns (status, parsed JSON or None). Raises SiteError if unreachable."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(site + path, data=data, method=method)
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Cookie", f"{COOKIE}={token}")
    try:
        with _opener.open(req, timeout=timeout) as res:
            status, raw = res.status, res.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    except (urllib.error.URLError, OSError) as e:
        raise SiteError(f"couldn't reach {site}: {getattr(e, 'reason', e)}") from None
    try:
        return status, json.loads(raw) if raw else None
    except ValueError:
        return status, None


def _error(status: int, data: Any) -> SiteError:
    if status == 401:
        return SignedOut()
    msg = data.get("error") if isinstance(data, dict) else None
    return SiteError(f"the site said: {msg}" if msg else f"the site answered {status}")


# ──────────────────────────────── login ─────────────────────────────────────

def login(site: str | None = None, open_browser: bool = True,
          say: Callable[[str], None] = print, sleep: Callable[[float], None] = time.sleep) -> dict:
    site = clean_site(site)
    status, start = call(site, "POST", "/login/cli/start", {"name": socket.gethostname()[:60]})
    if status != 200 or not isinstance(start, dict):
        raise _error(status, start)
    say(f"  Open  {start['verification_uri']}\n  and enter  {start['user_code']}\n")
    if open_browser:
        try:
            webbrowser.open(start["verification_uri_complete"])
        except Exception:
            pass
    say("  Waiting for you to approve it in the browser… (ctrl+c to stop)")
    interval = max(1, int(start.get("interval", 5)))
    deadline = time.monotonic() + int(start.get("expires_in", 600))
    while time.monotonic() < deadline:
        sleep(interval)
        status, res = call(site, "POST", "/login/cli/token", {"device_code": start["device_code"]})
        if status == 200 and isinstance(res, dict) and res.get("token"):
            info = {"site": site, "token": res["token"], "username": res.get("username", "")}
            save_login(info)
            return info
        err = res.get("error") if isinstance(res, dict) else None
        if err == "authorization_pending":
            continue
        if err == "access_denied":
            raise SiteError("the sign-in was refused in the browser")
        if err == "expired_token":
            break
        raise _error(status, res)
    raise SiteError("the code expired before it was approved; run  sintfoap login  again")


def logout() -> str | None:
    """Ends the session on the site (best effort) and forgets it here. Returns the site, if any."""
    info = load_login()
    if not info:
        return None
    try:
        call(info["site"], "POST", "/logout", token=info["token"])
    except SiteError:
        pass        # still forget it here; it expires on its own
    forget_login()
    return info["site"]


def _get(path: str) -> dict:
    info = load_login()
    if not info:
        raise SignedOut()
    status, data = call(info["site"], "GET", path, token=info["token"])
    if status != 200 or not isinstance(data, dict):
        raise _error(status, data)
    return data


def whoami() -> dict:
    return {**_get("/login/cli/me"), "site": load_login()["site"]}


def dashboard() -> dict:
    """{site, user, apps, account}: what /dashboard shows. See src/cli.js."""
    return _get("/login/cli/dashboard")


# ──────────────────────────────── chat ──────────────────────────────────────
# The same API the /chat/ page uses (src/chat.js). The terminal sends no Origin
# header, which the site counts as same-site, like a form post from the page.

def _chat(method: str, path: str, body: Any = None) -> Any:
    info = load_login()
    if not info:
        raise SignedOut()
    status, data = call(info["site"], method, "/chat/api" + path, body, token=info["token"])
    if status not in (200, 201):
        raise _error(status, data)
    return data


def chat_state() -> dict:
    """{user, rooms}: every room, with joined, unread and manage for this account."""
    return _chat("GET", "/state")


def chat_messages(room: str, since: int | None = None, before: int | None = None) -> dict:
    """{seq, more, joined, messages}: the newest page, older ones (before), or changes (since)."""
    q = f"?since={since}" if since is not None else f"?before={before}" if before is not None else ""
    return _chat("GET", f"/rooms/{room}/messages{q}")


def chat_post(room: str, text: str) -> dict:
    return _chat("POST", f"/rooms/{room}/messages", {"body": text})


def chat_delete(room: str, message_id: int) -> dict:
    return _chat("DELETE", f"/rooms/{room}/messages/{message_id}")


def chat_create(name: str, topic: str = "") -> dict:
    return _chat("POST", "/rooms", {"name": name, "topic": topic})


def chat_update(room: str, **fields: str) -> dict:
    return _chat("PATCH", f"/rooms/{room}", fields)


def chat_join(room: str) -> dict:
    return _chat("POST", f"/rooms/{room}/join")


def chat_leave(room: str) -> dict:
    return _chat("POST", f"/rooms/{room}/leave")
