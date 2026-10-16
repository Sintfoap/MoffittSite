"""Chat in the terminal, like /chat/: rooms on the left, the open room on the
right, a line to type in at the bottom. Like the web page it asks the site for
changes every few seconds. Anything that isn't a message starts with a slash:
/join, /leave, /new, /dm, /search, /edit, /react, /help…
"""
from __future__ import annotations

import asyncio
import re
import time
from datetime import datetime

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import Footer, Input, Label, ListItem, ListView, Static

from . import site
from .look import BAD, BG, GOLD, GOLD_DIM, GOOD, INK, LINE, MUTED, PANEL, Failed, Page, plural

ROOM_EVERY, LIST_EVERY = 2.5, 15     # seconds, the same as the web page
TYPING_EVERY = 3                     # tell the room you're typing at most this often
MARK = {"open": "# ", "private": "* ", "dm": "@ "}
GROUP_SECONDS = 5 * 60               # messages this close from one person share a heading

HELP = """Type a message and press enter to send it (members only). @name mentions
someone; tab after @ completes a name from the room.
  /join  /leave              join or leave the open room
  /new NAME | TOPIC          make a room anyone can join (the topic is optional)
  /private NAME | TOPIC      make a room only people you add can see
  /add NAME  /remove NAME    add someone to a private room, or take them out (owner)
  /dm NAME                   a direct message with someone (tab completes names)
  /who                       who's in the room, and who's online (●)
  /search TEXT               find messages in this room; /search on its own goes back
  /rename NAME  /topic TEXT  change the open room (its owner, or an admin)
  /edit [TEXT]               change your last message (↑ on an empty line too)
  /react NAME                react to the last message from someone else, or
                             take it back: +1 heart laugh tada wow sad eyes pray
  /delete                    delete your last message in this room
  /older                     load older messages
tab or esc moves to the room list; enter on a room opens it. Start a message
with // to send one that begins with /."""

# Names for the site's reactions, since emoji are hard to type in a terminal.
REACTION_NAMES = {
    "+1": "👍", "thumbsup": "👍", "like": "👍", "yes": "👍",
    "heart": "❤️", "love": "❤️", "<3": "❤️",
    "laugh": "😂", "lol": "😂", "haha": "😂",
    "tada": "🎉", "party": "🎉", "yay": "🎉",
    "wow": "😮", "sad": "😢", "eyes": "👀", "look": "👀", "pray": "🙏", "thanks": "🙏",
}
# The same @name rule as the site's (src/chat.js).
MENTION = re.compile(r"(^|[^\w@./])@([a-z0-9][a-z0-9_-]{2,31})(?![\w-])", re.IGNORECASE)


def clock(t: int) -> str:
    return datetime.fromtimestamp(t).strftime("%H:%M")


def day(t: int) -> str:
    d, today = datetime.fromtimestamp(t).date(), datetime.now().date()
    if d == today:
        return "Today"
    if (today - d).days == 1:
        return "Yesterday"
    return f"{d:%A} {d.day} {d:%B}" + ("" if d.year == today.year else f" {d.year}")


def body_text(body: str, me: str | None, style: str) -> Text:
    """A message's text with @names picked out, and @you stronger still."""
    t, at = Text(), 0
    for m in MENTION.finditer(body):
        start = m.start(2) - 1
        t.append(body[at:start], style=style)
        you = me and m.group(2).lower() == me
        t.append("@" + m.group(2), style=f"bold {BG} on {GOLD}" if you else f"bold {GOLD}")
        at = m.end()
    t.append(body[at:], style=style)
    return t


def render_log(messages: list[dict], more: bool, me: str | None = None) -> Text:
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
        if m.get("mentions_me"):
            t.append("▌", style=GOLD)
        t.append_text(body_text(m["body"], me, MUTED if m.get("pending") else INK))
        if m.get("edited_at"):
            t.append(" (edited)", style=MUTED)
        t.append("\n")
        if m.get("reactions"):
            t.append("  ")
            for r in m["reactions"]:
                t.append(f" {r['emoji']} {r['count']} ", style=f"bold {GOLD}" if r["mine"] else MUTED)
            t.append("\n")
        prev = m
    if not messages:
        t.append("\nNo messages yet.\n", style=MUTED)
    return t


def _names(names: list[str]) -> str:
    return " and ".join(names) if len(names) <= 2 else ", ".join(names[:-1]) + " and " + names[-1]


def render_results(found: dict, q: str) -> Text:
    msgs = found["messages"]
    t = Text(f"{len(msgs)}{'+' if found.get('more') else ''} message{'' if len(msgs) == 1 else 's'} with “{q}”, newest first\n"
             if msgs else f"Nothing here says “{q}”.\n", style=MUTED)
    for m in msgs:
        t.append(f"\n{m['author_name']}", style=f"bold {GOLD if m['mine'] else INK}")
        t.append(f"  {day(m['created_at'])} {clock(m['created_at'])}\n", style=MUTED)
        body = Text(m["body"] + "\n", style=INK)
        body.highlight_words([q], style=f"bold {BG} on {GOLD}", case_sensitive=False)
        t.append_text(body)
    return t


class RoomItem(ListItem):
    def __init__(self, room: dict, is_open: bool, online: frozenset = frozenset()):
        self.room = room
        super().__init__(Label(self.label(room, is_open, online)))

    def update(self, room: dict, is_open: bool, online: frozenset = frozenset()) -> None:
        self.room = room
        self.query_one(Label).update(self.label(room, is_open, online))

    @staticmethod
    def label(room: dict, is_open: bool, online: frozenset = frozenset()) -> Text:
        kind = room.get("kind", "open")
        name = Text(MARK[kind], style=GOLD if kind == "private" else MUTED)
        name.append(room["name"], style=f"bold {INK}" if room["joined"] else MUTED)
        if kind == "dm" and room.get("with") in online:
            name.append(" ●", style=GOOD)
        if room.get("mentions") and not is_open:
            name.append("  @", style=f"bold {BAD}")
        if room["unread"] and not is_open:
            name.append(f"  {min(room['unread'], 99)}", style=f"bold {GOLD}")
        if not room["joined"]:
            name.append(f"  {room['members']}", style=MUTED)
        return name


class MessageInput(Input):
    """The message line. Tab after an @ completes a name from the room; ↑ on
    an empty line starts editing your last message."""
    BINDINGS = [
        Binding("tab", "complete", "Complete", show=False),
        Binding("up", "edit_last", "Edit last", show=False),
    ]

    def action_complete(self) -> None:
        head = self.value[:self.cursor_position]
        m = re.search(r"^/(?:dm|add|remove) @?([a-z0-9_-]*)$", head, re.IGNORECASE)
        if m:
            names = self.screen.people_names(m.group(1).lower(), room_only=head.lower().startswith("/remove"))
        else:
            m = re.search(r"(?:^|[^\w@./])@([a-z0-9_-]*)$", head, re.IGNORECASE)
            names = self.screen.mention_names(m.group(1).lower()) if m else []
        if not names:
            self.screen.focus_next()
            return
        # One match fills it in; several fill in what they share.
        common = names[0] if len(names) == 1 else _shared_start(names)
        done = len(names) == 1
        new_head = head[:len(head) - len(m.group(1))] + common + (" " if done else "")
        self.value = new_head + self.value[self.cursor_position:]
        self.cursor_position = len(new_head)
        if not done:
            self.screen.status("@" + "  @".join(names))

    def action_edit_last(self) -> None:
        if not self.value:
            self.screen.start_edit()


def _shared_start(words: list[str]) -> str:
    out = words[0]
    for w in words[1:]:
        while not w.startswith(out):
            out = out[:-1]
    return out


class ChatPage(Page):
    WEB_PATH = "/chat/"
    DEFAULT_CSS = f"""
    ChatPage #main {{ padding: 1 2 0 2; }}
    ChatPage #side {{ width: 30; margin-right: 1; }}
    ChatPage #side-title {{ height: 1; margin-bottom: 1; }}
    ChatPage #rooms {{ background: {BG}; border: round {LINE}; height: 1fr; }}
    ChatPage #rooms:focus {{ border: round {GOLD}; background-tint: {BG} 0%; }}
    ChatPage #rooms > ListItem {{ background: {BG}; padding: 0 1; }}
    ChatPage #rooms > ListItem.-highlight {{ background: {PANEL}; }}
    ChatPage #rooms:focus > ListItem.-highlight {{ background: #1d2a1b; }}
    ChatPage #room {{ background: {PANEL}; border: round {LINE}; }}
    ChatPage #head {{ height: auto; padding: 0 1; border-bottom: solid {LINE}; }}
    ChatPage #log {{ height: 1fr; padding: 0 1; scrollbar-background: {PANEL}; }}
    ChatPage #presence {{ height: 1; padding: 0 2; color: {MUTED}; }}
    ChatPage #input {{ margin: 0 1; }}
    ChatPage #status {{ height: 1; padding: 0 2; color: {GOLD_DIM}; }}
    """
    BINDINGS = [
        Binding("ctrl+n", "new_room", "New room"),
        Binding("ctrl+u", "older", "Older"),
        Binding("f5", "reload", "Refresh"),
    ]

    def __init__(self, api=site, room: str | None = None):
        super().__init__()
        self.api = api
        self.want = room                 # a room name or id from the command line
        self.me: dict = {}
        self.rooms: list[dict] = []
        self.open: dict | None = None    # {id, seq, more, joined, messages: {id: message}, members: [...]}
        self.reactions: list[str] = list(dict.fromkeys(REACTION_NAMES.values()))
        self.online: frozenset = frozenset()
        self.people: list[dict] = []        # everyone else, for /dm and /add
        self.searching: str | None = None   # the search whose results are showing
        self._typed = 0.0
        self._busy = False

    def compose(self) -> ComposeResult:
        yield from self.top()
        with Horizontal(id="main"):
            with Vertical(id="side"):
                yield Static("C H A T", id="side-title", classes="kicker")
                yield ListView(id="rooms")
            with Vertical(id="room"):
                yield Static(Text("Pick a room on the left, or /new NAME to make one. /help lists commands.", style=MUTED), id="head")
                with VerticalScroll(id="log"):
                    yield Static(id="messages")
                yield Static(id="presence")
                yield MessageInput(placeholder="Message, or /help", id="input")
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
        self.run_worker(self.load_people(), exclusive=True, group="people")   # for /dm and /add
        self.set_interval(ROOM_EVERY, self.poll)
        self.set_interval(LIST_EVERY, self.load_rooms)

    # ── talking to the site ────────────────────────────────────────────
    async def call(self, fn, *args, **kw):
        """A site call off the UI thread; None if it failed (the person has been told why)."""
        try:
            return await self.fetch(lambda: fn(*args, **kw))
        except Failed:
            return None

    def status(self, text: str, bad: bool = False) -> None:
        self.query_one("#status", Static).update(Text(f"● {text}" if text else "", style=BAD if bad else GOLD_DIM))

    async def load_rooms(self) -> None:
        s = await self.call(self.api.chat_state)
        if s is None:
            return
        # Your rooms, then your direct messages, then rooms you could join.
        order = lambda r: (not r["joined"], r.get("kind") == "dm")  # noqa: E731
        self.me, self.rooms = s["user"], sorted(s["rooms"], key=order)
        self.reactions = s.get("reactions") or self.reactions
        self.online = frozenset(s.get("online") or ())
        if self.open and not any(r["id"] == self.open["id"] for r in self.rooms):
            self.open = None
            self.query_one("#head", Static).update(Text("That room was deleted.", style=MUTED))
            self.query_one("#messages", Static).update("")
        await self.render_rooms()

    async def render_rooms(self) -> None:
        lv = self.query_one("#rooms", ListView)
        items = list(lv.query(RoomItem))
        is_open = lambda r: bool(self.open and self.open["id"] == r["id"])  # noqa: E731
        if [i.room["id"] for i in items] == [r["id"] for r in self.rooms]:
            # Same rooms in the same order: just redraw them, so the highlight stays put.
            for item, r in zip(items, self.rooms):
                item.update(r, is_open(r), self.online)
            return
        current = lv.index
        await lv.clear()
        await lv.extend(RoomItem(r, is_open(r), self.online) for r in self.rooms)
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
                     "messages": {m["id"]: m for m in data["messages"]}, "members": [],
                     "here": data.get("here") or [], "typing": data.get("typing") or []}
        self.searching = None
        r = self.room()
        if r:
            r["unread"] = r["mentions"] = 0
        self.run_worker(self.load_members(room_id), exclusive=True, group="members")
        self.status("")
        self.render_head()
        self.render_messages(to_bottom=True)
        self.render_presence()
        await self.render_rooms()
        self.query_one("#input", Input).focus()

    async def load_members(self, room_id: str) -> None:
        """Who's in the room, for completing @names."""
        try:
            members = await asyncio.to_thread(self.api.chat_members, room_id)
        except site.SiteError:
            return      # only completion misses out; the next room open tries again
        if self.open and self.open["id"] == room_id:
            self.open["members"] = members

    async def load_people(self) -> None:
        try:
            self.people = await asyncio.to_thread(self.api.chat_people)
        except site.SiteError:
            pass

    def people_names(self, start: str, room_only: bool = False) -> list[str]:
        if room_only:
            return self.mention_names(start)
        if not self.people:
            self.run_worker(self.load_people(), exclusive=True, group="people")
        return sorted(p["username"] for p in self.people
                      if p["username"].startswith(start) or p["name"].lower().startswith(start))

    def mention_names(self, start: str) -> list[str]:
        mine = self.me.get("username")
        people = (self.open or {}).get("members") or []
        return sorted(p["username"] for p in people
                      if p["username"] != mine and (p["username"].startswith(start) or p["name"].lower().startswith(start)))

    def render_head(self) -> None:
        r, o = self.room(), self.open
        if not r or not o:
            return
        kind = r.get("kind", "open")
        t = Text(MARK[kind], style=GOLD if kind == "private" else MUTED)
        t.append(r["name"], style=f"bold {INK}")
        if kind == "dm":
            t.append(f"   direct message with @{r.get('with') or '?'}", style=MUTED)
            if r.get("with") in self.online:
                t.append("  ● online", style=GOOD)
        else:
            t.append(f"   {plural(r['members'], 'member')}", style=MUTED)
        if kind == "private":
            t.append("   private: /add NAME to bring people in", style=GOLD_DIM)
        if not o["joined"]:
            t.append("   not joined: /join to post", style=GOLD)
        if r["topic"]:
            t.append("\n" + r["topic"], style=MUTED)
        self.query_one("#head", Static).update(t)
        self.query_one("#input", Input).placeholder = (
            f"Message {MARK[kind]}{r['name']}, or /help" if o["joined"] else "/join to post here, or /help")

    def render_presence(self) -> None:
        o = self.open
        t = Text()
        if o and o["typing"]:
            t.append("… ", style=GOLD)
            t.append(f"{_names(o['typing'])} {'is' if len(o['typing']) == 1 else 'are'} typing", style=MUTED)
        elif o and o["here"]:
            t.append("● ", style=GOOD)
            t.append(f"here now: {_names(o['here'])}", style=MUTED)
        self.query_one("#presence", Static).update(t)

    def render_messages(self, to_bottom: bool = False) -> None:
        if self.searching is not None:
            return
        log = self.query_one("#log", VerticalScroll)
        near_bottom = log.max_scroll_y - log.scroll_y < 3
        shown = sorted((m for m in self.open["messages"].values() if not m["deleted"]), key=lambda m: m["id"])
        self.query_one("#messages", Static).update(render_log(shown, self.open["more"], self.me.get("username")))
        if to_bottom or near_bottom:
            self.call_after_refresh(log.scroll_end, animate=False)

    async def poll(self) -> None:
        # Not while another page is on top, or while a poll is still out.
        if not self.open or self._busy or not self.is_current:
            return
        self._busy = True
        room_id = self.open["id"]
        try:
            data = await self.call(self.api.chat_messages, room_id, since=self.open["seq"])
            if data is None or not self.open or self.open["id"] != room_id:
                return
            people = (data.get("here") or [], data.get("typing") or [])
            if people != (self.open["here"], self.open["typing"]):
                self.open["here"], self.open["typing"] = people
                self.render_presence()
            if not data["messages"]:
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

    def on_input_changed(self, event: Input.Changed) -> None:
        # Let the room know you're typing a message (not a command), now and then.
        o, v = self.open, event.value
        if o and o["joined"] and v and not (v.startswith("/") and not v.startswith("//")) and time.monotonic() - self._typed > TYPING_EVERY:
            self._typed = time.monotonic()
            self.run_worker(asyncio.to_thread(self.api.chat_typing, o["id"]), group="typing", exit_on_error=False)

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
        self._typed = 0.0
        temp = {"id": float("inf"), "body": text, "created_at": int(time.time()), "author": self.me.get("username"),
                "author_name": self.me.get("name", ""), "mine": True, "deleted": False, "pending": True}
        self.open["messages"][temp["id"]] = temp
        self.render_messages(to_bottom=True)
        m = await self.call(self.api.chat_post, room_id, text)
        if self.open and self.open["id"] == room_id:
            self.open["messages"].pop(temp["id"], None)
            if m:
                self.open["messages"][m["id"]] = m
            else:
                self.query_one("#input", Input).value = text    # not sent: put it back to try again
            self.render_messages(to_bottom=True)

    async def command(self, text: str) -> None:
        word, _, rest = text[1:].partition(" ")
        word, rest = word.lower(), rest.strip()
        o = self.open
        if word in ("help", "h", "?"):
            self.query_one("#messages", Static).update(Text(HELP, style=MUTED))
            return
        if word in ("new", "private"):
            name, _, topic = rest.partition("|")
            if not name.strip():
                return self.status(f"Usage: /{word} NAME | TOPIC", bad=True)
            r = await self.call(self.api.chat_create, name.strip(), topic.strip(), private=word == "private")
            if r:
                await self.load_rooms()
                await self.open_room(r["id"])
                self.status(f"made {MARK[r.get('kind', 'open')]}{r['name']}" + ("; /add NAME to bring people in" if word == "private" else ""))
            return
        if word == "dm":
            if not rest:
                return self.status("Usage: /dm NAME", bad=True)
            r = await self.call(self.api.chat_dm, rest.lstrip("@"))
            if r:
                await self.load_rooms()
                await self.open_room(r["id"])
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
        elif word == "edit":
            last = self.last_mine()
            if not last:
                return self.status("You have no messages here to edit.", bad=True)
            if not rest:
                return self.start_edit()
            m = await self.call(self.api.chat_edit, o["id"], last["id"], rest)
            if m and self.open is o:
                o["messages"][m["id"]] = m
                self.render_messages()
                self.status("edited your last message")
        elif word == "react":
            await self.react(rest)
        elif word == "delete":
            last = self.last_mine()
            if not last:
                return self.status("You have no messages here to delete.", bad=True)
            if await self.call(self.api.chat_delete, o["id"], last["id"]) is not None:
                last["deleted"] = True
                self.render_messages()
                self.status("deleted your last message")
        elif word == "older":
            await self.action_older()
        elif word in ("add", "remove"):
            if not rest:
                return self.status(f"Usage: /{word} NAME", bad=True)
            fn = self.api.chat_add if word == "add" else self.api.chat_remove
            people = await self.call(fn, o["id"], rest.lstrip("@").lower())
            if people is not None:
                o["members"] = people
                await self.load_rooms()
                self.render_head()
                self.status(f"{'added' if word == 'add' else 'took out'} @{rest.lstrip('@').lower()}")
        elif word == "who":
            people = await self.call(self.api.chat_members, o["id"])
            if people is not None:
                o["members"] = people
                t = Text("Members (● online)\n", style=f"bold {INK}")
                for p in people:
                    t.append("● " if p.get("online") else "  ", style=GOOD)
                    t.append(p["name"], style=INK)
                    t.append(f"  @{p['username']}" + ("  · made this room" if p.get("owner") else "") + "\n", style=MUTED)
                self.query_one("#messages", Static).update(t)
        elif word == "search":
            if not rest:
                self.searching = None
                self.status("")
                return self.render_messages(to_bottom=True)
            found = await self.call(self.api.chat_search, o["id"], rest)
            if found is not None and self.open is o:
                self.searching = rest
                self.query_one("#messages", Static).update(render_results(found, rest))
                self.query_one("#log", VerticalScroll).scroll_home(animate=False)
                self.status("/search on its own goes back to the room")
        else:
            self.status(f"No command /{word}. /help lists them.", bad=True)

    def last_mine(self) -> dict | None:
        mine = [m for m in (self.open or {}).get("messages", {}).values()
                if m["mine"] and not m["deleted"] and not m.get("pending")]
        return max(mine, key=lambda m: m["id"]) if mine else None

    def start_edit(self) -> None:
        """Puts your last message on the line as /edit TEXT, ready to change."""
        last = self.last_mine()
        if not last:
            return self.status("You have no messages here to edit.", bad=True)
        box = self.query_one("#input", Input)
        box.value = "/edit " + last["body"].replace("\n", " ")
        box.cursor_position = len(box.value)
        box.focus()
        self.status("change it and press enter; esc to leave it as it was")

    async def react(self, name: str) -> None:
        o = self.open
        emoji = REACTION_NAMES.get(name.lower(), name)
        if emoji not in self.reactions:
            return self.status("Usage: /react NAME, one of +1 heart laugh tada wow sad eyes pray", bad=True)
        if not o["joined"]:
            return self.status("Join the room to react: /join", bad=True)
        shown = sorted((m for m in o["messages"].values() if not m["deleted"] and not m.get("pending")), key=lambda m: m["id"])
        target = next((m for m in reversed(shown) if not m["mine"]), None) or (shown[-1] if shown else None)
        if not target:
            return self.status("There's nothing here to react to yet.", bad=True)
        on = not any(r["emoji"] == emoji and r["mine"] for r in target.get("reactions", []))
        m = await self.call(self.api.chat_react, o["id"], target["id"], emoji, on)
        if m and self.open is o:
            o["messages"][m["id"]] = m
            self.render_messages()
            self.status(f"{'reacted' if on else 'took back'} {emoji} to {target['author_name']}")

    # ── keys ───────────────────────────────────────────────────────────
    def leave_field(self) -> bool:
        if self.searching is not None:     # Esc first closes search results
            self.searching = None
            self.status("")
            self.render_messages(to_bottom=True)
            return True
        # Esc in the message line goes to the room list; Esc there leaves the page.
        self.query_one("#rooms", ListView).focus()
        return True

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
