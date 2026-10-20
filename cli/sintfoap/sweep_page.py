"""Sweep in the terminal: the same suggestions as /sweep/.

The rooms Sweep may read down the left (space ticks one, b changes how far
back its first sweep looks). On the right, what it suggested from them: a
accepts one into Drift, e edits it first, x turns it down (shift+x says why),
and s sweeps the ticked rooms again. What you accept and turn down shapes
what it suggests next."""
from __future__ import annotations

import time

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Footer, Input, Label, OptionList, Select, SelectionList, Static
from textual.widgets.option_list import Option
from textual.widgets.selection_list import Selection

from . import site
from .look import BAD, FAINT, GOLD, GOOD, INK, MUTED, Ask, Page, attempt, plural

KINDS = {"event": "Event", "task": "Task", "list": "List item"}
KIND_STYLE = {"event": GOLD, "task": GOOD, "list": MUTED}


def nice_when(s: str | None) -> str:
    """'Fri Oct 24, 7:00 PM' from YYYY-MM-DD or YYYY-MM-DDTHH:MM."""
    if not s:
        return ""
    day, _, hm = s.partition("T")
    t = time.strptime(day, "%Y-%m-%d")
    out = time.strftime("%a %b %-d", t)
    if hm:
        h, m = (int(x) for x in hm.split(":"))
        out += f", {h % 12 or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"
    return out


def stamp(t: int | None) -> str:
    return time.strftime("%b %-d, %-I:%M %p", time.localtime(t)) if t else ""


def guess(data: dict, s: dict) -> dict | None:
    """The collection a suggestion names, if you have one by that name."""
    name = (s.get("collection") or "").casefold()
    return next((c for c in data["collections"] if not c.get("owner_name") and c["name"].casefold() == name), None) if name else None


def days_label(n: int) -> str:
    return "last day" if n == 1 else f"last {n} days"


class EditDialog(ModalScreen[dict | None]):
    """A suggestion's title, kind, date and collection before accepting it. Dismisses with what to send, or None."""
    BINDINGS = [Binding("escape", "cancel", "Cancel"), Binding("ctrl+s", "save", "Accept", priority=True)]

    def __init__(self, s: dict, collections: list[dict], named: dict | None):
        super().__init__()
        self.s, self.collections, self.named = s, collections, named

    def compose(self) -> ComposeResult:
        s = self.s
        options = [(f"{c['name']} ({c['owner_name']})" if c.get("owner_name") else c["name"], c["id"]) for c in self.collections]
        if not self.named and s["kind"] == "list" and s.get("collection"):
            options.insert(0, (f"New list: {s['collection']}", ""))
        with VerticalScroll(classes="dialog"):
            yield Label(Text("Edit, then accept", style=f"bold {INK}"))
            yield Label("Title", classes="lbl")
            yield Input(s["title"], id="title", max_length=200)
            yield Label("Kind", classes="lbl")
            yield Select([(v, k) for k, v in KINDS.items()], value=s["kind"], allow_blank=False, id="kind")
            yield Label("When (YYYY-MM-DD or YYYY-MM-DDTHH:MM)", classes="lbl")
            yield Input(s.get("start") or "", id="start")
            yield Label("Into", classes="lbl")
            yield Select(options, value=self.named["id"] if self.named else options[0][1], allow_blank=False, id="collection")
            with Horizontal(classes="buttons"):
                yield Button("Accept", id="save")
                yield Button("Cancel", id="cancel", classes="quiet")
            yield Static(Text("ctrl+s accepts, esc cancels", style=FAINT))

    def on_mount(self) -> None:
        self.query_one("#title", Input).focus()

    def action_save(self) -> None:
        title = self.query_one("#title", Input).value.strip()
        if not title:
            self.app.notify("A suggestion needs a title.", severity="error", timeout=3)
            return
        out = {"title": title, "kind": self.query_one("#kind", Select).value,
               "start": self.query_one("#start", Input).value.strip() or None}
        col = self.query_one("#collection", Select).value
        if col:
            out["collection"] = col
        self.dismiss(out)

    def action_cancel(self) -> None:
        self.dismiss(None)

    def on_input_submitted(self) -> None:
        self.action_save()

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.action_save() if e.button.id == "save" else self.dismiss(None)


class SweepPage(Page):
    WEB_PATH = "/sweep/"
    SIDE = "#side"
    DEFAULT_CSS = f"""
    SweepPage #body {{ padding: 0 2 0 2; height: 1fr; }}
    SweepPage #notice {{ display: none; border: round {BAD}; color: {BAD}; padding: 0 1; margin-bottom: 1; }}
    SweepPage #notice.on {{ display: block; }}
    SweepPage #status {{ color: {GOLD}; height: auto; margin-bottom: 1; }}
    SweepPage #main {{ height: 1fr; }}
    SweepPage #side {{ width: 38; height: 1fr; border-right: solid {GOLD}; margin-right: 2; padding-right: 1; }}
    SweepPage #right {{ width: 1fr; height: 1fr; }}
    SweepPage .group {{ color: {FAINT}; }}
    SweepPage #rooms {{ height: auto; max-height: 20; background: {INK} 0%; border: none; padding: 0; margin-bottom: 1; }}
    SweepPage #rooms:focus {{ border: none; background-tint: {INK} 0%; }}
    SweepPage #room-note {{ color: {FAINT}; }}
    SweepPage #sugs {{ height: auto; max-height: 14; margin-bottom: 1; }}
    SweepPage #detail {{ height: auto; margin-bottom: 1; }}
    SweepPage #history {{ height: auto; color: {MUTED}; }}
    """
    BINDINGS = [
        Binding("s", "sweep", "Sweep now"),
        Binding("a", "accept", "Accept"),
        Binding("e", "edit", "Edit"),
        Binding("x", "reject", "Turn down"),
        Binding("X", "reject_why", "Turn down, why", show=False),
        Binding("b", "back", "How far back", show=False),
        Binding("r", "refresh", "Refresh"),
    ]

    def __init__(self):
        super().__init__()
        self.data: dict | None = None

    def compose(self) -> ComposeResult:
        yield from self.top()
        with Vertical(id="body"):
            yield Static("S W E E P", classes="kicker")
            yield Static(Text("Suggestions from your chats", style=f"bold {INK}"), classes="h1")
            yield Static(Text("Sweep reads the rooms you tick and suggests events, tasks and list items for Drift. "
                              "Nothing is added until you accept it.", style=MUTED), classes="sub")
            yield Static(id="notice")
            yield Static(id="status")
            with Horizontal(id="main"):
                with VerticalScroll(id="side"):
                    yield Static("ROOMS TO READ", classes="group")
                    yield SelectionList(id="rooms")
                    yield Static(id="room-note")
                with VerticalScroll(id="right"):
                    yield Static("WAITING FOR YOU", classes="group", id="sugs-title")
                    yield OptionList(id="sugs")
                    yield Static(id="detail")
                    yield Static("WHAT YOU'VE DECIDED", classes="group", id="history-title")
                    yield Static(id="history")
        yield Footer()

    async def on_mount(self) -> None:
        super().on_mount()
        await self.action_refresh()
        self.query_one("#sugs" if self.data and self.data["suggestions"] else "#rooms").focus()

    @attempt
    async def action_refresh(self) -> None:
        self.show(await self.fetch(site.sweep_state))

    def current(self) -> dict | None:
        if not self.data:
            return None
        i = self.query_one("#sugs", OptionList).highlighted
        sugs = self.data["suggestions"]
        return sugs[i] if i is not None and 0 <= i < len(sugs) else None

    def room_at(self) -> dict | None:
        rooms = self.query_one("#rooms", SelectionList)
        i = rooms.highlighted
        return self.data["rooms"][i] if self.data and i is not None and 0 <= i < len(self.data["rooms"]) else None

    def show(self, data: dict) -> None:
        keep = self.current()
        self.data = data
        notice = self.query_one("#notice", Static)
        problem = ("Sweep isn't set up on this site yet. The site's admin needs to add the ANTHROPIC_API_KEY secret." if not data["ready"]
                   else "You need Drift to accept suggestions. Ask the site's admin to turn it on for you." if not data["drift"] else "")
        notice.update(problem)
        notice.set_class(bool(problem), "on")

        rooms = self.query_one("#rooms", SelectionList)
        at = rooms.highlighted
        with rooms.prevent(SelectionList.SelectedChanged):
            rooms.clear_options()
            for r in data["rooms"]:
                label = Text(r["name"], style=INK if not r["encrypted"] or r["on"] else FAINT)
                label.append(f"  {days_label(r['days'])}" if r["on"] else "  encrypted" if r["encrypted"] else "", style=FAINT)
                rooms.add_option(Selection(label, r["id"], r["on"], disabled=r["encrypted"] and not r["on"]))
        if data["rooms"]:
            rooms.highlighted = min(at or 0, len(data["rooms"]) - 1)
        self.query_one("#room-note", Static).update(
            Text("You aren't in any chat rooms yet." if not data["rooms"] else
                 "space ticks a room · b how far back\nEncrypted rooms can't be read yet.", style=FAINT))

        sugs = self.query_one("#sugs", OptionList)
        sugs.clear_options()
        for s in data["suggestions"]:
            t = Text(f"{KINDS[s['kind']]:<10}", style=KIND_STYLE[s["kind"]])
            t.append(s["title"], style=INK)
            if s.get("start"):
                t.append(f"  {nice_when(s['start'])}", style=GOLD)
            sugs.add_option(Option(t))
        n = len(data["suggestions"])
        self.query_one("#sugs-title", Static).update(f"WAITING FOR YOU ({n})" if n else "WAITING FOR YOU")
        sugs.display = bool(n)
        if n:
            ids = [s["id"] for s in data["suggestions"]]
            sugs.highlighted = ids.index(keep["id"]) if keep and keep["id"] in ids else 0
        self.show_detail()

        hist = Text()
        for s in data["history"][:15]:
            yes = s["status"] == "accepted"
            hist.append("✓ " if yes else "✕ ", style=GOOD if yes else BAD)
            hist.append(f"{KINDS[s['kind']]}: {(s.get('accepted') or {}).get('title') or s['title']}", style=MUTED)
            hist.append(f"  {s['room_name']}" + (f" · “{s['reason']}”" if s.get("reason") else "") + "\n", style=FAINT)
        self.query_one("#history", Static).update(hist or Text("Nothing yet.", style=FAINT))

    def show_detail(self) -> None:
        s, d = self.current(), self.query_one("#detail", Static)
        if not s:
            on = self.data and any(r["on"] for r in self.data["rooms"])
            d.update(Text("Nothing waiting. Press s to read what's new in your rooms." if on
                          else "Nothing yet. Tick some rooms on the left, then press s to sweep.", style=FAINT))
            return
        t = Text(s["title"], style=f"bold {INK}")
        if s.get("start"):
            t.append(f"\n{nice_when(s['start'])}" + (f" – {nice_when(s['end'])}" if s.get("end") else ""), style=GOLD)
        if s.get("quote"):
            t.append(f"\n“{s['quote']}”", style=MUTED)
        t.append("\n" + " · ".join(x for x in (s["room_name"], s["author"], stamp(s.get("said_at"))) if x), style=FAINT)
        if s.get("why"):
            t.append(f"\n{s['why']}", style=f"italic {FAINT}")
        named = guess(self.data, s)
        into = named["name"] if named else f"a new list, {s['collection']}" if s["kind"] == "list" and s.get("collection") else \
            (self.data["collections"][0]["name"] if self.data["collections"] else "")
        if into and self.data["drift"]:
            t.append(f"\na adds it to {into} · e edits first · x turns it down", style=GOLD)
        d.update(t)

    def on_option_list_option_highlighted(self, e: OptionList.OptionHighlighted) -> None:
        if e.option_list.id == "sugs":
            self.show_detail()

    @attempt
    async def on_selection_list_selection_toggled(self, e: SelectionList.SelectionToggled) -> None:
        room = next((r for r in self.data["rooms"] if r["id"] == e.selection.value), None)
        if not room:
            return
        on = e.selection.value in e.selection_list.selected
        try:
            self.show(await self.fetch(site.sweep_room, room["id"], on))
        except Exception:
            self.show(self.data)
            raise
        self.app.notify(f"Sweep {'reads' if on else 'leaves'} {room['name']}.", timeout=2)

    @attempt
    async def action_back(self) -> None:
        room = self.room_at()
        if not room or not room["on"]:
            return
        days = self.data["days"]
        nxt = days[(days.index(room["days"]) + 1) % len(days)] if room["days"] in days else days[0]
        self.show(await self.fetch(site.sweep_room, room["id"], True, nxt))
        self.app.notify(f"{room['name']}: the first sweep reads the {days_label(nxt)}.", timeout=2)

    @attempt
    async def action_sweep(self) -> None:
        if not self.data or not self.data["ready"]:
            return
        status = self.query_one("#status", Static)
        status.update("Reading your rooms…")
        try:
            out = await self.fetch(site.sweep_now)
        except Exception:
            status.update("")
            raise
        self.show(out["state"])
        read = sum(r["messages"] for r in out["swept"])
        msg = (f"Read {plural(read, 'message')}, " + (f"{plural(out['added'], 'new suggestion')}." if out["added"] else "nothing new to suggest.")
               + (" There's more to read: press s again." if out.get("more") else "")) if read else "Nothing new in your rooms since the last sweep."
        status.update(msg)
        if out["added"]:
            self.query_one("#sugs").focus()

    async def decide(self, s: dict, yes: bool, body: dict) -> None:
        out = await self.fetch(site.sweep_accept if yes else site.sweep_reject, s["id"], body)
        self.show(out["state"] if yes else out)
        self.query_one("#status", Static).update(
            f"Added “{out['item']['title']}” to {out['item']['collection_name']}." if yes else f"Turned down “{s['title']}”.")

    @attempt
    async def action_accept(self) -> None:
        s = self.current()
        if not s or not self.data["drift"]:
            return
        named = guess(self.data, s)
        await self.decide(s, True, {"collection": named["id"]} if named else {})

    def action_edit(self) -> None:
        s = self.current()
        if not s or not self.data["drift"]:
            return

        async def done(body: dict | None) -> None:
            if body:
                await attempt(lambda page: page.decide(s, True, body))(self)
        self.app.push_screen(EditDialog(s, self.data["collections"], guess(self.data, s)), done)

    @attempt
    async def action_reject(self) -> None:
        s = self.current()
        if s:
            await self.decide(s, False, {})

    def action_reject_why(self) -> None:
        s = self.current()
        if not s:
            return

        async def done(reason: str | None) -> None:
            if reason is not None:
                await attempt(lambda page: page.decide(s, False, {"reason": reason}))(self)
        self.app.push_screen(Ask(f"Turn down “{s['title']}”", "Why not? Sweep reads this next time.", ok="Turn down"), done)
