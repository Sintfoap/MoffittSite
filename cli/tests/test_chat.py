"""sintfoap chat: the terminal chat against a stand-in for /chat/api (see src/chat.js)."""
import asyncio
import json
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from sintfoap import site


class FakeChatApi:
    """The chat_* functions in site.py, kept in memory, with the site's rules."""

    def __init__(self):
        self.seq = {}
        self.rooms = {}
        self.msgs = []
        self.joined = set()
        self.next_id = 1

    def add_room(self, rid, name, joined=True, owner=False):
        self.rooms[rid] = {"id": rid, "name": name, "topic": "", "members": 1, "joined": joined,
                           "unread": 0, "manage": owner}
        self.seq[rid] = 0
        if joined:
            self.joined.add(rid)

    def add_message(self, rid, body, author="sam", mine=False):
        self.seq[rid] += 1
        m = {"id": self.next_id, "seq": self.seq[rid], "created_at": int(time.time()), "deleted": False, "body": body,
             "author": author, "author_name": author.title(), "mine": mine, "can_delete": mine, "room": rid}
        self.next_id += 1
        self.msgs.append(m)
        return m

    def chat_state(self):
        rooms = [{**r, "joined": r["id"] in self.joined} for r in self.rooms.values()]
        return {"user": {"username": "ryan", "name": "Ryan M", "admin": False}, "rooms": rooms}

    def chat_messages(self, room, since=None, before=None):
        if room not in self.rooms:
            raise site.SiteError("the site said: not found")
        ms = [m for m in self.msgs if m["room"] == room]
        if since is not None:
            out, more = [m for m in ms if m["seq"] > since], False
        else:
            ms = [m for m in ms if not m["deleted"] and (before is None or m["id"] < before)]
            out, more = ms[-3:], len(ms) > 3        # pages of 3, to test history
        return {"seq": self.seq[room], "more": more, "joined": room in self.joined, "messages": out}

    def chat_post(self, room, text):
        if room not in self.joined:
            raise site.SiteError("the site said: join the room to post in it")
        return self.add_message(room, text, "ryan", mine=True)

    def chat_delete(self, room, mid):
        m = next(m for m in self.msgs if m["id"] == mid)
        self.seq[room] += 1
        m.update(deleted=True, body="", seq=self.seq[room])
        return {"deleted": True}

    def chat_create(self, name, topic=""):
        rid = f"r_{len(self.rooms):016x}"
        self.add_room(rid, name, owner=True)
        self.rooms[rid]["topic"] = topic
        return self.rooms[rid]

    def chat_update(self, room, **fields):
        self.rooms[room].update(fields)
        return {"id": room, **fields}

    def chat_join(self, room):
        self.joined.add(room)
        return {"joined": True}

    def chat_leave(self, room):
        self.joined.discard(room)
        return {"joined": False}


def run_chat(api, test, room=None):
    pytest.importorskip("textual")
    from sintfoap.chat import Chat

    async def go():
        app = Chat(api=api, room=room)
        async with app.run_test(size=(110, 34)) as pilot:
            await pilot.pause()
            await test(app, pilot)
        return app
    return asyncio.run(go())


def shown(app):
    return str(app.query_one("#messages").render())


async def type_line(pilot, text):
    for ch in text:
        await pilot.press("space" if ch == " " else ch)
    await pilot.press("enter")
    await pilot.pause()


def test_opens_your_first_room_and_sends_messages():
    api = FakeChatApi()
    api.add_room("r_a", "general")
    api.add_message("r_a", "hello ryan")

    async def t(app, pilot):
        assert app.open["id"] == "r_a"
        assert "hello ryan" in shown(app) and "Sam" in shown(app)
        assert app.focused.id == "input"
        await type_line(pilot, "hi sam")
        assert "hi sam" in shown(app)
        assert [m["body"] for m in api.msgs] == ["hello ryan", "hi sam"]
        # Someone else's new message turns up on the next poll.
        api.add_message("r_a", "how are you?")
        await app.poll()
        assert "how are you?" in shown(app)
    run_chat(api, t)


def test_join_new_rename_and_leave():
    api = FakeChatApi()
    api.add_room("r_a", "general", joined=False)

    async def t(app, pilot):
        assert app.open is None
        app.query_one("#rooms").focus()
        await pilot.press("enter")
        await pilot.pause()
        assert app.open["id"] == "r_a" and not app.open["joined"]
        await type_line(pilot, "nope")
        assert api.msgs == [] and "/join" in str(app.query_one("#status").render())
        await type_line(pilot, "/join")
        assert app.open["joined"]
        await type_line(pilot, "/new games | board games")
        assert app.open["id"] != "r_a" and app.room()["name"] == "games" and app.room()["topic"] == "board games"
        await type_line(pilot, "/rename tabletop")
        assert app.room()["name"] == "tabletop"
        await type_line(pilot, "/leave")
        assert not app.open["joined"]
    run_chat(api, t)


def test_delete_older_and_help():
    api = FakeChatApi()
    api.add_room("r_a", "general")
    for i in range(1, 6):
        api.add_message("r_a", f"m{i}")

    async def t(app, pilot):
        assert "m3" in shown(app) and "m1" not in shown(app) and "/older" in shown(app)
        await type_line(pilot, "/older")
        assert "m1" in shown(app) and "/older" not in shown(app)
        await type_line(pilot, "mine")
        await type_line(pilot, "/delete")
        assert api.msgs[-1]["deleted"] and "mine" not in shown(app)
        await type_line(pilot, "/help")
        assert "/join" in shown(app)
    run_chat(api, t)


def test_opens_a_room_by_name_and_notices_deletes_from_elsewhere():
    api = FakeChatApi()
    api.add_room("r_a", "general")
    api.add_room("r_b", "random")
    gone = api.add_message("r_b", "oops")

    async def t(app, pilot):
        assert app.open["id"] == "r_b"
        api.chat_delete("r_b", gone["id"])
        await app.poll()
        assert "oops" not in shown(app)
        del api.rooms["r_b"]
        await app.load_rooms()
        assert app.open is None
    run_chat(api, t, room="#Random")


# ── site.py's chat calls, over HTTP ─────────────────────────────────────────

class FakeSite(BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *a):
        pass

    def _send(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _handle(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"null")
        self.seen.append((self.command, self.path, body, self.headers.get("Cookie"), self.headers.get("Origin")))
        if self.headers.get("Cookie") != "__Host-sid=tok":
            return self._send(401, {"error": "not signed in"})
        if self.path.endswith("/messages") and self.command == "POST":
            return self._send(429, {"error": "you're sending messages too quickly; wait a few seconds"})
        self._send(201 if self.command == "POST" else 200, {"ok": True})

    do_GET = do_POST = do_PATCH = do_DELETE = _handle


@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", tempfile.mkdtemp())
    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeSite)
    origin = f"http://127.0.0.1:{srv.server_port}"
    FakeSite.seen = []
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield origin
    srv.shutdown()


def test_site_chat_calls(fake):
    with pytest.raises(site.SignedOut):
        site.chat_state()
    site.save_login({"site": fake, "token": "tok", "username": "ryan"})
    assert site.chat_state() == {"ok": True}
    site.chat_messages("r_a", since=4)
    site.chat_messages("r_a", before=9)
    site.chat_join("r_a")
    site.chat_create("games", "board games")
    site.chat_update("r_a", topic="hi")
    site.chat_delete("r_a", 7)
    with pytest.raises(site.SiteError, match="too quickly"):
        site.chat_post("r_a", "hello")
    assert [(m, p, b) for m, p, b, _, _ in FakeSite.seen] == [
        ("GET", "/chat/api/state", None),
        ("GET", "/chat/api/rooms/r_a/messages?since=4", None),
        ("GET", "/chat/api/rooms/r_a/messages?before=9", None),
        ("POST", "/chat/api/rooms/r_a/join", None),
        ("POST", "/chat/api/rooms", {"name": "games", "topic": "board games"}),
        ("PATCH", "/chat/api/rooms/r_a", {"topic": "hi"}),
        ("DELETE", "/chat/api/rooms/r_a/messages/7", None),
        ("POST", "/chat/api/rooms/r_a/messages", {"body": "hello"}),
    ]
    # No Origin header: the site treats that like its own page.
    assert all(origin is None for *_, origin in FakeSite.seen)
