"""Feedback in the terminal: the same page as /feedback/.

Your notes to the site's owner down the left (and, for admins, the inbox of
everyone's: v switches), the open one on the right with its photos, the
things it links to, and the replies. n writes a note, l links something on
the site to it (a recipe, Drift item, pantry item, board post, trip, Food
club month, chat room or Meal plan week), u adds any web link, p adds a
photo from a file, c replies, and admins set its status with s. A note closed
unsent (esc) is kept, and n opens it again as you left it."""
from __future__ import annotations

from functools import partial

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Footer, Input, Label, OptionList, Select, Static, TextArea
from textual.widgets.option_list import Option

from . import site
from .look import BAD, FAINT, GOLD, GOLD_DIM, GOOD, INK, MUTED, Ask, Confirm, Page, attempt, open_in_browser, plural

WARN = "#e0b25a"
KIND = {"idea": "Idea", "bug": "Bug", "praise": "Praise", "question": "Question", "other": "Other"}
STATUS = {"new": "New", "planned": "Planned", "done": "Done", "closed": "Closed"}
STATUS_STYLE = {"new": GOLD, "planned": WARN, "done": GOOD, "closed": FAINT}
FILTERS = (("open", "Open"), ("new", "New"), ("planned", "Planned"), ("done", "Done"), ("closed", "Closed"), ("all", "All"))


def matches(note: dict, filt: str) -> bool:
    """Whether a note shows under a status filter: open is new and planned."""
    return filt == "all" or (note["status"] in ("new", "planned") if filt == "open" else note["status"] == filt)


def when(stamp: str) -> str:
    """2026-11-11T19:37:00.000Z → 2026-11-11 19:37 (UTC, as the site keeps it)."""
    return stamp[:16].replace("T", " ") if stamp else ""


def link_text(link: dict, sources: dict) -> Text:
    """A linked thing as a few lines: what it is, its name, a line about it, and what it said."""
    what = (link.get("what") or ("Link" if link["app"] == "url" else sources.get(link["app"], link["app"]))).upper()
    t = Text.assemble((f"{what}  ", GOLD), (link.get("title") or link.get("url", ""), f"bold {INK}"))
    if link["app"] == "url":
        t.append("\n" + link["url"], FAINT)
    else:
        if link.get("sub"):
            t.append("\n" + link["sub"], FAINT)
        if link.get("detail"):
            t.append("\n" + link["detail"], MUTED)
    return t


# The note being written, kept when the dialog is closed unsent (esc) or sending fails, so
# it comes back as you left it the next time n is pressed, as the website keeps it.
DRAFT: dict = {}


class WriteDialog(ModalScreen[dict | None]):
    """A new note: what kind, a subject, and what's on your mind. Dismisses with {kind, subject, message}, or None
    (closed unsent: what's typed stays in DRAFT for next time)."""
    BINDINGS = [Binding("escape", "cancel", "Close"), Binding("ctrl+s", "send", "Send", priority=True)]
    DEFAULT_CSS = """
    WriteDialog #message { height: 10; }
    """

    def __init__(self, kinds: list[str]):
        super().__init__()
        self.kinds = kinds or list(KIND)

    def compose(self) -> ComposeResult:
        with VerticalScroll(classes="dialog"):
            yield Label(Text("Write a note to the site's owner", style=f"bold {INK}"))
            yield Static(Text("Only the owner (the site's admins) sees it. After it's sent, l links things on the site to it "
                              "and p adds photos.", style=MUTED))
            yield Label("What kind", classes="lbl")
            kind = DRAFT.get("kind") if DRAFT.get("kind") in self.kinds else self.kinds[0]
            yield Select([(KIND.get(k, k), k) for k in self.kinds], value=kind, allow_blank=False, id="kind")
            yield Label("Subject", classes="lbl")
            yield Input(DRAFT.get("subject", ""), id="subject", placeholder="In a few words", max_length=200)
            yield Label("What's on your mind", classes="lbl")
            yield TextArea(DRAFT.get("message", ""), id="message", soft_wrap=True)
            with Horizontal(classes="buttons"):
                yield Button("Send", id="send")
                yield Button("Close", id="cancel", classes="quiet")
            yield Static(Text("ctrl+s sends, esc closes it and keeps what you wrote for next time", style=FAINT))

    def on_mount(self) -> None:
        self.query_one("#message" if DRAFT.get("subject") else "#subject").focus()
        if DRAFT.get("subject") or DRAFT.get("message"):
            self.app.notify("Your unsent note is just as you left it.", timeout=3)

    def on_input_submitted(self, e: Input.Submitted) -> None:
        self.query_one("#message", TextArea).focus()

    def keep(self) -> None:
        subject = self.query_one("#subject", Input).value
        message = self.query_one("#message", TextArea).text
        DRAFT.clear()
        if subject.strip() or message.strip():
            DRAFT.update(kind=self.query_one("#kind", Select).value, subject=subject, message=message)

    def action_send(self) -> None:
        subject = self.query_one("#subject", Input).value.strip()
        message = self.query_one("#message", TextArea).text.strip()
        if not subject and not message:
            self.app.notify("Say what it's about first.", severity="error", timeout=3)
            return
        self.keep()
        self.dismiss({"kind": self.query_one("#kind", Select).value, "subject": subject, "message": message})

    def action_cancel(self) -> None:
        self.keep()
        self.dismiss(None)

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.action_send() if e.button.id == "send" else self.action_cancel()


class LinkDialog(ModalScreen[list | None]):
    """Pick things on the site to link: an app, a search, then Enter on each one. Dismisses with [{app, id}] picked, or None."""
    BINDINGS = [Binding("escape", "done", "Done")]
    DEFAULT_CSS = """
    LinkDialog #found { height: 14; }
    """

    def __init__(self, sources: list[dict], linked: list[dict]):
        super().__init__()
        self.sources = sources
        self.have = {(l["app"], l.get("id")) for l in linked}
        self.picked: list[dict] = []
        self.items: list[dict] = []
        self.searching = 0

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Label(Text("Link something", style=f"bold {INK}"))
            yield Select([(s["app"], s["id"]) for s in self.sources], value=self.sources[0]["id"], allow_blank=False, id="source")
            yield Input(id="find", placeholder="Search by name")
            yield OptionList(id="found")
            yield Static(Text("Enter links the highlighted one; esc is done", style=FAINT), id="hint")

    def on_mount(self) -> None:
        self.query_one("#find", Input).focus()
        self.search()

    def on_select_changed(self, e: Select.Changed) -> None:
        self.search()

    def on_input_changed(self, e: Input.Changed) -> None:
        self.search()

    def on_input_submitted(self, e: Input.Submitted) -> None:
        self.query_one("#found", OptionList).focus()

    def search(self) -> None:
        self.searching += 1
        n = self.searching
        self.run_worker(partial(self._search, n), exclusive=True)

    async def _search(self, n: int) -> None:
        import asyncio
        app = str(self.query_one("#source", Select).value)
        q = self.query_one("#find", Input).value
        try:
            items = await asyncio.to_thread(site.feedback_linkable, app, q)
        except site.SiteError as e:
            self.app.notify(str(e).removeprefix("the site said: ").capitalize(), severity="error", timeout=4)
            return
        if n != self.searching:
            return
        self.items = items
        self.show()

    def show(self) -> None:
        box = self.query_one("#found", OptionList)
        at = box.highlighted
        box.clear_options()
        if not self.items:
            box.add_option(Option(Text("Nothing by that name.", style=FAINT), disabled=True))
            return
        for it in self.items:
            done = (it["app"], it["id"]) in self.have
            box.add_option(Option(Text.assemble(("✓ " if done else "+ ", GOOD if done else GOLD), (it["title"], f"bold {INK}"),
                                                (f"  {it['sub']}" if it.get("sub") else "", FAINT)), id=f"{it['app']}:{it['id']}"))
        box.highlighted = min(at or 0, len(self.items) - 1)

    def on_option_list_option_selected(self, e: OptionList.OptionSelected) -> None:
        it = self.items[e.option_index] if e.option_index < len(self.items) else None
        if not it or (it["app"], it["id"]) in self.have:
            return
        self.have.add((it["app"], it["id"]))
        self.picked.append({"app": it["app"], "id": it["id"]})
        self.app.notify(f"Linked {it['title']}.", timeout=2)
        self.show()

    def action_done(self) -> None:
        self.dismiss(self.picked)


class PhotoDialog(ModalScreen[dict | None]):
    """A picture file and a caption. Dismisses with {path, caption}, or None."""
    BINDINGS = [Binding("escape", "cancel", "Cancel")]

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Label(Text("Add a photo to your note", style=f"bold {INK}"))
            yield Static(Text(f"A JPEG, PNG, WebP or GIF of at most {site.PHOTO_BYTES // 1024} KB, like a screenshot. "
                              "The website shrinks bigger ones for you.", style=MUTED))
            yield Label("File", classes="lbl")
            yield Input(placeholder="~/Pictures/screenshot.png", id="path")
            yield Label("Caption", classes="lbl")
            yield Input(placeholder="What it shows", id="caption", max_length=300)
            with Horizontal(classes="buttons"):
                yield Button("Add photo", id="ok")
                yield Button("Cancel", id="cancel", classes="quiet")

    def on_mount(self) -> None:
        self.query_one("#path", Input).focus()

    def answer(self) -> None:
        path = self.query_one("#path", Input).value.strip()
        if not path:
            self.app.notify("Say which file.", severity="error", timeout=3)
            return
        self.dismiss({"path": path, "caption": self.query_one("#caption", Input).value.strip()})

    def on_input_submitted(self, e: Input.Submitted) -> None:
        if e.input.id == "path":
            self.query_one("#caption", Input).focus()
        else:
            self.answer()

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.answer() if e.button.id == "ok" else self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class ReplyDialog(ModalScreen[str | None]):
    """A reply on a note. Dismisses with its text, or None."""
    BINDINGS = [Binding("escape", "cancel", "Cancel"), Binding("ctrl+s", "send", "Send", priority=True)]
    DEFAULT_CSS = """
    ReplyDialog #text { height: 8; }
    """

    def __init__(self, to: str):
        super().__init__()
        self.to = to

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Label(Text(f"Reply to {self.to}", style=f"bold {INK}"))
            yield TextArea(id="text", soft_wrap=True)
            with Horizontal(classes="buttons"):
                yield Button("Reply", id="send")
                yield Button("Cancel", id="cancel", classes="quiet")
            yield Static(Text("ctrl+s sends, esc cancels", style=FAINT))

    def on_mount(self) -> None:
        self.query_one("#text", TextArea).focus()

    def action_send(self) -> None:
        text = self.query_one("#text", TextArea).text.strip()
        if text:
            self.dismiss(text)

    def action_cancel(self) -> None:
        self.dismiss(None)

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.action_send() if e.button.id == "send" else self.dismiss(None)


class FeedbackPage(Page):
    WEB_PATH = "/feedback/"
    SIDE = "#notes"
    DEFAULT_CSS = f"""
    FeedbackPage #body {{ padding: 0 2 0 2; height: 1fr; }}
    FeedbackPage #headline {{ color: {INK}; text-style: bold; margin-bottom: 1; }}
    FeedbackPage #main {{ height: 1fr; }}
    FeedbackPage #notes {{ width: 40; height: 1fr; border-right: solid {GOLD_DIM}; margin-right: 2; }}
    FeedbackPage #note {{ width: 1fr; height: 1fr; }}
    FeedbackPage #when {{ color: {GOLD}; }}
    FeedbackPage #title {{ color: {INK}; text-style: bold; }}
    FeedbackPage #by {{ color: {FAINT}; margin-bottom: 1; }}
    FeedbackPage #message, FeedbackPage #status, FeedbackPage #replies {{ margin-bottom: 1; }}
    FeedbackPage .group {{ color: {FAINT}; }}
    FeedbackPage #photos {{ height: auto; max-height: 10; margin-bottom: 1; }}
    FeedbackPage #links {{ height: auto; max-height: 18; margin-bottom: 1; }}
    """
    BINDINGS = [
        Binding("n", "write", "Write"),
        Binding("v", "switch", "Sent/Inbox"),
        Binding("f", "filter", "Status filter", show=False),
        Binding("l", "link", "Link"),
        Binding("u", "url", "Web link", show=False),
        Binding("p", "photo", "Add photo"),
        Binding("c", "reply", "Reply"),
        Binding("s", "status", "Status"),
        Binding("o", "open", "Open", show=False),
        Binding("x", "remove", "Remove", show=False),
        Binding("d", "delete", "Delete", show=False),
        Binding("r", "refresh", "Refresh"),
    ]

    def __init__(self):
        super().__init__()
        self.data: dict | None = None
        self.tab = "mine"
        self.filter = "open"
        self.open: str | None = None
        self.note: dict | None = None
        self.started = False

    def compose(self) -> ComposeResult:
        yield from self.top()
        with Vertical(id="body"):
            yield Static("F E E D B A C K", classes="kicker")
            yield Static(id="headline")
            with Horizontal(id="main"):
                yield OptionList(id="notes")
                with VerticalScroll(id="note"):
                    yield Static(id="when")
                    yield Static(id="title")
                    yield Static(id="by")
                    yield Static(id="message")
                    yield Static(id="status")
                    yield Static(id="photos-head", classes="group")
                    yield OptionList(id="photos")
                    yield Static(id="links-head", classes="group")
                    yield OptionList(id="links")
                    yield Static(id="replies-head", classes="group")
                    yield Static(id="replies")
        yield Footer()

    async def on_mount(self) -> None:
        await self.action_refresh()
        self.query_one("#notes", OptionList).focus()

    # ── loading and showing ───────────────────────────────────────────────

    def notes(self) -> list[dict]:
        return (self.data.get("inbox") or []) if self.tab == "inbox" else self.data["mine"]

    def shown(self) -> list[dict]:
        return [n for n in self.notes() if matches(n, self.filter)]

    @attempt
    async def action_refresh(self) -> None:
        self.data = await self.fetch(site.feedback)
        if not self.started:
            self.started = True
            # Admins start on the inbox when something's waiting there.
            if self.data.get("owner") and any(n["unread"] for n in self.data["inbox"]):
                self.tab = "inbox"
        if not any(n["id"] == self.open for n in self.shown()):
            first = next((n for n in self.shown() if n["unread"]), None) or (self.shown()[0] if self.shown() else None)
            self.open = first["id"] if first else None
        self.note = await self.fetch(site.feedback_note, self.open) if self.open else None
        self.read_open()
        self.show_all()

    def read_open(self) -> None:
        """Opening a note reads it: its line in the list stops being unread, and
        the Feedback count at the top (and in the g menu) goes down to match."""
        for n in self.data["mine"] + (self.data.get("inbox") or []):
            if n["id"] == self.open:
                n["unread"] = False
        waiting = self.data["inbox"] if self.data.get("owner") else self.data["mine"]
        if hasattr(self.app, "set_badge"):
            self.app.set_badge("feedback", sum(1 for n in waiting if n["unread"]))

    def show_all(self) -> None:
        self.show_headline()
        self.show_list()
        self.show_note()

    def show_headline(self) -> None:
        unread = lambda ns: sum(1 for n in ns if n["unread"])  # noqa: E731
        bits = [f"Sent {len(self.data['mine'])}" + (f" ({unread(self.data['mine'])} new)" if unread(self.data["mine"]) else "")]
        if self.data.get("owner"):
            inbox = self.data["inbox"]
            bits.append(f"Inbox {len(inbox)}" + (f" ({unread(inbox)} unread)" if unread(inbox) else ""))
        head = "What people have sent you" if self.tab == "inbox" else "Tell the site's owner what you think"
        self.query_one("#headline", Static).update(Text.assemble((head, f"bold {INK}"), ("   " + " · ".join(bits), FAINT)))

    def show_list(self) -> None:
        box = self.query_one("#notes", OptionList)
        with self.prevent(OptionList.OptionHighlighted):
            box.clear_options()
            where = "INBOX" if self.tab == "inbox" else "SENT"
            box.add_option(Option(Text.assemble((where, f"bold {GOLD}"), (" · ", FAINT), (dict(FILTERS)[self.filter], f"bold {GOLD}"),
                                                ("\n" + ("v sent/inbox, " if self.data.get("owner") else "") + "f status", FAINT)), disabled=True))
            notes = self.shown()
            if not self.notes():
                box.add_option(Option(Text("Nobody has sent anything yet." if self.tab == "inbox" else "Nothing sent yet. Press n to write a note.", style=FAINT), disabled=True))
            elif not notes:
                box.add_option(Option(Text("Nothing with that status.", style=FAINT), disabled=True))
            at = None
            for n in notes:
                bits = ([n["by"]] if self.tab == "inbox" else []) + [KIND.get(n["kind"], n["kind"]), when(n["last_at"])[:10]]
                for count, word in ((n["photos"], "photo"), (n["links"], "link"), (n["replies"], "reply")):
                    if count:
                        bits.append(plural(count, word) if word != "reply" else f"{count} {'reply' if count == 1 else 'replies'}")
                new = ("UNREAD " if n.get("why") == "note" else "NEW REPLY ") if n["unread"] else ""
                box.add_option(Option(Text.assemble(("● " if n["unread"] else "", BAD), (STATUS.get(n["status"], n["status"]).upper() + " ", STATUS_STYLE.get(n["status"], FAINT)),
                                                    (new, f"bold {BAD}"),
                                                    (n["subject"], f"bold {INK}"), ("\n" + " · ".join(bits), FAINT)), id=n["id"]))
                if n["id"] == self.open:
                    at = box.option_count - 1
            if at is not None:
                box.highlighted = at

    def show_note(self) -> None:
        n = self.note
        parts = ["#when", "#by", "#message", "#status", "#photos-head", "#photos", "#links-head", "#links", "#replies-head", "#replies"]
        for part in parts:
            self.query_one(part).display = bool(n)
        if not n:
            self.query_one("#title", Static).update(Text(
                "Notes people send will show up here." if self.tab == "inbox" else
                "Ideas, bugs, praise or questions go straight to the site's owner, and only to them. Press n to write one.", style=MUTED))
            return
        self.query_one("#when", Static).update(" · ".join([KIND.get(n["kind"], n["kind"]).upper(), STATUS.get(n["status"], n["status"]).upper(), when(n["created"])]))
        self.query_one("#title", Static).update(Text.assemble(n["subject"] or "(no subject)", ("  ● NEW" if n.get("new_to_you") else "", f"bold {BAD}")))
        self.query_one("#by", Static).update(
            ("From you · the owner has read it" if n["seen_by_owner"] else "From you · not read yet") if n["yours"]
            else f"From {n['by']}" + (f" ({n['username']})" if n.get("username") else ""))
        self.query_one("#message", Static).update(Text(n.get("message", ""), style=INK))
        self.query_one("#message").display = bool(n.get("message"))
        status = Text("Status  ", style=FAINT)
        for s in self.data["statuses"]:
            on = s == n["status"]
            status.append(f" {STATUS.get(s, s)} ", f"bold {STATUS_STYLE.get(s, INK)} reverse" if on else MUTED)
            status.append(" ")
        if n["can_set_status"]:
            status.append(" s changes it", FAINT)
        self.query_one("#status", Static).update(status)

        photos = self.query_one("#photos", OptionList)
        tail = "  o opens one in your browser" + (", p adds more" if n["can_add_photos"] else "") if n["photos"] else ("  none; p adds one" if n["can_add_photos"] else "  none")
        self.query_one("#photos-head", Static).update(f"PHOTOS ({len(n['photos'])}){tail}" if n["photos"] else f"PHOTOS{tail}")
        photos.display = bool(n["photos"])
        at = photos.highlighted
        photos.clear_options()
        for ph in n["photos"]:
            photos.add_option(Option(Text.assemble(("▣ ", GOLD), (ph["caption"] or "a photo", INK), (f" · {when(ph['created'])}", FAINT)), id=ph["id"]))
        if n["photos"]:
            photos.highlighted = min(at or 0, len(n["photos"]) - 1)

        sources = {s["id"]: s["name"] for s in self.data["sources"]}
        links = self.query_one("#links", OptionList)
        self.query_one("#links-head", Static).update(
            f"LINKED ({len(n['links'])})" + ("  l links more, u a web link, o opens one" if n["can_edit"] else "  o opens one") if n["links"]
            else "LINKED  nothing" + ("; l links something on the site, u a web link" if n["can_edit"] else ""))
        links.display = bool(n["links"])
        at = links.highlighted
        links.clear_options()
        for i, l in enumerate(n["links"]):
            links.add_option(Option(link_text(l, sources), id=f"link-{i}"))
        if n["links"]:
            links.highlighted = min(at or 0, len(n["links"]) - 1)

        self.query_one("#replies-head", Static).update(f"REPLIES ({len(n['replies'])})  c replies" if n["replies"] else "REPLIES  none yet; c replies")
        replies = Text()
        for i, r in enumerate(n["replies"]):
            if i:
                replies.append("\n\n")
            # A reply since you last looked has a red bar and says NEW.
            bar, bar_style = ("│ ", BAD) if r.get("unread") else ("│ " if r["from_owner"] else "  ", GOLD)
            replies.append(bar, bar_style)
            replies.append("You" if r["yours"] else r["by"], f"bold {INK}")
            replies.append((" · the owner" if r["from_owner"] and not r["yours"] else "") + f" · {when(r['created'])}", FAINT)
            replies.append("  ● NEW" if r.get("unread") else "", f"bold {BAD}")
            replies.append("\n")
            replies.append(bar, bar_style)
            replies.append(r["text"].replace("\n", "\n" + bar), INK)
        self.query_one("#replies", Static).update(replies)
        self.query_one("#replies").display = bool(n["replies"])

    async def changed(self, note: dict) -> None:
        """After a change: the note as the site sent it back, and the list again."""
        self.note = note
        self.open = note["id"]
        self.data = await self.fetch(site.feedback)
        self.read_open()
        self.show_all()

    # ── moving around ─────────────────────────────────────────────────────

    @attempt
    async def on_option_list_option_highlighted(self, e: OptionList.OptionHighlighted) -> None:
        if e.option_list.id == "notes" and e.option.id and e.option.id != self.open:
            self.open = e.option.id
            note = await self.fetch(site.feedback_note, self.open)
            if self.open == e.option.id:
                self.note = note
                self.read_open()
                self.show_headline()
                self.show_list()
                self.show_note()

    async def action_switch(self) -> None:
        if not (self.data and self.data.get("owner")):
            return
        self.tab = "mine" if self.tab == "inbox" else "inbox"
        self.open = None
        await self.action_refresh()

    async def action_filter(self) -> None:
        ids = [f for f, _ in FILTERS]
        self.filter = ids[(ids.index(self.filter) + 1) % len(ids)]
        self.open = None
        await self.action_refresh()

    def check_action(self, action: str, parameters: tuple) -> bool | None:
        if isinstance(self.focused, (Input, TextArea)) and action not in ("back",):
            return False
        return True

    def action_web(self) -> None:
        open_in_browser(self.app, site.site_url("/feedback/" + (f"#{self.open}" if self.open else "")))

    # ── writing ───────────────────────────────────────────────────────────

    def action_write(self) -> None:
        async def done(fields: dict | None) -> None:
            if fields:
                await self.send(fields)
        self.app.push_screen(WriteDialog((self.data or {}).get("kinds", [])), done)

    @attempt
    async def send(self, fields: dict) -> None:
        note = await self.fetch(site.send_feedback, fields)
        DRAFT.clear()
        self.tab, self.filter = "mine", "open"
        await self.changed(note)
        self.app.notify("Sent. Thank you! l links things to it, p adds photos.", timeout=4)

    def action_link(self) -> None:
        n = self.note
        if not n or not n["can_edit"]:
            return
        if not self.data["sources"]:
            self.app.notify("None of your apps have anything to link yet; u adds a web link.", severity="error", timeout=4)
            return

        async def done(picked: list | None) -> None:
            if picked:
                await self.set_links(n, n["links"] + picked)
        self.app.push_screen(LinkDialog(self.data["sources"], n["links"]), done)

    def action_url(self) -> None:
        n = self.note
        if not n or not n["can_edit"]:
            return

        async def done(url: str | None) -> None:
            if url and url.strip():
                await self.set_links(n, n["links"] + [{"app": "url", "url": url.strip()}])
        self.app.push_screen(Ask("Add a web link", "Any page: on this site or anywhere else.", placeholder="https://…", ok="Add"), done)

    @attempt
    async def set_links(self, n: dict, links: list[dict]) -> None:
        keep = [{"app": "url", "url": l["url"], "title": l.get("title", "")} if l["app"] == "url" else {"app": l["app"], "id": l["id"]} for l in links]
        await self.changed(await self.fetch(site.update_feedback, n["id"], {"links": keep}))

    def action_photo(self) -> None:
        n = self.note
        if not n or not n["can_add_photos"]:
            return

        async def done(got: dict | None) -> None:
            if got:
                await self.add_photo(n, got)
        self.app.push_screen(PhotoDialog(), done)

    @attempt
    async def add_photo(self, n: dict, got: dict) -> None:
        await self.changed(await self.fetch(site.add_feedback_photo, n["id"], got["path"], got["caption"]))
        self.app.notify("Photo added.", timeout=2)

    def action_reply(self) -> None:
        n = self.note
        if not n:
            return

        async def done(text: str | None) -> None:
            if text:
                await self.reply(n, text)
        self.app.push_screen(ReplyDialog("the owner" if n["yours"] else n["by"]), done)

    @attempt
    async def reply(self, n: dict, text: str) -> None:
        await self.changed(await self.fetch(site.reply_feedback, n["id"], text))
        self.app.notify("Reply sent.", timeout=2)

    @attempt
    async def action_status(self) -> None:
        n = self.note
        if not n or not n["can_set_status"]:
            return
        order = self.data["statuses"]
        nxt = order[(order.index(n["status"]) + 1) % len(order)] if n["status"] in order else order[0]
        await self.changed(await self.fetch(site.update_feedback, n["id"], {"status": nxt}))
        self.app.notify(f"Marked {STATUS.get(nxt, nxt).lower()}.", timeout=2)

    # ── the highlighted photo or link ─────────────────────────────────────

    def highlighted(self) -> tuple[str, dict] | None:
        """("photo" | "link", it): whichever list has the focus, else the photos."""
        n = self.note
        if not n:
            return None
        for kind, key in (("link", "links"), ("photo", "photos")):
            box = self.query_one(f"#{key}", OptionList)
            if (self.focused is box or kind == "photo") and n[key] and box.highlighted is not None:
                return kind, n[key][box.highlighted]
        return None

    def action_open(self) -> None:
        got = self.highlighted()
        if not got:
            return
        kind, it = got
        if kind == "photo":
            open_in_browser(self.app, site.site_url(f"/feedback/api/photos/{it['id']}"))
        else:
            open_in_browser(self.app, it["url"] if it["app"] == "url" else site.site_url(it.get("href") or "/"))

    def action_remove(self) -> None:
        got = self.highlighted()
        n = self.note
        if not got:
            return
        kind, it = got
        if kind == "photo" and not it["can_remove"] or kind == "link" and not n["can_edit"]:
            return

        async def answer(yes: bool | None) -> None:
            if yes:
                await self.remove(n, kind, it)
        name = it.get("caption") or "this photo" if kind == "photo" else it.get("title") or it.get("url")
        self.app.push_screen(Confirm(f"Take {name} off?", yes="Remove", danger=True), answer)

    @attempt
    async def remove(self, n: dict, kind: str, it: dict) -> None:
        if kind == "photo":
            await self.changed(await self.fetch(site.remove_feedback_photo, n["id"], it["id"]))
        else:
            await self.set_links(n, [l for l in n["links"] if l is not it])

    def action_delete(self) -> None:
        n = self.note
        if not n or not n["can_delete"]:
            return

        async def answer(yes: bool | None) -> None:
            if yes:
                await self.delete(n)
        self.app.push_screen(Confirm(f"Delete “{n['subject'] or 'this note'}”?", "Its photos and replies go too.", yes="Delete", danger=True), answer)

    @attempt
    async def delete(self, n: dict) -> None:
        await self.fetch(site.delete_feedback, n["id"])
        self.open = None
        await self.action_refresh()
