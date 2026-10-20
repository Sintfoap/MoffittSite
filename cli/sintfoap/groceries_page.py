"""Grocery autopilot in the terminal: the same order as /groceries/.

What the order is made from down the left: the Drift list (l picks another)
and your recipes (space picks one, + and - change its servings). On the right,
the order itself, added up: space leaves a line out, h says you always have it
(n puts one back). m matches each line to a product at your Kroger store,
c changes one, [ and ] change how many, and k sends them to your Kroger cart.
i makes an Instacart list instead and opens it, and b searches Walmart for a
line, since Walmart has no way to fill a cart. z picks your Kroger store,
C connects your Kroger account in the browser and D disconnects it."""
from __future__ import annotations

import time

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Footer, Label, OptionList, SelectionList, Static
from textual.widgets.option_list import Option
from textual.widgets.selection_list import Selection

from . import site
from .look import BAD, FAINT, GOLD, GOOD, INK, MUTED, Ask, Confirm, Page, attempt, open_in_browser, plural


def money(n) -> str:
    return f"${n:.2f}" if n else ""


def stamp(t: int | None) -> str:
    return time.strftime("%b %-d, %-I:%M %p", time.localtime(t)) if t else ""


def product_text(p: dict) -> str:
    return " · ".join(x for x in (p["description"], p.get("size"), money(p.get("price"))) if x)


class Pick(ModalScreen[int | None]):
    """One of a list of choices. Dismisses with its index, or None."""
    BINDINGS = [Binding("escape", "cancel", "Cancel")]

    def __init__(self, title: str, hint: str, choices: list[Text | str]):
        super().__init__()
        self.title_, self.hint, self.choices = title, hint, choices

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Label(Text(self.title_, style=f"bold {INK}"))
            if self.hint:
                yield Static(Text(self.hint, style=MUTED))
            yield OptionList(*[Option(c) for c in self.choices], id="choices")
            yield Static(Text("enter picks, esc cancels", style=FAINT))

    def on_mount(self) -> None:
        self.query_one("#choices", OptionList).focus()

    def on_option_list_option_selected(self, e: OptionList.OptionSelected) -> None:
        self.dismiss(e.option_index)

    def action_cancel(self) -> None:
        self.dismiss(None)


class GroceriesPage(Page):
    WEB_PATH = "/groceries/"
    SIDE = "#side"
    DEFAULT_CSS = f"""
    GroceriesPage #body {{ padding: 0 2 0 2; height: 1fr; }}
    GroceriesPage #status {{ color: {GOLD}; height: auto; margin-bottom: 1; }}
    GroceriesPage #main {{ height: 1fr; }}
    GroceriesPage #side {{ width: 38; height: 1fr; border-right: solid {GOLD}; margin-right: 2; padding-right: 1; }}
    GroceriesPage #right {{ width: 1fr; height: 1fr; }}
    GroceriesPage .group {{ color: {FAINT}; }}
    GroceriesPage SelectionList {{ height: auto; background: {INK} 0%; border: none; padding: 0; margin-bottom: 1; }}
    GroceriesPage SelectionList:focus {{ border: none; background-tint: {INK} 0%; }}
    GroceriesPage #recipes {{ max-height: 14; }}
    GroceriesPage #lines {{ max-height: 18; }}
    GroceriesPage #list, GroceriesPage #pantry, GroceriesPage #detail, GroceriesPage #stores, GroceriesPage #orders {{ height: auto; margin-bottom: 1; }}
    """
    BINDINGS = [
        Binding("l", "list", "Drift list"),
        Binding("plus,equals_sign", "servings(1)", "Servings +", show=False),
        Binding("minus", "servings(-1)", "Servings -", show=False),
        Binding("h", "have", "Always have"),
        Binding("n", "need", "Need it", show=False),
        Binding("m", "match", "Match"),
        Binding("c", "change", "Change product", show=False),
        Binding("right_square_bracket", "qty(1)", "More", show=False),
        Binding("left_square_bracket", "qty(-1)", "Fewer", show=False),
        Binding("k", "kroger", "To Kroger"),
        Binding("i", "instacart", "Instacart list"),
        Binding("b", "walmart", "Walmart search", show=False),
        Binding("z", "store", "Kroger store", show=False),
        Binding("C", "connect", "Connect Kroger", show=False),
        Binding("D", "disconnect", "Disconnect Kroger", show=False),
        Binding("t", "tick", "Tick off Drift", show=False),
        Binding("r", "refresh", "Refresh"),
    ]

    def __init__(self):
        super().__init__()
        self.data: dict | None = None
        self.skip: set[str] = set()
        self.qty: dict[str, int] = {}
        self.matches: dict[str, dict] = {}
        self.check_off = True

    def compose(self) -> ComposeResult:
        yield from self.top()
        with Vertical(id="body"):
            yield Static("G R O C E R Y   A U T O P I L O T", classes="kicker")
            yield Static(Text("Your next grocery order", style=f"bold {INK}"), classes="h1")
            yield Static(Text("Made from your Drift list and the recipes you pick, added up and sent to a store.", style=MUTED), classes="sub")
            yield Static(id="status")
            with Horizontal(id="main"):
                with VerticalScroll(id="side"):
                    yield Static("MADE FROM", classes="group")
                    yield Static(id="list")
                    yield Static("RECIPES", classes="group")
                    yield SelectionList(id="recipes")
                    yield Static("ALWAYS IN THE CUPBOARD", classes="group")
                    yield Static(id="pantry")
                with VerticalScroll(id="right"):
                    yield Static("THE ORDER", classes="group", id="lines-title")
                    yield SelectionList(id="lines")
                    yield Static(id="detail")
                    yield Static("SEND IT", classes="group")
                    yield Static(id="stores")
                    yield Static("PAST ORDERS", classes="group", id="orders-title")
                    yield Static(id="orders")
        yield Footer()

    async def on_mount(self) -> None:
        super().on_mount()
        await self.action_refresh()
        self.query_one("#lines" if self.data and self.data["lines"] else "#recipes").focus()

    @attempt
    async def action_refresh(self) -> None:
        self.show(await self.fetch(site.groceries_state))

    # ── what's where ───────────────────────────────────────────────────────

    def product(self, line: dict) -> dict | None:
        m = self.matches.get(line["key"])
        return m["match"] if m else line.get("match")

    def sending(self) -> list[dict]:
        return [l for l in self.data["lines"] if l["key"] not in self.skip] if self.data else []

    def line_at(self) -> dict | None:
        lines = self.query_one("#lines", SelectionList)
        i = lines.highlighted
        return self.data["lines"][i] if self.data and i is not None and 0 <= i < len(self.data["lines"]) else None

    def recipe_at(self) -> dict | None:
        rs = self.query_one("#recipes", SelectionList)
        i = rs.highlighted
        return self.data["recipes"][i] if self.data and i is not None and 0 <= i < len(self.data["recipes"]) else None

    def status(self, text: str) -> None:
        self.query_one("#status", Static).update(text)

    # ── drawing ────────────────────────────────────────────────────────────

    def show(self, data: dict) -> None:
        self.data = data
        keys = {l["key"] for l in data["lines"]}
        self.skip &= keys

        lst = Text()
        if not data["drift"]:
            lst.append("Turn on Drift to shop from a list.", style=FAINT)
        else:
            lst.append("Drift list: ", style=MUTED)
            lst.append(data["list"]["name"] if data["list"] else "none", style=INK if data["list"] else FAINT)
            lst.append("  (l to change)", style=FAINT)
        self.query_one("#list", Static).update(lst)

        picked = {r["id"]: r for r in data["plan"]["recipes"]}
        rs = self.query_one("#recipes", SelectionList)
        at = rs.highlighted
        with rs.prevent(SelectionList.SelectedChanged):
            rs.clear_options()
            for r in data["recipes"]:
                on = r["id"] in picked
                serves = (picked[r["id"]].get("servings") if on else None) or r.get("servings")
                label = Text(r["title"], style=INK)
                if serves:
                    label.append(f"  serves {serves:g}", style=GOLD if on else FAINT)
                rs.add_option(Selection(label, r["id"], on))
        if data["recipes"]:
            rs.highlighted = min(at or 0, len(data["recipes"]) - 1)
        rs.display = bool(data["recipes"])

        have = Text()
        for l in data["have"]:
            have.append(f"{l['name']}\n", style=MUTED)
        have.append("h leaves the highlighted line out · n puts one back" if data["have"] else "Nothing yet: h on a line leaves it out of every order.", style=FAINT)
        self.query_one("#pantry", Static).update(have)

        lines = self.query_one("#lines", SelectionList)
        at = lines.highlighted
        with lines.prevent(SelectionList.SelectedChanged):
            lines.clear_options()
            for l in data["lines"]:
                t = Text(f"{l['amount']:<10}" if l["amount"] else " " * 10, style=GOLD)
                t.append(l["name"], style=INK)
                p = self.product(l)
                if p and data["kroger"]["store"]:
                    t.append(f"  → {p['description']}" + (f" ×{self.qty[l['key']]}" if self.qty.get(l["key"], 1) > 1 else ""), style=GOOD)
                elif l["key"] in self.matches:
                    t.append("  → nothing found", style=BAD)
                lines.add_option(Selection(t, l["key"], l["key"] not in self.skip))
        n, sent = len(data["lines"]), len(self.sending())
        self.query_one("#lines-title", Static).update(f"THE ORDER ({n if sent == n else f'{sent} of {n}'})" if n else "THE ORDER")
        if n:
            lines.highlighted = min(at or 0, n - 1)
        lines.display = bool(n)
        self.show_detail()
        self.show_stores()

        orders = Text()
        for o in data["orders"][:8]:
            orders.append("Kroger" + (f", {o['place']}" if o.get("place") else "") if o["store"] == "kroger" else "Instacart", style=INK)
            orders.append(f" · {plural(len(o['lines']), 'thing')} · {stamp(o['created_at'])}\n", style=FAINT)
        self.query_one("#orders", Static).update(orders or Text("Nothing sent yet.", style=FAINT))

    def show_detail(self) -> None:
        d = self.query_one("#detail", Static)
        l = self.line_at()
        if not l:
            d.update(Text("Nothing to buy: everything's ticked off or in the cupboard." if self.data and (self.data["list"] or self.data["plan"]["recipes"])
                          else "Pick a Drift list or some recipes on the left to make an order.", style=FAINT))
            return
        t = Text(l["name"], style=f"bold {INK}")
        if l["amount"]:
            t.append(f"  {l['amount']}", style=GOLD)
        t.append("\nFrom " + ", ".join(l["from"]), style=FAINT)
        p = self.product(l)
        if p:
            t.append(f"\nKroger: {product_text(p)}", style=GOOD)
            t.append(f"  ×{self.qty.get(l['key'], 1)}  ([ ] how many, c changes it)", style=FAINT)
        elif self.data["kroger"]["store"]:
            t.append("\nNot matched at Kroger yet: m matches the order, c searches for this one", style=FAINT)
        t.append(f"\nWalmart: {l['walmart']}  (b opens it)", style=FAINT)
        d.update(t)

    def show_stores(self) -> None:
        k, t = self.data["kroger"], Text()
        t.append("Kroger  ", style=f"bold {GOLD}")
        if not k["ready"]:
            t.append("not set up on this site yet (the admin adds the KROGER_ secrets)", style=FAINT)
        elif not k["connected"]:
            t.append("not connected: C connects your Kroger account in the browser", style=FAINT)
        elif not k["store"]:
            t.append("connected; z picks your store", style=MUTED)
        else:
            ready = len([l for l in self.sending() if self.product(l)])
            t.append(f"{k['store']['name']} · {'pickup' if k['modality'] == 'PICKUP' else 'delivery'}", style=INK)
            t.append(f"  m matches, k sends {ready} to your cart" if ready else "  m matches the order to products there", style=FAINT)
        t.append("\nInstacart  ", style=f"bold {GOLD}")
        t.append("i makes a shopping list and opens it" if self.data["instacart"]["ready"] else "not set up on this site yet (the admin adds INSTACART_API_KEY)",
                 style=FAINT if not self.data["instacart"]["ready"] else MUTED)
        t.append("\nWalmart  ", style=f"bold {GOLD}")
        t.append("has no way for apps to fill a cart; b searches walmart.com for a line", style=FAINT)
        t.append(f"\n{'Ticks' if self.check_off else 'Leaves'} the Drift items {'off ' if self.check_off else ''}once they're sent (t)", style=FAINT)
        self.query_one("#stores", Static).update(t)

    def on_selection_list_selection_highlighted(self, e: SelectionList.SelectionHighlighted) -> None:
        if e.selection_list.id == "lines":
            self.show_detail()

    @attempt
    async def on_selection_list_selection_toggled(self, e: SelectionList.SelectionToggled) -> None:
        if e.selection_list.id == "lines":
            key = e.selection.value
            self.skip.discard(key) if key in e.selection_list.selected else self.skip.add(key)
            self.show(self.data)
            return
        on = set(e.selection_list.selected)
        old = {r["id"]: r for r in self.data["plan"]["recipes"]}
        recipes = [old.get(r["id"], {"id": r["id"], "servings": None}) for r in self.data["recipes"] if r["id"] in on]
        try:
            self.show(await self.fetch(lambda: site.groceries_plan(recipes=recipes)))
        except Exception:
            self.show(self.data)
            raise

    # ── what's on it ───────────────────────────────────────────────────────

    def action_list(self) -> None:
        if not self.data or not self.data["drift"]:
            return
        lists = self.data["lists"]

        async def done(i: int | None) -> None:
            if i is None:
                return
            pick = None if i == 0 else lists[i - 1]["id"]
            await attempt(lambda page: page._plan(list=pick))(self)
        names = ["No list"] + [f"{c['name']} ({c['owner_name']})" if c.get("owner_name") else c["name"] for c in lists]
        self.app.push_screen(Pick("Shop from which Drift list?", "Its unticked items go on the order.", names), done)

    async def _plan(self, **changes) -> None:
        self.show(await self.fetch(lambda: site.groceries_plan(**changes)))

    @attempt
    async def action_servings(self, step: int) -> None:
        r = self.recipe_at()
        picked = {x["id"]: x for x in self.data["plan"]["recipes"]} if self.data else {}
        if not r or r["id"] not in picked:
            return
        now = picked[r["id"]].get("servings") or r.get("servings") or 1
        new = max(1, now + step)
        await self._plan(recipes=[{**x, "servings": new} if x["id"] == r["id"] else x for x in self.data["plan"]["recipes"]])
        self.status(f"{r['title']}: serves {new:g}.")

    @attempt
    async def action_have(self) -> None:
        l = self.line_at()
        if l:
            self.show(await self.fetch(site.groceries_pantry, l["name"], True))
            self.status(f"{l['name']} is left out from now on.")

    def action_need(self) -> None:
        if not self.data or not self.data["have"]:
            return
        have = self.data["have"]

        async def done(i: int | None) -> None:
            if i is None:
                return

            async def back(page: "GroceriesPage") -> None:
                page.show(await page.fetch(site.groceries_pantry, have[i]["name"], False))
                page.status(f"{have[i]['name']} is back on the order.")
            await attempt(back)(self)
        self.app.push_screen(Pick("Put which back on the order?", "", [l["name"] for l in have]), done)

    # ── Kroger ─────────────────────────────────────────────────────────────

    @attempt
    async def action_match(self) -> None:
        if not self.data or not self.data["kroger"]["store"]:
            return
        self.status("Finding each line at your Kroger store…")
        try:
            self.matches = await self.fetch(site.kroger_match)
        except Exception:
            self.status("")
            raise
        self.show(self.data)
        n = sum(1 for m in self.matches.values() if m["match"])
        self.status(f"Matched {n} of {len(self.data['lines'])}. c changes one, k sends them to your cart.")

    def action_change(self) -> None:
        l = self.line_at()
        if not l or not self.data["kroger"]["store"]:
            return

        async def searched(q: str | None) -> None:
            q = (q or "").strip()
            if not q:
                return

            async def go(page: "GroceriesPage") -> None:
                choices = await page.fetch(site.kroger_search, q)
                if not choices:
                    page.app.notify(f"Nothing at your Kroger store for “{q}”.", timeout=3)
                    return

                async def picked(i: int | None) -> None:
                    if i is None:
                        return

                    async def save(p: "GroceriesPage") -> None:
                        await p.fetch(site.grocery_match, l["key"], choices[i])
                        p.matches[l["key"]] = {"match": choices[i], "choices": choices, "remembered": True}
                        p.show(p.data)
                        p.status(f"{l['name']} will be {choices[i]['description']} from now on.")
                    await attempt(save)(page)
                page.app.push_screen(Pick(f"Which for {l['name']}?", "", [product_text(c) for c in choices]), picked)
            await attempt(go)(self)
        self.app.push_screen(Ask(f"Search Kroger for {l['name']}", "", value=l["name"], ok="Search"), searched)

    def action_qty(self, step: int) -> None:
        l = self.line_at()
        if not l or not self.product(l):
            return
        self.qty[l["key"]] = max(1, min(50, self.qty.get(l["key"], 1) + step))
        self.show(self.data)

    @attempt
    async def action_kroger(self) -> None:
        if not self.data or not self.data["kroger"]["store"]:
            return
        lines = [{"key": l["key"], "product": self.product(l), "quantity": self.qty.get(l["key"], 1)} for l in self.sending() if self.product(l)]
        if not lines:
            self.app.notify("Nothing's matched yet: press m first.", timeout=3)
            return
        self.status("Sending to your Kroger cart…")
        try:
            out = await self.fetch(site.kroger_cart, lines, self.check_off)
        except Exception:
            self.status("")
            raise
        self.matches, self.qty = {}, {}
        self.skip.clear()
        self.show(out["state"])
        self.status(f"Put {plural(out['added'], 'thing')} in your Kroger cart" + (f", and ticked {out['checked']} off in Drift" if out["checked"] else "")
                    + ". Check out in Kroger's app.")

    def action_store(self) -> None:
        if not self.data or not self.data["kroger"]["connected"]:
            return

        async def zipped(z: str | None) -> None:
            z = (z or "").strip()
            if not z:
                return

            async def go(page: "GroceriesPage") -> None:
                found = await page.fetch(site.kroger_stores, z)
                if not found:
                    page.app.notify("No Kroger stores near there.", timeout=3)
                    return

                async def picked(i: int | None) -> None:
                    if i is not None:
                        async def save(p: "GroceriesPage") -> None:
                            p.matches = {}
                            p.show(await p.fetch(site.kroger_store, found[i]["id"]))
                            p.status(f"Shopping at {found[i]['name']}.")
                        await attempt(save)(page)
                page.app.push_screen(Pick("Which store?", "", [Text(f"{s['name']}  ", style=INK) + Text(s["address"], style=FAINT) for s in found]), picked)
            await attempt(go)(self)
        self.app.push_screen(Ask("Your Kroger store", "Your ZIP code, to find the stores near you.", placeholder="45202", ok="Find"), zipped)

    def action_connect(self) -> None:
        if self.data and self.data["kroger"]["ready"]:
            open_in_browser(self.app, site.site_url("/groceries/kroger/connect"))
            self.status("Sign in to Kroger in your browser, then press r here.")

    def action_disconnect(self) -> None:
        if not self.data or not self.data["kroger"]["connected"]:
            return

        async def done(yes: bool) -> None:
            if yes:
                async def go(page: "GroceriesPage") -> None:
                    page.matches = {}
                    page.show(await page.fetch(site.kroger_disconnect))
                    page.status("Kroger is disconnected. The products you picked are kept.")
                await attempt(go)(self)
        self.app.push_screen(Confirm("Disconnect Kroger?", "The products you've picked are kept for when you connect again.", yes="Disconnect", danger=True), done)

    # ── the others ─────────────────────────────────────────────────────────

    @attempt
    async def action_instacart(self) -> None:
        if not self.data or not self.data["instacart"]["ready"] or not self.sending():
            return
        self.status("Making your Instacart list…")
        try:
            out = await self.fetch(site.groceries_instacart, sorted(self.skip), self.check_off)
        except Exception:
            self.status("")
            raise
        self.skip.clear()
        self.show(out["state"])
        open_in_browser(self.app, out["url"])
        self.status("Your Instacart list is ready" + (f", and ticked {out['checked']} off in Drift" if out["checked"] else "") + f": {out['url']}")

    def action_walmart(self) -> None:
        l = self.line_at()
        if l:
            open_in_browser(self.app, l["walmart"])

    def action_tick(self) -> None:
        self.check_off = not self.check_off
        if self.data:
            self.show_stores()
