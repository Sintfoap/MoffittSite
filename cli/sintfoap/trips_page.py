"""Trip planner in the terminal: the same trips as /trips/.

Your trips down the left, the open one on the right in three tabs (1 the
days, 2 the places, 3 the packing list), as on the website. a adds to the tab
you're on, x takes the highlighted line off, and s sends the packing list to
a Drift checklist. Everyone on a trip can change it; whoever made it picks
who's going (m)."""
from __future__ import annotations

from datetime import date

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Footer, Input, Label, OptionList, Select, SelectionList, Static, TextArea
from textual.widgets.option_list import Option
from textual.widgets.selection_list import Selection

from . import site
from .look import FAINT, GOLD, GOLD_DIM, GOOD, INK, MUTED, Ask, Confirm, Failed, Page, attempt, fetch, plural

TABS = (("days", "Days"), ("places", "Places"), ("packing", "Packing"))
KIND = {"days": "plans", "places": "places", "packing": "packing"}
DEFAULT = "default:"   # the send list's value for the trip's own Packing checklist
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
DAYS = "Mon Tue Wed Thu Fri Sat Sun".split()


def nice_day(d: str) -> str:
    t = date.fromisoformat(d)
    return f"{DAYS[t.weekday()]} {t.day} {MONTHS[t.month - 1]}"


def span(t: dict) -> str:
    """When the trip is, as the website says it."""
    if not t.get("start"):
        return "No dates yet"
    if not t.get("end") or t["end"] == t["start"]:
        return f"{nice_day(t['start'])} {t['start'][:4]}"
    n = (date.fromisoformat(t["end"]) - date.fromisoformat(t["start"])).days + 1
    return f"{nice_day(t['start'])} – {nice_day(t['end'])} {t['end'][:4]} · {n} days"


def packing_name(title: str) -> str:
    return f"Packing: {title}"[:100]


class TripDialog(ModalScreen[dict | None]):
    """A trip's name, dates and notes (or a new trip's). Dismisses with what to save, or None."""
    BINDINGS = [Binding("escape", "cancel", "Cancel"), Binding("ctrl+s", "save", "Save", priority=True)]
    DEFAULT_CSS = """
    TripDialog .grid { height: auto; }
    TripDialog .grid > Vertical { height: auto; width: 1fr; margin-right: 1; }
    TripDialog #notes { height: 5; }
    """

    def __init__(self, trip: dict | None):
        super().__init__()
        self.t = trip or {}

    def compose(self) -> ComposeResult:
        t = self.t
        with VerticalScroll(classes="dialog"):
            yield Label(Text("Edit trip" if t else "New trip", style=f"bold {INK}"))
            yield Label("Where to", classes="lbl")
            yield Input(t.get("title", ""), id="title", placeholder="Lisbon in May", max_length=200)
            with Horizontal(classes="grid"):
                with Vertical():
                    yield Label("From", classes="lbl")
                    yield Input(t.get("start", ""), id="start", placeholder="2026-05-01", max_length=10)
                with Vertical():
                    yield Label("To", classes="lbl")
                    yield Input(t.get("end", ""), id="end", placeholder="2026-05-04", max_length=10)
            yield Label("Notes", classes="lbl")
            yield TextArea(t.get("notes", ""), id="notes", soft_wrap=True)
            with Horizontal(classes="buttons"):
                yield Button("Save", id="save")
                yield Button("Cancel", id="cancel", classes="quiet")
            yield Static(Text("Dates are YYYY-MM-DD. ctrl+s saves, esc cancels", style=FAINT))

    def on_mount(self) -> None:
        self.query_one("#title", Input).focus()

    def action_save(self) -> None:
        v = lambda i: self.query_one(f"#{i}", Input).value.strip()  # noqa: E731
        if not v("title"):
            self.app.notify("A trip needs a name.", severity="error", timeout=3)
            self.query_one("#title", Input).focus()
            return
        self.dismiss({"title": v("title"), "start": v("start"), "end": v("end") or v("start"),
                      "notes": self.query_one("#notes", TextArea).text.strip()})

    def action_cancel(self) -> None:
        self.dismiss(None)

    def on_input_submitted(self) -> None:
        self.action_save()

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.action_save() if e.button.id == "save" else self.dismiss(None)


class StopDialog(ModalScreen[dict | None]):
    """A stop on the itinerary: which day, when, what, and where."""
    BINDINGS = [Binding("escape", "cancel", "Cancel"), Binding("ctrl+s", "save", "Save", priority=True)]
    DEFAULT_CSS = """
    StopDialog .grid { height: auto; }
    StopDialog .grid > Vertical { height: auto; width: 1fr; margin-right: 1; }
    """

    def __init__(self, trip: dict, day: str):
        super().__init__()
        self.t, self.day = trip, day

    def compose(self) -> ComposeResult:
        t = self.t
        days = [(f"Day {i + 1} · {nice_day(d)}", d) for i, d in enumerate(t["days"])] + [("Any day", "")]
        with VerticalScroll(classes="dialog"):
            yield Label(Text("Add a stop", style=f"bold {INK}"))
            with Horizontal(classes="grid"):
                with Vertical():
                    yield Label("Day", classes="lbl")
                    yield Select(days, value=self.day if any(d == self.day for _, d in days) else "", allow_blank=False, id="day")
                with Vertical():
                    yield Label("Time", classes="lbl")
                    yield Input(id="time", placeholder="09:30", max_length=5)
            yield Label("What's the plan", classes="lbl")
            yield Input(id="title", max_length=300)
            yield Label("Place", classes="lbl")
            yield Select([("No place", "")] + [(f"{i + 1}. {p['place']}", p["id"]) for i, p in enumerate(t["places"])],
                         value="", allow_blank=False, id="place")
            with Horizontal(classes="buttons"):
                yield Button("Add", id="save")
                yield Button("Cancel", id="cancel", classes="quiet")
            yield Static(Text("ctrl+s adds, esc cancels", style=FAINT))

    def on_mount(self) -> None:
        self.query_one("#title", Input).focus()

    def action_save(self) -> None:
        title = self.query_one("#title", Input).value.strip()
        if not title:
            self.app.notify("Say what the plan is.", severity="error", timeout=3)
            return
        self.dismiss({"day": self.query_one("#day", Select).value, "time": self.query_one("#time", Input).value.strip(),
                      "title": title, "place": self.query_one("#place", Select).value})

    def action_cancel(self) -> None:
        self.dismiss(None)

    def on_input_submitted(self) -> None:
        self.action_save()

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.action_save() if e.button.id == "save" else self.dismiss(None)


class PlaceDialog(ModalScreen[dict | None]):
    """Pinning a place: searched for (when the site can), typed, or one off
    your Drift map. Dismisses with the place's fields, or None."""
    BINDINGS = [Binding("escape", "cancel", "Cancel")]
    DEFAULT_CSS = """
    PlaceDialog OptionList { height: auto; max-height: 10; margin-bottom: 1; }
    """

    def __init__(self, search: bool, drift: bool):
        super().__init__()
        self.search, self.drift = search, drift
        self.found: list[dict] = []
        self.mine: list[dict] = []

    def compose(self) -> ComposeResult:
        with VerticalScroll(classes="dialog"):
            yield Label(Text("Pin a place", style=f"bold {INK}"))
            yield Input(id="q", placeholder="Search for a place or an address" if self.search else "A place to pin (its name)", max_length=200)
            yield OptionList(id="found")
            if self.drift:
                yield Label("From your Drift map", classes="lbl")
                yield OptionList(id="mine")
            yield Static(Text("enter searches, then pick one" if self.search else "enter pins it", style=FAINT))

    async def on_mount(self) -> None:
        self.query_one("#found").display = False
        self.query_one("#q", Input).focus()
        if self.drift:
            try:
                self.mine = await fetch(self.app, site.drift_places)
            except Failed:
                self.mine = []
            box = self.query_one("#mine", OptionList)
            for i, it in enumerate(self.mine):
                box.add_option(Option(Text.assemble((it["title"], INK), (f"  {it['place']} · {it['collection']}" if it["place"] else f"  {it['collection']}", FAINT)), id=str(i)))
            if not self.mine:
                box.add_option(Option(Text("Nothing on your Drift map yet.", style=FAINT), disabled=True))

    async def on_input_submitted(self, e: Input.Submitted) -> None:
        q = e.value.strip()
        if not q:
            return
        if not self.search:
            self.dismiss({"place": q})
            return
        try:
            self.found = await fetch(self.app, site.search_places, q) or []
        except Failed:
            return
        box = self.query_one("#found", OptionList)
        box.clear_options()
        for i, r in enumerate(self.found):
            box.add_option(Option(Text.assemble((r["place"], INK), (f"  {r['lat']:.4f}, {r['lng']:.4f}", FAINT)), id=str(i)))
        if not self.found:
            box.add_option(Option(Text("Nothing found by that name.", style=FAINT), disabled=True))
        box.display = True
        box.focus()

    def on_option_list_option_selected(self, e: OptionList.OptionSelected) -> None:
        i = int(e.option.id)
        if e.option_list.id == "found":
            self.dismiss(dict(self.found[i]))
        else:
            it = self.mine[i]
            self.dismiss({"place": it["place"] or it["title"], "lat": it["lat"], "lng": it["lng"],
                          "note": it["title"] if it["place"] else "", "drift": it["id"]})

    def action_cancel(self) -> None:
        self.dismiss(None)


class TripsPage(Page):
    WEB_PATH = "/trips/"
    SIDE = "#shelf"
    DEFAULT_CSS = f"""
    TripsPage #body {{ padding: 0 2 0 2; height: 1fr; }}
    TripsPage #main {{ height: 1fr; }}
    TripsPage #shelf {{ width: 34; height: 1fr; border-right: solid {GOLD_DIM}; margin-right: 2; }}
    TripsPage #trip {{ width: 1fr; height: 1fr; }}
    TripsPage #title {{ color: {INK}; text-style: bold; }}
    TripsPage #facts {{ color: {FAINT}; }}
    TripsPage #people {{ margin-bottom: 1; }}
    TripsPage #notes {{ color: {MUTED}; margin-bottom: 1; }}
    TripsPage #tabs {{ margin-bottom: 1; }}
    TripsPage OptionList, TripsPage SelectionList {{ height: auto; max-height: 24; background: {INK} 0%; border: none; padding: 0; margin-bottom: 1; }}
    TripsPage OptionList:focus, TripsPage SelectionList:focus {{ border: none; background-tint: {INK} 0%; }}
    TripsPage #shelf {{ max-height: 100%; }}
    TripsPage .hint {{ color: {FAINT}; }}
    TripsPage #send {{ height: auto; margin-bottom: 1; }}
    TripsPage #send-btn {{ margin-top: 1; }}
    TripsPage #list {{ width: 40; }}
    """
    BINDINGS = [
        Binding("n", "new", "New trip"),
        Binding("1", "tab('days')", "Days", show=False),
        Binding("2", "tab('places')", "Places", show=False),
        Binding("3", "tab('packing')", "Packing", show=False),
        Binding("a", "add", "Add"),
        Binding("x", "remove", "Take off"),
        Binding("b", "bringing", "Who's bringing", show=False),
        Binding("s", "send", "Packing to Drift"),
        Binding("m", "member", "Add someone"),
        Binding("M", "unmember", "Take someone off", show=False),
        Binding("e", "edit", "Edit"),
        Binding("d", "delete", "Delete / leave"),
        Binding("r", "refresh", "Refresh"),
        Binding("backslash", "fold", "Trips"),
    ]

    def __init__(self):
        super().__init__()
        self.data: dict | None = None
        self.trip: dict | None = None
        self.tab = "days"
        self.skip: set[str] = set()     # packing ids unticked for sending
        self.picked: set[str] = set()   # packing ids ticked that wouldn't be by default

    def compose(self) -> ComposeResult:
        yield from self.top()
        with Vertical(id="body"):
            yield Static("T R I P   P L A N N E R", classes="kicker")
            with Horizontal(id="main"):
                yield OptionList(id="shelf")
                with VerticalScroll(id="trip"):
                    yield Static(id="title")
                    yield Static(id="facts")
                    yield Static(id="people")
                    yield Static(id="notes")
                    yield Static(id="tabs")
                    with Vertical(id="days-tab"):
                        yield OptionList(id="stops")
                        yield Static(classes="hint", id="days-hint")
                    with Vertical(id="places-tab"):
                        yield OptionList(id="places")
                        yield Static(Text("a pins a place (searched for, or off your Drift map) · x unpins it", style=FAINT), classes="hint")
                    with Vertical(id="packing-tab"):
                        yield SelectionList(id="packing")
                        yield Static(classes="hint", id="packing-hint")
                        with Horizontal(id="send"):
                            yield Button("Send", id="send-btn")
                            yield Select([("Packing", "")], value="", allow_blank=False, id="list")
                        yield Static(id="no-drift")
        yield Footer()

    async def on_mount(self) -> None:
        await self.action_refresh()
        self.query_one("#shelf", OptionList).focus()

    # ── loading and showing ───────────────────────────────────────────────

    @attempt
    async def action_refresh(self) -> None:
        self.data = await self.fetch(site.trips)
        want = self.trip["id"] if self.trip else None
        if not any(t["id"] == want for t in self.data["trips"]):
            want = self.data["trips"][0]["id"] if self.data["trips"] else None
        self.trip = await self.fetch(site.trip, want) if want else None
        self.show_shelf()
        self.show_trip()

    @attempt
    async def open(self, trip_id: str) -> None:
        t = await self.fetch(site.trip, trip_id)
        if not self.trip or t["id"] != self.trip["id"]:
            self.skip.clear()
            self.picked.clear()
        self.trip = t
        self.show_trip()

    def took(self, t: dict) -> None:
        """After a change: the trip as the site has it now, and its line in the list."""
        self.trip = t
        for s in self.data["trips"]:
            if s["id"] == t["id"]:
                s.update(title=t["title"], start=t["start"], end=t["end"], people=len(t["members"]))
        self.show_shelf()
        self.show_trip()

    def show_shelf(self) -> None:
        shelf = self.query_one("#shelf", OptionList)
        with self.prevent(OptionList.OptionHighlighted):
            shelf.clear_options()
            trips = self.data["trips"]
            if not trips:
                shelf.add_option(Option(Text("No trips yet. Press n to start one.", style=FAINT), disabled=True))
                return
            for t in trips:
                when = span(t).split(" · ")[0]
                who = (f"{t['people']} going" if t["people"] > 1 else "") if t["owned"] else f"with {t['owner_name']}"
                sub = " · ".join(x for x in (when, who) if x)
                shelf.add_option(Option(Text.assemble((t["title"], f"bold {INK}"), ("\n" + sub, FAINT)), id=t["id"]))
            if self.trip:
                shelf.highlighted = next((i for i, t in enumerate(trips) if t["id"] == self.trip["id"]), 0)

    def name_of(self, user_id: str) -> str:
        return next((m["name"] for m in self.trip["members"] if m["id"] == user_id), "")

    def sendable(self, p: dict) -> bool:
        if p["id"] in self.picked:
            return True
        return p["id"] not in self.skip and not p["in_drift"] and (not p["who"] or p["who"] == self.trip["you"])

    def show_trip(self) -> None:
        t = self.trip
        for w in ("#facts", "#people", "#notes", "#tabs", "#days-tab", "#places-tab", "#packing-tab"):
            self.query_one(w).display = bool(t)
        if not t:
            self.query_one("#title", Static).update(Text("Your trips will show up here. Press n to start one: where you're going and when.", style=MUTED))
            return
        self.query_one("#title", Static).update(t["title"])
        self.query_one("#facts", Static).update(span(t))
        people = Text()
        for i, m in enumerate(t["members"]):
            if i:
                people.append("  ")
            people.append(f"[{m['name']}{' (you)' if m['id'] == t['you'] else ''}]", style=f"bold {GOLD}" if m["owner"] else INK)
        if t["owned"]:
            people.append("   m adds someone", style=FAINT)
        self.query_one("#people", Static).update(people)
        self.query_one("#notes", Static).update(Text(t.get("notes", ""), style=MUTED))
        self.query_one("#notes").display = bool(t.get("notes"))
        tabs = Text()
        counts = {"days": len(t["plans"]), "places": len(t["places"]), "packing": len(t["packing"])}
        for i, (key, label) in enumerate(TABS, 1):
            tabs.append(f" {i} {label.upper()} ({counts[key]}) ", style=f"bold {GOLD} reverse" if key == self.tab else MUTED)
            tabs.append("  ")
        self.query_one("#tabs", Static).update(tabs)
        for key, _ in TABS:
            self.query_one(f"#{key}-tab").display = key == self.tab
        self.show_days()
        self.show_places()
        self.show_packing()

    def show_days(self) -> None:
        t = self.trip
        box = self.query_one("#stops", OptionList)
        at = box.highlighted
        box.clear_options()
        days = list(t["days"])
        others = sorted({p["day"] for p in t["plans"] if p["day"] and p["day"] not in days})
        place_at = {p["id"]: i for i, p in enumerate(t["places"])}
        for d in days + others + [""]:
            stops = [p for p in t["plans"] if p["day"] == d]
            if d in others and not stops:
                continue
            n = days.index(d) if d in days else -1
            head = (f"DAY {n + 1} · " if n >= 0 else "") + nice_day(d).upper() + ("  (outside the trip)" if n < 0 else "") if d else "ANY DAY"
            box.add_option(Option(Text(head, style=f"bold {GOLD}"), id="day:" + d))
            for p in stops:
                line = Text.assemble(("  " + (p["time"] or "·").ljust(6), f"bold {GOLD}"), (p["title"], INK))
                if p["place"] in place_at:
                    i = place_at[p["place"]]
                    line.append(f"  📍 {i + 1}. {t['places'][i]['place']}", style=FAINT)
                box.add_option(Option(line, id=p["id"]))
            if not stops:
                box.add_option(Option(Text("  Nothing planned yet.", style=FAINT), disabled=True))
        if at is not None and box.option_count:
            box.highlighted = min(at, box.option_count - 1)
        self.query_one("#days-hint", Static).update(Text(
            ("" if t["start"] else "Give the trip dates (e) to plan it day by day. ") + "a adds a stop to the highlighted day · x takes one off", style=FAINT))

    def show_places(self) -> None:
        t = self.trip
        box = self.query_one("#places", OptionList)
        at = box.highlighted
        box.clear_options()
        for i, p in enumerate(t["places"]):
            line = Text.assemble((f"{i + 1}. ", f"bold {GOLD}"), (p["place"], INK))
            line.append(f"  {p['lat']:.4f}, {p['lng']:.4f}" if p["lat"] is not None else "  not on the map", style=FAINT)
            if p.get("note"):
                line.append(f"\n   {p['note']}", style=MUTED)
            box.add_option(Option(line, id=p["id"]))
        if not t["places"]:
            box.add_option(Option(Text("No places pinned yet.", style=FAINT), disabled=True))
        if at is not None and t["places"]:
            box.highlighted = min(at, len(t["places"]) - 1)

    def show_packing(self) -> None:
        t = self.trip
        box = self.query_one("#packing", SelectionList)
        at = box.highlighted
        with self.prevent(SelectionList.SelectedChanged):
            box.clear_options()
            for p in t["packing"]:
                line = Text(p["text"], style=INK)
                who = "me" if p["who"] == t["you"] else self.name_of(p["who"])
                line.append(f"  {who}" if who else "  anyone", style=FAINT)
                if p["in_drift"]:
                    line.append("  ✓ in your Drift", style=GOOD)
                box.add_option(Selection(line, p["id"], self.sendable(p)))
        if at is not None and t["packing"]:
            box.highlighted = min(at, len(t["packing"]) - 1)
        has = bool(t["packing"])
        box.display = has
        drift = self.data.get("drift")
        self.query_one("#packing-hint", Static).update(Text(
            "space ticks what to send · b who's bringing it · a adds · x takes off" if has else "Nothing on the list yet. a adds something.", style=FAINT))
        self.query_one("#send").display = has and drift
        self.query_one("#no-drift").display = has and not drift
        self.query_one("#no-drift", Static).update(Text("Ask the site's admin for Drift to send this to a checklist.", style=FAINT))
        if has and drift:
            self.show_send()

    def show_send(self) -> None:
        t = self.trip
        n = sum(1 for p in t["packing"] if self.sendable(p))
        btn = self.query_one("#send-btn", Button)
        btn.label = f"Send {n} to"
        btn.disabled = not n
        name = packing_name(t["title"])
        lists = self.data.get("lists", [])
        mine = next((x for x in lists if not x.get("owner_name") and x["name"].lower() == name.lower()), None)
        # The trip's own checklist, by a value of its own, so the label follows the trip it's for.
        default = DEFAULT + name + (" (new)" if not mine else "")
        options = [(name if mine else f"{name} (new)", default)]
        options += [(f"{x['name']} ({x['owner_name']}'s)" if x.get("owner_name") else x["name"], x["id"]) for x in lists if x is not mine]
        sel = self.query_one("#list", Select)
        keep = sel.value if isinstance(sel.value, str) and any(v == sel.value for _, v in options[1:]) else default
        with sel.prevent(Select.Changed):
            sel.set_options(options)
            sel.value = keep

    # ── moving around ─────────────────────────────────────────────────────

    async def on_option_list_option_highlighted(self, e: OptionList.OptionHighlighted) -> None:
        if e.option_list.id == "shelf" and e.option.id and (not self.trip or e.option.id != self.trip["id"]):
            await self.open(e.option.id)

    def on_option_list_option_selected(self, e: OptionList.OptionSelected) -> None:
        if e.option_list.id == "shelf" and self.trip:
            self.focus_tab()

    def focus_tab(self) -> None:
        w = {"days": "#stops", "places": "#places", "packing": "#packing"}[self.tab]
        self.query_one(w).focus()

    def action_tab(self, tab: str) -> None:
        if not self.trip:
            return
        self.tab = tab
        self.show_trip()
        self.focus_tab()

    def on_selection_list_selected_changed(self, e: SelectionList.SelectedChanged) -> None:
        if not self.trip:
            return
        on = set(e.selection_list.selected)
        t = self.trip
        self.skip.clear()
        self.picked.clear()
        for p in t["packing"]:
            wanted = not p["in_drift"] and (not p["who"] or p["who"] == t["you"])
            if (p["id"] in on) != wanted:
                (self.picked if p["id"] in on else self.skip).add(p["id"])
        if self.data.get("drift"):
            self.show_send()

    def check_action(self, action: str, parameters: tuple) -> bool | None:
        if isinstance(self.focused, (Input, TextArea)) and action not in ("back", "fold"):
            return False
        return True

    def highlighted(self, tab: str) -> str | None:
        """The id of the stop, place or packing line highlighted in that tab."""
        box = self.query_one({"days": "#stops", "places": "#places", "packing": "#packing"}[tab])
        if box.highlighted is None:
            return None
        if tab == "packing":
            return box.get_option_at_index(box.highlighted).value
        return box.get_option_at_index(box.highlighted).id

    # ── trips ─────────────────────────────────────────────────────────────

    def action_new(self) -> None:
        self.app.push_screen(TripDialog(None), self.after_trip(None))

    def action_edit(self) -> None:
        if self.trip:
            self.app.push_screen(TripDialog(self.trip), self.after_trip(self.trip))

    def after_trip(self, was: dict | None):
        async def done(fields: dict | None) -> None:
            if fields is not None:
                await self.save_trip(was, fields)
        return done

    @attempt
    async def save_trip(self, was: dict | None, fields: dict) -> None:
        t = await self.fetch(site.update_trip, was["id"], fields) if was else await self.fetch(site.add_trip, fields)
        self.data = await self.fetch(site.trips)
        if not was:
            self.tab = "days"
        self.app.notify(f"Saved {t['title']}.", timeout=2)
        self.took(t)

    def action_delete(self) -> None:
        t = self.trip
        if not t:
            return

        async def answer(yes: bool | None) -> None:
            if yes:
                await self.delete(t)
        if t["owned"]:
            self.app.push_screen(Confirm(f"Delete {t['title']}?", "It's gone for everyone on it; anything already sent to Drift stays there.",
                                         yes="Delete", danger=True), answer)
        else:
            self.app.push_screen(Confirm(f"Leave {t['title']}?", "You'll need to be added again to see it.", yes="Leave", danger=True), answer)

    @attempt
    async def delete(self, t: dict) -> None:
        await self.fetch(site.delete_trip, t["id"])
        self.data["trips"] = [x for x in self.data["trips"] if x["id"] != t["id"]]
        self.trip = None
        if self.data["trips"]:
            self.trip = await self.fetch(site.trip, self.data["trips"][0]["id"])
        self.show_shelf()
        self.show_trip()

    def action_member(self) -> None:
        t = self.trip
        if not t:
            return
        if not t["owned"]:
            self.app.notify("Only the person who made the trip can change who's on it.", severity="error", timeout=3)
            return

        async def answer(name: str | None) -> None:
            if name and name.strip():
                await self.change(site.add_traveller, t["id"], name.strip(), done="They're on the trip.")
        self.app.push_screen(Ask("Add someone to the trip", "They need Trip planner turned on.", placeholder="username", ok="Add"), answer)

    def action_unmember(self) -> None:
        t = self.trip
        if not t or not t["owned"]:
            return

        async def answer(name: str | None) -> None:
            who = next((m for m in t["members"] if not m["owner"] and m["username"] == (name or "").strip().lstrip("@").lower()), None)
            if name and not who:
                self.app.notify("No one by that username is on the trip.", severity="error", timeout=3)
            elif who:
                await self.change(site.remove_traveller, t["id"], who["id"])
        others = ", ".join(m["username"] for m in t["members"] if not m["owner"]) or "no one yet"
        self.app.push_screen(Ask("Take someone off the trip", f"Going: {others}", placeholder="username", ok="Take off"), answer)

    @attempt
    async def change(self, fn, *args, done: str = "") -> None:
        self.took(await self.fetch(fn, *args))
        if done:
            self.app.notify(done, timeout=2)

    # ── stops, places and packing ─────────────────────────────────────────

    def action_add(self) -> None:
        t = self.trip
        if not t:
            return
        if self.tab == "days":
            h = self.highlighted("days") or ""
            day = h[4:] if h.startswith("day:") else next((p["day"] for p in t["plans"] if p["id"] == h), t["days"][0] if t["days"] else "")

            async def stop(fields: dict | None) -> None:
                if fields:
                    await self.change(site.add_to_trip, t["id"], "plans", fields)
            self.app.push_screen(StopDialog(t, day), stop)
        elif self.tab == "places":
            async def place(fields: dict | None) -> None:
                if fields:
                    await self.change(site.add_to_trip, t["id"], "places", fields, done=f"Pinned {fields['place']}.")
            self.app.push_screen(PlaceDialog(bool(self.data.get("search")), bool(self.data.get("drift"))), place)
        else:
            async def thing(text: str | None) -> None:
                if text and text.strip():
                    await self.change(site.add_to_trip, t["id"], "packing", {"text": text.strip()})
            self.app.push_screen(Ask("Something to pack", ok="Add"), thing)

    async def action_remove(self) -> None:
        t, entry = self.trip, self.highlighted(self.tab) if self.trip else None
        if not t or not entry or entry.startswith("day:"):
            return
        await self.change(site.remove_from_trip, t["id"], KIND[self.tab], entry)

    async def action_bringing(self) -> None:
        """b on a packing line: the next person to bring it (anyone, then each of you in turn)."""
        t = self.trip
        if not t or self.tab != "packing":
            return
        entry = self.highlighted("packing")
        p = next((x for x in t["packing"] if x["id"] == entry), None)
        if not p:
            return
        order = [""] + [m["id"] for m in t["members"]]
        nxt = order[(order.index(p["who"]) + 1) % len(order)] if p["who"] in order else ""
        await self.change(site.change_in_trip, t["id"], "packing", p["id"], {"who": nxt})

    # ── packing to Drift ──────────────────────────────────────────────────

    async def on_button_pressed(self, e: Button.Pressed) -> None:
        if e.button.id == "send-btn":
            await self.action_send()

    @attempt
    async def action_send(self) -> None:
        t = self.trip
        if not t or not t["packing"] or not self.data.get("drift"):
            return
        if self.tab != "packing":
            self.action_tab("packing")
        ids = [p["id"] for p in t["packing"] if self.sendable(p)]
        if not ids:
            self.app.notify("Tick at least one thing to send.", severity="error", timeout=3)
            return
        to = self.query_one("#list", Select).value
        out = await self.fetch(lambda: site.pack(t["id"], ids, to if isinstance(to, str) and not to.startswith(DEFAULT) else None))
        self.skip.clear()
        self.picked.clear()
        if not any(x["id"] == out["list"]["id"] for x in self.data["lists"]):
            self.data["lists"].insert(0, {"id": out["list"]["id"], "name": out["list"]["name"], "owner_name": None})
        self.took(out["trip"])
        self.app.notify(f"Added {plural(out['added'], 'thing')} to {out['list']['name']} in Drift.", timeout=3)
