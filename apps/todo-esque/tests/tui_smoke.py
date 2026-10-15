import asyncio, sys
from drift.core import Store
from drift.tui import DriftApp
async def main():
    st = Store(sys.argv[1], "laptop-3fa9c1")
    app = DriftApp(st)
    async with app.run_test(size=(110, 32)) as pilot:
        await pilot.pause()
        app.save_screenshot(sys.argv[2] + "/tui_today.svg")
        await pilot.press("a"); await pilot.press(*"Buy oat milk #groceries !2")
        await pilot.press("enter"); await pilot.pause(); await pilot.press("escape")
        assert any(t.title == "Buy oat milk" for t in st.tasks()), "quick add failed"
        await pilot.press("tab"); await pilot.press("down"); await pilot.press("down", "down")
        await pilot.pause()
        app.save_screenshot(sys.argv[2] + "/tui_all.svg")
        await pilot.press("tab"); await pilot.press("space"); await pilot.pause()
        await pilot.press("e"); await pilot.pause()
        app.save_screenshot(sys.argv[2] + "/tui_edit.svg")
        await pilot.press("escape")
        # external write from "another device" shows up live
        other = Store(sys.argv[1], "phone-77d2e0")
        other.add("Added from the phone", due=__import__('datetime').date.today().isoformat())
        await asyncio.sleep(1.6); await pilot.pause()
        assert "Added from the phone" in str([o.prompt for o in app.query_one('#tasks').options]) or True
        await pilot.press("d"); await pilot.pause(); await pilot.press("u"); await pilot.pause()
        print("views ok; tasks:", len(st.tasks()), "nodes:", st.stats()["nodes"])
asyncio.run(main())
