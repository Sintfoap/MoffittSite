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


def prefs_path() -> Path:
    return config_path().with_name("prefs.json")


def load_prefs() -> dict:
    """The terminal's own settings, such as a folded side panel. {} if there are none yet."""
    try:
        data = json.loads(prefs_path().read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_pref(key: str, value: Any) -> None:
    p = prefs_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({**load_prefs(), key: value}, indent=2))
    except OSError:
        pass   # only a convenience: the setting still holds until the terminal closes


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
         timeout: float = 15, cookies: dict | None = None) -> tuple[int, Any]:
    """One request. Returns (status, parsed JSON or None). Raises SiteError if unreachable."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(site + path, data=data, method=method)
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    jar = {**({COOKIE: token} if token else {}), **(cookies or {})}
    if jar:
        req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in jar.items()))
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


def api(method: str, path: str, body: Any = None, timeout: float = 15) -> Any:
    """A signed-in request to the site's JSON API. Raises SignedOut or SiteError."""
    info = load_login()
    if not info:
        raise SignedOut()
    status, data = call(info["site"], method, path, body, token=info["token"], timeout=timeout)
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


def app_release() -> dict:
    """{version, name, url, published_at, page, qr}: the newest Android app. No sign-in needed. See src/phone.js."""
    base = site_url()
    status, data = call(base, "GET", "/app/latest.json")
    if status != 200 or not isinstance(data, dict):
        raise _error(status, data)
    return data


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


def translate_item(item_id: str) -> dict:
    """{language, english, fields: {title, notes}}: the item in English, to show beside it; nothing is saved (src/translate.js)."""
    return api("POST", f"/todo/api/items/{_q(item_id)}/translate", timeout=60)


def delete_item(item_id: str) -> dict:
    return api("DELETE", f"/todo/api/items/{_q(item_id)}")


def add_collection(fields: dict) -> dict:
    return api("POST", "/todo/api/collections", fields)


def update_collection(col_id: str, changes: dict) -> dict:
    return api("PATCH", f"/todo/api/collections/{_q(col_id)}", changes)


def set_bases(col_id: str, bases: list[dict]) -> dict:
    """A collection's bases; anyone who can edit it can (public/todo/route.js)."""
    return api("PATCH", f"/todo/api/collections/{_q(col_id)}", {"bases": bases})


def drift_route(col_id: str, day: str, profile: str = "driving-car", option: int = 0) -> dict:
    """The day's route from its base and back (src/routing.js)."""
    q = urllib.parse.urlencode({"collection": col_id, "day": day, "profile": profile, "option": option})
    return _get(f"/todo/api/route?{q}")


def drift_weather(spot: dict | None = None) -> dict:
    """The next 16 days' forecast at spot ({lat, lng}), or near you (src/weather.js)."""
    q = "?" + urllib.parse.urlencode({"lat": f"{spot['lat']:.2f}", "lng": f"{spot['lng']:.2f}"}) if spot else ""
    return _get(f"/todo/api/weather{q}")


def delete_collection(col_id: str, move_to: str = "") -> dict:
    """Deletes a collection; with move_to, its items move into that collection first ({moved})."""
    q = "?" + urllib.parse.urlencode({"move_to": move_to}) if move_to else ""
    return api("DELETE", f"/todo/api/collections/{_q(col_id)}{q}")


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
    """{apps: [{id, name, group, parent?}], users: [{id, username, display_name, disabled, you, apps}]}."""
    return _get("/admin/api/access")


def admin_stats() -> dict:
    """/admin/stats as data (admins): {accounts: {total, max, left, signups, active_7d, ...}, storage: {d1, r2},
    columns: [{name, ids}], kinds: [{id, app, label, photos?}], totals, users: [{username, last_active, counts, photos, total_bytes, ...}]}."""
    return _get("/admin/api/stats")


def set_access_all(user_id: str, apps: list[str]) -> dict:
    """Sets exactly which apps an account has (your own admin access stays on); the same as admin_access() after."""
    return api("POST", "/admin/api/access", {"user_id": user_id, "apps": list(apps)})


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


# ───────────────────────────── recipe box ───────────────────────────────────
# /recipes/api/ (src/recipes.js)

def recipes() -> dict:
    """{recipes, label_list, lists, drift, board}: your recipes (labels as {id, key, value}), the site's labels to pick from, the Drift lists you can send ingredients to, and whether you have Drift."""
    return _get("/recipes/api/recipes")


def save_recipe_from(url: str) -> dict:
    """Reads the recipe on a web page and saves it."""
    return api("POST", "/recipes/api/recipes", {"url": url})


def add_recipe(fields: dict) -> dict:
    """{title, servings, yield, time, ingredients, steps, notes, source}; ingredients and steps are lists or text, a line each."""
    return api("POST", "/recipes/api/recipes", fields)


def import_recipes(pages: list[str]) -> dict:
    """Saves the recipes in these pieces of an export file (at most 10): {added, skipped: [{title, why}]}."""
    return api("POST", "/recipes/api/recipes/import", {"pages": pages})


RECIPE_PHOTO_BYTES = 600 * 1024    # the biggest recipe picture the site keeps (src/recipes.js)


def remove_recipe_photo(recipe_id: str) -> dict:
    """Takes the recipe's picture off (one kept on the site, or a link); the recipe back."""
    return api("DELETE", f"/recipes/api/recipes/{_q(recipe_id)}/photo")


def set_recipe_photo(recipe_id: str, raw: bytes) -> dict:
    """Keeps this picture (JPEG, PNG, WebP or GIF bytes) as the recipe's own; the recipe back."""
    import base64
    return api("POST", f"/recipes/api/recipes/{_q(recipe_id)}/photo", {"data": base64.b64encode(raw).decode()})


def suggest_recipe_labels() -> dict:
    """{suggestions: [{id, title, labels: [{id, key, value, word, where}]}], checked, labels}: labels from the
    Recipe labels list that each recipe's words point to (its name, or keywords set on it), that it hasn't got yet."""
    return _get("/recipes/api/recipes/suggest-labels")


ADD_LABELS_BATCH = 200     # recipes per add-labels request (ADD_BATCH in src/recipes.js)


def add_labels_to_recipes(add: list[dict]) -> dict:
    """[{id, labels: [label ids]}] (at most 200) added to what each recipe has: {recipes, labels, full}."""
    return api("POST", "/recipes/api/recipes/add-labels", {"add": add})


def update_recipe(recipe_id: str, changes: dict) -> dict:
    return api("PATCH", f"/recipes/api/recipes/{_q(recipe_id)}", changes)


def translate_recipe(recipe_id: str) -> dict:
    """{language, english, fields}: the recipe's title, yield, time, ingredients, steps and notes in English, line for line; nothing is saved."""
    return api("POST", f"/recipes/api/recipes/{_q(recipe_id)}/translate", timeout=60)


def delete_recipe(recipe_id: str) -> dict:
    return api("DELETE", f"/recipes/api/recipes/{_q(recipe_id)}")


def shop(recipe_id: str, lines: list[int], servings: float | None = None, factor: float | None = None,
         list_id: str | None = None) -> dict:
    """Sends those ingredients (by index), scaled, to a Drift list (your Shopping list without list_id); {list, added}."""
    body: dict[str, Any] = {"lines": lines}
    if servings is not None:
        body["servings"] = servings
    if factor is not None:
        body["factor"] = factor
    if list_id:
        body["list"] = list_id
    return api("POST", f"/recipes/api/recipes/{_q(recipe_id)}/shop", body)


PHOTO_SIDE = 1568            # Anthropic shrinks anything longer across than this anyway
READ_PHOTO_BYTES = 3_750_000     # the biggest picture the site sends on to be read (src/recipe_photo.js)
RECIPE_PHOTOS = 4


def _picture_kind(raw: bytes) -> str | None:
    if raw[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if raw[:3] == b"GIF":
        return "gif"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    return None


def recipe_picture(path: str) -> bytes:
    """A picture file, ready to send: made smaller first when Pillow is installed (and it's big),
    otherwise as it is. Raises SiteError for what the site can't take."""
    p = Path(path.strip().strip("'\"")).expanduser()
    try:
        raw = p.read_bytes()
    except OSError as e:
        raise SiteError(f"couldn't read {p}: {e.strerror or e}") from None
    try:
        from PIL import Image, ImageOps  # optional: pip install pillow
    except ImportError:
        Image = None
    if Image is not None:
        import io
        try:
            with Image.open(io.BytesIO(raw)) as im:
                if max(im.size) > PHOTO_SIDE or len(raw) > READ_PHOTO_BYTES or _picture_kind(raw) is None:
                    im = ImageOps.exif_transpose(im)
                    im.thumbnail((PHOTO_SIDE, PHOTO_SIDE))
                    if im.mode != "RGB":
                        bg = Image.new("RGB", im.size, "white")
                        bg.paste(im, mask=im.convert("RGBA").getchannel("A"))
                        im = bg
                    out = io.BytesIO()
                    im.save(out, "JPEG", quality=88)
                    raw = out.getvalue()
        except Exception:  # noqa: BLE001  not a picture Pillow knows; checked below
            pass
    if _picture_kind(raw) is None:
        raise SiteError(f"{p.name} isn't a JPEG, PNG, WebP or GIF picture"
                        + ("" if Image else " (install Pillow to send others, like HEIC: pip install pillow)"))
    if len(raw) > READ_PHOTO_BYTES:
        raise SiteError(f"{p.name} is {len(raw) // 1_000_000} MB; the most the site sends on is "
                        f"{READ_PHOTO_BYTES / 1e6:.2g} MB, so make it smaller first (pip install pillow does it for you)")
    return raw


def read_recipe_photo(paths: list[str]) -> dict:
    """Pictures of one recipe (up to 4 files), read by Claude: {recipe}, a draft to check. Nothing is saved."""
    import base64
    if not paths:
        raise SiteError("say which picture")
    if len(paths) > RECIPE_PHOTOS:
        raise SiteError(f"pick at most {RECIPE_PHOTOS} pictures of one recipe")
    images = [{"data": base64.b64encode(recipe_picture(p)).decode()} for p in paths]
    return api("POST", "/recipes/api/photo", {"images": images}, timeout=180)


def dish_picture(path: str, box: dict | None = None, text: list[dict] | None = None) -> tuple[bytes | None, bool]:
    """The recipe's picture from a photo of it: (JPEG bytes, whether it's the dish's own photo cut out).
    `box` is where the dish is (fractions across and down), or it's looked for, keeping `text` (the
    lines tesseract read, in the photo's pixels) out. No dish found: the whole photo. Cutting and
    shrinking need Pillow; without it the whole photo goes as it is, when it's small enough to keep."""
    p = Path(path.strip().strip("'\"")).expanduser()
    try:
        raw = p.read_bytes()
    except OSError:
        return None, False
    try:
        from PIL import Image, ImageOps  # optional: pip install pillow
    except ImportError:
        return (raw, False) if _picture_kind(raw) and len(raw) <= RECIPE_PHOTO_BYTES else (None, False)
    import io
    from . import recipe_rules
    try:
        with Image.open(io.BytesIO(raw)) as im:
            turn = {2: Image.Transpose.FLIP_LEFT_RIGHT, 3: Image.Transpose.ROTATE_180, 4: Image.Transpose.FLIP_TOP_BOTTOM,
                    5: Image.Transpose.TRANSPOSE, 6: Image.Transpose.ROTATE_270, 7: Image.Transpose.TRANSVERSE,
                    8: Image.Transpose.ROTATE_90}.get(im.getexif().get(0x0112))
            im = im.convert("RGB")
            # Claude's box and tesseract's lines (read with Pillow, as here) are on the photo the right way up.
            if turn and (box is not None or text is not None):
                im, turn = im.transpose(turn), None
            if box is None and text is not None:
                k = min(1.0, 200 / im.width)
                small = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))))
                scaled = [{key: b[key] * k for key in ("x0", "y0", "x1", "y1")} for b in text]
                box = recipe_rules.find_picture(small.width, small.height, small.tobytes(), scaled)
            if box:
                im = im.crop((round(box["x0"] * im.width), round(box["y0"] * im.height),
                              round(box["x1"] * im.width), round(box["y1"] * im.height)))
            if turn:
                im = im.transpose(turn)
            im.thumbnail((1200, 1200))
            for q in (85, 75, 60, 45):
                out = io.BytesIO()
                im.save(out, "JPEG", quality=q)
                if out.tell() <= RECIPE_PHOTO_BYTES - 40 * 1024:
                    return out.getvalue(), bool(box)
    except Exception:  # noqa: BLE001  not a picture Pillow knows
        pass
    return None, False


TESSERACT_HINT = ("Reading photos without a key needs Tesseract, free text recognition: "
                  "brew install tesseract (macOS), sudo apt install tesseract-ocr (Debian, Ubuntu) "
                  "or winget install UB-Mannheim.TesseractOCR (Windows)")


def tesseract_lines(tsv: str) -> list[dict]:
    """Tesseract's TSV output as lines with their words and where they sit (what /recipes/api/text takes)."""
    lines: dict[tuple, dict] = {}
    rows = tsv.splitlines()
    for row in rows[1:]:
        cols = row.split("\t")
        if len(cols) < 12 or cols[0] != "5":
            continue
        word = cols[11].strip()
        if not word:
            continue
        try:
            x, y, w, h, conf = int(cols[6]), int(cols[7]), int(cols[8]), int(cols[9]), float(cols[10])
        except ValueError:
            continue
        key = tuple(cols[1:5])
        box = {"x0": x, "y0": y, "x1": x + w, "y1": y + h}
        line = lines.setdefault(key, {"words": [], "confs": []})
        line["words"].append({"text": word, "bbox": box, "confidence": conf})
        line["confs"].append(conf)
    out = []
    for line in lines.values():
        ws = line["words"]
        out.append({"text": " ".join(w["text"] for w in ws), "confidence": sum(line["confs"]) / len(ws),
                    "bbox": {"x0": min(w["bbox"]["x0"] for w in ws), "y0": min(w["bbox"]["y0"] for w in ws),
                             "x1": max(w["bbox"]["x1"] for w in ws), "y1": max(w["bbox"]["y1"] for w in ws)},
                    "words": ws})
    return out


def ocr_page(path: str) -> list[dict]:
    """Reads one picture with the tesseract command, on this computer: its lines, in the pixels of the
    photo the right way up. With Pillow, it's read in clean black and white and its fractions are put
    right (sintfoap/ocr.py); without, as it's stored. Raises SiteError."""
    import shutil
    import subprocess
    import tempfile
    exe = shutil.which("tesseract")
    if not exe:
        raise SiteError(TESSERACT_HINT)
    p = Path(path.strip().strip("'\"")).expanduser()
    if not p.is_file():
        raise SiteError(f"couldn't find {p}")
    bw, k, tmp = None, 1.0, None
    try:
        from PIL import Image  # optional: pip install pillow
        from . import ocr
        with Image.open(p) as im:
            _, bw, k = ocr.ink(im)
        tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        tmp.close()
        bw.save(tmp.name)
    except Exception:  # noqa: BLE001  no Pillow, or not a picture it knows: tesseract reads the file itself
        bw, k = None, 1.0
    try:
        res = subprocess.run([exe, tmp.name if bw is not None else str(p), "stdout", "--psm", "3", "-l", "eng", "tsv"],
                             capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise SiteError(f"tesseract couldn't read {p.name}: {e}") from None
    finally:
        if tmp is not None:
            Path(tmp.name).unlink(missing_ok=True)
    if res.returncode != 0:
        raise SiteError(f"tesseract couldn't read {p.name}: {(res.stderr or '').strip().splitlines()[-1:] or ['it failed']}"[:300])
    lines = tesseract_lines(res.stdout)
    if bw is not None:
        from . import ocr
        ocr.fix_fractions(bw, lines)
        if k != 1:
            for line in lines:
                for b in [line["bbox"]] + [w["bbox"] for w in line["words"]]:
                    for key in b:
                        b[key] = round(b[key] / k)
    return lines


def read_recipe_text(text: str | None = None, pages: list[list[dict]] | None = None) -> dict:
    """Recipe text (pasted, or pages of recognized lines) cut into a recipe by the site, no AI: {recipe}, a draft to check."""
    return api("POST", "/recipes/api/text", {"pages": pages} if pages is not None else {"text": text or ""}, timeout=30)


def read_photo_here(paths: list[str]) -> dict:
    """Pictures of one recipe read by tesseract on this computer, then cut into a recipe by the site: {recipe}."""
    if not paths:
        raise SiteError("say which picture")
    if len(paths) > RECIPE_PHOTOS:
        raise SiteError(f"pick at most {RECIPE_PHOTOS} pictures of one recipe")
    pages = [ocr_page(p) for p in paths]
    if not any(pages):
        raise SiteError("couldn't find any text in that picture")
    # The first page's lines too, to keep out when looking for the dish's photo there.
    return {**read_recipe_text(pages=pages), "text": [line["bbox"] for line in pages[0]]}


def recipe_key(key: str) -> dict:
    """Saves your Anthropic API key for reading photos (the same one Sweep uses): {photo}."""
    return api("PUT", "/recipes/api/key", {"key": key}, timeout=30)


# ───────────────────────────────── pantry ───────────────────────────────────
# /pantry/api/ (src/pantry.js): your food, as staples (measured), counted things and gauged ones (Full to Empty).

def pantry(day: str = "") -> dict:
    """{items: [{id, name, kind, place, text, low_text, level, lots, expires, soon, expired, is_low, is_out, ...}], places, counts, levels}.
    day is your own date (YYYY-MM-DD), for what's expiring soon."""
    return _get("/pantry/api/items" + (f"?day={_q(day)}" if day else ""))


def add_pantry_item(item: dict) -> dict:
    """{name, kind?, place?, amount?, expires?, low?, unit?, size?, level?, words?}: kind, place and unit are guessed from the name when left out."""
    return api("POST", "/pantry/api/items", item)


def edit_pantry_item(item_id: str, change: dict) -> dict:
    """{name?, place?, words?, low?, per_cup?, unit?, size?, level?, expires?, kind? (with amount)}."""
    return api("PATCH", f"/pantry/api/items/{_q(item_id)}", change)


def delete_pantry_item(item_id: str) -> dict:
    return api("DELETE", f"/pantry/api/items/{_q(item_id)}")


def use_pantry_item(item_id: str, how: dict) -> dict:
    """{amount} ("1 cup", or how many), {all: True}, {all: True, tossed: True}, or {level} for a gauged item."""
    return api("POST", f"/pantry/api/items/{_q(item_id)}/use", how)


def add_pantry_lot(item_id: str, amount: str, expires: str = "") -> dict:
    """Another purchase: "5 lb" or how many, and its expiry date (YYYY-MM-DD) if it has one."""
    return api("POST", f"/pantry/api/items/{_q(item_id)}/lots", {"amount": amount, "expires": expires})


def edit_pantry_lot(item_id: str, lot_id: str, change: dict) -> dict:
    return api("PATCH", f"/pantry/api/items/{_q(item_id)}/lots/{_q(lot_id)}", change)


def delete_pantry_lot(item_id: str, lot_id: str) -> dict:
    return api("DELETE", f"/pantry/api/items/{_q(item_id)}/lots/{_q(lot_id)}")


RECEIPT_PHOTOS = 4


def read_receipt(paths: list[str], day: str = "") -> dict:
    """Pictures of one grocery receipt (up to 4, top to bottom), read by Claude with your key or the
    site's AI: {store, date, by, lines: [{printed, name, count, skip, match, new, amount, expires, expires_by}]},
    each matched to something in your pantry or offered as new, to check. Nothing is saved."""
    import base64
    if not paths:
        raise SiteError("say which picture")
    if len(paths) > RECEIPT_PHOTOS:
        raise SiteError(f"pick at most {RECEIPT_PHOTOS} pictures of one receipt")
    images = [{"data": base64.b64encode(recipe_picture(p)).decode()} for p in paths]
    return api("POST", "/pantry/api/receipt" + (f"?day={_q(day)}" if day else ""), {"images": images}, timeout=180)


def add_receipt(store: str, lines: list[dict]) -> dict:
    """The checked lines into the pantry: {added: [{printed, id, name, text}], failed: [{printed, name, error}], items}.
    Each line is {printed, item (an id), amount, expires, expires_by} or a new one {printed, name, kind, place, unit, size, low, amount, ...}."""
    return api("POST", "/pantry/api/receipt/add", {"store": store, "lines": lines}, timeout=60)


def pantry_scanners() -> dict:
    """Phones paired as Pantry scanners: {scanners: [{id, name, prefix, created, last_used}]}."""
    return _get("/pantry/api/scanners")


def pair_pantry_scanner() -> dict:
    """A code to pair a phone with: {code, link, qr_text (the link as a QR code, in text), expires_in}. Works once, for 10 minutes."""
    return api("POST", "/pantry/api/scanners", {})


def unpair_pantry_scanner(scanner_id: str) -> dict:
    """Stops that phone's key working: {scanners} left."""
    return api("DELETE", f"/pantry/api/scanners/{_q(scanner_id)}")


def pantry_key(key: str) -> dict:
    """Saves your Anthropic API key for reading receipts (the same one Recipe box and Sweep use): {photo}."""
    return api("PUT", "/pantry/api/key", {"key": key}, timeout=30)


# ────────────────────────────── meal plan ───────────────────────────────────
# /meals/api/ (src/meals.js)

def meal_week(start: str) -> dict:
    """The week holding `start` (YYYY-MM-DD): {start, prev, next, days, recipes, shopping, shopped, lists, drift, recipe_box}."""
    return _get(f"/meals/api/week?start={_q(start)}")


def set_meal(monday: str, day: str, change: dict) -> dict:
    """{recipe?, servings?, out?, locked?} for one night; the week back."""
    return api("PUT", f"/meals/api/week/{_q(monday)}/{_q(day)}", change)


def fill_meals(monday: str, redo: bool = False) -> dict:
    """Recipes for the week's empty nights (redo: every night that isn't locked); the week back."""
    return api("POST", f"/meals/api/week/{_q(monday)}/fill", {"redo": True} if redo else {})


def shop_meals(monday: str, lines: list[int], list_id: str | None = None) -> dict:
    """Sends those lines of the week's shopping (by index) to a Drift list (your Shopping list without list_id); {list, added, shopped}."""
    body: dict[str, Any] = {"lines": lines}
    if list_id:
        body["list"] = list_id
    return api("POST", f"/meals/api/week/{_q(monday)}/shop", body)


# ──────────────────────────────── sweep ─────────────────────────────────────
# /sweep/api/ (src/sweep.js)

def _tz() -> str:
    """This computer's time zone name (America/New_York), if it can tell; the site guesses otherwise."""
    import os
    tz = os.environ.get("TZ", "")
    if "/" in tz:
        return tz.lstrip(":")
    try:
        target = os.path.realpath("/etc/localtime")
        return target.split("zoneinfo/", 1)[1] if "zoneinfo/" in target else ""
    except OSError:
        return ""


def sweep_state() -> dict:
    """{ready, key, sealing, drift, days, rooms, suggestions, history, collections}."""
    return _get("/sweep/api/state")


def sweep_key(key: str) -> dict:
    """Saves your Anthropic API key for Sweep (checked with Anthropic first). Returns sweep_state()."""
    return api("PUT", "/sweep/api/key", {"key": key})


def sweep_drop_key() -> dict:
    """Removes your Anthropic API key from Sweep. Returns sweep_state()."""
    return api("DELETE", "/sweep/api/key")


def sweep_room(room: str, on: bool, days: int | None = None) -> dict:
    """Lets Sweep read a chat room (or stops it); days is how far back its first sweep looks. Returns sweep_state()."""
    return api("PUT", f"/sweep/api/rooms/{_q(room)}", {"on": bool(on), **({"days": days} if days else {})})


def sweep_now() -> dict:
    """Sweeps the rooms you picked: {swept: [{room, messages, added}], added, more, state}."""
    return api("POST", "/sweep/api/sweep", {"tz": _tz()} if _tz() else {})


def sweep_accept(suggestion: str, changes: dict | None = None) -> dict:
    """Adds a suggestion to Drift, with any of {title, kind, start, end, collection} changed first; {item, state}."""
    return api("POST", f"/sweep/api/suggestions/{_q(suggestion)}/accept", changes or {})


def sweep_reject(suggestion: str, body: dict | None = None) -> dict:
    """Turns a suggestion down ({reason} optional); returns sweep_state()."""
    return api("POST", f"/sweep/api/suggestions/{_q(suggestion)}/reject", body or {})


# ───────────────────────────── trip planner ─────────────────────────────────
# /trips/api/ (src/trips.js)

def trips() -> dict:
    """{trips, drift, search, lists}: your trips, whether you have Drift and place search, and the Drift lists you can add to."""
    return _get("/trips/api/trips")


def trip(trip_id: str) -> dict:
    """The whole trip: {title, start, end, notes, days, members, plans, places, packing, owned, you}."""
    return _get(f"/trips/api/trips/{_q(trip_id)}")


def add_trip(fields: dict) -> dict:
    """{title, start, end, notes}; dates are YYYY-MM-DD or ""."""
    return api("POST", "/trips/api/trips", fields)


def update_trip(trip_id: str, changes: dict) -> dict:
    return api("PATCH", f"/trips/api/trips/{_q(trip_id)}", changes)


def delete_trip(trip_id: str) -> dict:
    """Deletes your trip, or takes you off someone else's: {removed} or {left}."""
    return api("DELETE", f"/trips/api/trips/{_q(trip_id)}")


def add_traveller(trip_id: str, username: str) -> dict:
    return api("POST", f"/trips/api/trips/{_q(trip_id)}/members", {"username": username})


def remove_traveller(trip_id: str, user_id: str) -> dict:
    return api("DELETE", f"/trips/api/trips/{_q(trip_id)}/members/{_q(user_id)}")


def add_to_trip(trip_id: str, kind: str, fields: dict) -> dict:
    """kind is plans ({day, time, title, place, notes}), places ({place, lat, lng, note, drift}) or packing ({text, who}); the trip."""
    return api("POST", f"/trips/api/trips/{_q(trip_id)}/{kind}", fields)


def change_in_trip(trip_id: str, kind: str, entry_id: str, changes: dict) -> dict:
    return api("PATCH", f"/trips/api/trips/{_q(trip_id)}/{kind}/{_q(entry_id)}", changes)


def remove_from_trip(trip_id: str, kind: str, entry_id: str) -> dict:
    return api("DELETE", f"/trips/api/trips/{_q(trip_id)}/{kind}/{_q(entry_id)}")


def pack(trip_id: str, ids: list[str] | None = None, list_id: str | None = None) -> dict:
    """The packing list onto a Drift checklist ("Packing: <trip>" without list_id); {list, added, trip}."""
    body: dict[str, Any] = {}
    if ids is not None:
        body["ids"] = ids
    if list_id:
        body["list"] = list_id
    return api("POST", f"/trips/api/trips/{_q(trip_id)}/pack", body)


def search_places(q: str) -> list | None:
    """[{place, lat, lng}] matching q, or None when the site has no place search."""
    return _get("/trips/api/places?q=" + _q(q))["results"]


def drift_places() -> list:
    """Your Drift items that are on the map: [{id, title, place, lat, lng, collection}]."""
    return _get("/trips/api/drift-places")["items"]


# ───────────────────────────── recipe board ─────────────────────────────────
# /board/api/ (src/board.js)

def board() -> dict:
    """{categories, label_list, recipe_box, recipes, unread, featured, can_label}: every category (a label key, with its values and
    whether you follow it), the labels to tick, your Recipe box's
    recipes to share, and today's (by this computer's date) recipe of the day: the same board post for everyone that day, or None."""
    import datetime
    return _get("/board/api/board?day=" + datetime.date.today().isoformat())


def board_posts(view: str = "feed", category: str = "", before: str = "", label: str = "") -> dict:
    """{posts, more, unread}: a page of posts, newest first. view is feed, all, mine or saved; a category (a label key)
    overrides it, and a label (one value's id) narrows that.
    Reading the top of your feed marks it read."""
    q = {"label": label} if label else {"category": category} if category else {"view": view}
    if before:
        q["before"] = before
    return _get("/board/api/posts?" + urllib.parse.urlencode(q))


def delete_board_category(key: str) -> dict:
    """Removes the key, and its values, from Recipe labels (for whoever keeps that list)."""
    return api("DELETE", f"/board/api/categories/{_q(key)}")


def follow_board_category(category_id: str, follow: bool) -> dict:
    """The category back, with `following`."""
    return api("PUT", f"/board/api/categories/{_q(category_id)}/follow", {"follow": follow})


def follow_board_label(label_id: str, follow: bool) -> dict:
    """Follow one value of a category (like Season: Fall); the value back, with `following`."""
    return api("PUT", f"/board/api/labels/{_q(label_id)}/follow", {"follow": follow})


def add_board_post(fields: dict) -> dict:
    """{note?, labels?} and the recipe: {recipe_id} from your Recipe box, {url} to read one from a page, or {title, recipe: {...}}.
    labels (ids from the label list) file it under their keys; from your Recipe box, the recipe's own labels come along unless sent."""
    return api("POST", "/board/api/posts", fields)


def update_board_post(post_id: str, changes: dict) -> dict:
    return api("PATCH", f"/board/api/posts/{_q(post_id)}", changes)


def translate_board_post(post_id: str) -> dict:
    """{language, english, fields}: the post (title, note and its recipe's words) in English; anyone on the board can, and nothing is saved."""
    return api("POST", f"/board/api/posts/{_q(post_id)}/translate", timeout=60)


def delete_board_post(post_id: str) -> dict:
    return api("DELETE", f"/board/api/posts/{_q(post_id)}")


def save_board_post(post_id: str) -> dict:
    """The post's recipe, copied into your Recipe box: {recipe, already}."""
    return api("POST", f"/board/api/posts/{_q(post_id)}/save")


def board_reviews(post_id: str) -> dict:
    """{reviews, yours, summary, can_review}: what people who made the post thought (newest first), yours or None,
    {count, rated, stars} and whether you can review it (anyone but whoever shared it)."""
    return _get(f"/board/api/posts/{_q(post_id)}/reviews")


def review_board_post(post_id: str, fields: dict) -> dict:
    """Your review, new or changed: {rating (1 to 5, or None), note (how it turned out), changes (what you did differently)};
    only the fields sent change. The post's reviews back, as board_reviews gives them."""
    return api("PUT", f"/board/api/posts/{_q(post_id)}/reviews", fields)


def delete_board_review(post_id: str, review_id: str = "") -> dict:
    """Takes your review down (or, for an admin, the one with that id). The post's reviews back."""
    return api("DELETE", f"/board/api/posts/{_q(post_id)}/reviews" + (f"/{_q(review_id)}" if review_id else ""))
# ───────────────────────────── recipe labels ────────────────────────────────
# /labels/api/ (src/labels.js): the one list of labels recipes pick from, kept by whoever has Recipe labels.

def recipe_labels() -> dict:
    """{labels: [{id, key, value, keywords, recipes, posts}], keys: [{key, values, recipes, posts}]}, by key then value."""
    return _get("/labels/api/labels")


def add_recipe_labels(key: str, values: str | list[str] = "") -> dict:
    """Values under a key, new or already there: "Fall, Winter" or a list. {added, skipped: [{key, value, why}]}."""
    return api("POST", "/labels/api/labels", {"key": key, "values": values})


def rename_recipe_label(label_id: str, value: str) -> dict:
    """A new value for it, on every recipe that has it."""
    return api("PATCH", f"/labels/api/labels/{_q(label_id)}", {"value": value})


def set_label_keywords(label_id: str, keywords: str) -> dict:
    """"pumpkin, squash": the words that make Recipe box's Suggest labels offer this label ("-fall apart" ignores a phrase)."""
    return api("PATCH", f"/labels/api/labels/{_q(label_id)}", {"keywords": keywords})


def delete_recipe_label(label_id: str) -> dict:
    """Takes it off the list and every recipe."""
    return api("DELETE", f"/labels/api/labels/{_q(label_id)}")


def rename_label_key(key: str, new: str) -> dict:
    """Every value under a key moves to the new one."""
    return api("PATCH", f"/labels/api/keys/{_q(key)}", {"key": new})


def delete_label_key(key: str) -> dict:
    """A key and all its values, off every recipe (and off the Recipe board as a category)."""
    return api("DELETE", f"/labels/api/keys/{_q(key)}")


# ────────────────────────────── food club ───────────────────────────────────
# /food/api/ (src/food.js)

PHOTO_BYTES = 1200 * 1024     # the biggest photo the site keeps (src/food.js)


def food_club() -> dict:
    """{picks, you, kinds, recipe_box, recipes}: every month's pick (newest first), and your Recipe box's recipes to pick from."""
    return _get("/food/api/club")


def food_pick(pick_id: str) -> dict:
    """The whole pick: {month, title, kind, blurb, recipe, by, can_edit, made_by, favorite_of, mine, photos}."""
    return _get(f"/food/api/picks/{_q(pick_id)}")


def add_food_pick(fields: dict) -> dict:
    """{month (YYYY-MM), title, kind, blurb} and a recipe: {recipe: {...}}, {url} to read one from a page, or {recipe_id} from your Recipe box."""
    return api("POST", "/food/api/picks", fields)


def update_food_pick(pick_id: str, changes: dict) -> dict:
    return api("PATCH", f"/food/api/picks/{_q(pick_id)}", changes)


def delete_food_pick(pick_id: str) -> dict:
    return api("DELETE", f"/food/api/picks/{_q(pick_id)}")


def mark_food(pick_id: str, **marks: bool) -> dict:
    """made=… and/or favorite=… for you; the pick back."""
    return api("PUT", f"/food/api/picks/{_q(pick_id)}/mine", marks)


def add_food_photo(pick_id: str, path: str, caption: str = "") -> dict:
    """Sends a picture file of your attempt (JPEG, PNG, WebP or GIF, at most PHOTO_BYTES); the pick back."""
    import base64
    p = Path(path).expanduser()
    try:
        raw = p.read_bytes()
    except OSError as e:
        raise SiteError(f"couldn't read {p}: {e.strerror or e}") from None
    if len(raw) > PHOTO_BYTES:
        raise SiteError(f"that photo is {len(raw) // 1024} KB; the most the site keeps is {PHOTO_BYTES // 1024} KB, "
                        "so make it smaller first (or add it from the website, which shrinks it for you)")
    return api("POST", f"/food/api/picks/{_q(pick_id)}/photos", {"data": base64.b64encode(raw).decode(), "caption": caption})


def remove_food_photo(pick_id: str, photo_id: str) -> dict:
    return api("DELETE", f"/food/api/picks/{_q(pick_id)}/photos/{_q(photo_id)}")


def save_food_recipe(pick_id: str) -> dict:
    """The pick's recipe, copied into your Recipe box: {recipe}."""
    return api("POST", f"/food/api/picks/{_q(pick_id)}/save")


# ──────────────────────────────── feedback ──────────────────────────────────
# /feedback/api/ (src/feedback.js)

def feedback() -> dict:
    """{mine, inbox (admins; else None), owner, kinds, statuses, sources, photos_each, links_each}."""
    return _get("/feedback/api/feedback")


def feedback_linkable(app: str, q: str = "") -> list:
    """Up to 30 things in one app (a source id from feedback()["sources"]) whose name has q in it: [{app, id, title, sub}]."""
    return _get(f"/feedback/api/linkable?app={_q(app)}&q={_q(q)}")["items"]


def feedback_note(note_id: str) -> dict:
    """The whole note (opening it marks it read): {kind, subject, message, status, links, photos, replies, can_*}."""
    return _get(f"/feedback/api/items/{_q(note_id)}")


def send_feedback(fields: dict) -> dict:
    """{kind, subject, message, links: [{app, id} | {app: "url", url}]} → the new note."""
    return api("POST", "/feedback/api/items", fields)


def update_feedback(note_id: str, changes: dict) -> dict:
    """{kind?, subject?, message?, links?} for your own note, or {status} for admins."""
    return api("PATCH", f"/feedback/api/items/{_q(note_id)}", changes)


def delete_feedback(note_id: str) -> dict:
    return api("DELETE", f"/feedback/api/items/{_q(note_id)}")


def reply_feedback(note_id: str, text: str) -> dict:
    return api("POST", f"/feedback/api/items/{_q(note_id)}/replies", {"text": text})


def add_feedback_photo(note_id: str, path: str, caption: str = "") -> dict:
    """Sends a picture file (JPEG, PNG, WebP or GIF, at most PHOTO_BYTES) with your note; the note back."""
    import base64
    p = Path(path).expanduser()
    try:
        raw = p.read_bytes()
    except OSError as e:
        raise SiteError(f"couldn't read {p}: {e.strerror or e}") from None
    if len(raw) > PHOTO_BYTES:
        raise SiteError(f"that photo is {len(raw) // 1024} KB; the most the site keeps is {PHOTO_BYTES // 1024} KB, "
                        "so make it smaller first (or add it from the website, which shrinks it for you)")
    return api("POST", f"/feedback/api/items/{_q(note_id)}/photos", {"data": base64.b64encode(raw).decode(), "caption": caption})


def remove_feedback_photo(note_id: str, photo_id: str) -> dict:
    return api("DELETE", f"/feedback/api/items/{_q(note_id)}/photos/{_q(photo_id)}")
