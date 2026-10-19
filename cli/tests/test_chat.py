"""sintfoap chat: the chat page against a stand-in for /chat/api (see src/chat.js)."""
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
        self.typing_calls = 0
        self.seq = {}
        self.rooms = {}
        self.msgs = []
        self.joined = set()
        self.next_id = 1

    def add_room(self, rid, name, joined=True, owner=False):
        self.rooms[rid] = {"id": rid, "name": name, "topic": "", "members": 1, "joined": joined,
                           "unread": 0, "mentions": 0, "manage": owner}
        self.seq[rid] = 0
        if joined:
            self.joined.add(rid)

    def add_message(self, rid, body, author="sam", mine=False):
        self.seq[rid] += 1
        m = {"id": self.next_id, "seq": self.seq[rid], "created_at": int(time.time()), "deleted": False, "body": body,
             "author": author, "author_name": author.title(), "mine": mine, "can_delete": mine, "can_edit": mine,
             "edited_at": None, "mentions_me": "@ryan" in body and not mine, "reactions": [], "room": rid}
        self.next_id += 1
        self.msgs.append(m)
        return m

    def chat_state(self):
        rooms = [{**r, "joined": r["id"] in self.joined} for r in self.rooms.values()]
        return {"user": {"username": "ryan", "name": "Ryan M", "admin": False}, "rooms": rooms, "online": ["kim"],
                "reactions": ["👍", "❤️", "😂", "🎉", "😮", "😢", "👀", "🙏"]}

    def chat_messages(self, room, since=None, before=None):
        if room not in self.rooms:
            raise site.SiteError("the site said: not found")
        ms = [m for m in self.msgs if m["room"] == room]
        if since is not None:
            out, more = [m for m in ms if m["seq"] > since], False
        else:
            ms = [m for m in ms if not m["deleted"] and (before is None or m["id"] < before)]
            out, more = ms[-3:], len(ms) > 3        # pages of 3, to test history
        return {"seq": self.seq[room], "more": more, "joined": room in self.joined, "messages": out,
                "here": ["Sam"], "typing": ["Kim"] if self.typing_calls else []}

    def chat_post(self, room, text):
        if room not in self.joined:
            raise site.SiteError("the site said: join the room to post in it")
        return self.add_message(room, text, "ryan", mine=True)

    def chat_delete(self, room, mid):
        m = next(m for m in self.msgs if m["id"] == mid)
        self.seq[room] += 1
        m.update(deleted=True, body="", seq=self.seq[room])
        return {"deleted": True}

    def chat_edit(self, room, mid, text):
        m = next(m for m in self.msgs if m["id"] == mid)
        self.seq[room] += 1
        m.update(body=text, edited_at=int(time.time()), seq=self.seq[room])
        return dict(m)

    def chat_react(self, room, mid, emoji, on=True):
        m = next(m for m in self.msgs if m["id"] == mid)
        self.seq[room] += 1
        rs = [r for r in m["reactions"] if r["emoji"] != emoji]
        if on:
            rs.append({"emoji": emoji, "count": 1, "mine": True, "names": "Ryan M"})
        m.update(reactions=rs, seq=self.seq[room])
        return dict(m)

    def chat_members(self, room):
        return [{"username": u, "name": u.title(), "joined_at": 0, "owner": False} for u in ("ryan", "sam", "sandra", "kim")]

    def chat_create(self, name, topic="", private=False):
        rid = f"r_{len(self.rooms):016x}"
        self.add_room(rid, name, owner=True)
        self.rooms[rid].update(topic=topic, kind="private" if private else "open")
        return self.rooms[rid]

    def chat_people(self):
        return [{"username": "sam", "name": "Sam", "online": False}, {"username": "kim", "name": "Kim", "online": True}]

    def chat_dm(self, username):
        rid = f"r_dm{username:0>13}"
        if rid not in self.rooms:
            self.add_room(rid, username.title())
            self.rooms[rid].update(kind="dm", **{"with": username})
        return self.rooms[rid]

    def chat_add(self, room, username):
        self.added = (room, username)
        return self.chat_members(room)

    def chat_remove(self, room, username):
        if username == "kim":
            raise site.SiteError("the site said: only the room's owner can take people out")
        return self.chat_members(room)

    def chat_search(self, room, text, months=None):
        self.searched = (text, months)
        found = [m for m in reversed(self.msgs) if m["room"] == room and not m["deleted"] and text.lower() in m["body"].lower()]
        if months:
            # As a Matrix room's search answers: one found there that isn't here yet.
            return {"more": False, "since": 1_700_000_000, "platform": "Matrix", "messages": found + [{
                "id": None, "ext_id": "$old", "on_platform": True, "author_name": "Sam", "mine": False,
                "created_at": 1_700_100_000, "body": f"older {text} from Matrix", "deleted": False}]}
        return {"more": False, "messages": found}

    def chat_typing(self, room):
        self.typing_calls += 1
        return {"typing": True}

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
    from rich.text import Text
    from textual.app import App
    from sintfoap.chat_page import ChatPage
    from sintfoap.look import CSS as SITE_CSS

    class Host(App):
        """Just enough of SiteApp to hold the page."""
        CSS = SITE_CSS
        data, signed_out = None, False

        def who_line(self):
            return Text("Ryan M")

        def on_mount(self):
            self.push_screen(ChatPage(api=api, room=room))

    async def go():
        app = Host()
        async with app.run_test(size=(110, 34)) as pilot:
            await pilot.pause()
            await pilot.pause()
            await test(app.screen, pilot)
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


def test_edit_react_and_mentions():
    api = FakeChatApi()
    api.add_room("r_a", "general")
    api.add_message("r_a", "lunch at noon, @ryan?")

    async def t(app, pilot):
        assert "▌" in shown(app)                      # mentioned
        await type_line(pilot, "sure thign")
        # ↑ on the empty line puts the last message up to edit.
        await pilot.press("up")
        box = app.query_one("#input")
        assert box.value == "/edit sure thign"
        box.value = "/edit sure thing"
        await pilot.press("enter")
        await pilot.pause()
        assert api.msgs[-1]["body"] == "sure thing" and "(edited)" in shown(app)

        await type_line(pilot, "/react tada")
        assert api.msgs[0]["reactions"][0]["emoji"] == "🎉", "reacts to the last message from someone else"
        assert "🎉 1" in shown(app)
        await type_line(pilot, "/react tada")
        assert api.msgs[0]["reactions"] == [], "the same again takes it back"
        await type_line(pilot, "/react pizza")
        assert "Usage: /react" in str(app.query_one("#status").render())

        # Tab after @ completes a name from the room; with two choices it fills in what they share.
        for ch in "hi @k":
            await pilot.press("space" if ch == " " else ch)
        await pilot.press("tab")
        assert box.value == "hi @kim " and box.has_focus
        box.value = "@s"
        box.cursor_position = 2
        await pilot.press("tab")
        assert box.value == "@sa" and "@sam" in str(app.query_one("#status").render())
        box.value = ""
        await pilot.press("tab")
        assert not box.has_focus, "tab with nothing to complete still moves on"
    run_chat(api, t)


def test_room_list_shows_mentions():
    from sintfoap.chat_page import RoomItem
    room = {"id": "r_a", "name": "general", "joined": True, "unread": 2, "mentions": 1, "members": 3}
    assert str(RoomItem.label(room, False)) == "# general  @  2"
    assert str(RoomItem.label(room, True)) == "# general"


def test_a_long_room_list_scrolls_and_long_names_keep_their_badges():
    api = FakeChatApi()
    for i in range(40):
        api.add_room(f"r{i}", f"room-{i}" + ("-with-a-name-far-too-long-for-the-column" if i == 30 else ""), joined=i < 25)
    api.rooms["r30"]["unread"] = 0

    async def t(app, pilot):
        lv = app.query_one("#rooms")
        assert lv.max_scroll_y > 0
        lv.focus()
        lv.index = 30
        await pilot.pause()
        item = next(i for i in app.query("RoomItem") if i.room["id"] == "r30")
        assert item.region.height == 1 and lv.scrollable_content_region.contains_region(item.region)
        name = str(item.query_one(".name").render())
        assert name.startswith("# room-30-with") and name.endswith("…") and len(name) == item.query_one(".name").size.width and str(item.query_one(".badges").render()) == "  1"
        # The column keeps its width, with a one-cell scrollbar.
        assert app.query_one("#side").size.width == 30 and lv.styles.scrollbar_size_vertical == 1
    run_chat(api, t)


def test_private_rooms_dms_search_and_presence():
    api = FakeChatApi()
    api.add_room("r_a", "general")
    api.add_message("r_a", "pizza on friday")
    api.add_message("r_a", "something else")

    async def t(app, pilot):
        assert "here now: Sam" in str(app.query_one("#presence").render())
        # Typing a message tells the room; a command doesn't.
        for ch in "/he":
            await pilot.press(ch)
        assert api.typing_calls == 0
        app.query_one("#input").value = ""
        await pilot.press("h", "i")
        await pilot.pause()
        assert api.typing_calls == 1
        app.query_one("#input").value = ""
        await app.poll()
        assert "Kim is typing" in str(app.query_one("#presence").render())

        await type_line(pilot, "/search PIZZA")
        assert "1 message with" in shown(app) and "something else" not in shown(app)
        assert api.searched == ("PIZZA", None)
        # Back some months: Matrix's own search finds older history too.
        await type_line(pilot, "/search 1y pizza")
        assert api.searched == ("pizza", 12)
        assert "2 messages with “pizza” since" in shown(app) and "older pizza from Matrix" in shown(app) and "on Matrix" in shown(app)
        await type_line(pilot, "/search 6 months pizza")
        assert api.searched == ("pizza", 6)
        await pilot.press("escape")                     # back to the room
        assert "something else" in shown(app) and app.focused.id == "input"

        await type_line(pilot, "/private plans | just us")
        assert app.room()["kind"] == "private" and "/add NAME" in str(app.query_one("#head").render())
        # Tab completes people for /add and /dm.
        for ch in "/add k":
            await pilot.press("space" if ch == " " else ch)
        await pilot.press("tab")
        assert app.query_one("#input").value == "/add kim "
        await pilot.press("enter")
        await pilot.pause()
        assert api.added == (app.open["id"], "kim")
        await type_line(pilot, "/remove sam")
        assert "took out @sam" in str(app.query_one("#status").render())

        await type_line(pilot, "/dm kim")
        assert app.room()["kind"] == "dm" and app.room()["with"] == "kim"
        head = str(app.query_one("#head").render())
        assert "direct message with @kim" in head and "online" in head
        item = next(i for i in app.query("RoomItem") if i.room["id"] == app.open["id"])
        assert str(item.query_one(".name").render()) == "@ Kim" and str(item.query_one(".badges").render()) == " ●"

        await type_line(pilot, "/who")
        assert "Members" in shown(app) and "@sandra" in shown(app)
    run_chat(api, t)


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
        # The site answers lists of members, people and connections with a list.
        lists = self.command == "GET" and self.path.endswith(("/members", "/people", "/connections"))
        self._send(201 if self.command == "POST" else 200, [] if lists else {"ok": True})

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
    site.chat_edit("r_a", 7, "fixed")
    site.chat_react("r_a", 7, "👍", on=False)
    assert site.chat_members("r_a") == []
    site.chat_create("secret", private=True)
    site.chat_dm("sam")
    site.chat_people()
    site.chat_add("r_a", "kim")
    site.chat_remove("r_a", "kim")
    site.chat_search("r_a", "pizza & beer")
    site.chat_search("r_a", "pizza", months=6)
    site.chat_typing("r_a")
    assert site.chat_connections() == []
    site.chat_connect("matrix", {"homeserver": "matrix.org", "token": "syt_x"})
    site.chat_sync("k_1")
    site.chat_disconnect("k_1")
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
        ("PATCH", "/chat/api/rooms/r_a/messages/7", {"body": "fixed"}),
        ("POST", "/chat/api/rooms/r_a/messages/7/reactions", {"emoji": "👍", "on": False}),
        ("GET", "/chat/api/rooms/r_a/members", None),
        ("POST", "/chat/api/rooms", {"name": "secret", "topic": "", "private": True}),
        ("POST", "/chat/api/dms", {"username": "sam"}),
        ("GET", "/chat/api/people", None),
        ("POST", "/chat/api/rooms/r_a/members", {"username": "kim"}),
        ("DELETE", "/chat/api/rooms/r_a/members/kim", None),
        ("GET", "/chat/api/rooms/r_a/search?q=pizza%20%26%20beer", None),
        ("GET", "/chat/api/rooms/r_a/search?q=pizza&months=6", None),
        ("POST", "/chat/api/rooms/r_a/typing", None),
        ("GET", "/chat/api/connections", None),
        ("POST", "/chat/api/connections", {"provider": "matrix", "homeserver": "matrix.org", "token": "syt_x"}),
        ("POST", "/chat/api/connections/k_1/sync", None),
        ("DELETE", "/chat/api/connections/k_1", None),
        ("POST", "/chat/api/rooms/r_a/messages", {"body": "hello"}),
    ]
    # No Origin header: the site treats that like its own page.
    assert all(origin is None for *_, origin in FakeSite.seen)


def test_the_dashboard_chat_card_opens_the_chat_page(monkeypatch):
    pytest.importorskip("textual")
    from sintfoap.chat_page import ChatPage
    from sintfoap.tui import SiteApp

    api = FakeChatApi()
    api.add_room("r_a", "general")
    api.add_message("r_a", "hello ryan")
    for name in ("chat_state", "chat_messages", "chat_post", "chat_members", "chat_people"):
        monkeypatch.setattr(site, name, getattr(api, name))
    origin = "https://sintfoap.test"
    dash = {"site": origin, "user": {"username": "ryan", "display_name": "Ryan M", "admin": False},
            "apps": [{"name": "Chat", "blurb": "Rooms.", "url": origin + "/chat/"}],
            "account": {"two_factor": True, "sessions": 1, "recovery_codes_left": 5, "email": None,
                        "email_confirmed": False, "setup_needed": None, "url": origin + "/account"}}

    async def go():
        app = SiteApp(load=lambda: dash)
        async with app.run_test(size=(110, 34)) as pilot:
            for _ in range(3):
                await pilot.pause()
            app.screen.query_one("#app-0").focus()
            await pilot.press("enter")
            for _ in range(3):
                await pilot.pause()
            assert isinstance(app.screen, ChatPage)
            assert "hello ryan" in shown(app.screen)
            await pilot.press("escape", "escape")     # message line → room list → back to the dashboard
            await pilot.pause()
            assert not isinstance(app.screen, ChatPage)
    asyncio.run(go())
