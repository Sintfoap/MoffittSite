"""The book club pick in the terminal: the same list and votes as the public /books/ page.

Anyone can open it, signed in or not (`sintfoap books`). This terminal gets one
vote, like a browser, which it can move to another book or take back. Admins
also see who voted for what, as on /admin, and can remove a vote."""
from __future__ import annotations

import asyncio
import time

from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Footer, Label, OptionList, Static
from textual.widgets.option_list import Option

from . import site
from .look import CSS, FAINT, GOLD, GOLD_DIM, GOOD, INK, LINE, MUTED, Ask, Confirm, Page, attempt, open_in_browser, plural


def bar(n: int, top: int, width: int = 24) -> Text:
    full = round(width * n / top) if top else 0
    return Text.assemble(("━" * full, GOLD), ("━" * (width - full), LINE))


def when(t: int) -> str:
    return time.strftime("%b %-d %H:%M", time.localtime(t))


class BookCard(Static, can_focus=True):
    """One book. Enter votes for it; o picks a place to get it."""
    # Here rather than on the page, so the scrolling page around the cards doesn't take the arrow keys.
    BINDINGS = [Binding("down,j", "screen.move(1)", show=False), Binding("up,k", "screen.move(-1)", show=False)]

    def __init__(self, book: dict, mine: bool, top: int, **kw):
        super().__init__(classes="card book" + (" mine" if mine else ""), **kw)
        self.book, self.mine, self.top = book, mine, top

    def render(self) -> Text:
        b = self.book
        t = Text(b["title"], style=f"bold {INK}")
        if self.mine:
            t.append("   ✓ YOUR VOTE", style=f"bold {GOOD}")
        if b.get("series"):
            t.append(f"\n{b['series']}", style=f"italic {MUTED}")
        t.append(f"\n{b['author']} · {b['year']}\n\n", style=GOLD_DIM)
        t.append(b["blurb"], style=MUTED)
        t.append("\n\n")
        for i, link in enumerate(b["links"]):
            t.append("   " if i else "")
            t.append(link["label"], style=f"{GOLD} link {link['url']}")
        t.append("\n\n")
        t.append_text(bar(b["votes"], self.top))
        t.append(f"  {plural(b['votes'], 'vote')}", style=INK)
        t.append("    ENTER " + ("TAKE BACK" if self.mine else "VOTE") + "   O WHERE TO GET IT", style=GOLD_DIM)
        return t

    def on_click(self) -> None:
        self.focus()


class Links(ModalScreen[str | None]):
    """Where to get a book: pick one to open it in the browser."""
    BINDINGS = [Binding("escape", "cancel", "Cancel")]

    def __init__(self, book: dict):
        super().__init__()
        self.book = book

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Label(Text(f"Where to get {self.book['title']}", style=f"bold {INK}"))
            yield OptionList(*[Option(Text.assemble((link["label"], INK), ("\n" + link["url"], FAINT)), id=link["url"])
                               for link in self.book["links"]], id="links")

    def on_option_list_option_selected(self, e: OptionList.OptionSelected) -> None:
        self.dismiss(e.option.id)

    def action_cancel(self) -> None:
        self.dismiss(None)


class BooksPage(Page):
    WEB_PATH = "/books/"
    DEFAULT_CSS = f"""
    BooksPage #body {{ padding: 0 4 1 4; }}
    BooksPage #cards {{ max-width: 100; height: auto; }}
    BooksPage #books {{ height: auto; }}
    BooksPage .book.mine {{ border: round {GOOD}; }}
    BooksPage .book:focus {{ border: round {GOLD}; }}
    BooksPage #status {{ color: {GOLD_DIM}; padding-bottom: 1; }}
    BooksPage #votes {{ display: none; }}
    BooksPage #votes.on {{ display: block; }}
    BooksPage #voters {{ height: auto; max-height: 20; }}
    """
    BINDINGS = [
        Binding("enter,v", "vote", "Vote"),
        Binding("u", "unvote", "Take back", show=False),
        Binding("o", "links", "Where to get it"),
        Binding("n", "name", "Your name"),
        Binding("tab", "move(1)", "Next", show=False),
        Binding("shift+tab", "move(-1)", "Previous", show=False),
        Binding("x", "remove", "Remove vote", show=False),
        Binding("r", "refresh", "Refresh"),
    ]

    def __init__(self):
        super().__init__()
        self.data: dict | None = None
        self.votes: dict | None = None
        self.voter_name = ""

    def compose(self) -> ComposeResult:
        yield from self.top()
        with VerticalScroll(id="body"):
            with Vertical(id="cards"):
                yield Static("B O O K   C L U B", classes="kicker")
                yield Static(Text("What should we read next?", style=f"bold {INK}"), classes="h1")
                yield Static(Text("Four books for the club to choose between. Enter votes for one; you can move your vote or take it back (u). "
                                  "n sets the name your vote is under. This page is public: no sign-in needed.", style=MUTED), classes="sub")
                yield Static(id="status")
                yield Vertical(id="books")
                with Vertical(id="votes", classes="card"):
                    yield Static("Who voted (admins)", classes="card-title")
                    yield Static(Text("x removes the highlighted vote.", style=FAINT))
                    yield OptionList(id="voters")
        yield Footer()

    async def on_mount(self) -> None:
        await self.action_refresh()

    @attempt
    async def action_refresh(self) -> None:
        await self.show(await self.fetch(site.books))
        await self.load_votes()

    async def load_votes(self) -> None:
        """Who voted for what, if this terminal is signed in as an admin. Anyone else just doesn't see it."""
        if not site.load_login():
            return
        try:
            self.votes = await asyncio.to_thread(site.admin_books)
        except site.SiteError:
            self.votes = None
        box = self.query_one("#votes")
        box.set_class(self.votes is not None, "on")
        if self.votes is None:
            return
        voters = self.query_one("#voters", OptionList)
        voters.clear_options()
        for v in self.votes["votes"]:
            who = v["name"] or "no name given"
            line = Text.assemble((v["title"], f"bold {INK}"), ("   ", ""), (who, INK if v["name"] else FAINT))
            if v.get("username"):
                line.append(f"  ({v['username']})", style=GOLD_DIM)
            line.append(f"\n{v['device']} · {v['ip']}" + (f" · {v['place']}" if v.get("place") else "") + f" · {when(v['updated_at'])}", style=MUTED)
            voters.add_option(Option(line, id=v["voter"]))
        box.border_title = plural(len(self.votes["votes"]), "vote")
        if self.votes["votes"]:
            voters.highlighted = 0
        else:
            voters.add_option(Option(Text("No votes yet.", style=FAINT), disabled=True))

    async def show(self, data: dict) -> None:
        self.data = data
        if data.get("name") and not self.voter_name:
            self.voter_name = data["name"]
        focused = self.focused.book["id"] if isinstance(self.focused, BookCard) else None
        top = max([1] + [b["votes"] for b in data["books"]])
        holder = self.query_one("#books", Vertical)
        await holder.remove_children()
        cards = [BookCard(b, b["id"] == data["mine"], top, id=f"book-{b['id']}") for b in data["books"]]
        await holder.mount_all(cards)
        mine = next((b["title"] for b in data["books"] if b["id"] == data["mine"]), None)
        status = Text(f"You voted for {mine}. " if mine else "You haven't voted yet. ", style=GOOD if mine else INK)
        status.append(f"{plural(data['total'], 'vote')} so far.", style=MUTED)
        status.append(f"   Voting as {self.voter_name}." if self.voter_name else "   No name set (n).", style=GOLD_DIM)
        self.query_one("#status", Static).update(status)
        target = next((c for c in cards if c.book["id"] == focused), cards[0] if cards else None)
        if target and not isinstance(self.focused, OptionList):
            self.call_after_refresh(target.focus)

    def cards(self) -> list[BookCard]:
        return list(self.query(BookCard))

    def action_move(self, delta: int) -> None:
        cards = self.cards()
        if not cards:
            return
        i = cards.index(self.focused) if self.focused in cards else -delta
        if 0 <= i + delta < len(cards):
            cards[i + delta].focus()
            cards[i + delta].scroll_visible()
        elif delta > 0 and self.votes is not None:
            self.query_one("#voters", OptionList).focus()

    @attempt
    async def action_vote(self) -> None:
        if not isinstance(self.focused, BookCard) or not self.data:
            return
        book = self.focused.book
        if book["id"] == self.data["mine"]:
            await self.action_unvote()
            return
        await self.show(await self.fetch(site.book_vote, book["id"], self.voter_name))
        self.app.notify(f"Voted for {book['title']}.", timeout=3)
        await self.load_votes()

    @attempt
    async def action_unvote(self) -> None:
        if not self.data or not self.data["mine"]:
            return
        await self.show(await self.fetch(site.book_unvote))
        self.app.notify("Your vote is taken back.", timeout=3)
        await self.load_votes()

    def action_links(self) -> None:
        if isinstance(self.focused, BookCard):
            self.app.push_screen(Links(self.focused.book), lambda url: url and open_in_browser(self.app, url))

    def action_name(self) -> None:
        self.app.push_screen(Ask("Your name", "Shown with your vote, so it's clear who voted. Leave it empty to vote without one.",
                                 self.voter_name, "So the club knows who voted", ok="Save"), self.set_name)

    @attempt
    async def set_name(self, name: str | None) -> None:
        if name is None:
            return
        self.voter_name = name.strip()[:60]
        if self.data and self.data["mine"]:
            await self.show(await self.fetch(site.book_vote, self.data["mine"], self.voter_name))
            await self.load_votes()
        elif self.data:
            await self.show(self.data)

    def action_remove(self) -> None:
        voters = self.query_one("#voters", OptionList)
        if self.focused is not voters or voters.highlighted is None or not self.votes:
            return
        voter = voters.get_option_at_index(voters.highlighted).id
        v = next((v for v in self.votes["votes"] if v["voter"] == voter), None)
        if not v:
            return

        async def done(yes: bool) -> None:
            if yes:
                await self.remove_vote(voter)
        self.app.push_screen(Confirm("Remove this vote?", f"{v['name'] or 'Someone'} for {v['title']}, from {v['device']} at {v['ip']}.",
                                     yes="Remove", danger=True), done)

    @attempt
    async def remove_vote(self, voter: str) -> None:
        await self.fetch(site.remove_book_vote, voter)
        self.app.notify("That vote is removed.", timeout=3)
        await self.show(await self.fetch(site.books))
        await self.load_votes()


class BooksApp(App):
    """The books page on its own, for `sintfoap books` without signing in."""
    TITLE = "sintfoap.xyz"
    CSS = CSS

    def __init__(self):
        super().__init__()
        self.data: dict | None = None
        self.signed_out = False

    def get_default_screen(self) -> BooksPage:
        return BooksPage()

    def who_line(self) -> Text:
        return Text.assemble(("not signed in", MUTED), (f"   {site.site_url().split('://', 1)[-1]}", FAINT))

    def go(self, where: str | None) -> None:
        if where:
            self.notify("The rest of the site needs signing in: run  sintfoap login", timeout=4)


def run() -> None:
    BooksApp().run()

