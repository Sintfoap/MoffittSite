"""Meal plan in the terminal: the same week of dinners as /meals/.

The week's nights down the left, each with its dinner and whether something
on in Drift makes it busy. The open night's events and recipe are on the
right, with the week's shopping under them. f fills the empty nights, r
shuffles every night that isn't locked, enter picks a recipe yourself, and
s sends the ticked shopping to a Drift list. [ and ] move a week."""
from __future__ import annotations

import datetime as dt

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Footer, Label, OptionList, Select, SelectionList, Static
from textual.widgets.option_list import Option
from textual.widgets.selection_list import Selection

from . import site
from .look import BAD, FAINT, GOLD, GOOD, INK, MUTED, Page, attempt, plural

WARN = "#e0b25a"

SHOPPING = "Shopping list"


def monday_of(day: dt.date) -> dt.date:
    return day - dt.timedelta(days=day.weekday())


def nice_day(s: str, month: str = "%b") -> str:
    d = dt.date.fromisoformat(s)
    return f"{d.strftime(month)} {d.day}"


def clock(t: str) -> str:
    h, m = (int(x) for x in t.split(":"))
    return f"{h % 12 or 12}{f':{m:02d}' if m else ''} {'am' if h < 12 else 'pm'}"


def week_name(data: dict) -> str:
    start, end = data["start"], data["days"][-1]["day"]
    same = start[:7] == end[:7]
    return f"{nice_day(start)} – {dt.date.fromisoformat(end).day if same else nice_day(end)}"


class PickRecipe(ModalScreen[str | None]):
    """A recipe for one night. Dismisses with its id, "" for nothing planned, or None to cancel."""
    BINDINGS = [Binding("escape", "cancel", "Cancel")]
    DEFAULT_CSS = "PickRecipe OptionList { height: auto; max-height: 24; }"

    def __init__(self, night: dict, recipes: list[dict]):
        super().__init__()
        self.night = night
        self.recipes = recipes

    def compose(self) -> ComposeResult:
        n = self.night
        with Vertical(classes="dialog"):
            yield Label(Text(f"Dinner on {n['name']} {nice_day(n['day'])}", style=f"bold {INK}"))
            if n.get("busy"):
                yield Static(Text(f"Busy: {n['why']}. Quick recipes are marked.", style=WARN))
            options = [Option(Text("Nothing planned", style=FAINT), id="")]
            for r in self.recipes:
                line = Text(r["title"], style=f"bold {INK}" if r["id"] == n.get("recipe") else INK)
                if r.get("time"):
                    line.append(f"  {r['time']}", style=FAINT)
                if r.get("quick"):
                    line.append("  quick", style=GOOD)
                options.append(Option(line, id=r["id"]))
            yield OptionList(*options, id="pick")
            yield Static(Text("enter picks, esc cancels", style=FAINT))

    def on_mount(self) -> None:
        pick = self.query_one("#pick", OptionList)
        ids = [""] + [r["id"] for r in self.recipes]
        pick.highlighted = ids.index(self.night.get("recipe") or "") if (self.night.get("recipe") or "") in ids else 0
        pick.focus()

    def on_option_list_option_selected(self, e: OptionList.OptionSelected) -> None:
        self.dismiss(e.option.id or "")

    def action_cancel(self) -> None:
        self.dismiss(None)


class MealsPage(Page):
    WEB_PATH = "/meals/"
    DEFAULT_CSS = f"""
    MealsPage #body {{ padding: 0 2 0 2; height: 1fr; }}
    MealsPage #week {{ color: {INK}; margin-bottom: 1; }}
    MealsPage #main {{ height: 1fr; }}
    MealsPage #nights {{ width: 46; height: 1fr; border-right: solid {GOLD}; margin-right: 2; }}
    MealsPage #night {{ width: 1fr; height: 1fr; }}
    MealsPage #title {{ color: {INK}; text-style: bold; }}
    MealsPage #events, MealsPage #dish {{ margin-bottom: 1; }}
    MealsPage .group {{ color: {FAINT}; }}
    MealsPage SelectionList {{ height: auto; max-height: 20; background: {INK} 0%; border: none; padding: 0; margin-bottom: 1; }}
    MealsPage SelectionList:focus {{ border: none; background-tint: {INK} 0%; }}
    MealsPage #send {{ height: auto; margin-bottom: 1; }}
    MealsPage #list {{ width: 40; }}
    """
    BINDINGS = [
        Binding("f", "fill", "Fill the week"),
        Binding("r", "shuffle", "Shuffle"),
        Binding("enter", "choose", "Pick a recipe", show=False),
        Binding("plus,equals_sign", "servings(1)", "More"),
        Binding("minus", "servings(-1)", "Fewer"),
        Binding("l", "toggle('locked')", "Lock"),
        Binding("o", "toggle('out')", "Out"),
        Binding("s", "send", "Send to list"),
        Binding("left_square_bracket", "week(-1)", "Last week"),
        Binding("right_square_bracket", "week(1)", "Next week"),
        Binding("t", "week(0)", "This week"),
    ]

    def __init__(self):
        super().__init__()
        self.data: dict | None = None
        self.at = 0                     # the open night, 0 for Monday
        self.skip: set[str] = set()     # shopping lines (by text) not to send

    def compose(self) -> ComposeResult:
        yield from self.top()
        with Vertical(id="body"):
            yield Static("M E A L   P L A N", classes="kicker")
            yield Static(id="week")
            with Horizontal(id="main"):
                yield OptionList(id="nights")
                with VerticalScroll(id="night"):
                    yield Static(id="title")
                    yield Static(id="events")
                    yield Static(id="dish")
                    yield Static("SHOPPING FOR THE WEEK", classes="group", id="shop-head")
                    yield SelectionList(id="shopping")
                    with Horizontal(id="send"):
                        yield Button("Send", id="send-btn")
                        yield Select([(SHOPPING, "")], value="", allow_blank=False, id="list")
                    yield Static(id="shop-note")
        yield Footer()

    async def on_mount(self) -> None:
        super().on_mount()
        today = dt.date.today()
        self.at = today.weekday()
        await self.load(today.isoformat())
        self.query_one("#nights", OptionList).focus()

    # ── loading and showing ───────────────────────────────────────────────

    @attempt
    async def load(self, start: str) -> None:
        self.show(await self.fetch(site.meal_week, start))

    def show(self, data: dict) -> None:
        self.data = data
        this = monday_of(dt.date.today()).isoformat() == data["start"]
        line = Text.assemble(("This week" if this else "Week of", f"bold {GOLD}"), (f"  {week_name(data)}", f"bold {INK}"),
                             ("   [ ] other weeks · t this week", FAINT))
        self.query_one("#week", Static).update(line)
        self.show_nights()
        self.show_night()
        self.show_shopping()

    def recipe(self, rid: str | None) -> dict | None:
        return next((r for r in self.data["recipes"] if r["id"] == rid), None) if rid else None

    def night(self) -> dict:
        return self.data["days"][self.at]

    def show_nights(self) -> None:
        nights = self.query_one("#nights", OptionList)
        today = dt.date.today().isoformat()
        with self.prevent(OptionList.OptionHighlighted):
            nights.clear_options()
            for n in self.data["days"]:
                r = self.recipe(n["recipe"])
                head = Text.assemble((f"{n['name']} {nice_day(n['day'])}", f"bold {GOLD}" if n["day"] == today else f"bold {INK}"))
                if n["locked"] and not n["out"]:
                    head.append("  locked", style=FAINT)
                if n["busy"]:
                    head.append("  busy", style=WARN)
                dish = Text("Out tonight", style=MUTED) if n["out"] else Text(r["title"], style=INK) if r else Text("Nothing planned", style=FAINT)
                if r and not n["out"]:
                    if r.get("quick"):
                        dish.append("  quick", style=GOOD)
                    elif n.get("slow"):
                        dish.append("  takes a while", style=BAD)
                nights.add_option(Option(Text.assemble(head, "\n  ", dish), id=n["day"]))
            nights.highlighted = self.at

    def show_night(self) -> None:
        n = self.night()
        self.query_one("#title", Static).update(f"{dt.date.fromisoformat(n['day']).strftime('%A')} {nice_day(n['day'], '%B')}")
        ev = Text()
        if not self.data["drift"]:
            ev.append("Without Drift, Meal plan can't see your calendar.", style=FAINT)
        elif not n["events"]:
            ev.append("Nothing on in Drift.", style=FAINT)
        for i, e in enumerate(n["events"]):
            ev.append("\n" if i else "")
            ev.append(f"{clock(e['time']) if e['time'] else 'all day':>8}  ", style=FAINT)
            ev.append(e["title"], style=MUTED)
        if n["busy"]:
            ev.append(f"\nBusy night: {n['why']}", style=WARN)
        self.query_one("#events", Static).update(ev)
        r = self.recipe(n["recipe"])
        dish = Text()
        if n["out"]:
            dish.append("Out tonight", style=f"bold {INK}")
            dish.append("   o to cook after all", style=FAINT)
        elif r:
            dish.append(r["title"], style=f"bold {INK}")
            if r.get("time"):
                dish.append(f"  {r['time']}", style=FAINT)
            if r.get("quick"):
                dish.append("  quick", style=GOOD)
            dish.append("\n−  ", style=GOLD)
            dish.append(f"serves {n['servings']:g}" if n["servings"] else "as written", style=f"bold {INK}")
            dish.append("  +", style=GOLD)
            dish.append("   locked: filling the week keeps it" if n["locked"] else "   l locks it", style=FAINT)
            if n.get("slow"):
                dish.append(f"\nThis takes {r['time']} on a busy night.", style=BAD)
            dish.append("\nenter picks another, o marks it a night out", style=FAINT)
        else:
            dish.append("Nothing planned", style=MUTED)
            hint = "enter picks a recipe, f fills the week" if self.data["recipes"] else \
                "Your Recipe box is empty; save some recipes there first." if self.data["recipe_box"] else \
                "Meal plan picks from your Recipe box; ask the site's admin to turn it on."
            dish.append(f"\n{hint}", style=FAINT)
        self.query_one("#dish", Static).update(dish)

    def show_shopping(self) -> None:
        items = self.data["shopping"]
        lst = self.query_one("#shopping", SelectionList)
        at = lst.highlighted
        with self.prevent(SelectionList.SelectedChanged):
            lst.clear_options()
            for i, s in enumerate(items):
                lst.add_option(Selection(Text.assemble((s["line"], INK), (f"   {', '.join(s['for'])}", FAINT)), i, s["line"] not in self.skip))
        if at is not None and items:
            lst.highlighted = min(at, len(items) - 1)
        lst.display = bool(items)
        drift = self.data["drift"]
        self.query_one("#send").display = bool(items) and drift
        note = Text()
        if not items:
            note.append("Plan some dinners and what to buy shows up here.", style=FAINT)
        elif not drift:
            note.append("Ask the site's admin for Drift to send these to a shopping list.", style=FAINT)
        if self.data.get("shopped"):
            sh = self.data["shopped"]
            note.append(("\n" if note.plain else "") + f"Sent {sh['added']} to {sh['list']} on {nice_day(sh['at'][:10])}.", style=MUTED)
        self.query_one("#shop-note", Static).update(note)
        if items and drift:
            self.show_send()

    def show_send(self) -> None:
        n = sum(1 for s in self.data["shopping"] if s["line"] not in self.skip)
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

    # ── moving around ─────────────────────────────────────────────────────

    def on_option_list_option_highlighted(self, e: OptionList.OptionHighlighted) -> None:
        if e.option_list.id == "nights" and e.option_index != self.at:
            self.at = e.option_index
            self.show_night()

    def on_option_list_option_selected(self, e: OptionList.OptionSelected) -> None:
        if e.option_list.id == "nights":
            self.action_choose()

    def on_selection_list_selected_changed(self, e: SelectionList.SelectedChanged) -> None:
        on = set(e.selection_list.selected)
        self.skip = {s["line"] for i, s in enumerate(self.data["shopping"]) if i not in on}
        if self.data["drift"]:
            self.show_send()

    async def action_week(self, step: int) -> None:
        if not self.data:
            return
        start = dt.date.today().isoformat() if step == 0 else self.data["next" if step > 0 else "prev"]
        await self.load(start)

    # ── changing the plan ─────────────────────────────────────────────────

    @attempt
    async def change(self, change: dict) -> None:
        n = self.night()
        self.show(await self.fetch(site.set_meal, self.data["start"], n["day"], change))

    def action_choose(self) -> None:
        if not self.data or self.night()["out"]:
            return

        async def picked(rid: str | None) -> None:
            if rid is not None:
                await self.change({"recipe": rid or None})
        self.app.push_screen(PickRecipe(self.night(), self.data["recipes"]), picked)

    async def action_toggle(self, what: str) -> None:
        n = self.data and self.night()
        if n and not (what == "locked" and n["out"]):
            await self.change({what: not n[what]})

    async def action_servings(self, step: int) -> None:
        n = self.data and self.night()
        r = n and self.recipe(n["recipe"])
        if not r or n["out"]:
            return
        now = round(n["servings"] or r.get("servings") or 1)
        if step < 0 and now <= 1:
            return
        await self.change({"servings": max(1, now + step)})

    @attempt
    async def fill(self, redo: bool) -> None:
        if not self.data["recipes"]:
            self.app.notify("Save some recipes in your Recipe box first.", severity="error", timeout=3)
            return
        self.show(await self.fetch(site.fill_meals, self.data["start"], redo))
        planned = sum(1 for n in self.data["days"] if n["recipe"] and not n["out"])
        self.app.notify(f"{plural(planned, 'dinner')} planned.", timeout=2)

    async def action_fill(self) -> None:
        if self.data:
            await self.fill(False)

    async def action_shuffle(self) -> None:
        if self.data:
            await self.fill(True)

    # ── sending to Drift ──────────────────────────────────────────────────

    async def on_button_pressed(self, e: Button.Pressed) -> None:
        if e.button.id == "send-btn":
            await self.action_send()

    @attempt
    async def action_send(self) -> None:
        if not self.data or not self.data["shopping"] or not self.data["drift"]:
            return
        lines = [i for i, s in enumerate(self.data["shopping"]) if s["line"] not in self.skip]
        if not lines:
            self.app.notify("Tick at least one thing to buy.", severity="error", timeout=3)
            return
        to = self.query_one("#list", Select).value
        out = await self.fetch(site.shop_meals, self.data["start"], lines, to if isinstance(to, str) and to else None)
        self.data["shopped"] = out["shopped"]
        if not any(x["id"] == out["list"]["id"] for x in self.data["lists"]):
            self.data["lists"].insert(0, {"id": out["list"]["id"], "name": out["list"]["name"], "owner_name": None})
        self.show_shopping()
        self.app.notify(f"Added {plural(out['added'], 'thing')} to {out['list']['name']} in Drift.", timeout=3)
