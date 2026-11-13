"""Account settings in the terminal: the same cards as /account, API keys for AI agents included.

Anything that needs your password (two-factor, recovery codes, email, the
password itself) opens /account in the browser instead, so the terminal never
asks for it."""
from __future__ import annotations

import time

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import Button, Footer, Input, Static

from . import site
from .look import BAD, INK, MUTED, Confirm, Page, attempt, plural

WEB_ONLY = "needs your password, so it's done on the website: press w to open it."


class SettingsPage(Page):
    WEB_PATH = "/account"
    DEFAULT_CSS = f"""
    SettingsPage #body {{ padding: 0 4 1 4; }}
    SettingsPage #cards {{ max-width: 80; height: auto; }}
    SettingsPage #must {{ display: none; border: round {BAD}; color: {BAD}; padding: 0 1; margin-bottom: 1; }}
    SettingsPage #must.on {{ display: block; }}
    SettingsPage .row {{ height: auto; margin-top: 1; }}
    SettingsPage #name {{ width: 1fr; margin-right: 2; }}
    SettingsPage #save {{ margin-top: 1; }}
    SettingsPage #keys {{ height: auto; }}
    SettingsPage .key {{ height: auto; margin-top: 1; }}
    SettingsPage .key Static {{ width: 1fr; }}
    """
    BINDINGS = [Binding("r", "refresh", "Refresh")]

    def __init__(self):
        super().__init__()
        self.acct: dict | None = None

    def compose(self) -> ComposeResult:
        yield from self.top()
        with VerticalScroll(id="body"):
            with Vertical(id="cards"):
                yield Static("A C C O U N T   S E T T I N G S", classes="kicker")
                yield Static(id="h1", classes="h1 sub")
                yield Static(id="must")
                with Vertical(classes="card", id="profile"):
                    yield Static("Profile", classes="card-title")
                    yield Static(id="username")
                    with Horizontal(classes="row"):
                        yield Input(id="name", max_length=50, placeholder="Display name")
                        yield Button("Save", id="save")
                with Vertical(classes="card", id="twofa"):
                    yield Static(id="twofa-title", classes="card-title")
                    yield Static(id="twofa-text")
                with Vertical(classes="card", id="recovery"):
                    yield Static("Recovery codes", classes="card-title")
                    yield Static(id="recovery-text")
                with Vertical(classes="card", id="email"):
                    yield Static("Email", classes="card-title")
                    yield Static(id="email-text")
                with Vertical(classes="card", id="password"):
                    yield Static("Password", classes="card-title")
                    yield Static(Text("Changing your password " + WEB_ONLY + " It signs you out everywhere else.", style=MUTED))
                with Vertical(classes="card", id="sessions"):
                    yield Static("Sessions", classes="card-title")
                    yield Static(id="sessions-text")
                    with Horizontal(classes="row"):
                        yield Button("Sign out everywhere else", id="others", classes="quiet")
                        yield Button("Sign out this terminal", id="this", classes="danger")
                with Vertical(classes="card", id="agents"):
                    yield Static("API keys for AI agents", classes="card-title")
                    yield Static(id="agents-text")
                    yield Vertical(id="keys")
        yield Footer()

    async def on_mount(self) -> None:
        await self.action_refresh()

    @attempt
    async def action_refresh(self) -> None:
        self.show(await self.fetch(site.account))

    def show(self, a: dict) -> None:
        self.acct = a
        self.query_one("#h1", Static).update(Text(a["display_name"], style=f"bold {INK}"))
        must = self.query_one("#must", Static)
        must.set_class(a["must_change_pw"], "on")
        must.update("Your password was reset, so choose a new one before anything else. That " + WEB_ONLY)
        self.query_one("#username", Static).update(Text.assemble(("Username ", MUTED), (a["username"], f"bold {INK}")))
        name = self.query_one("#name", Input)
        if not name.has_focus:
            name.value = a["display_name"]

        on = a["two_factor"]
        self.query_one("#twofa-title", Static).update(f"Two-factor is {'on' if on else 'off'}")
        if on:
            t = Text("Signing in asks for a code from your phone after your password. ", style=MUTED)
            t.append("Two-factor is required for admin accounts, so it can't be turned off." if a["admin"]
                     else "Turning it off " + WEB_ONLY)
        else:
            t = Text("Admin accounts need two-factor before they can use the rest of the site. " if a["admin"]
                     else "Add a code from your phone on top of your password. ", style=BAD if a["admin"] else MUTED)
            t.append("Setting it up " + WEB_ONLY, style=MUTED)
        self.query_one("#twofa-text", Static).update(t)

        left = a["recovery_codes_left"]
        t = Text(f"You have {plural(left, 'recovery code')} left. " if left else
                 "You have none, so if you forget your password only the admin can reset it. ",
                 style=MUTED if left else BAD)
        t.append("Making new ones " + WEB_ONLY, style=MUTED)
        self.query_one("#recovery-text", Static).update(t)

        self.query_one("#email").display = bool(a["mail"])
        if a.get("email"):
            t = Text.assemble((a["email"], f"bold {INK}"), (" is confirmed, so it can reset your password. " if a["email_confirmed"]
                                                            else " isn't confirmed yet. Open the link we sent to it. ", MUTED))
        else:
            t = Text("Add an email address to get your username and a reset link if you forget your password. ", style=MUTED)
        t.append("Changing it " + WEB_ONLY, style=MUTED)
        self.query_one("#email-text", Static).update(t)

        self.query_one("#sessions-text", Static).update(Text.assemble(
            (f"Signed in on {plural(a['sessions'], 'device')}, including this terminal.", MUTED)))
        self.show_agents(a.get("agents"))
        for b in self.query("#save, #name, #others"):
            b.disabled = a["must_change_pw"]

    def show_agents(self, ag: dict | None) -> None:
        """The MCP server's keys: what they reach, and each one with Revoke. Making one needs the password."""
        self.query_one("#agents").display = bool(ag)
        if not ag:
            return
        reach = [what for tool, what in (("drift", "Drift (your items and collections)"),
                                          ("recipes", "Recipe box (find, add and change your recipes, mark what you made, shop for them)"))
                 if tool in ag["tools"]]
        t = Text("An AI agent with one of your keys can act as you in ", style=MUTED)
        t.append(" and ".join(reach) + ", through the MCP server at ", style=MUTED)
        t.append(ag["mcp"], style=f"bold {INK}")
        t.append(". Treat a key like a password. Making one " + WEB_ONLY, style=MUTED)
        if not ag["keys"]:
            t.append("\n\nNo keys yet.", style=MUTED)
        self.query_one("#agents-text", Static).update(t)
        box = self.query_one("#keys", Vertical)
        box.remove_children()
        when = lambda ts: time.strftime("%Y-%m-%d", time.localtime(ts)) if ts else "never"
        for k in ag["keys"]:
            revoke = Button("Revoke", classes="danger revoke")
            revoke.api_key = k
            box.mount(Horizontal(
                Static(Text.assemble((k["name"], f"bold {INK}"), (f"  {k['prefix']}…  made {when(k['created_at'])}, last used {when(k['last_used'])}", MUTED))),
                revoke, classes="key"))

    async def on_input_submitted(self, e: Input.Submitted) -> None:
        if e.input.id == "name":
            await self.save_name()

    async def on_button_pressed(self, e: Button.Pressed) -> None:
        if e.button.id == "save":
            await self.save_name()
        elif e.button.id == "others":
            self.app.push_screen(Confirm("Sign out everywhere else?", "Every other browser and terminal signed in to your account is signed out. This one stays signed in.",
                                         yes="Sign them out"), self.sign_out_others)
        elif e.button.has_class("revoke"):
            k = e.button.api_key
            self.app.push_screen(Confirm(f"Revoke {k['name']}?", "Any AI agent using this key loses access straight away. This can't be undone.",
                                         yes="Revoke", danger=True), lambda yes: self.revoke(yes, k))
        elif e.button.id == "this":
            where = site.logout()
            self.app.signed_out = True
            self.app.exit(message=f"Signed out of {where}." if where else "Signed out.")

    @attempt
    async def save_name(self) -> None:
        name = self.query_one("#name", Input).value
        self.show(await self.fetch(site.save_display_name, name))
        self.app.notify("Display name saved.", timeout=3)
        if self.app.data:
            self.app.data["user"]["display_name"] = self.acct["display_name"]
            self.set_who()

    @attempt
    async def revoke(self, yes: bool | None, key: dict) -> None:
        if not yes:
            return
        self.show(await self.fetch(site.revoke_api_key, key["id"]))
        self.app.notify(f"Revoked {key['name']}.", timeout=3)

    @attempt
    async def sign_out_others(self, yes: bool | None) -> None:
        if not yes:
            return
        self.show(await self.fetch(site.sign_out_others))
        self.app.notify("Signed out everywhere else.", timeout=3)

    def leave_field(self) -> bool:
        self.query_one("#save", Button).focus()
        return True

