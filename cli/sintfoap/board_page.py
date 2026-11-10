"""Recipe board in the terminal: the same board as /board/.

Your feed and the other views down the left, then every category, starred if
you follow it (f stars the highlighted one). The posts of whichever is open
sit on the right, newest first, with the highlighted one's recipe under them;
s saves it into your Recipe box, n shares one of yours."""
from __future__ import annotations

from datetime import datetime, timezone

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Footer, Input, Label, OptionList, Select, Static, TextArea
from textual.widgets.option_list import Option

from . import site
from .look import FAINT, GOLD, GOLD_DIM, INK, MUTED, Ask, Confirm, Page, attempt, plural

VIEWS = [("feed", "Your feed"), ("all", "Everything"), ("mine", "Shared by you"), ("saved", "Saved")]
BLURB = {"all": "Every recipe on the board.", "mine": "The recipes you've posted.", "saved": "Recipes you've saved to your Recipe box."}


def ago(iso: str, now: datetime | None = None) -> str:
    try:
        then = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return ""
    s = ((now or datetime.now(timezone.utc)) - then).total_seconds()
    if s < 60:
        return "just now"
    if s < 3600:
        return f"{int(s // 60)} min ago"
    if s < 86400:
        return f"{int(s // 3600)} hr ago"
    if s < 86400 * 7:
        return plural(int(s // 86400), "day") + " ago"
    return then.strftime("%-d %b %Y")


class ShareDialog(ModalScreen[dict | None]):
    """A new post (from your Recipe box, a link, or typed in), or an edit of one. Dismisses with what to send, or None."""
    BINDINGS = [Binding("escape", "cancel", "Cancel"), Binding("ctrl+s", "save", "Post", priority=True)]
    DEFAULT_CSS = """
    ShareDialog .grid { height: auto; }
    ShareDialog .grid > Vertical { height: auto; width: 1fr; margin-right: 1; }
    ShareDialog #ingredients, ShareDialog #steps { height: 7; }
    ShareDialog #note { height: 3; }
    ShareDialog .part { height: auto; }
    """

    def __init__(self, board: dict, category: str = "", post: dict | None = None, recipe_id: str = ""):
        super().__init__()
        self.board, self.post = board, post
        self.category = (post or {}).get("category") or category or next((c["id"] for c in board["categories"] if c["following"]), "") \
            or (board["categories"][0]["id"] if board["categories"] else "")
        self.recipe_id = recipe_id
        froms = [("Type it in", "typed")] if post else []
        if not post:
            if board.get("recipe_box") and board.get("recipes"):
                froms.append(("From my Recipe box", "box"))
            froms += [("From a link", "url"), ("Type it in", "typed")]
        self.froms = froms

    def compose(self) -> ComposeResult:
        p = self.post or {}
        r = p.get("recipe") or {}
        with VerticalScroll(classes="dialog"):
            yield Label(Text("Edit post" if self.post else "Share a recipe", style=f"bold {INK}"))
            yield Label("Category", classes="lbl")
            yield Select([(c["name"], c["id"]) for c in self.board["categories"]], value=self.category or Select.BLANK, allow_blank=False, id="category")
            if not self.post:
                yield Label("The recipe", classes="lbl")
                yield Select(self.froms, value=self.froms[0][1], allow_blank=False, id="from")
            with Vertical(classes="part", id="part-box"):
                recipes = self.board.get("recipes") or []
                if recipes:
                    pick = self.recipe_id if any(x["id"] == self.recipe_id for x in recipes) else recipes[0]["id"]
                    yield Label("Recipe", classes="lbl")
                    yield Select([(x["title"], x["id"]) for x in recipes], value=pick, allow_blank=False, id="recipe_id")
            with Vertical(classes="part", id="part-url"):
                yield Label("Link to the recipe", classes="lbl")
                yield Input(id="url", placeholder="https://…")
            with Vertical(classes="part", id="part-typed"):
                yield Label("Title", classes="lbl")
                yield Input(p.get("title", ""), id="title", max_length=200)
                with Horizontal(classes="grid"):
                    with Vertical():
                        yield Label("Serves", classes="lbl")
                        s = r.get("servings")
                        yield Input("" if s is None else (str(int(s)) if s == int(s) else str(s)), id="servings", type="number")
                    with Vertical():
                        yield Label("Makes", classes="lbl")
                        yield Input(r.get("yield", ""), id="yield", placeholder="12 cookies", max_length=100)
                    with Vertical():
                        yield Label("Time", classes="lbl")
                        yield Input(r.get("time", ""), id="time", placeholder="45 min", max_length=50)
                yield Label("Ingredients, one per line", classes="lbl")
                yield TextArea("\n".join(r.get("ingredients", [])), id="ingredients", soft_wrap=True)
                yield Label("Steps, one per line", classes="lbl")
                yield TextArea("\n".join(r.get("steps", [])), id="steps", soft_wrap=True)
                yield Label("Link (optional)", classes="lbl")
                yield Input(r.get("source", ""), id="source")
            yield Label("A note for everyone (optional)", classes="lbl")
            yield TextArea(p.get("note", ""), id="note", soft_wrap=True)
            with Horizontal(classes="buttons"):
                yield Button("Save" if self.post else "Post", id="save")
                yield Button("Cancel", id="cancel", classes="quiet")
            yield Static(Text("ctrl+s posts, esc cancels", style=FAINT))

    def on_mount(self) -> None:
        if self.recipe_id and any(v == "box" for _, v in self.froms):
            self.query_one("#from", Select).value = "box"
        self.show_from()
        self.query_one("#category", Select).focus()

    def chosen(self) -> str:
        return "typed" if self.post else self.query_one("#from", Select).value

    def show_from(self) -> None:
        f = self.chosen()
        for part in ("box", "url", "typed"):
            self.query_one(f"#part-{part}").display = part == f

    def on_select_changed(self, e: Select.Changed) -> None:
        if e.select.id == "from":
            self.show_from()

    def fields(self) -> dict:
        v = lambda i: self.query_one(f"#{i}", Input).value.strip()  # noqa: E731
        t = lambda i: self.query_one(f"#{i}", TextArea).text  # noqa: E731
        out = {"category": self.query_one("#category", Select).value, "note": t("note").strip()}
        f = self.chosen()
        if f == "box":
            out["recipe_id"] = self.query_one("#recipe_id", Select).value
        elif f == "url":
            out["url"] = v("url")
        else:
            try:
                serves = float(v("servings")) if v("servings") else None
            except ValueError:
                serves = None
            was = (self.post or {}).get("recipe") or {}
            out["title"] = v("title")
            out["recipe"] = {"ingredients": t("ingredients"), "steps": t("steps"), "servings": serves, "yield": v("yield"),
                             "time": v("time"), "source": v("source"),
                             **({"notes": was.get("notes", ""), "image": was.get("image", "")} if was else {})}
        return out

    def action_save(self) -> None:
        f = self.fields()
        if "url" in f and not f["url"]:
            self.app.notify("Paste the link to the recipe.", severity="error", timeout=3)
            return
        if "title" in f and not f["title"]:
            self.app.notify("Give the recipe a title.", severity="error", timeout=3)
            self.query_one("#title", Input).focus()
            return
        self.dismiss(f)

    def action_cancel(self) -> None:
        self.dismiss(None)

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.action_save() if e.button.id == "save" else self.dismiss(None)


class BoardPage(Page):
    WEB_PATH = "/board/"
    SIDE = "#side"
    DEFAULT_CSS = f"""
    BoardPage #body {{ padding: 0 2 0 2; height: 1fr; }}
    BoardPage #main {{ height: 1fr; }}
    BoardPage #side {{ width: 30; height: 1fr; border-right: solid {GOLD_DIM}; margin-right: 2; }}
    BoardPage #right {{ width: 1fr; height: 1fr; }}
    BoardPage #heading {{ color: {INK}; text-style: bold; }}
    BoardPage #sub {{ color: {FAINT}; margin-bottom: 1; }}
    BoardPage #posts {{ height: 2fr; min-height: 6; border-bottom: solid {GOLD_DIM}; }}
    BoardPage #post {{ height: 3fr; padding-top: 1; }}
    BoardPage #post-title {{ color: {INK}; text-style: bold; }}
    BoardPage #post-meta {{ color: {FAINT}; margin-bottom: 1; }}
    BoardPage .group {{ color: {FAINT}; }}
    BoardPage #ingredients, BoardPage #steps, BoardPage #notes, BoardPage #note {{ margin-bottom: 1; }}
    """
    BINDINGS = [
        Binding("n", "share", "Share"),
        Binding("f", "follow", "Follow"),
        Binding("s", "save", "Save to box"),
        Binding("c", "category", "New category"),
        Binding("m", "older", "Older"),
        Binding("e", "edit", "Edit", show=False),
        Binding("d", "delete", "Delete", show=False),
        Binding("r", "refresh", "Refresh"),
        Binding("backslash", "fold", "Side"),
    ]

    def __init__(self, share: str = ""):
        super().__init__()
        self.board: dict | None = None
        self.at: dict = {"view": "feed", "category": ""}
        self.posts: list[dict] = []
        self.more = False
        self.open: str | None = None
        self.share_id = share

    def compose(self) -> ComposeResult:
        yield from self.top()
        with Vertical(id="body"):
            yield Static("R E C I P E   B O A R D", classes="kicker")
            with Horizontal(id="main"):
                yield OptionList(id="side")
                with Vertical(id="right"):
                    yield Static(id="heading")
                    yield Static(id="sub")
                    yield OptionList(id="posts")
                    with VerticalScroll(id="post"):
                        yield Static(id="post-title")
                        yield Static(id="post-meta")
                        yield Static(id="note")
                        yield Static("INGREDIENTS", classes="group", id="ing-head")
                        yield Static(id="ingredients")
                        yield Static("STEPS", classes="group", id="steps-head")
                        yield Static(id="steps")
                        yield Static("NOTES", classes="group", id="notes-head")
                        yield Static(id="notes")
        yield Footer()

    async def on_mount(self) -> None:
        await self.action_refresh()
        self.query_one("#side", OptionList).focus()
        if self.share_id:
            self.action_share(self.share_id)
            self.share_id = ""

    # ── loading and showing ───────────────────────────────────────────────

    @attempt
    async def action_refresh(self) -> None:
        self.board = await self.fetch(site.board)
        await self.load()

    async def load(self, older: bool = False) -> None:
        before = self.posts[-1]["created"] if older and self.posts else ""
        out = await self.fetch(site.board_posts, self.at["view"], self.at["category"], before)
        self.posts = self.posts + out["posts"] if older else out["posts"]
        self.more = out["more"]
        if not self.at["category"] and self.at["view"] == "feed" and not older:
            self.board["unread"] = 0
        if not older:
            self.open = "featured" if self.featured() else self.posts[0]["id"] if self.posts else None
        self.show_nav()
        self.show_top()
        self.show_posts()
        self.show_post()

    def cat(self, cid: str) -> dict | None:
        return next((c for c in (self.board or {}).get("categories", []) if c["id"] == cid), None)

    def show_nav(self) -> None:
        if not self.board:
            return
        side = self.query_one("#side", OptionList)
        keep = side.highlighted
        with self.prevent(OptionList.OptionHighlighted):
            side.clear_options()
            for vid, name in VIEWS:
                here = not self.at["category"] and self.at["view"] == vid
                t = Text(("▸ " if here else "  ") + name, style=f"bold {INK}" if here else MUTED)
                if vid == "feed" and self.board.get("unread"):
                    t.append(f"  {self.board['unread']} new", style=f"bold {GOLD}")
                side.add_option(Option(t, id="v:" + vid))
            side.add_option(Option(Text("\nCATEGORIES   f follows", style=FAINT), disabled=True))
            for c in self.board["categories"]:
                here = self.at["category"] == c["id"]
                t = Text.assemble(("★ " if c["following"] else "☆ ", GOLD if c["following"] else FAINT),
                                  (c["name"], f"bold {INK}" if here else MUTED), (f"  {c['posts']}" if c["posts"] else "", FAINT))
                side.add_option(Option(t, id="c:" + c["id"]))
        if keep is not None:
            side.highlighted = min(keep, side.option_count - 1)

    def show_top(self) -> None:
        c = self.cat(self.at["category"])
        if c:
            head, sub = c["name"] + ("  ★ following" if c["following"] else ""), \
                f"{plural(c['posts'], 'recipe')} · {c['followers']} following" + ("" if c["following"] else " · f to follow")
        else:
            head = dict(VIEWS)[self.at["view"]]
            if self.at["view"] == "feed":
                n = sum(1 for x in self.board["categories"] if x["following"])
                sub = f"New recipes in the {n} categor{'y' if n == 1 else 'ies'} you follow." if n \
                    else "Star a category on the left (f) to follow it, and its new recipes show up here."
            else:
                sub = BLURB[self.at["view"]]
        self.query_one("#heading", Static).update(head)
        self.query_one("#sub", Static).update(sub)

    def featured(self) -> dict | None:
        """The recipe of the day, when the feed or Everything is open."""
        f = (self.board or {}).get("featured")
        return f if f and not self.at["category"] and self.at["view"] in ("feed", "all") else None

    def show_posts(self) -> None:
        box = self.query_one("#posts", OptionList)
        with self.prevent(OptionList.OptionHighlighted):
            box.clear_options()
            f = self.featured()
            if f:
                t = Text.assemble(("★ RECIPE OF THE DAY  ", f"bold {GOLD}"), (f["title"], f"bold {INK}"), ("  ✓ saved" if f["saved"] else "", GOLD_DIM))
                t.append(f"\n{f['category_name']}", style=GOLD_DIM)
                t.append(f" · shared by {f['by']}", style=FAINT)
                box.add_option(Option(t, id="featured"))
            if not self.posts:
                none = "You don't follow any categories yet." if not self.at["category"] and self.at["view"] == "feed" \
                    and not any(c["following"] for c in self.board["categories"]) else "No recipes here yet. Press n to share one."
                box.add_option(Option(Text(none, style=FAINT), disabled=True))
                return
            for p in self.posts:
                t = Text.assemble((p["title"], f"bold {INK}"), ("  new" if p.get("new") else "", f"bold {GOLD}"),
                                  ("  ✓ saved" if p["saved"] else "", GOLD_DIM))
                t.append(f"\n{p['category_name']}", style=GOLD_DIM)
                t.append(f" · {p['by']} · {ago(p['created'])}" + (f" · saved {p['saves']}×" if p["saves"] else ""), style=FAINT)
                box.add_option(Option(t, id=p["id"]))
            if self.more:
                box.add_option(Option(Text("Older…  m", style=GOLD_DIM), id="more"))
            skip = 1 if f else 0
            box.highlighted = 0 if self.open == "featured" else next((i + skip for i, p in enumerate(self.posts) if p["id"] == self.open), 0)

    def current(self) -> dict | None:
        if self.open == "featured":
            return self.featured()
        return next((p for p in self.posts if p["id"] == self.open), None)

    def show_post(self) -> None:
        p = self.current()
        for w in ("#post-meta", "#note", "#ing-head", "#ingredients", "#steps-head", "#steps", "#notes-head", "#notes"):
            self.query_one(w).display = bool(p)
        if not p:
            self.query_one("#post-title", Static).update("")
            return
        r = p["recipe"]
        self.query_one("#post-title", Static).update(("★ Recipe of the day: " if self.open == "featured" else "") + p["title"])
        bits = [b for b in (r.get("time"), f"serves {r['servings']:g}" if r.get("servings") else r.get("yield"), r.get("source")) if b]
        meta = Text(f"{p['category_name']} · shared by {p['by']}", style=GOLD_DIM)
        if bits:
            meta.append("\n" + " · ".join(bits), style=FAINT)
        if self.board.get("recipe_box"):
            meta.append("\n" + ("Saved in your Recipe box" if p["saved"] else "s saves it to your Recipe box"), style=GOLD if not p["saved"] else FAINT)
        if p["can_edit"]:
            meta.append("   e edits · d deletes", style=FAINT)
        self.query_one("#post-meta", Static).update(meta)
        self.query_one("#note").display = bool(p["note"])
        self.query_one("#note", Static).update(Text(p["note"], style=MUTED))
        ing = Text()
        for i, line in enumerate(r["ingredients"]):
            ing.append(("" if i == 0 else "\n") + "• ", style=GOLD)
            ing.append(line, style=INK)
        steps = Text()
        for i, s in enumerate(r["steps"], 1):
            steps.append(f"{'' if i == 1 else chr(10) + chr(10)}{i}. ", style=f"bold {GOLD}")
            steps.append(s, style=INK)
        for key, body, w in (("ing", ing, "ingredients"), ("steps", steps, "steps"), ("notes", Text(r.get("notes", ""), style=MUTED), "notes")):
            self.query_one(f"#{key}-head").display = bool(body.plain)
            self.query_one(f"#{w}").display = bool(body.plain)
            self.query_one(f"#{w}", Static).update(body)

    # ── moving around ─────────────────────────────────────────────────────

    async def on_option_list_option_selected(self, e: OptionList.OptionSelected) -> None:
        oid = e.option.id or ""
        if e.option_list.id == "side":
            if oid.startswith("v:"):
                await self.go(view=oid[2:])
            elif oid.startswith("c:"):
                await self.go(category=oid[2:])
            if self.posts:
                self.query_one("#posts", OptionList).focus()
        elif e.option_list.id == "posts" and oid == "more":
            await self.action_older()

    def on_option_list_option_highlighted(self, e: OptionList.OptionHighlighted) -> None:
        if e.option_list.id == "posts" and e.option.id and e.option.id != "more" and e.option.id != self.open:
            self.open = e.option.id
            self.show_post()

    @attempt
    async def go(self, view: str = "feed", category: str = "") -> None:
        self.at = {"view": view, "category": category}
        await self.load()

    @attempt
    async def action_older(self) -> None:
        if self.more:
            await self.load(older=True)

    def highlighted_category(self) -> dict | None:
        side = self.query_one("#side", OptionList)
        if self.focused is side and side.highlighted is not None:
            oid = side.get_option_at_index(side.highlighted).id or ""
            if oid.startswith("c:"):
                return self.cat(oid[2:])
        return self.cat(self.at["category"])

    def check_action(self, action: str, parameters: tuple) -> bool | None:
        if action in ("share", "follow", "save", "category", "older", "edit", "delete", "refresh") and isinstance(self.focused, (Input, TextArea)):
            return False
        return True

    # ── following, saving, sharing ────────────────────────────────────────

    @attempt
    async def action_follow(self) -> None:
        c = self.highlighted_category()
        if not c:
            self.app.notify("Highlight a category on the left to follow it.", timeout=3)
            return
        c.update(await self.fetch(site.follow_board_category, c["id"], not c["following"]))
        self.app.notify(f"Following {c['name']}; its new recipes go in your feed." if c["following"] else f"Stopped following {c['name']}.", timeout=3)
        if not self.at["category"] and self.at["view"] == "feed":
            await self.load()
        else:
            self.show_nav()
            self.show_top()

    @attempt
    async def action_save(self) -> None:
        p = self.current()
        if not p:
            return
        if not self.board.get("recipe_box"):
            self.app.notify("Ask the site's admin for Recipe box to save recipes from here.", timeout=4)
            return
        out = await self.fetch(site.save_board_post, p["id"])
        for x in [p, (self.board or {}).get("featured"), *self.posts]:
            if x and x["id"] == p["id"] and not x["saved"]:
                x["saved"], x["saves"] = True, x["saves"] + 1
        self.app.notify(f"{p['title']} is already in your Recipe box." if out["already"] else f"Saved {p['title']} to your Recipe box.", timeout=3)
        self.show_posts()
        self.show_post()

    def action_category(self) -> None:
        async def made(name: str | None) -> None:
            if name and name.strip():
                await self.new_category(name.strip())
        self.app.push_screen(Ask("New category", "Anyone on the board can post in it. You follow what you start.", placeholder="Grilling", ok="Add"), made)

    @attempt
    async def new_category(self, name: str) -> None:
        c = await self.fetch(site.add_board_category, name)
        self.board["categories"] = sorted(self.board["categories"] + [c], key=lambda x: x["name"].casefold())
        await self.go(category=c["id"])

    def action_share(self, recipe_id: str = "") -> None:
        if not self.board or not self.board["categories"]:
            return
        self.app.push_screen(ShareDialog(self.board, self.at["category"], recipe_id=recipe_id), self.after(None))

    def action_edit(self) -> None:
        p = self.current()
        if p and p["can_edit"]:
            self.app.push_screen(ShareDialog(self.board, post=p), self.after(p))

    def after(self, was: dict | None):
        async def done(fields: dict | None) -> None:
            if fields is not None:
                await self.send(was, fields)
        return done

    @attempt
    async def send(self, was: dict | None, fields: dict) -> None:
        if was:
            p = await self.fetch(site.update_board_post, was["id"], fields)
            self.posts = [p if x["id"] == p["id"] else x for x in self.posts]
            self.board = await self.fetch(site.board)
            self.app.notify(f"Saved {p['title']}.", timeout=2)
            self.show_nav()
            self.show_posts()
            self.show_post()
            return
        if "url" in fields:
            self.app.notify("Reading that page…", timeout=2)
        p = await self.fetch(site.add_board_post, fields)
        self.board = await self.fetch(site.board)
        self.app.notify(f"Posted {p['title']} in {p['category_name']}.", timeout=3)
        self.at = {"view": "feed", "category": p["category"]}
        await self.load()
        self.open = p["id"]
        self.show_posts()
        self.show_post()

    def action_delete(self) -> None:
        p = self.current()
        if not p or not p["can_edit"]:
            return

        async def answer(yes: bool | None) -> None:
            if yes:
                await self.delete(p)
        self.app.push_screen(Confirm(f"Take {p['title']} off the board?", "Copies people saved stay in their Recipe box.", yes="Delete", danger=True), answer)

    @attempt
    async def delete(self, p: dict) -> None:
        await self.fetch(site.delete_board_post, p["id"])
        self.board = await self.fetch(site.board)
        self.posts = [x for x in self.posts if x["id"] != p["id"]]
        self.open = self.posts[0]["id"] if self.posts else None
        self.show_nav()
        self.show_top()
        self.show_posts()
        self.show_post()
