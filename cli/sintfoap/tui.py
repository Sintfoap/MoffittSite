"""The dashboard in the terminal (Textual): the same cards and colours as /dashboard."""
from __future__ import annotations

import asyncio
import webbrowser

from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Grid, Horizontal, VerticalScroll
from textual.widgets import Footer, Static

from . import site

# The site's palette (src/pages.js), converted from oklch.
BG, PANEL = "#0b0f0a", "#121a12"
GOLD, GOLD_DIM = "#d6ae5e", "#a08850"
INK, MUTED = "#f4efe6", "#c6bcab"
LINE = "#4a4430"
BAD, GOOD = "#e47a62", "#7fcf98"

REFRESH_EVERY = 30   # seconds


def plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def account_lines(data: dict) -> Text:
    u, a = data["user"], data["account"]
    t = Text.assemble(("Signed in as ", MUTED), (u["username"], f"bold {INK}"), (". ", MUTED),
                      ("Two-factor is ", MUTED), ("on" if a["two_factor"] else "off", GOOD if a["two_factor"] else BAD),
                      (". ", MUTED), (f"Signed in on {plural(a['sessions'], 'device')}.", MUTED))
    left = a["recovery_codes_left"]
    t.append("\n")
    t.append(f"{plural(left, 'recovery code')} left." if left else
             "No recovery codes, so only the admin can reset a forgotten password.",
             MUTED if left else BAD)
    if a.get("email"):
        t.append(f"  Email {a['email']} " + ("is confirmed." if a["email_confirmed"] else "isn't confirmed yet."), MUTED)
    return t


class Card(Static, can_focus=True):
    """A dashboard card. Enter or a click opens its page in the browser."""

    def __init__(self, title: str, body: Text | str, url: str, action: str = "Open →", **kw):
        super().__init__(**kw)
        self.url, self._title, self._body, self._action = url, title, body, action

    def render(self) -> Text:
        t = Text(self._title, style=f"bold {INK}")
        t.append("\n\n")
        t.append(self._body if isinstance(self._body, Text) else Text(self._body, style=MUTED))
        t.append("\n\n")
        t.append(self._action.upper(), style=f"bold {GOLD}")
        return t

    def open(self) -> None:
        webbrowser.open(self.url)
        self.app.notify(f"Opened {self.url}", timeout=3)

    def on_click(self) -> None:
        self.open()


class Dashboard(App):
    TITLE = "sintfoap.xyz"
    AUTO_FOCUS = None    # action_refresh focuses the first card once the cards exist
    CSS = f"""
    Screen {{ background: {BG}; color: {INK}; }}
    #top {{ height: 3; padding: 1 2 0 2; }}
    #crest {{ width: auto; color: {GOLD}; text-style: bold; }}
    #who {{ width: 1fr; content-align: right middle; color: {MUTED}; }}
    #body {{ padding: 1 4; scrollbar-size-vertical: 1; scrollbar-background: {BG}; scrollbar-color: {LINE}; scrollbar-color-hover: {GOLD_DIM}; scrollbar-color-active: {GOLD}; }}
    #kicker {{ color: {GOLD}; text-style: bold; }}
    #welcome {{ color: {INK}; text-style: bold; padding: 1 0 1 0; }}
    #notice {{ display: none; border: round {BAD}; color: {BAD}; padding: 0 1; margin-bottom: 1; }}
    #notice.on {{ display: block; }}
    #apps {{ grid-size: 2; grid-gutter: 1 2; height: auto; margin-bottom: 1; }}
    Card {{ background: {PANEL}; border: round {LINE}; padding: 1 2; height: auto; }}
    Card:focus {{ border: round {GOLD}; }}
    Card:hover {{ border: round {GOLD_DIM}; }}
    #account {{ margin-bottom: 1; }}
    #status {{ color: {GOLD_DIM}; height: 1; }}
    Footer {{ background: {PANEL}; }}
    """
    BINDINGS = [
        Binding("enter", "open", "Open", show=True),
        Binding("tab,right,l,down,j", "move(1)", "Next", show=False),
        Binding("shift+tab,left,h,up,k", "move(-1)", "Previous", show=False),
        Binding("s", "settings", "Settings"),
        Binding("r", "refresh", "Refresh"),
        Binding("o", "sign_out", "Sign out"),
        Binding("q,escape", "quit", "Quit"),
    ]

    def __init__(self, load=site.dashboard):
        super().__init__()
        self._load = load
        self.data: dict | None = None
        self.signed_out = False

    def compose(self) -> ComposeResult:
        with Horizontal(id="top"):
            yield Static("✕ SINTFOAP.XYZ", id="crest")
            yield Static(id="who")
        with VerticalScroll(id="body", can_focus=False):
            yield Static("D A S H B O A R D", id="kicker")
            yield Static(id="welcome")
            yield Static(id="notice")
            yield Grid(id="apps")
            yield Card("Your account", "", "", "Account settings →", id="account")
            yield Static(id="status")
        yield Footer()

    async def on_mount(self) -> None:
        await self.action_refresh()
        self.set_interval(REFRESH_EVERY, self.action_refresh)

    # ── data → widgets ─────────────────────────────────────────────────
    async def action_refresh(self) -> None:
        try:
            data = await asyncio.to_thread(self._load)   # keep the UI responsive while it fetches
        except site.SignedOut:
            self.signed_out = True
            self.exit(message="Signed out on the site. Run  sintfoap login  to sign in again.")
            return
        except site.SiteError as e:
            self.query_one("#status", Static).update(Text(f"● {e}", style=BAD))
            return
        focused = self.focused.id if self.focused else None
        self.data = data
        u, a = data["user"], data["account"]
        host = data["site"].split("://", 1)[-1]
        self.sub_title = host
        self.query_one("#who", Static).update(Text.assemble(
            (u["display_name"], INK), ("   ADMIN" if u["admin"] else "", GOLD_DIM), (f"   {host}", MUTED)))
        self.query_one("#welcome", Static).update(Text(f"Welcome, {u['display_name']}", style=f"bold {INK}"))

        notice = self.query_one("#notice", Static)
        notice.set_class(bool(a.get("setup_needed")), "on")
        if a.get("setup_needed"):
            notice.update(f"Finish setting up your account first: {a['setup_needed']}. Press s to open account settings.")

        grid = self.query_one("#apps", Grid)
        await grid.remove_children()
        cards = [Card(app["name"], app["blurb"], app["url"], id=f"app-{i}") for i, app in enumerate(data["apps"])]
        if cards:
            await grid.mount_all(cards)
        elif not a.get("setup_needed"):
            await grid.mount(Static(Text("Your account doesn't have any apps yet. Ask the site's admin for access.", style=MUTED)))

        acct = self.query_one("#account", Card)
        acct._body, acct.url = account_lines(data), a["url"]
        acct.refresh(layout=True)
        self.query_one("#status", Static).update(Text(f"● up to date · refreshes every {REFRESH_EVERY}s", style=GOLD_DIM))

        target = self.query(f"#{focused}").first() if focused and self.query(f"#{focused}") else None
        self.call_after_refresh((target or (cards[0] if cards else acct)).focus)

    # ── actions ────────────────────────────────────────────────────────
    def cards(self) -> list[Card]:
        return list(self.query(Card))

    def action_move(self, delta: int) -> None:
        cards = self.cards()
        if not cards:
            return
        i = cards.index(self.focused) if self.focused in cards else -delta
        cards[(i + delta) % len(cards)].focus()

    def action_open(self) -> None:
        if isinstance(self.focused, Card) and self.focused.url:
            self.focused.open()

    def action_settings(self) -> None:
        if self.data:
            self.query_one("#account", Card).open()

    def action_sign_out(self) -> None:
        where = site.logout()
        self.signed_out = True
        self.exit(message=f"Signed out of {where}." if where else "Signed out.")


def run() -> None:
    Dashboard().run()
