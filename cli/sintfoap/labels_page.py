"""Recipe labels in the terminal: the site's one list of labels, as on /labels/.

Each key (Season, Cuisine...) with its values under it. The keys are also the
Recipe board's categories. n adds labels: a key and any number of values, like
"Season: Fall, Winter" (a key that's already there gets the new values), a adds
more values under the highlighted key, e renames the highlighted value or key,
x removes it. Renaming or removing applies to every recipe that has it. k sets
a value's keywords (pumpkin, squash): words that make Recipe box's Suggest
labels offer it."""
from __future__ import annotations

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import VerticalScroll
from textual.widgets import Footer, OptionList, Static
from textual.widgets.option_list import Option

from . import site
from .look import FAINT, GOLD, INK, MUTED, Ask, Confirm, Page, attempt, plural


def split_add(text: str) -> tuple[str, str]:
    """"Season: Fall, Winter" → ("Season", "Fall, Winter"); no colon, a key on its own."""
    key, _, values = text.partition(":")
    return key.strip(), values.strip()


def used(x: dict) -> str:
    return ", ".join(b for b in (x.get("recipes") and plural(x["recipes"], "recipe"),
                                 x.get("posts") and plural(x["posts"], "board post")) if b)


class LabelsPage(Page):
    WEB_PATH = "/labels/"
    DEFAULT_CSS = """
    LabelsPage #body { padding: 0 4 1 4; }
    LabelsPage #list { height: auto; max-height: 30; }
    """
    BINDINGS = [Binding("n", "add", "Add labels"), Binding("a", "add_under", "Add under key"),
                Binding("e", "rename", "Rename"), Binding("k", "keywords", "Keywords"), Binding("x", "remove", "Remove"), Binding("r", "refresh", "Refresh")]

    def __init__(self):
        super().__init__()
        self.data: dict = {"labels": [], "keys": []}
        self.rows: list[tuple[str, dict]] = []   # ("key", key) or ("label", label), one per option

    def compose(self) -> ComposeResult:
        yield from self.top()
        with VerticalScroll(id="body"):
            yield Static("R E C I P E   L A B E L S", classes="kicker")
            yield Static(Text("The label list", style=f"bold {INK}"), classes="h1")
            yield Static(Text("The one list everyone picks from in Recipe box, like Season: Fall, so nobody ends up with Fall and Autumn. "
                              "Each key is also a category on the Recipe board. n adds labels (Season: Fall, Winter), a adds more under the "
                              "highlighted key, e renames, x removes; renaming or removing applies to every recipe. k sets a value's keywords "
                              "(pumpkin, squash for Fall), so Recipe box's Suggest labels offers it for recipes that mention them.", style=MUTED), classes="sub")
            yield OptionList(id="list", classes="card")
        yield Footer()

    async def on_mount(self) -> None:
        await self.action_refresh()

    @attempt
    async def action_refresh(self) -> None:
        self.show(await self.fetch(site.recipe_labels))

    def show(self, data: dict) -> None:
        self.data = data
        box = self.query_one("#list", OptionList)
        at = box.highlighted
        box.clear_options()
        self.rows = []
        if not data["keys"]:
            box.add_option(Option(Text("No labels yet. Press n to add some, like Season: Fall, Winter, Spring, Summer.", style=FAINT), disabled=True))
        for k in data["keys"]:
            self.rows.append(("key", k))
            box.add_option(Option(Text.assemble((k["key"], f"bold {GOLD}"), (f"   {plural(k['values'], 'value')}", FAINT),
                                                (f"  {used(k)}" if used(k) else "", FAINT))))
            for lb in (x for x in data["labels"] if x["key"].casefold() == k["key"].casefold()):
                self.rows.append(("label", lb))
                box.add_option(Option(Text.assemble(("    " + (lb["value"] or "(no value)"), INK if lb["value"] else FAINT),
                                                    (f"   {used(lb)}" if used(lb) else "", FAINT),
                                                    (f"   ≈ {lb['keywords']}" if lb.get("keywords") else "", MUTED))))
        box.border_title = plural(len(data["labels"]), "label")
        if self.rows:
            box.highlighted = min(at or 0, len(self.rows) - 1)
        box.focus()

    def current(self) -> tuple[str, dict] | None:
        box = self.query_one("#list", OptionList)
        if box.highlighted is None or box.highlighted >= len(self.rows):
            return None
        return self.rows[box.highlighted]

    def key_here(self) -> str | None:
        """The key of the highlighted row, whether it's the key or one of its values."""
        row = self.current()
        return row and row[1]["key"]

    @attempt
    async def add(self, key: str, values: str) -> None:
        out = await self.fetch(site.add_recipe_labels, key, values)
        added = ", ".join(lb["value"] or lb["key"] for lb in out["added"])
        skipped = f" Skipped {', '.join(s['value'] or s['key'] for s in out['skipped'])} (already on the list)." if out["skipped"] else ""
        self.app.notify(f"Added {added} under {out['added'][0]['key']}.{skipped}" if out["added"] else f"Nothing new to add.{skipped}", timeout=5)
        self.show(await self.fetch(site.recipe_labels))

    def action_add(self) -> None:
        async def made(text: str | None) -> None:
            if text and text.strip():
                await self.add(*split_add(text))
        self.app.push_screen(Ask("Add labels", "A key and its values, separated by commas, like Season: Fall, Winter. "
                                 "A key that's already on the list gets the new values. Just a key (Favorite) is a label on its own.",
                                 placeholder="Season: Fall, Winter, Spring", ok="Add"), made)

    def action_add_under(self) -> None:
        key = self.key_here()
        if not key:
            return self.action_add()

        async def made(text: str | None) -> None:
            if text and text.strip():
                await self.add(key, text)
        self.app.push_screen(Ask(f"More under {key}", "Values separated by commas.", placeholder="Winter, Spring", ok="Add"), made)

    def action_rename(self) -> None:
        row = self.current()
        if not row:
            return
        kind, x = row

        async def renamed(text: str | None) -> None:
            if text is None or not text.strip():
                return
            if kind == "key":
                await self.call(site.rename_label_key, x["key"], text.strip())
            else:
                await self.call(site.rename_recipe_label, x["id"], text.strip())
        if kind == "key":
            self.app.push_screen(Ask(f"Rename {x['key']}", "Every value under it moves with it.", value=x["key"], ok="Rename"), renamed)
        else:
            self.app.push_screen(Ask(f"Rename {x['key']}: {x['value']}", "It changes on every recipe that has it.", value=x["value"], ok="Rename"), renamed)

    def action_keywords(self) -> None:
        row = self.current()
        if not row or row[0] != "label":
            self.app.notify("Highlight a value (like Fall) to give it keywords.", timeout=3)
            return
        lb = row[1]
        name = f"{lb['key']}: {lb['value']}" if lb["value"] else lb["key"]

        async def answer(text: str | None) -> None:
            if text is not None and text.strip() != (lb.get("keywords") or ""):
                await self.call(site.set_label_keywords, lb["id"], text)
        also = f", as well as {lb['value']} itself" if lb["value"] else ""
        self.app.push_screen(Ask(f"Keywords for {name}",
                                 f"Separated by commas. Recipe box's Suggest labels offers this label for a recipe with any of them in its "
                                 f"title, ingredients, steps or notes{also}. Start one with - to ignore a phrase (-fall apart).",
                                 value=lb.get("keywords") or "", placeholder="pumpkin, squash, apple cider", ok="Save"), answer)

    def action_remove(self) -> None:
        row = self.current()
        if not row:
            return
        kind, x = row

        async def answer(yes: bool | None) -> None:
            if yes:
                await self.call(site.delete_label_key if kind == "key" else site.delete_recipe_label, x["key"] if kind == "key" else x["id"])
        u = used(x)
        if kind == "key":
            self.app.push_screen(Confirm(f"Remove {x['key']} and its {plural(x['values'], 'value')}?",
                                         (f"They come off {u}. " if u else "") + "It's no longer a category on the Recipe board.", yes="Remove", danger=True), answer)
        else:
            name = f"{x['key']}: {x['value']}" if x["value"] else x["key"]
            self.app.push_screen(Confirm(f"Remove {name}?", f"It comes off {u}." if u else "Nothing has it yet.", yes="Remove", danger=True), answer)

    @attempt
    async def call(self, fn, *args) -> None:
        await self.fetch(fn, *args)
        self.show(await self.fetch(site.recipe_labels))
