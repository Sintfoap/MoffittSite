from test_pages import *  # noqa
def test_shot(real_site):
    async def recipes(app, pilot):
        page = app.screen
        await page.import_file("/tmp/claude-0/sp/recipes.html")
        await settle(pilot, 1.5)
        page.open = next(r["id"] for r in page.data["recipes"] if r["title"].startswith("Alice Springs"))
        page.show_shelf(); page.show_recipe()
        await settle(pilot, 0.5)
        app.save_screenshot("terminal.svg", "/tmp/claude-0/sp/shots")
    run_app("recipes", recipes)
