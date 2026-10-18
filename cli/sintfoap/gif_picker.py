"""The GIF picker for chat in the terminal, like the web page's (which is
after Discord's): a search line over a list. Before you type, the list offers
your favorites, what's trending and the categories; picking one lists its
GIFs. Enter sends the highlighted GIF, ctrl+s stars it (favorites are kept on
the site, so the web page has them too), esc goes back and then closes.

A terminal can't play a GIF, so they're listed by name; what's sent is the
GIF's link, which the web page shows as the picture (src/gifs.js).
"""
from __future__ import annotations

from urllib.parse import urlparse

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import ModalScreen
from textual.widgets import Input, Label, ListItem, ListView, Static

from . import site
from .look import FAINT, GOLD, GOLD_DIM, INK, LINE, MUTED, PANEL, Failed, fetch

SEARCH_WAIT = 0.35      # seconds after the last keypress before searching


def is_gif(body: str, hosts: list[str]) -> bool:
    """A message whose whole text is a GIF link from the GIF hosts (as the web page decides)."""
    body = (body or "").strip()
    if not body or not hosts or any(c.isspace() for c in body):
        return False
    try:
        u = urlparse(body)
        port = u.port
    except ValueError:
        return False
    host = (u.hostname or "").lower()
    return (u.scheme == "https" and port is None and not u.username
            and any(host == h or host.endswith("." + h) for h in hosts)
            and u.path.lower().endswith((".gif", ".webp")))


class Row(ListItem):
    """One line of the picker: a GIF, a place to go (favorites, trending, a category), or "more"."""

    def __init__(self, kind: str, data: dict | None = None, label: Text | None = None):
        self.kind, self.data = kind, data or {}
        super().__init__(Label(label or Text()))

    def relabel(self, label: Text) -> None:
        self.query_one(Label).update(label)


class GifInput(Input):
    BINDINGS = [Binding("down", "into_list", "GIFs", show=False)]

    def action_into_list(self) -> None:
        lv = self.screen.query_one("#gif-list", ListView)
        if lv.children:
            lv.focus()


class GifPicker(ModalScreen[dict | None]):
    DEFAULT_CSS = f"""
    GifPicker .dialog {{ height: 30; }}
    GifPicker #gif-list {{ height: 1fr; background: {PANEL}; border: round {LINE}; margin-top: 1; }}
    GifPicker #gif-list:focus {{ border: round {GOLD}; }}
    GifPicker #gif-list > ListItem {{ background: {PANEL}; padding: 0 1; }}
    GifPicker #gif-list > ListItem.-highlight {{ background: #1d2a1b; }}
    GifPicker #gif-note {{ height: 1; color: {FAINT}; }}
    """
    BINDINGS = [
        Binding("escape", "back", "Back"),
        Binding("ctrl+s", "star", "Favorite"),
    ]

    def __init__(self, api=site, query: str = "", provider: str = "GIFs"):
        super().__init__()
        self.api, self.query_text, self.provider = api, query, provider
        self.view: dict = {"kind": "home"}
        self.favorites: list[dict] = []
        self.categories: list[dict] | None = None
        self.next: str | None = None
        self._timer = None
        self._token = 0

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Label(Text("GIFs", style=f"bold {INK}"), id="gif-title")
            yield GifInput(placeholder=f"Search {self.provider}", id="gif-q")
            yield ListView(id="gif-list")
            yield Static(Text(f"enter send · ctrl+s favorite · esc back · powered by {self.provider}"), id="gif-note")

    async def on_mount(self) -> None:
        box = self.query_one("#gif-q", Input)
        box.focus()
        await self.load_favorites()
        if self.query_text:
            box.value = self.query_text      # starts the search (on_input_changed)
        else:
            await self.go({"kind": "home"})

    # ── talking to the site ────────────────────────────────────────────
    async def call(self, fn, *args):
        try:
            return await fetch(self.app, lambda: fn(*args))
        except Failed:
            return None

    async def load_favorites(self) -> None:
        r = await self.call(self.api.chat_gif_favorites)
        if r is not None:
            self.favorites = r.get("favorites") or []

    def starred(self, url: str) -> bool:
        return any(f["url"] == url for f in self.favorites)

    # ── views ──────────────────────────────────────────────────────────
    def label(self, g: dict) -> Text:
        t = Text("★ " if self.starred(g["url"]) else "  ", style=GOLD)
        t.append(g.get("title") or "GIF", style=INK)
        if g.get("width") and g.get("height"):
            t.append(f"  {g['width']}×{g['height']}", style=FAINT)
        return t

    async def go(self, view: dict) -> None:
        self._token += 1
        token = self._token
        self.view, self.next = view, None
        kind = view["kind"]
        title = {"favorites": "★ Favorites", "trending": "↗ Trending GIFs", "category": view.get("name", "")}.get(kind, "GIFs")
        self.query_one("#gif-title", Label).update(Text(title, style=f"bold {INK}"))
        lv = self.query_one("#gif-list", ListView)
        if kind == "home":
            if self.categories is None:
                r = await self.call(self.api.chat_gif_categories)
                self.categories = (r or {}).get("categories") or []
            if token != self._token:
                return
            rows = [Row("favorites", label=Text(f"★ Favorites ({len(self.favorites)})", style=f"bold {GOLD}")),
                    Row("trending", label=Text("↗ Trending GIFs", style=f"bold {INK}"))]
            rows += [Row("category", c, Text("# " + c["name"], style=MUTED)) for c in self.categories]
            await lv.clear()
            await lv.extend(rows)
            lv.index = 0
            return
        if kind == "favorites":
            await lv.clear()
            if self.favorites:
                await lv.extend(Row("gif", g, self.label(g)) for g in self.favorites)
                lv.index = 0
            else:
                await lv.append(Row("none", label=Text("No favorites yet: ctrl+s on a GIF stars it.", style=MUTED)))
            return
        await lv.clear()
        await lv.append(Row("none", label=Text("Loading…", style=MUTED)))
        await self.more(token, fresh=True)

    async def more(self, token: int | None = None, fresh: bool = False) -> None:
        token = token or self._token
        q = "" if self.view["kind"] == "trending" else self.view.get("q", "")
        r = await self.call(self.api.chat_gifs, q, None if fresh else self.next)
        if token != self._token:
            return
        lv = self.query_one("#gif-list", ListView)
        for row in [c for c in lv.children if isinstance(c, Row) and c.kind in ("none", "more")]:
            await row.remove()
        if r is None:
            return
        gifs = r.get("results") or []
        self.next = r.get("next") if gifs else None
        had = len([c for c in lv.children if isinstance(c, Row) and c.kind == "gif"])
        await lv.extend(Row("gif", g, self.label(g)) for g in gifs)
        if self.next:
            await lv.append(Row("more", label=Text("more…", style=GOLD_DIM)))
        if not had and not gifs:
            await lv.append(Row("none", label=Text("No GIFs found. Try another search.", style=MUTED)))
        if not had:
            lv.index = 0

    # ── input ──────────────────────────────────────────────────────────
    def on_input_changed(self, event: Input.Changed) -> None:
        if self._timer:
            self._timer.stop()
        q = event.value.strip()
        self._timer = self.set_timer(SEARCH_WAIT if q else 0.01,
                                     lambda: self.run_worker(self.go({"kind": "search", "q": q} if q else {"kind": "home"}), exclusive=True))

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        q = event.value.strip()
        if self._timer:
            self._timer.stop()
        if q and self.view != {"kind": "search", "q": q}:
            await self.go({"kind": "search", "q": q})
        lv = self.query_one("#gif-list", ListView)
        if lv.children:
            lv.focus()

    async def on_list_view_selected(self, event: ListView.Selected) -> None:
        row = event.item
        if not isinstance(row, Row):
            return
        if row.kind == "gif":
            self.dismiss(row.data)
        elif row.kind == "more":
            await self.more()
        elif row.kind in ("favorites", "trending"):
            await self.go({"kind": row.kind})
        elif row.kind == "category":
            await self.go({"kind": "category", "name": row.data["name"], "q": row.data["query"]})

    async def action_star(self) -> None:
        lv = self.query_one("#gif-list", ListView)
        row = lv.highlighted_child
        if not isinstance(row, Row) or row.kind != "gif":
            return self.app.notify("Highlight a GIF to star it.", timeout=3)
        on = not self.starred(row.data["url"])
        r = await self.call(self.api.chat_gif_favorite, row.data, on)
        if r is None:
            return
        self.favorites = r.get("favorites") or []
        if self.view["kind"] == "favorites":
            await self.go({"kind": "favorites"})
        else:
            row.relabel(self.label(row.data))
        self.app.notify("Added to your favorite GIFs." if on else "Removed from your favorite GIFs.", timeout=3)

    async def action_back(self) -> None:
        if self.view["kind"] in ("favorites", "trending", "category"):
            box = self.query_one("#gif-q", Input)
            if box.value:
                await self.go({"kind": "search", "q": box.value.strip()})
            else:
                await self.go({"kind": "home"})
            box.focus()
        else:
            self.dismiss(None)
