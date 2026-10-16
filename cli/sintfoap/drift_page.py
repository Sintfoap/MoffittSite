"""
Drift in the terminal: the same collections, views and quick-add as /todo/,
reading and writing through the site's API (src/drift.js).

Store plugins run only in the browser's sandbox, so here their data is kept
as it is and their views are a press of w away.
"""
from __future__ import annotations

import calendar
from datetime import date

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Checkbox, Footer, Input, Label, OptionList, Select, Static, TextArea
from textual.widgets.option_list import Option

from . import site
from . import drift_rules as R
from .look import BAD, FAINT, GOLD, GOLD_DIM, GOOD, INK, LINE, MUTED, PRI, Confirm, Failed, Page, attempt, fetch, plural

POLL_EVERY = 5      # seconds between "did anything change?" checks, like the web page
TAG, COL = "#8fb3d9", "#b79ad6"
STARTER = ["checklist", "event", "list", "graph"]


def writable(col: dict | None) -> bool:
    return bool(col) and col.get("role") != "view"


# ── drawing one item ───────────────────────────────────────────────────────

def item_row(it: dict, *, depth: int = 0, col_name: str | None = None, skip_event: bool = False,
             extra: list[tuple[str, str]] = (), links: list[str] = ()) -> Text:
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
    chips += list(extra)
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


def month_grid(month: str, sel: str, events: list[dict]) -> Text:
    first = date.fromisoformat(month + "-01")
    busy = {}
    for it in events:
        ev = it["meta"]["event"]
        d0, d1 = R.day_of(ev["start"]), R.day_of(ev.get("end") or ev["start"])
        for d in calendar.Calendar().itermonthdates(first.year, first.month):
            if d0 <= d.isoformat() <= d1:
                busy[d.isoformat()] = busy.get(d.isoformat(), 0) + 1
    t = Text(f"\n{first.strftime('%B %Y')}\n", style=f"bold {INK}")
    t.append(" Mo  Tu  We  Th  Fr  Sa  Su\n", style=MUTED)
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
        t.append("\n")
    t.append("[ ] day   { } month   g today", style=FAINT)
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

    def __init__(self, it: dict, cols: list[dict], col: dict | None):
        super().__init__()
        self.it, self.cols, self.col = it, cols, col
        self.ro = not writable(col)
        plugins = (col or {}).get("plugins", [])
        self.has_check = "checklist" in plugins or "checklist" in it["meta"]
        self.has_event = "event" in plugins or "event" in it["meta"]

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
        Binding("g", "screen.go_today", "Go to today", show=False),
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
    DriftPage Nav {{ height: 1fr; }}
    """
    BINDINGS = [
        Binding("r", "refresh", "Refresh"),
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
                yield Input(id="add", placeholder="Add an item   #tag  +collection  !1-3  ^date  @time")
                yield Static(id="preview")
                yield Input(id="search", placeholder="Search titles, notes and tags (esc to clear)")
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
                opts.append(Option(item_row(it, col_name=name_of(it), **kw), id=it["id"]))

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
                    opts.append(Option(item_row(it, col_name=name_of(it), skip_event=True,
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
                    opts.append(Option(item_row(it, depth=depth, col_name=name_of(it)), id=it["id"]))
        elif tab == "graph":
            titles = {it["id"]: it["title"] for it in scope}
            opts.append(Option(Text("\nLinks as a list. The network you can drag and zoom is in the browser: press w.", style=FAINT), disabled=True))
            linked = [it for it in shown if it["meta"].get("graph")]
            opts.append(Option(header("Items", len(linked) or ""), disabled=True))
            for it in linked:
                links = [titles[x] for x in it["meta"]["graph"].get("links", []) if x in titles]
                opts.append(Option(item_row(it, col_name=name_of(it), links=links), id=it["id"]))
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
        add.placeholder = "This collection is view-only for you" if ro else "Add an item   #tag  +collection  !1-3  ^date  @time"

        with self.prevent(OptionList.OptionHighlighted):
            lst.set_options(opts)
            ids = [o.id for o in opts]
            target = keep if keep and keep in ids else next((o.id for o in opts if o.id and not o.disabled), None)
            if target:
                lst.highlighted = ids.index(target)

    def calendar(self, opts: list, shown: list[dict], name_of) -> None:
        events = [it for it in shown if it["meta"].get("event")]
        opts.append(Option(month_grid(self.month, self.day, events), disabled=True))
        on = sorted([it for it in events if R.on_day(it["meta"]["event"], self.day)], key=R.by_start)
        later = sorted([it for it in events if self.day < R.day_of(it["meta"]["event"]["start"]) <= R.add_days(14, self.day)], key=R.by_start)
        opts.append(Option(header(R.nice_day(self.day), len(on) or ""), disabled=True))
        for it in on:
            opts.append(Option(item_row(it, col_name=name_of(it), skip_event=True, extra=[(R.when(it["meta"]["event"]), GOLD)]), id=it["id"]))
        if not on:
            opts.append(Option(Text("   Nothing on this day. Items you add now land here.", style=FAINT), disabled=True))
        if later:
            opts.append(Option(header("Next two weeks", len(later)), disabled=True))
            for it in later:
                opts.append(Option(item_row(it, col_name=name_of(it)), id=it["id"]))

    # ── moving around ──────────────────────────────────────────────────
    def on_option_list_option_highlighted(self, e: OptionList.OptionHighlighted) -> None:
        if e.option_list.id == "nav" and e.option.id and e.option.id != "new" and e.option.id != self.view:
            self.view, self.q = e.option.id, ""
            self.query_one("#search", Input).value = ""
            self.query_one("#search").set_class(False, "on")
            self.render_items()

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
        if self.current()[2] != "event":
            return
        self.day = R.add_days(step, self.day)
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
        self.day, self.month = R.today(), R.today()[:7]
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
        dated = kind != "col" or (target is cur and tab == "event")
        day = self.day if (kind == "calendar" or tab == "event") else None
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
        self.app.push_screen(ItemDialog(it, self.state["collections"], self.col(it["collection"])), lambda out: self.edited(it, out))

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
