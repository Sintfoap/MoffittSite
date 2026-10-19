"""Recipe box in the terminal: the same recipes as /recipes/.

Your recipes down the left, the open one on the right, scaled to the servings
you pick (+ and -). Space ticks which ingredients to send, and s sends them to
a Drift list. A link pasted in the box at the top is read by the site, as on
the website; n types one in by hand."""
from __future__ import annotations

import asyncio
from urllib.parse import urlparse

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Footer, Input, Label, OptionList, Select, SelectionList, Static, TextArea
from textual.widgets.option_list import Option
from textual.widgets.selection_list import Selection

from . import site
from . import recipe_rules as R
from .look import FAINT, GOLD, GOLD_DIM, INK, MUTED, Confirm, Page, attempt, plural

SHOPPING = "Shopping list"


def host(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").removeprefix("www.")
    except ValueError:
        return ""


def by_title(recipes: list[dict]) -> list[dict]:
    return sorted(recipes, key=lambda r: r["title"].casefold())


class RecipeDialog(ModalScreen[dict | None]):
    """A recipe's fields (or a new recipe's). Dismisses with what to save, or None."""
    BINDINGS = [Binding("escape", "cancel", "Cancel"), Binding("ctrl+s", "save", "Save", priority=True)]
    DEFAULT_CSS = """
    RecipeDialog .grid { height: auto; }
    RecipeDialog .grid > Vertical { height: auto; width: 1fr; margin-right: 1; }
    RecipeDialog #ingredients, RecipeDialog #steps { height: 8; }
    RecipeDialog #notes { height: 4; }
    """

    def __init__(self, recipe: dict | None, source: str = ""):
        super().__init__()
        self.r = recipe or {}
        self.source = source

    def compose(self) -> ComposeResult:
        r = self.r
        with VerticalScroll(classes="dialog"):
            yield Label(Text("Edit recipe" if r else "New recipe", style=f"bold {INK}"))
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
                "ingredients": t("ingredients"), "steps": t("steps"), "notes": t("notes").strip(), "source": v("source")}

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


class RecipesPage(Page):
    WEB_PATH = "/recipes/"
    DEFAULT_CSS = f"""
    RecipesPage #body {{ padding: 0 2 0 2; height: 1fr; }}
    RecipesPage #url {{ margin-bottom: 1; }}
    RecipesPage #main {{ height: 1fr; }}
    RecipesPage #shelf {{ width: 36; height: 1fr; border-right: solid {GOLD_DIM}; margin-right: 2; }}
    RecipesPage #recipe {{ width: 1fr; height: 1fr; }}
    RecipesPage #title {{ color: {INK}; text-style: bold; }}
    RecipesPage #facts {{ color: {FAINT}; margin-bottom: 1; }}
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
        Binding("e", "edit", "Edit"),
        Binding("plus,equals_sign", "servings(1)", "More"),
        Binding("minus", "servings(-1)", "Fewer"),
        Binding("s", "send", "Send to list"),
        Binding("d", "delete", "Delete"),
        Binding("r", "refresh", "Refresh"),
    ]

    def __init__(self):
        super().__init__()
        self.data: dict | None = None
        self.open: str | None = None
        self.scale: dict[str, dict] = {}       # recipe id → {servings} or {factor}
        self.skip: dict[str, set[int]] = {}    # recipe id → ingredient indexes not to send

    def compose(self) -> ComposeResult:
        yield from self.top()
        with Vertical(id="body"):
            yield Static("R E C I P E   B O X", classes="kicker")
            yield Input(placeholder="Paste a link to a recipe and press enter (a)", id="url")
            with Horizontal(id="main"):
                yield OptionList(id="shelf")
                with VerticalScroll(id="recipe"):
                    yield Static(id="title")
                    yield Static(id="facts")
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
        if not any(r["id"] == self.open for r in self.data["recipes"]):
            self.open = self.data["recipes"][0]["id"] if self.data["recipes"] else None
        self.show_shelf()
        self.show_recipe()

    def current(self) -> dict | None:
        return next((r for r in (self.data or {}).get("recipes", []) if r["id"] == self.open), None)

    def show_shelf(self) -> None:
        shelf = self.query_one("#shelf", OptionList)
        with self.prevent(OptionList.OptionHighlighted):
            shelf.clear_options()
            recipes = self.data["recipes"]
            if not recipes:
                shelf.add_option(Option(Text("No recipes yet. Paste a link above.", style=FAINT), disabled=True))
                return
            for r in recipes:
                sub = " · ".join(x for x in (r.get("time"), host(r.get("source", ""))) if x) or plural(len(r["ingredients"]), "ingredient")
                shelf.add_option(Option(Text.assemble((r["title"], f"bold {INK}"), ("\n" + sub, FAINT)), id=r["id"]))
            shelf.highlighted = next(i for i, r in enumerate(recipes) if r["id"] == self.open)

    def amounts(self, r: dict) -> tuple[float, float | None]:
        s = self.scale.get(r["id"], {})
        f = R.factor_for(r, s.get("servings"), s.get("factor"))
        return f, (round(r["servings"] * f * 100) / 100 if r.get("servings") else None)

    def show_recipe(self) -> None:
        r = self.current()
        parts = ["#ing-head", "#ingredients", "#send", "#no-drift", "#steps-head", "#steps", "#notes-head", "#notes", "#serves", "#facts"]
        for p in parts:
            self.query_one(p).display = bool(r)
        if not r:
            self.query_one("#title", Static).update(Text("Your recipes will show up here. Paste a link above, or press n to type one in.", style=MUTED))
            return
        self.query_one("#title", Static).update(r["title"])
        bits = [b for b in (r.get("time"), r.get("yield") if r.get("yield") and not r["yield"].replace(".", "").isdigit() else "", host(r.get("source", ""))) if b]
        self.query_one("#facts", Static).update(" · ".join(bits))
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
        at = ing.highlighted
        with self.prevent(SelectionList.SelectedChanged):
            ing.clear_options()
            for i, raw in enumerate(r["ingredients"]):
                scaled = R.scale_line(raw, f)
                ing.add_option(Selection(Text(scaled, style=f"bold {GOLD}" if scaled != raw else INK), i, i not in off))
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
        if action in ("servings", "add", "new", "edit", "send", "delete", "refresh") and isinstance(self.focused, (Input, TextArea)):
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
                self.app.push_screen(RecipeDialog(None, url), self.after_dialog(None))
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
        self.app.push_screen(RecipeDialog(None, url), self.after_dialog(None))

    def action_edit(self) -> None:
        r = self.current()
        if r:
            self.app.push_screen(RecipeDialog(r), self.after_dialog(r))

    def after_dialog(self, was: dict | None):
        async def done(fields: dict | None) -> None:
            if fields is not None:
                await self.save(was, fields)
        return done

    @attempt
    async def save(self, was: dict | None, fields: dict) -> None:
        if was:
            r = await self.fetch(site.update_recipe, was["id"], fields)
            if r.get("servings") != was.get("servings"):
                self.scale.pop(r["id"], None)
        else:
            r = await self.fetch(site.add_recipe, fields)
            self.query_one("#url", Input).value = ""
        self.app.notify(f"Saved {r['title']}.", timeout=2)
        await self.saved(r)

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
        self.open = self.data["recipes"][0]["id"] if self.data["recipes"] else None
        self.show_shelf()
        self.show_recipe()

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
