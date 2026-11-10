"""Admin in the terminal: which apps each account can use, as on /admin.

There's a switch for every app in the site's app list (APPS in src/auth.js), so
a new app shows up here by itself, off for everyone. Under them is Recipe
box's label list (n adds one, e renames the highlighted one, x removes it),
the labels everyone picks from for their recipes. The rest of /admin
(passwords, two-factor, disabling and deleting accounts) is on the website:
press w to open it."""
from __future__ import annotations

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import Checkbox, Footer, OptionList, Static
from textual.widgets.option_list import Option

from . import site
from .look import BAD, FAINT, GOLD, INK, MUTED, Ask, Confirm, Page, attempt, plural


def split_label(text: str) -> tuple[str, str]:
    """"Season: Fall" → ("Season", "Fall"); no colon, no value."""
    key, _, value = text.partition(":")
    return key.strip(), value.strip()


class AdminPage(Page):
    WEB_PATH = "/admin"
    DEFAULT_CSS = f"""
    AdminPage #body {{ padding: 0 4 1 4; }}
    AdminPage #people {{ height: auto; }}
    AdminPage .person {{ height: auto; padding: 0 0 1 0; }}
    AdminPage .who {{ width: 30; }}
    AdminPage .switches {{ height: auto; width: 1fr; }}
    AdminPage .switches Checkbox {{ width: auto; height: 1; margin-right: 2; }}
    AdminPage #labels {{ height: auto; max-height: 16; }}
    """
    BINDINGS = [Binding("r", "refresh", "Refresh"), Binding("n", "add_label", "New label"),
                Binding("e", "rename_label", "Rename label"), Binding("x", "delete_label", "Remove label")]

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
            yield Static(Text("Recipe labels", style=f"bold {INK}"), classes="h1")
            yield Static(Text("The labels people tick on their recipes in Recipe box, like Season: Fall, to filter and sort by. "
                              "One list, so nobody ends up with Fall and Autumn. n adds one, e renames the highlighted one "
                              "(on every recipe), x removes it (from every recipe).", style=MUTED), classes="sub")
            yield OptionList(id="labels", classes="card")
        yield Footer()

    async def on_mount(self) -> None:
        await self.action_refresh()

    @attempt
    async def action_refresh(self) -> None:
        await self.show(await self.fetch(site.admin_access))
        self.show_labels(await self.fetch(site.recipe_labels))

    def show_labels(self, data: dict) -> None:
        self.labels = data["labels"]
        box = self.query_one("#labels", OptionList)
        at = box.highlighted
        box.clear_options()
        if not self.labels:
            box.add_option(Option(Text("No labels yet. Press n to add the first, like Season: Fall.", style=FAINT), disabled=True))
        for lb in self.labels:
            box.add_option(Option(Text.assemble((lb["key"], f"bold {GOLD}"), ("  " + lb["value"], INK),
                                                (f"   {plural(lb['recipes'], 'recipe')}", FAINT)), id=lb["id"]))
        box.border_title = plural(len(self.labels), "label")
        if self.labels:
            box.highlighted = min(at or 0, len(self.labels) - 1)

    def current_label(self) -> dict | None:
        box = self.query_one("#labels", OptionList)
        if box.highlighted is None or not getattr(self, "labels", None):
            return None
        return self.labels[box.highlighted] if box.highlighted < len(self.labels) else None

    def action_add_label(self) -> None:
        async def made(text: str | None) -> None:
            if text and text.strip():
                await self.label_call(site.add_recipe_label, *split_label(text))
        self.app.push_screen(Ask("New recipe label", "A name and a value, like Season: Fall (or just a name, like Favorite).", placeholder="Season: Fall", ok="Add"), made)

    def action_rename_label(self) -> None:
        lb = self.current_label()
        if not lb:
            return

        async def renamed(text: str | None) -> None:
            if text and text.strip():
                await self.label_call(site.rename_recipe_label, lb["id"], *split_label(text))
        now = f"{lb['key']}: {lb['value']}" if lb["value"] else lb["key"]
        self.app.push_screen(Ask("Rename label", "It changes on every recipe that has it.", value=now, ok="Rename"), renamed)

    def action_delete_label(self) -> None:
        lb = self.current_label()
        if not lb:
            return

        async def answer(yes: bool | None) -> None:
            if yes:
                await self.label_call(site.delete_recipe_label, lb["id"])
        name = f"{lb['key']}: {lb['value']}" if lb["value"] else lb["key"]
        self.app.push_screen(Confirm(f"Remove {name}?", f"It comes off the list and {plural(lb['recipes'], 'recipe')}.", yes="Remove", danger=True), answer)

    @attempt
    async def label_call(self, fn, *args) -> None:
        await self.fetch(fn, *args)
        self.show_labels(await self.fetch(site.recipe_labels))

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
