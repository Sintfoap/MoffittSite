"""
Drift on the website — sign in to sintfoap.xyz from the terminal and use your
account's todo list instead of a local vault.

  drift login [--site URL]    prints a code, you approve it in your browser
  drift whoami
  drift logout

Signing in never asks for your password here: the site shows the code and
you approve it while signed in there (two-factor included). The token it hands
back is kept in ~/.config/drift/site.json, readable only by you.

`RemoteStore` has the same methods the CLI and terminal UI use on `Store`, so
both work unchanged against the site. Stdlib only.
"""
from __future__ import annotations

import json
import os
import socket
import stat
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any, Callable

from .core import DEFAULTS, Task, parse_quick, sort_key

DEFAULT_SITE = "https://sintfoap.xyz"
USER_AGENT = f"drift-cli/1 ({socket.gethostname()[:40]})"
COOKIE = "__Host-sid"


class SiteError(Exception):
    pass


class SignedOut(SiteError):
    def __init__(self, msg: str = "not signed in to the site; run  drift login"):
        super().__init__(msg)


# ─────────────────────────────── config file ────────────────────────────────

def config_path() -> Path:
    base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "drift" / "site.json"


def load_login() -> dict | None:
    """{site, token, username} from the last `drift login`, or None."""
    try:
        data = json.loads(config_path().read_text())
    except (OSError, ValueError):
        return None
    return data if data.get("site") and data.get("token") else None


def save_login(data: dict) -> None:
    p = config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    # Create it private from the start, so the token is never briefly world-readable.
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
    site = (site or os.environ.get("DRIFT_SITE") or DEFAULT_SITE).strip().rstrip("/")
    if "://" not in site:
        site = "https://" + site
    if not site.startswith(("https://", "http://localhost", "http://127.0.0.1")):
        raise SiteError("the site address must start with https://")
    return site


# ──────────────────────────────── HTTP ──────────────────────────────────────

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


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # /logout answers with a redirect to the sign-in page; there's nothing to follow.
    def redirect_request(self, *a, **k):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


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
    say(f"  Open  {start['verification_uri']}\n"
        f"  and enter  {start['user_code']}\n")
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
            info = {"site": site, "token": res["token"], "username": res.get("username", ""),
                    "display_name": res.get("display_name", "")}
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
    raise SiteError("the code expired before it was approved; run  drift login  again")


def logout() -> str | None:
    """Ends the session on the site (best effort) and forgets it here. Returns the site, if any."""
    info = load_login()
    if not info:
        return None
    try:
        call(info["site"], "POST", "/logout", token=info["token"])
    except SiteError:
        pass        # still forget it locally; it expires on its own
    forget_login()
    return info["site"]


def whoami() -> dict:
    info = load_login()
    if not info:
        raise SignedOut()
    status, me = call(info["site"], "GET", "/login/cli/me", token=info["token"])
    if status != 200:
        raise _error(status, me)
    return {**me, "site": info["site"]}


# ─────────────────────────────── RemoteStore ────────────────────────────────

_TASK_FIELDS = list(DEFAULTS) + ["updated"]


def _task(d: dict) -> Task:
    vals = {k: d[k] for k in _TASK_FIELDS if k in d}
    if "order" in vals:
        vals["order"] = float(vals["order"] or 0)
    return Task(id=d["id"], **vals)


class RemoteStore:
    """Your todo list on the site, with the methods frontends use on `Store`."""

    def __init__(self, site: str, token: str, username: str = ""):
        self.site, self.token, self.username = site, token, username
        self._tasks: dict[str, Task] = {}
        self._fingerprint = ""
        self._lock = threading.RLock()
        self._listeners: list[Callable[[], None]] = []
        self.version = 0
        self.error: str | None = None     # last background sync problem, for the UI
        self.refresh()

    @classmethod
    def from_login(cls) -> "RemoteStore":
        info = load_login()
        if not info:
            raise SignedOut()
        return cls(info["site"], info["token"], info.get("username", ""))

    def _call(self, method: str, path: str, body: Any = None) -> Any:
        status, data = call(self.site, method, path, body, self.token)
        if status >= 400:
            raise _error(status, data)
        return data

    # ── reading ────────────────────────────────────────────────────────
    def refresh(self) -> bool:
        data = self._call("GET", "/todo/api/tasks")
        tasks = {d["id"]: _task(d) for d in data.get("tasks", [])}
        fp = json.dumps(sorted(data.get("tasks", []), key=lambda d: d["id"]), sort_keys=True)
        with self._lock:
            changed = fp != self._fingerprint
            self._tasks, self._fingerprint = tasks, fp
            if changed:
                self.version += 1
        if changed:
            for fn in list(self._listeners):
                try:
                    fn()
                except Exception:
                    pass
        return changed

    def get(self, tid: str) -> Task | None:
        with self._lock:
            return self._tasks.get(tid)

    def tasks(self, include_deleted: bool = False) -> list[Task]:
        with self._lock:
            out = list(self._tasks.values())
        out.sort(key=sort_key)
        return out

    def projects(self) -> list[str]:
        return sorted({t.project for t in self.tasks() if t.project})

    def tags(self) -> list[str]:
        return sorted({g for t in self.tasks() for g in t.tags})

    # ── writing ────────────────────────────────────────────────────────
    def add(self, title: str, **fields: Any) -> Task:
        t = _task(self._call("POST", "/todo/api/tasks", {"title": title.strip(), **fields}))
        self.refresh()
        return self.get(t.id) or t

    def update(self, tid: str, **changes: Any) -> Task:
        t = _task(self._call("PATCH", f"/todo/api/tasks/{tid}", changes))
        self.refresh()
        return self.get(tid) or t

    def toggle(self, tid: str) -> Task:
        t = self.get(tid)
        if t is None:
            raise KeyError(tid)
        return self.update(tid, done=not t.done)

    def delete(self, tid: str) -> None:
        self._call("DELETE", f"/todo/api/tasks/{tid}")
        self.refresh()

    def quick_add(self, text: str) -> Task:
        title, fields = parse_quick(text)
        return self.add(title, **fields)

    # ── live updates ───────────────────────────────────────────────────
    def subscribe(self, fn: Callable[[], None]) -> None:
        self._listeners.append(fn)

    def watch(self, interval: float = 5.0) -> threading.Thread:
        """Re-fetch every few seconds so edits from the website or another terminal show up."""
        def loop():
            while True:
                time.sleep(interval)
                try:
                    self.refresh()
                    self.error = None
                except SiteError as e:
                    self.error = str(e)
        th = threading.Thread(target=loop, daemon=True, name="drift-site-watch")
        th.start()
        return th

    def stats(self) -> dict[str, Any]:
        ts = self.tasks()
        host = self.site.split("://", 1)[-1]
        return {
            "vault": self.site, "node": self.username or host, "nodes": [host],
            "site": host, "user": self.username,
            "open": sum(not t.done for t in ts), "done": sum(t.done for t in ts),
            "version": self.version,
        }
