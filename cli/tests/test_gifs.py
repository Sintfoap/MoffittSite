"""sintfoap chat: the GIF picker, against stand-ins for /chat/api/gifs (see src/gifs.js)."""
import asyncio

import pytest

from sintfoap import site
from sintfoap.gif_picker import is_gif

from test_chat import FakeChatApi, run_chat, shown

HOSTS = ["klipy.com", "tenor.com", "giphy.com"]


def gif(name, w=200, h=100):
    return {"id": name, "title": f"{name} gif", "url": f"https://static.klipy.com/ii/{name}.gif",
            "preview": f"https://static.klipy.com/ii/{name}-tiny.gif", "width": w, "height": h}


class FakeGifApi(FakeChatApi):
    def __init__(self, ready=True):
        super().__init__()
        self.ready = ready
        self.favs = []
        self.searches = []

    def chat_state(self):
        return {**super().chat_state(), "gifs": {"ready": self.ready, "hosts": HOSTS, "provider": "GIPHY"}}

    def chat_gifs(self, q="", pos=None):
        self.searches.append((q, pos))
        if not q:
            return {"results": [gif("hot")], "next": None}
        if pos:
            return {"results": [gif(f"{q}3")], "next": None}
        return {"results": [gif(f"{q}1"), gif(f"{q}2")], "next": "2"}

    def chat_gif_categories(self):
        return {"categories": [{"name": "happy", "query": "happy", "preview": None}]}

    def chat_gif_favorites(self):
        return {"favorites": list(self.favs)}

    def chat_gif_favorite(self, g, on=True):
        self.favs = [f for f in self.favs if f["url"] != g["url"]]
        if on:
            self.favs.insert(0, g)
        return self.chat_gif_favorites()


def test_is_gif():
    assert is_gif("https://static.klipy.com/ii/a.gif", HOSTS)
    assert is_gif(" https://media.tenor.com/x/y.webp ", HOSTS)
    assert not is_gif("https://static.klipy.com/ii/a.gif hi", HOSTS)
    assert not is_gif("http://static.klipy.com/ii/a.gif", HOSTS)
    assert not is_gif("https://evil.example/a.gif", HOSTS)
    assert not is_gif("https://notklipy.com/a.gif", HOSTS)
    assert not is_gif("https://static.klipy.com/page", HOSTS)
    assert not is_gif("https://static.klipy.com:8443/a.gif", HOSTS)
    assert not is_gif("https://static.klipy.com/ii/a.gif", [])


async def settle(pilot, n=4):
    for _ in range(n):
        await pilot.pause()


def test_ctrl_g_searches_and_sends_a_gif():
    api = FakeGifApi()
    api.add_room("r_a", "general")
    api.add_message("r_a", "https://static.klipy.com/ii/wave.gif")

    async def t(app, pilot):
        from sintfoap.gif_picker import GifPicker
        assert "GIF https://static.klipy.com/ii/wave.gif" in shown(app)
        await pilot.press("ctrl+g")
        await settle(pilot)
        picker = app.app.screen
        assert isinstance(picker, GifPicker)
        rows = [str(r.query_one("Label").render()) for r in picker.query("Row")]
        assert rows[:2] == ["★ Favorites (0)", "↗ Trending GIFs"] and "# happy" in rows
        for ch in "cat":
            await pilot.press(ch)
        await asyncio.sleep(0.5)
        await settle(pilot)
        rows = [str(r.query_one("Label").render()) for r in picker.query("Row")]
        assert rows[0].strip().startswith("cat1 gif") and rows[-1] == "more…"
        # ↓ into the list, star the first, then ↓ ↓ to "more…" loads the next page.
        await pilot.press("down", "ctrl+s")
        await settle(pilot)
        assert [f["url"] for f in api.favs] == ["https://static.klipy.com/ii/cat1.gif"]
        await pilot.press("down", "down", "enter")
        await settle(pilot)
        assert ("cat", "2") in api.searches
        # Enter on the first GIF sends its link.
        picker.query_one("#gif-list").index = 1
        await pilot.press("enter")
        await settle(pilot)
        assert app.app.screen is app
        assert api.msgs[-1]["body"] == "https://static.klipy.com/ii/cat2.gif"
    run_chat(api, t)


def test_favorites_view_slash_gif_and_star():
    api = FakeGifApi()
    api.add_room("r_a", "general")
    api.add_message("r_a", "https://media.tenor.com/x/dance.gif")

    async def t(app, pilot):
        from sintfoap.gif_picker import GifPicker
        app.query_one("#input").value = "/star"
        await pilot.press("enter")
        await settle(pilot)
        assert [f["url"] for f in api.favs] == ["https://media.tenor.com/x/dance.gif"]
        # /gif opens the picker; Favorites lists the starred GIF; esc goes back, then closes.
        app.query_one("#input").value = "/gif"
        await pilot.press("enter")
        await settle(pilot)
        picker = app.app.screen
        assert isinstance(picker, GifPicker)
        picker.query_one("#gif-list").focus()
        await pilot.press("enter")
        await settle(pilot)
        assert picker.view["kind"] == "favorites"
        assert "GIF" in str(picker.query("Row").first().query_one("Label").render())
        await pilot.press("escape")
        await settle(pilot)
        assert picker.view["kind"] == "home"
        await pilot.press("escape")
        await settle(pilot)
        assert app.app.screen is app
        # /gif TEXT starts with that search.
        app.query_one("#input").value = "/gif party"
        await pilot.press("enter")
        await asyncio.sleep(0.5)
        await settle(pilot)
        assert ("party", None) in api.searches
        await pilot.press("escape")
        await settle(pilot)
        assert app.app.screen is app
        app.query_one("#input").value = "/star"
        await pilot.press("enter")
        await settle(pilot)
        assert api.favs == []
    run_chat(api, t)


def test_gifs_off_says_so():
    api = FakeGifApi(ready=False)
    api.add_room("r_a", "general")

    async def t(app, pilot):
        await pilot.press("ctrl+g")
        await settle(pilot)
        assert app.app.screen is app
        assert "GIF_API_KEY" in str(app.query_one("#status").render())
    run_chat(api, t)


def test_site_gif_calls(monkeypatch, tmp_path):
    seen = []
    monkeypatch.setattr(site, "load_login", lambda: {"site": "https://sintfoap.test", "token": "t"})
    monkeypatch.setattr(site, "call", lambda s, m, p, b=None, token=None, **k: (seen.append((m, p, b)) or (200, {"ok": True})))
    site.chat_gifs("cats & dogs")
    site.chat_gifs("cats", pos="30")
    site.chat_gifs()
    site.chat_gif_categories()
    site.chat_gif_favorites()
    site.chat_gif_favorite({"url": "https://static.klipy.com/a.gif", "width": None, "title": "a"}, on=False)
    assert seen == [
        ("GET", "/chat/api/gifs?q=cats%20%26%20dogs", None),
        ("GET", "/chat/api/gifs?q=cats&pos=30", None),
        ("GET", "/chat/api/gifs?q=", None),
        ("GET", "/chat/api/gifs/categories", None),
        ("GET", "/chat/api/gifs/favorites", None),
        ("POST", "/chat/api/gifs/favorites", {"gif": {"url": "https://static.klipy.com/a.gif", "title": "a"}, "on": False}),
    ]
