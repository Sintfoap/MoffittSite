"""Recipe board in the terminal: the same board as /board/.

Your feed and the other views down the left, then every category, starred if
you follow it (f stars the highlighted one, or just one of its values). The categories are the label keys
from Recipe labels: a post is under every key its labels use, and the open key
lists its values to narrow it down. The posts of whichever is open sit on the
right, newest first, with the highlighted one's recipe under them; s saves it
into your Recipe box, n shares one of yours (tick its labels to file it)."""
from __future__ import annotations

from datetime import datetime, timezone

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Footer, Input, Label, OptionList, Select, SelectionList, Static, TextArea
from textual.widgets.option_list import Option
from textual.widgets.selection_list import Selection

from . import site
from .look import FAINT, GOLD, GOLD_DIM, INK, MUTED, Ask, Confirm, Page, attempt, plural

VIEWS = [("feed", "Your feed"), ("all", "Everything"), ("mine", "Shared by you"), ("saved", "Saved")]
def label_line(p: dict) -> str:
    """"Course: Dinner · Cuisine: Irish"."""
    return " · ".join(f"{lb['key']}: {lb['value']}" if lb["value"] else lb["key"] for lb in (p.get("recipe") or {}).get("labels", []))


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
    ShareDialog #labels { height: auto; max-height: 10; background: transparent; border: none; padding: 0; }
    """

    def __init__(self, board: dict, label: str = "", post: dict | None = None, recipe_id: str = ""):
        super().__init__()
        self.board, self.post = board, post
        self.label = label   # the value open on the board, ticked to start with
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
            if p.get("from_box"):
                yield Label(Text("This post is a recipe in a Recipe box, so what you change here changes there too "
                                 "(the note is just the post's).", style=FAINT), id="synced-hint")
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
            yield Label("Labels: it shows under each one's category (space ticks)", classes="lbl")
            if self.board.get("label_list"):
                yield SelectionList(*[Selection(Text.assemble((lb["key"], f"bold {GOLD}"), ("  " + (lb["value"] or "yes"), INK)), lb["id"])
                                      for lb in self.board["label_list"]], id="labels")
            else:
                yield Static(Text("No labels yet, so it goes in Everything only. Whoever keeps Recipe labels adds them.", style=FAINT))
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
        self.tick(self.start_labels())
        self.query_one("#from" if not self.post else "#title").focus()

    def start_labels(self) -> list[str]:
        if self.post:
            return [lb["id"] for lb in self.post["recipe"].get("labels", [])]
        if self.chosen() == "box":
            return self.box_labels()
        return [self.label] if self.label else []

    def box_labels(self) -> list[str]:
        """The labels of the recipe picked from your Recipe box."""
        rid = self.query_one("#recipe_id", Select).value if self.query("#recipe_id") else ""
        return next((x.get("labels", []) for x in self.board.get("recipes", []) if x["id"] == rid), [])

    def tick(self, ids: list[str]) -> None:
        if not self.query("#labels"):
            return
        box = self.query_one("#labels", SelectionList)
        box.deselect_all()
        for i in ids:
            try:
                box.select(i)
            except Exception:
                pass

    def picked(self) -> list[str]:
        return list(self.query_one("#labels", SelectionList).selected) if self.query("#labels") else []

    def chosen(self) -> str:
        return "typed" if self.post else self.query_one("#from", Select).value

    def show_from(self) -> None:
        f = self.chosen()
        for part in ("box", "url", "typed"):
            self.query_one(f"#part-{part}").display = part == f

    def on_select_changed(self, e: Select.Changed) -> None:
        if e.select.id == "from":
            self.show_from()
            if e.value == "box":
                self.tick(self.box_labels())
        elif e.select.id == "recipe_id":
            self.tick(self.box_labels())

    def fields(self) -> dict:
        v = lambda i: self.query_one(f"#{i}", Input).value.strip()  # noqa: E731
        t = lambda i: self.query_one(f"#{i}", TextArea).text  # noqa: E731
        out = {"note": t("note").strip(), "labels": self.picked()}
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


RECIPE_TEXT = ("yield", "time", "ingredients", "steps", "notes")


def in_english(p: dict, fields: dict) -> dict:
    """A post with the words of its translation swapped in (src/translate.js sends only the fields that had text)."""
    recipe = {**p["recipe"], **{k: fields[k] for k in RECIPE_TEXT if k in fields}}
    return {**p, "title": fields.get("title", p["title"]), "note": fields.get("note", p["note"]), "recipe": recipe}


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
    BoardPage #english {{ color: {MUTED}; background: #24251a; padding: 0 1; margin-bottom: 1; }}
    BoardPage #post-meta {{ color: {FAINT}; margin-bottom: 1; }}
    BoardPage .group {{ color: {FAINT}; }}
    BoardPage #ingredients, BoardPage #steps, BoardPage #notes, BoardPage #note {{ margin-bottom: 1; }}
    """
    BINDINGS = [
        Binding("n", "share", "Share"),
        Binding("f", "follow", "Follow"),
        Binding("s", "save", "Save to box"),
        Binding("x", "remove_category", "Remove category", show=False),
        Binding("m", "older", "Older"),
        Binding("E", "english", "English"),
        Binding("S", "save_english", "Save the English", show=False),
        Binding("e", "edit", "Edit", show=False),
        Binding("d", "delete", "Delete", show=False),
        Binding("r", "refresh", "Refresh"),
        Binding("backslash", "fold", "Side"),
    ]

    def __init__(self, share: str = ""):
        super().__init__()
        self.board: dict | None = None
        self.at: dict = {"view": "feed", "category": "", "label": ""}
        self.posts: list[dict] = []
        self.more = False
        self.open: str | None = None
        self.share_id = share
        self.english: dict[str, dict] = {}     # post id → {language, fields, on}: E's translation, shown while on

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
                        yield Static(id="english")
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
        out = await self.fetch(site.board_posts, self.at["view"], self.at["category"], before, self.at["label"])
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
        return next((c for c in (self.board or {}).get("categories", []) if cid and c["id"].casefold() == cid.casefold()), None)

    def value(self, c: dict | None, lid: str) -> dict | None:
        return next((v for v in (c or {}).get("values", []) if v["id"] == lid), None)

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
            if not self.board["categories"]:
                side.add_option(Option(Text("No labels yet: the categories\nare Recipe labels' keys.", style=FAINT), disabled=True))
            for c in self.board["categories"]:
                here = (self.at["category"] or "").casefold() == c["id"].casefold()
                t = Text.assemble(("★ " if c["following"] else "☆ ", GOLD if c["following"] else FAINT),
                                  (c["name"], f"bold {INK}" if here and not self.at["label"] else MUTED), (f"  {c['posts']}" if c["posts"] else "", FAINT))
                side.add_option(Option(t, id="c:" + c["id"]))
                # The open key's values, to narrow it to one (and any value you follow, so you can see it).
                for v in [v for v in c["values"] if here or v.get("following")]:
                    on = self.at["label"] == v["id"]
                    star = v.get("following")
                    side.add_option(Option(Text.assemble(("  ★ " if star else "  ☆ ", GOLD if star else FAINT), (v["value"], f"bold {INK}" if on else MUTED),
                                                         (f"  {v['posts']}" if v["posts"] else "", FAINT)), id="l:" + v["id"]))
        if keep is not None:
            side.highlighted = min(keep, side.option_count - 1)

    def show_top(self) -> None:
        c = self.cat(self.at["category"])
        v = self.value(c, self.at["label"])
        if c:
            f, name = (v, f"{c['name']}: {v['value']}") if v else (c, c["name"])
            head = name + ("  ★ following" if f.get("following") else "")
            sub = f"{plural(f['posts'], 'recipe')} · {f.get('followers', 0)} following {name}" + ("" if f.get("following") else " · f to follow") \
                + (" · x removes the category" if c.get("can_delete") and not v else "")
        else:
            head = dict(VIEWS)[self.at["view"]]
            if self.at["view"] == "feed":
                n = self.followed()
                sub = f"New recipes in what you follow: {', '.join(n)}." if n \
                    else "Star a category, or one of its values, on the left (f) to follow it, and its new recipes show up here."
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
                t.append("\n" + (label_line(f) + " · " if label_line(f) else ""), style=GOLD_DIM)
                t.append(f"shared by {f['by']}", style=FAINT)
                box.add_option(Option(t, id="featured"))
            if not self.posts:
                none = "You don't follow any categories yet." if not self.at["category"] and self.at["view"] == "feed" \
                    and not self.followed() else "No recipes here yet. Press n to share one."
                box.add_option(Option(Text(none, style=FAINT), disabled=True))
                return
            for p in self.posts:
                t = Text.assemble((p["title"], f"bold {INK}"), ("  new" if p.get("new") else "", f"bold {GOLD}"),
                                  ("  ✓ saved" if p["saved"] else "", GOLD_DIM))
                t.append("\n" + (label_line(p) + " · " if label_line(p) else ""), style=GOLD_DIM)
                t.append(f"{p['by']} · {ago(p['created'])}" + (f" · saved {p['saves']}×" if p["saves"] else ""), style=FAINT)
                box.add_option(Option(t, id=p["id"]))
            if self.more:
                box.add_option(Option(Text("Older…  m", style=GOLD_DIM), id="more"))
            skip = 1 if f else 0
            box.highlighted = 0 if self.open == "featured" else next((i + skip for i, p in enumerate(self.posts) if p["id"] == self.open), 0)

    def current(self) -> dict | None:
        if self.open == "featured":
            return self.featured()
        return next((p for p in self.posts if p["id"] == self.open), None)

    def shown(self) -> dict | None:
        """The open post as it's shown: in English while E's translation is on."""
        p = self.current()
        tr = p and self.english.get(p["id"])
        return in_english(p, tr["fields"]) if tr and tr["on"] else p

    def show_post(self) -> None:
        p = self.shown()
        tr = p and self.english.get(p["id"])
        bar = self.query_one("#english", Static)
        bar.display = bool(tr)
        if tr:
            bar.update(Text.assemble(
                (f"Translated from {tr['language']}" if tr["on"] else f"In {tr['language']}; the English is ready", MUTED),
                ("   E ", f"bold {GOLD}"), ("the original" if tr["on"] else "the English", INK),
                *((("   S ", f"bold {GOLD}"), ("save the English", INK)) if p["can_edit"] else ())))
        for w in ("#post-meta", "#note", "#ing-head", "#ingredients", "#steps-head", "#steps", "#notes-head", "#notes"):
            self.query_one(w).display = bool(p)
        if not p:
            self.query_one("#post-title", Static).update("")
            return
        r = p["recipe"]
        self.query_one("#post-title", Static).update(("★ Recipe of the day: " if self.open == "featured" else "") + p["title"])
        bits = [b for b in (r.get("time"), f"serves {r['servings']:g}" if r.get("servings") else r.get("yield"), r.get("source")) if b]
        meta = Text((label_line(p) + " · " if label_line(p) else "") + f"shared by {p['by']}", style=GOLD_DIM)
        if bits:
            meta.append("\n" + " · ".join(bits), style=FAINT)
        if self.board.get("recipe_box"):
            meta.append("\n" + ("Saved in your Recipe box" if p["saved"] else "s saves it to your Recipe box"), style=GOLD if not p["saved"] else FAINT)
        if p.get("from_box"):
            meta.append("\n" + ("Kept in step with your Recipe box: change it there or here" if p.get("recipe_id")
                                 else f"Kept in step with {p['by']}'s Recipe box"), style=FAINT)
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
            elif oid.startswith("l:"):
                await self.go(category=self.at["category"], label=oid[2:])
            if self.posts:
                self.query_one("#posts", OptionList).focus()
        elif e.option_list.id == "posts" and oid == "more":
            await self.action_older()

    def on_option_list_option_highlighted(self, e: OptionList.OptionHighlighted) -> None:
        if e.option_list.id == "posts" and e.option.id and e.option.id != "more" and e.option.id != self.open:
            self.open = e.option.id
            self.show_post()

    @attempt
    async def go(self, view: str = "feed", category: str = "", label: str = "") -> None:
        self.at = {"view": view, "category": category, "label": label}
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
        return self.cat(self.at["category"] or "")

    def followed(self) -> list[str]:
        """What you follow: whole categories, and single values like "Season: Fall"."""
        return [n for c in self.board["categories"] for n in ([c["name"]] if c["following"] else [])
                + [f"{c['name']}: {v['value']}" for v in c["values"] if v.get("following")]]

    def highlighted_follow(self) -> tuple[dict | None, dict | None]:
        """The category and value f follows: the highlighted row on the left, else what's open."""
        side = self.query_one("#side", OptionList)
        oid = ""
        if self.focused is side and side.highlighted is not None:
            oid = side.get_option_at_index(side.highlighted).id or ""
        if oid.startswith("l:"):
            for c in self.board["categories"]:
                v = self.value(c, oid[2:])
                if v:
                    return c, v
        if oid.startswith("c:"):
            return self.cat(oid[2:]), None
        c = self.cat(self.at["category"] or "")
        return c, self.value(c, self.at["label"])

    def check_action(self, action: str, parameters: tuple) -> bool | None:
        if action in ("share", "follow", "save", "remove_category", "older", "edit", "delete", "refresh", "english", "save_english") and isinstance(self.focused, (Input, TextArea)):
            return False
        return True

    # ── following, saving, sharing ────────────────────────────────────────

    @attempt
    async def action_follow(self) -> None:
        c, v = self.highlighted_follow()
        if not c:
            self.app.notify("Highlight a category, or one of its values, on the left to follow it.", timeout=3)
            return
        if v:
            v.update(await self.fetch(site.follow_board_label, v["id"], not v.get("following")))
            f, name = v, f"{c['name']}: {v['value']}"
        else:
            c.update(await self.fetch(site.follow_board_category, c["id"], not c["following"]))
            f, name = c, c["name"]
        self.app.notify(f"Following {name}; its new recipes go in your feed." if f["following"] else f"Stopped following {name}.", timeout=3)
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

    def action_remove_category(self) -> None:
        """x: remove the highlighted (or open) category, which is its key in Recipe labels."""
        c = self.highlighted_category()
        if not c:
            return
        if not c.get("can_delete"):
            self.app.notify("Categories come from Recipe labels; whoever keeps that list can remove one.", timeout=4)
            return

        async def answer(yes: bool | None) -> None:
            if yes:
                await self.remove_category(c)
        self.app.push_screen(Confirm(f"Remove the {c['name']} category?",
                                     f"That takes {c['name']} and its {plural(len(c['values']), 'value')} off Recipe labels, and off every recipe "
                                     "and post that has them. The recipes and posts stay.", yes="Remove", danger=True), answer)

    @attempt
    async def remove_category(self, c: dict) -> None:
        await self.fetch(site.delete_board_category, c["id"])
        self.board = await self.fetch(site.board)
        self.app.notify(f"Removed the {c['name']} category.", timeout=3)
        await self.go(view="all")

    def action_share(self, recipe_id: str = "") -> None:
        if not self.board:
            return
        self.app.push_screen(ShareDialog(self.board, self.at["label"], recipe_id=recipe_id), self.after(None))

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
            self.english.pop(p["id"], None)
            self.posts = [p if x["id"] == p["id"] else x for x in self.posts]
            if (self.board.get("featured") or {}).get("id") == p["id"]:
                self.board["featured"] = p
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
        self.app.notify(f"Posted {p['title']} in {', '.join(p['categories'])}." if p["categories"]
                        else f"Posted {p['title']}. Give it labels to put it in categories.", timeout=3)
        self.at = {"view": "feed", "category": p["categories"][0], "label": ""} if p["categories"] else {"view": "mine", "category": "", "label": ""}
        await self.load()
        self.open = p["id"]
        self.show_posts()
        self.show_post()

    # ── translating ───────────────────────────────────────────────────────

    @attempt
    async def action_english(self) -> None:
        """E: the open post in English, or back and forth between it and the original."""
        p = self.current()
        if not p:
            return
        tr = self.english.get(p["id"])
        if tr:
            tr["on"] = not tr["on"]
            self.show_post()
            return
        self.app.notify(f"Translating {p['title']}…", timeout=2)
        out = await self.fetch(site.translate_board_post, p["id"])
        if out.get("english"):
            self.app.notify(f"{p['title']} is already in English.", timeout=3)
            return
        self.english[p["id"]] = {"language": out["language"], "fields": out["fields"], "on": True}
        self.show_post()

    def action_save_english(self) -> None:
        p = self.current()
        tr = p and self.english.get(p["id"])
        if not tr:
            self.app.notify("Press E to translate it first.", timeout=3)
            return
        if not p["can_edit"]:
            self.app.notify("Only whoever posted it can save it in English.", timeout=3)
            return

        async def answer(yes: bool | None) -> None:
            if yes:
                e = in_english(p, tr["fields"])
                recipe = {k: v for k, v in e["recipe"].items() if k != "title"}
                recipe["labels"] = [lb["id"] for lb in recipe.get("labels", [])]
                self.english.pop(p["id"], None)
                await self.send(p, {"title": e["title"], "note": e["note"], "recipe": recipe})
        self.app.push_screen(Confirm(f"Save the English over the {tr['language']}?", f"{p['title']} changes for everyone on the board; the original isn't kept.",
                                     yes="Save the English"), answer)

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
