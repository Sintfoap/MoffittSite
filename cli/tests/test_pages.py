"""The terminal's Drift, plugin store, settings and chat pages, against the site's real Worker (tests/devsite.mjs)."""
import asyncio
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from sintfoap import site
from sintfoap import drift_rules as R

pytest.importorskip("textual")
from sintfoap.tui import SiteApp  # noqa: E402

DEVSITE = Path(__file__).with_name("devsite.mjs")
SHOTS = os.environ.get("SINTFOAP_SHOTS")     # a folder to save SVG screenshots in, for looking at


def start_site(monkeypatch, *flags):
    if not shutil.which("node"):
        pytest.skip("needs node to run the site")
    monkeypatch.setenv("XDG_CONFIG_HOME", tempfile.mkdtemp())
    proc = subprocess.Popen(["node", "--no-warnings", str(DEVSITE), *flags], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    info = json.loads(proc.stdout.readline())
    site.save_login({"site": info["origin"], "token": info["token"], "username": "ryan"})
    return proc, info["origin"]


@pytest.fixture
def real_site(monkeypatch):
    proc, origin = start_site(monkeypatch)
    yield origin
    proc.kill()


@pytest.fixture
def notify_site(monkeypatch):
    proc, origin = start_site(monkeypatch, "--notify")
    yield origin
    proc.kill()


@pytest.fixture
def admin_site(monkeypatch):
    proc, origin = start_site(monkeypatch, "--admin")
    yield origin
    proc.kill()


def run_app(start, test, size=(120, 40)):
    async def go():
        app = SiteApp(start)
        async with app.run_test(size=size) as pilot:
            await pilot.pause(0.3)
            await test(app, pilot)
            if SHOTS:
                app.save_screenshot(f"{start}-{test.__name__}.svg", SHOTS)
        return app
    return asyncio.run(go())


async def settle(pilot, n=0.3):
    await pilot.pause(n)


async def type_(pilot, text):
    await pilot.press(*[{" ": "space"}.get(c, c) for c in text])


# ── Drift ──────────────────────────────────────────────────────────────────

def test_drift_quick_add_lands_in_the_collection_with_its_metadata(real_site):
    async def quick_add(app, pilot):
        page = app.screen
        assert page.state["collections"][0]["name"] == "Inbox"
        await pilot.press("shift+tab", "shift+tab")   # items → add → the collections
        assert app.focused.id == "nav"
        await pilot.press("down", "down")                      # Calendar, (heading), Inbox
        assert page.view.startswith("c:")
        await pilot.press("a")
        await type_(pilot, "Call Sam #family !3 ^tomorrow @3pm")
        await pilot.press("enter")
        await settle(pilot)
        it = next(i for i in page.state["items"] if i["title"] == "Call Sam")
        assert it["tags"] == ["family"]
        assert it["meta"]["checklist"]["priority"] == 3
        assert it["meta"]["event"]["start"] == R.add_days(1) + "T15:00"
        assert "list" in it["meta"]
        await type_(pilot, "Buy milk")
        await pilot.press("enter")
        await settle(pilot)
    run_app("drift", quick_add)
    items = site.drift_state()["items"]
    assert sorted(i["title"] for i in items) == ["Buy milk", "Call Sam"]


def test_backslash_hides_the_side_panel_on_every_page_and_remembers(real_site):
    async def fold(app, pilot):
        side = app.screen.query_one("#side")
        assert side.display
        await pilot.press("shift+tab", "shift+tab")   # into the views, so hiding them has to move focus
        assert app.focused.id == "nav"
        await pilot.press("backslash")
        await settle(pilot)
        assert not side.display, "the views are hidden"
        assert app.focused is not None and side not in app.focused.ancestors_with_self
        assert app.screen.query_one("#pane").size.width > 110, "and the items get the width"
        app.open_page("chat")
        await settle(pilot, 0.6)
        assert not app.screen.query_one("#side").display, "the next page follows"
        await pilot.press("escape")
        await settle(pilot)
    run_app("drift", fold)
    assert site.load_prefs()["side_hidden"] is True

    async def back(app, pilot):
        assert not app.screen.query_one("#shelf").display, "remembered the next time"
        await pilot.press("backslash")
        await settle(pilot)
        assert app.screen.query_one("#shelf").display
    run_app("recipes", back)
    assert site.load_prefs()["side_hidden"] is False


def test_drift_ticks_edits_and_deletes_with_undo(real_site):
    st = site.drift_state()
    col = st["collections"][0]
    site.add_item({"title": "Water plants", "collection": col["id"], "meta": {"checklist": {"done": False, "priority": 0}}})

    async def keys(app, pilot):
        page = app.screen
        page.view = "c:" + col["id"]
        page.render_all()
        page.query_one("#items").focus()
        await settle(pilot)
        assert page.selected()["title"] == "Water plants"
        await pilot.press("2")
        await settle(pilot)
        await pilot.press("x")
        await settle(pilot)
        it = page.item(page.state["items"][0]["id"])
        assert it["meta"]["checklist"]["done"] and it["meta"]["checklist"]["priority"] == 2

        await pilot.press("h")          # show done
        await settle(pilot)
        assert page.selected()["title"] == "Water plants"
        await pilot.press("e")
        await settle(pilot)
        dlg = app.screen
        dlg.query_one("#title").value = "Water the plants"
        dlg.query_one("#day").value = "fri"
        await pilot.press("ctrl+s")
        await settle(pilot)
        it = page.item(it["id"])
        assert it["title"] == "Water the plants"
        assert it["meta"]["event"]["start"] == R.parse_date("fri")

        await pilot.press("d")
        await settle(pilot)
        assert not page.state["items"]
        await pilot.press("u")
        await settle(pilot)
        assert page.state["items"][0]["title"] == "Water the plants"
    run_app("drift", keys)


def test_drift_list_view_nests_and_today_shows_dated_items(real_site):
    col = site.drift_state()["collections"][0]
    site.update_collection(col["id"], {"view": "list"})
    a = site.add_item({"title": "Trip", "collection": col["id"], "meta": {"list": {"order": 1, "parent": None}}})
    b = site.add_item({"title": "Pack", "collection": col["id"], "meta": {"list": {"order": 2, "parent": None}}})
    dentist = site.add_item({"title": "Dentist", "collection": col["id"], "meta": {"event": {"start": R.today() + "T09:30", "end": None}}})

    async def outline(app, pilot):
        page = app.screen
        assert "Dentist" in str(page.query_one("#items").get_option(dentist["id"]).prompt)   # on Today
        page.view = "c:" + col["id"]
        page.render_all()
        page.query_one("#items").focus()
        await settle(pilot)
        assert page.current()[2] == "list"
        page.query_one("#items").highlighted = [o.id for o in page.query_one("#items").options].index(b["id"])
        await pilot.press("greater_than_sign")
        await settle(pilot)
        assert page.item(b["id"])["meta"]["list"]["parent"] == a["id"]
        await pilot.press("v")                         # next view wraps round to Checklist
        await settle(pilot)
        assert page.current()[2] == "checklist"
    run_app("drift", outline)


def test_drift_collections_are_made_and_shared(real_site):
    async def collections(app, pilot):
        page = app.screen
        page.action_new_collection()
        await settle(pilot)
        dlg = app.screen
        dlg.query_one("#name").value = "Work"
        dlg.query_one("#p-graph").value = False
        await pilot.press("ctrl+s")
        await settle(pilot, 0.5)
        col = page.current()[1]
        assert col["name"] == "Work" and col["plugins"] == ["checklist", "event", "list"]
        page.action_collection()
        await settle(pilot)
        dlg = app.screen
        dlg.query_one("#share-with").value = "sam"
        await dlg.share("sam", "view")
        await settle(pilot)
        assert dlg.col["shares"][0]["role"] == "view"
        await pilot.press("escape")
        await settle(pilot)
    run_app("drift", collections)
    st = site.drift_state()
    work = next(c for c in st["collections"] if c["name"] == "Work")
    assert work["shares"] == [{"username": "sam", "name": "Sam", "role": "view"}]


# ── plugin store ───────────────────────────────────────────────────────────

def test_store_lists_plugins_and_adds_them_to_drift(real_site):
    async def browse(app, pilot):
        page = app.screen
        assert [p["id"] for p in page.state["store"]] == ["stars"]
        await pilot.press("enter")
        await settle(pilot)
        assert "Stars" in str(app.screen.query_one(".h1").render())
        await pilot.press("i")
        await settle(pilot)
        assert page.installed == {"stars"}
        await pilot.press("escape")
        await settle(pilot)
    run_app("store", browse)
    assert site.installed() == ["stars"]


def test_store_writes_submits_and_withdraws_your_own_plugin(real_site):
    async def write(app, pilot):
        page = app.screen
        await pilot.press("2", "n")
        await settle(pilot)
        dlg = app.screen
        dlg.query_one("#id").value = "mood"
        dlg.query_one("#name").value = "Mood"
        dlg.query_one("#description").value = "How it felt."
        await pilot.click("#ok")
        await settle(pilot, 0.5)
        ed = app.screen
        assert "item.meta.mood" in ed.query_one("#code").text
        ed.query_one("#code").insert("// changed\n", (0, 0))
        await settle(pilot)
        assert ed.dirty
        await pilot.press("ctrl+s")
        await settle(pilot)
        assert not ed.dirty
        await pilot.press("ctrl+r")
        await settle(pilot)
        await pilot.press("enter")              # no note
        await settle(pilot, 0.5)
        assert ed.p["pending"]["version"] == 1
        await ed.withdraw()
        await settle(pilot)
        assert not ed.p["pending"]
        await pilot.press("escape")
        await settle(pilot)
        assert page.state["mine"][0]["working"]["code"].startswith("// changed")
    run_app("store", write)


def test_admins_review_in_the_terminal(admin_site):
    site.new_plugin({"id": "mood", "name": "Mood", "description": "", "code": "export default {};"})
    site.save_plugin("mood", {"code": "export default { id: 'mood' };"})
    site.submit_plugin("mood", "first one")

    async def review(app, pilot):
        page = app.screen
        assert len(page.queue) == 1
        await pilot.press("3", "enter")
        await settle(pilot)
        rv = app.screen
        await rv.action_decide("reject")          # needs a note
        assert site.review_queue()
        rv.query_one("#note").value = "Looks good"
        await rv.action_decide("approve")
        await settle(pilot, 0.5)
        assert not page.queue and [p["id"] for p in page.state["store"]] == ["mood", "stars"]
    run_app("store", review)


# ── admin ──────────────────────────────────────────────────────────────────

def test_admins_switch_apps_on_and_off_in_the_terminal(admin_site):
    async def access(app, pilot):
        page = app.screen
        assert type(page).__name__ == "AdminPage"
        apps = [a["id"] for a in page.data["apps"]]
        assert apps == ["drift", "admin", "plugins", "chat", "chat-bridges", "recipes", "sweep", "notifications"]
        # A switch for every app on every account; your own admin one can't be turned off.
        assert len(page.boxes) == len(apps) * len(page.data["users"])
        me = next(i for i, u in enumerate(page.data["users"]) if u["you"])
        assert page.query_one(f"#u{me}-admin").disabled
        sam = next(i for i, u in enumerate(page.data["users"]) if u["username"] == "sam")
        page.query_one(f"#u{sam}-chat").focus()
        await pilot.press("space")
        await settle(pilot, 0.5)
        assert "chat" not in next(u for u in site.admin_access()["users"] if u["username"] == "sam")["apps"]
        assert not page.query_one(f"#u{sam}-chat").value
        assert app.focused.id == f"u{sam}-chat"
        await pilot.press("space")
        await settle(pilot, 0.5)
        assert "chat" in next(u for u in site.admin_access()["users"] if u["username"] == "sam")["apps"]
    run_app("admin", access)


def test_g_a_opens_the_terminal_admin_page(admin_site):
    async def go(app, pilot):
        await settle(pilot, 0.5)
        app.go("a")
        await settle(pilot, 0.5)
        assert type(app.screen).__name__ == "AdminPage"
    run_app("dashboard", go)


# ── notifications ──────────────────────────────────────────────────────────

def test_notifications_page_changes_what_is_sent_and_where(notify_site):
    async def notifications(app, pilot):
        page = app.screen
        assert type(page).__name__ == "NotificationsPage"
        assert page.data["configured"]
        assert [d["label"] for d in page.data["devices"]] == ["Chrome on Android"]
        assert page.query_one("#chat_dms").value
        assert not page.query_one("#chat_rooms").value
        assert page.query_one("#chat_bridges").display, "ryan has Chat connections"
        # A switch here is the same setting as on the website.
        page.query_one("#chat_rooms").focus()
        await pilot.press("space")
        await settle(pilot, 0.5)
        assert site.notify_state()["prefs"]["chat_rooms"] is True
        page.query_one("#lead").value = 60
        await settle(pilot, 0.5)
        assert site.notify_state()["prefs"]["drift_lead"] == 60
        page.query_one("#drift_events").focus()
        await pilot.press("space")
        await settle(pilot, 0.5)
        assert site.notify_state()["prefs"]["drift_events"] is False
        assert page.query_one("#lead").disabled
        # t sends a test to every browser; Remove forgets one.
        await pilot.press("t")
        await settle(pilot, 0.5)
        assert page.data["sent"] == 1
        page.query_one(f"#rm-{page.data['devices'][0]['id']}").press()
        await settle(pilot, 0.5)
        assert site.notify_state()["devices"] == []
        assert not page.query_one("#test").display
    run_app("notifications", notifications)


def test_g_n_opens_the_terminal_notifications_page(notify_site):
    async def go(app, pilot):
        await settle(pilot, 0.5)
        assert any(n["key"] == "n" for n in app.data["nav"])
        app.go("n")
        await settle(pilot, 0.5)
        assert type(app.screen).__name__ == "NotificationsPage"
    run_app("dashboard", go)


# ── recipe box ─────────────────────────────────────────────────────────────

def test_recipe_box_saves_from_a_link_scales_and_sends_to_drift(real_site):
    async def recipes(app, pilot):
        page = app.screen
        assert type(page).__name__ == "RecipesPage"
        assert page.data["recipes"] == [] and page.data["drift"]
        # a, then a link: the site reads the recipe off the page.
        await pilot.press("a")
        assert app.focused.id == "url"
        app.focused.value = "https://recipes.test/pancakes"
        await pilot.press("enter")
        await settle(pilot, 0.6)
        r = page.current()
        assert r["title"] == "Pancakes" and r["servings"] == 4
        assert app.focused.id == "shelf"
        # + twice: 6 servings, and the lines change to match.
        await pilot.press("plus", "plus")
        assert page.amounts(r) == (1.5, 6)
        ing = page.query_one("#ingredients")
        assert str(ing.get_option_at_index(0).prompt) == "2¼ cups flour"
        # Untick the salt, then send the rest to a new Shopping list in Drift.
        ing.focus()
        ing.highlighted = 3
        await pilot.press("space")
        await settle(pilot)
        assert page.skip[r["id"]] == {3}
        await pilot.press("s")
        await settle(pilot, 0.6)
        drift = site.drift_state()
        shopping = next(c for c in drift["collections"] if c["name"] == "Shopping list")
        titles = sorted(it["title"] for it in drift["items"] if it["collection"] == shopping["id"])
        assert titles == ["1½ cup milk", "2¼ cups flour", "3 eggs"]
        assert any(x["id"] == shopping["id"] for x in page.data["lists"])
        # A page with no recipe on it opens the editor with the link filled in.
        page.query_one("#url").focus()
        page.query_one("#url").value = "https://recipes.test/blog"
        await pilot.press("enter")
        await settle(pilot, 0.6)
        dialog = app.screen
        assert type(dialog).__name__ == "RecipeDialog"
        assert dialog.query_one("#source").value == "https://recipes.test/blog"
        dialog.query_one("#title").value = "Toast"
        dialog.query_one("#ingredients").text = "2 slices bread\nbutter"
        await pilot.press("ctrl+s")
        await settle(pilot, 0.6)
        assert [x["title"] for x in site.recipes()["recipes"]] == ["Pancakes", "Toast"]
        assert page.current()["ingredients"] == ["2 slices bread", "butter"]
        # d deletes, after asking.
        await pilot.press("d")
        await settle(pilot)
        await pilot.press("y")
        await settle(pilot, 0.6)
        assert [x["title"] for x in site.recipes()["recipes"]] == ["Pancakes"]
    run_app("recipes", recipes)


def test_g_r_opens_the_terminal_recipe_box(real_site):
    async def go(app, pilot):
        await settle(pilot, 0.5)
        assert any(n["key"] == "r" for n in app.data["nav"])
        app.go("r")
        await settle(pilot, 0.5)
        assert type(app.screen).__name__ == "RecipesPage"
    run_app("dashboard", go)


# ── sweep ──────────────────────────────────────────────────────────────────

def test_sweep_picks_a_room_sweeps_it_and_accepts_into_drift(real_site):
    async def sweep(app, pilot):
        page = app.screen
        assert type(page).__name__ == "SweepPage"
        assert page.data["ready"] and page.data["suggestions"] == []
        rooms = page.query_one("#rooms")
        names = [r["name"] for r in page.data["rooms"]]
        assert "Plans" in names
        rooms.focus()
        rooms.highlighted = names.index("Plans")
        await pilot.press("space")
        await settle(pilot, 0.6)
        assert next(r for r in page.data["rooms"] if r["name"] == "Plans")["on"]
        # b: the first sweep looks back further.
        rooms.highlighted = [r["name"] for r in page.data["rooms"]].index("Plans")
        await pilot.press("b")
        await settle(pilot, 0.6)
        assert next(r for r in page.data["rooms"] if r["name"] == "Plans")["days"] == 14
        await pilot.press("s")
        await settle(pilot, 0.8)
        s = page.current()
        assert s["title"] == "Dinner at Lucia's" and s["author"] == "Sam"
        assert "Read 1 message, 1 new suggestion." in str(page.query_one("#status").render())
        assert "Fri Jan 4, 7:00 PM" in str(page.query_one("#detail").render())
        # e: edit the title, then accept.
        await pilot.press("e")
        await settle(pilot)
        dialog = app.screen
        assert type(dialog).__name__ == "EditDialog"
        dialog.query_one("#title").value = "Dinner with Sam"
        await pilot.press("ctrl+s")
        await settle(pilot, 0.8)
        assert page.data["suggestions"] == []
        assert page.data["history"][0]["status"] == "accepted"
        assert "Added “Dinner with Sam” to Inbox." in str(page.query_one("#status").render())
    run_app("sweep", sweep)
    item = next(i for i in site.drift_state()["items"] if i["title"] == "Dinner with Sam")
    assert item["meta"]["event"]["start"] == "2030-01-04T19:00"


def test_g_w_opens_the_terminal_sweep(real_site):
    async def go(app, pilot):
        await settle(pilot, 0.5)
        app.go("w")
        await settle(pilot, 0.5)
        assert type(app.screen).__name__ == "SweepPage"
    run_app("dashboard", go)


# ── settings ───────────────────────────────────────────────────────────────

def test_settings_renames_and_signs_out_other_devices(real_site):
    async def settings(app, pilot):
        page = app.screen
        assert "Ryan M" in str(page.query_one("#h1").render())
        assert "2 devices" in str(page.query_one("#sessions-text").render())
        name = page.query_one("#name")
        name.value = "Ryan Moffitt"
        name.focus()
        await pilot.press("enter")
        await settle(pilot)
        assert "Ryan Moffitt" in str(page.query_one("#h1").render())
        await page.sign_out_others(True)
        await settle(pilot)
        assert "1 device," in str(page.query_one("#sessions-text").render())
        assert "needs your password" in str(page.query_one("#twofa-text").render())
    run_app("settings", settings)
    assert site.account()["display_name"] == "Ryan Moffitt"


def test_dashboard_cards_open_the_terminal_pages(real_site):
    async def cards(app, pilot):
        await settle(pilot, 0.5)
        assert app.focused.id == "app-0" and app.focused.page == "drift"
        await pilot.press("enter")
        await settle(pilot, 0.5)
        assert type(app.screen).__name__ == "DriftPage"
        await pilot.press("escape")
        await settle(pilot)
        await pilot.press("s")
        await settle(pilot, 0.5)
        assert type(app.screen).__name__ == "SettingsPage"
    run_app("dashboard", cards)


# ── Chat ───────────────────────────────────────────────────────────────────

def test_chat_makes_a_room_and_posts_to_the_real_site(real_site):
    async def chat(app, pilot):
        assert type(app.screen).__name__ == "ChatPage"
        await pilot.press("ctrl+n")
        await type_(pilot, "general | hello all")
        await pilot.press("enter")
        await settle(pilot, 0.5)
        await type_(pilot, "first post")
        await pilot.press("enter")
        await settle(pilot, 0.5)
        page = app.screen
        assert page.room()["name"] == "general" and page.room()["topic"] == "hello all"
        assert "first post" in str(page.query_one("#messages").render())
        for line in ("/edit first post, edited", "/react tada", "/react crab", "second post", "/delete"):
            await type_(pilot, line)
            await pilot.press("enter")
            await settle(pilot, 0.5)
    run_app("chat", chat)
    [room] = [r for r in site.chat_state()["rooms"] if r["name"] != "Plans"]  # Plans is the dev site's, for Sweep
    assert room["name"] == "general" and room["joined"]
    [m] = site.chat_messages(room["id"])["messages"]
    assert m["body"] == "first post, edited" and m["edited_at"], "edited, and the second post deleted"
    assert [(r["emoji"], r["count"], r["mine"]) for r in m["reactions"]] == [("🎉", 1, True), ("🦀", 1, True)]



def test_chat_connects_matrix_and_talks_in_its_rooms(real_site):
    async def bridge(app, pilot):
        page = app.screen
        assert page.bridges["allowed"] and page.bridges["ready"]
        await type_(pilot, "/connect")
        await pilot.press("enter")
        await settle(pilot)
        assert type(app.screen).__name__ == "ConnectDialog"
        assert app.screen.query_one("#f-token").password, "secrets are typed hidden"
        await type_(pilot, "matrix.test")
        await pilot.press("enter")
        await type_(pilot, "syt_good")
        await pilot.press("enter", "enter", "enter")
        await settle(pilot, 1.5)
        assert type(app.screen).__name__ == "ChatPage"
        assert "@ryan:matrix.test" in str(page.query_one("#messages").render()), str(page.query_one("#status").render())
        room = next(r for r in page.rooms if r["kind"] == "bridge" and r["name"] == "Family")
        await page.open_room(room["id"])
        await settle(pilot)
        assert "dinner at six?" in str(page.query_one("#messages").render())
        assert "on Matrix as @ryan:matrix.test" in str(page.query_one("#head").render())
        await type_(pilot, "on my way")
        await pilot.press("enter")
        await settle(pilot, 0.5)
        for line in ("/edit on my way!", "/react tada"):
            await type_(pilot, line)
            await pilot.press("enter")
            await settle(pilot, 0.5)
        assert "reacted 🎉 to Sam" in str(page.query_one("#status").render()), str(page.query_one("#status").render())
        await type_(pilot, "/reply @sam six is **great**")
        await pilot.press("enter")
        await settle(pilot, 0.5)
        shown = str(page.query_one("#messages").render())
        assert "↳ Sam dinner at six?" in shown and "six is great" in shown, shown
        # An invite: accepted from the room.
        club = next(r for r in page.rooms if r.get("invite"))
        await page.open_room(club["id"])
        await settle(pilot)
        assert "Kim invited you: /accept or /decline" in str(page.query_one("#head").render())
        await type_(pilot, "/accept")
        await pilot.press("enter")
        await settle(pilot, 0.5)
        assert "accepted" in str(page.query_one("#status").render()), str(page.query_one("#status").render())
        assert not next(r for r in page.rooms if r["id"] == club["id"]).get("invite")
        # A new direct message on Matrix.
        await type_(pilot, "/dm @sam:matrix.test")
        await pilot.press("enter")
        await settle(pilot, 1)
        assert "talking with @sam:matrix.test on Matrix" in str(page.query_one("#status").render()), str(page.query_one("#status").render())
        await type_(pilot, "/disconnect 2")
        await pilot.press("enter")
        await settle(pilot)
    run_app("chat", bridge)
    room = next(r for r in site.chat_state()["rooms"] if r["kind"] == "bridge" and r["name"] == "Family")
    msgs = site.chat_messages(room["id"])["messages"]
    assert [(m["body"], m["mine"]) for m in msgs] == [("dinner at six?", False), ("on my way!", True), ("six is **great**", True)]
    assert msgs[2]["reply"]["id"] == msgs[0]["id"]
    [c] = site.chat_connections()
    site.chat_disconnect(c["id"])
    assert not any(r["kind"] == "bridge" for r in site.chat_state()["rooms"])


# ── the rules, without a site ──────────────────────────────────────────────

def test_chat_formatting_matches_the_web_page():
    from sintfoap.chat_page import body_text, quote_text
    t = body_text("**bold** *it* ~~no~~ `x*y*` [site](https://e.org) @josh\n> quoted\n```\ncode **raw**\n```", "josh", "white")
    assert t.plain == "bold it no x*y* site @josh\n▏quoted\ncode **raw**"
    styles = {t.plain[s.start:s.end]: str(s.style) for s in t.spans}
    assert "bold" in styles["bold"] and "italic" in styles["it"] and "strike" in styles["no"]
    assert "link https://e.org" in styles["site"]
    assert quote_text({"id": None}).plain.endswith("Deleted message")
    assert quote_text({"id": 1, "author_name": "Sam", "body": "**big**\nnews"}).plain == "  ↳ Sam big news"


def test_quick_add_parsing_matches_the_web_page():
    title, f = R.parse_quick("Call Sam #Family +home !2 ^+3d @3:15pm")
    assert title == "Call Sam"
    assert f == {"tags": ["family"], "collection": "home", "priority": 2, "date": R.add_days(3), "time": "15:15"}
    assert R.parse_quick("x !!!")[1]["priority"] == 3
    assert R.parse_time("930") == "09:30" and R.parse_time("13pm") is None
    assert R.parse_date("2026-02-30") is None


def test_outline_moves():
    items = [{"id": f"i_{n}", "created": "", "meta": {"list": {"order": n, "parent": None}}} for n in range(3)]
    assert R.list_move(items[1], items, "indent") == {"parent": "i_0", "order": 0}
    assert R.list_move(items[0], items, "indent") is None
    assert R.list_move(items[2], items, "up") == {"parent": None, "order": 0.5}
    items[1]["meta"]["list"] = {"order": 0, "parent": "i_0"}
    assert [(it["id"], d) for it, d in R.walk_outline(items)] == [("i_0", 0), ("i_1", 1), ("i_2", 0)]
    assert R.list_move(items[1], items, "outdent") == {"parent": None, "order": 1}


def test_day_plan_splits_a_day_into_no_set_time_and_hours():
    d = "2026-03-10"
    ev = lambda title, start, end=None: {"title": title, "meta": {"event": {"start": start, "end": end}}}
    items = [ev("Rent", d), ev("Standup", d + "T09:15"), ev("Workshop", d + "T13:00", d + "T15:00"),
             ev("Trip", "2026-03-09T18:00", "2026-03-11T10:00"), ev("Late", d + "T22:30"), ev("Elsewhere", "2026-03-12")]
    plan = R.day_plan(items, d)
    assert [i["title"] for i in plan["untimed"]] == ["Rent", "Trip"]
    assert {h: [i["title"] for i in v] for h, v in plan["hours"].items()} == {9: ["Standup"], 13: ["Workshop"], 22: ["Late"]}
    assert plan["busy"] == {9, 13, 14, 22}
    assert (plan["lo"], plan["hi"]) == (8, 22)
    assert R.day_plan(items, d, now_hour=6)["lo"] == 6


def test_drift_calendar_shows_the_day_by_the_hour(real_site):
    col = site.drift_state()["collections"][0]
    for title, start in [("Pay rent", R.today()), ("Standup", R.today() + "T09:00"), ("Lunch", R.today() + "T12:30")]:
        site.add_item({"title": title, "collection": col["id"], "meta": {"event": {"start": start, "end": None}}})

    async def calendar_day(app, pilot):
        page = app.screen
        page.view = "calendar"
        page.render_all()
        await settle(pilot)
        lst = page.query_one("#items")
        lines = [str(lst.get_option_at_index(i).prompt) for i in range(lst.option_count)]
        text = "\n".join(lines)
        assert "No set time" in text and "By the hour" in text
        assert text.index("Pay rent") < text.index("By the hour") < text.index("Standup") < text.index("Lunch")
        assert any(l.lstrip().startswith("9am") and "Standup" in l for l in lines)
        assert any(l.lstrip().startswith("12pm") and "Lunch" in l for l in lines)
    run_app("drift", calendar_day)


def test_drift_graph_lists_link_types_and_kinds(real_site):
    col = site.drift_state()["collections"][0]
    site.update_collection(col["id"], {"plugins": col["plugins"] + ["graph"]})
    a = site.add_item({"title": "Write copy", "collection": col["id"], "meta": {"graph": {"links": []}}})
    site.add_item({"title": "Launch", "collection": col["id"],
                   "meta": {"graph": {"links": [a["id"]], "rel": {a["id"]: "depends on"}, "kind": "milestone"}}})

    async def graph_tab(app, pilot):
        page = app.screen
        page.view = "c:" + col["id"]
        page.tabs[col["id"]] = "graph"
        page.render_all()
        await settle(pilot)
        lst = page.query_one("#items")
        line = next(str(lst.get_option_at_index(i).prompt) for i in range(lst.option_count) if "Launch" in str(lst.get_option_at_index(i).prompt))
        assert "milestone" in line and "→ depends on Write copy" in line
    run_app("drift", graph_tab)


def test_places_parse_and_draw_like_the_web_page():
    assert R.parse_coords("37.7955, -122.3937") == {"lat": 37.7955, "lng": -122.3937}
    assert R.parse_coords("https://www.openstreetmap.org/?mlat=51.5&mlon=-0.12#map=17/51.5/-0.12") == {"lat": 51.5, "lng": -0.12}
    assert R.parse_coords("https://www.google.com/maps/@37.80,-122.27,15z") == {"lat": 37.8, "lng": -122.27}
    assert R.parse_coords("91, 0") is None and R.parse_coords("Ferry Building") is None
    assert R.parse_quick("Lunch #food ~ Ferry Building, SF @1pm") == ("Lunch", {"tags": ["food"], "time": "13:00", "place": "Ferry Building, SF"})
    assert R.fresh_meta(["location"], {"place": "Coit Tower"}) == {"location": {"place": "Coit Tower", "lat": None, "lng": None}}
    assert R.place_label({"place": "", "lat": 1.5, "lng": 2}) == "1.50000, 2.00000"

    d = "2026-10-20"
    at = lambda id_, start, loc: {"id": id_, "title": id_, "meta": {"event": {"start": start, "end": None}, **({"location": loc} if loc else {})}}  # noqa: E731
    a = {"place": "A", "lat": 51.520847, "lng": -0.195521}
    b = {"place": "", "lat": 51.521251, "lng": -0.203586}
    items = [at("tea", d + "T15:00", b), at("lunch", d + "T12:00", a), at("lost", d + "T09:00", {"place": "Atlantis", "lat": None, "lng": None}),
             at("nowhere", d + "T10:00", None), at("tomorrow", "2026-10-21", a)]
    plan = R.day_stops(items, d)
    assert [(s["n"], s["item"]["id"]) for s in plan["stops"]] == [(1, "lunch"), (2, "tea")]
    assert plan["stops"][0]["from"] is None and round(plan["stops"][1]["from"]) == 560
    assert [it["id"] for it in plan["unplaced"]] == ["lost"] and [it["id"] for it in plan["elsewhere"]] == ["nowhere"]
    assert R.nice_distance(560) == "560 m" and R.nice_distance(1234) == "1.2 km" and R.nice_distance(1609.344, True) == "1.0 mi"

    m = R.text_map(plan["stops"], None, 40, 9)
    text = "\n".join("".join(r) for r in m["cells"])
    assert "1" in text and "2" in text and "·" in text
    (r1, c1), (r2, c2) = sorted(m["marks"], key=lambda k: m["marks"][k] != "lunch")
    assert c1 > c2, "lunch is east of tea"
    # Picking a stop centres the map on it.
    m = R.text_map(plan["stops"], "tea", 40, 9)
    assert m["marks"].get((4, 20)) == "tea"


def test_drift_map_shows_the_days_places_and_goes_to_the_one_picked(real_site):
    col = site.drift_state()["collections"][0]
    site.update_collection(col["id"], {"plugins": col["plugins"] + ["location"]})
    places = [("Breakfast", "T08:30", "Bayswater", 51.520847, -0.195521), ("Museum", "T10:00", "British Museum", 51.5194, -0.1270),
              ("Lunch", "T13:00", "South Bank", 51.5033, -0.1196)]
    for title, tm, place, lat, lng in places:
        site.add_item({"title": title, "collection": col["id"],
                       "meta": {"event": {"start": R.today() + tm, "end": None}, "location": {"place": place, "lat": lat, "lng": lng}}})
    site.add_item({"title": "Tomorrow", "collection": col["id"],
                   "meta": {"event": {"start": R.add_days(1), "end": None}, "location": {"place": "Notting Hill", "lat": 51.52, "lng": -0.2}}})
    site.add_item({"title": "Call home", "collection": col["id"], "meta": {"event": {"start": R.today() + "T18:00", "end": None}}})

    async def map_tab(app, pilot):
        page = app.screen
        page.view = "c:" + col["id"]
        page.tabs[col["id"]] = "location"
        page.render_all()
        await settle(pilot)
        lst = page.query_one("#items")
        lines = [str(lst.get_option_at_index(i).prompt) for i in range(lst.option_count)]
        text = "\n".join(lines)
        assert text.index("Breakfast") < text.index("Museum") < text.index("Lunch") < text.index("NO PLACE") < text.index("Call home")
        assert "Tomorrow" not in text, "only the chosen day"
        assert "British Museum" in text and ("km from 1" in text or "mi from 1" in text), "km or miles, by the locale"
        geo = page.query_one("#geo")
        assert geo.has_class("on")
        # Moving to Lunch centres the map on it and names it under the map.
        page.query_one("#items").focus()
        lst.highlighted = next(i for i, l in enumerate(lines) if "Lunch" in l)
        await settle(pilot)
        shown = str(geo.render())
        assert "Lunch" in shown and "South Bank" in shown
        # The next day has its own places.
        await pilot.press("right_square_bracket")
        await settle(pilot)
        text = "\n".join(str(lst.get_option_at_index(i).prompt) for i in range(lst.option_count))
        assert "Tomorrow" in text and "Breakfast" not in text
        # Adding on the map lands on the day shown, with its place (no key here, so kept as typed).
        page.query_one("#add").focus()
        await type_(pilot, "Dinner @7pm ~ Notting Hill")
        await pilot.press("enter")
        await settle(pilot, 0.6)
        made = next(it for it in site.drift_state()["items"] if it["title"] == "Dinner")
        assert made["meta"]["event"]["start"] == R.add_days(1) + "T19:00"
        assert made["meta"]["location"] == {"place": "Notting Hill", "lat": None, "lng": None}
    run_app("drift", map_tab)


def test_bases_and_routes_read_like_the_web_page():
    home = {"place": "Home", "lat": 51.5, "lng": -0.1, "from": None, "to": None}
    trip = {"place": "Hotel", "lat": 48.85, "lng": 2.35, "from": "2026-10-01", "to": "2026-10-07"}
    night = {"place": "Friend's", "lat": 48.9, "lng": 2.3, "from": "2026-10-03", "to": "2026-10-03"}
    assert R.base_for([home, trip, night], "2026-09-30") is home
    assert R.base_for([home, trip, night], "2026-10-02") is trip
    assert R.base_for([home, trip, night], "2026-10-03") is night
    assert R.base_for([trip], "2026-10-08") is None and R.base_for(None, "2026-10-08") is None
    assert R.base_scope(home) == "Home base" and R.base_scope(trip).startswith("Base from ")
    assert R.nice_duration(30) == "1 min" and R.nice_duration(65 * 60) == "1 h 5 min" and R.nice_duration(7200) == "2 h"
    # The base is on the map, and the route leaves from it and comes back.
    stop = lambda id_, n, lat, lng: {"item": {"id": id_, "meta": {"location": {"place": id_, "lat": lat, "lng": lng}}}, "n": n}  # noqa: E731
    m = R.text_map([stop("a", 1, 51.52, -0.12), stop("b", 2, 51.52, -0.08)], None, 40, 9, home)
    assert "base" in m["marks"].values() and "⌂" in "".join("".join(r) for r in m["cells"])


def test_drift_map_plans_a_route_from_the_base_and_sets_bases(real_site):
    col = site.drift_state()["collections"][0]
    site.update_collection(col["id"], {"plugins": col["plugins"] + ["location"]})
    for title, tm, lat, lng in [("Breakfast", "T08:30", 51.520847, -0.195521), ("Museum", "", 51.5194, -0.1270), ("Lunch", "T13:00", 51.5033, -0.1196)]:
        site.add_item({"title": title, "collection": col["id"],
                       "meta": {"event": {"start": R.today() + tm, "end": None}, "location": {"place": title, "lat": lat, "lng": lng}}})
    site.set_bases(col["id"], [{"place": "", "lat": 51.5154, "lng": -0.1755}])

    async def route(app, pilot):
        page = app.screen
        page.view = "c:" + col["id"]
        page.tabs[col["id"]] = "location"
        page.render_all()
        await settle(pilot)
        lst = page.query_one("#items")
        text = lambda: "\n".join(str(lst.get_option_at_index(i).prompt) for i in range(lst.option_count))  # noqa: E731
        assert "Home base" in text() and "51.51540, -0.17550" in text()
        lst.focus()
        await pilot.press("p")
        await settle(pilot, 0.8)
        t = text()
        assert "Route" in t and "of travel" in t and "(Drive)" in t, t
        assert "needs an OpenRouteService key" in t, "no key on the test site"
        assert "Back to" in t and " drive" in t
        assert t.index("Breakfast") < t.index("Lunch"), "times first"
        assert "⌂" in str(page.query_one("#geo").render())
        await pilot.press("m")
        await settle(pilot, 0.8)
        assert "(Walk)" in text() and " walk" in text()
        before = text()
        await pilot.press("right_parenthesis")
        await settle(pilot, 0.8)
        assert "Route 2 of" in text() and text() != before
        # b sets a base for just this day; the route then leaves from there.
        await pilot.press("b")
        await settle(pilot)
        dlg = app.screen
        dlg.query_one("#place").value = "51.5033, -0.1196"
        await pilot.press("ctrl+s")
        await settle(pilot, 0.8)
        bases = next(c for c in site.drift_state()["collections"] if c["id"] == col["id"])["bases"]
        assert [(b["from"], b["lat"]) for b in bases] == [(None, 51.5154), (R.today(), 51.5033)]
        assert "Base for Today" in text() and "51.50330, -0.11960" in text()
    run_app("drift", route)
