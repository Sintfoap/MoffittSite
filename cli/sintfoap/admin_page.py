"""Admin in the terminal: which apps each account can use, as on /admin.

There's a switch for every app in the site's app list (APPS in src/auth.js), so
a new app shows up here by itself, off for everyone. The rest of /admin
(passwords, two-factor, disabling and deleting accounts) is on the website:
press w to open it."""
from __future__ import annotations

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import Checkbox, Footer, Static

from . import site
from .look import BAD, FAINT, INK, MUTED, Page, attempt, plural


class AdminPage(Page):
    WEB_PATH = "/admin"
    DEFAULT_CSS = f"""
    AdminPage #body {{ padding: 0 4 1 4; }}
    AdminPage #people {{ height: auto; }}
    AdminPage .person {{ height: auto; padding: 0 0 1 0; }}
    AdminPage .who {{ width: 30; }}
    AdminPage .switches {{ height: auto; width: 1fr; }}
    AdminPage .switches Checkbox {{ width: auto; height: 1; margin-right: 2; }}
    """
    BINDINGS = [Binding("r", "refresh", "Refresh")]

    def __init__(self):
        super().__init__()
        self.data: dict | None = None
        self.boxes: dict[str, tuple[str, str]] = {}   # checkbox id → (user id, app id)

    def compose(self) -> ComposeResult:
        yield from self.top()
        with VerticalScroll(id="body"):
            yield Static("A D M I N", classes="kicker")
            yield Static(Text("Who can use which app", style=f"bold {INK}"), classes="h1")
            yield Static(Text("Space turns an app on or off for that account. New apps start off for everyone. "
                              "Passwords, two-factor and disabling or deleting accounts are on the website: press w.", style=MUTED), classes="sub")
            yield Vertical(id="people", classes="card")
        yield Footer()

    async def on_mount(self) -> None:
        await self.action_refresh()

    @attempt
    async def action_refresh(self) -> None:
        await self.show(await self.fetch(site.admin_access))

    async def show(self, data: dict) -> None:
        self.data = data
        names = {a["id"]: a["name"] for a in data["apps"]}
        focused = self.focused.id if isinstance(self.focused, Checkbox) else None
        people = self.query_one("#people", Vertical)
        await people.remove_children()
        self.boxes = {}
        rows = []
        for i, u in enumerate(data["users"]):
            who = Text.assemble((u["display_name"], f"bold {INK}"), ("\n" + u["username"], MUTED))
            if u.get("you"):
                who.append("  you", style=FAINT)
            if u.get("disabled"):
                who.append("  disabled", style=BAD)
            boxes = []
            for app in data["apps"]:
                bid = f"u{i}-{app['id']}"
                self.boxes[bid] = (u["id"], app["id"])
                # Your own admin switch stays on, as on the website.
                boxes.append(Checkbox(names[app["id"]], app["id"] in u["apps"], id=bid,
                                      disabled=bool(u.get("you")) and app["id"] == "admin"))
            rows.append(Horizontal(Static(who, classes="who"), Horizontal(*boxes, classes="switches"), classes="person"))
        await people.mount_all(rows)
        people.border_title = plural(len(data["users"]), "account")
        target = self.query(f"#{focused}").first() if focused and self.query(f"#{focused}") else None
        boxes = [b for b in self.query(Checkbox) if not b.disabled]
        if target or boxes:
            self.call_after_refresh((target or boxes[0]).focus)

    async def on_checkbox_changed(self, e: Checkbox.Changed) -> None:
        if e.checkbox.id not in self.boxes or not self.data:
            return
        user_id, app_id = self.boxes[e.checkbox.id]
        user = next(u for u in self.data["users"] if u["id"] == user_id)
        if (app_id in user["apps"]) == e.value:
            return   # the page itself set it
        await self.set_access(user, app_id, e.value, e.checkbox)

    @attempt
    async def set_access(self, user: dict, app_id: str, on: bool, box: Checkbox) -> None:
        try:
            data = await self.fetch(site.set_access, user["id"], app_id, on)
        except Exception:
            box.value = app_id in user["apps"]   # put it back as it was
            raise
        name = next(a["name"] for a in data["apps"] if a["id"] == app_id)
        self.app.notify(f"{name} is {'on' if on else 'off'} for {user['username']}.", timeout=3)
        await self.show(data)
