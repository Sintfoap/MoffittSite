"""Admin in the terminal: which apps each account can use, as on /admin.

Each account folds open to its switches, grouped as the site's menu groups
them (Apps, Kitchen, Account), with a part of an app (Chat connections) under
it. Space flips a switch; nothing is sent until ctrl+s saves that account's
switches all at once, so several can change together. There's a switch for
every app in the site's app list (APPS in src/auth.js), so a new app shows up
here by itself, off for everyone. The rest of /admin (passwords, two-factor,
disabling and deleting accounts) is on the website: press w to open it."""
from __future__ import annotations

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import Button, Checkbox, Collapsible, Footer, Static

from . import site
from .look import BAD, FAINT, GOLD, INK, MUTED, Page, attempt, plural

GROUPS = [("site", "APPS"), ("kitchen", "KITCHEN"), ("account", "ACCOUNT")]


def grouped(apps: list[dict]) -> list[tuple[str, list[dict]]]:
    """The apps under the menu's headings, each part of an app right after it."""
    top = [a for a in apps if not a.get("parent")]
    out = []
    for g, title in GROUPS:
        here = [x for a in top if a.get("group", "site") == g for x in [a, *[c for c in apps if c.get("parent") == a["id"]]]]
        if here:
            out.append((title, here))
    # A site too old to send groups: everything under Apps.
    return out or [("APPS", apps)]


class AdminPage(Page):
    WEB_PATH = "/admin"
    DEFAULT_CSS = f"""
    AdminPage #body {{ padding: 0 4 1 4; }}
    AdminPage #people {{ height: auto; }}
    AdminPage Collapsible {{ height: auto; padding: 0; margin: 0 0 1 0; border-top: none; background: transparent; }}
    AdminPage Collapsible > Contents {{ padding: 0 0 0 3; height: auto; }}
    AdminPage .group {{ height: auto; margin-bottom: 1; }}
    AdminPage .legend {{ color: {FAINT}; width: 10; padding-top: 0; }}
    AdminPage .switches {{ height: auto; width: 1fr; layout: grid; grid-size: 3; grid-gutter: 0 2; }}
    AdminPage .switches Checkbox {{ width: auto; height: 1; }}
    AdminPage .switches Checkbox.part {{ padding-left: 2; }}
    AdminPage .save-row {{ height: auto; }}
    AdminPage .save-row Button {{ margin-right: 2; }}
    AdminPage .unsaved {{ color: {GOLD}; padding: 1 0 0 1; }}
    """
    BINDINGS = [
        Binding("ctrl+s", "save", "Save this account", priority=True),
        Binding("a", "all(True)", "All on"),
        Binding("x", "all(False)", "All off"),
        Binding("e", "expand(True)", "Expand all"),
        Binding("c", "expand(False)", "Collapse all"),
        Binding("r", "refresh", "Refresh"),
    ]

    def __init__(self):
        super().__init__()
        self.data: dict | None = None
        self.boxes: dict[str, tuple[str, str]] = {}   # checkbox id → (user id, app id)
        self.opened: set[str] = set()                 # user ids whose fold is open, kept across a refresh

    def compose(self) -> ComposeResult:
        yield from self.top()
        with VerticalScroll(id="body"):
            yield Static("A D M I N", classes="kicker")
            yield Static(Text("Who can use which app", style=f"bold {INK}"), classes="h1")
            yield Static(Text("Enter opens an account. Space flips a switch, a turns them all on and x all off; ctrl+s saves "
                              "that account's changes together. New apps start off for everyone. Passwords, two-factor and "
                              "disabling or deleting accounts are on the website: press w.", style=MUTED), classes="sub")
            yield Static(id="feedback-line", classes="sub")
            yield Vertical(id="people", classes="card")
        yield Footer()

    async def on_mount(self) -> None:
        await self.action_refresh()

    @attempt
    async def action_refresh(self) -> None:
        await self.show(await self.fetch(site.admin_access))

    def title_for(self, u: dict, on: int, unsaved: bool = False) -> str:
        bits = [u["display_name"] if u["display_name"].lower() == u["username"] else f"{u['display_name']} ({u['username']})",
                f"{on} of {len(self.data['apps'])} apps"]
        if u.get("you"):
            bits.append("you")
        if u.get("disabled"):
            bits.append("disabled")
        if unsaved:
            bits.append("unsaved")
        return "   ".join(bits)

    async def show(self, data: dict) -> None:
        self.data = data
        fb = data.get("feedback")
        line = self.query_one("#feedback-line", Static)
        line.display = bool(fb)
        if fb:
            line.update(Text.assemble(("Feedback inbox  ", f"bold {GOLD}"),
                                      (f"{plural(fb['total'], 'note')}, {fb['unread']} unread, {fb['open']} still open" if fb["total"] else "nothing sent yet", INK),
                                      ("   g k opens it", FAINT)))
        focused = self.focused.id if isinstance(self.focused, Checkbox) else None
        people = self.query_one("#people", Vertical)
        await people.remove_children()
        self.boxes = {}
        folds = []
        groups = grouped(data["apps"])
        for i, u in enumerate(data["users"]):
            rows = []
            for title, apps in groups:
                boxes = []
                for app in apps:
                    bid = f"u{i}-{app['id']}"
                    self.boxes[bid] = (u["id"], app["id"])
                    # Your own admin switch stays on, as on the website.
                    boxes.append(Checkbox(app["name"], app["id"] in u["apps"], id=bid, classes="part" if app.get("parent") else "",
                                          disabled=bool(u.get("you")) and app["id"] == "admin"))
                rows.append(Horizontal(Static(Text(title, style=FAINT), classes="legend"), Vertical(*boxes, classes="switches"), classes="group"))
            rows.append(Horizontal(Button("Save", id=f"save-{i}"), Button("All on", id=f"on-{i}", classes="quiet"),
                                   Button("All off", id=f"off-{i}", classes="quiet"), Static("", id=f"unsaved-{i}", classes="unsaved"),
                                   classes="save-row"))
            folds.append(Collapsible(*rows, title=self.title_for(u, len(u["apps"])), collapsed=u["id"] not in self.opened, id=f"person-{i}"))
        await people.mount_all(folds)
        people.border_title = plural(len(data["users"]), "account")
        target = self.query(f"#{focused}").first() if focused and self.query(f"#{focused}") else None
        if target:
            self.call_after_refresh(target.focus)
        elif folds:
            self.call_after_refresh(folds[0].query_one("CollapsibleTitle").focus)

    # ── which account, and its switches ───────────────────────────────────

    def person_index(self) -> int | None:
        """The account the focus is in: its fold's title, a switch or a button inside it."""
        node = self.focused
        while node is not None and not (isinstance(node, Collapsible) and (node.id or "").startswith("person-")):
            node = node.parent
        return int(node.id.split("-")[1]) if node is not None else None

    def switches(self, i: int) -> list[Checkbox]:
        return [b for b in self.query(Checkbox) if (b.id or "").startswith(f"u{i}-")]

    def wanted(self, i: int) -> list[str]:
        return [self.boxes[b.id][1] for b in self.switches(i) if b.value]

    def mark(self, i: int) -> None:
        u = self.data["users"][i]
        want = self.wanted(i)
        unsaved = set(want) != set(u["apps"])
        self.query_one(f"#person-{i}", Collapsible).title = self.title_for(u, len(want), unsaved)
        self.query_one(f"#unsaved-{i}", Static).update(Text("unsaved: ctrl+s saves", style=GOLD) if unsaved else "")

    def on_checkbox_changed(self, e: Checkbox.Changed) -> None:
        if e.checkbox.id in self.boxes and self.data:
            self.mark(int(e.checkbox.id.split("-")[0][1:]))

    def on_collapsible_expanded(self, e: Collapsible.Expanded) -> None:
        if self.data and (e.collapsible.id or "").startswith("person-"):
            self.opened.add(self.data["users"][int(e.collapsible.id.split("-")[1])]["id"])

    def on_collapsible_collapsed(self, e: Collapsible.Collapsed) -> None:
        if self.data and (e.collapsible.id or "").startswith("person-"):
            self.opened.discard(self.data["users"][int(e.collapsible.id.split("-")[1])]["id"])

    def action_all(self, on: bool) -> None:
        i = self.person_index()
        if i is None:
            return
        self.query_one(f"#person-{i}", Collapsible).collapsed = False
        for b in self.switches(i):
            if not b.disabled:
                b.value = on

    def action_expand(self, on: bool) -> None:
        for c in self.query(Collapsible):
            c.collapsed = not on

    async def on_button_pressed(self, e: Button.Pressed) -> None:
        kind, _, i = (e.button.id or "").partition("-")
        if not i.isdigit():
            return
        if kind == "save":
            await self.save(int(i))
        elif kind in ("on", "off"):
            e.button.focus()
            self.action_all(kind == "on")

    async def action_save(self) -> None:
        i = self.person_index()
        if i is not None:
            await self.save(i)

    @attempt
    async def save(self, i: int) -> None:
        u = self.data["users"][i]
        want = self.wanted(i)
        if set(want) == set(u["apps"]):
            self.app.notify(f"Nothing to save for {u['username']}.", timeout=2)
            return
        names = {a["id"]: a["name"] for a in self.data["apps"]}
        on = [names[a] for a in want if a not in u["apps"]]
        off = [names[a] for a in u["apps"] if a not in want]
        self.opened.add(u["id"])
        data = await self.fetch(site.set_access_all, u["id"], want)
        said = "; ".join(x for x in (f"on: {', '.join(on)}" if on else "", f"off: {', '.join(off)}" if off else "") if x)
        self.app.notify(f"Saved {u['username']}'s apps ({said}).", timeout=4)
        await self.show(data)
