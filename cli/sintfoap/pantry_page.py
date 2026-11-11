"""Pantry in the terminal: the same food as /pantry/.

Your food down the left, by where it's kept (Fridge, Freezer, Cupboard,
Spice rack), with how much is left and when it expires; the highlighted one
on the right, with each purchase of it. Measured things (flour, sugar) are
kept by weight or volume, counted things (cans, eggs) go by whole units, and
gauged things (spices) go from Full to Empty. Any of them can be a staple,
with a point it's running low at (2 lb, 3 cans, ½ left).

n adds food, u uses some, m adds a purchase (or refills a gauged thing), e
edits, p corrects or takes off a purchase, x removes it, f shows all, use
soon or running low, / finds. c reads a grocery receipt from a photo (Claude
with your key, k, or the site's AI): each line matched to what you have or
offered as new, with an estimated expiry date, to check before it's added.
Store abbreviations are remembered once added. s pairs the Pantry scanner
app on a phone (a QR code to scan), and unpairs phones."""
from __future__ import annotations

import datetime as dt

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Checkbox, Footer, Input, Label, OptionList, Select, Static
from textual.widgets.option_list import Option

from . import site
from .look import BAD, FAINT, GOLD, INK, MUTED, Ask, Confirm, Page, attempt, plural
from .receipt_dialog import ReceiptDialog, ScannerDialog

WARN = "#e0b25a"
FILTERS = (("all", "All"), ("soon", "Use soon"), ("low", "Running low"))
KINDS = (("Measured: by weight or volume, like flour", "measured"), ("Counted: whole units, like cans", "counted"), ("Gauged: full to empty, like spices", "gauged"))
LEVELS = ["Empty", "Almost out", "¼ left", "½ left", "¾ left", "Full"]
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()


def nice(day: str, today: dt.date | None = None) -> str:
    """2026-11-14 → Nov 14 (with the year when it isn't this one)."""
    y, m, d = day.split("-")
    this = (today or dt.date.today()).year
    return f"{MONTHS[int(m) - 1]} {int(d)}" + ("" if int(y) == this else f", {y}")


def shown(items: list[dict], filt: str = "all", find: str = "") -> list[dict]:
    q = find.strip().lower()
    return [i for i in items
            if (filt == "all" or (i["soon"] if filt == "soon" else i["is_low"] or i["is_out"]))
            and (not q or q in i["name"].lower() or q in (i.get("words") or "").lower())]


def when(i: dict) -> Text:
    if not i.get("expires"):
        return Text("")
    if i["expired"]:
        return Text(f"expired {nice(i['expires'])}", style=f"bold {BAD}")
    return Text(f"{'use by' if i['soon'] else 'expires'} {nice(i['expires'])}", style=f"bold {WARN}" if i["soon"] else MUTED)


def est(lot: dict) -> str:
    """ (est.) after a date that was estimated from how long such things keep."""
    return " (est.)" if lot.get("by") == "estimated" else ""


def gauge(level: int) -> str:
    return "▮" * level + "▯" * (5 - level)


def have(i: dict) -> Text:
    style = BAD if i["is_out"] else WARN if i["is_low"] else INK
    if i["kind"] == "gauged":
        return Text.assemble((gauge(i["level"]) + " ", style), (i["text"], f"bold {style}"))
    return Text(i["text"], style=f"bold {style}")


class ItemDialog(ModalScreen[dict | None]):
    """New food, or changes to one. Dismisses with what to send, or None."""
    BINDINGS = [Binding("escape", "cancel", "Cancel"), Binding("ctrl+s", "save", "Save", priority=True)]
    DEFAULT_CSS = """
    ItemDialog .grid { height: auto; }
    ItemDialog .grid > Vertical { height: auto; width: 1fr; margin-right: 1; }
    ItemDialog .part { height: auto; }
    """

    def __init__(self, item: dict | None, places: list[str]):
        super().__init__()
        self.i = item or {}
        self.places = places

    def compose(self) -> ComposeResult:
        i = self.i
        kinds = list(KINDS) if i else [("Guess from the name", "")] + list(KINDS)
        with VerticalScroll(classes="dialog"):
            yield Label(Text(f"Edit {i['name']}" if i else "Add food", style=f"bold {INK}"))
            yield Label("Name", classes="lbl")
            yield Input(i.get("name", ""), id="name", placeholder="Whole wheat flour", max_length=80)
            with Horizontal(classes="grid"):
                with Vertical():
                    yield Label("Kind", classes="lbl")
                    yield Select(kinds, value=i.get("kind", ""), allow_blank=False, id="kind")
                with Vertical():
                    yield Label("Where it's kept", classes="lbl")
                    yield Input(i.get("place", ""), id="place", placeholder=" / ".join(self.places[:4]) or "Cupboard", max_length=30)
            with Horizontal(classes="grid part", id="amounts"):
                with Vertical():
                    yield Label("How much you have now" if i else "How much you have", classes="lbl", id="amount-label")
                    yield Input("", id="amount", placeholder="10 lb, or how many", max_length=40)
                with Vertical():
                    yield Label("Expires", classes="lbl")
                    yield Input("", id="expires", placeholder="YYYY-MM-DD", max_length=10)
            with Horizontal(classes="grid part", id="measured"):
                with Vertical():
                    yield Label("Grams in a cup", classes="lbl")
                    pc = i.get("per_cup")
                    yield Input("" if pc is None else f"{pc:g}", id="per_cup", placeholder="120", type="number")
            with Horizontal(classes="grid part", id="counted"):
                with Vertical():
                    yield Label("One is a (counted)", classes="lbl")
                    yield Input(i.get("unit", ""), id="unit", placeholder="can", max_length=20)
                with Vertical():
                    yield Label("Size of one", classes="lbl")
                    yield Input(i.get("size", ""), id="size", placeholder="16 oz", max_length=40)
            with Horizontal(classes="grid part", id="gauged"):
                with Vertical():
                    yield Label("How full", classes="lbl")
                    yield Select([(lv, n) for n, lv in reversed(list(enumerate(LEVELS)))], value=i.get("level") if i.get("level") is not None else 5,
                                 allow_blank=False, id="level")
                with Vertical():
                    yield Label("Expires", classes="lbl")
                    yield Input(i.get("expires", "") if i.get("kind") == "gauged" else "", id="g-expires", placeholder="YYYY-MM-DD", max_length=10)
            yield Checkbox("Staple: kept stocked, and running low at…", bool(i.get("staple")), id="staple")
            with Vertical(classes="part", id="low-box"):
                yield Input("" if i.get("kind") == "gauged" else i.get("low_text", ""), id="low", placeholder="2 lb, or how many", max_length=40)
                low = i.get("low") if i.get("kind") == "gauged" and i.get("low") is not None else 1
                yield Select([(lv, n) for n, lv in reversed(list(enumerate(LEVELS))) if n < 5], value=low, allow_blank=False, id="low-level")
            yield Label("Other names recipes use", classes="lbl")
            yield Input(i.get("words", ""), id="words", placeholder="wholemeal flour, ww flour", max_length=200)
            with Horizontal(classes="buttons"):
                yield Button("Save", id="save")
                yield Button("Cancel", id="cancel", classes="quiet")
            yield Static(Text("Left to guess, the kind, place and unit come from the name. ctrl+s saves, esc cancels", style=FAINT))

    def on_mount(self) -> None:
        self.show_kind()
        self.query_one("#name", Input).focus()

    def kind(self) -> str:
        return str(self.query_one("#kind", Select).value or "")

    def changing(self) -> bool:
        return bool(self.i) and self.kind() != self.i["kind"]

    def show_kind(self) -> None:
        k = self.kind()
        self.query_one("#amounts").display = k != "gauged" and (not self.i or self.changing())
        self.query_one("#measured").display = k in ("measured", "")
        staple = self.query_one("#staple", Checkbox).value
        self.query_one("#low-box").display = staple
        self.query_one("#low").display = staple and k != "gauged"
        self.query_one("#low-level").display = staple and k == "gauged"
        self.query_one("#counted").display = k in ("counted", "")
        self.query_one("#gauged").display = k == "gauged"

    def on_select_changed(self, e: Select.Changed) -> None:
        if e.select.id == "kind":
            self.show_kind()

    def on_checkbox_changed(self, e: Checkbox.Changed) -> None:
        self.show_kind()

    def fields(self) -> dict:
        v = lambda x: self.query_one(f"#{x}", Input).value.strip()  # noqa: E731
        k = self.kind()
        out: dict = {"name": v("name"), "words": v("words")}
        if k:
            out["kind"] = k
        if v("place") or self.i:
            out["place"] = v("place")
        if k != "gauged" and (not self.i or self.changing()):
            if v("amount"):
                out["amount"] = v("amount")
            out["expires"] = v("expires")
        out["staple"] = self.query_one("#staple", Checkbox).value
        if out["staple"]:
            out["low"] = self.query_one("#low-level", Select).value if k == "gauged" else v("low")
        if k in ("measured", "") and (v("per_cup") or (self.i and k == "measured")):
            out["per_cup"] = float(v("per_cup")) if v("per_cup") else None
        if k in ("counted", ""):
            if v("unit") or k == "counted":
                out["unit"] = v("unit")
            if v("size") or k == "counted":
                out["size"] = v("size")
        if k == "gauged":
            out["level"] = self.query_one("#level", Select).value
            out["expires"] = v("g-expires")
        return out

    def action_save(self) -> None:
        f = self.fields()
        if not f["name"]:
            self.app.notify("Give it a name, like Whole wheat flour.", severity="error", timeout=3)
            self.query_one("#name", Input).focus()
            return
        self.dismiss(f)

    def action_cancel(self) -> None:
        self.dismiss(None)

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.action_save() if e.button.id == "save" else self.dismiss(None)


class UseDialog(ModalScreen[dict | None]):
    """Using some: an amount (or how many), all of it, or tossing it; for a gauged thing, how full it is now."""
    BINDINGS = [Binding("escape", "cancel", "Cancel")]

    def __init__(self, item: dict):
        super().__init__()
        self.i = item

    def compose(self) -> ComposeResult:
        i = self.i
        with Vertical(classes="dialog"):
            yield Label(Text(f"Use {i['name']}", style=f"bold {INK}"))
            if i["kind"] == "gauged":
                yield Static(Text(f"It's at {i['text'].lower()}. How full is it now?", style=MUTED))
                yield Select([(lv, n) for n, lv in reversed(list(enumerate(LEVELS)))], value=i["level"], allow_blank=False, id="level")
            else:
                hint = f"How many {i['unit']}s you used (part of one counts as one)." if i["kind"] == "counted" else "How much you used, like 1 cup or 200 g."
                yield Static(Text(f"You have {i['text']}. {hint}", style=MUTED))
                yield Input("1" if i["kind"] == "counted" else "", id="amount", placeholder="1 cup", max_length=40)
            with Horizontal(classes="buttons"):
                if i["kind"] == "gauged":
                    yield Button("Set", id="level-set")
                else:
                    yield Button("Use it", id="use")
                    yield Button("Used it all", id="all", classes="quiet")
                yield Button("Tossed it", id="toss", classes="danger")
                yield Button("Cancel", id="cancel", classes="quiet")

    def on_mount(self) -> None:
        self.query_one("#level" if self.i["kind"] == "gauged" else "#amount").focus()

    def on_input_submitted(self) -> None:
        self.answer("use")

    def answer(self, how: str) -> None:
        if how == "use":
            n = self.query_one("#amount", Input).value.strip()
            if not n:
                return
            self.dismiss({"amount": n})
        elif how == "level-set":
            self.dismiss({"level": self.query_one("#level", Select).value})
        elif how == "all":
            self.dismiss({"all": True})
        elif how == "toss":
            self.dismiss({"all": True, "tossed": True})
        else:
            self.dismiss(None)

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.answer(e.button.id or "")

    def action_cancel(self) -> None:
        self.dismiss(None)


class LotDialog(ModalScreen[dict | None]):
    """Another purchase, or a correction to one: how much and when it expires."""
    BINDINGS = [Binding("escape", "cancel", "Cancel")]

    def __init__(self, item: dict, lot: dict | None = None):
        super().__init__()
        self.i, self.lot = item, lot

    def compose(self) -> ComposeResult:
        i, lot = self.i, self.lot or {}
        with Vertical(classes="dialog"):
            yield Label(Text(f"Correct the {i['name']} bought {nice(lot['added'])}" if lot else f"Bought more {i['name']}", style=f"bold {INK}"))
            yield Label(f"How many {i['unit']}s" if i["kind"] == "counted" else "How much, like 5 lb", classes="lbl")
            yield Input((str(lot["amount"]) if i["kind"] == "counted" else lot["text"]) if lot else "", id="amount", max_length=40)
            yield Label("Expires (YYYY-MM-DD, or leave it empty)", classes="lbl")
            yield Input(lot.get("expires", ""), id="expires", placeholder="YYYY-MM-DD", max_length=10)
            with Horizontal(classes="buttons"):
                yield Button("Save", id="save")
                yield Button("Cancel", id="cancel", classes="quiet")

    def on_mount(self) -> None:
        self.query_one("#amount", Input).focus()

    def save(self) -> None:
        n = self.query_one("#amount", Input).value.strip()
        if n:
            self.dismiss({"amount": n, "expires": self.query_one("#expires", Input).value.strip()})

    def on_input_submitted(self) -> None:
        self.save()

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.save() if e.button.id == "save" else self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class LotsDialog(ModalScreen[tuple[str, dict] | None]):
    """Each purchase of an item: enter corrects it, x takes it off. Dismisses with ("edit" or "remove", the lot)."""
    BINDINGS = [Binding("escape", "cancel", "Close"), Binding("x", "remove", "Take off")]

    def __init__(self, item: dict):
        super().__init__()
        self.i = item

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Label(Text(f"Each purchase of {self.i['name']}", style=f"bold {INK}"))
            yield OptionList(*[Option(Text.assemble((lot["text"], f"bold {INK}"), (f"   bought {nice(lot['added'])}", MUTED),
                                                    (f"   expires {nice(lot['expires'])}{est(lot)}" if lot["expires"] else "   no expiry date", MUTED)))
                               for lot in self.i["lots"]], id="lots")
            yield Static(Text("enter corrects one, x takes it off, esc closes", style=FAINT))

    def on_option_list_option_selected(self, e: OptionList.OptionSelected) -> None:
        self.dismiss(("edit", self.i["lots"][e.option_index]))

    def action_remove(self) -> None:
        at = self.query_one("#lots", OptionList).highlighted
        if at is not None:
            self.dismiss(("remove", self.i["lots"][at]))

    def action_cancel(self) -> None:
        self.dismiss(None)


class PantryPage(Page):
    WEB_PATH = "/pantry/"
    SIDE = None
    DEFAULT_CSS = """
    PantryPage #body { padding: 0 4 1 4; }
    PantryPage #cols { height: 1fr; }
    PantryPage #list { width: 3fr; height: 1fr; }
    PantryPage #detail { width: 2fr; height: auto; max-height: 100%; margin-left: 2; }
    """
    BINDINGS = [Binding("n", "add", "Add food"), Binding("u", "use", "Use"), Binding("m", "more", "Bought more"),
                Binding("e", "edit", "Edit"), Binding("p", "lots", "Purchases"), Binding("x", "remove", "Remove"),
                Binding("f", "filter", "Show"), Binding("slash", "find", "Find"), Binding("c", "receipt", "Receipt"),
                Binding("s", "scanner", "Phone scanner"), Binding("k", "key", "Claude key", show=False), Binding("r", "refresh", "Refresh")]

    def __init__(self):
        super().__init__()
        self.data: dict = {"items": [], "places": [], "counts": {"all": 0, "soon": 0, "low": 0}}
        self.filt = "all"
        self.find = ""
        self.rows: list[dict | None] = []   # an item per option; None for a place's heading

    def compose(self) -> ComposeResult:
        yield from self.top()
        with Vertical(id="body"):
            yield Static(Text("K I T C H E N", style=f"bold {GOLD}"), classes="kicker")
            yield Static(Text("Pantry", style=f"bold {INK}"), classes="h1")
            yield Static("", id="sub", classes="sub")
            with Horizontal(id="cols"):
                yield OptionList(id="list", classes="card")
                yield Static("", id="detail", classes="card")
        yield Footer()

    async def on_mount(self) -> None:
        await self.action_refresh()

    @attempt
    async def action_refresh(self) -> None:
        self.show(await self.fetch(site.pantry, dt.date.today().isoformat()))

    def show(self, data: dict, keep: str | None = None) -> None:
        self.data = data
        c = data["counts"]
        tabs = []
        for f, name in FILTERS:
            tabs += [(name, f"bold {GOLD}" if f == self.filt else MUTED), (f" {c[f]}" if c[f] else "", FAINT), ("   ", "")]
        self.query_one("#sub", Static).update(Text.assemble(*tabs, (f"finding “{self.find}”   " if self.find else "", WARN),
                                                            ("f switches, / finds, n adds food", FAINT)))
        box = self.query_one("#list", OptionList)
        at = self.current()
        keep = keep or (at and at["id"])
        box.clear_options()
        self.rows = []
        items = shown(data["items"], self.filt, self.find)
        if not data["items"]:
            box.add_option(Option(Text("Nothing in your pantry yet. Press n to add food, like Whole wheat flour, 10 lb.", style=FAINT), disabled=True))
        elif not items:
            box.add_option(Option(Text({"soon": "Nothing to use soon.", "low": "Nothing's running low."}.get(self.filt, "Nothing matches."), style=FAINT), disabled=True))
        for place in data["places"]:
            here = [i for i in items if i["place"] == place]
            if not here:
                continue
            self.rows.append(None)
            box.add_option(Option(Text.assemble((place, f"bold {GOLD}"), (f"  {len(here)}", FAINT)), disabled=True))
            for i in here:
                self.rows.append(i)
                line = Text.assemble(("  " + i["name"], INK), ("  " + i["kind"], FAINT))
                line.align("left", 34)
                line.append_text(have(i))
                w = when(i)
                if w.plain:
                    line.append("   ")
                    line.append_text(w)
                line.no_wrap, line.overflow = True, "ellipsis"
                box.add_option(Option(line))
        box.border_title = plural(len(items), "thing")
        if keep:
            idx = next((n for n, i in enumerate(self.rows) if i and i["id"] == keep), None)
        else:
            idx = None
        if idx is None:
            idx = next((n for n, i in enumerate(self.rows) if i), None)
        if idx is not None:
            box.highlighted = idx
        box.focus()
        self.show_detail()

    def current(self) -> dict | None:
        box = self.query_one("#list", OptionList)
        if box.highlighted is None or box.highlighted >= len(self.rows):
            return None
        return self.rows[box.highlighted]

    def on_option_list_option_highlighted(self, e: OptionList.OptionHighlighted) -> None:
        self.show_detail()

    def show_detail(self) -> None:
        i = self.current()
        d = self.query_one("#detail", Static)
        if not i:
            d.update(Text("Highlight something to see it here.", style=FAINT))
            return
        t = Text.assemble((i["name"], f"bold {INK}"), (f"   {i['kind']}{' staple' if i.get('staple') else ''}, {i['place']}\n\n", FAINT), have(i))
        if i.get("staple") and i["low_text"]:
            t.append(f"\n{'Out' if i['is_out'] else 'Low' if i['is_low'] else 'Low at'} {'' if i['is_out'] else i['low_text']}".rstrip(), MUTED)
        if i["kind"] == "counted" and i["size"]:
            t.append(f"\n{i['size']} each", MUTED)
        if i.get("words"):
            t.append(f"\nAlso called {i['words']}", MUTED)
        w = when(i)
        if w.plain:
            t.append("\n")
            t.append_text(w)
        if i["kind"] != "gauged":
            t.append("\n\nPURCHASES\n", f"bold {FAINT}")
            if not i["lots"]:
                t.append("None left. m adds what you buy next.", FAINT)
            for lot in i["lots"]:
                t.append(f"{lot['text']}", INK)
                t.append(f"  bought {nice(lot['added'])}" + (f", expires {nice(lot['expires'])}{est(lot)}" if lot["expires"] else ""), MUTED)
                t.append("\n")
        t.append("\n\nu use · m " + ("refill" if i["kind"] == "gauged" else "bought more") + " · e edit" + ("" if i["kind"] == "gauged" else " · p purchases"), FAINT)
        d.update(t)

    # ── actions ────────────────────────────────────────────────────────────

    async def done(self, out: dict, said: str) -> None:
        self.app.notify(said, timeout=4)
        self.show(await self.fetch(site.pantry, dt.date.today().isoformat()), keep=out.get("id"))

    def action_add(self) -> None:
        async def made(f: dict | None) -> None:
            if f:
                await self.add(f)
        self.app.push_screen(ItemDialog(None, self.data.get("usual_places", []) or self.data["places"]), made)

    @attempt
    async def add(self, f: dict) -> None:
        out = await self.fetch(site.add_pantry_item, f)
        await self.done(out, f"Added {out['name']}: {out['text']}.")

    def action_edit(self) -> None:
        i = self.current()
        if not i:
            return

        async def changed(f: dict | None) -> None:
            if f:
                await self.edit(i, f)
        self.app.push_screen(ItemDialog(i, self.data.get("usual_places", []) or self.data["places"]), changed)

    @attempt
    async def edit(self, i: dict, f: dict) -> None:
        out = await self.fetch(site.edit_pantry_item, i["id"], f)
        await self.done(out, f"Saved {out['name']}.")

    def action_use(self) -> None:
        i = self.current()
        if not i:
            return

        async def used(how: dict | None) -> None:
            if how:
                await self.use(i, how)
        self.app.push_screen(UseDialog(i), used)

    @attempt
    async def use(self, i: dict, how: dict) -> None:
        out = await self.fetch(site.use_pantry_item, i["id"], how)
        said = (f"Tossed the {i['name']}." if how.get("tossed") else f"Used up the {i['name']}." if how.get("all")
                else f"{i['name']} is at {out['text'].lower()}." if i["kind"] == "gauged" else f"{i['name']}: {out['text']} left.")
        await self.done(out, said)

    def action_more(self) -> None:
        i = self.current()
        if not i:
            return
        if i["kind"] == "gauged":
            self.run_worker(self.use(i, {"level": 5}))
            return

        async def bought(f: dict | None) -> None:
            if f:
                await self.lot(i, None, f)
        self.app.push_screen(LotDialog(i), bought)

    @attempt
    async def lot(self, i: dict, lot: dict | None, f: dict) -> None:
        if lot:
            out = await self.fetch(site.edit_pantry_lot, i["id"], lot["id"], f)
        else:
            out = await self.fetch(site.add_pantry_lot, i["id"], f["amount"], f["expires"])
        await self.done(out, f"{i['name']}: {out['text']} now.")

    def action_lots(self) -> None:
        i = self.current()
        if not i or i["kind"] == "gauged" or not i["lots"]:
            self.app.notify("Nothing bought to correct here." if i else "Highlight something first.", timeout=3)
            return

        async def picked(choice: tuple[str, dict] | None) -> None:
            if not choice:
                return
            what, lot = choice
            if what == "edit":
                async def fixed(f: dict | None) -> None:
                    if f:
                        await self.lot(i, lot, f)
                self.app.push_screen(LotDialog(i, lot), fixed)
            else:
                async def sure(yes: bool | None) -> None:
                    if yes:
                        await self.take_off(i, lot)
                self.app.push_screen(Confirm(f"Take the {lot['text']} of {i['name']} off?", f"Bought {nice(lot['added'])}.", yes="Take it off", danger=True), sure)
        self.app.push_screen(LotsDialog(i), picked)

    @attempt
    async def take_off(self, i: dict, lot: dict) -> None:
        out = await self.fetch(site.delete_pantry_lot, i["id"], lot["id"])
        await self.done(out, f"{i['name']}: {out['text']} now.")

    def action_remove(self) -> None:
        i = self.current()
        if not i:
            return

        async def sure(yes: bool | None) -> None:
            if yes:
                await self.remove(i)
        self.app.push_screen(Confirm(f"Remove {i['name']} from your pantry?", "Every purchase of it goes too.", yes="Remove", danger=True), sure)

    @attempt
    async def remove(self, i: dict) -> None:
        await self.fetch(site.delete_pantry_item, i["id"])
        await self.done({}, f"Removed {i['name']}.")

    def action_filter(self) -> None:
        names = [f for f, _ in FILTERS]
        self.filt = names[(names.index(self.filt) + 1) % len(names)]
        self.show(self.data)

    def action_find(self) -> None:
        def found(text: str | None) -> None:
            if text is not None:
                self.find = text.strip()
                self.show(self.data)
        self.app.push_screen(Ask("Find in your pantry", "Part of a name. Leave it empty to show everything.", value=self.find, ok="Find"), found)

    # ── a receipt ──────────────────────────────────────────────────────────

    def action_receipt(self) -> None:
        photo = self.data.get("photo") or {}
        if not photo.get("ready") and not photo.get("ai"):
            self.app.notify("Reading receipts needs your Anthropic API key: press k to add it.", severity="error", timeout=6)
            return

        async def answer(paths: str | None) -> None:
            if paths and paths.strip():
                await self.read_receipt([x.strip() for x in paths.split(",") if x.strip()])
        who = "Claude reads it, with your key. " if photo.get("ready") else "The site's AI reads it (Cloudflare's, no key needed). "
        self.app.push_screen(Ask("Scan a receipt",
                                 "A photo of a grocery receipt (a long one: up to 4 pictures, top to bottom, separated by commas). "
                                 + who + "You check each line before anything is added.",
                                 placeholder="~/Pictures/receipt.jpg", ok="Read it"), answer)

    @attempt
    async def read_receipt(self, paths: list[str]) -> None:
        self.app.notify(f"Reading {'the receipt' if len(paths) == 1 else f'{len(paths)} pictures'}…", timeout=8)
        out = await self.fetch(site.read_receipt, paths, dt.date.today().isoformat())
        if out.get("why"):
            self.app.notify(f"Claude couldn't read it ({out['why'].split('. ')[0].rstrip('.')}), so the site's AI did.", timeout=6)
        self.check_receipt(out["store"], out["date"], out["by"], ReceiptDialog.rows_from(out["lines"]))

    def check_receipt(self, store: str, date: str, by: str, rows: list[dict]) -> None:
        async def checked(send: list[dict] | None) -> None:
            if send is not None:
                await self.add_receipt(store, date, by, rows, send)
        self.app.push_screen(ReceiptDialog(store, date, by, rows, self.data["items"], self.data.get("usual_places", []) or self.data["places"]), checked)

    @attempt
    async def add_receipt(self, store: str, date: str, by: str, rows: list[dict], send: list[dict]) -> None:
        out = await self.fetch(site.add_receipt, store, [ReceiptDialog.line(r) for r in send])
        names = ", ".join(a["name"] for a in out["added"])
        self.show(await self.fetch(site.pantry, dt.date.today().isoformat()))
        if not out["failed"]:
            self.app.notify(f"Added {len(out['added'])} from the receipt" + (f": {names}." if names else "."), timeout=6)
            return
        # The ones that couldn't go in stay to fix, each saying why.
        why = {f["printed"]: f["error"] for f in out["failed"]}
        left = [{**r, "error": why[r["printed"]]} for r in send if r["printed"] in why]
        self.app.notify(f"Added {len(out['added'])}. {plural(len(left), 'line')} still need a fix.", severity="warning", timeout=6)
        self.check_receipt(store, date, by, left)

    def action_key(self) -> None:
        if not (self.data.get("photo") or {}).get("sealing"):
            self.app.notify("This site can't keep API keys yet. Ask its admin to set CHAT_BRIDGE_KEY.", severity="error", timeout=6)
            return

        async def answer(key: str | None) -> None:
            if key and key.strip():
                await self.save_key(key.strip())
        self.app.push_screen(Ask("Read receipts with Claude",
                                 "Claude reads receipts with your own Anthropic API key (console.anthropic.com/settings/keys), "
                                 "so nobody else is billed for yours. It's kept sealed on the site; Recipe box and Sweep use the same one.",
                                 placeholder="sk-ant-…", ok="Save key", password=True), answer)

    @attempt
    async def save_key(self, key: str) -> None:
        self.data["photo"] = (await self.fetch(site.pantry_key, key))["photo"]
        self.app.notify("Key saved: receipts are read by Claude now.", timeout=3)

    # ── the phone scanner ──────────────────────────────────────────────────

    @attempt
    async def action_scanner(self) -> None:
        code = await self.fetch(site.pair_pantry_scanner)
        phones = (await self.fetch(site.pantry_scanners))["scanners"]
        self.app.push_screen(ScannerDialog(code, phones))
