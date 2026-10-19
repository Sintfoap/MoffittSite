"""
Talking to sintfoap.xyz: signing in and out, and the JSON the terminal pages use
(dashboard, settings, Drift, the plugin store).

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
import urllib.parse
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


def api(method: str, path: str, body: Any = None) -> Any:
    """A signed-in request to the site's JSON API. Raises SignedOut or SiteError."""
    info = load_login()
    if not info:
        raise SignedOut()
    status, data = call(info["site"], method, path, body, token=info["token"])
    if not 200 <= status < 300 or data is None:
        raise _error(status, data)
    return data


def _get(path: str) -> dict:
    data = api("GET", path)
    if not isinstance(data, dict):
        raise SiteError("the site sent something unexpected")
    return data


def _get_list(path: str) -> list:
    data = api("GET", path)
    if not isinstance(data, list):
        raise SiteError("the site sent something unexpected")
    return data


def site_url(path: str = "") -> str:
    info = load_login()
    return (info["site"] if info else clean_site(None)) + path


def whoami() -> dict:
    return {**_get("/login/cli/me"), "site": load_login()["site"]}


def dashboard() -> dict:
    """{site, user, apps, account}: what /dashboard shows. See src/cli.js."""
    return _get("/login/cli/dashboard")


# ─────────────────────────────── settings ───────────────────────────────────
# What /account shows, minus everything that needs the password (src/cli.js).

def account() -> dict:
    return _get("/login/cli/account")


def save_display_name(name: str) -> dict:
    return api("POST", "/login/cli/account", {"display_name": name})


def sign_out_others() -> dict:
    return api("POST", "/login/cli/account/sessions")


# ──────────────────────────────── Drift ─────────────────────────────────────
# /todo/api/ (src/worker.js, src/drift.js)

def _q(s: str) -> str:
    return urllib.parse.quote(s, safe="")


def drift_state() -> dict:
    return _get("/todo/api/state")


def drift_version() -> str:
    return _get("/todo/api/version")["version"]


def add_item(fields: dict) -> dict:
    return api("POST", "/todo/api/items", fields)


def update_item(item_id: str, changes: dict) -> dict:
    return api("PATCH", f"/todo/api/items/{_q(item_id)}", changes)


def delete_item(item_id: str) -> dict:
    return api("DELETE", f"/todo/api/items/{_q(item_id)}")


def add_collection(fields: dict) -> dict:
    return api("POST", "/todo/api/collections", fields)


def update_collection(col_id: str, changes: dict) -> dict:
    return api("PATCH", f"/todo/api/collections/{_q(col_id)}", changes)


def delete_collection(col_id: str) -> dict:
    return api("DELETE", f"/todo/api/collections/{_q(col_id)}")


def share(col_id: str, username: str, role: str) -> dict:
    return api("POST", f"/todo/api/collections/{_q(col_id)}/shares", {"username": username, "role": role})


def unshare(col_id: str, username: str) -> dict:
    return api("DELETE", f"/todo/api/collections/{_q(col_id)}/shares/{_q(username)}")


def install(plugin_id: str) -> list[str]:
    return api("POST", f"/todo/api/installs/{_q(plugin_id)}")["installed"]


def uninstall(plugin_id: str) -> list[str]:
    return api("DELETE", f"/todo/api/installs/{_q(plugin_id)}")["installed"]


def installed() -> list[str]:
    return _get("/todo/api/installs")["installed"]


# ───────────────────────────── plugin store ─────────────────────────────────
# /plugins/api/ (src/store.js)

def store_state() -> dict:
    return _get("/plugins/api/state")


def store_plugin(plugin_id: str) -> dict:
    return _get(f"/plugins/api/store/{_q(plugin_id)}")


def new_plugin(fields: dict) -> dict:
    return api("POST", "/plugins/api/mine", fields)


def save_plugin(plugin_id: str, fields: dict) -> dict:
    return api("PATCH", f"/plugins/api/mine/{_q(plugin_id)}", fields)


def delete_plugin(plugin_id: str) -> dict:
    return api("DELETE", f"/plugins/api/mine/{_q(plugin_id)}")


def submit_plugin(plugin_id: str, note: str = "") -> dict:
    return api("POST", f"/plugins/api/mine/{_q(plugin_id)}/submit", {"note": note})


def withdraw_plugin(plugin_id: str) -> dict:
    return api("POST", f"/plugins/api/mine/{_q(plugin_id)}/withdraw")


def review_queue() -> list[dict]:
    return api("GET", "/plugins/api/review")


def review(plugin_id: str, version: int, decision: str, note: str = "") -> dict:
    return api("POST", f"/plugins/api/review/{_q(plugin_id)}/{int(version)}", {"decision": decision, "note": note})


# ──────────────────────────────── chat ──────────────────────────────────────
# /chat/api/ (src/chat.js)

def chat_state() -> dict:
    """{user, rooms, online, reactions, bridges}: every room you can see, with kind, joined, unread, mentions and
    manage; bridges says whether you can connect other platforms, and which."""
    return _get("/chat/api/state")


def chat_messages(room: str, since: int | None = None, before: int | None = None) -> dict:
    """{seq, more, joined, messages, here, typing, reads?}: the newest page, older ones (before), or changes (since)."""
    q = f"?since={int(since)}" if since is not None else f"?before={int(before)}" if before is not None else ""
    return _get(f"/chat/api/rooms/{_q(room)}/messages{q}")


def chat_post(room: str, text: str, reply_to: int | None = None) -> dict:
    """Sends a message; reply_to is the id of the message it answers, if any."""
    return api("POST", f"/chat/api/rooms/{_q(room)}/messages", {"body": text, **({"reply_to": int(reply_to)} if reply_to is not None else {})})


def chat_delete(room: str, message_id: int) -> dict:
    return api("DELETE", f"/chat/api/rooms/{_q(room)}/messages/{int(message_id)}")


def chat_edit(room: str, message_id: int, text: str) -> dict:
    """Change one of your own messages; returns it as it now is."""
    return api("PATCH", f"/chat/api/rooms/{_q(room)}/messages/{int(message_id)}", {"body": text})


def chat_react(room: str, message_id: int, emoji: str, on: bool = True) -> dict:
    """Add (or with on=False take back) a reaction; returns the message."""
    return api("POST", f"/chat/api/rooms/{_q(room)}/messages/{int(message_id)}/reactions", {"emoji": emoji, "on": on})


def chat_emoji() -> dict:
    """{quick, groups: [{name, emoji: [[emoji, name]]}], aliases}: every emoji a reaction can be, for the full picker."""
    return _get("/chat/api/emoji")


def chat_members(room: str) -> list:
    """[{username, name, joined_at, owner}] for a room."""
    return _get_list(f"/chat/api/rooms/{_q(room)}/members")


def chat_create(name: str, topic: str = "", private: bool = False) -> dict:
    body = {"name": name, "topic": topic}
    if private:
        body["private"] = True
    return api("POST", "/chat/api/rooms", body)


def chat_dm(username: str) -> dict:
    """Your direct message room with someone, made if it's new."""
    return api("POST", "/chat/api/dms", {"username": username})


def chat_people() -> list:
    """[{username, name, online}]: everyone else who can use chat."""
    return _get_list("/chat/api/people")


def chat_add(room: str, username: str) -> list:
    """Adds someone to a private room; returns its members."""
    return api("POST", f"/chat/api/rooms/{_q(room)}/members", {"username": username})


def chat_remove(room: str, username: str) -> list:
    return api("DELETE", f"/chat/api/rooms/{_q(room)}/members/{_q(username)}")


def chat_search(room: str, text: str, months: int | None = None) -> dict:
    """{more, messages, since, platform?, platform_error?}: messages in a room containing text, newest
    first, from the last `months` months (any time without it). In a room from Matrix, Matrix's own
    search finds history not brought in yet: those have id None and on_platform set."""
    back = f"&months={int(months)}" if months is not None else ""
    return _get(f"/chat/api/rooms/{_q(room)}/search?q={_q(text)}{back}")


def chat_typing(room: str) -> dict:
    return api("POST", f"/chat/api/rooms/{_q(room)}/typing")


def chat_update(room: str, **fields: str) -> dict:
    return api("PATCH", f"/chat/api/rooms/{_q(room)}", fields)


def chat_join(room: str) -> dict:
    return api("POST", f"/chat/api/rooms/{_q(room)}/join")


def chat_leave(room: str) -> dict:
    return api("POST", f"/chat/api/rooms/{_q(room)}/leave")


def chat_gifs(q: str = "", pos: str | None = None) -> dict:
    """{results: [{id, title, url, preview, width, height}], next}: a GIF search, or what's trending without q."""
    return _get(f"/chat/api/gifs?q={_q(q)}" + (f"&pos={_q(pos)}" if pos else ""))


def chat_gif_categories() -> dict:
    """{categories: [{name, query, preview}]}: the GIF picker's categories."""
    return _get("/chat/api/gifs/categories")


def chat_gif_favorites() -> dict:
    """{favorites: [{url, preview, width, height, title}]}: your starred GIFs, newest first."""
    return _get("/chat/api/gifs/favorites")


def chat_gif_favorite(gif: dict, on: bool = True) -> dict:
    """Stars a GIF (or with on=False takes the star off); the same as chat_gif_favorites() after."""
    keep = {k: gif.get(k) for k in ("url", "preview", "width", "height", "title") if gif.get(k) is not None}
    return api("POST", "/chat/api/gifs/favorites", {"gif": keep, "on": bool(on)})


# ──────────────────────────────── admin ─────────────────────────────────────
# /admin/api/access (src/account.js); admins only.

def admin_access() -> dict:
    """{apps: [{id, name}], users: [{id, username, display_name, disabled, you, apps}]}."""
    return _get("/admin/api/access")


def set_access(user_id: str, app: str, on: bool) -> dict:
    """Turns one app on or off for an account; the same as admin_access() after."""
    return api("POST", "/admin/api/access", {"user_id": user_id, "app": app, "on": bool(on)})


# Connections to other chat platforms (src/bridges.js): their rooms show up
# in chat_state as rooms of kind "bridge".

def chat_connections() -> list:
    """[{id, provider, network, label, status, error, rooms, synced_at}]: your connections."""
    return _get_list("/chat/api/connections")


def chat_connect(provider: str, fields: dict) -> dict:
    """Connects an account on another platform ({homeserver, token} for Matrix, say); returns the connection."""
    return api("POST", "/chat/api/connections", {"provider": provider, **fields})


def chat_disconnect(connection: str) -> dict:
    return api("DELETE", f"/chat/api/connections/{_q(connection)}")


def chat_bridge_dm(connection: str, user: str, encrypted: bool | None = None) -> dict:
    """{id}: a direct message with someone on a connection's platform (their id there, @sam:matrix.org)."""
    return api("POST", f"/chat/api/connections/{_q(connection)}/dm", {"user": user, **({"encrypted": encrypted} if encrypted is not None else {})})


def chat_sync(connection: str) -> dict:
    """Syncs a connection now (and tries again if it had stopped working); returns it."""
    return api("POST", f"/chat/api/connections/{_q(connection)}/sync")


# ──────────────────────────── notifications ─────────────────────────────────
# /notifications/api/ (src/notify.js). A terminal can't receive push
# notifications, but it can change what's sent and where it goes.

def notify_state() -> dict:
    """{configured, public_key, prefs, devices, apps, leads}."""
    return _get("/notifications/api/state")


def save_notify_prefs(**fields: Any) -> dict:
    """Any of chat_dms, chat_mentions, chat_rooms, chat_bridges, drift_events, drift_lead, tz; returns notify_state()."""
    return api("PATCH", "/notifications/api/prefs", fields)


def remove_device(device_id: str) -> dict:
    return api("DELETE", f"/notifications/api/devices/{_q(device_id)}")


def send_test() -> dict:
    """Pushes a test notification to all your browsers; notify_state() plus {sent, failed}."""
    return api("POST", "/notifications/api/test")
