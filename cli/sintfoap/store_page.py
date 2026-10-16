"""
The plugin store in the terminal, like /plugins/: browse approved plugins and
add them to Drift, write your own and send them for review, and (for admins)
review what's waiting. Plugin code is only ever shown as text here; nothing
in the terminal runs it. "Try it" needs the browser's sandbox, so it's on w.
"""
from __future__ import annotations

import difflib
import json
import time

from rich.syntax import Syntax
from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Footer, Input, Label, OptionList, Static, TextArea
from textual.widgets.option_list import Option

from . import site
from .look import BAD, FAINT, GOLD, GOLD_DIM, GOOD, INK, LINE, MUTED, Ask, Confirm, Failed, Page, attempt, fetch

STATUS = {"draft": "Draft", "pending": "Waiting for review", "approved": "Approved", "rejected": "Rejected"}
STATUS_COLOUR = {"draft": MUTED, "pending": GOLD, "approved": GOOD, "rejected": BAD}
TABS = [("store", "Store"), ("mine", "My plugins"), ("review", "Review")]


def ago(t: int | None) -> str:
    if not t:
        return ""
    s = time.time() - t
    if s < 60:
        return "just now"
    if s < 3600:
        return f"{int(s // 60)} min ago"
    if s < 86400:
        return f"{int(s // 3600)} h ago"
    return time.strftime("%b %-d, %Y", time.localtime(t))


def badge(status: str) -> tuple[str, str]:
    return (f"[{STATUS[status]}]", STATUS_COLOUR[status])


def template(pid: str, name: str, description: str) -> str:
    """The same starting point as the store page: a small working plugin with no imports."""
    q = json.dumps
    return f"""// {name}: a Drift plugin.
// It keeps its data on each item under item.meta.{pid}.
export default {{
  id: {q(pid)},
  name: {q(name)},
  description: {q(description)},
  icon: '<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.8"/>',

  // Checks and tidies this plugin's data. Call fail("why") to refuse it.
  clean(value, fail) {{
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("{pid} must be an object");
    return {{ stars: Math.max(0, Math.min(5, Math.trunc(Number(value.stars) || 0))) }};
  }},

  // Data for a new item added while the plugin is on (or undefined for none).
  fresh: () => ({{ stars: 0 }}),

  // Shown under an item's title.
  chips: item => item.meta.{pid}.stars ? [`<span class="chip">${{"★".repeat(item.meta.{pid}.stars)}}</span>`] : [],

  // Inputs in the item dialog, and how to read them back.
  editor: item => `<label>Stars<input type="number" name="stars" min="0" max="5" value="${{item.meta.{pid}?.stars || 0}}"></label>`,
  read: fields => ({{ stars: Number(fields.stars) || 0 }}),
}};
"""


def code_view(code: str) -> Syntax:
    return Syntax(code or "", "javascript", theme="monokai", line_numbers=True, word_wrap=False, background_color="#0e140e")


def diff_text(live: str | None, code: str) -> Text:
    """The submitted code against the live version, with long unchanged stretches folded."""
    a, b = (live.split("\n") if live else []), code.split("\n")
    t = Text()
    for group in difflib.SequenceMatcher(None, a, b).get_grouped_opcodes(3):
        if t:
            t.append("  ⋯\n", style=FAINT)
        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                for line in a[i1:i2]:
                    t.append(f"  {line}\n", style=MUTED)
                continue
            for line in a[i1:i2]:
                t.append(f"- {line}\n", style=f"{BAD} on #2a1612")
            for line in b[j1:j2]:
                t.append(f"+ {line}\n", style=f"{GOOD} on #12241a")
    return t or Text("No changes from the live version.", style=MUTED)


# ── one store plugin ───────────────────────────────────────────────────────

class PluginPage(Page):
    WEB_PATH = "/plugins/"
    DEFAULT_CSS = """
    PluginPage #body { padding: 0 4 1 4; }
    """
    BINDINGS = [Binding("i", "install", "Add to / remove from Drift")]

    def __init__(self, store: "StorePage", p: dict):
        super().__init__()
        self.store, self.p = store, p

    def compose(self) -> ComposeResult:
        p = self.p
        yield from self.top()
        with VerticalScroll(id="body"):
            yield Static("P L U G I N   S T O R E", classes="kicker")
            yield Static(Text(p["name"], style=f"bold {INK}"), classes="h1")
            yield Static(Text.assemble((f"by {p.get('author') or 'a removed account'}", MUTED), (f"   v{p['version']}", MUTED),
                                       (f"   approved {ago(p.get('updated'))}", MUTED), ("   id ", MUTED), (p["id"], INK)), classes="sub")
            yield Static(Text(p.get("description") or "No description.", style=INK), classes="sub")
            yield Static(id="installed", classes="sub")
            yield Static(code_view(p.get("code", "")), classes="card")
        yield Footer()

    def on_mount(self) -> None:
        self.show()

    def show(self) -> None:
        on = self.p["id"] in self.store.installed
        self.query_one("#installed", Static).update(Text(
            "✓ In your Drift. Turn it on for a collection in that collection's settings (c in Drift). Press i to remove it." if on else
            "Press i to add it to Drift. It runs in a sandbox in the browser, with no access to the rest of the site.",
            style=GOOD if on else GOLD))

    @attempt
    async def action_install(self) -> None:
        on = self.p["id"] in self.store.installed
        self.store.installed = set(await self.fetch(site.uninstall if on else site.install, self.p["id"]))
        self.show()
        self.store.render_tab()
        self.app.notify("Removed from Drift." if on else "Added to Drift. Turn it on in a collection's settings.", timeout=3)


# ── your plugin ────────────────────────────────────────────────────────────

class EditorPage(Page):
    WEB_PATH = "/plugins/#workshop"
    DEFAULT_CSS = f"""
    EditorPage #body {{ padding: 0 4 0 4; height: 1fr; }}
    EditorPage .fields {{ height: auto; }}
    EditorPage .fields > Vertical {{ height: auto; width: 1fr; margin-right: 2; }}
    EditorPage #code {{ height: 1fr; min-height: 8; }}
    EditorPage #notes {{ height: auto; }}
    EditorPage .notice {{ border: round {GOLD_DIM}; padding: 0 1; height: auto; }}
    EditorPage .notice.bad {{ border: round {BAD}; }}
    EditorPage .notice.good {{ border: round {GOOD}; }}
    EditorPage #actions {{ height: auto; margin: 1 0; }}
    EditorPage #saved {{ width: 1fr; color: {GOLD_DIM}; content-align: right middle; }}
    """
    BINDINGS = [
        Binding("ctrl+s", "save", "Save draft", priority=True),
        Binding("ctrl+r", "submit", "Submit", priority=True),
    ]

    def __init__(self, store: "StorePage", p: dict):
        super().__init__()
        self.store, self.p, self.dirty = store, p, False

    def compose(self) -> ComposeResult:
        yield from self.top()
        with Vertical(id="body"):
            yield Static("M Y   P L U G I N S", classes="kicker")
            yield Vertical(id="notes")
            with Horizontal(classes="fields"):
                with Vertical():
                    yield Label("Name", classes="lbl")
                    yield Input(id="name", max_length=60)
                with Vertical():
                    yield Label("Description", classes="lbl")
                    yield Input(id="desc", max_length=300)
            yield Label("Code   (Try it runs in the browser's sandbox: press w there)", classes="lbl")
            code = TextArea.code_editor("", id="code", soft_wrap=False)
            try:
                code.language = "javascript"
            except Exception:
                pass                     # no syntax highlighting without tree-sitter; editing still works
            yield code
            with Horizontal(id="actions"):
                yield Button("Save draft", id="save")
                yield Button("Submit for review", id="submit", classes="quiet")
                yield Button("Withdraw", id="withdraw", classes="quiet")
                yield Button("Delete", id="delete", classes="danger")
                yield Static(id="saved")
        yield Footer()

    async def on_mount(self) -> None:
        await self.show(self.p)
        self.query_one("#code").focus()

    async def show(self, p: dict) -> None:
        self.p = p
        w, r = p["working"], p.get("lastReview")
        notes = self.query_one("#notes", Vertical)
        await notes.remove_children()
        out = []
        if p.get("pending"):
            more = ("You've changed it since; submit again to send the newer version instead." if w["status"] == "draft"
                    else "Saving a change starts a new draft and leaves the submitted version as it is.")
            out.append(Static(Text.assemble((f"Version {p['pending']['version']} is waiting for review. ", f"bold {GOLD}"), (more, MUTED)), classes="notice"))
        published = (p.get("published") or {}).get("version") or 0
        if r and r["status"] == "rejected" and r["version"] >= published and not p.get("pending"):
            out.append(Static(Text.assemble((f"Version {r['version']} was rejected. ", f"bold {BAD}"), (r.get("note") or "", INK)), classes="notice bad"))
        if r and r["status"] == "approved" and r["version"] == published and w["status"] != "draft":
            out.append(Static(Text.assemble((f"Version {r['version']} is live in the store. ", f"bold {GOOD}"), (r.get("note") or "", INK)), classes="notice good"))
        if out:
            await notes.mount_all(out)
        self.query_one("#name", Input).value = w["name"]
        self.query_one("#desc", Input).value = w["description"]
        self.query_one("#code", TextArea).load_text(w["code"])
        self.query_one("#withdraw").display = bool(p.get("pending"))
        self.set_dirty(False)

    def set_dirty(self, dirty: bool) -> None:
        self.dirty = dirty
        w = self.p["working"]
        self.query_one("#saved", Static).update(
            "Unsaved changes" if dirty else f"v{w['version']} · {STATUS[w['status']]} · id {self.p['id']}")
        self.query_one("#submit", Button).disabled = dirty or w["status"] != "draft"

    def on_input_changed(self, e: Input.Changed) -> None:
        if e.input.id in ("name", "desc") and e.value != self.p["working"]["name" if e.input.id == "name" else "description"]:
            self.set_dirty(True)

    def on_text_area_changed(self, e: TextArea.Changed) -> None:
        if e.text_area.text != self.p["working"]["code"]:
            self.set_dirty(True)

    async def on_button_pressed(self, e: Button.Pressed) -> None:
        if e.button.id == "save":
            await self.action_save()
        elif e.button.id == "submit":
            self.action_submit()
        elif e.button.id == "withdraw":
            await self.withdraw()
        elif e.button.id == "delete":
            w = self.p["working"]
            more = "It comes out of the store too. " if self.p.get("published") else ""
            self.app.push_screen(Confirm(f"Delete {w['name']}?", more + "This can't be undone.", yes="Delete", danger=True), self.delete)

    @attempt
    async def action_save(self) -> None:
        p = await self.fetch(site.save_plugin, self.p["id"], {
            "name": self.query_one("#name", Input).value, "description": self.query_one("#desc", Input).value,
            "code": self.query_one("#code", TextArea).text})
        self.store.replace(p)
        await self.show(p)
        self.app.notify("Saved.", timeout=2)

    def action_submit(self) -> None:
        if self.dirty:
            self.app.notify("Save your changes first (ctrl+s).", severity="warning")
            return
        if self.p["working"]["status"] != "draft":
            self.app.notify("There's no draft to submit. Change something and save it first.", severity="warning")
            return
        self.app.push_screen(Ask("Submit for review", "Anything the reviewer should know? (optional)", ok="Submit"), self.submit)

    @attempt
    async def submit(self, note: str | None) -> None:
        if note is None:
            return
        p = await self.fetch(site.submit_plugin, self.p["id"], note)
        self.store.replace(p)
        await self.show(p)
        self.app.notify("Sent for review.", timeout=3)

    @attempt
    async def withdraw(self) -> None:
        p = await self.fetch(site.withdraw_plugin, self.p["id"])
        self.store.replace(p)
        await self.show(p)
        self.app.notify("Taken out of review.", timeout=3)

    @attempt
    async def delete(self, yes: bool | None) -> None:
        if not yes:
            return
        await self.fetch(site.delete_plugin, self.p["id"])
        self.store.removed(self.p["id"])
        self.app.notify("Deleted.", timeout=2)
        self.app.pop_screen()

    def leave_field(self) -> bool:
        return False

    def action_back(self) -> None:
        if self.dirty:
            self.app.push_screen(Confirm("Leave without saving your changes?", yes="Leave", danger=True),
                                 lambda yes: yes and self.app.pop_screen())
            return
        self.app.pop_screen()


class NewPlugin(ModalScreen[dict | None]):
    BINDINGS = [Binding("escape", "cancel", "Cancel")]

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Label(Text("New plugin", style=f"bold {INK}"))
            yield Label("Id", classes="lbl")
            yield Input(id="id", max_length=30, placeholder="e.g. stars")
            yield Static(Text("2 to 30 lowercase letters. It's where the plugin keeps its data on each item, and can't change later.", style=FAINT))
            yield Label("Name", classes="lbl")
            yield Input(id="name", max_length=60, placeholder="e.g. Stars")
            yield Label("Description", classes="lbl")
            yield Input(id="description", max_length=300, placeholder="What it adds to Drift")
            with Horizontal(classes="buttons"):
                yield Button("Create", id="ok")
                yield Button("Cancel", id="cancel", classes="quiet")

    def values(self) -> dict:
        return {k: self.query_one(f"#{k}", Input).value.strip() for k in ("id", "name", "description")}

    def on_input_submitted(self, e: Input.Submitted) -> None:
        if e.input.id == "description":
            self.dismiss(self.values())
        else:
            self.focus_next()

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.dismiss(self.values() if e.button.id == "ok" else None)

    def action_cancel(self) -> None:
        self.dismiss(None)


# ── review ─────────────────────────────────────────────────────────────────

class ReviewPage(Page):
    WEB_PATH = "/plugins/#review"
    DEFAULT_CSS = """
    ReviewPage #body { padding: 0 4 1 4; }
    ReviewPage #note { margin-top: 1; }
    ReviewPage .buttons { height: auto; margin-top: 1; }
    """
    def __init__(self, store: "StorePage", s: dict):
        super().__init__()
        self.store, self.s = store, s

    def compose(self) -> ComposeResult:
        s = self.s
        yield from self.top()
        with VerticalScroll(id="body"):
            yield Static("R E V I E W", classes="kicker")
            yield Static(Text(s["name"], style=f"bold {INK}"), classes="h1")
            yield Static(Text.assemble((s.get("author") or "a removed account", MUTED), (f"   submitted {ago(s.get('submitted_at'))}", MUTED),
                                       ("   id ", MUTED), (s["id"], INK), (f"   v{s['version']}", MUTED),
                                       ("   Update" if s.get("live_code") is not None else "   New plugin", GOLD)), classes="sub")
            yield Static(Text(s.get("description") or "No description.", style=INK), classes="sub")
            if s.get("note"):
                yield Static(Text("“" + s["note"] + "”", style=f"italic {MUTED}"), classes="sub")
            yield Static(Text("Compared with the live version" if s.get("live_code") is not None else "Every line is new", style=GOLD_DIM))
            yield Static(diff_text(s.get("live_code"), s["code"]), classes="card")
            yield Input(id="note", max_length=1000, placeholder="Note to the author. Needed when rejecting: say what to change.")
            with Horizontal(classes="buttons"):
                yield Button("Approve", id="approve")
                yield Button("Reject", id="reject", classes="danger")
        yield Footer()

    async def on_button_pressed(self, e: Button.Pressed) -> None:
        await self.action_decide(e.button.id)

    @attempt
    async def action_decide(self, decision: str) -> None:
        note = self.query_one("#note", Input).value.strip()
        if decision == "reject" and not note:
            self.app.notify("Say why it's rejected, so the author can fix it.", severity="warning")
            self.query_one("#note").focus()
            return
        await self.fetch(site.review, self.s["id"], self.s["version"], decision, note)
        self.app.notify(f"{self.s['name']} is live." if decision == "approve" else f"{self.s['name']} was sent back.", timeout=3)
        self.app.pop_screen()
        await self.store.action_refresh()

    def leave_field(self) -> bool:
        return False


# ── the store ──────────────────────────────────────────────────────────────

class StoreList(OptionList):
    BINDINGS = [
        Binding("j", "cursor_down", "Down", show=False),
        Binding("k", "cursor_up", "Up", show=False),
        Binding("slash", "screen.search", "Search"),
        Binding("i", "screen.install", "Add / remove", show=False),
    ]


class StorePage(Page):
    WEB_PATH = "/plugins/"
    DEFAULT_CSS = f"""
    StorePage #body {{ padding: 0 4 0 4; height: 1fr; }}
    StorePage #tabs {{ height: auto; margin-bottom: 1; }}
    StorePage #search {{ display: none; }}
    StorePage #search.on {{ display: block; }}
    StorePage #list {{ height: 1fr; }}
    StorePage #list > .option-list--option {{ padding: 0 1; }}
    StorePage #list:focus > .option-list--option-highlighted {{ border-left: outer {GOLD}; }}
    StorePage .sep {{ color: {LINE}; }}
    """
    BINDINGS = [
        Binding("1", "tab('store')", "Store"),
        Binding("2", "tab('mine')", "My plugins"),
        Binding("3", "tab('review')", "Review", show=False),
        Binding("n", "new", "New plugin"),
        Binding("r", "refresh", "Refresh"),
    ]

    def __init__(self):
        super().__init__()
        self.state: dict = {"user": {}, "store": [], "mine": [], "waiting": 0}
        self.queue: list[dict] = []
        self.installed: set[str] = set()
        self.tab = "store"
        self.q = ""

    def compose(self) -> ComposeResult:
        yield from self.top()
        with Vertical(id="body"):
            yield Static("P L U G I N   S T O R E", classes="kicker")
            yield Static(Text("Plugins add new kinds of data and new views to Drift. Write one, send it for review, and once it's approved anyone can find it here.", style=MUTED), classes="sub")
            yield Static(id="tabs")
            yield Input(id="search", placeholder="Search plugins (esc to clear)")
            yield StoreList(id="list")
        yield Footer()

    async def on_mount(self) -> None:
        await self.action_refresh()
        self.query_one("#list").focus()

    @attempt
    async def action_refresh(self) -> None:
        self.state = await self.fetch(site.store_state)
        self.installed = set(await self.fetch(site.installed))
        self.queue = await self.fetch(site.review_queue) if self.state["user"].get("reviewer") else []
        self.render_tab()

    def action_tab(self, name: str) -> None:
        if name == "review" and not self.state["user"].get("reviewer"):
            return
        self.tab = name
        self.render_tab(keep=None)
        self.query_one("#list").focus()

    def render_tab(self, keep: str | None = "") -> None:
        lst = self.query_one("#list", StoreList)
        if keep == "":
            keep = lst.highlighted_option.id if lst.highlighted_option else None
        tabs = Text()
        for n, (key, label) in enumerate(TABS, 1):
            if key == "review" and not self.state["user"].get("reviewer"):
                continue
            label += f" {len(self.queue)}" if key == "review" and self.queue else ""
            tabs.append(f" {n} {label} ", style=f"bold #1a1206 on {GOLD}" if key == self.tab else MUTED)
            tabs.append("  ")
        if self.tab == "mine":
            tabs.append("n new plugin", style=FAINT)
        self.query_one("#tabs", Static).update(tabs)
        self.query_one("#search").set_class(self.tab == "store" and bool(self.q or self.query_one("#search").has_focus), "on")

        opts: list = []
        sep = Option(Text("─" * 40, style=LINE), disabled=True)
        if self.tab == "store":
            q = self.q.lower()
            shown = [p for p in self.state["store"] if not q or q in f"{p['name']} {p['description']} {p.get('author')} {p['id']}".lower()]
            for p in shown:
                t = Text.assemble((p["name"], f"bold {INK}"), ("   ✓ In your Drift" if p["id"] in self.installed else "", GOOD), "\n",
                                  (p.get("description") or "No description.", MUTED), "\n",
                                  (f"by {p.get('author') or 'a removed account'} · v{p['version']} · {ago(p.get('updated'))}", GOLD_DIM))
                opts += [Option(t, id=p["id"]), sep]
            if not shown:
                opts.append(Option(Text.assemble(("No plugins match" if q else "No plugins yet", f"bold {INK}"), "\n",
                                                 ("Try a different search." if q else "Write the first one under My plugins (2).", MUTED)), disabled=True))
        elif self.tab == "mine":
            for p in self.state["mine"]:
                status = "pending" if p.get("pending") else p["working"]["status"]
                label, colour = badge(status)
                t = Text.assemble((p["working"]["name"], f"bold {INK}"), "   ", (label, colour),
                                  (f"   live v{p['published']['version']}" if p.get("published") else "", GOOD), "\n",
                                  (p["working"].get("description") or "No description.", MUTED), "\n", (f"id {p['id']}", GOLD_DIM))
                opts += [Option(t, id=p["id"]), sep]
            if not self.state["mine"]:
                opts.append(Option(Text.assemble(("Make a plugin", f"bold {INK}"), "\n",
                                                 ("Press n to start one. You'll get a small working example to change.", MUTED)), disabled=True))
        else:
            for s in self.queue:
                t = Text.assemble((s["name"], f"bold {INK}"), ("   Update" if s.get("live_code") is not None else "   New plugin", GOLD), "\n",
                                  (s.get("description") or "No description.", MUTED), "\n",
                                  (f"{s.get('author') or 'a removed account'} · submitted {ago(s.get('submitted_at'))} · v{s['version']}", GOLD_DIM))
                opts += [Option(t, id=f"{s['id']}/{s['version']}"), sep]
            if not self.queue:
                opts.append(Option(Text.assemble(("Nothing to review", f"bold {INK}"), "\n", ("Submitted plugins show up here.", MUTED)), disabled=True))
        with self.prevent(OptionList.OptionHighlighted):
            lst.set_options(opts)
            ids = [o.id for o in opts]
            if keep and keep in ids:
                lst.highlighted = ids.index(keep)
            elif any(ids):
                lst.highlighted = next(i for i, x in enumerate(ids) if x)

    # ── moving around ──────────────────────────────────────────────────
    def action_search(self) -> None:
        if self.tab != "store":
            return
        s = self.query_one("#search", Input)
        s.set_class(True, "on")
        s.focus()

    def on_input_changed(self, e: Input.Changed) -> None:
        if e.input.id == "search":
            self.q = e.value.strip()
            self.render_tab()

    def on_input_submitted(self, e: Input.Submitted) -> None:
        self.query_one("#list").focus()

    def leave_field(self) -> bool:
        s = self.query_one("#search", Input)
        s.value, self.q = "", ""
        self.render_tab()
        self.query_one("#list").focus()
        return True

    @attempt
    async def on_option_list_option_selected(self, e: OptionList.OptionSelected) -> None:
        oid = e.option.id
        if not oid:
            return
        if self.tab == "store":
            self.app.push_screen(PluginPage(self, await self.fetch(site.store_plugin, oid)))
        elif self.tab == "mine":
            p = next(x for x in self.state["mine"] if x["id"] == oid)
            self.app.push_screen(EditorPage(self, p))
        else:
            s = next(x for x in self.queue if f"{x['id']}/{x['version']}" == oid)
            self.app.push_screen(ReviewPage(self, s))

    @attempt
    async def action_install(self) -> None:
        o = self.query_one("#list", StoreList).highlighted_option
        if self.tab != "store" or not o or not o.id:
            return
        on = o.id in self.installed
        self.installed = set(await self.fetch(site.uninstall if on else site.install, o.id))
        self.render_tab()
        self.app.notify("Removed from Drift." if on else "Added to Drift. Turn it on in a collection's settings.", timeout=3)

    def action_new(self) -> None:
        self.app.push_screen(NewPlugin(), self.create)

    async def create(self, f: dict | None) -> None:
        if not f:
            return
        try:
            p = await fetch(self.app, site.new_plugin, {**f, "code": template(f["id"], f["name"], f["description"])})
        except Failed:
            return
        self.replace(p)
        self.tab = "mine"
        self.render_tab(keep=p["id"])
        self.app.push_screen(EditorPage(self, p))

    # ── kept in step with the editor ───────────────────────────────────
    def replace(self, p: dict) -> None:
        mine = self.state["mine"]
        for n, x in enumerate(mine):
            if x["id"] == p["id"]:
                mine[n] = p
                break
        else:
            mine.append(p)
        self.render_tab()

    def removed(self, pid: str) -> None:
        self.state["mine"] = [x for x in self.state["mine"] if x["id"] != pid]
        self.state["store"] = [x for x in self.state["store"] if x["id"] != pid]
        self.render_tab()

    async def on_screen_resume(self) -> None:
        # A submit or an approval changes the queue and the store.
        if self.state["user"]:
            await self.action_refresh()
