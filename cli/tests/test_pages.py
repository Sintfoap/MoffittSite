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
        assert apps == ["drift", "admin", "plugins", "chat"]
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
        await type_(pilot, "/delete")
        await pilot.press("enter")
        await settle(pilot, 0.5)
    run_app("chat", chat)
    [room] = site.chat_state()["rooms"]
    assert room["name"] == "general" and room["joined"]
    msgs = site.chat_messages(room["id"])["messages"]
    assert msgs == [], "the post was deleted"


# ── the rules, without a site ──────────────────────────────────────────────

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
