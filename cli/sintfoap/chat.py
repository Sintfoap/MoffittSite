"""Chat in the terminal (Textual): the rooms from /chat/, in the site's colours.

Rooms on the left, the open room on the right, a line to type in at the bottom.
Like the web page it asks the site for changes every few seconds. Anything
that isn't a message starts with a slash: /join, /leave, /new, /help…
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime

from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import Footer, Input, Label, ListItem, ListView, Static

from . import site
from .tui import BG, PANEL, GOLD, GOLD_DIM, INK, MUTED, LINE, BAD

ROOM_EVERY, LIST_EVERY = 2.5, 15     # seconds, the same as the web page
GROUP_SECONDS = 5 * 60               # messages this close from one person share a heading

HELP = """Type a message and press enter to send it (members only).
  /join  /leave              join or leave the open room
  /new NAME | TOPIC          make a room (the topic is optional)
  /rename NAME  /topic TEXT  change the open room (its owner, or an admin)
  /delete                    delete your last message in this room
  /older                     load older messages
  /quit                      leave chat
tab moves between the room list and the message line; enter on a room opens it."""


def clock(t: int) -> str:
    return datetime.fromtimestamp(t).strftime("%H:%M")


def day(t: int) -> str:
    d, today = datetime.fromtimestamp(t).date(), datetime.now().date()
    if d == today:
        return "Today"
    if (today - d).days == 1:
        return "Yesterday"
    return f"{d:%A} {d.day} {d:%B}" + ("" if d.year == today.year else f" {d.year}")


def render_log(messages: list[dict], more: bool) -> Text:
    """The open room's messages as styled text, oldest first."""
    t = Text()
    if more:
        t.append("  /older for earlier messages\n", style=GOLD_DIM)
    prev, last_day = None, None
    for m in messages:
        d = day(m["created_at"])
        if d != last_day:
            t.append(f"\n{'─' * 3} {d} {'─' * 3}\n", style=MUTED)
            last_day, prev = d, None
        first = not prev or prev["author"] != m["author"] or m["created_at"] - prev["created_at"] > GROUP_SECONDS
        if first:
            t.append("\n")
            t.append(m["author_name"], style=f"bold {GOLD if m['mine'] else INK}")
            t.append(f"  {clock(m['created_at'])}\n", style=MUTED)
        t.append(m["body"] + "\n", style=MUTED if m.get("pending") else INK)
        prev = m
    if not messages:
        t.append("\nNo messages yet.\n", style=MUTED)
    return t


class RoomItem(ListItem):
    def __init__(self, room: dict, is_open: bool):
        self.room = room
        super().__init__(Label(self.label(room, is_open)))

    def update(self, room: dict, is_open: bool) -> None:
        self.room = room
        self.query_one(Label).update(self.label(room, is_open))

    @staticmethod
    def label(room: dict, is_open: bool) -> Text:
        name = Text("# ", style=MUTED)
        name.append(room["name"], style=f"bold {INK}" if room["joined"] else MUTED)
        if room["unread"] and not is_open:
            name.append(f"  {min(room['unread'], 99)}", style=f"bold {GOLD}")
        if not room["joined"]:
            name.append(f"  {room['members']}", style=MUTED)
        return name


class Chat(App):
    TITLE = "sintfoap.xyz chat"
    CSS = f"""
    Screen {{ background: {BG}; color: {INK}; }}
    #top {{ height: 1; padding: 0 2; margin-top: 1; }}
    #crest {{ width: auto; color: {GOLD}; text-style: bold; }}
    #who {{ width: 1fr; content-align: right middle; color: {MUTED}; }}
    #main {{ padding: 1 2 0 2; }}
    #side {{ width: 30; margin-right: 1; }}
    #side-title {{ color: {GOLD}; text-style: bold; height: 1; margin-bottom: 1; }}
    #rooms {{ background: {BG}; border: round {LINE}; height: 1fr; scrollbar-size-vertical: 1; scrollbar-background: {BG}; scrollbar-color: {LINE}; }}
    #rooms:focus {{ border: round {GOLD}; }}
    #rooms > ListItem {{ background: {BG}; padding: 0 1; }}
    #rooms > ListItem.-highlight {{ background: {PANEL}; }}
    #rooms:focus > ListItem.-highlight {{ background: {LINE}; }}
    #room {{ background: {PANEL}; border: round {LINE}; }}
    #head {{ height: auto; padding: 0 1; border-bottom: solid {LINE}; }}
    #log {{ height: 1fr; padding: 0 1; scrollbar-size-vertical: 1; scrollbar-background: {PANEL}; scrollbar-color: {LINE}; scrollbar-color-hover: {GOLD_DIM}; }}
    #input {{ background: {BG}; border: round {LINE}; margin: 0 1; }}
    #input:focus {{ border: round {GOLD}; }}
    #status {{ height: 1; padding: 0 2; color: {GOLD_DIM}; }}
    Footer {{ background: {PANEL}; }}
    """
    BINDINGS = [
        Binding("ctrl+n", "new_room", "New room"),
        Binding("ctrl+u", "older", "Older"),
        Binding("f5", "reload", "Refresh"),
        Binding("escape", "focus_rooms", "Rooms", show=False),
        Binding("ctrl+q", "quit", "Quit"),
    ]

    def __init__(self, api=site, room: str | None = None):
        super().__init__()
        self.api = api
        self.want = room                 # a room name or id from the command line
        self.me: dict = {}
        self.rooms: list[dict] = []
        self.open: dict | None = None    # {id, seq, more, joined, messages: {id: message}}
        self.signed_out = False
        self._busy = False

    def compose(self) -> ComposeResult:
        with Horizontal(id="top"):
            yield Static("✕ SINTFOAP.XYZ · CHAT", id="crest")
            yield Static(id="who")
        with Horizontal(id="main"):
            with Vertical(id="side"):
                yield Static("R O O M S", id="side-title")
                yield ListView(id="rooms")
            with Vertical(id="room"):
                yield Static(Text("Pick a room on the left, or /new NAME to make one. /help lists commands.", style=MUTED), id="head")
                with VerticalScroll(id="log"):
                    yield Static(id="messages")
                yield Input(placeholder="Message, or /help", id="input")
        yield Static(id="status")
        yield Footer()

    async def on_mount(self) -> None:
        await self.load_rooms()
        if self.rooms:
            want = (self.want or "").lstrip("#").lower()
            pick = next((r for r in self.rooms if want and want in (r["id"], r["name"].lower())), None)
            pick = pick or next((r for r in self.rooms if r["joined"]), None)
            if pick:
                await self.open_room(pick["id"])
            else:
                self.query_one("#rooms", ListView).focus()
        else:
            self.query_one("#input", Input).focus()
        self.set_interval(ROOM_EVERY, self.poll)
        self.set_interval(LIST_EVERY, self.load_rooms)

    # ── talking to the site ────────────────────────────────────────────
    async def call(self, fn, *args, **kw):
        """Runs an API call off the UI thread. Returns None (and says why) if it fails."""
        try:
            return await asyncio.to_thread(fn, *args, **kw)
        except site.SignedOut:
            self.signed_out = True
            self.exit(message="Signed out on the site. Run  sintfoap login  to sign in again.")
        except site.SiteError as e:
            self.status(str(e).removeprefix("the site said: "), bad=True)
        return None

    def status(self, text: str, bad: bool = False) -> None:
        self.query_one("#status", Static).update(Text(f"● {text}", style=BAD if bad else GOLD_DIM))

    async def load_rooms(self) -> None:
        s = await self.call(self.api.chat_state)
        if s is None:
            return
        self.me, self.rooms = s["user"], sorted(s["rooms"], key=lambda r: not r["joined"])
        self.query_one("#who", Static).update(Text(self.me["name"], style=INK))
        if self.open and not any(r["id"] == self.open["id"] for r in self.rooms):
            self.open = None
            self.query_one("#head", Static).update(Text("That room was deleted.", style=MUTED))
            self.query_one("#messages", Static).update("")
        await self.render_rooms()

    async def render_rooms(self) -> None:
        lv = self.query_one("#rooms", ListView)
        items = list(lv.query(RoomItem))
        is_open = lambda r: bool(self.open and self.open["id"] == r["id"])
        if [i.room["id"] for i in items] == [r["id"] for r in self.rooms]:
            # Same rooms in the same order: just redraw them, so the highlight stays put.
            for item, r in zip(items, self.rooms):
                item.update(r, is_open(r))
            return
        current = lv.index
        await lv.clear()
        await lv.extend(RoomItem(r, is_open(r)) for r in self.rooms)
        if self.open:
            current = next((i for i, r in enumerate(self.rooms) if r["id"] == self.open["id"]), current)
        if self.rooms:
            lv.index = min(current or 0, len(self.rooms) - 1)

    def room(self) -> dict | None:
        return next((r for r in self.rooms if self.open and r["id"] == self.open["id"]), None)

    async def open_room(self, room_id: str) -> None:
        data = await self.call(self.api.chat_messages, room_id)
        if data is None:
            return
        self.open = {"id": room_id, "seq": data["seq"], "more": data["more"], "joined": data["joined"],
                     "messages": {m["id"]: m for m in data["messages"]}}
        r = self.room()
        if r:
            r["unread"] = 0
        self.query_one("#status", Static).update("")
        self.render_head()
        self.render_messages(to_bottom=True)
        await self.render_rooms()
        self.query_one("#input", Input).focus()

    def render_head(self) -> None:
        r, o = self.room(), self.open
        if not r or not o:
            return
        t = Text("# ", style=MUTED)
        t.append(r["name"], style=f"bold {INK}")
        t.append(f"   {r['members']} member{'s' * (r['members'] != 1)}", style=MUTED)
        if not o["joined"]:
            t.append("   not joined: /join to post", style=GOLD)
        if r["topic"]:
            t.append("\n" + r["topic"], style=MUTED)
        self.query_one("#head", Static).update(t)
        self.query_one("#input", Input).placeholder = (
            f"Message # {r['name']}, or /help" if o["joined"] else "/join to post here, or /help")

    def render_messages(self, to_bottom: bool = False) -> None:
        log = self.query_one("#log", VerticalScroll)
        near_bottom = log.max_scroll_y - log.scroll_y < 3
        shown = sorted((m for m in self.open["messages"].values() if not m["deleted"]), key=lambda m: m["id"])
        self.query_one("#messages", Static).update(render_log(shown, self.open["more"]))
        if to_bottom or near_bottom:
            self.call_after_refresh(log.scroll_end, animate=False)

    async def poll(self) -> None:
        if not self.open or self._busy:
            return
        self._busy = True
        room_id = self.open["id"]
        try:
            data = await self.call(self.api.chat_messages, room_id, since=self.open["seq"])
            if data is None or not self.open or self.open["id"] != room_id or not data["messages"]:
                return
            for m in data["messages"]:
                self.open["messages"][m["id"]] = m
            self.open["seq"] = max(self.open["seq"], data["seq"])
            self.render_messages()
        finally:
            self._busy = False

    # ── input ──────────────────────────────────────────────────────────
    async def on_list_view_selected(self, event: ListView.Selected) -> None:
        if isinstance(event.item, RoomItem):
            await self.open_room(event.item.room["id"])

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        text = event.value.strip()
        event.input.value = ""
        if not text:
            return
        if text.startswith("/") and not text.startswith("//"):
            await self.command(text)
        else:
            await self.send(text.removeprefix("/"))     # "//" sends a message that starts with "/"

    async def send(self, text: str) -> None:
        if not self.open:
            return self.status("Pick a room first.", bad=True)
        if not self.open["joined"]:
            return self.status("Join the room to post: /join", bad=True)
        room_id = self.open["id"]
        temp = {"id": float("inf"), "body": text, "created_at": int(time.time()), "author": self.me.get("username"),
                "author_name": self.me.get("name", ""), "mine": True, "deleted": False, "pending": True}
        self.open["messages"][temp["id"]] = temp
        self.render_messages(to_bottom=True)
        m = await self.call(self.api.chat_post, room_id, text)
        if self.open and self.open["id"] == room_id:
            self.open["messages"].pop(temp["id"], None)
            if m:
                self.open["messages"][m["id"]] = m
                self.status("sent")
            else:
                self.query_one("#input", Input).value = text
            self.render_messages(to_bottom=True)

    async def command(self, text: str) -> None:
        word, _, rest = text[1:].partition(" ")
        word, rest = word.lower(), rest.strip()
        o = self.open
        if word in ("help", "h", "?"):
            self.query_one("#messages", Static).update(Text(HELP, style=MUTED))
            return
        if word in ("quit", "q", "exit"):
            self.exit()
            return
        if word == "new":
            name, _, topic = rest.partition("|")
            if not name.strip():
                return self.status("Usage: /new NAME | TOPIC", bad=True)
            r = await self.call(self.api.chat_create, name.strip(), topic.strip())
            if r:
                await self.load_rooms()
                await self.open_room(r["id"])
                self.status(f"made # {r['name']}")
            return
        if not o:
            return self.status("Open a room first.", bad=True)
        if word in ("join", "leave"):
            if await self.call(self.api.chat_join if word == "join" else self.api.chat_leave, o["id"]) is not None:
                await self.load_rooms()
                await self.open_room(o["id"])
                self.status("joined" if word == "join" else "left the room")
        elif word in ("rename", "topic"):
            if word == "rename" and not rest:
                return self.status("Usage: /rename NAME", bad=True)
            if await self.call(self.api.chat_update, o["id"], **{"name" if word == "rename" else "topic": rest}) is not None:
                await self.load_rooms()
                self.render_head()
                self.status("saved")
        elif word == "delete":
            mine = [m for m in o["messages"].values() if m["mine"] and not m["deleted"] and not m.get("pending")]
            if not mine:
                return self.status("You have no messages here to delete.", bad=True)
            last = max(mine, key=lambda m: m["id"])
            if await self.call(self.api.chat_delete, o["id"], last["id"]) is not None:
                last["deleted"] = True
                self.render_messages()
                self.status("deleted your last message")
        elif word == "older":
            await self.action_older()
        else:
            self.status(f"No command /{word}. /help lists them.", bad=True)

    # ── keys ───────────────────────────────────────────────────────────
    def action_new_room(self) -> None:
        box = self.query_one("#input", Input)
        box.value = "/new "
        box.focus()
        box.cursor_position = len(box.value)

    async def action_older(self) -> None:
        o = self.open
        if not o or not o["more"]:
            return self.status("No older messages.")
        real = [i for i in o["messages"] if isinstance(i, int)]
        data = await self.call(self.api.chat_messages, o["id"], before=min(real))
        if data and self.open is o:
            for m in data["messages"]:
                o["messages"][m["id"]] = m
            o["more"] = data["more"]
            self.render_messages()
            self.query_one("#log", VerticalScroll).scroll_home(animate=False)

    async def action_reload(self) -> None:
        await self.load_rooms()
        await self.poll()

    def action_focus_rooms(self) -> None:
        self.query_one("#rooms", ListView).focus()


def run(room: str | None = None) -> None:
    Chat(room=room).run()
