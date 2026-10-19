"""
The site in the terminal (Textual): the dashboard, and from it Drift, the
plugin store, chat, Recipe box, account settings and (for admins) who can use which app,
in the same colours as the website.
"""
from __future__ import annotations

from datetime import datetime

from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Grid, VerticalScroll
from textual.widgets import Footer, Static

from . import site
from .look import BAD, BG, CSS, FAINT, GOLD, GOLD_DIM, GOOD, INK, LINE, MUTED, PANEL, Failed, Page, fetch, open_in_browser, plural

# The palette lives in look.py; these names stay importable from here too.
__all__ = ["SiteApp", "Dashboard", "run", "BG", "PANEL", "GOLD", "GOLD_DIM", "INK", "MUTED", "LINE", "BAD", "GOOD", "FAINT"]
WARN = "#e0b25a"


REFRESH_EVERY = 30   # seconds

# Which site pages have a terminal version, by the path the dashboard links to.
IN_TERMINAL = {"/todo/": "drift", "/plugins/": "store", "/chat/": "chat", "/admin": "admin", "/notifications/": "notifications", "/recipes/": "recipes"}


def account_lines(data: dict) -> Text:
    """Counts, then the same checks as the web dashboard's account panel."""
    u, a = data["user"], data["account"]
    n, left, plugins = a["sessions"], a["recovery_codes_left"], a.get("plugins_installed")
    t = Text.assemble(("Signed in as ", MUTED), (u["username"], f"bold {INK}"), ("   ", MUTED),
                      (plural(n, "device"), INK), ("  ·  ", FAINT), (plural(left, "recovery code"), INK))
    if plugins is not None:
        t.append_text(Text.assemble(("  ·  ", FAINT), (plural(plugins, "plugin"), INK)))
    t.append("\n")
    check = lambda ok, warn, text: t.append_text(Text.assemble(  # noqa: E731
        ("\n✓ " if ok else "\n! " if warn else "\n✕ ", GOOD if ok else WARN if warn else BAD), (text, MUTED if ok else INK)))
    check(a["two_factor"], False, "Two-factor is on." if a["two_factor"] else "Two-factor is off.")
    if not left:
        check(False, False, "No recovery codes, so only the admin can reset a forgotten password.")
    else:
        check(left >= 3, True, f"{plural(left, 'recovery code')} left." + ("" if left >= 3 else " Make new ones soon."))
    if a.get("email"):
        check(a["email_confirmed"], True, f"Email {a['email']} " + ("is confirmed." if a["email_confirmed"] else "isn't confirmed yet."))
    return t


def today_lines(today: dict) -> Text:
    """The web dashboard's Today card: overdue Drift items in red, then what's due today."""
    t = Text()
    for kind, colour in (("late", BAD), ("due", INK)):
        for it in today.get(kind, []):
            if t:
                t.append("\n")
            t.append("● " if kind == "late" else "○ ", style=colour)
            t.append(it["title"], style=colour)
            t.append(f"   +{it['collection']}" if it.get("collection") else "", style=GOLD_DIM)
            t.append(f"   {it['when']}" if it.get("when") else "", style=BAD if kind == "late" else MUTED)
    return t or Text("Nothing due today.", style=MUTED)


def greeting(hour: int) -> str:
    return "Good morning" if 4 <= hour < 12 else "Good afternoon" if hour < 18 else "Good evening"


def page_for(url: str) -> str | None:
    for path, page in IN_TERMINAL.items():
        if url.endswith(path):
            return page
    return None


class Card(Static, can_focus=True):
    """A dashboard card. Enter or a click opens its page: here if the terminal has it, else in the browser."""

    def __init__(self, title: str, body: Text | str, url: str, action: str = "Open →", page: str | None = None, **kw):
        super().__init__(**kw)
        self.url, self.page, self._title, self._body, self._action = url, page, title, body, action

    def render(self) -> Text:
        t = Text(self._title, style=f"bold {INK}")
        t.append("\n\n")
        t.append(self._body if isinstance(self._body, Text) else Text(self._body, style=MUTED))
        t.append("\n\n")
        t.append(self._action.upper(), style=f"bold {GOLD}")
        if self.page:
            t.append("   W IN BROWSER", style=GOLD_DIM)
        return t

    def open(self) -> None:
        if self.page:
            self.app.open_page(self.page)
        else:
            self.open_web()

    def open_web(self) -> None:
        open_in_browser(self.app, self.url)

    def on_click(self) -> None:
        self.open()


class DashboardPage(Page):
    AUTO_FOCUS = ""    # refresh() focuses the first card once the cards exist
    DEFAULT_CSS = f"""
    DashboardPage #body {{ padding: 1 4; }}
    DashboardPage #welcome {{ color: {INK}; text-style: bold; padding: 1 0 1 0; }}
    DashboardPage #notice {{ display: none; border: round {BAD}; color: {BAD}; padding: 0 1; margin-bottom: 1; }}
    DashboardPage #notice.on {{ display: block; }}
    DashboardPage #apps {{ grid-size: 2; grid-gutter: 1 2; height: auto; margin-bottom: 1; }}
    Card {{ background: #121a12; border: round #4a4430; padding: 1 2; height: auto; }}
    Card:focus {{ border: round {GOLD}; }}
    Card:hover {{ border: round {GOLD_DIM}; }}
    DashboardPage #panels {{ grid-size: 2; grid-columns: 2fr 3fr; grid-gutter: 1 2; height: auto; margin-bottom: 1; }}
    DashboardPage #panels.single {{ grid-size: 1; grid-columns: 1fr; }}
    DashboardPage #status {{ color: {GOLD_DIM}; height: 1; }}
    """
    BINDINGS = [
        Binding("enter", "open", "Open", show=True),
        Binding("tab,right,l,down,j", "move(1)", "Next", show=False),
        Binding("shift+tab,left,h,up,k", "move(-1)", "Previous", show=False),
        Binding("w", "web", "In browser"),
        Binding("s", "settings", "Settings"),
        Binding("r", "refresh", "Refresh"),
        Binding("o", "sign_out", "Sign out"),
        Binding("q,escape", "app.quit", "Quit"),
    ]

    def compose(self) -> ComposeResult:
        yield from self.top()
        with VerticalScroll(id="body", can_focus=False):
            yield Static("D A S H B O A R D", classes="kicker", id="kicker")
            yield Static(id="welcome")
            yield Static(id="notice")
            with Grid(id="panels"):
                yield Card("Today", "", "", "Open Drift →", page="drift", id="today")
                yield Card("Your account", "", "", "Account settings →", page="settings", id="account")
            yield Grid(id="apps")
            yield Static(id="status")
        yield Footer()

    async def on_mount(self) -> None:
        await self.action_refresh()
        self.set_interval(REFRESH_EVERY, self.action_refresh)
        self.mounted = True

    async def action_refresh(self) -> None:
        try:
            data = await fetch(self.app, self.app.load)
        except Failed:
            self.query_one("#status", Static).update(Text("● couldn't reach the site", style=BAD))
            return
        focused = self.focused.id if self.focused else None
        self.app.data = data
        for screen in self.app.screen_stack:
            if isinstance(screen, Page):
                screen.set_who()
        u, a = data["user"], data["account"]
        self.app.sub_title = data["site"].split("://", 1)[-1]
        # Newer sites send the date and Today; older ones get the first dashboard's heading.
        if data.get("date"):
            first = u["display_name"].split()[0] if u["display_name"].split() else u["display_name"]
            self.query_one("#kicker", Static).update(data["date"].upper())
            self.query_one("#welcome", Static).update(Text(f"{greeting(datetime.now().hour)}, {first}", style=f"bold {INK}"))
        else:
            self.query_one("#welcome", Static).update(Text(f"Welcome, {u['display_name']}", style=f"bold {INK}"))
        today = self.query_one("#today", Card)
        today.display = bool(data.get("today"))
        self.query_one("#panels").set_class(not data.get("today"), "single")
        if data.get("today"):
            today._body, today.url = today_lines(data["today"]), data["today"]["url"]
            today.refresh(layout=True)

        notice = self.query_one("#notice", Static)
        notice.set_class(bool(a.get("setup_needed")), "on")
        if a.get("setup_needed"):
            notice.update(f"Finish setting up your account first: {a['setup_needed']}. Press s for account settings.")

        grid = self.query_one("#apps", Grid)
        await grid.remove_children()
        cards = [Card(app["name"], app["blurb"], app["url"], page=page_for(app["url"]), id=f"app-{i}")
                 for i, app in enumerate(data["apps"])]
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

    def cards(self) -> list[Card]:
        return [c for c in self.query(Card) if c.display]

    def action_move(self, delta: int) -> None:
        cards = self.cards()
        if not cards:
            return
        i = cards.index(self.focused) if self.focused in cards else -delta
        cards[(i + delta) % len(cards)].focus()

    def action_open(self) -> None:
        if isinstance(self.focused, Card) and (self.focused.url or self.focused.page):
            self.focused.open()

    def action_web(self) -> None:
        if isinstance(self.focused, Card) and self.focused.url:
            self.focused.open_web()

    def action_settings(self) -> None:
        self.app.open_page("settings")

    def action_sign_out(self) -> None:
        where = site.logout()
        self.app.signed_out = True
        self.app.exit(message=f"Signed out of {where}." if where else "Signed out.")

    async def on_screen_resume(self) -> None:
        # Back from another page: a changed name or a new sign-out shows straight away.
        if getattr(self, "mounted", False):
            await self.action_refresh()


class SiteApp(App):
    TITLE = "sintfoap.xyz"
    CSS = CSS

    def __init__(self, start: str = "dashboard", load=site.dashboard, room: str | None = None):
        super().__init__()
        self.start, self.load, self.room = start, load, room
        self.data: dict | None = None
        self.signed_out = False

    def get_default_screen(self) -> DashboardPage:
        return DashboardPage()

    def on_mount(self) -> None:
        if self.start != "dashboard":
            self.open_page(self.start)

    def who_line(self) -> Text:
        if not self.data:
            return Text("")
        u = self.data["user"]
        host = self.data["site"].split("://", 1)[-1]
        return Text.assemble((u["display_name"], INK), ("   ADMIN" if u["admin"] else "", GOLD_DIM), (f"   {host}", MUTED))

    def go(self, where: str | None) -> None:
        """The g chord, as on the website. The letters and where they lead come
        from the site's menu (`nav` in the dashboard data); g o signs out."""
        if not where:
            return
        if where == "o":
            where_ = site.logout()
            self.signed_out = True
            self.exit(message=f"Signed out of {where_}." if where_ else "Signed out.")
            return
        nav = (self.data or {}).get("nav")
        if nav:
            item = next((n for n in nav if n.get("key") == where), None)
            if not item:
                return
            page = "home" if item["id"] == "home" else "settings" if item["id"] == "account" else page_for(item["url"])
            if not page:
                open_in_browser(self, item["url"])
                return
        else:  # a site too old to send its menu
            page = {"h": "home", "d": "drift", "p": "store", "s": "settings", "c": "chat", "a": "admin"}.get(where)
        while len(self.screen_stack) > 1:
            self.pop_screen()
        if page and page != "home":
            self.open_page(page)

    def open_page(self, name: str) -> None:
        if name == "settings":
            from .settings_page import SettingsPage
            self.push_screen(SettingsPage())
        elif name == "drift":
            from .drift_page import DriftPage
            self.push_screen(DriftPage())
        elif name == "store":
            from .store_page import StorePage
            self.push_screen(StorePage())
        elif name == "admin":
            from .admin_page import AdminPage
            self.push_screen(AdminPage())
        elif name == "notifications":
            from .notifications_page import NotificationsPage
            self.push_screen(NotificationsPage())
        elif name == "recipes":
            from .recipes_page import RecipesPage
            self.push_screen(RecipesPage())
        elif name == "books":
            from .books_page import BooksPage
            self.push_screen(BooksPage())
        elif name == "chat":
            from .chat_page import ChatPage
            # The room named on the command line, the first time only.
            self.push_screen(ChatPage(room=self.room))
            self.room = None


# The name the first version had.
Dashboard = SiteApp


def run(start: str = "dashboard", room: str | None = None) -> None:
    SiteApp(start, room=room).run()
