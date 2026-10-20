"""
Drift in the terminal: the same collections, views and quick-add as /todo/,
reading and writing through the site's API (src/drift.js).

Store plugins run only in the browser's sandbox, so here their data is kept
as it is and their views are a press of w away.
"""
from __future__ import annotations

import calendar
import json
import locale
import os
import time
from datetime import date, datetime

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Checkbox, Footer, Input, Label, OptionList, Select, Static, TextArea
from textual.widgets.option_list import Option

from . import site
from . import drift_rules as R
from .look import BAD, FAINT, GOLD, GOLD_DIM, GOOD, INK, LINE, MUTED, PRI, Confirm, Failed, Page, attempt, fetch, open_in_browser, plural

POLL_EVERY = 5      # seconds between "did anything change?" checks, like the web page
# Distances in miles where the web page would use them (an American English locale).
MILES = (locale.getlocale()[0] or os.environ.get("LANG", "")).startswith("en_US")
FAHRENHEIT = MILES      # and °F, for the same reason
WX_TTL, WX_RETRY = 30 * 60, 2 * 60      # seconds to keep a forecast, or to wait after one failed
TAG, COL, KIND, PLACE, RAIN = "#8fb3d9", "#b79ad6", "#c3a6f7", "#e47a62", "#7fa6d9"
ADD_HINT = "Add an item   #tag  +collection  !1-3  ^date  @time  ~ place"
STARTER = ["checklist", "event", "list", "graph"]


def writable(col: dict | None) -> bool:
    return bool(col) and col.get("role") != "view"


# ── drawing one item ───────────────────────────────────────────────────────

def item_row(it: dict, *, depth: int = 0, col_name: str | None = None, skip_event: bool = False,
             extra: list[tuple[str, str]] = (), links: list[str] = (), wx: tuple[str, str] | None = None) -> Text:
    m = it["meta"]
    ck = m.get("checklist")
    done = bool(ck and ck.get("done"))
    pri = (ck or {}).get("priority") or 0
    t = Text(no_wrap=True, overflow="ellipsis")
    t.append("▌" if pri else " ", style=PRI[pri] if pri else FAINT)
    t.append("  " * depth)
    if ck:
        t.append(" ✓ " if done else " ○ ", style=f"bold {GOOD}" if done else MUTED)
    else:
        t.append(" • ", style=GOLD_DIM)
    t.append(it["title"], style=f"{FAINT} strike" if done else INK)
    chips: list[tuple[str, str]] = []
    ev = m.get("event")
    if ev and not skip_event:
        d = R.day_of(ev["start"])
        chips.append(("◷ " + R.event_chip(ev), BAD if R.is_late(it) else GOLD if d == R.today() else MUTED))
    if wx:
        chips.append(wx)
    chips += list(extra)
    loc = m.get("location")
    if loc and R.place_label(loc):
        chips.append(("⌖ " + R.place_label(loc), PLACE if R.placed(loc) else MUTED))
    if col_name:
        chips.append((f"+{col_name}", COL))
    chips += [(f"#{g}", TAG) for g in it.get("tags", [])]
    if links:
        chips.append(("→ " + ", ".join(links), GOLD_DIM))
    if it.get("notes"):
        chips.append(("¶", FAINT))
    for s, style in chips:
        t.append("   " + s, style=FAINT if done else style)
    return t


def header(title: str, n: int | str = "", note: str = "") -> Text:
    t = Text.assemble(("\n" + title.upper(), f"bold {GOLD}"), (f"  {n}" if n != "" else "", GOLD_DIM))
    if note:
        t.append("   " + note, style=FAINT)
    return t


def month_grid(month: str, sel: str, events: list[dict], wx: dict[str, tuple[str, str]] | None = None) -> Text:
    """The month, with a dot on busy days and, given wx ({day: (symbol, style)}), each day's weather."""
    first = date.fromisoformat(month + "-01")
    busy = {}
    for it in events:
        ev = it["meta"]["event"]
        d0, d1 = R.day_of(ev["start"]), R.day_of(ev.get("end") or ev["start"])
        for d in calendar.Calendar().itermonthdates(first.year, first.month):
            if d0 <= d.isoformat() <= d1:
                busy[d.isoformat()] = busy.get(d.isoformat(), 0) + 1
    t = Text(f"\n{first.strftime('%B %Y')}\n", style=f"bold {INK}")
    t.append("  Mo   Tu   We   Th   Fr   Sa   Su\n" if wx else " Mo  Tu  We  Th  Fr  Sa  Su\n", style=MUTED)
    for week in calendar.Calendar().monthdatescalendar(first.year, first.month):
        for d in week:
            iso = d.isoformat()
            style = FAINT if d.month != first.month else (GOLD if iso in busy else INK)
            if iso == R.today():
                style += " bold underline"
            if iso == sel:
                style += " reverse"
            t.append(f"{d.day:>3}", style=style)
            t.append("•" if iso in busy and d.month == first.month else " ", style=GOLD)
            if wx is not None:
                sym, st = wx.get(iso, (" ", FAINT))
                t.append(sym, style=st)
        t.append("\n")
    t.append("[ ] day   { } month   . today", style=FAINT)
    return t


# ── dialogs ────────────────────────────────────────────────────────────────

class ItemDialog(ModalScreen[dict | None]):
    """Edit an item: its base fields, plus Checklist and Events if the collection uses them."""
    BINDINGS = [Binding("escape", "cancel", "Cancel"), Binding("ctrl+s", "save", "Save", priority=True)]
    DEFAULT_CSS = """
    ItemDialog .grid { height: auto; }
    ItemDialog .grid > Vertical { height: auto; width: 1fr; margin-right: 1; }
    ItemDialog TextArea { height: 6; }
    ItemDialog Select { width: 1fr; }
    """

    def __init__(self, it: dict, cols: list[dict], col: dict | None, wx: str = ""):
        super().__init__()
        self.it, self.cols, self.col, self.wx = it, cols, col, wx
        self.ro = not writable(col)
        plugins = (col or {}).get("plugins", [])
        self.has_check = "checklist" in plugins or "checklist" in it["meta"]
        self.has_event = "event" in plugins or "event" in it["meta"]
        self.has_place = "location" in plugins or "location" in it["meta"]
        self.has_weather = "weather" in plugins or "weather" in it["meta"]

    def compose(self) -> ComposeResult:
        it, m = self.it, self.it["meta"]
        with VerticalScroll(classes="dialog"):
            if self.ro:
                yield Static(Text(f"Shared by {self.col.get('owner_name', 'someone')}. You can view it but not change it.", style=GOLD_DIM))
            yield Label("Title", classes="lbl")
            yield Input(it["title"], id="title", disabled=self.ro)
            yield Label("Notes", classes="lbl")
            yield TextArea(it.get("notes", ""), id="notes", disabled=self.ro, soft_wrap=True)
            with Horizontal(classes="grid"):
                with Vertical():
                    yield Label("Tags", classes="lbl")
                    yield Input(" ".join(it.get("tags", [])), id="tags", placeholder="Separate with spaces", disabled=self.ro)
                with Vertical():
                    yield Label("Collection", classes="lbl")
                    owner = (self.col or {}).get("owner")
                    move = [c for c in self.cols if c["id"] == it["collection"] or (writable(c) and c.get("owner") == owner)]
                    yield Select([(c["name"], c["id"]) for c in move], value=it["collection"], allow_blank=False, id="collection", disabled=self.ro)
            if self.has_check:
                ck = m.get("checklist")
                with Horizontal(classes="grid"):
                    with Vertical():
                        yield Label("Checklist", classes="lbl")
                        yield Select([("Not on the checklist", -1)] + [(f"{p} priority" if i else "No priority", i) for i, p in enumerate(R.PRIORITY)],
                                     value=ck.get("priority", 0) if ck else -1, allow_blank=False, id="priority", disabled=self.ro)
                    with Vertical():
                        yield Label(" ", classes="lbl")
                        yield Checkbox("Done", bool(ck and ck.get("done")), id="done", disabled=self.ro)
            if self.has_event:
                ev = m.get("event") or {}
                with Horizontal(classes="grid"):
                    with Vertical():
                        yield Label("Date  (today, fri, +3d, 11/2…)", classes="lbl")
                        yield Input(R.day_of(ev.get("start")), id="day", placeholder="No date", disabled=self.ro)
                    with Vertical():
                        yield Label("Time  (9, 3pm, 15:30)", classes="lbl")
                        yield Input(R.time_of(ev.get("start")), id="time", placeholder="All day", disabled=self.ro)
            if self.has_place:
                loc = m.get("location") or {}
                yield Label("Place  (an address, a place's name, or lat, lng: the site finds it)", classes="lbl")
                yield Input(R.place_label(loc), id="place", placeholder="No place", disabled=self.ro)
                if R.placed(loc):
                    yield Static(Text(f"{loc['lat']:.5f}, {loc['lng']:.5f}", style=FAINT))
                elif loc.get("place"):
                    yield Static(Text("Not found on the map yet.", style=FAINT))
            if self.has_weather:
                yield Label("Weather", classes="lbl")
                yield Checkbox("Outdoors: warn me when its day looks wet", R.outdoors(it), id="outdoor", disabled=self.ro)
                if self.wx:
                    yield Static(Text(self.wx, style=MUTED))
            yield Static(id="err")
            with Horizontal(classes="buttons"):
                if not self.ro:
                    yield Button("Save", id="save")
                yield Button("Cancel" if not self.ro else "Close", id="cancel", classes="quiet")
                if not self.ro:
                    yield Button("Delete item", id="delete", classes="danger")
            yield Static(Text("ctrl+s save   esc cancel", style=FAINT))

    def on_mount(self) -> None:
        self.query_one("#title", Input).focus()

    def on_button_pressed(self, e: Button.Pressed) -> None:
        if e.button.id == "save":
            self.action_save()
        elif e.button.id == "delete":
            self.dismiss({"deleted": True})
        else:
            self.dismiss(None)

    def on_input_submitted(self, e: Input.Submitted) -> None:
        self.action_save()

    def action_cancel(self) -> None:
        self.dismiss(None)

    def fail(self, msg: str) -> None:
        self.query_one("#err", Static).update(Text(msg, style=BAD))

    def action_save(self) -> None:
        if self.ro:
            return self.dismiss(None)
        it, m = self.it, self.it["meta"]
        title = self.query_one("#title", Input).value.strip()
        if not title:
            return self.fail("Give the item a title.")
        out: dict = {}
        if title != it["title"]:
            out["title"] = title
        notes = self.query_one("#notes", TextArea).text
        if notes != it.get("notes", ""):
            out["notes"] = notes
        tags = sorted({g.lstrip("#").lower() for g in self.query_one("#tags", Input).value.replace(",", " ").split() if g.lstrip("#")})
        if tags != sorted(it.get("tags", [])):
            out["tags"] = tags
        col = self.query_one("#collection", Select).value
        if col != it["collection"]:
            out["collection"] = col
        meta = {}
        if self.has_check:
            pri, done = self.query_one("#priority", Select).value, self.query_one("#done", Checkbox).value
            old = m.get("checklist")
            if pri == -1:
                if old:
                    meta["checklist"] = None
            else:
                new = {"done": done, "priority": pri, "done_at": old.get("done_at") if old and old.get("done") and done else None}
                if not old or old.get("done") != done or old.get("priority") != pri:
                    meta["checklist"] = new
        if self.has_event:
            raw_day, raw_time = self.query_one("#day", Input).value.strip(), self.query_one("#time", Input).value.strip()
            old = m.get("event")
            if not raw_day and not raw_time:
                if old:
                    meta["event"] = None
            else:
                day = R.parse_date(raw_day) if raw_day else R.today()
                tm = R.parse_time(raw_time) if raw_time else ""
                if not day:
                    return self.fail(f"“{raw_day}” isn't a date Drift understands. Try today, fri, +3d or 2026-11-02.")
                if tm is None:
                    return self.fail(f"“{raw_time}” isn't a time. Try 9, 3pm or 15:30.")
                start = f"{day}T{tm}" if tm else day
                end = (old or {}).get("end")
                if end and (("T" in end) != ("T" in start) or end < start):
                    end = None
                if not old or old.get("start") != start or old.get("end") != end:
                    meta["event"] = {"start": start, "end": end}
        if self.has_place:
            raw = " ".join(self.query_one("#place", Input).value.split())
            old = m.get("location")
            if not raw:
                if old and R.place_label(old):
                    meta["location"] = None
            elif not old or raw != R.place_label(old):
                at = R.parse_coords(raw)
                meta["location"] = {"place": "", **at} if at else {"place": raw, "lat": None, "lng": None}
        if self.has_weather:
            outdoor, old = self.query_one("#outdoor", Checkbox).value, m.get("weather")
            if (old is None and outdoor) or (old is not None and old.get("outdoor") != outdoor):
                meta["weather"] = {"outdoor": outdoor}
        if meta:
            out["meta"] = meta
        self.dismiss(out)


class CollectionDialog(ModalScreen[str | None]):
    """A collection's name, plugins and sharing (or a new collection). Talks to the site itself.
    Dismisses with "deleted", "left", the new collection's id, or None."""
    BINDINGS = [Binding("escape", "close", "Close"), Binding("ctrl+s", "save", "Save", priority=True)]
    DEFAULT_CSS = f"""
    CollectionDialog .people {{ height: auto; }}
    CollectionDialog .person {{ height: auto; }}
    CollectionDialog .person Static {{ width: 1fr; }}
    CollectionDialog #share-with {{ width: 1fr; }}
    CollectionDialog #share-role {{ width: 24; }}
    CollectionDialog Checkbox {{ background: {LINE} 0%; border: none; padding: 0; }}
    """

    def __init__(self, page: "DriftPage", col: dict | None):
        super().__init__()
        self.page, self.col = page, col

    def compose(self) -> ComposeResult:
        col, st = self.col, self.page.state
        with VerticalScroll(classes="dialog"):
            if col and col["role"] != "owner":
                yield Label(Text(col["name"], style=f"bold {INK}"))
                can = "add and change items" if col["role"] == "edit" else "view items but not change them"
                yield Static(Text(f"Shared with you by {col['owner_name']}. You can {can}. Only {col['owner_name']} can rename it, change its plugins or share it.", style=MUTED))
                yield Static(Text("Plugins: " + (", ".join(self.page.plugin_name(p) for p in col["plugins"]) or "none") + ".", style=MUTED))
                with Horizontal(classes="buttons"):
                    yield Button("Leave collection", id="leave", classes="danger")
                    yield Button("Done", id="close", classes="quiet")
                return
            yield Label(Text("Collection settings" if col else "New collection", style=f"bold {INK}"))
            yield Label("Name", classes="lbl")
            yield Input(col["name"] if col else "", id="name", max_length=100, placeholder="e.g. Home, Work, Reading")
            yield Label("Plugins decide what you can add to items here and how you can see them.", classes="lbl")
            on = col["plugins"] if col else STARTER
            for pid, (name, desc) in R.BUILT_IN.items():
                yield Checkbox(Text.assemble((name, f"bold {INK}"), ("  " + desc, MUTED)), pid in on, id=f"p-{pid}")
            for p in st.get("store", []):
                if p.get("installed") or p["id"] in on:
                    yield Checkbox(Text.assemble((p["name"], f"bold {INK}"), ("  from the store, runs in the browser", MUTED)), p["id"] in on, id=f"p-{p['id']}")
            if col:
                yield Label("Sharing. Editors can add and change items; viewers can only look.", classes="lbl")
                with Vertical(classes="people"):
                    for s in col.get("shares", []):
                        with Horizontal(classes="person"):
                            yield Static(Text.assemble((s["name"], INK), (f"  @{s['username']}", MUTED)))
                            yield Button("Can edit" if s["role"] == "edit" else "Can view", id=f"role-{s['username']}", classes="quiet")
                            yield Button("Remove", id=f"unshare-{s['username']}", classes="danger")
                    if not col.get("shares"):
                        yield Static(Text("Only you.", style=FAINT))
                with Horizontal(classes="person"):
                    yield Input(id="share-with", placeholder="Their username")
                    yield Select([("Can edit", "edit"), ("Can view", "view")], value="edit", allow_blank=False, id="share-role")
                    yield Button("Share", id="share", classes="quiet")
            with Horizontal(classes="buttons"):
                yield Button("Save" if col else "Create", id="save")
                yield Button("Cancel", id="close", classes="quiet")
                if col:
                    yield Button("Delete collection", id="delete", classes="danger")

    def on_mount(self) -> None:
        for w in self.query("#name, #close"):
            w.focus()
            break

    def action_close(self) -> None:
        self.dismiss(None)

    async def on_input_submitted(self, e: Input.Submitted) -> None:
        if e.input.id == "share-with":
            await self.share(e.input.value, self.query_one("#share-role", Select).value)
        else:
            await self.action_save()

    async def on_button_pressed(self, e: Button.Pressed) -> None:
        bid = e.button.id or ""
        if bid == "close":
            self.dismiss(None)
        elif bid == "save":
            await self.action_save()
        elif bid == "share":
            await self.share(self.query_one("#share-with", Input).value, self.query_one("#share-role", Select).value)
        elif bid.startswith("role-"):
            who = bid[5:]
            s = next(x for x in self.col["shares"] if x["username"] == who)
            await self.share(who, "view" if s["role"] == "edit" else "edit")
        elif bid.startswith("unshare-"):
            await self.unshare(bid[8:])
        elif bid == "delete":
            note = " The people you shared it with lose it too." if self.col.get("shares") else ""
            self.app.push_screen(Confirm(f"Delete “{self.col['name']}” and the items in it?", "You can undo it straight after with u." + note,
                                         yes="Delete", danger=True), self.delete)
        elif bid == "leave":
            self.app.push_screen(Confirm(f"Leave “{self.col['name']}”?", f"{self.col['owner_name']} can share it with you again.",
                                         yes="Leave", danger=True), self.leave)

    @attempt
    async def action_save(self) -> None:
        if self.col and self.col["role"] != "owner":
            return
        name = self.query_one("#name", Input).value.strip()
        if not name:
            self.app.notify("Give the collection a name.", severity="error")
            return
        plugins = [cb.id[2:] for cb in self.query(Checkbox) if cb.value]
        if self.col:
            await fetch(self.app, site.update_collection, self.col["id"], {"name": name, "plugins": plugins})
            self.dismiss(self.col["id"])
        else:
            view = next((p for p in plugins if p in R.VIEW_LABELS), "")
            c = await fetch(self.app, site.add_collection, {"name": name, "plugins": plugins, "view": view})
            self.dismiss(c["id"])

    @attempt
    async def share(self, username: str, role: str) -> None:
        username = username.strip().lstrip("@")
        if not username:
            return
        x = await fetch(self.app, site.share, self.col["id"], username, role)
        self.col["shares"] = sorted([s for s in self.col.get("shares", []) if s["username"] != x["username"]] + [x], key=lambda s: s["username"])
        self.app.notify(f"{x['name']} can now {'edit' if role == 'edit' else 'view'} “{self.col['name']}”.", timeout=3)
        await self.recompose()

    @attempt
    async def unshare(self, username: str) -> None:
        await fetch(self.app, site.unshare, self.col["id"], username)
        self.col["shares"] = [s for s in self.col.get("shares", []) if s["username"] != username]
        await self.recompose()

    @attempt
    async def delete(self, yes: bool | None) -> None:
        if yes:
            await fetch(self.app, site.delete_collection, self.col["id"])
            self.dismiss("deleted")

    @attempt
    async def leave(self, yes: bool | None) -> None:
        if yes:
            await fetch(self.app, site.unshare, self.col["id"], self.page.state["user"]["username"])
            self.dismiss("left")


class BaseDialog(ModalScreen[dict | None]):
    """Set where a day starts and ends: for that day, a stretch of days, or every day (the home base).
    Returns {"base": {...}} to save, {"remove": True}, or None."""
    BINDINGS = [Binding("escape", "cancel", "Cancel"), Binding("ctrl+s", "save", "Save", priority=True)]
    DEFAULT_CSS = """
    BaseDialog .grid { height: auto; }
    BaseDialog .grid > Vertical { height: auto; width: 1fr; margin-right: 1; }
    BaseDialog Select { width: 1fr; }
    """

    def __init__(self, day: str, base: dict | None):
        super().__init__()
        self.day, self.base = day, base

    def compose(self) -> ComposeResult:
        b = self.base or {}
        scope = "home" if b and R.is_home(b) else "range" if b and b["from"] != b["to"] else "day"
        with VerticalScroll(classes="dialog"):
            yield Static(Text("Change the base" if b else "Set a base", style=f"bold {INK}"))
            yield Static(Text("Where the day's route starts and ends.", style=MUTED))
            yield Label("Place  (an address, a place's name, or lat, lng: the site finds it)", classes="lbl")
            yield Input(R.place_label(b) if b else "", id="place", placeholder="Home, a hotel, a friend's…")
            yield Label("It's the base for", classes="lbl")
            yield Select([(R.nice_day(self.day), "day"), ("A stretch of days", "range"), ("Every day (home base)", "home")],
                         value=scope, allow_blank=False, id="scope")
            with Horizontal(classes="grid", id="dates"):
                with Vertical():
                    yield Label("From", classes="lbl")
                    yield Input(b.get("from") or self.day, id="from")
                with Vertical():
                    yield Label("To", classes="lbl")
                    yield Input(b.get("to") or R.add_days(1, self.day), id="to")
            yield Static(id="err")
            with Horizontal(classes="buttons"):
                yield Button("Save", id="save")
                yield Button("Cancel", id="cancel", classes="quiet")
                if self.base:
                    yield Button("Remove base", id="remove", classes="danger")
            yield Static(Text("ctrl+s save   esc cancel", style=FAINT))

    def on_mount(self) -> None:
        self.query_one("#dates").display = self.query_one("#scope", Select).value == "range"
        self.query_one("#place", Input).focus()

    def on_select_changed(self, e: Select.Changed) -> None:
        if e.select.id == "scope":
            self.query_one("#dates").display = e.value == "range"

    def on_button_pressed(self, e: Button.Pressed) -> None:
        if e.button.id == "save":
            self.action_save()
        elif e.button.id == "remove":
            self.dismiss({"remove": True})
        else:
            self.dismiss(None)

    def on_input_submitted(self, e: Input.Submitted) -> None:
        self.action_save()

    def action_cancel(self) -> None:
        self.dismiss(None)

    def fail(self, msg: str) -> None:
        self.query_one("#err", Static).update(Text(msg, style=BAD))

    def action_save(self) -> None:
        raw = self.query_one("#place", Input).value.strip()
        if not raw:
            return self.fail("Give the base a place.")
        old = self.base
        at = R.parse_coords(raw)
        loc = ({"place": old["place"], "lat": old["lat"], "lng": old["lng"]} if old and raw == R.place_label(old)
               else {"place": "", **at} if at else {"place": raw, "lat": None, "lng": None})
        scope = self.query_one("#scope", Select).value
        if scope == "home":
            when = {"from": None, "to": None}
        elif scope == "day":
            when = {"from": self.day, "to": self.day}
        else:
            a, z = (R.parse_date(self.query_one(f"#{k}", Input).value) for k in ("from", "to"))
            if not a or not z:
                return self.fail("The days need to be dates Drift understands, like 2026-11-02, fri or +3d.")
            if z < a:
                return self.fail("The last day can't be before the first.")
            when = {"from": a, "to": z}
        self.dismiss({"base": {**loc, **when}})


# ── the page ───────────────────────────────────────────────────────────────

class ItemList(OptionList):
    """The items on screen. Its keys are the web page's."""
    BINDINGS = [
        Binding("e", "screen.edit", "Edit"),
        Binding("x,space", "screen.toggle", "Done"),
        Binding("a,n", "screen.compose", "Add"),
        Binding("v", "screen.next_view", "View"),
        Binding("slash", "screen.search", "Search"),
        Binding("c", "screen.collection", "Collection"),
        Binding("d,delete,backspace", "screen.delete", "Delete"),
        Binding("u", "screen.undo", "Undo", show=False),
        Binding("0", "screen.priority(0)", "No priority", show=False),
        Binding("1", "screen.priority(1)", "Low", show=False),
        Binding("2", "screen.priority(2)", "Medium", show=False),
        Binding("3", "screen.priority(3)", "High", show=False),
        Binding("t", "screen.date_today", "Today", show=False),
        Binding("h", "screen.show_done", "Show done", show=False),
        Binding("greater_than_sign", "screen.move('indent')", "Nest", show=False),
        Binding("less_than_sign", "screen.move('outdent')", "Unnest", show=False),
        Binding("K", "screen.move('up')", "Move up", show=False),
        Binding("J", "screen.move('down')", "Move down", show=False),
        Binding("left_square_bracket", "screen.day(-1)", "Previous day", show=False),
        Binding("right_square_bracket", "screen.day(1)", "Next day", show=False),
        Binding("left_curly_bracket", "screen.month(-1)", "Previous month", show=False),
        Binding("right_curly_bracket", "screen.month(1)", "Next month", show=False),
        Binding("full_stop", "screen.go_today", "Go to today", show=False),
        Binding("o", "screen.open_place", "Open place", show=False),
        Binding("p", "screen.route", "Route", show=False),
        Binding("m", "screen.route_mode", "Drive, walk or cycle", show=False),
        Binding("left_parenthesis", "screen.route_option(-1)", "Previous route", show=False),
        Binding("right_parenthesis", "screen.route_option(1)", "Next route", show=False),
        Binding("b", "screen.base", "Base", show=False),
        Binding("j", "cursor_down", "Down", show=False),
        Binding("k", "cursor_up", "Up", show=False),
    ]


class Nav(OptionList):
    BINDINGS = [
        Binding("j", "cursor_down", "Down", show=False),
        Binding("k", "cursor_up", "Up", show=False),
        Binding("a", "screen.compose", "Add"),
        Binding("c", "screen.collection", "Collection"),
        Binding("N", "screen.new_collection", "New collection"),
    ]


class DriftPage(Page):
    WEB_PATH = "/todo/"
    SIDE = "#side"
    DEFAULT_CSS = f"""
    DriftPage #main {{ height: 1fr; }}
    DriftPage #side {{ width: 30; padding: 0 1 0 2; border-right: tall {LINE}; }}
    DriftPage #pane {{ padding: 0 2 0 2; }}
    DriftPage #h1 {{ color: {INK}; text-style: bold; height: auto; }}
    DriftPage #subline {{ color: {MUTED}; height: auto; }}
    DriftPage #tabs {{ height: auto; margin-top: 1; }}
    DriftPage #add {{ margin-top: 1; }}
    DriftPage #preview {{ height: auto; color: {MUTED}; padding: 0 1; }}
    DriftPage #search {{ display: none; }}
    DriftPage #search.on {{ display: block; }}
    DriftPage #items {{ height: 1fr; }}
    DriftPage #geo {{ display: none; height: auto; }}
    DriftPage #geo.on {{ display: block; }}
    DriftPage Nav {{ height: 1fr; }}
    """
    BINDINGS = [
        Binding("r", "refresh", "Refresh"),
        Binding("backslash", "fold", "Side panel"),
        Binding("N", "new_collection", "New collection", show=False),
    ]

    def __init__(self):
        super().__init__()
        self.state: dict = {"collections": [], "items": [], "store": [], "user": {}}
        self.view = "today"           # "today" | "calendar" | "c:<collection id>"
        self.tabs: dict[str, str] = {}
        self.show_done = False
        self.day = R.today()
        self.month = self.day[:7]
        self.q = ""
        self.undo: tuple[str, str] | None = None     # (kind, id) of the last delete
        self.loaded = False
        # The Map view's route (p): how you get around, which of the orders, and the plan the site sent.
        self.route_on, self.profile, self.option = False, "driving-car", 0
        self.route: dict | None = None
        self.route_key: str | None = None
        # Weather's forecasts by spot (R.spot_key): {"at", "data", "loading", "failed"}.
        self.wx: dict[str, dict] = {}

    def compose(self) -> ComposeResult:
        yield from self.top()
        with Horizontal(id="main"):
            with Vertical(id="side"):
                yield Static("D R I F T", classes="kicker")
                yield Nav(id="nav")
            with Vertical(id="pane"):
                yield Static(id="h1")
                yield Static(id="subline")
                yield Static(id="tabs")
                yield Input(id="add", placeholder=ADD_HINT)
                yield Static(id="preview")
                yield Input(id="search", placeholder="Search titles, notes and tags (esc to clear)")
                yield Static(id="geo")
                yield ItemList(id="items")
        yield Footer()

    async def on_mount(self) -> None:
        await self.action_refresh()
        self.query_one("#items").focus()
        self.set_interval(POLL_EVERY, self.poll)

    # ── data ───────────────────────────────────────────────────────────
    @attempt
    async def action_refresh(self) -> None:
        self.state = await self.fetch(site.drift_state)
        self.loaded = True
        self.render_all()

    async def poll(self) -> None:
        if not self.loaded or self.app.screen is not self:
            return
        try:
            v = await fetch(self.app, site.drift_version)
        except Failed:
            return
        if v != self.state.get("version"):
            await self.action_refresh()

    def col(self, cid: str | None) -> dict | None:
        return next((c for c in self.state["collections"] if c["id"] == cid), None)

    def item(self, iid: str | None) -> dict | None:
        return next((i for i in self.state["items"] if i["id"] == iid), None)

    def plugin_name(self, pid: str) -> str:
        if pid in R.BUILT_IN:
            return R.BUILT_IN[pid][0]
        return next((p["name"] for p in self.state.get("store", []) if p["id"] == pid), pid)

    def put(self, it: dict) -> None:
        items = self.state["items"]
        for n, x in enumerate(items):
            if x["id"] == it["id"]:
                items[n] = it
                return
        items.append(it)

    # ── what's on screen ───────────────────────────────────────────────
    def current(self) -> tuple[str, dict | None, str | None]:
        """(kind, collection, tab)"""
        if self.view.startswith("c:"):
            col = self.col(self.view[2:])
            if col:
                return "col", col, self.tab_for(col)
            self.view = "today"
        return self.view, None, "event" if self.view == "calendar" else None

    def view_tabs(self, col: dict) -> list[str]:
        return [p for p in col["plugins"] if p in R.VIEW_LABELS]

    def tab_for(self, col: dict) -> str | None:
        tabs = self.view_tabs(col)
        t = self.tabs.get(col["id"]) or col.get("view")
        return t if t in tabs else (tabs[0] if tabs else None)

    def matches(self, it: dict) -> bool:
        if not self.q:
            return True
        q = self.q.lower()
        return any(q in (s or "").lower() for s in [it["title"], it.get("notes", ""), *it.get("tags", [])])

    def render_all(self) -> None:
        self.render_nav()
        self.render_items()

    def render_nav(self) -> None:
        nav = self.query_one("#nav", Nav)
        items = self.state["items"]
        live = [it for it in items if it["meta"].get("event") and R.is_open(it)]
        n_today = sum(1 for it in live if R.day_of(it["meta"]["event"]["start"]) <= R.today())
        late = any(R.is_late(it) for it in live)

        def line(label: str, n: int = 0, hot: bool = False, mark: str = "  ") -> Text:
            t = Text(no_wrap=True, overflow="ellipsis")
            t.append(mark, style=GOLD)
            t.append(label, style=INK)
            if n:
                t.append(f"  {n}", style=BAD if hot else GOLD_DIM)
            return t

        opts: list = [Option(line("Today", n_today, late, "☀ "), id="today"), Option(line("Calendar", mark="▦ "), id="calendar"),
                      Option(Text("\nCOLLECTIONS", style=f"bold {GOLD_DIM}"), disabled=True)]
        open_in = lambda c: sum(1 for it in items if it["collection"] == c["id"] and R.is_open(it))  # noqa: E731
        own = [c for c in self.state["collections"] if c["role"] == "owner"]
        shared = [c for c in self.state["collections"] if c["role"] != "owner"]
        opts += [Option(line(c["name"], open_in(c)), id="c:" + c["id"]) for c in own]
        opts.append(Option(Text("+ New collection", style=GOLD_DIM), id="new"))
        if shared:
            opts.append(Option(Text("\nSHARED WITH YOU", style=f"bold {GOLD_DIM}"), disabled=True))
            opts += [Option(line(c["name"], open_in(c)), id="c:" + c["id"]) for c in shared]
        # Drawing the list isn't someone picking a view.
        with self.prevent(OptionList.OptionHighlighted):
            nav.set_options(opts)
            ids = [o.id for o in opts]
            if self.view in ids:
                nav.highlighted = ids.index(self.view)

    def render_items(self, keep: str | None = None) -> None:
        lst = self.query_one("#items", ItemList)
        keep = keep or (lst.highlighted_option.id if lst.highlighted_option else None)
        kind, col, tab = self.current()
        cols = {c["id"]: c for c in self.state["collections"]}
        scope = [it for it in self.state["items"] if not col or it["collection"] == col["id"]]
        shown = [it for it in scope if self.matches(it)]
        name_of = (lambda it: None) if col else (lambda it: cols[it["collection"]]["name"] if it["collection"] in cols else None)
        opts: list = []

        def rows(lst_, **kw):
            for it in lst_:
                opts.append(Option(item_row(it, col_name=name_of(it), wx=self.wx_chip(it), **kw), id=it["id"]))

        def group(title, lst_, empty="", **kw):
            opts.append(Option(header(title, len(lst_) or ""), disabled=True))
            rows(lst_, **kw)
            if not lst_ and empty:
                opts.append(Option(Text("   " + empty, style=FAINT), disabled=True))

        h1, sub = "", []
        if kind == "today":
            h1 = date.today().strftime("%A")
            ev = [it for it in shown if it["meta"].get("event")]
            late = [it for it in ev if R.is_late(it)]
            on = sorted([it for it in ev if R.on_day(it["meta"]["event"], R.today())], key=R.by_start)
            left = sum(1 for it in on if R.is_open(it))
            sub = [date.today().strftime("%B ") + str(date.today().day), f"{left} of {len(on)} still open" if on else "Nothing scheduled"]
            if late:
                group("Overdue", late)
            if on:
                opts.append(Option(header("Today", len(on)), disabled=True))
                for it in on:
                    tm = R.time_of(it["meta"]["event"]["start"])
                    opts.append(Option(item_row(it, col_name=name_of(it), wx=self.wx_chip(it), skip_event=True,
                                                extra=[(R.nice_time(tm), GOLD)] if tm else []), id=it["id"]))
            if not opts:
                opts.append(Option(Text("\nNothing for today. Items with today's date, from any collection, show up here. Add one above.", style=MUTED), disabled=True))
        elif kind == "calendar" or tab == "event":
            if kind == "calendar":
                h1, sub = "Calendar", ["Events from every collection"]
            self.calendar(opts, shown, name_of)
        elif tab == "checklist":
            allc = [it for it in shown if it["meta"].get("checklist")]
            open_ = sorted([it for it in allc if not it["meta"]["checklist"].get("done")], key=R.checklist_rank)
            done = sorted([it for it in allc if it["meta"]["checklist"].get("done")],
                          key=lambda it: it["meta"]["checklist"].get("done_at") or "", reverse=True)
            if not allc:
                opts.append(Option(Text("\nNothing to check off. Add an item above and it lands here.", style=MUTED), disabled=True))
            else:
                group("Open", open_, "All done.")
                if done:
                    opts.append(Option(header("Done", len(done), "h to " + ("hide" if self.show_done else "show")), disabled=True))
                    if self.show_done:
                        rows(done)
        elif tab == "list":
            if not shown:
                opts.append(Option(Text("\nThis list is empty. Add an item above; > nests it under the one before.", style=MUTED), disabled=True))
            elif self.q:
                group("Matches", sorted(shown, key=R.list_order))
            else:
                opts.append(Option(Text("\n> nest   < unnest   K J move", style=FAINT), disabled=True))
                for it, depth in R.walk_outline(shown):
                    opts.append(Option(item_row(it, depth=depth, col_name=name_of(it), wx=self.wx_chip(it)), id=it["id"]))
        elif tab == "location":
            self.map_list(opts, shown, name_of)
        elif tab == "weather":
            self.forecast_list(opts, shown, name_of)
        elif tab == "graph":
            titles = {it["id"]: it["title"] for it in scope}
            opts.append(Option(Text("\nLinks as a list. The network you can drag and zoom is in the browser: press w.", style=FAINT), disabled=True))
            linked = [it for it in shown if it["meta"].get("graph")]
            opts.append(Option(header("Items", len(linked) or ""), disabled=True))
            for it in linked:
                g = it["meta"]["graph"]
                rel = g.get("rel") or {}
                links = [(f"{rel[x]} " if rel.get(x) else "") + titles[x] for x in g.get("links", []) if x in titles]
                kind = [(g["kind"], KIND)] if g.get("kind") else []
                opts.append(Option(item_row(it, col_name=name_of(it), wx=self.wx_chip(it), links=links, extra=kind), id=it["id"]))
        else:
            if shown:
                group("Items", shown)
            store_on = [p for p in col["plugins"] if p not in R.BUILT_IN]
            hint = (f"{', '.join(self.plugin_name(p) for p in store_on)} from the store draws its view in the browser: press w."
                    if store_on and col.get("view") in store_on else "Turn on a plugin with c for checklists, calendars and lists.")
            opts.append(Option(Text("\n" + hint, style=FAINT), disabled=True))

        if kind == "col":
            h1 = col["name"]
            n = len(scope)
            sub = [plural(n, "item")]
            if col["role"] != "owner":
                sub.append(f"Shared by {col['owner_name']}" + (", view only" if col["role"] == "view" else ""))
            elif col.get("shares"):
                sub.append("Shared with " + ", ".join(s["name"] for s in col["shares"]))
        if self.q:
            sub.append(f"matching “{self.q}”")
        self.query_one("#h1", Static).update(Text(h1, style=f"bold {INK}"))
        self.query_one("#subline", Static).update(Text("  ·  ".join(sub), style=MUTED))
        tabs = Text()
        if kind == "col":
            for p in self.view_tabs(col):
                lbl = R.VIEW_LABELS[p]
                tabs.append(f" {lbl} ", style=f"bold #1a1206 on {GOLD}" if p == tab else MUTED)
                tabs.append("  ")
            tabs.append("v next view   c " + ("settings" if col["role"] == "owner" else "about"), style=FAINT)
        self.query_one("#tabs", Static).update(tabs)
        ro = kind == "col" and not writable(col)
        add = self.query_one("#add", Input)
        add.disabled = ro
        add.placeholder = "This collection is view-only for you" if ro else ADD_HINT

        with self.prevent(OptionList.OptionHighlighted):
            lst.set_options(opts)
            ids = [o.id for o in opts]
            target = keep if keep and keep in ids else next((o.id for o in opts if o.id and not o.disabled), None)
            if target:
                lst.highlighted = ids.index(target)
        self.query_one("#geo").set_class(tab == "location", "on")
        if tab == "location":
            self.draw_map(shown, target)

    def calendar(self, opts: list, shown: list[dict], name_of) -> None:
        events = [it for it in shown if it["meta"].get("event")]
        _, col, _ = self.current()
        marks = None
        if self.weather_on(col):
            marks = {}
            for d in calendar.Calendar().itermonthdates(*(int(x) for x in self.month.split("-"))):
                iso = d.isoformat()
                f = R.forecast_day(self.forecast(R.day_spot(col, iso)), iso)
                if f:
                    marks[iso] = ("☂", f"bold {BAD}") if self.spoilt(shown, iso) else (R.sky(f.get("code"))[1], RAIN if R.wet(f) else MUTED)
        opts.append(Option(month_grid(self.month, self.day, events, marks), disabled=True))
        later = sorted([it for it in events if self.day < R.day_of(it["meta"]["event"]["start"]) <= R.add_days(14, self.day)], key=R.by_start)
        now_h = datetime.now().hour if self.day == R.today() else None
        plan = R.day_plan(events, self.day, now_h)
        n = len(plan["untimed"]) + sum(len(v) for v in plan["hours"].values())
        opts.append(Option(header(R.nice_day(self.day), n or ""), disabled=True))
        if marks is not None:
            self.day_weather(opts, shown, col, self.day)
        opts.append(Option(Text(f"  No set time  {len(plan['untimed']) or ''}", style=f"bold {MUTED}"), disabled=True))
        for it in plan["untimed"]:
            ev = it["meta"]["event"]
            extra = [("continues" + (f" until {R.nice_time(R.time_of(ev['end'])) or R.nice_day(R.day_of(ev['end']))}" if ev.get("end") else ""), GOLD)] \
                if R.time_of(ev["start"]) else []
            opts.append(Option(item_row(it, col_name=name_of(it), wx=self.wx_chip(it), skip_event=True, extra=extra), id=it["id"]))
        if not plan["untimed"]:
            opts.append(Option(Text("   Items you add without a time land here.", style=FAINT), disabled=True))
        opts.append(Option(Text("\n  By the hour", style=f"bold {MUTED}"), disabled=True))
        for h in range(plan["lo"], plan["hi"] + 1):
            label = Text(f"{R.nice_time(f'{h:02d}:00'):>6} ", style=f"bold {GOLD}" if h == now_h else MUTED if h in plan["busy"] else FAINT)
            label.append("┃" if h in plan["busy"] else "│", style=GOLD if h in plan["busy"] else FAINT)
            items = plan["hours"].get(h, [])
            if not items:
                opts.append(Option(label, disabled=True))
            for i, it in enumerate(items):
                row = label.copy() if i == 0 else Text(" " * 7 + "┃", style=GOLD)
                row.append_text(item_row(it, col_name=name_of(it), wx=self.wx_chip(it), skip_event=True, extra=[(R.when(it["meta"]["event"]), GOLD)]))
                opts.append(Option(row, id=it["id"]))
        if later:
            opts.append(Option(header("Next two weeks", len(later)), disabled=True))
            for it in later:
                opts.append(Option(item_row(it, col_name=name_of(it), wx=self.wx_chip(it)), id=it["id"]))

    # ── Weather ────────────────────────────────────────────────────────
    def weather_on(self, col: dict | None) -> bool:
        """Weather is on for this collection (on Today and Calendar: for any)."""
        cols = [col] if col else self.state["collections"]
        return any("weather" in c["plugins"] for c in cols)

    def forecast(self, spot: dict | None) -> dict | None:
        """The forecast at spot (None: near you) as far as it's known, asking the site
        for it when it's missing or old. The page draws again when it arrives."""
        key = R.spot_key(spot)
        e = self.wx.get(key)
        if e and (e["loading"] or time.monotonic() - e["at"] < (WX_RETRY if e["failed"] else WX_TTL)):
            return e["data"]
        entry = {"at": time.monotonic(), "data": (e or {}).get("data"), "loading": True, "failed": False}
        self.wx[key] = entry
        self.run_worker(self.load_forecast(entry, spot if R.placed(spot) else None))
        return entry["data"]

    async def load_forecast(self, entry: dict, spot: dict | None) -> None:
        try:
            entry["data"] = await fetch(self.app, site.drift_weather, spot)
        except Failed:
            entry["failed"] = True
        entry["loading"], entry["at"] = False, time.monotonic()
        self.render_items()

    def item_weather(self, it: dict) -> list[dict]:
        """The forecast for each day an item's event covers, as far ahead as it goes."""
        ev = it["meta"].get("event")
        if not ev:
            return []
        col, out = self.col(it["collection"]), []
        d, last = max(R.day_of(ev["start"]), R.today()), R.day_of(ev.get("end") or ev["start"])
        for _ in range(16):
            if d > last:
                break
            f = R.forecast_day(self.forecast(R.spot_for(it, d, col)), d)
            if f:
                out.append(f)
            d = R.add_days(1, d)
        return out

    def wx_chip(self, it: dict) -> tuple[str, str] | None:
        """Weather's chip for an item on it: a warning on a wet day if it's outdoors, else the forecast."""
        if "weather" not in it["meta"]:
            return None
        days = self.item_weather(it)
        if not days:
            return None
        w = next((d for d in days if R.wet(d)), None) if R.outdoors(it) and R.is_open(it) else None
        if w:
            return "☂ " + R.why(w), f"bold {BAD}"
        return f"{R.sky(days[0].get('code'))[1]} {R.hi_lo(days[0], FAHRENHEIT)}", MUTED

    def wx_line(self, it: dict) -> str:
        """The item dialog's line about its day's weather."""
        ev = it["meta"].get("event")
        if not ev:
            return "Give it a date to see its forecast."
        days = self.item_weather(it)
        if not days:
            return "Its day has passed." if R.day_of(ev.get("end") or ev["start"]) < R.today() else "The forecast reaches 16 days ahead; check back closer to the day."
        return " · ".join(("" if len(days) == 1 else d["day"][5:] + ": ") + f"{R.sky(d.get('code'))[0]}, {R.hi_lo(d, FAHRENHEIT)}"
                          + (f", {d['rain']}% chance of rain" if d.get("rain") is not None else "") for d in days)

    def spoilt(self, items: list[dict], d: str) -> list[dict]:
        """The outdoor items on day d that look like getting wet."""
        return [it for it in items if R.wet_on(it, d, self.forecast(R.spot_for(it, d, self.col(it["collection"]))))]

    def day_weather(self, opts: list, shown: list[dict], col: dict | None, d: str) -> None:
        """A day's weather in a line, and a warning naming its outdoor items if it looks wet."""
        f = R.forecast_day(self.forecast(R.day_spot(col, d)), d)
        if not f:
            return
        sym, words = R.sky(f.get("code"))[1], R.sky(f.get("code"))[0]
        line = Text(f"  {sym} {words} · {R.hi_lo(f, FAHRENHEIT)}" + (f" · {f['rain']}% chance of rain" if f.get("rain") is not None else ""),
                    style=RAIN if R.wet(f) else MUTED)
        spot = R.day_spot(col, d)
        if spot:
            line.append(f"  at {R.place_label(spot)}", style=FAINT)
        opts.append(Option(line, disabled=True))
        bad = self.spoilt(shown, d)
        if bad:
            opts.append(Option(Text("  ☂ Looks wet for " + ", ".join(f"“{it['title']}”" for it in bad)
                                    + (", which is outdoors." if len(bad) == 1 else ", which are outdoors."), style=BAD), disabled=True))

    def forecast_list(self, opts: list, shown: list[dict], name_of) -> None:
        """The Forecast view: the days ahead, each with its weather and what's on."""
        _, col, _ = self.current()
        home = R.day_spot(col, R.today())
        fc = self.forecast(home)
        key = self.wx.get(R.spot_key(home), {})
        if not fc:
            msg = "Couldn't get the forecast. It'll try again in a couple of minutes." if key.get("failed") else "Getting the forecast…"
            opts.append(Option(Text("\n" + msg, style=FAINT), disabled=True))
            return
        if not fc.get("days"):
            opts.append(Option(Text("\nThe site couldn't tell where you are. Turn on Locations and give this collection a home base on its Map (b), "
                                    "and the forecast is for there.", style=FAINT), disabled=True))
            return
        where = f" at {R.place_label(home)}" if home else " near you" if fc.get("near") else ""
        opts.append(Option(Text(f"\nThe next {len(fc['days'])} days{where}. Mark an item as outdoors (e) or tag it #outdoor "
                                "to be warned when its day looks wet.", style=FAINT), disabled=True))
        events = [it for it in shown if it["meta"].get("event")]
        for f0 in fc["days"]:
            d = f0["day"]
            if d < R.today():
                continue
            f = R.forecast_day(self.forecast(R.day_spot(col, d)), d) or f0
            label = "Today" if d == R.today() else date.fromisoformat(d).strftime("%a %b ") + str(date.fromisoformat(d).day)
            h = Text.assemble(("\n" + label.upper(), f"bold {GOLD}"))
            h.append(f"   {R.sky(f.get('code'))[1]} {R.sky(f.get('code'))[0]} · {R.hi_lo(f, FAHRENHEIT)}"
                     + (f" · {f['rain']}% rain" if f.get("rain") is not None else ""), style=RAIN if R.wet(f) else MUTED)
            opts.append(Option(h, disabled=True))
            on = sorted([it for it in events if R.on_day(it["meta"]["event"], d)], key=R.by_start)
            bad = self.spoilt(on, d)
            if bad:
                opts.append(Option(Text(("  ☂ An outdoor item" if len(bad) == 1 else f"  ☂ {len(bad)} outdoor items")
                                        + f" on a wet day. Move {'it' if len(bad) == 1 else 'them'}, or bring an umbrella.", style=BAD), disabled=True))
            for it in on:
                opts.append(Option(item_row(it, col_name=name_of(it), wx=("☂ outdoors", f"bold {BAD}") if it in bad else None), id=it["id"]))

    def route_stops(self, plan: dict, col: dict | None) -> list[dict]:
        """The day's stops in the order to show them: the route's, once the site has
        planned it (p), else the order they happen. Asks for the route when what
        it depends on changes."""
        if not (self.route_on and col and plan["stops"]):
            return plan["stops"]
        key = json.dumps([col["id"], self.day, self.profile, self.option, col.get("bases") or [],
                          [[st["item"]["id"], st["item"]["meta"].get("event"), st["item"]["meta"]["location"], st["item"]["meta"].get("graph")]
                           for st in plan["stops"]]], sort_keys=True)
        if key != self.route_key:
            self.route_key, self.route = key, None
            self.run_worker(self.load_route(key, col["id"]))
        r = self.route
        if not r or not r.get("options"):
            return plan["stops"]
        by = {st["item"]["id"]: st["item"] for st in plan["stops"]}
        opt = r["options"][r["option"]]
        shift = 0 if R.placed(r.get("base")) else -1
        order = [i for i in opt["order"] if i in by]
        return [{"item": by[i], "n": n + 1, "from": None, "leg": r["legs"][n + shift] if 0 <= n + shift < len(r["legs"]) else None,
                 "late": i in opt["late"]} for n, i in enumerate(order)]

    async def load_route(self, key: str, col_id: str) -> None:
        try:
            r = await fetch(self.app, site.drift_route, col_id, self.day, self.profile, self.option)
        except Failed:
            r = {"error": True, "options": []}
        if self.route_key == key:
            self.route = r
            self.render_items()

    def leg_text(self, leg: dict | None) -> str:
        if not leg:
            return ""
        verb = R.VERB.get((self.route or {}).get("profile"), "drive")
        return f"{R.nice_duration(leg['duration'])} {verb}" + (f", {R.nice_distance(leg['distance'], MILES)}" if leg.get("distance") else "")

    def map_list(self, opts: list, shown: list[dict], name_of) -> None:
        """The Map view's list: the day's base and stops in order, under the map (draw_map)."""
        plan = R.day_stops(shown, self.day)
        _, col, _ = self.current()
        base = R.base_for((col or {}).get("bases"), self.day)
        stops = self.route_stops(plan, col)
        keys = "[ ] day   . today   o OpenStreetMap   b base   p route" + ("   m how   ( ) other routes" if self.route_on else "")
        opts.append(Option(header(R.nice_day(self.day), len(plan["stops"]) or "", keys), disabled=True))
        line = Text("  ⌂ ", style=f"bold {GOLD}")
        if base:
            line.append(R.base_scope(base) + "  ", style=MUTED)
            line.append(R.place_label(base), style=PLACE)
            if not R.placed(base):
                line.append("  not found on the map", style=FAINT)
        else:
            line.append("No base for this day, so routes start at the first stop. b sets one.", style=FAINT)
        opts.append(Option(line, disabled=True))
        r = self.route if self.route_on and plan["stops"] else None
        if self.route_on and plan["stops"]:
            summary = Text("  ")
            if r is None:
                summary.append("Planning the route…", style=FAINT)
            elif r.get("error"):
                summary.append("Couldn't plan the route just now.", style=BAD)
            elif r["options"]:
                opt, n = r["options"][r["option"]], len(r["options"])
                summary.append(f"Route {r['option'] + 1} of {n}" if n > 1 else "Route", style=f"bold {INK}")
                summary.append(f"  {R.nice_duration(opt['duration'])} of travel" + (f", {R.nice_distance(opt['distance'], MILES)}" if opt.get("distance") else ""), style=GOLD)
                summary.append(f"  ({R.PROFILES[r['profile']]})", style=MUTED)
                notes = ([R.straight_note(r)] if R.straight_note(r) else []) + \
                        (["some linked places can't be next to each other at those times"] if r.get("loose") else [])
                if notes:
                    summary.append("   " + "; ".join(notes), style=FAINT)
            opts.append(Option(summary, disabled=True))
        for st in stops:
            it = st["item"]
            row = Text()
            row.append(f" {R.stop_label(st['n'])} ", style=f"bold #1a1206 on {GOLD}")
            extra = [(R.when(it["meta"]["event"]), GOLD)]
            if r and r.get("options"):
                extra += [(self.leg_text(st.get("leg")), MUTED)] if st.get("leg") else []
                extra += [("probably late", BAD)] if st.get("late") else []
            elif st.get("from") is not None:
                extra.append((f"{R.nice_distance(st['from'], MILES)} from {st['n'] - 1}", MUTED))
            row.append_text(item_row(it, col_name=name_of(it), wx=self.wx_chip(it), skip_event=True, extra=extra))
            opts.append(Option(row, id=it["id"]))
        if r and r.get("options") and R.placed(r.get("base")) and r.get("legs"):
            back = Text("  ⌂ ", style=f"bold {GOLD}")
            back.append(f"Back to {R.place_label(r['base'])}", style=MUTED)
            back.append(f"   {self.leg_text(r['legs'][-1])}", style=MUTED)
            opts.append(Option(back, disabled=True))
        if not plan["stops"]:
            msg = ("Turn on Events with c too, so items have a day to be on the map." if col and "event" not in col["plugins"]
                   else "Nothing with a place on this day. Give an event one with e, or add one with ~ and its name.")
            opts.append(Option(Text("   " + msg, style=FAINT), disabled=True))
        if plan["unplaced"]:
            opts.append(Option(header("Not found yet", len(plan["unplaced"]), "e to change the place, or pin it on the website"), disabled=True))
            for it in plan["unplaced"]:
                opts.append(Option(item_row(it, col_name=name_of(it), wx=self.wx_chip(it), skip_event=True), id=it["id"]))
        if plan["elsewhere"]:
            opts.append(Option(header("No place", len(plan["elsewhere"])), disabled=True))
            for it in plan["elsewhere"]:
                opts.append(Option(item_row(it, col_name=name_of(it), wx=self.wx_chip(it), skip_event=True, extra=[(R.when(it["meta"]["event"]), GOLD)]), id=it["id"]))

    def draw_map(self, shown: list[dict] | None = None, sel: str | None = None) -> None:
        """The day's stops on a map drawn in characters, in the route's order when
        there is one, from the base and back. The highlighted stop is centred."""
        _, col, _ = self.current()
        if shown is None:
            shown = [it for it in self.state["items"] if (not col or it["collection"] == col["id"]) and self.matches(it)]
        stops = self.route_stops(R.day_stops(shown, self.day), col)
        base = R.base_for((col or {}).get("bases"), self.day) if self.route_on else None
        geo = self.query_one("#geo", Static)
        if not stops:
            geo.update("")
            return
        width = max(min(self.query_one("#pane").size.width - 6, 110), 30) if self.query_one("#pane").size.width else 60
        m = R.text_map(stops, sel, width, 13, base)
        out = Text("┌" + "─" * width + "┐\n", style=LINE)
        for r, row in enumerate(m["cells"]):
            out.append("│", style=LINE)
            for c, ch in enumerate(row):
                hit = m["marks"].get((r, c))
                out.append(ch, style=(f"bold {INK} on {LINE}" if hit == "base" else f"bold #1a1206 on {BAD}" if hit == sel else f"bold #1a1206 on {GOLD}") if hit else GOLD_DIM)
            out.append("│\n", style=LINE)
        scale = 10 * m["metres"]
        foot = f"└{'─' * 2}┤{'─' * 8}├ {R.nice_distance(scale, MILES)} "
        out.append(foot + "─" * max(width + 1 - len(foot), 0) + "┘", style=LINE)
        st = next((x for x in stops if x["item"]["id"] == sel), None)
        if st:
            loc = st["item"]["meta"]["location"]
            out.append(f"\n {R.stop_label(st['n'])} ", style=f"bold #1a1206 on {BAD}")
            out.append(f" {st['item']['title']}   ", style=f"bold {INK}")
            out.append(R.place_label(loc), style=PLACE)
            out.append(f"   {loc['lat']:.5f}, {loc['lng']:.5f}", style=MUTED)
        geo.update(out)

    def action_route(self) -> None:
        if self.current()[2] != "location":
            return
        self.route_on, self.option = not self.route_on, 0
        self.render_items()

    def action_route_mode(self) -> None:
        if self.current()[2] != "location" or not self.route_on:
            return
        ps = list(R.PROFILES)
        self.profile, self.option = ps[(ps.index(self.profile) + 1) % len(ps)], 0
        self.render_items()

    def action_route_option(self, step: int) -> None:
        n = len((self.route or {}).get("options") or [])
        if self.current()[2] != "location" or not self.route_on or n < 2:
            return
        self.option = (self.option + step) % n
        self.render_items()

    def action_base(self) -> None:
        """b: set the base for the day shown, or change the one it has (a home base stays, and a new one is made for the day)."""
        _, col, tab = self.current()
        if tab != "location" or not col:
            return
        if not writable(col):
            self.app.notify("You can view this collection but not change it.", timeout=3)
            return
        bases = col.get("bases") or []
        cur = R.base_for(bases, self.day)
        editing = cur if cur and not R.is_home(cur) else None

        async def done(out: dict | None) -> None:
            if not out:
                return
            keep = [b for b in bases if b is not editing]
            new = keep if out.get("remove") else keep + [out["base"]]
            try:
                saved = await self.fetch(site.set_bases, col["id"], new)
            except Failed:
                return
            col["bases"] = saved.get("bases") or []
            self.render_items()

        self.app.push_screen(BaseDialog(self.day, editing), callback=lambda out: self.run_worker(done(out)))

    def action_open_place(self) -> None:
        it = self.selected()
        loc = (it or {}).get("meta", {}).get("location") or {}
        if R.placed(loc):
            open_in_browser(self.app, R.osm_link(loc))

    # ── moving around ──────────────────────────────────────────────────
    def on_option_list_option_highlighted(self, e: OptionList.OptionHighlighted) -> None:
        if e.option_list.id == "nav" and e.option.id and e.option.id != "new" and e.option.id != self.view:
            self.view, self.q = e.option.id, ""
            self.query_one("#search", Input).value = ""
            self.query_one("#search").set_class(False, "on")
            self.render_items()
        elif e.option_list.id == "items" and self.current()[2] == "location":
            self.draw_map(sel=e.option.id)

    def on_option_list_option_selected(self, e: OptionList.OptionSelected) -> None:
        if e.option_list.id == "nav":
            if e.option.id == "new":
                self.action_new_collection()
            else:
                self.query_one("#items").focus()
        elif e.option.id:
            self.action_edit()

    def selected(self) -> dict | None:
        lst = self.query_one("#items", ItemList)
        o = lst.highlighted_option
        return self.item(o.id) if o and o.id else None

    def can_edit(self, it: dict) -> bool:
        if writable(self.col(it["collection"])):
            return True
        self.app.notify("You can view this collection but not change it.", timeout=3)
        return False

    def action_next_view(self) -> None:
        kind, col, tab = self.current()
        if kind != "col":
            return
        tabs = self.view_tabs(col)
        if len(tabs) < 2:
            return
        nxt = tabs[(tabs.index(tab) + 1) % len(tabs)]
        self.tabs[col["id"]] = nxt
        self.render_items()
        if col["role"] == "owner":
            self.run_worker(self.remember_view(col, nxt))

    async def remember_view(self, col: dict, view: str) -> None:
        try:
            await fetch(self.app, site.update_collection, col["id"], {"view": view})
            col["view"] = view
        except Failed:
            pass

    def action_show_done(self) -> None:
        self.show_done = not self.show_done
        self.render_items()

    def action_day(self, step: int) -> None:
        if self.current()[2] not in ("event", "location"):
            return
        self.day, self.option = R.add_days(step, self.day), 0
        self.month = self.day[:7]
        self.render_items()

    def action_month(self, step: int) -> None:
        if self.current()[2] != "event":
            return
        y, m = (int(x) for x in self.month.split("-"))
        m += step
        y, m = y + (m - 1) // 12, (m - 1) % 12 + 1
        self.month = f"{y:04d}-{m:02d}"
        self.day = f"{self.month}-01"
        self.render_items()

    def action_go_today(self) -> None:
        self.day, self.month, self.option = R.today(), R.today()[:7], 0
        self.render_items()

    def action_compose(self) -> None:
        self.query_one("#add", Input).focus()

    def action_search(self) -> None:
        s = self.query_one("#search", Input)
        s.set_class(True, "on")
        s.focus()

    def leave_field(self) -> bool:
        f = self.focused
        if isinstance(f, Input) and f.id == "search":
            f.value, self.q = "", ""
            f.set_class(False, "on")
            self.render_items()
        self.query_one("#items").focus()
        return True

    def action_back(self) -> None:
        if isinstance(self.focused, (Input, TextArea)):
            self.leave_field()
            return
        super().action_back()

    def on_input_changed(self, e: Input.Changed) -> None:
        if e.input.id == "search":
            self.q = e.value.strip()
            self.render_items()
        elif e.input.id == "add":
            self.query_one("#preview", Static).update(self.preview(e.value))

    def preview(self, text: str) -> Text:
        if not text.strip():
            return Text("")
        _, f = R.parse_quick(text)
        t = Text()
        if f.get("date") or f.get("time"):
            t.append(f"◷ {R.nice_day(f.get('date') or R.today())}" + (f" {R.nice_time(f['time'])}" if f.get("time") else "") + "   ", style=GOLD)
        if f.get("priority"):
            t.append(f"{R.PRIORITY[f['priority']]} priority   ", style=PRI[f["priority"]])
        if f.get("collection"):
            t.append(f"+{f['collection']}   ", style=COL)
        for g in f.get("tags", []):
            t.append(f"#{g}   ", style=TAG)
        if f.get("place"):
            t.append(f"⌖ {f['place']}   ", style=PLACE)
        return t

    # ── changing things ────────────────────────────────────────────────
    @attempt
    async def on_input_submitted(self, e: Input.Submitted) -> None:
        if e.input.id == "search":
            self.query_one("#items").focus()
            return
        if e.input.id != "add" or not e.value.strip():
            return
        text = e.value.strip()
        title, quick = R.parse_quick(text)
        if not title:
            self.app.notify("Give the item a name before the tags.", severity="warning")
            return
        kind, cur, tab = self.current()
        target = cur or (self.state["collections"][0] if self.state["collections"] else None)
        if quick.get("collection"):
            want = quick["collection"].lower()
            target = next((c for c in self.state["collections"] if writable(c) and c["name"].lower() == want), None)
            if not target:
                self.app.notify(f"There's no collection called “{quick['collection']}” you can add to.", severity="warning")
                return
        if not writable(target):
            self.app.notify("You can view this collection but not add to it.", severity="warning")
            return
        dated = kind != "col" or (target is cur and tab in ("event", "location"))
        day = self.day if (kind == "calendar" or tab in ("event", "location")) else None
        meta = R.fresh_meta(target["plugins"], quick, dated_view=dated, day=day)
        e.input.value = ""
        try:
            it = await self.fetch(site.add_item, {"title": title, "collection": target["id"], "tags": quick.get("tags", []), "meta": meta})
        except Failed:
            e.input.value = text
            raise
        self.state["items"].append(it)
        self.render_all()
        self.render_items(keep=it["id"])
        self.app.notify(f"Added “{title}”" + ("" if target is cur else f" to {target['name']}"), timeout=2)

    @attempt
    async def patch(self, it: dict, changes: dict) -> None:
        self.put(await self.fetch(site.update_item, it["id"], changes))
        self.render_all()

    async def set_meta(self, it: dict, pid: str, value) -> None:
        await self.patch(it, {"meta": {pid: value}})

    async def action_toggle(self) -> None:
        it = self.selected()
        if not it or not self.can_edit(it):
            return
        ck = it["meta"].get("checklist")
        if not ck:
            if "checklist" not in (self.col(it["collection"]) or {}).get("plugins", []):
                return
            ck = {"done": False, "priority": 0}
        await self.set_meta(it, "checklist", {"done": not ck.get("done"), "priority": ck.get("priority", 0)})
        if not ck.get("done"):
            self.app.notify(f"Done: {it['title']}", timeout=2)

    async def action_priority(self, p: int) -> None:
        it = self.selected()
        if it and it["meta"].get("checklist") and self.can_edit(it):
            await self.set_meta(it, "checklist", {**it["meta"]["checklist"], "priority": p})

    async def action_date_today(self) -> None:
        it = self.selected()
        if not it or not self.can_edit(it):
            return
        tm = R.time_of((it["meta"].get("event") or {}).get("start"))
        await self.set_meta(it, "event", {"start": R.today() + (f"T{tm}" if tm else ""), "end": None})

    async def action_move(self, how: str) -> None:
        kind, col, tab = self.current()
        it = self.selected()
        if tab != "list" or not it or self.q or not self.can_edit(it):
            return
        scope = [x for x in self.state["items"] if x["collection"] == col["id"]]
        new = R.list_move(it, scope, how)
        if new:
            await self.set_meta(it, "list", new)

    @attempt
    async def action_delete(self) -> None:
        it = self.selected()
        if not it or not self.can_edit(it):
            return
        lst = self.query_one("#items", ItemList)
        ids = [o.id for o in lst.options if o.id]
        i = ids.index(it["id"])
        nxt = ids[i + 1] if i + 1 < len(ids) else ids[i - 1] if i else None
        await self.fetch(site.delete_item, it["id"])
        self.state["items"] = [x for x in self.state["items"] if x["id"] != it["id"]]
        self.undo = ("item", it["id"])
        self.render_all()
        self.render_items(keep=nxt)
        self.app.notify(f"Deleted “{it['title']}”. Press u to undo.", timeout=5)

    @attempt
    async def action_undo(self) -> None:
        if not self.undo:
            return
        kind, xid = self.undo
        self.undo = None
        if kind == "item":
            self.put(await self.fetch(site.update_item, xid, {"deleted": False}))
            self.render_all()
            self.render_items(keep=xid)
        else:
            await self.fetch(site.update_collection, xid, {"deleted": False})
            self.view = "c:" + xid
            await self.action_refresh()
        self.app.notify("Put back.", timeout=2)

    def action_edit(self) -> None:
        it = self.selected()
        if not it:
            return
        col = self.col(it["collection"])
        wx = self.wx_line(it) if "weather" in (col or {}).get("plugins", []) or "weather" in it["meta"] else ""
        self.app.push_screen(ItemDialog(it, self.state["collections"], col, wx), lambda out: self.edited(it, out))

    @attempt
    async def edited(self, it: dict, out: dict | None) -> None:
        if not out:
            return
        if out.get("deleted"):
            await self.action_delete()
            return
        await self.patch(it, out)
        self.render_items(keep=it["id"])

    def action_collection(self) -> None:
        kind, col, _ = self.current()
        if kind != "col":
            self.app.notify("Pick a collection on the left first.", timeout=2)
            return
        self.app.push_screen(CollectionDialog(self, col), self.collection_closed)

    def action_new_collection(self) -> None:
        self.app.push_screen(CollectionDialog(self, None), self.collection_closed)

    async def collection_closed(self, out: str | None) -> None:
        if not out:
            return
        if out in ("deleted", "left"):
            _, col, _ = self.current()
            if out == "deleted" and col:
                self.undo = ("collection", col["id"])
                self.app.notify(f"Deleted “{col['name']}”. Press u to undo.", timeout=5)
            elif col:
                self.app.notify(f"You left “{col['name']}”.", timeout=3)
            self.view = "today"
        else:
            self.view = "c:" + out
        await self.action_refresh()
