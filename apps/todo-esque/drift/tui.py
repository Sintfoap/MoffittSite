"""Drift terminal UI (Textual). Talks to the Store directly; no server needed."""
from __future__ import annotations

import functools
from datetime import date

from rich.text import Text
from textual import on
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Footer, Input, Label, OptionList, Static, TextArea
from textual.widgets.option_list import Option

from .core import Store, Task, bucket, parse_date
from .site import SiteError

# palette — warm dusk
BG, PANEL, LINE = "#16161e", "#1c1c26", "#2a2a38"
FG, MUTED, FAINT = "#e6e1d8", "#8b8799", "#55536a"
ACCENT = "#f2a65a"       # amber
RED, AMB, BLU, GRN, VIO = "#ef6f6c", "#f2c14e", "#7aa2f7", "#9ece6a", "#bb9af7"
PRI = {3: RED, 2: AMB, 1: BLU}

VIEWS = [("today", "◉", "Today"), ("upcoming", "◷", "Upcoming"),
         ("inbox", "▢", "Inbox"), ("all", "≡", "All open"), ("done", "✓", "Done")]
BUCKET_LABEL = {"overdue": "Overdue", "today": "Today", "upcoming": "Upcoming",
                "someday": "No date", "done": "Completed"}


def guarded(fn):
    """When the list is on the website, a failed save shows a message instead of crashing."""
    @functools.wraps(fn)
    def wrapper(self, *a, **k):
        try:
            return fn(self, *a, **k)
        except SiteError as e:
            self.notify(str(e), severity="error", timeout=6)
    return wrapper


def nice_due(d: str | None) -> str:
    if not d:
        return ""
    try:
        dd = date.fromisoformat(d)
    except ValueError:
        return d
    n = (dd - date.today()).days
    if n == 0:
        return "today"
    if n == 1:
        return "tomorrow"
    if n == -1:
        return "yesterday"
    if 1 < n < 7:
        return dd.strftime("%a")
    if n < 0:
        return f"{-n}d late"
    return dd.strftime("%b %-d")


def task_row(t: Task) -> Text:
    b = bucket(t)
    row = Text(no_wrap=True, overflow="ellipsis")
    row.append("▌" if t.priority else " ", style=PRI.get(t.priority, FAINT))
    if t.done:
        row.append(" ✓  ", style=f"bold {GRN}")
        row.append(t.title, style=f"{FAINT} strike")
    else:
        row.append(" ○  ", style=MUTED)
        row.append(t.title, style=FG)
    meta = []
    if t.due:
        col = {"overdue": RED, "today": ACCENT}.get(b, MUTED)
        meta.append((f"  ◷ {nice_due(t.due)}", col))
    if t.project:
        meta.append((f"  +{t.project}", VIO))
    for g in t.tags:
        meta.append((f"  #{g}", BLU if not t.done else FAINT))
    if t.notes:
        meta.append(("  ¶", FAINT))
    for s, st in meta:
        row.append(s, style=st if not t.done else FAINT)
    return row


class EditScreen(ModalScreen[dict | None]):
    BINDINGS = [Binding("escape", "cancel", "Cancel"),
                Binding("ctrl+s", "save", "Save", priority=True)]

    def __init__(self, task: Task):
        super().__init__()
        self.t = task

    def compose(self) -> ComposeResult:
        t = self.t
        with Vertical(id="edit"):
            yield Label("Edit task", id="edit-title")
            yield Label("Title", classes="lbl")
            yield Input(t.title, id="f-title")
            with Horizontal(classes="row"):
                with Vertical():
                    yield Label("Due  (today, fri, +3d, 2026-11-02)", classes="lbl")
                    yield Input(t.due or "", id="f-due")
                with Vertical():
                    yield Label("Priority  (0–3)", classes="lbl")
                    yield Input(str(t.priority), id="f-pri")
            with Horizontal(classes="row"):
                with Vertical():
                    yield Label("Project", classes="lbl")
                    yield Input(t.project, id="f-proj")
                with Vertical():
                    yield Label("Tags", classes="lbl")
                    yield Input(" ".join(t.tags), id="f-tags")
            yield Label("Notes", classes="lbl")
            yield TextArea(t.notes, id="f-notes")
            yield Static(Text.assemble(("ctrl+s", ACCENT), (" save   ", MUTED),
                                       ("esc", ACCENT), (" cancel", MUTED)), id="edit-help")

    def action_cancel(self):
        self.dismiss(None)

    def action_save(self):
        q = lambda i: self.query_one(i, Input).value  # noqa: E731
        due_raw = q("#f-due").strip()
        try:
            pri = int(q("#f-pri") or 0)
        except ValueError:
            pri = self.t.priority
        self.dismiss({
            "title": q("#f-title") or self.t.title,
            "due": parse_date(due_raw) if due_raw else None,
            "priority": pri,
            "project": q("#f-proj"),
            "tags": q("#f-tags"),
            "notes": self.query_one("#f-notes", TextArea).text,
        })

    @on(Input.Submitted)
    def _submit(self):
        self.action_save()


class DriftApp(App):
    TITLE = "drift"
    CSS = f"""
    Screen {{ background: {BG}; color: {FG}; }}
    #top {{ height: 3; padding: 1 2 0 2; background: {BG}; }}
    #brand {{ width: auto; }}
    #status {{ width: 1fr; content-align: right middle; text-align: right; }}
    #body {{ height: 1fr; }}
    #side {{ width: 26; background: {PANEL}; border-right: tall {LINE}; padding: 1 0; }}
    #side > .option-list--option {{ padding: 0 2; }}
    OptionList {{ background: transparent; border: none; scrollbar-size: 1 1;
                  scrollbar-color: {LINE}; scrollbar-background: transparent; }}
    OptionList:focus {{ border: none; }}
    OptionList > .option-list--option-highlighted {{ background: {LINE}; }}
    OptionList:focus > .option-list--option-highlighted {{ background: #34324a; }}
    OptionList > .option-list--option-disabled {{ color: {FAINT}; }}
    OptionList > .option-list--separator {{ color: {LINE}; }}
    #main {{ padding: 1 2 0 2; }}
    #viewtitle {{ height: 2; }}
    #add {{ border: round {LINE}; background: {PANEL}; margin-bottom: 1; padding: 0 1; }}
    #add:focus {{ border: round {ACCENT}; }}
    #search {{ display: none; border: round {LINE}; background: {PANEL}; margin-bottom: 1; }}
    #search.on {{ display: block; }}
    #search:focus {{ border: round {BLU}; }}
    #tasks {{ height: 1fr; }}
    #empty {{ display: none; color: {FAINT}; padding: 2 4; }}
    #empty.on {{ display: block; }}
    Footer {{ background: {PANEL}; }}
    Footer > .footer--key {{ background: {LINE}; color: {ACCENT}; }}
    EditScreen {{ align: center middle; background: rgba(10,10,16,0.7); }}
    #edit {{ width: 76; height: auto; max-height: 90%; background: {PANEL};
             border: round {ACCENT}; padding: 1 2; }}
    #edit-title {{ color: {ACCENT}; text-style: bold; margin-bottom: 1; }}
    #edit .lbl {{ color: {MUTED}; margin-top: 1; }}
    #edit Input {{ background: {BG}; border: tall {LINE}; }}
    #edit Input:focus {{ border: tall {ACCENT}; }}
    #edit .row {{ height: auto; }}
    #edit .row > Vertical {{ height: auto; margin-right: 1; }}
    #f-notes {{ height: 5; background: {BG}; border: tall {LINE}; }}
    #edit-help {{ margin-top: 1; }}
    """
    BINDINGS = [
        Binding("a", "focus_add", "Add"),
        Binding("space", "toggle", "Done"),
        Binding("e", "edit", "Edit"),
        Binding("enter", "edit", "Edit", show=False),
        Binding("d", "delete", "Delete"),
        Binding("u", "undo", "Undo"),
        Binding("t", "due_today", "→Today"),
        Binding("slash", "search", "Search"),
        Binding("tab", "swap", "Pane", show=False, priority=True),
        Binding("j", "cursor(1)", show=False),
        Binding("k", "cursor(-1)", show=False),
        Binding("escape", "escape", show=False),
        Binding("q", "quit", "Quit"),
    ]

    def __init__(self, store: Store):
        super().__init__()
        self.store = store
        self.view = "today"
        self.query_text = ""
        self.undo_stack: list[str] = []

    # ── layout ─────────────────────────────────────────────────────────
    def compose(self) -> ComposeResult:
        with Horizontal(id="top"):
            yield Static(id="brand")
            yield Static(id="status")
        with Horizontal(id="body"):
            yield OptionList(id="side")
            with Vertical(id="main"):
                yield Static(id="viewtitle")
                yield Input(placeholder="＋ Add a task…   #tag  +project  !1-3  ^fri",
                            id="add")
                yield Input(placeholder="⌕ filter…", id="search")
                yield OptionList(id="tasks")
                yield Static("Nothing here. Press  a  to add something.", id="empty")
        yield Footer()

    def on_mount(self):
        self.query_one("#brand", Static).update(
            Text.assemble(("◆ ", ACCENT), ("drift", f"bold {FG}"),
                          ("  decentralized tasks", FAINT)))
        import threading
        main = threading.get_ident()

        def changed():
            if threading.get_ident() == main:
                self.call_later(self.reload)      # our own write
            else:
                self.call_from_thread(self.reload)  # another device / process
        self.store.subscribe(changed)
        self.store.watch()
        self.reload()
        self.query_one("#tasks").focus()

    # ── data → widgets ─────────────────────────────────────────────────
    def visible(self) -> list[Task]:
        ts = self.store.tasks()
        v = self.view
        if v == "today":
            ts = [t for t in ts if bucket(t) in ("overdue", "today")]
        elif v == "upcoming":
            ts = [t for t in ts if bucket(t) == "upcoming"]
        elif v == "inbox":
            ts = [t for t in ts if not t.done and not t.project]
        elif v == "all":
            ts = [t for t in ts if not t.done]
        elif v == "done":
            ts = sorted([t for t in ts if t.done],
                        key=lambda t: t.completed_at or "", reverse=True)
        elif v.startswith("p:"):
            ts = [t for t in ts if t.project == v[2:]]
        elif v.startswith("#:"):
            ts = [t for t in ts if v[2:] in t.tags]
        if self.query_text:
            q = self.query_text.lower()
            ts = [t for t in ts if q in t.title.lower() or q in t.notes.lower()
                  or any(q in g for g in t.tags) or q in t.project.lower()]
        return ts

    def reload(self):
        all_tasks = self.store.tasks()
        side = self.query_one("#side", OptionList)
        hi = side.highlighted
        side.clear_options()
        counts = {
            "today": sum(bucket(t) in ("overdue", "today") for t in all_tasks),
            "upcoming": sum(bucket(t) == "upcoming" for t in all_tasks),
            "inbox": sum(not t.done and not t.project for t in all_tasks),
            "all": sum(not t.done for t in all_tasks),
            "done": sum(t.done for t in all_tasks),
        }
        overdue = sum(bucket(t) == "overdue" for t in all_tasks)
        for key, icon, name in VIEWS:
            n = counts[key]
            line = Text.assemble((f"{icon} ", ACCENT if key == self.view else MUTED),
                                 (f"{name:<14}", FG))
            line.append(f"{n:>3}" if n else "", style=RED if key == "today" and overdue else FAINT)
            side.add_option(Option(line, id=key))
        projects, tags = self.store.projects(), self.store.tags()
        if projects:
            side.add_option(None)
            side.add_option(Option(Text("PROJECTS", style=f"bold {FAINT}"), disabled=True))
            for p in projects:
                n = sum(t.project == p and not t.done for t in all_tasks)
                side.add_option(Option(Text.assemble(("+ ", VIO), (f"{p[:15]:<15}", FG),
                                                     (f"{n:>3}" if n else "", FAINT)), id=f"p:{p}"))
        if tags:
            side.add_option(None)
            side.add_option(Option(Text("TAGS", style=f"bold {FAINT}"), disabled=True))
            for g in tags:
                side.add_option(Option(Text.assemble(("# ", BLU), (g, FG)), id=f"#:{g}"))
        if hi is not None and hi < side.option_count:
            side.highlighted = hi

        # main list
        tl = self.query_one("#tasks", OptionList)
        prev = self.current_id()
        prev_idx = tl.highlighted
        tl.clear_options()
        ts = self.visible()
        group = None
        grouped = self.view in ("all", "today", "inbox") or self.view[:2] in ("p:", "#:")
        new_hi = None
        for t in ts:
            b = bucket(t)
            if grouped and b != group:
                if group is not None:
                    tl.add_option(Option(Text(""), disabled=True))
                tl.add_option(Option(Text(f"  {BUCKET_LABEL[b].upper()}",
                                          style=f"bold {RED if b == 'overdue' else FAINT}"),
                                     disabled=True))
                group = b
            tl.add_option(Option(task_row(t), id=t.id))
            if t.id == prev:
                new_hi = tl.option_count - 1
        if new_hi is not None:
            tl.highlighted = new_hi
        elif ts:
            # keep roughly the same position after an item disappears
            idx = min(prev_idx or 0, tl.option_count - 1)
            while idx < tl.option_count and tl.get_option_at_index(idx).disabled:
                idx += 1
            if idx >= tl.option_count:
                idx = max(i for i in range(tl.option_count)
                          if not tl.get_option_at_index(i).disabled)
            tl.highlighted = idx
        self.query_one("#empty").set_class(not ts, "on")
        tl.display = bool(ts)

        # headers
        name = dict((k, n) for k, _, n in VIEWS).get(self.view) or (
            ("+" if self.view[0] == "p" else "#") + self.view[2:])
        sub = date.today().strftime("%A, %B %-d") if self.view == "today" else \
            f"{len(ts)} task{'s' * (len(ts) != 1)}"
        self.query_one("#viewtitle", Static).update(
            Text.assemble((name, f"bold {FG}"), ("   " + sub, MUTED)))
        s = self.store.stats()
        if "site" in s:     # signed in to the website (drift/site.py)
            err = getattr(self.store, "error", None)
            self.query_one("#status", Static).update(Text.assemble(
                ("● ", RED if err else GRN), (f"{s['user']}", MUTED), (f"   {s['site']}", FAINT),
                (f"   {'offline' if err else str(s['open']) + ' open'}", RED if err else FAINT)))
            return
        self.query_one("#status", Static).update(Text.assemble(
            ("● ", GRN), (f"{s['node']}", MUTED), (f"   {len(s['nodes'])} node", FAINT),
            ("s" if len(s["nodes"]) != 1 else "", FAINT),
            (f"   {s['open']} open", FAINT)))

    def current_id(self) -> str | None:
        tl = self.query_one("#tasks", OptionList)
        if tl.highlighted is None or tl.option_count == 0:
            return None
        opt = tl.get_option_at_index(tl.highlighted)
        return opt.id if opt.id and opt.id.startswith("t_") else None

    # ── events ─────────────────────────────────────────────────────────
    @on(OptionList.OptionHighlighted, "#side")
    def _side_hi(self, ev: OptionList.OptionHighlighted):
        if ev.option.id and ev.option.id != self.view:
            self.view = ev.option.id
            self.reload()

    @on(OptionList.OptionSelected, "#side")
    def _side_sel(self, ev):
        self.query_one("#tasks").focus()

    @on(OptionList.OptionSelected, "#tasks")
    def _task_sel(self, ev):
        self.action_edit()

    @on(Input.Submitted, "#add")
    @guarded
    def _add(self, ev: Input.Submitted):
        text = ev.value.strip()
        if not text:
            self.query_one("#tasks").focus()
            return
        t = self.store.quick_add(text)
        # adding inside a project view files it there
        if self.view.startswith("p:") and not t.project:
            self.store.update(t.id, project=self.view[2:])
        elif self.view.startswith("#:") and self.view[2:] not in t.tags:
            self.store.update(t.id, tags=t.tags + [self.view[2:]])
        elif self.view == "today" and not t.due:
            self.store.update(t.id, due=date.today().isoformat())
        ev.input.value = ""
        self.notify(f"Added  {t.title}", timeout=2)

    @on(Input.Changed, "#search")
    def _search(self, ev: Input.Changed):
        self.query_text = ev.value
        self.reload()

    @on(Input.Submitted, "#search")
    def _search_done(self, ev):
        self.query_one("#tasks").focus()

    @guarded
    def on_key(self, ev):
        if isinstance(self.focused, Input) or isinstance(self.screen, EditScreen):
            return
        if ev.character in ("0", "1", "2", "3") and (tid := self.current_id()):
            self.store.update(tid, priority=int(ev.character))
            ev.stop()

    # ── actions ────────────────────────────────────────────────────────
    def _typing(self) -> bool:
        return isinstance(self.focused, (Input, TextArea))

    def action_noop(self):
        pass

    def action_focus_add(self):
        self.query_one("#add").focus()

    @guarded
    def action_toggle(self):
        if self._typing():
            return
        if tid := self.current_id():
            t = self.store.toggle(tid)
            if t.done:
                self.notify(f"✓  {t.title}", timeout=2)

    @guarded
    def action_edit(self):
        if self._typing() or not (tid := self.current_id()):
            return
        t = self.store.get(tid)

        @guarded
        def done(_self, changes):
            if changes:
                cur = self.store.get(tid)
                diff = {k: v for k, v in changes.items()
                        if getattr(cur, k) != (v if k != "tags" else
                                               sorted(set(v.lower().replace("#", "").split())))}
                if diff:
                    self.store.update(tid, **diff)
        self.push_screen(EditScreen(t), functools.partial(done, self))

    @guarded
    def action_delete(self):
        if self._typing() or not (tid := self.current_id()):
            return
        t = self.store.get(tid)
        self.store.delete(tid)
        self.undo_stack.append(tid)
        self.notify(f"Deleted  {t.title}  —  press u to undo", timeout=4)

    @guarded
    def action_undo(self):
        if self._typing() or not self.undo_stack:
            return
        self.store.update(self.undo_stack.pop(), deleted=False)

    @guarded
    def action_due_today(self):
        if self._typing() or not (tid := self.current_id()):
            return
        self.store.update(tid, due=date.today().isoformat())

    def action_search(self):
        s = self.query_one("#search", Input)
        s.add_class("on")
        s.focus()

    def action_escape(self):
        s = self.query_one("#search", Input)
        if s.has_class("on"):
            s.value = ""
            s.remove_class("on")
        self.query_one("#tasks").focus()

    def action_swap(self):
        if isinstance(self.screen, EditScreen) or self._typing():
            self.screen.focus_next()
            return
        side, tasks = self.query_one("#side"), self.query_one("#tasks")
        (tasks if self.focused is side else side).focus()

    def action_cursor(self, delta: int):
        if self._typing():
            return
        ol = self.focused if isinstance(self.focused, OptionList) else self.query_one("#tasks")
        (ol.action_cursor_down if delta > 0 else ol.action_cursor_up)()

    def check_action(self, action, parameters):
        # let single-letter keys type into inputs
        if action in ("focus_add", "toggle", "edit", "delete", "undo", "due_today",
                      "search", "cursor", "quit") and self._typing():
            return False
        return True


def run(store: Store):
    DriftApp(store).run()
