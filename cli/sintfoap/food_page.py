"""Food club in the terminal: the same club as /food/.

Every month's pick down the left (coming up, this month, before), the open one
on the right: why it was picked, who made it and who loved it, everyone's
photos, and the recipe. m marks it made, f a favorite, p adds a photo of
yours from a file, o opens the highlighted photo in your browser, n picks a
month and s saves the recipe to your Recipe box."""
from __future__ import annotations

from datetime import date

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Footer, Input, Label, OptionList, Select, Static, TextArea
from textual.widgets.option_list import Option

from . import site
from .look import FAINT, GOLD, GOLD_DIM, GOOD, INK, MUTED, Confirm, Page, attempt, open_in_browser, plural

KIND = {"meal": "Meal", "side": "Side", "dessert": "Dessert", "baking": "Baking", "snack": "Snack", "drink": "Drink"}
MONTHS = "January February March April May June July August September October November December".split()
FILTERS = (("all", "All"), ("favorites", "★ Favorites"), ("made", "Made"))


def this_month(today: date | None = None) -> str:
    d = today or date.today()
    return f"{d.year}-{d.month:02d}"


def month_name(m: str, short: bool = False) -> str:
    y, n = m.split("-")
    name = MONTHS[int(n) - 1]
    return f"{name[:3] if short else name} {y}"


def next_free(picks: list[dict], today: date | None = None) -> str:
    """The first month from this one that nobody's picked yet."""
    taken = {p["month"] for p in picks}
    d = today or date.today()
    y, m = d.year, d.month
    for _ in range(36):
        s = f"{y}-{m:02d}"
        if s not in taken:
            return s
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return this_month(today)


def names(people: list[str]) -> str:
    return " and ".join(people) if len(people) <= 2 else ", ".join(people[:-1]) + " and " + people[-1]


def grouped(picks: list[dict], filt: str = "all", today: date | None = None) -> list[tuple[str, list[dict]]]:
    """The picks to list, as (heading, picks): coming up (soonest first), this month, before (latest first)."""
    now = this_month(today)
    keep = [p for p in picks if filt == "all" or (p["mine"]["favorite"] if filt == "favorites" else p["mine"]["made"])]
    return [(h, ps) for h, ps in (
        ("COMING UP", sorted((p for p in keep if p["month"] > now), key=lambda p: p["month"])),
        ("THIS MONTH", [p for p in keep if p["month"] == now]),
        ("BEFORE", [p for p in keep if p["month"] < now]),
    ) if ps]


class PickDialog(ModalScreen[dict | None]):
    """A month's pick (or a new one): what, when, why, and where its recipe comes from. Dismisses with what to send, or None."""
    BINDINGS = [Binding("escape", "cancel", "Cancel"), Binding("ctrl+s", "save", "Save", priority=True)]
    DEFAULT_CSS = """
    PickDialog .grid { height: auto; }
    PickDialog .grid > Vertical { height: auto; width: 1fr; margin-right: 1; }
    PickDialog #blurb { height: 4; }
    PickDialog #ingredients, PickDialog #steps { height: 6; }
    PickDialog #notes { height: 3; }
    PickDialog #typed, PickDialog #from-url, PickDialog #from-box { height: auto; }
    """

    def __init__(self, pick: dict | None, club: dict):
        super().__init__()
        self.p = pick or {}
        self.club = club

    def compose(self) -> ComposeResult:
        p, r = self.p, (self.p.get("recipe") or {})
        modes = [("From a link", "url"), ("Type it in", "type")]
        if self.club.get("recipe_box") and self.club.get("recipes"):
            modes.insert(1, ("From my Recipe box", "box"))
        if r:
            modes.insert(0, ("Keep it as it is", "keep"))
        modes.append(("No recipe", "none"))
        with VerticalScroll(classes="dialog"):
            yield Label(Text(f"Edit {month_name(p['month'])}'s pick" if p else "Pick a month", style=f"bold {INK}"))
            with Horizontal(classes="grid"):
                with Vertical():
                    yield Label("Month", classes="lbl")
                    yield Input(p.get("month") or next_free(self.club.get("picks", [])), id="month", placeholder="2026-11", max_length=7)
                with Vertical():
                    yield Label("What kind", classes="lbl")
                    yield Select([(KIND.get(k, k), k) for k in self.club.get("kinds", KIND)], value=p.get("kind", "meal"), allow_blank=False, id="kind")
            yield Label("The food", classes="lbl")
            yield Input(p.get("title", ""), id="title", placeholder="Shakshuka (or leave it to the recipe's name)", max_length=200)
            yield Label("Why this one", classes="lbl")
            yield TextArea(p.get("blurb", ""), id="blurb", soft_wrap=True)
            yield Label("Recipe", classes="lbl")
            yield Select(modes, value=modes[0][1], allow_blank=False, id="mode")
            with Vertical(id="from-url"):
                yield Label("Recipe link", classes="lbl")
                yield Input("", id="url", placeholder="https://… a recipe page")
            with Vertical(id="from-box"):
                yield Label("From your Recipe box", classes="lbl")
                box = [(x["title"], x["id"]) for x in self.club.get("recipes", [])] or [("(empty)", "")]
                yield Select(box, value=box[0][1], allow_blank=False, id="recipe")
            with Vertical(id="typed"):
                with Horizontal(classes="grid"):
                    with Vertical():
                        yield Label("Serves", classes="lbl")
                        s = r.get("servings")
                        yield Input("" if s is None else f"{s:g}", id="servings", type="number")
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
                yield Input(r.get("source", ""), id="source")
            with Horizontal(classes="buttons"):
                yield Button("Save", id="save")
                yield Button("Cancel", id="cancel", classes="quiet")
            yield Static(Text("The month is YYYY-MM. ctrl+s saves, esc cancels", style=FAINT))

    def on_mount(self) -> None:
        self.show_mode()
        self.query_one("#title" if self.p else "#month", Input).focus()

    def mode(self) -> str:
        return str(self.query_one("#mode", Select).value)

    def show_mode(self) -> None:
        m = self.mode()
        self.query_one("#from-url").display = m == "url"
        self.query_one("#from-box").display = m == "box"
        self.query_one("#typed").display = m == "type"

    def on_select_changed(self, e: Select.Changed) -> None:
        if e.select.id == "mode":
            self.show_mode()

    def fields(self) -> dict:
        v = lambda i: self.query_one(f"#{i}", Input).value.strip()  # noqa: E731
        t = lambda i: self.query_one(f"#{i}", TextArea).text  # noqa: E731
        out: dict = {"month": v("month"), "kind": self.query_one("#kind", Select).value, "blurb": t("blurb").strip()}
        if v("title") or self.p:
            out["title"] = v("title")
        m = self.mode()
        if m == "url" and v("url"):
            out["url"] = v("url")
        elif m == "box":
            out["recipe_id"] = self.query_one("#recipe", Select).value
        elif m == "none":
            out["recipe"] = None
        elif m == "type":
            try:
                serves = float(v("servings")) if v("servings") else None
            except ValueError:
                serves = None
            out["recipe"] = {"servings": serves, "yield": v("yield"), "time": v("time"), "ingredients": t("ingredients"),
                             "steps": t("steps"), "notes": t("notes").strip(), "source": v("source")}
        return out

    def action_save(self) -> None:
        f = self.fields()
        if not f.get("title") and not f.get("url") and not f.get("recipe_id"):
            self.app.notify("Say what the food is, or give a recipe link.", severity="error", timeout=3)
            self.query_one("#title", Input).focus()
            return
        self.dismiss(f)

    def action_cancel(self) -> None:
        self.dismiss(None)

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.action_save() if e.button.id == "save" else self.dismiss(None)


class PhotoDialog(ModalScreen[dict | None]):
    """A picture file of your attempt, and a caption. Dismisses with {path, caption}, or None."""
    BINDINGS = [Binding("escape", "cancel", "Cancel")]

    def __init__(self, title: str):
        super().__init__()
        self.title_text = title

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Label(Text(f"Add a photo of your {self.title_text}", style=f"bold {INK}"))
            yield Static(Text(f"A JPEG, PNG, WebP or GIF of at most {site.PHOTO_BYTES // 1024} KB. "
                              "The website shrinks bigger ones for you.", style=MUTED))
            yield Label("File", classes="lbl")
            yield Input(placeholder="~/Pictures/dinner.jpg", id="path")
            yield Label("Caption", classes="lbl")
            yield Input(placeholder="How it went", id="caption", max_length=300)
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


class FoodPage(Page):
    WEB_PATH = "/food/"
    SIDE = "#months"
    DEFAULT_CSS = f"""
    FoodPage #body {{ padding: 0 2 0 2; height: 1fr; }}
    FoodPage #headline {{ color: {INK}; text-style: bold; margin-bottom: 1; }}
    FoodPage #main {{ height: 1fr; }}
    FoodPage #months {{ width: 38; height: 1fr; border-right: solid {GOLD_DIM}; margin-right: 2; }}
    FoodPage #pick {{ width: 1fr; height: 1fr; }}
    FoodPage #when {{ color: {GOLD}; }}
    FoodPage #title {{ color: {INK}; text-style: bold; }}
    FoodPage #by {{ color: {FAINT}; margin-bottom: 1; }}
    FoodPage #blurb, FoodPage #marks, FoodPage #people {{ margin-bottom: 1; }}
    FoodPage .group {{ color: {FAINT}; }}
    FoodPage #photos {{ height: auto; max-height: 12; margin-bottom: 1; }}
    FoodPage #facts {{ color: {FAINT}; }}
    FoodPage #ingredients, FoodPage #steps, FoodPage #notes {{ margin-bottom: 1; }}
    """
    BINDINGS = [
        Binding("n", "new", "Pick a month"),
        Binding("m", "made", "Made it"),
        Binding("f", "favorite", "Favorite"),
        Binding("p", "photo", "Add photo"),
        Binding("o", "open_photo", "See photo", show=False),
        Binding("x", "remove_photo", "Remove photo", show=False),
        Binding("s", "save", "To Recipe box"),
        Binding("e", "edit", "Edit"),
        Binding("d", "delete", "Delete", show=False),
        Binding("v", "filter", "Show"),
        Binding("r", "refresh", "Refresh"),
        Binding("backslash", "fold", "Months"),
    ]

    def __init__(self):
        super().__init__()
        self.club: dict | None = None
        self.open: str | None = None
        self.pick: dict | None = None
        self.filter = "all"

    def compose(self) -> ComposeResult:
        yield from self.top()
        with Vertical(id="body"):
            yield Static("F O O D   C L U B", classes="kicker")
            yield Static(id="headline")
            with Horizontal(id="main"):
                yield OptionList(id="months")
                with VerticalScroll(id="pick"):
                    yield Static(id="when")
                    yield Static(id="title")
                    yield Static(id="by")
                    yield Static(id="blurb")
                    yield Static(id="marks")
                    yield Static(id="people")
                    yield Static(id="photos-head", classes="group")
                    yield OptionList(id="photos")
                    yield Static("RECIPE", classes="group", id="recipe-head")
                    yield Static(id="facts")
                    yield Static(id="ingredients")
                    yield Static("STEPS", classes="group", id="steps-head")
                    yield Static(id="steps")
                    yield Static("NOTES", classes="group", id="notes-head")
                    yield Static(id="notes")
        yield Footer()

    async def on_mount(self) -> None:
        await self.action_refresh()
        self.query_one("#months", OptionList).focus()

    # ── loading and showing ───────────────────────────────────────────────

    @attempt
    async def action_refresh(self) -> None:
        self.club = await self.fetch(site.food_club)
        picks = self.club["picks"]
        if not any(p["id"] == self.open for p in picks):
            now = this_month()
            first = (next((p for p in picks if p["month"] == now), None)
                     or next((p for p in reversed(picks) if p["month"] > now), None) or (picks[0] if picks else None))
            self.open = first["id"] if first else None
        self.pick = await self.fetch(site.food_pick, self.open) if self.open else None
        self.show_all()

    def show_all(self) -> None:
        self.show_headline()
        self.show_months()
        self.show_pick()

    def show_headline(self) -> None:
        now = next((p for p in self.club["picks"] if p["month"] == this_month()), None)
        month = MONTHS[date.today().month - 1]
        self.query_one("#headline", Static).update(f"{month}: {now['title']}" if now else f"Nobody's picked {month} yet")

    def show_months(self) -> None:
        box = self.query_one("#months", OptionList)
        with self.prevent(OptionList.OptionHighlighted):
            box.clear_options()
            label = dict(FILTERS)[self.filter]
            box.add_option(Option(Text.assemble(("Showing ", FAINT), (label, f"bold {GOLD}"), ("  (v changes)", FAINT)), disabled=True))
            groups = grouped(self.club["picks"], self.filter)
            if not self.club["picks"]:
                box.add_option(Option(Text("No picks yet. Press n to pick a month.", style=FAINT), disabled=True))
            elif not groups:
                box.add_option(Option(Text("Nothing here yet.", style=FAINT), disabled=True))
            at = None
            for head, picks in groups:
                box.add_option(Option(Text("\n" + head, style=FAINT), disabled=True))
                for p in picks:
                    bits = [month_name(p["month"], short=True), p["by"]]
                    if p["made"]:
                        bits.append(f"{p['made']} made")
                    if p["photos"]:
                        bits.append(plural(p["photos"], "photo"))
                    star = ("★ ", GOLD) if p["mine"]["favorite"] else ("", "")
                    box.add_option(Option(Text.assemble(star, (p["title"], f"bold {INK}"), ("\n" + " · ".join(bits), FAINT)), id=p["id"]))
                    if p["id"] == self.open:
                        at = box.option_count - 1
            if at is not None:
                box.highlighted = at

    def show_pick(self) -> None:
        p = self.pick
        parts = ["#when", "#by", "#blurb", "#marks", "#people", "#photos-head", "#photos", "#recipe-head", "#facts",
                 "#ingredients", "#steps-head", "#steps", "#notes-head", "#notes"]
        for part in parts:
            self.query_one(part).display = bool(p)
        if not p:
            self.query_one("#title", Static).update(Text("Each month's food will show up here. Press n to pick a month.", style=MUTED))
            return
        now = this_month()
        when = [month_name(p["month"]).upper(), KIND.get(p["kind"], p["kind"]).upper()]
        if p["month"] == now:
            when.append("THIS MONTH")
        elif p["month"] > now:
            when.append("COMING UP")
        self.query_one("#when", Static).update(" · ".join(when))
        self.query_one("#title", Static).update(p["title"])
        self.query_one("#by", Static).update(f"Picked by {'you' if p['yours'] else p['by']}")
        self.query_one("#blurb", Static).update(Text(p.get("blurb", ""), style=INK))
        self.query_one("#blurb").display = bool(p.get("blurb"))
        mine = p["mine"]
        self.query_one("#marks", Static).update(Text.assemble(
            ("✓ Made it" if mine["made"] else "○ Not made yet", f"bold {GOOD}" if mine["made"] else MUTED), ("  (m)   ", FAINT),
            ("★ A favorite" if mine["favorite"] else "☆ Not a favorite", f"bold {GOLD}" if mine["favorite"] else MUTED), ("  (f)", FAINT)))
        who = Text()
        if p["made_by"]:
            who.append("Made by ", MUTED)
            who.append(names(p["made_by"]), f"bold {INK}")
        else:
            who.append("Nobody's made it yet.", FAINT)
        if p["favorite_of"]:
            who.append(" · ", FAINT)
            who.append("★ ", GOLD)
            who.append("a favorite of ", MUTED)
            who.append(names(p["favorite_of"]), f"bold {INK}")
        self.query_one("#people", Static).update(who)

        photos = self.query_one("#photos", OptionList)
        self.query_one("#photos-head", Static).update(
            f"PHOTOS ({len(p['photos'])})  o opens one in your browser, p adds yours" if p["photos"] else "PHOTOS  none yet; made it? press p to add yours")
        photos.display = bool(p["photos"])
        at = photos.highlighted
        photos.clear_options()
        for ph in p["photos"]:
            photos.add_option(Option(Text.assemble(("▣ ", GOLD), ("You" if ph["yours"] else ph["by"], f"bold {INK}"),
                                                   (f" · {ph['caption']}" if ph["caption"] else "", MUTED), (f" · {ph['created'][:10]}", FAINT)), id=ph["id"]))
        if p["photos"]:
            photos.highlighted = min(at or 0, len(p["photos"]) - 1)

        r = p.get("recipe")
        for part in ("#facts", "#ingredients", "#steps-head", "#steps", "#notes-head", "#notes"):
            self.query_one(part).display = bool(r)
        if not r:
            self.query_one("#recipe-head", Static).update("RECIPE  none yet" + ("; press e to add one" if p["can_edit"] else f"; ask {p['by']} for it"))
            return
        self.query_one("#recipe-head", Static).update("RECIPE" + ("  s saves it to your Recipe box" if self.club.get("recipe_box") else ""))
        facts = [b for b in (r.get("time"), f"serves {r['servings']:g}" if r.get("servings") else "",
                             r.get("yield") if r.get("yield") and not r["yield"].replace(".", "").isdigit() else "", r.get("source")) if b]
        self.query_one("#facts", Static).update(" · ".join(facts))
        ing = Text()
        for i, line in enumerate(r["ingredients"]):
            ing.append(("\n" if i else "") + "• ", GOLD)
            ing.append(line, INK)
        self.query_one("#ingredients", Static).update(ing)
        self.query_one("#ingredients").display = bool(r["ingredients"])
        steps = Text()
        for i, s in enumerate(r["steps"], 1):
            steps.append(f"{'' if i == 1 else chr(10) + chr(10)}{i}. ", f"bold {GOLD}")
            steps.append(s, INK)
        self.query_one("#steps", Static).update(steps)
        for key in ("steps", "notes"):
            self.query_one(f"#{key}-head").display = bool(r.get(key))
            self.query_one(f"#{key}").display = bool(r.get(key))
        self.query_one("#notes", Static).update(Text(r.get("notes", ""), style=MUTED))

    async def changed(self, pick: dict) -> None:
        """After a change: the pick as the site sent it back, and the list again."""
        self.pick = pick
        self.open = pick["id"]
        self.club = await self.fetch(site.food_club)
        self.show_all()

    # ── moving around ─────────────────────────────────────────────────────

    @attempt
    async def on_option_list_option_highlighted(self, e: OptionList.OptionHighlighted) -> None:
        if e.option_list.id == "months" and e.option.id and e.option.id != self.open:
            self.open = e.option.id
            self.pick = await self.fetch(site.food_pick, self.open)
            if self.open == e.option.id:
                self.show_pick()

    def action_filter(self) -> None:
        ids = [f for f, _ in FILTERS]
        self.filter = ids[(ids.index(self.filter) + 1) % len(ids)]
        self.show_months()

    def check_action(self, action: str, parameters: tuple) -> bool | None:
        if isinstance(self.focused, (Input, TextArea)) and action not in ("back",):
            return False
        return True

    # ── made, favorite, photos ────────────────────────────────────────────

    @attempt
    async def action_made(self) -> None:
        if self.pick:
            await self.changed(await self.fetch(lambda: site.mark_food(self.pick["id"], made=not self.pick["mine"]["made"])))

    @attempt
    async def action_favorite(self) -> None:
        if self.pick:
            on = not self.pick["mine"]["favorite"]
            await self.changed(await self.fetch(lambda: site.mark_food(self.pick["id"], favorite=on)))
            self.app.notify(f"{self.pick['title']} is one of your favorites." if on else "Taken off your favorites.", timeout=2)

    def action_photo(self) -> None:
        if not self.pick:
            return
        p = self.pick

        async def done(got: dict | None) -> None:
            if got:
                await self.add_photo(p, got)
        self.app.push_screen(PhotoDialog(p["title"]), done)

    @attempt
    async def add_photo(self, p: dict, got: dict) -> None:
        await self.changed(await self.fetch(site.add_food_photo, p["id"], got["path"], got["caption"]))
        self.app.notify("Photo added.", timeout=2)

    def highlighted_photo(self) -> dict | None:
        box = self.query_one("#photos", OptionList)
        if not self.pick or not self.pick["photos"] or box.highlighted is None:
            return None
        return self.pick["photos"][box.highlighted]

    def action_open_photo(self) -> None:
        ph = self.highlighted_photo()
        if ph:
            open_in_browser(self.app, site.site_url(f"/food/api/photos/{ph['id']}"))
        elif self.pick:
            open_in_browser(self.app, site.site_url(f"/food/#{self.pick['id']}"))

    def action_web(self) -> None:
        open_in_browser(self.app, site.site_url("/food/" + (f"#{self.open}" if self.open else "")))

    def action_remove_photo(self) -> None:
        ph = self.highlighted_photo()
        if not ph or not ph["can_remove"]:
            return
        pick = self.pick

        async def answer(yes: bool | None) -> None:
            if yes:
                await self.remove_photo(pick, ph)
        self.app.push_screen(Confirm("Take this photo off?", f"{ph['by']}'s photo of {pick['title']}.", yes="Remove", danger=True), answer)

    @attempt
    async def remove_photo(self, pick: dict, ph: dict) -> None:
        await self.changed(await self.fetch(site.remove_food_photo, pick["id"], ph["id"]))

    @attempt
    async def action_save(self) -> None:
        if not self.pick or not self.pick.get("recipe"):
            return
        if not self.club.get("recipe_box"):
            self.app.notify("Ask the site's admin for Recipe box to save recipes.", severity="error", timeout=3)
            return
        out = await self.fetch(site.save_food_recipe, self.pick["id"])
        self.app.notify(f"Saved {out['recipe']['title']} to your Recipe box.", timeout=3)

    # ── picking, editing, deleting ────────────────────────────────────────

    def action_new(self) -> None:
        self.app.push_screen(PickDialog(None, self.club or {}), self.after_dialog(None))

    def action_edit(self) -> None:
        if self.pick and self.pick["can_edit"]:
            self.app.push_screen(PickDialog(self.pick, self.club), self.after_dialog(self.pick))

    def after_dialog(self, was: dict | None):
        async def done(fields: dict | None) -> None:
            if fields is not None:
                await self.save_pick(was, fields)
        return done

    @attempt
    async def save_pick(self, was: dict | None, fields: dict) -> None:
        if fields.get("url"):
            self.app.notify("Reading the recipe…", timeout=2)
        saved = await self.fetch(site.update_food_pick, was["id"], fields) if was else await self.fetch(site.add_food_pick, fields)
        self.app.notify("Saved." if was else f"{month_name(saved['month'])} is {saved['title']}.", timeout=3)
        await self.changed(saved)

    def action_delete(self) -> None:
        p = self.pick
        if not p or not p["can_edit"]:
            return

        async def answer(yes: bool | None) -> None:
            if yes:
                await self.delete(p)
        self.app.push_screen(Confirm(f"Delete {month_name(p['month'])}'s pick, {p['title']}?",
                                     "Its photos and who made it go too.", yes="Delete", danger=True), answer)

    @attempt
    async def delete(self, p: dict) -> None:
        await self.fetch(site.delete_food_pick, p["id"])
        self.open = None
        await self.action_refresh()
