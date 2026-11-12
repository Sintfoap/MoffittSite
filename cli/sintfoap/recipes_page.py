"""Recipe box in the terminal: the same recipes as /recipes/.

Your recipes down the left, the open one on the right, scaled to the servings
you pick (+ and -). Space ticks which ingredients to send, and s sends them to
a Drift list. A link pasted in the box at the top is read by the site, as on
the website; n types one in by hand, i imports a file of them (Recipe
Keeper's export, with its pictures, or a saved recipe page), p reads one from
a photo (a cookbook page, a screenshot: by tesseract on this computer, or by
Claude with your key, k) and t from pasted text, for you to check before
it's saved. l filters the shelf by labels and f by ingredients ("eggs,
spinach, -nuts"), with the lines it found lit up. u makes a link anyone
can read the recipe at without signing in, to copy or turn off. L suggests labels for
the whole box from each recipe's words (a label's name, or the keywords set
on it in Recipe labels), to untick any that don't fit before they're added.
m marks the open recipe made (today) and 1 to 5 give it stars, yours alone;
M shows only the ones you've made, then only the ones you haven't, and R
only those with at least so many stars. Under the title, a line says when
someone who made a recipe you shared on the Recipe board has reviewed it,
and v opens those reviews (the website's Reviews box): enter on one opens
its recipe here, with its reviews under it, or the post on the board."""
from __future__ import annotations

import asyncio
import re
import zipfile
from datetime import date
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Checkbox, Footer, Input, Label, OptionList, Select, SelectionList, Static, TextArea
from textual.widgets.option_list import Option
from textual.widgets.selection_list import Selection

from . import site
from . import recipe_rules as R
from .look import FAINT, GOLD, GOLD_DIM, INK, MUTED, Ask, Confirm, Page, attempt, plural

SHOPPING = "Shopping list"


def host(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").removeprefix("www.")
    except ValueError:
        return ""


def by_title(recipes: list[dict]) -> list[dict]:
    return sorted(recipes, key=lambda r: r["title"].casefold())


# ── labels: made up per recipe ("Season: Fall"), matched whatever their case ──

def label_text(label: dict) -> str:
    return f"{label['key']}: {label['value']}" if label.get("value") else label["key"]


def all_labels(recipes: list[dict]) -> list[tuple[dict, int]]:
    """The labels your recipes use (from the site's list), once each, with how many have it: by key, then value."""
    seen: dict[str, list] = {}
    for r in recipes:
        for lb in r.get("labels", []):
            seen.setdefault(lb["id"], [lb, 0])[1] += 1
    return [(lb, n) for lb, n in sorted(seen.values(), key=lambda x: (x[0]["key"].casefold(), x[0].get("value", "").casefold()))]


def passes(r: dict, filters: list[dict]) -> bool:
    """Any of the chosen values for a key, and every key chosen."""
    have = {lb["id"] for lb in r.get("labels", [])}
    keys: dict[str, set] = {}
    for f in filters:
        keys.setdefault(f["key"].casefold(), set()).add(f["id"])
    return all(have & want for want in keys.values())


def value_of(r: dict, key: str) -> str | None:
    return next((lb.get("value", "") for lb in r.get("labels", []) if lb["key"].casefold() == key.casefold()), None)


def named(r: dict, q: str) -> bool:
    """/'s find by name, as the website's search box: in the title, an ingredient or a label."""
    q = q.strip().casefold()
    return not q or q in r["title"].casefold() or any(q in i.casefold() for i in r.get("ingredients", [])) \
        or any(q in label_text(lb).casefold() for lb in r.get("labels", []))


# ── made it, and your stars: yours alone, as on the website ──
# made is the day you last made it ("" not yet), rating 1–5 stars (0 none).

MADE_FILTERS = ["", "made", "new"]                    # M cycles: either, made it before, not made yet
RATING_FILTERS = ["", "5", "4", "3", "2", "1", "none"]  # R cycles: any, at least so many stars, not rated
SORTS = {"": "title", "@rating": "your rating", "@made": "last made"}


def marked(r: dict, made: str = "", rating: str = "") -> bool:
    """Whether the made-it and stars filters let r through, as the website's."""
    if made == "made" and not r.get("made"):
        return False
    if made == "new" and r.get("made"):
        return False
    if rating == "none":
        return not r.get("rating")
    return not rating or (r.get("rating") or 0) >= int(rating)


def stars(n: int) -> str:
    return "★" * n + "☆" * (5 - n)


def made_on(day: str, today: date | None = None) -> str:
    """"today", "Nov 3", or "Nov 3, 2025" for another year."""
    today = today or date.today()
    try:
        d = date.fromisoformat(day)
    except ValueError:
        return day
    if d == today:
        return "today"
    out = f"{d.strftime('%b')} {d.day}"
    return out if d.year == today.year else f"{out}, {d.year}"


def mark_changes(r: dict, made: bool | None = None, rating: int | None = None, today: date | None = None) -> dict:
    """What to send for m (made toggled) or a number key (stars; the same again takes them off).
    Rating one not marked made marks it made today; unmarking takes the stars off too."""
    day = (today or date.today()).isoformat()
    if made is not None:
        return {"made": day} if made else {"made": "", "rating": 0}
    n = 0 if rating == r.get("rating") else rating or 0
    return {"rating": n, **({"made": day} if n and not r.get("made") else {})}


def arranged(recipes: list[dict], filters: list[dict], sort_key: str, terms: list[dict] | None = None, name: str = "",
             made: str = "", rating: str = "") -> list[dict]:
    """The shelf: the recipes the filters (and the search, by name or ingredient) let through, by title, your stars,
    the last made, or a label's value (those without it last)."""
    shown = [r for r in by_title(recipes) if passes(r, filters) and marked(r, made, rating) and named(r, name)
             and (not terms or R.ingredient_hits(r, terms) is not None)]
    if sort_key == "@rating":
        shown.sort(key=lambda r: -(r.get("rating") or 0))
    elif sort_key == "@made":
        shown.sort(key=lambda r: -int((r.get("made") or "0").replace("-", "")))   # latest first, then by title
    elif sort_key:
        shown.sort(key=lambda r: (value_of(r, sort_key) is None, (value_of(r, sort_key) or "").casefold()))
    return shown


class LabelFilter(ModalScreen[list | None]):
    """Pick the labels to filter the shelf by. Dismisses with the chosen ones, or None."""
    BINDINGS = [Binding("escape", "cancel", "Cancel"), Binding("enter", "done", "Filter", priority=True),
                Binding("c", "clear", "Clear")]
    DEFAULT_CSS = """
    LabelFilter SelectionList { height: auto; max-height: 24; background: transparent; border: none; padding: 0; margin: 1 0; }
    """

    def __init__(self, labels: list[tuple[dict, int]], chosen: list[dict]):
        super().__init__()
        self.labels = labels
        on = {f["id"] for f in chosen}
        self.items = [Selection(Text.assemble((lb["key"], f"bold {GOLD}"), (f"  {lb.get('value', '')}", INK), (f"   {n}", FAINT)),
                                i, lb["id"] in on) for i, (lb, n) in enumerate(labels)]

    def compose(self) -> ComposeResult:
        with VerticalScroll(classes="dialog"):
            yield Label(Text("Filter by label", style=f"bold {INK}"))
            yield Static(Text("space ticks one · enter filters · c clears · esc cancels", style=FAINT))
            yield SelectionList(*self.items, id="labels")

    def on_mount(self) -> None:
        self.query_one(SelectionList).focus()

    def action_done(self) -> None:
        self.dismiss([self.labels[i][0] for i in self.query_one(SelectionList).selected])

    def action_clear(self) -> None:
        self.dismiss([])

    def action_cancel(self) -> None:
        self.dismiss(None)


def gather(where: Path) -> tuple[list[str], dict[str, Callable[[], bytes]]]:
    """The recipe HTML at `where` (a file, the export's folder, or its .zip) and its pictures,
    by name, each read only when it's sent. Beside a lone .html, its images/ folder is looked in."""
    html: list[str] = []
    images: dict[str, Callable[[], bytes]] = {}
    if where.suffix.lower() == ".zip":
        z = zipfile.ZipFile(where)
        for name in z.namelist():
            if name.endswith("/") or "__MACOSX/" in name:
                continue
            if name.lower().endswith((".html", ".htm")):
                html.append(z.read(name).decode("utf-8", "replace"))
            elif name.lower().endswith(R.IMAGE_EXT):
                images[R.file_key(name)] = lambda n=name: z.read(n)
        return html, images
    if where.is_dir():
        files = sorted(p for p in where.rglob("*") if p.is_file())
        html = [p.read_text(encoding="utf-8", errors="replace") for p in files if p.suffix.lower() in (".html", ".htm")]
    else:
        html = [where.read_text(encoding="utf-8", errors="replace")]
        files = sorted(p for p in (where.parent / "images").glob("*") if p.is_file()) if (where.parent / "images").is_dir() else []
    for p in files:
        if p.suffix.lower() in R.IMAGE_EXT:
            images[R.file_key(p.name)] = p.read_bytes
    return html, images


class RecipeDialog(ModalScreen[dict | None]):
    """A recipe's fields (or a new recipe's). Dismisses with what to save, or None."""
    BINDINGS = [Binding("escape", "cancel", "Cancel"), Binding("ctrl+s", "save", "Save", priority=True)]
    DEFAULT_CSS = """
    RecipeDialog .grid { height: auto; }
    RecipeDialog .grid > Vertical { height: auto; width: 1fr; margin-right: 1; }
    RecipeDialog #ingredients, RecipeDialog #steps { height: 8; }
    RecipeDialog #notes { height: 4; }
    RecipeDialog #labels { height: auto; max-height: 8; background: transparent; border: none; padding: 0; }
    """

    def __init__(self, recipe: dict | None, source: str = "", heading: str = "", hint: str = "", label_list: list | None = None,
                 picture: str | None = None):
        super().__init__()
        self.picture = picture   # for a recipe read from a photo: what its picture would be ("the dish's photo from the page")
        self.r = recipe or {}
        self.source = source
        self.heading = heading or ("Edit recipe" if recipe else "New recipe")
        self.hint = hint
        self.label_list = label_list or []   # the site's labels (kept in Recipe labels) to tick

    def compose(self) -> ComposeResult:
        r = self.r
        with VerticalScroll(classes="dialog"):
            yield Label(Text(self.heading, style=f"bold {INK}"))
            if self.hint:
                yield Static(Text(self.hint, style=MUTED), id="hint")
            if self.picture:
                yield Checkbox(f"Use {self.picture} as the recipe's picture", True, id="use-picture")
            yield Label("Title", classes="lbl")
            yield Input(r.get("title", ""), id="title", max_length=200)
            with Horizontal(classes="grid"):
                with Vertical():
                    yield Label("Serves", classes="lbl")
                    s = r.get("servings")
                    yield Input("" if s is None else R.format_amount(s) if s != int(s) else str(int(s)), id="servings", type="number")
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
            yield Label("Labels (space ticks; the list is kept in Recipe labels)", classes="lbl")
            if self.label_list:
                on = {lb["id"] for lb in r.get("labels", [])}
                yield SelectionList(*[Selection(Text.assemble((lb["key"], f"bold {GOLD}"), ("  " + lb.get("value", ""), INK)), lb["id"], lb["id"] in on)
                                      for lb in self.label_list], id="labels")
            else:
                yield Static(Text("No labels yet. Whoever keeps Recipe labels adds them there.", style=FAINT))
            yield Label("Notes", classes="lbl")
            yield TextArea(r.get("notes", ""), id="notes", soft_wrap=True)
            yield Label("Link", classes="lbl")
            yield Input(r.get("source", "") or self.source, id="source")
            with Horizontal(classes="buttons"):
                yield Button("Save", id="save")
                yield Button("Cancel", id="cancel", classes="quiet")
                if self.r.get("id"):
                    # Deleting is here, as in the website's editor, out of the way of everyday keys.
                    yield Button("Delete recipe", id="delete", classes="danger")
            yield Static(Text("ctrl+s saves, esc cancels", style=FAINT))

    def on_mount(self) -> None:
        self.query_one("#title", Input).focus()

    def fields(self) -> dict:
        v = lambda i: self.query_one(f"#{i}", Input).value.strip()  # noqa: E731
        t = lambda i: self.query_one(f"#{i}", TextArea).text  # noqa: E731
        servings = v("servings")
        try:
            serves = float(servings) if servings else None
        except ValueError:
            serves = None
        return {"title": v("title"), "servings": serves, "yield": v("yield"), "time": v("time"),
                "ingredients": t("ingredients"), "steps": t("steps"), "notes": t("notes").strip(), "source": v("source"),
                "labels": list(self.query_one("#labels", SelectionList).selected) if self.label_list else [lb["id"] for lb in self.r.get("labels", [])],
                **({"_picture": self.query_one("#use-picture", Checkbox).value} if self.picture else {})}

    def action_save(self) -> None:
        f = self.fields()
        if not f["title"]:
            self.app.notify("A recipe needs a title.", severity="error", timeout=3)
            self.query_one("#title", Input).focus()
            return
        self.dismiss(f)

    def action_cancel(self) -> None:
        self.dismiss(None)

    def on_button_pressed(self, e: Button.Pressed) -> None:
        if e.button.id == "delete":
            self.dismiss({"_delete": True})
        else:
            self.action_save() if e.button.id == "save" else self.dismiss(None)


class PasteDialog(ModalScreen[str | None]):
    """A recipe's text, pasted. Dismisses with it, or None."""
    BINDINGS = [Binding("escape", "cancel", "Cancel"), Binding("ctrl+s", "read", "Read it", priority=True)]
    DEFAULT_CSS = "PasteDialog #text { height: 16; }"

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Label(Text("Paste a recipe's text", style=f"bold {INK}"))
            yield Static(Text("Copy the text out of a photo (Live Text on an iPhone, Google Lens on Android) or a page, and paste it here. "
                              "It's split into the title, ingredients and steps for you to check before saving.", style=MUTED))
            yield TextArea(id="text", soft_wrap=True)
            with Horizontal(classes="buttons"):
                yield Button("Read it", id="read")
                yield Button("Cancel", id="cancel", classes="quiet")
            yield Static(Text("ctrl+s reads it, esc cancels", style=FAINT))

    def on_mount(self) -> None:
        self.query_one("#text", TextArea).focus()

    def action_read(self) -> None:
        self.dismiss(self.query_one("#text", TextArea).text)

    def action_cancel(self) -> None:
        self.dismiss(None)

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.action_read() if e.button.id == "read" else self.dismiss(None)


def by_label(suggestions: list[dict]) -> list[tuple[dict, list[dict]]]:
    """Per recipe [{id, title, labels}] → per label [(label, [{id, title, word, where}])], by the label's name."""
    groups: dict[str, tuple[dict, list[dict]]] = {}
    for s in suggestions:
        for lb in s["labels"]:
            groups.setdefault(lb["id"], ({"id": lb["id"], "key": lb["key"], "value": lb["value"]}, []))[1].append(
                {"id": s["id"], "title": s["title"], "word": lb["word"], "where": lb["where"]})
    return sorted(groups.values(), key=lambda g: label_text(g[0]).casefold())


class SuggestLabels(ModalScreen[list | None]):
    """Suggested labels, grouped by label, all ticked: untick any that don't fit. Dismisses with
    [{id, labels}] per recipe to add, or None."""
    BINDINGS = [Binding("escape", "cancel", "Cancel"), Binding("enter", "done", "Add", priority=True),
                Binding("a", "all(True)", "Tick all"), Binding("u", "all(False)", "Untick all"),
                Binding("g", "group", "Tick or untick this label")]
    DEFAULT_CSS = """
    SuggestLabels .dialog { width: 96; max-height: 90%; }
    SuggestLabels SelectionList { height: auto; max-height: 30; background: transparent; border: none; padding: 0; margin: 1 0; }
    """

    def __init__(self, out: dict):
        super().__init__()
        self.out = out
        self.groups = by_label(out["suggestions"])
        self.rows: list[tuple[str, str] | None] = []   # (recipe id, label id), or None for a label's heading
        self.items: list[Selection] = []
        for lb, recipes in self.groups:
            self.rows.append(None)
            self.items.append(Selection(Text.assemble((lb["key"], f"bold {GOLD}"), (f"  {lb['value']}" if lb["value"] else "", INK),
                                                      (f"   {plural(len(recipes), 'recipe')}", FAINT)), len(self.items), False, disabled=True))
            for r in recipes:
                self.rows.append((r["id"], lb["id"]))
                self.items.append(Selection(Text.assemble(("  " + r["title"], INK), (f"   {r['word']} in {r['where']}", FAINT)),
                                            len(self.items), True))

    def compose(self) -> ComposeResult:
        total = len(self.rows) - len(self.groups)
        with VerticalScroll(classes="dialog"):
            yield Label(Text("Suggested labels", style=f"bold {INK}"))
            yield Static(Text(f"Checked {plural(self.out['checked'], 'recipe')} against {plural(self.out['labels'], 'label')}: "
                              f"{plural(total, 'suggestion')} for {plural(len(self.out['suggestions']), 'recipe')}, from each label's "
                              "name and the keywords set on it in Recipe labels. Untick any that don't fit.", style=MUTED))
            yield Static(Text("space ticks one · g the whole label · a all · u none · enter adds · esc cancels", style=FAINT))
            yield SelectionList(*self.items, id="suggestions")

    def on_mount(self) -> None:
        box = self.query_one(SelectionList)
        box.focus()
        box.highlighted = 1 if len(self.rows) > 1 else 0

    def action_all(self, on: bool) -> None:
        box = self.query_one(SelectionList)
        (box.select_all if on else box.deselect_all)()

    def action_group(self) -> None:
        """Ticks every recipe under the highlighted one's label, or unticks them if they all are."""
        box = self.query_one(SelectionList)
        at = box.highlighted
        if at is None:
            return
        start = next(i for i in range(at, -1, -1) if self.rows[i] is None)
        end = next((i for i in range(start + 1, len(self.rows)) if self.rows[i] is None), len(self.rows))
        mine = list(range(start + 1, end))
        on = set(box.selected)
        for i in mine:
            (box.deselect if all(j in on for j in mine) else box.select)(i)

    def action_done(self) -> None:
        per: dict[str, list[str]] = {}
        for i in sorted(self.query_one(SelectionList).selected):
            if self.rows[i]:
                rid, lid = self.rows[i]
                per.setdefault(rid, []).append(lid)
        self.dismiss([{"id": rid, "labels": ids} for rid, ids in per.items()])

    def action_cancel(self) -> None:
        self.dismiss(None)


# ── the reviews box: reviews of the recipes you shared on the board ──

def review_line(v: dict, title: bool = True) -> Text:
    """"★★★★☆ Sam made Brownies", or "Sam reviewed Stew" without stars."""
    t = Text()
    if v.get("rating") is not None:
        t.append(stars(v["rating"]) + " ", style=GOLD)
    t.append(v["by"], style=f"bold {INK}")
    t.append(" changed their review" if v.get("edited") else " made" if v.get("rating") is not None else " reviewed", style=MUTED)
    if title:
        t.append(" " + v["title"], style=f"bold {INK}")
    return t


def review_words(v: dict) -> str:
    return " · ".join(x for x in (v.get("note"), v.get("changes") and f"Changed: {v['changes']}") if x)


class ReviewsBox(ModalScreen[dict | None]):
    """v: the reviews of the recipes you shared on the board, newest first, new ones marked.
    Dismisses with the one picked (enter), or None."""
    BINDINGS = [Binding("escape", "cancel", "Close")]
    DEFAULT_CSS = """
    ReviewsBox OptionList { height: auto; max-height: 24; margin-top: 1; }
    """

    def __init__(self, reviews: list[dict], recipe_ids: set[str]):
        super().__init__()
        self.reviews, self.recipe_ids = reviews, recipe_ids

    def compose(self) -> ComposeResult:
        from .board_page import ago
        with VerticalScroll(classes="dialog"):
            yield Label(Text("Reviews of your recipes", style=f"bold {INK}"))
            yield Static(Text("enter opens the recipe (or its post on the board) · esc closes", style=FAINT))
            opts = []
            for v in self.reviews:
                t = Text("● " if v.get("new") else "  ", style=f"bold {GOLD}")
                t.append_text(review_line(v))
                words = review_words(v)
                if words:
                    t.append("\n  " + (words if len(words) <= 110 else words[:109] + "…"), style=MUTED)
                t.append("\n  " + ago(v["updated"]) + ("" if v.get("recipe_id") in self.recipe_ids else " · on the board"), style=FAINT)
                opts.append(Option(t, id=v["id"]))
            if not opts:
                opts.append(Option(Text("Share a recipe on the board (b), and when someone who made it says how it turned out, it shows here.", style=FAINT), disabled=True))
            yield OptionList(*opts, id="reviews")

    def on_mount(self) -> None:
        self.query_one(OptionList).focus()

    def on_option_list_option_selected(self, e: OptionList.OptionSelected) -> None:
        self.dismiss(next((v for v in self.reviews if v["id"] == e.option.id), None))

    def action_cancel(self) -> None:
        self.dismiss(None)


class ShareDialog(ModalScreen[str | None]):
    """u: the open recipe's share link, to copy (c) or turn off (x). Dismisses with "copy", "stop" or None."""
    BINDINGS = [Binding("escape", "close", "Close"), Binding("c", "copy", "Copy link"), Binding("x", "stop", "Turn it off")]

    def __init__(self, title: str, url: str):
        super().__init__()
        self._title, self._url = title, url

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Label(Text("Share link", style=f"bold {INK}"))
            yield Static(Text(f"Anyone with this link can read {self._title}, without an account: its picture, ingredients, "
                              "steps and notes, as you keep them here. Nothing else of yours is on it.", style=MUTED))
            yield Input(self._url, id="share-url")
            with Horizontal(classes="buttons"):
                yield Button("Copy link (c)", id="copy")
                yield Button("Close", id="close", classes="quiet")
                yield Button("Turn it off (x)", id="stop", classes="danger")

    def on_mount(self) -> None:
        self.query_one("#copy", Button).focus()

    def on_input_changed(self, e: Input.Changed) -> None:
        if e.value != self._url:   # it's there to read and select, not to change
            e.input.value = self._url

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.dismiss(None if e.button.id == "close" else e.button.id)

    def action_copy(self) -> None:
        self.dismiss("copy")

    def action_stop(self) -> None:
        self.dismiss("stop")

    def action_close(self) -> None:
        self.dismiss(None)


class RecipesPage(Page):
    WEB_PATH = "/recipes/"
    SIDE = "#shelf"
    DEFAULT_CSS = f"""
    RecipesPage #body {{ padding: 0 2 0 2; height: 1fr; }}
    RecipesPage #url {{ margin-bottom: 1; }}
    RecipesPage #main {{ height: 1fr; }}
    RecipesPage #shelf {{ width: 36; height: 1fr; border-right: solid {GOLD_DIM}; margin-right: 2; }}
    RecipesPage #recipe {{ width: 1fr; height: 1fr; }}
    RecipesPage #title {{ color: {INK}; text-style: bold; }}
    RecipesPage #english {{ color: {MUTED}; background: #24251a; padding: 0 1; margin-bottom: 1; }}
    RecipesPage #facts {{ color: {FAINT}; }}
    RecipesPage #tags {{ margin-bottom: 1; }}
    RecipesPage #filters {{ color: {FAINT}; height: auto; }}
    RecipesPage #serves {{ color: {INK}; margin-bottom: 1; }}
    RecipesPage .group {{ color: {FAINT}; }}
    RecipesPage SelectionList {{ height: auto; max-height: 20; background: {INK} 0%; border: none; padding: 0; margin-bottom: 1; }}
    RecipesPage SelectionList:focus {{ border: none; background-tint: {INK} 0%; }}
    RecipesPage #send {{ height: auto; margin-bottom: 1; }}
    RecipesPage #send-btn {{ margin-top: 1; }}
    RecipesPage #list {{ width: 40; }}
    RecipesPage #steps, RecipesPage #notes, RecipesPage #board-reviews {{ margin-bottom: 1; }}
    RecipesPage #inbox {{ margin-bottom: 1; }}
    """
    BINDINGS = [
        Binding("a", "add", "From a link"),
        Binding("slash", "find", "Find"),
        Binding("n", "new", "By hand"),
        Binding("i", "import_file", "Import file"),
        Binding("p", "photo", "From a photo"),
        Binding("t", "paste", "Paste text"),
        Binding("k", "key", "Claude key", show=False),
        Binding("e", "edit", "Edit"),
        Binding("c", "picture", "Picture"),
        Binding("plus,equals_sign", "servings(1)", "More"),
        Binding("minus", "servings(-1)", "Fewer"),
        Binding("s", "send", "Send to list"),
        Binding("l", "labels", "Filter"),
        Binding("L", "suggest", "Suggest labels"),
        Binding("f", "ingredients", "Ingredients"),
        Binding("o", "sort", "Sort"),
        Binding("m", "made", "Made it"),
        Binding("1", "rate(1)", "Stars 1–5"),
        *[Binding(str(n), f"rate({n})", f"{n} stars", show=False) for n in (2, 3, 4, 5)],
        Binding("0", "rate(0)", "No stars", show=False),
        Binding("M", "made_filter", "Made / new"),
        Binding("R", "rating_filter", "By stars"),
        Binding("b", "board", "Share on board"),
        Binding("v", "reviews", "Reviews"),
        Binding("u", "share", "Share link"),
        # Shown only for a recipe that doesn't read as English (or has its
        # English ready); the second E translates any recipe, as on the website.
        Binding("E", "english", "English"),
        Binding("E", "english_any", "English", show=False),
        Binding("S", "save_english", "Save the English", show=False),
        Binding("d", "delete", "Delete", show=False),
        Binding("r", "refresh", "Refresh"),
        Binding("backslash", "fold", "Shelf"),
        # Recipe labels is Recipe box's Labels tab, on the website too.
        Binding("ctrl+l", "labels_tab", "Labels tab"),
    ]

    def __init__(self):
        super().__init__()
        self.data: dict | None = None
        self.open: str | None = None
        self.scale: dict[str, dict] = {}       # recipe id → {servings} or {factor}
        self.skip: dict[str, set[int]] = {}    # recipe id → ingredient indexes not to send
        self.pending_picture: bytes | None = None   # a photo draft's picture, kept once it's saved if ticked
        self.filters: list[dict] = []          # labels the shelf shows only recipes with
        self.sort_key = ""                     # "" by title, "@rating", "@made", else a label's key
        self.made_filter = ""                  # M: "" either, "made" made it before, "new" not yet
        self.rating_filter = ""                # R: "" any, "5"…"1" at least that many stars, "none" not rated
        self.ingredients = ""                  # what f looks for: "eggs, spinach, -nuts"
        self.find_name = ""                    # what / looks for; one search at a time, like the website's one box
        self.english: dict[str, dict] = {}     # recipe id → {language, fields, on}: E's translation, shown while on
        self.inbox: dict = {"reviews": [], "unread": 0}   # site.recipe_reviews(): reviews of the recipes you shared on the board

    def compose(self) -> ComposeResult:
        yield from self.top()
        with Vertical(id="body"):
            yield Static("R E C I P E   B O X", classes="kicker", id="kicker")
            yield Static(id="inbox")
            yield Input(placeholder="Paste a link to a recipe (any site, or Recipe Keeper) and press enter (a)", id="url")
            yield Static(id="filters")
            with Horizontal(id="main"):
                yield OptionList(id="shelf")
                with VerticalScroll(id="recipe"):
                    yield Static(id="english")
                    yield Static(id="title")
                    yield Static(id="facts")
                    yield Static(id="marks")
                    yield Static(id="tags")
                    yield Static(id="serves")
                    yield Static("INGREDIENTS", classes="group", id="ing-head")
                    yield SelectionList(id="ingredients")
                    with Horizontal(id="send"):
                        yield Button("Send", id="send-btn")
                        yield Select([(SHOPPING, "")], value="", allow_blank=False, id="list")
                    yield Static(id="no-drift")
                    yield Static("STEPS", classes="group", id="steps-head")
                    yield Static(id="steps")
                    yield Static("NOTES", classes="group", id="notes-head")
                    yield Static(id="notes")
                    yield Static(classes="group", id="rev-head")
                    yield Static(id="board-reviews")
        yield Footer()

    async def on_mount(self) -> None:
        await self.action_refresh()
        self.query_one("#shelf", OptionList).focus()

    # ── loading and showing ───────────────────────────────────────────────

    @attempt
    async def action_refresh(self) -> None:
        self.data = await self.fetch(site.recipes)
        self.data["recipes"] = by_title(self.data["recipes"])
        self.inbox = await self.fetch(site.recipe_reviews)
        self.show_inbox()
        # The tabs, as on the website: Recipes here, and Labels for whoever keeps the list.
        kicker = Text("R E C I P E   B O X", style=f"bold {GOLD}")
        if self.data.get("labels"):
            kicker.append("     RECIPES", style=f"bold {INK}")
            kicker.append("  ·  labels (ctrl+l)", style=FAINT)
        self.query_one("#kicker", Static).update(kicker)
        self.refresh_bindings()
        shown = self.shelved()
        if not any(r["id"] == self.open for r in shown):
            self.open = shown[0]["id"] if shown else None
        self.show_shelf()
        self.show_recipe()

    def show_inbox(self) -> None:
        """The line under the title: new reviews of the recipes you shared, or where to find the old ones."""
        line = self.query_one("#inbox", Static)
        n, any_ = self.inbox.get("unread", 0), bool(self.inbox.get("reviews"))
        line.display = any_
        if n:
            line.update(Text.assemble(("● ", f"bold {GOLD}"), (plural(n, "new review") + " of the recipes you shared", f"bold {INK}"), ("   v ", f"bold {GOLD}"), ("read", INK)))
        elif any_:
            line.update(Text.assemble(("Reviews of the recipes you shared", FAINT), ("   v ", f"bold {GOLD}"), ("read", FAINT)))

    def show_board_reviews(self, r: dict | None) -> None:
        """Under the open recipe, when it's on the board: what the people who made it thought."""
        from .board_page import ago
        mine = [v for v in self.inbox.get("reviews", []) if r and v.get("recipe_id") == r["id"]]
        self.query_one("#rev-head").display = self.query_one("#board-reviews").display = bool(mine)
        if not mine:
            return
        rated = [v["rating"] for v in mine if v.get("rating") is not None]
        head = "ON THE BOARD" + (f" · ★ {round(sum(rated) / len(rated), 1):g}" if rated else "") + " · " + plural(len(mine), "review").upper()
        self.query_one("#rev-head", Static).update(Text(head, style=FAINT))
        t = Text()
        for i, v in enumerate(mine):
            if i:
                t.append("\n\n")
            t.append("● " if v.get("new") else "  ", style=f"bold {GOLD}")
            t.append_text(review_line(v, title=False))
            t.append("  " + ago(v["updated"]), style=FAINT)
            words = review_words(v)
            if words:
                t.append("\n  " + words, style=MUTED)
        self.query_one("#board-reviews", Static).update(t)

    @attempt
    async def action_reviews(self) -> None:
        """v: the reviews box. Opening it marks them read; enter on one opens its recipe, or its post on the board."""
        reviews = [dict(v) for v in self.inbox.get("reviews", [])]
        if self.inbox.get("unread"):
            self.inbox = await self.fetch(site.recipe_reviews_seen)
            self.show_inbox()
            self.show_recipe()
        ids = {r["id"] for r in (self.data or {}).get("recipes", [])}
        self.app.push_screen(ReviewsBox(reviews, ids), self.open_review)

    def open_review(self, v: dict | None) -> None:
        if not v:
            return
        if v.get("recipe_id") in {r["id"] for r in (self.data or {}).get("recipes", [])}:
            if not any(r["id"] == v["recipe_id"] for r in self.shelved()):
                # Hidden by a filter: show everything again, so it's on the shelf.
                self.filters, self.find_name, self.ingredients, self.made_filter, self.rating_filter = [], "", "", "", ""
            self.open = v["recipe_id"]
            self.show_shelf()
            self.show_recipe()
            return
        from .board_page import BoardPage
        self.app.push_screen(BoardPage(post=v["post"]))

    def terms(self) -> list[dict]:
        return R.ingredient_terms(self.ingredients)

    def shelved(self) -> list[dict]:
        return arranged(self.data["recipes"], self.filters, self.sort_key, self.terms(), self.find_name, self.made_filter, self.rating_filter)

    def current(self) -> dict | None:
        return next((r for r in (self.data or {}).get("recipes", []) if r["id"] == self.open), None)

    def show_shelf(self) -> None:
        shelf = self.query_one("#shelf", OptionList)
        with self.prevent(OptionList.OptionHighlighted):
            shelf.clear_options()
            self.show_filters()
            recipes = self.shelved()
            if not self.data["recipes"]:
                shelf.add_option(Option(Text("No recipes yet. Paste a link above.", style=FAINT), disabled=True))
                return
            if not recipes:
                why = "Nothing matches. " + " or ".join(k for k, on in (("l", self.filters), ("/", self.find_name.strip()), ("f", self.ingredients.strip()),
                                                                     ("M", self.made_filter), ("R", self.rating_filter)) if on) + " changes the filter."
                if self.made_filter == "new" and not (self.filters or self.find_name.strip() or self.ingredients.strip() or self.rating_filter):
                    why = "You've made every one. Time to add something new (a, or M to see them all)."
                shelf.add_option(Option(Text(why, style=FAINT), disabled=True))
                return
            terms = self.terms()
            for r in recipes:
                sorted_by = value_of(r, self.sort_key) if self.sort_key and not self.sort_key.startswith("@") else None
                sub = " · ".join(x for x in (sorted_by, r.get("time"), host(r.get("source", ""))) if x) or plural(len(r["ingredients"]), "ingredient")
                t = Text.assemble((r["title"], f"bold {INK}"), "\n")
                if r.get("rating"):
                    t.append("★" * r["rating"], style=GOLD)
                    t.append(" · ", style=FAINT)
                elif r.get("made"):
                    t.append("✓ made · ", style=FAINT)
                t.append(sub, style=FAINT)
                found = " · ".join(r["ingredients"][i] for i in R.ingredient_hits(r, terms) or []) if terms else ""
                if found:
                    t.append("\n" + found, style=GOLD)
                if r.get("labels"):
                    t.append("\n" + " · ".join(label_text(lb) for lb in r["labels"]), style=GOLD_DIM)
                shelf.add_option(Option(t, id=r["id"]))
            shelf.highlighted = next((i for i, r in enumerate(recipes) if r["id"] == self.open), 0)

    def show_filters(self) -> None:
        bits = Text()
        if self.filters:
            bits.append("FILTER  ", style=FAINT)
            bits.append("  ".join(label_text(f) for f in self.filters), style=f"bold {GOLD}")
            bits.append("   l changes", style=FAINT)
        if self.find_name.strip():
            bits.append(("   " if bits.plain else "") + "FIND  ", style=FAINT)
            bits.append(self.find_name.strip(), style=f"bold {GOLD}")
            bits.append("   / changes", style=FAINT)
        terms = self.terms()
        if terms:
            bits.append(("   " if bits.plain else "") + "INGREDIENTS  ", style=FAINT)
            bits.append(", ".join(("without " if t["without"] else "") + t["text"] for t in terms), style=f"bold {GOLD}")
            bits.append("   f changes", style=FAINT)
        if self.made_filter:
            bits.append(("   " if bits.plain else "") + "MADE  ", style=FAINT)
            bits.append("before" if self.made_filter == "made" else "not yet", style=f"bold {GOLD}")
            bits.append("   M changes", style=FAINT)
        if self.rating_filter:
            bits.append(("   " if bits.plain else "") + "STARS  ", style=FAINT)
            bits.append("none" if self.rating_filter == "none" else "★" * int(self.rating_filter) + ("" if self.rating_filter == "5" else " and up"), style=f"bold {GOLD}")
            bits.append("   R changes", style=FAINT)
        if self.sort_key in SORTS and self.sort_key:
            bits.append(("   " if bits.plain else "") + "SORT  ", style=FAINT)
            bits.append(SORTS[self.sort_key], style=f"bold {GOLD}")
        elif self.sort_key:
            key = next((lb["key"] for lb, _ in all_labels(self.data["recipes"]) if lb["key"].casefold() == self.sort_key), self.sort_key)
            bits.append(("   " if bits.plain else "") + "SORT  ", style=FAINT)
            bits.append(key, style=f"bold {GOLD}")
        self.query_one("#filters", Static).update(bits)
        self.query_one("#filters").display = bool(bits.plain)

    def amounts(self, r: dict) -> tuple[float, float | None]:
        s = self.scale.get(r["id"], {})
        f = R.factor_for(r, s.get("servings"), s.get("factor"))
        return f, (round(r["servings"] * f * 100) / 100 if r.get("servings") else None)

    def shown(self) -> dict | None:
        """The open recipe as it's shown: in English while E's translation is on."""
        r = self.current()
        tr = r and self.english.get(r["id"])
        return {**r, **tr["fields"]} if tr and tr["on"] else r

    def show_recipe(self) -> None:
        r = self.shown()
        tr = r and self.english.get(r["id"])
        bar = self.query_one("#english", Static)
        bar.display = bool(tr)
        if tr:
            bar.update(Text.assemble(
                (f"Translated from {tr['language']}" if tr["on"] else f"In {tr['language']}; the English is ready", MUTED),
                ("   E ", f"bold {GOLD}"), ("the original" if tr["on"] else "the English", INK),
                ("   S ", f"bold {GOLD}"), ("save the English", INK)))
        parts = ["#ing-head", "#ingredients", "#send", "#no-drift", "#steps-head", "#steps", "#notes-head", "#notes", "#serves", "#facts", "#marks", "#tags"]
        for p in parts:
            self.query_one(p).display = bool(r)
        if not r:
            self.show_board_reviews(None)
            self.query_one("#title", Static).update(Text("Your recipes will show up here. Paste a link above, or press n to type one in.", style=MUTED))
            return
        self.query_one("#title", Static).update(r["title"])
        bits = [b for b in (r.get("time"), r.get("yield") if r.get("yield") and not r["yield"].replace(".", "").isdigit() else "", host(r.get("source", ""))) if b]
        if r.get("image"):
            bits.append("has a picture (c changes it)")
        if r.get("share"):
            bits.append("shared by link (u)")
        self.query_one("#facts", Static).update(" · ".join(bits))
        self.query_one("#marks", Static).update(self.marks_line(self.current()))
        tags = Text()
        for i, lb in enumerate(r.get("labels", [])):
            tags.append(("" if i == 0 else "   ") + lb["key"], style=f"bold {GOLD}")
            if lb.get("value"):
                tags.append(" " + lb["value"], style=INK)
        self.query_one("#tags", Static).update(tags)
        self.query_one("#tags").display = bool(tags.plain)
        f, servings = self.amounts(r)
        line = Text("−  ", style=GOLD)
        if servings is not None:
            line.append(f"{R.format_amount(servings)} serving{'' if servings == 1 else 's'}", style=f"bold {INK}")
        else:
            line.append(f"×{R.format_amount(f)}", style=f"bold {INK}")
        line.append("  +", style=GOLD)
        if f != 1:
            line.append(f"   (the recipe makes {R.format_amount(r['servings'])})" if servings is not None else "   of the recipe", style=FAINT)
        self.query_one("#serves", Static).update(line)

        off = self.skip.get(r["id"], set())
        ing = self.query_one("#ingredients", SelectionList)
        terms = self.terms()
        found = set(R.ingredient_hits(r, terms) or []) if terms else set()
        at = ing.highlighted
        with self.prevent(SelectionList.SelectedChanged):
            ing.clear_options()
            for i, raw in enumerate(r["ingredients"]):
                scaled = R.scale_line(raw, f)
                line = Text(scaled, style=f"bold {GOLD}" if scaled != raw else INK)
                if i in found:
                    line.stylize("on #3a3420")
                ing.add_option(Selection(line, i, i not in off))
        if at is not None and r["ingredients"]:
            ing.highlighted = min(at, len(r["ingredients"]) - 1)
        has = bool(r["ingredients"])
        self.query_one("#ingredients").display = has
        drift = self.data.get("drift")
        self.query_one("#send").display = has and drift
        self.query_one("#no-drift").display = has and not drift
        self.query_one("#no-drift", Static).update(Text("Ask the site's admin for Drift to send these to a shopping list.", style=FAINT))
        if not has:
            self.query_one("#ing-head", Static).update(Text("INGREDIENTS  none yet; press e to add them", style=FAINT))
        else:
            self.query_one("#ing-head", Static).update(Text("INGREDIENTS  space ticks what to send", style=FAINT))
        if has and drift:
            self.show_send(r)
        for key in ("steps", "notes"):
            body = r.get(key)
            self.query_one(f"#{key}-head").display = bool(body)
            self.query_one(f"#{key}").display = bool(body)
        steps = Text()
        for i, s in enumerate(r.get("steps", []), 1):
            steps.append(f"{'' if i == 1 else chr(10) + chr(10)}{i}. ", style=f"bold {GOLD}")
            steps.append(s, style=INK)
        self.query_one("#steps", Static).update(steps)
        self.query_one("#notes", Static).update(Text(r.get("notes", ""), style=MUTED))
        self.show_board_reviews(self.current())
        self.refresh_bindings()   # E shows in the footer only for a recipe that isn't in English

    def marks_line(self, r: dict) -> Text:
        """Made it (when) and your stars, with the keys that change them."""
        line = Text()
        if r.get("made"):
            line.append(f"✓ Made {made_on(r['made'])}", style=f"bold {INK}")
            line.append("   m ", style=f"bold {GOLD}")
            line.append("not made", style=MUTED)
        else:
            line.append("Not made yet", style=MUTED)
            line.append("   m ", style=f"bold {GOLD}")
            line.append("I made this", style=INK)
        line.append("     ")
        n = r.get("rating") or 0
        line.append("★" * n, style=f"bold {GOLD}")
        line.append("☆" * (5 - n), style=GOLD_DIM)
        line.append("   1–5 ", style=f"bold {GOLD}")
        line.append("your rating" if n else "rate it", style=MUTED)
        return line

    def show_send(self, r: dict) -> None:
        n = len(r["ingredients"]) - len([i for i in self.skip.get(r["id"], set()) if i < len(r["ingredients"])])
        btn = self.query_one("#send-btn", Button)
        btn.label = f"Send {n} to"
        btn.disabled = not n
        lists = self.data.get("lists", [])
        mine = next((x for x in lists if not x.get("owner_name") and x["name"].lower() == SHOPPING.lower()), None)
        options = [(SHOPPING if mine else f"{SHOPPING} (new)", "")]
        options += [(f"{x['name']} ({x['owner_name']}'s)" if x.get("owner_name") else x["name"], x["id"]) for x in lists if x is not mine]
        sel = self.query_one("#list", Select)
        keep = sel.value if isinstance(sel.value, str) and any(v == sel.value for _, v in options) else ""
        with sel.prevent(Select.Changed):
            sel.set_options(options)
            sel.value = keep

    # ── picking and scaling ───────────────────────────────────────────────

    def on_option_list_option_highlighted(self, e: OptionList.OptionHighlighted) -> None:
        if e.option_list.id == "shelf" and e.option.id and e.option.id != self.open:
            self.open = e.option.id
            self.show_recipe()

    def on_option_list_option_selected(self, e: OptionList.OptionSelected) -> None:
        if e.option_list.id == "shelf" and self.current() and self.current()["ingredients"]:
            self.query_one("#ingredients", SelectionList).focus()

    def on_selection_list_selected_changed(self, e: SelectionList.SelectedChanged) -> None:
        r = self.current()
        if not r:
            return
        on = set(e.selection_list.selected)
        self.skip[r["id"]] = {i for i in range(len(r["ingredients"])) if i not in on}
        if self.data.get("drift"):
            self.show_send(r)

    def action_servings(self, step: int) -> None:
        r = self.current()
        if not r:
            return
        f, servings = self.amounts(r)
        if servings is not None:
            self.scale[r["id"]] = {"servings": max(1, round(servings) + step)}
        else:
            self.scale[r["id"]] = {"factor": max(0.5, round((f + step * 0.5) * 2) / 2)}
        self.show_recipe()

    def check_action(self, action: str, parameters: tuple) -> bool | None:
        # Typing in the link box or the editor shouldn't scale or delete anything.
        if action == "board" and not (self.data or {}).get("board"):
            return None
        if action == "labels_tab" and not (self.data or {}).get("labels"):
            return False
        if action == "english" and not self.offers_english():
            return False   # the footer's E; the hidden one (english_any) still translates

        if action in ("servings", "add", "find", "new", "share", "import_file", "photo", "paste", "key", "edit", "picture", "send", "delete", "refresh", "board", "labels", "suggest", "ingredients", "sort", "english", "english_any", "save_english",
                      "made", "rate", "made_filter", "rating_filter", "reviews") and isinstance(self.focused, (Input, TextArea)):
            return False
        return True

    # ── adding, editing and deleting ──────────────────────────────────────

    def action_add(self) -> None:
        self.query_one("#url", Input).focus()

    def leave_field(self) -> bool:
        if self.focused is self.query_one("#url", Input):
            self.query_one("#shelf", OptionList).focus()
            return True
        return False

    async def on_input_submitted(self, e: Input.Submitted) -> None:
        if e.input.id == "url" and e.value.strip():
            await self.save_from(e.value.strip())

    async def save_from(self, url: str) -> None:
        box = self.query_one("#url", Input)
        box.disabled = True
        self.app.notify("Reading that page…", timeout=2)
        try:
            r = await asyncio.to_thread(site.save_recipe_from, url)
        except site.SignedOut:
            self.app.signed_out = True
            self.app.exit(message="Signed out on the site. Run  sintfoap login  to sign in again.")
            return
        except site.SiteError as e:
            box.disabled = False
            box.focus()
            if "by hand" in str(e):
                # No recipe on the page: type it in, with the link filled in.
                self.app.notify("Couldn't find a recipe on that page, so type it in here.", timeout=4)
                self.app.push_screen(RecipeDialog(None, url, label_list=self.data.get("label_list")), self.after_dialog(None))
            else:
                self.app.notify(str(e).removeprefix("the site said: ").capitalize(), severity="error", timeout=5)
            return
        box.disabled = False
        box.value = ""
        self.app.notify(f"Saved {r['title']}.", timeout=3)
        await self.saved(r)

    async def saved(self, r: dict) -> None:
        self.data["recipes"] = by_title([x for x in self.data["recipes"] if x["id"] != r["id"]] + [r])
        self.open = r["id"]
        self.show_shelf()
        self.show_recipe()
        self.query_one("#shelf", OptionList).focus()

    def action_new(self) -> None:
        url = self.query_one("#url", Input).value.strip()
        self.app.push_screen(RecipeDialog(None, url, label_list=self.data.get("label_list")), self.after_dialog(None))

    def action_edit(self) -> None:
        r = self.current()
        if r:
            self.app.push_screen(RecipeDialog(r, label_list=self.data.get("label_list")), self.after_dialog(r))

    # ── a recipe's picture ────────────────────────────────────────────────

    def action_picture(self) -> None:
        r = self.current()
        if not r:
            return
        has = bool(r.get("image"))

        async def answer(path: str | None) -> None:
            if path is None:
                return
            if path.strip():
                await self.set_picture(r, path.strip())
            elif has:
                await self.remove_picture(r)
        self.app.push_screen(Ask(f"Picture for {r['title']}",
                                 f"A path to a JPEG, PNG, WebP or GIF of at most {site.RECIPE_PHOTO_BYTES // 1024} KB "
                                 "(the website shrinks bigger ones for you)."
                                 + (" Leave it empty to take the picture it has off." if has else ""),
                                 placeholder="~/Pictures/dinner.jpg", ok="Save"), answer)

    @attempt
    async def set_picture(self, r: dict, path: str) -> None:
        file = Path(path.strip("'\"")).expanduser()
        try:
            raw = await asyncio.to_thread(file.read_bytes)
        except OSError as e:
            self.app.notify(f"Couldn't read {file}: {e.strerror or e}.", severity="error", timeout=5)
            return
        if len(raw) > site.RECIPE_PHOTO_BYTES:
            self.app.notify(f"That picture is {len(raw) // 1024} KB; the most the site keeps is {site.RECIPE_PHOTO_BYTES // 1024} KB. "
                            "Make it smaller first, or add it from the website, which shrinks it for you.", severity="error", timeout=8)
            return
        await self.saved(await self.fetch(site.set_recipe_photo, r["id"], raw))
        self.app.notify(f"{r['title']} has a new picture.", timeout=3)

    @attempt
    async def remove_picture(self, r: dict) -> None:
        await self.saved(await self.fetch(site.remove_recipe_photo, r["id"]))
        self.app.notify(f"Took the picture off {r['title']}.", timeout=3)

    def after_dialog(self, was: dict | None):
        async def done(fields: dict | None) -> None:
            if fields and fields.get("_delete") and was:
                self.ask_delete(was)
            elif fields is not None:
                await self.save(was, fields)
        return done

    @attempt
    async def save(self, was: dict | None, fields: dict) -> None:
        picture = self.pending_picture if fields.pop("_picture", False) and not was else None
        self.pending_picture = None
        if was:
            r = await self.fetch(site.update_recipe, was["id"], fields)
            self.english.pop(r["id"], None)
            if r.get("servings") != was.get("servings"):
                self.scale.pop(r["id"], None)
        else:
            r = await self.fetch(site.add_recipe, fields)
            self.query_one("#url", Input).value = ""
            if picture:
                r = await self.fetch(site.set_recipe_photo, r["id"], picture)
        self.app.notify(f"Saved {r['title']}.", timeout=2)
        await self.saved(r)

    def action_labels(self) -> None:
        """l: filter the shelf by labels."""
        labels = all_labels((self.data or {}).get("recipes", []))
        if not labels:
            self.app.notify("None of your recipes have labels yet. Press e to tick some.", timeout=4)
            return

        def chosen(picked: list | None) -> None:
            if picked is not None:
                self.filters = picked
                self.reshelve()
        self.app.push_screen(LabelFilter(labels, self.filters), chosen)

    def action_find(self) -> None:
        """/: find by name, as the website's search box does: titles, labels and ingredients' words."""
        def chosen(text: str | None) -> None:
            if text is not None:
                self.find_name, self.ingredients = text.strip(), ""
                self.reshelve()
        self.app.push_screen(Ask("Find a recipe", "By its name, a label or any ingredient's words. f finds by ingredient instead. "
                                 "Leave it empty to show every recipe.", self.find_name, "chili", ok="Find"), chosen)

    def action_ingredients(self) -> None:
        """f: show only recipes with these ingredients (commas between; -nuts leaves out ones with nuts)."""
        def chosen(text: str | None) -> None:
            if text is not None:
                self.ingredients, self.find_name = text.strip(), ""
                self.reshelve()
        self.app.push_screen(Ask("Find by ingredient", "Separate several with commas; all of them must be in the recipe. "
                                 "-nuts leaves out recipes with nuts. Leave it empty to show every recipe.",
                                 self.ingredients, "eggs, spinach, -nuts", ok="Find"), chosen)

    @attempt
    async def action_suggest(self) -> None:
        """L: labels for the whole box, from each recipe's words, to check before they're added."""
        self.app.notify("Looking through your recipes…", timeout=2)
        out = await self.fetch(site.suggest_recipe_labels)
        if not out["labels"]:
            self.app.notify("There are no labels to suggest yet. Whoever keeps Recipe labels adds them there, like Season: Fall.", timeout=5)
            return
        if not out["suggestions"]:
            self.app.notify(f"Checked {plural(out['checked'], 'recipe')} against {plural(out['labels'], 'label')}: nothing new to suggest. "
                            "A label is matched by its name, and by keywords set on it in Recipe labels.", timeout=6)
            return

        async def chosen(add: list | None) -> None:
            if add:
                await self.add_labels(add)
        self.app.push_screen(SuggestLabels(out), chosen)

    @attempt
    async def add_labels(self, add: list[dict]) -> None:
        recipes = labels = full = 0
        for i in range(0, len(add), site.ADD_LABELS_BATCH):
            if len(add) > site.ADD_LABELS_BATCH:
                self.app.notify(f"Adding labels: {i} of {len(add)} recipes…", timeout=2)
            out = await self.fetch(site.add_labels_to_recipes, add[i:i + site.ADD_LABELS_BATCH])
            recipes += out["recipes"]
            labels += out["labels"]
            full += out["full"]
        await self.action_refresh()
        extra = f" {plural(full, 'recipe')} already had 20 labels, the most one can have, so got only some." if full else ""
        self.app.notify(f"Added {plural(labels, 'label')} to {plural(recipes, 'recipe')}.{extra}", timeout=6)

    def action_sort(self) -> None:
        """o: sort by title, then by each label's key in turn, then your rating and the last made."""
        keys = sorted({lb["key"].casefold() for lb, _ in all_labels((self.data or {}).get("recipes", []))})
        order = [""] + keys + ["@rating", "@made"]
        self.sort_key = order[(order.index(self.sort_key) + 1) % len(order)] if self.sort_key in order else ""
        self.reshelve()
        self.app.notify(f"Sorted by {SORTS.get(self.sort_key, self.sort_key)}.", timeout=2)

    # ── made it, and your stars ───────────────────────────────────────────

    @attempt
    async def mark(self, changes: dict) -> None:
        r = self.current()
        if not r:
            return
        fresh = await self.fetch(site.update_recipe, r["id"], changes)
        self.data["recipes"] = [fresh if x["id"] == r["id"] else x for x in self.data["recipes"]]
        self.reshelve()

    async def action_made(self) -> None:
        """m: mark the open recipe made today, or take the mark (and its stars) off."""
        r = self.current()
        if r:
            await self.mark(mark_changes(r, made=not r.get("made")))

    async def action_rate(self, n: int) -> None:
        """1–5: that many stars (the same again, or 0, takes them off)."""
        r = self.current()
        if r and (n or r.get("rating")):
            await self.mark(mark_changes(r, rating=n))

    def action_made_filter(self) -> None:
        """M: only the ones you've made (something familiar), then only the new ones, then all."""
        self.made_filter = MADE_FILTERS[(MADE_FILTERS.index(self.made_filter) + 1) % len(MADE_FILTERS)]
        self.reshelve()
        self.app.notify({"": "Showing made and not made.", "made": "Showing ones you've made.", "new": "Showing ones you haven't made yet."}[self.made_filter], timeout=2)

    def action_rating_filter(self) -> None:
        """R: at least 5 stars, then 4, 3, 2, 1, then not rated, then any."""
        self.rating_filter = RATING_FILTERS[(RATING_FILTERS.index(self.rating_filter) + 1) % len(RATING_FILTERS)]
        self.reshelve()
        f = self.rating_filter
        self.app.notify("Any rating." if not f else "Not rated yet." if f == "none" else f"{stars(int(f))}{'' if f == '5' else ' and up'}.", timeout=2)

    def reshelve(self) -> None:
        shown = self.shelved()
        if not any(r["id"] == self.open for r in shown):
            self.open = shown[0]["id"] if shown else None
        self.show_shelf()
        self.show_recipe()

    def action_labels_tab(self) -> None:
        """ctrl+l: the Labels tab, the one label list (Recipe labels) recipes pick from."""
        from .labels_page import LabelsPage
        self.app.push_screen(LabelsPage())

    def action_board(self) -> None:
        """b: share the open recipe on the Recipe board (for anyone with it)."""
        r = self.current()
        if r and (self.data or {}).get("board"):
            from .board_page import BoardPage
            self.app.push_screen(BoardPage(share=r["id"]))

    # ── share links ───────────────────────────────────────────────────────

    @attempt
    async def action_share(self) -> None:
        """u: a link anyone can read the open recipe at, no account needed; made the first time, then the same one until it's turned off."""
        r = self.current()
        if not r:
            return
        if not r.get("share"):
            r["share"] = (await self.fetch(site.share_recipe, r["id"]))["share"]
            self.show_recipe()
        url = site.site_url(r["share"])

        async def answer(what: str | None) -> None:
            if what == "copy":
                self.app.copy_to_clipboard(url)
                self.app.notify(f"Copied the link to {r['title']}: {url}", timeout=5)
            elif what == "stop":
                await self.unshare(r)
        self.app.push_screen(ShareDialog(r["title"], url), answer)

    @attempt
    async def unshare(self, r: dict) -> None:
        await self.fetch(site.unshare_recipe, r["id"])
        r["share"] = None
        self.show_recipe()
        self.app.notify(f"The link to {r['title']} is off; it won't open any more.", timeout=4)

    # ── importing a file ──────────────────────────────────────────────────

    def action_import_file(self) -> None:
        async def answer(path: str | None) -> None:
            if path and path.strip():
                await self.import_file(path.strip())
        self.app.push_screen(Ask("Import recipes from a file",
                                 "Recipe Keeper's export (its recipes.html, its folder, or its .zip), or a recipe page you saved. "
                                 "The export's pictures come too. Recipes already in your box are skipped, "
                                 "but get their picture if they have none.",
                                 placeholder="~/Downloads/recipes.html", ok="Import"), answer)

    @attempt
    async def import_file(self, path: str) -> None:
        where = Path(path.strip("'\"")).expanduser()
        try:
            html, images = await asyncio.to_thread(gather, where)
        except (OSError, zipfile.BadZipFile) as e:
            self.app.notify(f"Couldn't read {where}: {getattr(e, 'strerror', None) or e}.", severity="error", timeout=5)
            return
        if not html:
            self.app.notify("There's no recipe file (.html) there.", severity="error", timeout=4)
            return
        added: list[dict] = []
        skipped: list[dict] = []
        wants: list[tuple[str, str]] = []      # (recipe id, picture) for recipes without one yet
        pointed = done = total = 0
        for text in html:
            pages = R.split_pages(text)
            total += len(pages)
            for group in R.batches(pages):
                self.app.notify(f"Importing {where.name}: {done} of {total}…", timeout=2)
                out = await self.fetch(site.import_recipes, group)
                added += out["added"]
                skipped += out["skipped"]
                for page, r in zip(group, out.get("pages") or [None] * len(group)):
                    photo = R.photo_of(page)
                    pointed += bool(photo)
                    if photo and r and not r["image"] and R.file_key(photo) in images:
                        wants.append((r["id"], photo))
                done += len(group)
                if out["added"]:
                    # Shown as they come, so a failure part way keeps what got in.
                    self.data["recipes"] = by_title(self.data["recipes"] + out["added"])
                    self.open = self.open or out["added"][0]["id"]
                    self.show_shelf()
        if not added and not wants and total == 1 and skipped and skipped[0]["why"] == "had no recipe":
            self.app.notify("Couldn't find a recipe in that file.", severity="error", timeout=4)
            return
        pictures = too_big = 0
        for n, (rid, photo) in enumerate(wants):
            if n % 10 == 0:
                self.app.notify(f"Adding pictures: {n} of {len(wants)}…", timeout=2)
            raw = await asyncio.to_thread(images[R.file_key(photo)])
            if len(raw) > site.RECIPE_PHOTO_BYTES:
                too_big += 1
                continue
            r = await self.fetch(site.set_recipe_photo, rid, raw)
            self.data["recipes"] = by_title([x for x in self.data["recipes"] if x["id"] != r["id"]] + [r])
            pictures += 1
        if added or wants:
            self.open = (added[0]["id"] if added else wants[0][0])
            self.show_shelf()
            self.show_recipe()
        # Only filling in pictures: say that, not that every recipe was skipped.
        fill_only = not added and pictures
        if fill_only:
            text = f"Added {plural(pictures, 'picture')} from {where.name} to recipes already in your box."
            skipped = [x for x in skipped if x["why"] != "already in your box"]
        else:
            text = f"Imported {plural(len(added), 'recipe')} from {where.name}"
            text += f" and added {plural(pictures, 'picture')}." if pictures else "."
        if skipped:
            text += f" Skipped {len(skipped)}: {R.skipped_summary(skipped)}."
        if too_big:
            text += f" {plural(too_big, 'picture')} over {site.RECIPE_PHOTO_BYTES // 1024} KB stayed behind; the website shrinks them."
        if pointed and not images:
            text += " Their pictures weren't beside the file; give the export's folder or .zip to bring them."
        self.app.notify(text, timeout=10)

    # ── reading one from a photo ──────────────────────────────────────────

    # A photo is read by Claude when you've added an Anthropic key (k), which
    # also reads handwriting; otherwise by the site's own AI (Workers AI, no
    # key); and only when neither can, on this computer by tesseract.
    def action_photo(self) -> None:
        async def answer(paths: str | None) -> None:
            if paths and paths.strip():
                await self.from_photo([x.strip() for x in paths.split(",") if x.strip()])
        photo = (self.data or {}).get("photo") or {}
        who = ("Claude reads it, with your key. " if photo.get("ready") else
               "The site's AI reads it (Cloudflare's, no key needed). " if photo.get("ai") else
               "It's read on this computer by tesseract, no AI. ")
        self.app.push_screen(Ask("Read a recipe from a photo",
                                 "A picture of a cookbook page, a recipe card or a screenshot (a recipe over several pages: up to 4 files, "
                                 "separated by commas). " + who + "You check it before it's saved.",
                                 placeholder="~/Pictures/banana-bread.jpg", ok="Read it"), answer)

    def action_key(self) -> None:
        if not ((self.data or {}).get("photo") or {}).get("sealing"):
            self.app.notify("This site can't keep API keys yet. Ask its admin to set CHAT_BRIDGE_KEY.", severity="error", timeout=6)
            return

        async def answer(key: str | None) -> None:
            if key and key.strip():
                await self.save_key(key.strip())
        self.app.push_screen(Ask("Read photos with Claude",
                                 "Without a key, photos are read by the site's AI (Cloudflare's), or by tesseract on this computer when that can't. "
                                 "Claude reads them better, handwriting too, with your own Anthropic API key "
                                 "(console.anthropic.com/settings/keys), so nobody else is billed for yours. "
                                 "It's kept sealed on the site; Sweep uses the same one.",
                                 placeholder="sk-ant-…", ok="Save key", password=True), answer)

    @attempt
    async def save_key(self, key: str) -> None:
        self.data["photo"] = (await self.fetch(site.recipe_key, key))["photo"]
        self.app.notify("Key saved: photos are read by Claude now.", timeout=3)

    async def from_photo(self, paths: list[str]) -> None:
        photo = (self.data or {}).get("photo") or {}
        claude, ai = photo.get("ready"), photo.get("ai")
        self.app.notify(f"Reading {'the photo' if len(paths) == 1 else f'{len(paths)} photos'}…", timeout=8)

        def short(msg: str) -> str:
            return re.split(r"\.\s", msg)[0].rstrip(".")

        def read() -> dict:
            out = None
            if claude or ai:
                try:
                    out = site.read_recipe_photo(paths)
                    out["by_claude"] = out.get("by", "claude") == "claude"
                    if out.get("why"):
                        # Claude couldn't (a spent key, busy), and the site's AI read it instead.
                        if "didn't accept your API key" in out["why"]:
                            self.data["photo"] = {**self.data.get("photo", {}), "ready": False}
                        out["fell_back"] = f"Claude couldn't read it ({short(out['why'])}), so the site's AI read it instead."
                except site.SignedOut:
                    raise
                except site.SiteError as e:
                    # A revoked or spent key, the AI busy, no connection: read it here instead.
                    msg = str(e).removeprefix("the site said: ")
                    if "couldn't find a recipe" in msg:
                        raise
                    if "didn't accept your API key" in msg:
                        self.data["photo"] = {**self.data.get("photo", {}), "ready": False}
                    why = f"{'Claude' if claude else 'The site' + chr(39) + 's AI'} couldn't read it ({short(msg)}), so it was read here by text recognition."
            if out is None:
                out = site.read_photo_here(paths)
                if claude or ai:
                    out["fell_back"] = why
            # The recipe's picture: the dish's photo cut from the page (Claude's box, or looked for
            # around tesseract's lines), or the whole photo.
            box = out["recipe"].pop("picture", None)
            out["dish"] = site.dish_picture(paths[0], box, out.get("text"))
            return out

        await self.review(read, hint="Check it against the picture, fix any misread words, "
                                     "and move lines between the boxes if one landed in the wrong place.")

    def action_paste(self) -> None:
        self.app.push_screen(PasteDialog(), self.after_paste)

    async def after_paste(self, text: str | None) -> None:
        if text and text.strip():
            await self.review(lambda: site.read_recipe_text(text), hint="Read from the text you pasted. Check that each line landed in the right box, then save.")

    async def review(self, fn, *args, hint: str) -> bool:
        """Runs a reader off the UI thread and opens what it found in the editor, to check before saving."""
        try:
            out = await asyncio.to_thread(fn, *args)
        except site.SignedOut:
            self.app.signed_out = True
            self.app.exit(message="Signed out on the site. Run  sintfoap login  to sign in again.")
            return False
        except site.SiteError as e:
            msg = str(e).removeprefix("the site said: ")
            if "didn't accept your API key" in msg:
                self.data["photo"] = {**self.data.get("photo", {}), "ready": False}
                msg = "Anthropic didn't accept your API key, so photos are read here for now. Press k to add a new one."
            self.app.notify(msg[:1].upper() + msg[1:], severity="error", timeout=8)
            return False
        r = out["recipe"]
        if "fell_back" in out:
            hint = out["fell_back"] + " " + hint
        elif out.get("by") == "ai":
            hint = "Read from your photo by the site's AI (Cloudflare's, no key needed). " + hint
        elif out.get("by_claude"):
            hint = "Read from your photo by Claude. " + hint
        elif "dish" in out:
            hint = "Read from your photo by text recognition. " + hint
        picture, whole = None, False
        if out.get("dish") and out["dish"][0]:
            picture, whole = out["dish"][0], not out["dish"][1]
        self.pending_picture = picture
        if r.get("check"):
            hint += " Look twice at the amounts in " + ", ".join(f"“{x}”" for x in r["check"]) + ": fractions like ½ and ¾ are easy to misread."
        fields = {k: v for k, v in r.items() if k not in ("check", "picture")}
        offer = None if not picture else "the whole photo" if whole else "the dish's photo from the page"
        self.app.push_screen(RecipeDialog(fields, heading="Check the recipe", hint=hint, label_list=self.data.get("label_list"), picture=offer),
                             self.after_dialog(None))
        return True

    # ── translating ───────────────────────────────────────────────────────

    def offers_english(self) -> bool:
        """Whether the footer offers E: the open recipe doesn't read as English, or its English is ready."""
        r = self.current()
        return bool(r) and (r["id"] in self.english or not R.looks_english(r))

    async def action_english_any(self) -> None:
        await self.action_english()

    @attempt
    async def action_english(self) -> None:
        """E: the open recipe in English, or back and forth between it and the original."""
        r = self.current()
        if not r:
            return
        tr = self.english.get(r["id"])
        if tr:
            tr["on"] = not tr["on"]
            self.show_recipe()
            return
        self.app.notify(f"Translating {r['title']}…", timeout=2)
        out = await self.fetch(site.translate_recipe, r["id"])
        if out.get("english"):
            self.app.notify(f"{r['title']} is already in English.", timeout=3)
            return
        self.english[r["id"]] = {"language": out["language"], "fields": out["fields"], "on": True}
        if self.open == r["id"]:
            self.show_recipe()

    def action_save_english(self) -> None:
        r = self.current()
        tr = r and self.english.get(r["id"])
        if not tr:
            self.app.notify("Press E to translate it first.", timeout=3)
            return

        async def answer(yes: bool | None) -> None:
            if yes:
                await self.save_english(r, tr)
        self.app.push_screen(Confirm(f"Save the English over the {tr['language']}?", f"{r['title']}'s words are replaced; the original isn't kept.",
                                     yes="Save the English"), answer)

    @attempt
    async def save_english(self, r: dict, tr: dict) -> None:
        saved = await self.fetch(site.update_recipe, r["id"], tr["fields"])
        self.english.pop(r["id"], None)
        self.data["recipes"] = by_title([saved if x["id"] == r["id"] else x for x in self.data["recipes"]])
        self.reshelve()
        self.app.notify(f"Saved {saved['title']} in English.", timeout=3)

    def action_delete(self) -> None:
        r = self.current()
        if r:
            self.ask_delete(r)

    def ask_delete(self, r: dict) -> None:
        async def answer(yes: bool | None) -> None:
            if yes:
                await self.delete(r)
        self.app.push_screen(Confirm(f"Delete {r['title']}?", "It's gone for good; anything already sent to Drift stays there.",
                                     yes="Delete", danger=True), answer)

    @attempt
    async def delete(self, r: dict) -> None:
        await self.fetch(site.delete_recipe, r["id"])
        self.data["recipes"] = [x for x in self.data["recipes"] if x["id"] != r["id"]]
        self.open = None
        self.reshelve()

    # ── sending to Drift ──────────────────────────────────────────────────

    async def on_button_pressed(self, e: Button.Pressed) -> None:
        if e.button.id == "send-btn":
            await self.action_send()

    @attempt
    async def action_send(self) -> None:
        r = self.current()
        if not r or not r["ingredients"] or not self.data.get("drift"):
            return
        off = self.skip.get(r["id"], set())
        lines = [i for i in range(len(r["ingredients"])) if i not in off]
        if not lines:
            self.app.notify("Tick at least one ingredient to send.", severity="error", timeout=3)
            return
        s = self.scale.get(r["id"], {})
        to = self.query_one("#list", Select).value
        out = await self.fetch(lambda: site.shop(r["id"], lines, s.get("servings"), s.get("factor"), to if isinstance(to, str) and to else None))
        if not any(x["id"] == out["list"]["id"] for x in self.data["lists"]):
            self.data["lists"].insert(0, {"id": out["list"]["id"], "name": out["list"]["name"], "owner_name": None})
            self.show_send(r)
        self.app.notify(f"Added {plural(out['added'], 'ingredient')} to {out['list']['name']} in Drift.", timeout=3)
