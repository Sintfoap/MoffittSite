"""The full reaction picker for chat in the terminal, like the web page's
"+" (public/chat/emoji-picker.js): every emoji the site takes, from
/chat/api/emoji. Before you type, the list offers the quick reactions and
Unicode's groups; picking a group lists its emoji. Typing searches them by
name. Enter reacts with the highlighted emoji (or takes it back, if you had
it), esc goes back and then closes.
"""
from __future__ import annotations

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import ModalScreen
from textual.widgets import Input, Label, ListItem, ListView, Static

from .look import FAINT, GOLD, INK, LINE, MUTED, PANEL

MAX_FOUND = 200     # search results listed at once


class EmojiList:
    """The site's emoji ({quick, groups: [{name, emoji: [[emoji, name]]}], aliases}), for looking things up."""

    def __init__(self, data: dict):
        self.quick: list[str] = data.get("quick") or []
        self.groups: list[tuple[str, list[tuple[str, str]]]] = [(g["name"], [tuple(e) for e in g["emoji"]]) for g in data.get("groups") or []]
        self.names: dict[str, str] = {e: n for _, es in self.groups for e, n in es}
        aliases = data.get("aliases") or {}
        self.words = {e: f"{n} {aliases.get(e, '')}".lower() for e, n in self.names.items()}

    def search(self, q: str) -> list[tuple[str, str]]:
        words = q.lower().split()
        return [(e, n) for e, n in self.names.items() if all(w in self.words[e] for w in words)]

    def find(self, name: str) -> str | None:
        """An emoji by itself, or by name: "pizza", "red_heart", "thinking" (the first whose name starts so)."""
        if name in self.names:
            return name
        q = name.lower().replace("_", " ").strip()
        if not q:
            return None
        for test in (lambda w: w == q, lambda w: w.startswith(q), lambda w: q in w):
            hit = next((e for e, n in self.names.items() if test(n.lower())), None)
            if hit:
                return hit
        return None


class Row(ListItem):
    def __init__(self, kind: str, data=None, label: Text | None = None):
        self.kind, self.data = kind, data
        super().__init__(Label(label or Text()))


class EmojiInput(Input):
    BINDINGS = [Binding("down", "into_list", "Emoji", show=False)]

    def action_into_list(self) -> None:
        lv = self.screen.query_one("#emoji-list", ListView)
        if lv.children:
            lv.focus()


class EmojiPicker(ModalScreen[str | None]):
    DEFAULT_CSS = f"""
    EmojiPicker .dialog {{ height: 30; }}
    EmojiPicker #emoji-list {{ height: 1fr; background: {PANEL}; border: round {LINE}; margin-top: 1; }}
    EmojiPicker #emoji-list:focus {{ border: round {GOLD}; }}
    EmojiPicker #emoji-list > ListItem {{ background: {PANEL}; padding: 0 1; }}
    EmojiPicker #emoji-list > ListItem.-highlight {{ background: #1d2a1b; }}
    EmojiPicker #emoji-note {{ height: 1; color: {FAINT}; }}
    """
    BINDINGS = [Binding("escape", "back", "Back")]

    def __init__(self, emoji: EmojiList, have: list[str] | None = None, to: str = ""):
        super().__init__()
        self.emoji, self.have, self.to = emoji, set(have or ()), to
        self.view: dict = {"kind": "home"}

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Label(Text("React" + (f" to {self.to}" if self.to else ""), style=f"bold {INK}"), id="emoji-title")
            yield EmojiInput(placeholder="Search emoji", id="emoji-q")
            yield ListView(id="emoji-list")
            yield Static(Text("enter react (again takes it back) · esc back"), id="emoji-note")

    async def on_mount(self) -> None:
        self.query_one("#emoji-q", Input).focus()
        await self.go({"kind": "home"})

    def label(self, e: str, name: str) -> Text:
        t = Text(f"{e}  ", style=INK)
        t.append(name, style=f"bold {GOLD}" if e in self.have else MUTED)
        if e in self.have:
            t.append("  ✓ yours", style=GOLD)
        return t

    async def go(self, view: dict) -> None:
        self.view = view
        lv = self.query_one("#emoji-list", ListView)
        await lv.clear()
        kind = view["kind"]
        if kind == "home":
            rows = [Row("emoji", e, self.label(e, self.emoji.names.get(e, ""))) for e in self.emoji.quick]
            rows += [Row("group", name, Text.assemble((f"{es[0][0]}  ", INK), (name, f"bold {INK}"), (f"  {len(es)}", FAINT)))
                     for name, es in self.emoji.groups]
            title = "React" + (f" to {self.to}" if self.to else "")
        elif kind == "group":
            es = next(es for name, es in self.emoji.groups if name == view["name"])
            rows = [Row("emoji", e, self.label(e, n)) for e, n in es]
            title = view["name"]
        else:
            found = self.emoji.search(view["q"])
            rows = [Row("emoji", e, self.label(e, n)) for e, n in found[:MAX_FOUND]]
            if not found:
                rows = [Row("none", label=Text("No emoji match that. Try another word.", style=MUTED))]
            elif len(found) > MAX_FOUND:
                rows.append(Row("none", label=Text(f"…and {len(found) - MAX_FOUND} more: add a word to narrow it", style=FAINT)))
            title = f"{len(found)} found"
        self.query_one("#emoji-title", Label).update(Text(title, style=f"bold {INK}"))
        await lv.extend(rows)
        lv.index = 0

    async def on_input_changed(self, event: Input.Changed) -> None:
        q = event.value.strip()
        await self.go({"kind": "search", "q": q} if q else {"kind": "home"})

    def on_input_submitted(self, event: Input.Submitted) -> None:
        lv = self.query_one("#emoji-list", ListView)
        first = next((c for c in lv.children if isinstance(c, Row) and c.kind == "emoji"), None)
        if first:
            self.dismiss(first.data)

    async def on_list_view_selected(self, event: ListView.Selected) -> None:
        row = event.item
        if not isinstance(row, Row):
            return
        if row.kind == "emoji":
            self.dismiss(row.data)
        elif row.kind == "group":
            await self.go({"kind": "group", "name": row.data})

    async def action_back(self) -> None:
        if self.view["kind"] == "group":
            box = self.query_one("#emoji-q", Input)
            await self.go({"kind": "search", "q": box.value.strip()} if box.value.strip() else {"kind": "home"})
            box.focus()
        else:
            self.dismiss(None)
