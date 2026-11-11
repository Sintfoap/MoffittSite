"""Recipe box in the terminal: the same recipes as /recipes/.

Your recipes down the left, the open one on the right, scaled to the servings
you pick (+ and -). Space ticks which ingredients to send, and s sends them to
a Drift list. A link pasted in the box at the top is read by the site, as on
the website; n types one in by hand, i imports a file of them (Recipe
Keeper's export, with its pictures, or a saved recipe page), p reads one from
a photo (a cookbook page, a screenshot: by tesseract on this computer, or by
Claude with your key, k) and t from pasted text, for you to check before
it's saved. l filters the shelf by labels and f by ingredients ("eggs,
spinach, -nuts"), with the lines it found lit up."""
from __future__ import annotations

import asyncio
import re
import zipfile
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


def arranged(recipes: list[dict], filters: list[dict], sort_key: str, terms: list[dict] | None = None) -> list[dict]:
    """The shelf: the recipes the filters (and ingredient terms) let through, by title or by a label's value (those without it last)."""
    shown = [r for r in by_title(recipes) if passes(r, filters) and (not terms or R.ingredient_hits(r, terms) is not None)]
    if sort_key:
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
    RecipesPage #steps, RecipesPage #notes {{ margin-bottom: 1; }}
    """
    BINDINGS = [
        Binding("a", "add", "From a link"),
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
        Binding("f", "ingredients", "Ingredients"),
        Binding("o", "sort", "Sort"),
        Binding("b", "board", "Share on board"),
        Binding("E", "english", "English"),
        Binding("S", "save_english", "Save the English", show=False),
        Binding("d", "delete", "Delete"),
        Binding("r", "refresh", "Refresh"),
        Binding("backslash", "fold", "Shelf"),
    ]

    def __init__(self):
        super().__init__()
        self.data: dict | None = None
        self.open: str | None = None
        self.scale: dict[str, dict] = {}       # recipe id → {servings} or {factor}
        self.skip: dict[str, set[int]] = {}    # recipe id → ingredient indexes not to send
        self.pending_picture: bytes | None = None   # a photo draft's picture, kept once it's saved if ticked
        self.filters: list[dict] = []          # labels the shelf shows only recipes with
        self.sort_key = ""                     # "" by title, else a label's key
        self.ingredients = ""                  # what f looks for: "eggs, spinach, -nuts"
        self.english: dict[str, dict] = {}     # recipe id → {language, fields, on}: E's translation, shown while on

    def compose(self) -> ComposeResult:
        yield from self.top()
        with Vertical(id="body"):
            yield Static("R E C I P E   B O X", classes="kicker")
            yield Input(placeholder="Paste a link to a recipe (any site, or Recipe Keeper) and press enter (a)", id="url")
            yield Static(id="filters")
            with Horizontal(id="main"):
                yield OptionList(id="shelf")
                with VerticalScroll(id="recipe"):
                    yield Static(id="english")
                    yield Static(id="title")
                    yield Static(id="facts")
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
        yield Footer()

    async def on_mount(self) -> None:
        await self.action_refresh()
        self.query_one("#shelf", OptionList).focus()

    # ── loading and showing ───────────────────────────────────────────────

    @attempt
    async def action_refresh(self) -> None:
        self.data = await self.fetch(site.recipes)
        self.data["recipes"] = by_title(self.data["recipes"])
        shown = self.shelved()
        if not any(r["id"] == self.open for r in shown):
            self.open = shown[0]["id"] if shown else None
        self.show_shelf()
        self.show_recipe()

    def terms(self) -> list[dict]:
        return R.ingredient_terms(self.ingredients)

    def shelved(self) -> list[dict]:
        return arranged(self.data["recipes"], self.filters, self.sort_key, self.terms())

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
                why = "Nothing matches. " + " or ".join(k for k, on in (("l", self.filters), ("f", self.ingredients.strip())) if on) + " changes the filter."
                shelf.add_option(Option(Text(why, style=FAINT), disabled=True))
                return
            terms = self.terms()
            for r in recipes:
                sorted_by = value_of(r, self.sort_key) if self.sort_key else None
                sub = " · ".join(x for x in (sorted_by, r.get("time"), host(r.get("source", ""))) if x) or plural(len(r["ingredients"]), "ingredient")
                t = Text.assemble((r["title"], f"bold {INK}"), ("\n" + sub, FAINT))
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
        terms = self.terms()
        if terms:
            bits.append(("   " if bits.plain else "") + "INGREDIENTS  ", style=FAINT)
            bits.append(", ".join(("without " if t["without"] else "") + t["text"] for t in terms), style=f"bold {GOLD}")
            bits.append("   f changes", style=FAINT)
        if self.sort_key:
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
        parts = ["#ing-head", "#ingredients", "#send", "#no-drift", "#steps-head", "#steps", "#notes-head", "#notes", "#serves", "#facts", "#tags"]
        for p in parts:
            self.query_one(p).display = bool(r)
        if not r:
            self.query_one("#title", Static).update(Text("Your recipes will show up here. Paste a link above, or press n to type one in.", style=MUTED))
            return
        self.query_one("#title", Static).update(r["title"])
        bits = [b for b in (r.get("time"), r.get("yield") if r.get("yield") and not r["yield"].replace(".", "").isdigit() else "", host(r.get("source", ""))) if b]
        if r.get("image"):
            bits.append("has a picture (c changes it)")
        self.query_one("#facts", Static).update(" · ".join(bits))
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
        if action in ("servings", "add", "new", "import_file", "photo", "paste", "key", "edit", "picture", "send", "delete", "refresh", "board", "labels", "ingredients", "sort", "english", "save_english") and isinstance(self.focused, (Input, TextArea)):
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
            if fields is not None:
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

    def action_ingredients(self) -> None:
        """f: show only recipes with these ingredients (commas between; -nuts leaves out ones with nuts)."""
        def chosen(text: str | None) -> None:
            if text is not None:
                self.ingredients = text.strip()
                self.reshelve()
        self.app.push_screen(Ask("Find by ingredient", "Separate several with commas; all of them must be in the recipe. "
                                 "-nuts leaves out recipes with nuts. Leave it empty to show every recipe.",
                                 self.ingredients, "eggs, spinach, -nuts", ok="Find"), chosen)

    def action_sort(self) -> None:
        """o: sort by title, then by each label's key in turn."""
        keys = sorted({lb["key"].casefold() for lb, _ in all_labels((self.data or {}).get("recipes", []))})
        order = [""] + keys
        self.sort_key = order[(order.index(self.sort_key) + 1) % len(order)] if self.sort_key in order else ""
        self.reshelve()
        self.app.notify(f"Sorted by {self.sort_key or 'title'}.", timeout=2)

    def reshelve(self) -> None:
        shown = self.shelved()
        if not any(r["id"] == self.open for r in shown):
            self.open = shown[0]["id"] if shown else None
        self.show_shelf()
        self.show_recipe()

    def action_board(self) -> None:
        """b: share the open recipe on the Recipe board (for anyone with it)."""
        r = self.current()
        if r and (self.data or {}).get("board"):
            from .board_page import BoardPage
            self.app.push_screen(BoardPage(share=r["id"]))

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

    # A photo is read on this computer by tesseract (no AI, no key), or by
    # Claude when you've added an Anthropic key (k), which also reads handwriting.
    def action_photo(self) -> None:
        async def answer(paths: str | None) -> None:
            if paths and paths.strip():
                await self.from_photo([x.strip() for x in paths.split(",") if x.strip()])
        claude = ((self.data or {}).get("photo") or {}).get("ready")
        self.app.push_screen(Ask("Read a recipe from a photo",
                                 "A picture of a cookbook page or a screenshot (a recipe over several pages: up to 4 files, "
                                 "separated by commas). " + ("Claude reads it, with your key. " if claude else
                                 "It's read on this computer by tesseract, no AI. ") + "You check it before it's saved.",
                                 placeholder="~/Pictures/banana-bread.jpg", ok="Read it"), answer)

    def action_key(self) -> None:
        if not ((self.data or {}).get("photo") or {}).get("sealing"):
            self.app.notify("This site can't keep API keys yet. Ask its admin to set CHAT_BRIDGE_KEY.", severity="error", timeout=6)
            return

        async def answer(key: str | None) -> None:
            if key and key.strip():
                await self.save_key(key.strip())
        self.app.push_screen(Ask("Read photos with Claude",
                                 "Without a key, photos are read by tesseract on this computer, which is good with printed pages. "
                                 "Claude reads them better, handwriting too, with your own Anthropic API key "
                                 "(console.anthropic.com/settings/keys), so nobody else is billed for yours. "
                                 "It's kept sealed on the site; Sweep uses the same one.",
                                 placeholder="sk-ant-…", ok="Save key", password=True), answer)

    @attempt
    async def save_key(self, key: str) -> None:
        self.data["photo"] = (await self.fetch(site.recipe_key, key))["photo"]
        self.app.notify("Key saved: photos are read by Claude now.", timeout=3)

    async def from_photo(self, paths: list[str]) -> None:
        claude = ((self.data or {}).get("photo") or {}).get("ready")
        self.app.notify(f"Reading {'the photo' if len(paths) == 1 else f'{len(paths)} photos'}…", timeout=8)

        def read() -> dict:
            out = None
            if claude:
                try:
                    out = {**site.read_recipe_photo(paths), "by_claude": True}
                except site.SignedOut:
                    raise
                except site.SiteError as e:
                    # A revoked or spent key, Claude busy, no connection: read it here instead.
                    msg = str(e).removeprefix("the site said: ")
                    if "couldn't find a recipe" in msg:
                        raise
                    if "didn't accept your API key" in msg:
                        self.data["photo"] = {**self.data.get("photo", {}), "ready": False}
                    why = re.split(r"\.\s", msg)[0].rstrip(".")
            if out is None:
                out = site.read_photo_here(paths)
                if claude:
                    out["fell_back"] = why
            # The recipe's picture: the dish's photo cut from the page, or the whole photo.
            box = out["recipe"].pop("picture", None)
            out["dish"] = site.dish_picture(paths[0], box, None if out.get("by_claude") else out.get("text", []))
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
            hint = f"Claude couldn't read it ({out['fell_back']}), so it was read here by text recognition. " + hint
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
        if not r:
            return

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
