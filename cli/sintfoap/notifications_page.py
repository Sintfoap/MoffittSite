"""Notifications in the terminal: the same settings as /notifications/.

A terminal can't receive push notifications, so turning them on happens in a
browser or on a phone (press w). Here you pick what's sent, see every browser
it goes to, remove ones you don't want, and send a test."""
from __future__ import annotations

import time

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import Button, Checkbox, Footer, Select, Static

from . import site
from .look import BAD, FAINT, INK, MUTED, Page, attempt, plural

LEADS = [0, 5, 10, 15, 30, 60, 1440]   # minutes; LEADS in src/notify.js
CHAT = [("chat_dms", "Direct messages"), ("chat_mentions", "When someone @mentions you"),
        ("chat_rooms", "Every message in rooms you've joined (not while you have the room open)")]


def lead_label(m: int) -> str:
    if m == 0:
        return "when they start"
    if m >= 1440:
        return "a day before"
    if m >= 60:
        return f"{m // 60} hour{'s' if m > 60 else ''} before"
    return f"{m} minutes before"


def day(t: int | None) -> str:
    return time.strftime("%b %-d, %Y", time.localtime(t)) if t else ""


class NotificationsPage(Page):
    WEB_PATH = "/notifications/"
    DEFAULT_CSS = f"""
    NotificationsPage #body {{ padding: 0 4 1 4; }}
    NotificationsPage #cards {{ max-width: 90; height: auto; }}
    NotificationsPage #unconfigured {{ display: none; border: round {BAD}; color: {BAD}; padding: 0 1; margin-bottom: 1; }}
    NotificationsPage #unconfigured.on {{ display: block; }}
    NotificationsPage #chat-prefs, NotificationsPage #drift-prefs {{ height: auto; margin-bottom: 1; }}
    NotificationsPage .group {{ color: {FAINT}; }}
    NotificationsPage Checkbox {{ height: 1; width: auto; }}
    NotificationsPage .lead {{ height: auto; margin-left: 4; }}
    NotificationsPage .lead Static {{ width: auto; padding: 1 1 0 0; color: {MUTED}; }}
    NotificationsPage #lead {{ width: 30; }}
    NotificationsPage #devices {{ height: auto; }}
    NotificationsPage .device {{ height: auto; margin-bottom: 1; }}
    NotificationsPage .device Static {{ width: 1fr; }}
    NotificationsPage #test {{ margin-top: 1; }}
    """
    BINDINGS = [Binding("r", "refresh", "Refresh"), Binding("t", "test", "Send a test")]

    def __init__(self):
        super().__init__()
        self.data: dict | None = None

    def compose(self) -> ComposeResult:
        yield from self.top()
        with VerticalScroll(id="body"):
            with Vertical(id="cards"):
                yield Static("N O T I F I C A T I O N S", classes="kicker")
                yield Static(Text("Alerts for Chat and Drift", style=f"bold {INK}"), classes="h1")
                yield Static(Text("A terminal can't get push notifications. Turn them on in each browser or phone you want them on, "
                                  "at /notifications/ on the website (press w). What you pick here goes to all of them.", style=MUTED), classes="sub")
                yield Static("Push notifications aren't set up on this site yet. The site's admin needs to add its keys (see the README).",
                             id="unconfigured")
                with Vertical(classes="card", id="prefs"):
                    yield Static("What to send", classes="card-title")
                    with Vertical(id="chat-prefs"):
                        yield Static("CHAT", classes="group")
                        for key, label in CHAT:
                            yield Checkbox(label, id=key)
                    with Vertical(id="drift-prefs"):
                        yield Static("DRIFT", classes="group")
                        yield Checkbox("Reminders for dated items (all-day ones at 8am; done ones don't remind)", id="drift_events")
                        with Horizontal(classes="lead"):
                            yield Static("Timed items:")
                            # The site's own list replaces this once it's loaded.
                            yield Select([(lead_label(m), m) for m in LEADS], value=15, allow_blank=False, id="lead")
                    yield Static(Text("You don't have Chat or Drift, so there's nothing to notify you about yet.", style=FAINT), id="no-apps")
                with Vertical(classes="card", id="where"):
                    yield Static("Where they go", classes="card-title")
                    yield Vertical(id="devices")
                    yield Button("Send a test", id="test", classes="quiet")
        yield Footer()

    async def on_mount(self) -> None:
        await self.action_refresh()

    @attempt
    async def action_refresh(self) -> None:
        await self.show(await self.fetch(site.notify_state))

    async def show(self, data: dict) -> None:
        self.data = data
        p, apps = data["prefs"], data["apps"]
        self.query_one("#unconfigured").set_class(not data["configured"], "on")
        self.query_one("#chat-prefs").display = apps["chat"]
        self.query_one("#drift-prefs").display = apps["drift"]
        self.query_one("#no-apps").display = not (apps["chat"] or apps["drift"])
        for key in ("chat_dms", "chat_mentions", "chat_rooms", "drift_events"):
            box = self.query_one(f"#{key}", Checkbox)
            if box.value != p[key]:
                with box.prevent(Checkbox.Changed):
                    box.value = p[key]
        lead = self.query_one("#lead", Select)
        with lead.prevent(Select.Changed):
            lead.set_options([(lead_label(m), m) for m in data["leads"]])
            lead.value = p["drift_lead"]
        lead.disabled = not p["drift_events"]

        devices = self.query_one("#devices", Vertical)
        await devices.remove_children()
        rows = []
        for d in data["devices"]:
            when = f"Added {day(d['created_at'])}" + (f" · last delivered {day(d['last_ok'])}" if d.get("last_ok") else "")
            rows.append(Horizontal(Static(Text.assemble((d["label"], f"bold {INK}"), ("\n" + when, FAINT))),
                                   Button("Remove", id=f"rm-{d['id']}", classes="danger"), classes="device"))
        if not rows:
            rows.append(Static(Text("No browsers yet. Turn notifications on at /notifications/ in each browser or phone you want them on "
                                    "(press w to open it here).", style=FAINT)))
        await devices.mount_all(rows)
        self.query_one("#where").border_title = plural(len(data["devices"]), "browser")
        self.query_one("#test", Button).display = bool(data["configured"] and data["devices"])

    async def on_checkbox_changed(self, e: Checkbox.Changed) -> None:
        if not self.data or self.data["prefs"].get(e.checkbox.id) == e.value:
            return
        await self.save(e.checkbox.id, e.value)

    async def on_select_changed(self, e: Select.Changed) -> None:
        if e.select.id != "lead" or not self.data or e.value == self.data["prefs"]["drift_lead"] or e.value is Select.BLANK:
            return
        await self.save("drift_lead", e.value)

    @attempt
    async def save(self, key: str, value) -> None:
        try:
            data = await self.fetch(lambda: site.save_notify_prefs(**{key: value}))
        except Exception:
            await self.show(self.data)   # put it back as it was
            raise
        await self.show(data)
        self.app.notify("Saved.", timeout=2)

    async def on_button_pressed(self, e: Button.Pressed) -> None:
        if e.button.id == "test":
            await self.action_test()
        elif e.button.id and e.button.id.startswith("rm-"):
            await self.remove(e.button.id[3:])

    @attempt
    async def remove(self, device_id: str) -> None:
        name = next((d["label"] for d in self.data["devices"] if d["id"] == device_id), "That browser")
        await self.show(await self.fetch(site.remove_device, device_id))
        self.app.notify(f"{name} won't get notifications any more.", timeout=3)

    @attempt
    async def action_test(self) -> None:
        if not self.data or not self.data["devices"]:
            return
        data = await self.fetch(site.send_test)
        await self.show(data)
        if data.get("sent"):
            self.app.notify(f"Sent a test to {plural(data['sent'], 'browser')}.", timeout=3)
        else:
            self.app.notify("None of your browsers took the test notification.", severity="error", timeout=5)
