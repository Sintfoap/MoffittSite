"""What every terminal page shares: the site's colours, the top bar, and talking to the site without freezing the UI."""
from __future__ import annotations

import asyncio
import functools
import webbrowser

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.screen import ModalScreen, Screen
from textual.widgets import Button, Input, Label, Static, TextArea
from textual.containers import Vertical

from . import site

# The site's palette (src/pages.js), converted from oklch.
BG, PANEL, FIELD = "#0b0f0a", "#121a12", "#0e140e"
GOLD, GOLD_DIM = "#d6ae5e", "#a08850"
INK, MUTED, FAINT = "#f4efe6", "#c6bcab", "#6f6857"
LINE = "#4a4430"
BAD, GOOD = "#e47a62", "#7fcf98"
# Drift's priority colours (none, low, medium, high).
PRI = ["", "#7fa6d9", "#e0b25a", "#e47a62"]

CSS = f"""
Screen {{ background: {BG}; color: {INK}; }}
#top {{ height: 3; padding: 1 2 0 2; }}
#crest {{ width: auto; color: {GOLD}; text-style: bold; }}
#who {{ width: 1fr; content-align: right middle; color: {MUTED}; }}
.kicker {{ color: {GOLD}; text-style: bold; }}
.h1 {{ color: {INK}; text-style: bold; padding: 1 0 0 0; }}
.sub {{ color: {MUTED}; padding-bottom: 1; }}
.hint {{ color: {GOLD_DIM}; }}
.card {{ background: {PANEL}; border: round {LINE}; padding: 1 2; height: auto; margin-bottom: 1; }}
.card:focus, .card:focus-within {{ border: round {GOLD}; }}
.card-title {{ color: {INK}; text-style: bold; margin-bottom: 1; }}
Input {{ background: {FIELD}; border: round {LINE}; color: {INK}; }}
Input:focus {{ border: round {GOLD}; background-tint: {BG} 0%; }}
Input > .input--placeholder {{ color: {FAINT}; }}
TextArea {{ background: {FIELD}; border: round {LINE}; scrollbar-size: 1 1; scrollbar-background: {FIELD}; scrollbar-color: {LINE}; scrollbar-color-hover: {GOLD_DIM}; scrollbar-color-active: {GOLD}; scrollbar-corner-color: {FIELD}; }}
TextArea:focus {{ border: round {GOLD}; }}
Button {{ background: {GOLD}; color: #1a1206; border: none; text-style: bold; min-width: 10; height: 1; margin-right: 2; }}
Button:hover {{ background: {GOLD_DIM}; }}
Button:focus {{ text-style: bold reverse; }}
Button.quiet {{ background: {PANEL}; color: {GOLD}; }}
Button.danger {{ background: {PANEL}; color: {BAD}; }}
Select > SelectCurrent {{ background: {FIELD}; border: round {LINE}; color: {INK}; }}
Select:focus > SelectCurrent {{ border: round {GOLD}; background-tint: {BG} 0%; }}
Select > SelectOverlay {{ background: {PANEL}; border: round {GOLD_DIM}; }}
Checkbox {{ background: {BG} 0%; border: none; padding: 0 1 0 0; }}
Checkbox:focus {{ border: none; background-tint: {BG} 0%; }}
Checkbox:focus > .toggle--label {{ text-style: underline; background: {BG} 0%; }}
Checkbox > .toggle--button {{ background: {FIELD}; color: {FIELD}; }}
Checkbox.-on > .toggle--button {{ color: {GOLD}; }}
Label.lbl {{ color: {MUTED}; margin-top: 1; }}
VerticalScroll, OptionList, ListView {{ scrollbar-size-vertical: 1; scrollbar-background: {BG}; scrollbar-color: {LINE}; scrollbar-color-hover: {GOLD_DIM}; scrollbar-color-active: {GOLD}; }}
OptionList {{ background: {BG}; border: none; padding: 0; }}
OptionList:focus {{ border: none; background-tint: {BG} 0%; }}
OptionList > .option-list--option-highlighted {{ background: {PANEL}; text-style: none; }}
OptionList:focus > .option-list--option-highlighted {{ background: #1d2a1b; }}
OptionList > .option-list--option-disabled {{ color: {INK}; }}
Footer {{ background: {PANEL}; }}
Toast {{ background: {PANEL}; border-left: outer {GOLD}; color: {INK}; }}
Toast.-error {{ border-left: outer {BAD}; }}
ModalScreen {{ background: rgba(0,0,0,0.6); align: center middle; }}
.dialog {{ width: 76; max-width: 95%; height: auto; max-height: 95%; background: {PANEL}; border: round {GOLD_DIM}; padding: 1 2; }}
.dialog .buttons {{ height: auto; margin-top: 1; }}
Screen.side-hidden .side {{ display: none; }}
"""


def plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


class Failed(Exception):
    """A request failed and the person has already been told why."""


def attempt(fn):
    """For page actions that talk to the site: a failure becomes a message, not a crash."""
    @functools.wraps(fn)
    async def go(self, *a, **k):
        try:
            return await fn(self, *a, **k)
        except Failed:
            return None
    return go


async def fetch(app, fn, *args):
    """Runs a site.* call off the UI thread. Signed out on the site → leave; other failures → a message and Failed."""
    try:
        return await asyncio.to_thread(fn, *args)
    except site.SignedOut:
        app.signed_out = True
        app.exit(message="Signed out on the site. Run  sintfoap login  to sign in again.")
        raise Failed() from None
    except site.SiteError as e:
        app.notify(str(e).removeprefix("the site said: ").capitalize(), severity="error", timeout=5)
        raise Failed() from None


def open_in_browser(app, url: str) -> None:
    webbrowser.open(url)
    app.notify(f"Opened {url}", timeout=3)


class Page(Screen):
    """A page of the site: the crest and who's signed in at the top, Esc goes back."""
    WEB_PATH = "/dashboard"
    # The page's own side panel (Drift's views, chat's rooms, Recipe box's
    # shelf), which \ hides and shows like the web rail's Collapse. None: no panel.
    SIDE: str | None = None
    BINDINGS = [
        Binding("escape", "back", "Back"),
        Binding("backslash", "fold", "Side panel", show=False),
        Binding("g", "goto", "Go to"),
        Binding("w", "web", "In browser"),
        Binding("q", "app.quit", "Quit"),
    ]

    def top(self) -> ComposeResult:
        with Horizontal(id="top"):
            yield Static("✕ SINTFOAP.XYZ", id="crest")
            yield Static(self.app.who_line(), id="who")

    def on_mount(self) -> None:
        self.show_side()

    def on_screen_resume(self) -> None:
        self.show_side()

    def show_side(self) -> None:
        if self.SIDE:
            for w in self.query(self.SIDE):
                w.add_class("side")
        self.set_class(self.side_hidden(), "side-hidden")

    def side_hidden(self) -> bool:
        return bool(self.SIDE) and site.load_prefs().get("side_hidden", False)

    def action_fold(self) -> None:
        """\\: hide or show the side panel, here and on every page after, and remember it."""
        if not self.SIDE:
            return
        hide = not self.side_hidden()
        site.save_pref("side_hidden", hide)
        self.show_side()
        panel = self.query(self.SIDE).first()
        if hide and self.focused and panel in self.focused.ancestors_with_self:
            self.focus_next()
        self.notify("Side panel hidden. Press \\ to show it." if hide else "Side panel shown.", timeout=2)

    def set_who(self) -> None:
        for w in self.query("#who"):
            w.update(self.app.who_line())

    def action_back(self) -> None:
        if isinstance(self.focused, (Input, TextArea)) and self.leave_field():
            return
        if len(self.app.screen_stack) > 1:
            self.app.pop_screen()
        else:
            self.app.exit()

    def leave_field(self) -> bool:
        """Esc in a text box: where focus goes instead of leaving the page. False to leave."""
        return False

    def action_goto(self) -> None:
        data = self.app.data or {}
        self.app.push_screen(GoTo(data.get("nav"), admin=bool(data.get("user", {}).get("admin"))), self.app.go)

    def action_web(self) -> None:
        open_in_browser(self.app, site.site_url(self.WEB_PATH))

    async def fetch(self, fn, *args):
        return await fetch(self.app, fn, *args)


# ── small dialogs ──────────────────────────────────────────────────────────

class Ask(ModalScreen[str | None]):
    """One line of text, or None if cancelled."""
    BINDINGS = [Binding("escape", "cancel", "Cancel")]

    def __init__(self, title: str, hint: str = "", value: str = "", placeholder: str = "", ok: str = "OK", password: bool = False):
        super().__init__()
        self._title, self._hint, self._value, self._ph, self._ok, self._password = title, hint, value, placeholder, ok, password

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Label(Text(self._title, style=f"bold {INK}"))
            if self._hint:
                yield Static(Text(self._hint, style=MUTED))
            yield Input(self._value, placeholder=self._ph, id="answer", password=self._password)
            with Horizontal(classes="buttons"):
                yield Button(self._ok, id="ok")
                yield Button("Cancel", id="cancel", classes="quiet")

    def on_input_submitted(self) -> None:
        self.dismiss(self.query_one("#answer", Input).value)

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.dismiss(self.query_one("#answer", Input).value if e.button.id == "ok" else None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class Confirm(ModalScreen[bool]):
    BINDINGS = [Binding("escape", "no", "Cancel"), Binding("y", "yes", "Yes"), Binding("n", "no", "No")]

    def __init__(self, title: str, text: str = "", yes: str = "Yes", danger: bool = False):
        super().__init__()
        self._title, self._text, self._yes, self._danger = title, text, yes, danger

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Label(Text(self._title, style=f"bold {INK}"))
            if self._text:
                yield Static(Text(self._text, style=MUTED))
            with Horizontal(classes="buttons"):
                yield Button(self._yes, id="yes", classes="danger" if self._danger else "")
                yield Button("Cancel", id="no", classes="quiet")

    def on_mount(self) -> None:
        self.query_one("#no" if self._danger else "#yes", Button).focus()

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.dismiss(e.button.id == "yes")

    def action_yes(self) -> None:
        self.dismiss(True)

    def action_no(self) -> None:
        self.dismiss(False)


class GoTo(ModalScreen[str | None]):
    """The second key of the g chord. The letters come from the site's menu
    (the dashboard's `nav`), so the terminal offers what the web rail does."""
    DEFAULT_CSS = f"""
    GoTo {{ background: rgba(0,0,0,0.3); }}
    GoTo > Static {{ width: auto; background: {PANEL}; border: round {GOLD_DIM}; padding: 0 2; margin-bottom: 2; }}
    """
    # For a site too old to send its menu.
    KEYS = {"h": "home", "d": "Drift", "p": "plugin store", "c": "chat", "s": "settings", "a": "admin"}

    def __init__(self, nav: list | None = None, admin: bool = False):
        super().__init__()
        if nav:
            self.keys = {n["key"]: n["label"] for n in nav if n.get("key")}
        else:
            self.keys = {k: v for k, v in self.KEYS.items() if k != "a" or admin}
        self.keys["o"] = "sign out"

    def compose(self) -> ComposeResult:
        t = Text("go to   ", style=GOLD_DIM)
        for k, v in self.keys.items():
            t.append(k, style=f"bold {GOLD}")
            t.append(f" {v}   ", style=MUTED)
        yield Static(t)

    def on_key(self, event) -> None:
        event.stop()
        event.prevent_default()
        self.dismiss(event.key if event.key in self.keys else None)
