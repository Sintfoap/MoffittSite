"""Checking a receipt before it goes in the pantry, as on /pantry/: each line
the site read, ticked or not (space), and what it adds to (enter changes it:
something you have, or new, with how much and when it expires). ctrl+s adds
the ticked ones. A line that can't go in comes back here saying why."""
from __future__ import annotations

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Checkbox, Input, Label, OptionList, Select, Static
from textual.widgets.option_list import Option

from .look import BAD, FAINT, GOLD, INK, MUTED

LEVELS = ["Empty", "Almost out", "¼ left", "½ left", "¾ left", "Full"]
KINDS = (("Measured: by weight or volume, like flour", "measured"), ("Counted: whole units, like cans", "counted"), ("Gauged: full to empty, like spices", "gauged"))
HOW = {"remembered": "remembered from this store", "name": "matched by name"}


def _nice(day: str) -> str:
    from .pantry_page import nice
    return nice(day) if day else ""


class ReceiptDialog(ModalScreen[list[dict] | None]):
    """Dismisses with the ticked rows to add, or None."""
    BINDINGS = [Binding("escape", "cancel", "Cancel"), Binding("space", "tick", "Tick"),
                Binding("ctrl+s", "add", "Add", priority=True)]
    DEFAULT_CSS = """
    ReceiptDialog #rlines { height: auto; max-height: 24; }
    """

    def __init__(self, store: str, date: str, by: str, rows: list[dict], items: list[dict], places: list[str]):
        super().__init__()
        self.store, self.date, self.by, self.rows, self.items, self.places = store, date, by, rows, items, places

    @staticmethod
    def rows_from(lines: list[dict]) -> list[dict]:
        """The site's proposals as rows to check (what's not food starts unticked)."""
        rows = []
        for l in lines:
            m, new = l.get("match"), l.get("new") or {}
            rows.append({"printed": l["printed"], "said": l["name"], "on": not l["skip"], "skip": l["skip"],
                         "item": m["id"] if m else "", "match": m, "name": l["name"],
                         "kind": new.get("kind", "counted"), "place": new.get("place", ""), "unit": new.get("unit", ""),
                         "size": new.get("size", ""), "staple": False, "low": "", "amount": l.get("amount", ""),
                         "expires": l.get("expires", ""), "expires_by": l.get("expires_by", ""), "error": ""})
        return rows

    @staticmethod
    def line(r: dict) -> dict:
        """A row as the site takes it."""
        lot = {"printed": r["printed"], "amount": r["amount"], "expires": r["expires"], "expires_by": r["expires_by"] if r["expires"] else ""}
        if r.get("level") is not None:
            lot["level"] = r["level"]
        if r["item"]:
            return {**lot, "item": r["item"]}
        out = {**lot, "name": r["name"], "kind": r["kind"], "place": r["place"], "unit": r["unit"], "size": r["size"], "staple": bool(r.get("staple"))}
        return {**out, "low": r["low"]} if out["staple"] else out

    def target(self, r: dict) -> dict | None:
        return next((i for i in self.items if i["id"] == r["item"]), None)

    def label(self, r: dict) -> Text:
        i = self.target(r)
        t = Text.assemble(("[x] " if r["on"] else "[ ] ", GOLD if r["on"] else FAINT), (r["printed"] or r["said"], MUTED if r["on"] else FAINT))
        if r["skip"] and not r["on"]:
            t.append("   not food, so it's left off (space to add it)", FAINT)
            return t
        t.append("\n    ")
        if i:
            m = r.get("match") or {}
            t.append(i["name"], f"bold {INK}")
            t.append(f"  have {i['text']}", MUTED)
            t.append(f"  ({HOW.get(m.get('how', ''), 'picked') if m.get('id') == i['id'] else 'picked'})", FAINT)
        else:
            t.append("New: ", GOLD)
            t.append(r["name"] or "(no name)", f"bold {INK}")
            t.append(f"  {r['kind']}{' staple' if r.get('staple') else ''}, {r['place'] or 'Cupboard'}", FAINT)
        t.append("\n    ")
        if (i or {}).get("kind", r["kind"]) == "gauged":
            t.append(f"{LEVELS[r['level'] if r.get('level') is not None else 5].lower()}", MUTED)
        else:
            t.append(f"+ {r['amount'] or '?'}", INK)
            if r["expires"]:
                t.append(f"   expires {_nice(r['expires'])}" + (" (est.)" if r["expires_by"] == "estimated" else ""), MUTED)
        if r["error"]:
            t.append(f"\n    {r['error']}", BAD)
        return t

    def compose(self) -> ComposeResult:
        bits = [b for b in (f"bought {_nice(self.date)}" if self.date else "", "read by Claude" if self.by == "claude" else "read by the site's AI") if b]
        with Vertical(classes="dialog"):
            yield Label(Text.assemble((f"Check the {self.store} receipt" if self.store else "Check the receipt", f"bold {INK}"),
                                      ("   " + " · ".join(bits), FAINT)))
            yield Static(Text("Untick anything that isn't for the pantry. Lines already in your pantry add to what's there; the rest are new. "
                              "(est.) dates are estimates from how long such things usually keep.", style=MUTED))
            yield OptionList(*[Option(self.label(r)) for r in self.rows], id="rlines")
            with Horizontal(classes="buttons"):
                yield Button("Add", id="add")
                yield Button("Cancel", id="cancel", classes="quiet")
            yield Static("", id="count")

    def on_mount(self) -> None:
        self.query_one(".dialog").styles.width = 100   # wider than other dialogs, for the lines
        self.query_one("#rlines", OptionList).focus()
        self.refresh_rows()

    def refresh_rows(self, at: int | None = None) -> None:
        box = self.query_one("#rlines", OptionList)
        keep = box.highlighted if at is None else at
        box.clear_options()
        box.add_options([Option(self.label(r)) for r in self.rows])
        if self.rows:
            box.highlighted = min(keep or 0, len(self.rows) - 1)
        n = sum(r["on"] for r in self.rows)
        self.query_one("#add", Button).label = f"Add {n} to pantry"
        self.query_one("#count", Static).update(Text("space ticks, enter changes a line, ctrl+s adds, esc cancels", style=FAINT))

    def action_tick(self) -> None:
        at = self.query_one("#rlines", OptionList).highlighted
        if at is not None:
            self.rows[at]["on"] = not self.rows[at]["on"]
            self.refresh_rows(at)

    def on_option_list_option_selected(self, e: OptionList.OptionSelected) -> None:
        at = e.option_index

        def changed(r: dict | None) -> None:
            if r:
                self.rows[at] = {**r, "on": True, "error": ""}
                self.refresh_rows(at)
        self.app.push_screen(LineDialog(self.rows[at], self.items, self.places), changed)

    def action_add(self) -> None:
        send = [r for r in self.rows if r["on"]]
        if not send:
            self.app.notify("Tick something to add.", severity="error", timeout=3)
            return
        self.dismiss(send)

    def action_cancel(self) -> None:
        self.dismiss(None)

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.action_add() if e.button.id == "add" else self.dismiss(None)


class LineDialog(ModalScreen[dict | None]):
    """One receipt line: what it adds to, how much, and when it expires."""
    BINDINGS = [Binding("escape", "cancel", "Cancel"), Binding("ctrl+s", "save", "Save", priority=True)]
    DEFAULT_CSS = """
    LineDialog .grid, LineDialog #gauged, LineDialog #new { height: auto; }
    LineDialog .grid > Vertical { height: auto; width: 1fr; margin-right: 1; }
    """

    def __init__(self, row: dict, items: list[dict], places: list[str]):
        super().__init__()
        self.r, self.items, self.places = row, items, places

    def compose(self) -> ComposeResult:
        r = self.r
        to = [(f"New: {r['name'] or r['said']}", "")] + [(f"{i['name']} (have {i['text']})", i["id"]) for i in self.items]
        with VerticalScroll(classes="dialog"):
            yield Label(Text.assemble((r["printed"] or r["said"], f"bold {INK}"), (f"   {r['said']}" if r["printed"] else "", FAINT)))
            yield Label("Adds to", classes="lbl")
            yield Select(to, value=r["item"], allow_blank=False, id="to")
            with Vertical(id="new"):
                yield Label("Name", classes="lbl")
                yield Input(r["name"], id="name", max_length=80)
                with Horizontal(classes="grid"):
                    with Vertical():
                        yield Label("Kind", classes="lbl")
                        yield Select(list(KINDS), value="measured" if r["kind"] == "staple" else r["kind"], allow_blank=False, id="kind")
                    with Vertical():
                        yield Label("Where it's kept", classes="lbl")
                        yield Input(r["place"], id="place", placeholder=" / ".join(self.places[:4]) or "Cupboard", max_length=30)
                with Vertical(id="counted"):
                    yield Label("One is a", classes="lbl")
                    yield Input(r["unit"], id="unit", placeholder="can", max_length=20)
                yield Checkbox("Staple: kept stocked, and running low at…", bool(r.get("staple")), id="staple")
                yield Input("" if isinstance(r["low"], int) else str(r["low"]), id="low", placeholder="2 lb, or how many", max_length=40)
                yield Select([(lv, n) for n, lv in reversed(list(enumerate(LEVELS))) if n < 5],
                             value=r["low"] if isinstance(r["low"], int) else 1, allow_blank=False, id="low-level")
            with Vertical(id="gauged"):
                yield Label("How full", classes="lbl")
                yield Select([(lv, n) for n, lv in reversed(list(enumerate(LEVELS)))], value=r.get("level") if r.get("level") is not None else 5,
                             allow_blank=False, id="level")
            with Horizontal(classes="grid", id="amounts"):
                with Vertical():
                    yield Label("How much", classes="lbl")
                    yield Input(r["amount"], id="amount", placeholder="10 lb, or how many", max_length=40)
                with Vertical():
                    yield Label("Expires" + (" (estimated)" if r["expires_by"] == "estimated" else ""), classes="lbl")
                    yield Input(r["expires"], id="expires", placeholder="YYYY-MM-DD", max_length=10)
            with Horizontal(classes="buttons"):
                yield Button("Save", id="save")
                yield Button("Cancel", id="cancel", classes="quiet")

    def on_mount(self) -> None:
        self.show_parts()
        self.query_one("#to", Select).focus()

    def kind(self) -> str:
        to = self.query_one("#to", Select).value
        i = next((i for i in self.items if i["id"] == to), None)
        return i["kind"] if i else str(self.query_one("#kind", Select).value)

    def show_parts(self) -> None:
        new = not self.query_one("#to", Select).value
        k = self.kind()
        self.query_one("#new").display = new
        staple = self.query_one("#staple", Checkbox).value
        self.query_one("#low").display = staple and k != "gauged"
        self.query_one("#low-level").display = staple and k == "gauged"
        self.query_one("#counted").display = k == "counted"
        self.query_one("#amounts").display = k != "gauged"
        self.query_one("#gauged").display = k == "gauged"

    def on_select_changed(self, e: Select.Changed) -> None:
        self.show_parts()

    def on_checkbox_changed(self, e: Checkbox.Changed) -> None:
        self.show_parts()

    def action_save(self) -> None:
        v = lambda x: self.query_one(f"#{x}", Input).value.strip()  # noqa: E731
        expires = v("expires")
        self.dismiss({**self.r, "item": str(self.query_one("#to", Select).value or ""), "name": v("name"),
                      "kind": str(self.query_one("#kind", Select).value), "place": v("place"), "unit": v("unit"),
                      "staple": self.query_one("#staple", Checkbox).value,
                      "low": self.query_one("#low-level", Select).value if str(self.query_one("#kind", Select).value) == "gauged" else v("low"),
                      "amount": v("amount"), "expires": expires,
                      "level": self.query_one("#level", Select).value if self.kind() == "gauged" else None,
                      "expires_by": self.r["expires_by"] if expires == self.r["expires"] else "typed" if expires else ""})

    def action_cancel(self) -> None:
        self.dismiss(None)

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.action_save() if e.button.id == "save" else self.dismiss(None)


class ScannerDialog(ModalScreen[None]):
    """Pairing the Pantry scanner app: a QR code for the phone to scan (or its code to type), and
    the phones already paired, x unpairing the highlighted one. n makes a new code."""
    BINDINGS = [Binding("escape", "close", "Close"), Binding("x", "unpair", "Unpair"), Binding("n", "new", "New code")]

    def __init__(self, pairing: dict, phones: list[dict]):
        super().__init__()
        self.pairing, self.phones = pairing, phones

    def compose(self) -> ComposeResult:
        with VerticalScroll(classes="dialog"):
            yield Label(Text("Scan with your phone", style=f"bold {INK}"))
            yield Static(Text("In the Pantry scanner app (Android), tap Pair and point it at this code, or type the code.", style=MUTED))
            yield Static(self.qr(), id="qr")
            yield Static("", id="code")
            yield Label("Paired phones", classes="lbl")
            yield OptionList(id="phones")
            yield Static(Text("n new code · x unpairs the highlighted phone · esc closes", style=FAINT))

    def qr(self) -> Text:
        # A white margin all round, which cameras need to find the code.
        rows = self.pairing["qr_text"].rstrip("\n").split("\n")
        pad = " " * (len(rows[0]) + 4)
        return Text("\n".join([pad] + [f"  {r}  " for r in rows] + [pad]), style="black on white", no_wrap=True)

    def on_mount(self) -> None:
        self.query_one(".dialog").styles.width = 70
        self.show()

    def show(self) -> None:
        self.query_one("#qr", Static).update(self.qr())
        self.query_one("#code", Static).update(Text.assemble(("Code  ", MUTED), (self.pairing["code"], f"bold {GOLD}"),
                                                             ("   works once, for 10 minutes", FAINT)))
        box = self.query_one("#phones", OptionList)
        box.clear_options()
        if not self.phones:
            box.add_option(Option(Text("None yet.", style=FAINT), disabled=True))
        for p in self.phones:
            used = f"last used {_nice(p['last_used'][:10])}" if p.get("last_used") else "never used"
            box.add_option(Option(Text.assemble((p["name"], f"bold {INK}"), (f"   paired {_nice(p['created'][:10])}, {used}", MUTED))))
        if self.phones:
            box.highlighted = 0
            box.focus()

    async def action_new(self) -> None:
        from . import site
        from .look import Failed, fetch
        try:
            self.pairing = await fetch(self.app, site.pair_pantry_scanner)
        except Failed:
            return
        self.show()

    async def action_unpair(self) -> None:
        from . import site
        from .look import Failed, fetch
        at = self.query_one("#phones", OptionList).highlighted
        if at is None or at >= len(self.phones):
            return
        p = self.phones[at]
        try:
            self.phones = (await fetch(self.app, site.unpair_pantry_scanner, p["id"]))["scanners"]
        except Failed:
            return
        self.app.notify(f"Unpaired {p['name']}.", timeout=3)
        self.show()

    def action_close(self) -> None:
        self.dismiss(None)
