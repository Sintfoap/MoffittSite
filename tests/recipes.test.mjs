// Tests for Recipe box: reading recipes from pages, scaling, the API, and
// sending ingredients to a Drift list.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Browser, makeEnv, grantApps, sqlOne, run } from "./helpers.mjs";
import { parseRecipe, parseImported } from "../src/recipes.js";
import { splitPages, batches, photoOf, fileKey } from "../public/recipes/split.js";
import { unzip } from "../public/recipes/unzip.js";
import { deflateRawSync } from "node:zlib";
import { scaleLine, servingsOf, factorFor } from "../public/recipes/scale.js";

const CASES = JSON.parse(readFileSync(new URL("../cli/tests/scale_cases.json", import.meta.url)));

const PAGE = `<!doctype html><html><head><title>Best Pancakes | Food Site</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
  {"@type":"WebSite","name":"Food Site"},
  {"@type":["Recipe","NewsArticle"],"name":"Best Pancakes &amp; Syrup","image":[{"@type":"ImageObject","url":"https://food.test/p.jpg"}],
   "recipeYield":["4","4 servings"],"totalTime":"PT1H5M","description":"<p>Fluffy.</p>",
   "recipeIngredient":["1 1/2 cups flour","2 eggs","1&frac12; cups milk","salt to taste"],
   "recipeInstructions":[{"@type":"HowToSection","name":"Batter","itemListElement":[{"@type":"HowToStep","text":"Mix it."},{"@type":"HowToStep","text":"Rest it."}]},
     {"@type":"HowToStep","text":"Cook on a hot pan."}]}]}</script></head><body>…</body></html>`;

test("a page's JSON-LD recipe is read: through @graph, sections, entities and durations", () => {
  const r = parseRecipe(PAGE, "https://food.test/pancakes");
  assert.equal(r.title, "Best Pancakes & Syrup");
  assert.equal(r.image, "https://food.test/p.jpg");
  assert.equal(r.servings, 4);
  assert.equal(r.yield, "4");
  assert.equal(r.time, "1 hr 5 min");
  assert.deepEqual(r.ingredients, ["1 1/2 cups flour", "2 eggs", "1½ cups milk", "salt to taste"]);
  assert.deepEqual(r.steps, ["Mix it.", "Rest it.", "Cook on a hot pan."]);
  assert.equal(r.notes, "Fluffy.");
});

test("microdata works when there's no JSON-LD, and a page without a recipe gives null", () => {
  const r = parseRecipe(`<h1 itemprop="name">Toast</h1><span itemprop="recipeYield">Serves 2</span>
    <li itemprop="recipeIngredient">2 slices bread</li><li itemprop="recipeIngredient">butter</li>
    <div itemprop="recipeInstructions">Toast the bread.</div>`);
  assert.equal(r.title, "Toast");
  assert.equal(r.servings, 2);
  assert.deepEqual(r.ingredients, ["2 slices bread", "butter"]);
  assert.deepEqual(r.steps, ["Toast the bread."]);
  assert.equal(parseRecipe("<html><title>Just a blog</title></html>"), null);
});

test("scaling: the cases the terminal checks too", () => {
  for (const [line, factor, want] of CASES) assert.equal(scaleLine(line, factor), want, `${line} × ${factor}`);
  assert.equal(servingsOf("Makes 12 cookies"), 12);
  assert.equal(servingsOf("a lot"), null);
  assert.equal(factorFor({ servings: 4 }, { servings: 6 }), 1.5);
  assert.equal(factorFor({ servings: null }, { factor: 2 }), 2);
});

// The markup on a Recipe Keeper shared recipe (recipekeeperonline.com/recipe/…).
const KEEPER = `<html><head><title>Recipe Keeper</title></head><body><div class="recipe-details" itemscope itemtype="http://schema.org/Recipe">
  <h2 itemprop="name">Grandma&#39;s Chili</h2>
  <img src="/images/abc.jpg" itemprop="photo0" class="recipe-photo">
  <div>Serves: <span itemprop="recipeYield">6</span></div>
  <div>Prep time: <span>15 mins</span><meta content="PT15M" itemprop="prepTime"></div><meta content="PT1H" itemprop="cookTime">
  <div>Source: <span itemprop="recipeSource">Aunt May</span></div>
  <div class="recipe-ingredients" itemprop="recipeIngredients"><p>1 lb beef</p><div><p>2 (15 oz) cans beans</p></div><p>1 onion, diced</p></div>
  <div class="recipe-directions" itemprop="recipeDirections"><p>1. Brown the beef.</p><p>2. Add the rest and simmer.</p></div>
  <div itemprop="recipeNotes"><p>Better the next day.</p></div>
</div></body></html>`;

test("Recipe Keeper's shared recipes are read: its own names, every line, meta times and its photo", () => {
  const r = parseRecipe(KEEPER, "https://recipekeeperonline.com/recipe/Ka7ZNM6UmEm7Y9zoFtaSRg");
  assert.equal(r.title, "Grandma's Chili");
  assert.equal(r.servings, 6);
  assert.equal(r.time, "1 hr 15 min");
  assert.equal(r.image, "https://recipekeeperonline.com/images/abc.jpg");
  assert.deepEqual(r.ingredients, ["1 lb beef", "2 (15 oz) cans beans", "1 onion, diced"]);
  assert.deepEqual(r.steps, ["Brown the beef.", "Add the rest and simmer."]);
  assert.equal(r.notes, "Better the next day.\n\nSource: Aunt May");
});

// Today's shared pages, copied from a real one: one <li itemprop="ingredient"> per
// ingredient, <li> directions with blank ones between, and an unquoted itemprop=photo0.
const KEEPER_LI = `<html><head><title>Recipe Keeper - Ribs</title></head><body>
<article itemtype="http://schema.org/Recipe" itemscope="">
    <meta content="PT1H" itemprop="prepTime">
    <meta content="PT3M" itemprop="cookTime">
    <img src="/recipe/Bf-VsZTIJUS-eyORvzvndw/image" class="img-responsive recipe-photo" itemprop=photo0 />
    <h2 itemprop="name">Ribs</h2>
    <meta itemprop="recipeCourse" content="Main Dish">
    <div class="recipe-property" style="display: none;"><span class="recipe-label">Source: </span><span itemprop="recipeSource"></span></div>
    <div class="recipe-property" style="display: none;"><span class="recipe-label">Serving size: </span><span itemprop="recipeYield"></span></div>
    <ul class="list-unstyled recipe-ingredients">
        <li itemprop="ingredient">Rack of ribs</li>
        <li itemprop="ingredient">Special rub</li>
    </ul>
    <ul itemprop="recipeInstructions" class="recipe-directions list-unstyled">
        <li>Dry the ribs off and pat the spice rub in.</li>
        <li></li>
        <li>Grill each side for 5-10 minutes.</li>
    </ul>
</article></body></html>`;

test("Recipe Keeper's current shared pages are read too: <li> ingredients, blank steps dropped, prep and cook added up", () => {
  const r = parseRecipe(KEEPER_LI, "https://recipekeeperonline.com/recipe/Bf-VsZTIJUS-eyORvzvndw");
  assert.equal(r.title, "Ribs");
  assert.deepEqual(r.ingredients, ["Rack of ribs", "Special rub"]);
  assert.deepEqual(r.steps, ["Dry the ribs off and pat the spice rub in.", "Grill each side for 5-10 minutes."]);
  assert.equal(r.time, "1 hr 3 min");
  assert.equal(r.image, "https://recipekeeperonline.com/recipe/Bf-VsZTIJUS-eyORvzvndw/image");
  assert.equal(r.yield, "");
  assert.equal(r.notes, "");
});

let realFetch, pages;
beforeEach(() => {
  realFetch = globalThis.fetch;
  pages = new Map();
  globalThis.fetch = async (url) => {
    const p = pages.get(String(url));
    if (!p) return new Response("nope", { status: 404 });
    if (p.redirect) return new Response(null, { status: 301, headers: { Location: p.redirect } });
    return new Response(p.html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function cook(env, name = "ryan") {
  const b = new Browser(env);
  await b.signup(name);
  grantApps(env, name, "recipes");
  return b;
}
const api = (b, method, path, json) => b.req(method, "/recipes/api/" + path, { json });

test("Recipe box is off until an admin turns it on", async () => {
  const env = makeEnv(), josh = new Browser(env);
  await josh.signup("josh");
  assert.equal((await josh.get("/recipes/")).status, 403);
  assert.equal((await josh.get("/recipes/api/recipes")).status, 403);
  grantApps(env, "josh", "recipes");
  const page = await josh.get("/recipes/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("Content-Security-Policy"), /img-src 'self' data: https:/);
  assert.equal((await josh.get("/recipes")).status, 308);
});

test("saving from a link, editing, and deleting", async () => {
  const env = makeEnv(), ryan = await cook(env);
  pages.set("https://food.test/old", { redirect: "/pancakes" });
  pages.set("https://food.test/pancakes", { html: PAGE });
  pages.set("https://recipekeeperonline.com/recipe/Ka7ZNM6UmEm7Y9zoFtaSRg", { html: KEEPER });
  const keeper = await api(ryan, "POST", "recipes", { url: "https://recipekeeperonline.com/recipe/Ka7ZNM6UmEm7Y9zoFtaSRg" });
  assert.equal(keeper.status, 201, keeper.text);
  assert.equal(keeper.json.title, "Grandma's Chili");
  await api(ryan, "DELETE", `recipes/${keeper.json.id}`);
  const made = await api(ryan, "POST", "recipes", { url: "https://food.test/old" });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.title, "Best Pancakes & Syrup");
  assert.equal(made.json.source, "https://food.test/pancakes");

  pages.set("https://food.test/blog", { html: "<title>Blog</title>" });
  const none = await api(ryan, "POST", "recipes", { url: "https://food.test/blog" });
  assert.equal(none.status, 422);
  assert.equal(none.json.manual, true);
  for (const url of ["ftp://food.test/x", "http://localhost/x", "http://10.0.0.1/x", "https://user:pw@food.test/x", "not a link"]) {
    assert.equal((await api(ryan, "POST", "recipes", { url })).status, 400, url);
  }
  pages.set("https://food.test/sneaky", { redirect: "http://127.0.0.1/admin" });
  assert.match((await api(ryan, "POST", "recipes", { url: "https://food.test/sneaky" })).json.error, /redirects/);

  // By hand, with lines as text.
  const toast = await api(ryan, "POST", "recipes", { title: "Toast", yield: "Serves 2", ingredients: "2 slices bread\n\nbutter\n", steps: "Toast it." });
  assert.equal(toast.status, 201);
  assert.equal(toast.json.servings, 2);
  assert.deepEqual(toast.json.ingredients, ["2 slices bread", "butter"]);
  assert.equal((await api(ryan, "POST", "recipes", { title: "" })).status, 400);
  assert.equal((await api(ryan, "POST", "recipes", { title: "x", image: "http://plain.test/a.jpg" })).status, 400);

  const changed = await api(ryan, "PATCH", `recipes/${toast.json.id}`, { servings: 3, notes: "Rye is best." });
  assert.equal(changed.json.servings, 3);
  assert.equal(changed.json.title, "Toast");
  const all = (await ryan.get("/recipes/api/recipes")).json;
  assert.deepEqual(all.recipes.map(r => r.title), ["Best Pancakes & Syrup", "Toast"]);
  assert.equal(all.drift, true);

  // Someone else can't see or touch them.
  const sam = await cook(env, "sam");
  assert.deepEqual((await sam.get("/recipes/api/recipes")).json.recipes, []);
  assert.equal((await api(sam, "PATCH", `recipes/${toast.json.id}`, { title: "Mine" })).status, 404);
  assert.equal((await api(sam, "DELETE", `recipes/${toast.json.id}`)).status, 404);
  assert.equal((await api(ryan, "DELETE", `recipes/${toast.json.id}`)).status, 200);
  assert.equal((await ryan.get("/recipes/api/recipes")).json.recipes.length, 1);
  assert.equal((await ryan.req("POST", "/recipes/api/recipes", { json: { title: "x" }, origin: "https://evil.test" })).status, 403);
});

test("ingredients go to a Drift shopping list, scaled, and to a list shared with you", async () => {
  const env = makeEnv(), ryan = await cook(env);
  pages.set("https://food.test/pancakes", { html: PAGE });
  const { id } = (await api(ryan, "POST", "recipes", { url: "https://food.test/pancakes" })).json;

  const sent = await api(ryan, "POST", `recipes/${id}/shop`, { servings: 8, lines: [0, 2, 3] });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.list.name, "Shopping list");
  assert.equal(sent.json.added, 3);
  const drift = (await ryan.get("/todo/api/state")).json;
  const list = drift.collections.find(c => c.name === "Shopping list");
  assert.deepEqual(list.plugins, ["checklist", "list"]);
  const items = drift.items.filter(it => it.collection === list.id);
  assert.deepEqual(items.map(it => it.title).sort(), ["3 cups flour", "3 cups milk", "salt to taste"]);
  assert.equal(items[0].notes, "For Best Pancakes & Syrup (8 servings)");
  assert.equal(items[0].meta.checklist.done, false);

  // Again: the same list, not a second one.
  await api(ryan, "POST", `recipes/${id}/shop`, { servings: 4 });
  const after = (await ryan.get("/todo/api/state")).json;
  assert.equal(after.collections.filter(c => c.name === "Shopping list").length, 1);
  assert.equal(after.items.filter(it => it.collection === list.id).length, 7);
  assert.equal((await api(ryan, "POST", `recipes/${id}/shop`, { lines: [] })).status, 400);

  // sam shares a list with ryan to edit; ryan can send to it.
  const sam = new Browser(env);
  await sam.signup("sam");
  const shared = (await sam.req("POST", "/todo/api/collections", { json: { name: "House groceries" } })).json;
  await sam.req("POST", `/todo/api/collections/${shared.id}/shares`, { json: { username: "ryan", role: "edit" } });
  const lists = (await ryan.get("/recipes/api/recipes")).json.lists;
  assert.ok(lists.some(l => l.id === shared.id && l.owner_name === "sam"));
  const toShared = await api(ryan, "POST", `recipes/${id}/shop`, { list: shared.id, lines: [1] });
  assert.equal(toShared.json.list.name, "House groceries");
  assert.equal((await sam.get("/todo/api/state")).json.items.filter(it => it.collection === shared.id)[0].title, "2 eggs");
  // A list that's only shared to view isn't offered, and can't be sent to.
  await sam.req("POST", `/todo/api/collections/${shared.id}/shares`, { json: { username: "ryan", role: "view" } });
  assert.equal((await api(ryan, "POST", `recipes/${id}/shop`, { list: shared.id })).status, 400);

  // Without Drift there's no list to send to.
  const { id: uid } = sqlOne(env, "SELECT id FROM users WHERE username = 'ryan'");
  run(env, "DELETE FROM user_areas WHERE user_id = ? AND area = 'todo'", uid);
  assert.equal((await ryan.get("/recipes/api/recipes")).json.drift, false);
  assert.match((await api(ryan, "POST", `recipes/${id}/shop`, {})).json.error, /Drift/);
});

// Two recipes as Recipe Keeper's HTML export writes them (Settings → Export → HTML).
const EXPORT_RECIPE = (id, name, { source = "", ingredients = "", nut = "" } = {}) => `
    <div class="recipe-details">
        <meta content="${id}" itemprop="recipeId">
        <meta content="True" itemprop="recipeIsFavourite">
        <meta content="4" itemprop="recipeRating">
        <table><tr><td><img src="images/${id}_0.jpg" class="recipe-photo"/></td>
        <td><h2 itemprop="name">${name}</h2>
          <div>Courses: <span itemprop="recipeCourse">Main Dish</span></div>
          <div>Categories: <span>Basic, Italian</span><meta content="Basic" itemprop="recipeCategory"><meta content="Italian" itemprop="recipeCategory"></div>
          <div>Collections: <span>It&#39;s Complicated</span><meta content="It&#39;s Complicated" itemprop="recipeCollection"></div>
          <div>Source: <span itemprop="recipeSource">${source}</span></div>
          <div>Serving size: <span itemprop="recipeYield">10</span></div>
          <div>Preparation time: <span>10 mins</span><meta content="PT10M" itemprop="prepTime"></div>
          <div>Cooking time: <span>5 mins</span><meta content="PT5M" itemprop="cookTime"></div>
        </td></tr>
        <tr><td><div class="recipe-ingredients" itemprop="recipeIngredients">${ingredients}</div></td>
        <td><div itemprop="recipeDirections"><p>Melt it.</p><p></p><p>Whisk it.</p></div></td></tr></table>
        <div class="recipe-notes" itemprop="recipeNotes"><p>So good.</p></div>
        ${nut}
        <div class="recipe-photos-div"><img src="images/${id}_0.jpg" class="recipe-photos" itemprop=photo0 /></div>
        <hr />
    </div>`;
const EXPORT = `<!DOCTYPE html><html><head><style>.recipe-details h2 {color: #d24400}</style></head><body>
${EXPORT_RECIPE("a1", "Alfredo Sauce", { source: '<a href="https://food.test/alfredo">https://food.test/alfredo</a>',
  ingredients: "<p>&#189; cup butter</p><p></p><p>Sauce:</p><p>1 cup parmesan</p>",
  nut: '<div>Calories: 329<meta content="329" itemprop="recipeNutCalories"></div><div>Protein: 6g<meta content="6" itemprop="recipeNutProtein"></div>' })}
${EXPORT_RECIPE("b2", "Brats", { source: "Family Cookbook" })}
</body></html>`;

test("Recipe Keeper's HTML export: one piece per recipe, its link, extras in the notes, title-only ones kept", () => {
  const pages = splitPages(EXPORT);
  assert.equal(pages.length, 2);
  assert.deepEqual(splitPages("<p>no recipes here</p>"), ["<p>no recipes here</p>"]);
  assert.deepEqual(splitPages("  "), []);
  assert.deepEqual(batches(["a", "b", "c"], 2).map(b => b.length), [2, 1]);
  assert.deepEqual(batches(["aaaa", "bbbb", "c"], 10, 6).map(b => b.length), [1, 2]);

  const a = parseImported(pages[0]);
  assert.equal(a.title, "Alfredo Sauce");
  assert.equal(a.source, "https://food.test/alfredo");
  assert.equal(a.image, "");
  assert.equal(a.servings, 10);
  assert.equal(a.time, "15 min");
  assert.deepEqual(a.ingredients, ["½ cup butter", "Sauce:", "1 cup parmesan"]);
  assert.deepEqual(a.steps, ["Melt it.", "Whisk it."]);
  assert.equal(a.notes, "So good.\n\nCourses: Main Dish\nCategories: Basic, Italian\nCollections: It's Complicated\nRating: ★★★★☆\nFavourite\nNutrition per serving: Calories 329 · Protein 6g");

  const b = parseImported(pages[1]);
  assert.equal(b.title, "Brats");
  assert.deepEqual(b.ingredients, []);
  assert.equal(b.source, "");
  assert.match(b.notes, /^So good\.\n\nSource: Family Cookbook\n\nCourses: Main Dish/);

  // A saved recipe page on its own is read as a link would be.
  assert.equal(parseImported(PAGE).title, "Best Pancakes & Syrup");
  assert.equal(parseImported("<html><title>Just a blog</title></html>"), null);
});

test("importing a file: saved a few at a time, the same recipe twice skipped, the box's limit kept", async () => {
  const env = makeEnv(), ryan = await cook(env);
  const pages = [...splitPages(EXPORT), PAGE, "<p>nothing</p>"];
  const out = await api(ryan, "POST", "recipes/import", { pages });
  assert.equal(out.status, 200, out.text);
  assert.deepEqual(out.json.added.map(r => r.title), ["Alfredo Sauce", "Brats", "Best Pancakes & Syrup"]);
  assert.deepEqual(out.json.skipped, [{ title: "", why: "had no recipe" }]);
  assert.match(out.json.added[0].id, /^r_[0-9a-f]{10}$/);
  assert.equal((await ryan.get("/recipes/api/recipes")).json.recipes.length, 3);

  // Again: nothing new.
  const again = await api(ryan, "POST", "recipes/import", { pages: splitPages(EXPORT) });
  assert.deepEqual(again.json.added, []);
  assert.deepEqual(again.json.skipped.map(s => s.why), ["already in your box", "already in your box"]);

  assert.equal((await api(ryan, "POST", "recipes/import", { pages: [] })).status, 400);
  assert.equal((await api(ryan, "POST", "recipes/import", { pages: Array(11).fill(PAGE) })).status, 400);
  assert.equal((await ryan.get("/recipes/api/recipes/import")).status, 405);
  assert.equal((await ryan.req("POST", "/recipes/api/recipes/import", { json: { pages }, origin: "https://evil.test" })).status, 403);

  // Someone else's box is their own.
  const sam = await cook(env, "sam");
  assert.equal((await api(sam, "POST", "recipes/import", { pages: splitPages(EXPORT) })).json.added.length, 2);
});

// A tiny JPEG: just enough for the site to know it's one.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]).toString("base64");

test("an export's photos: found in each piece, matched by name, kept here, and filled in on a second import", async () => {
  const pages = splitPages(EXPORT);
  assert.equal(photoOf(pages[0]), "images/a1_0.jpg");
  assert.equal(photoOf('<img src="https://x.test/a.jpg" class="recipe-photo">'), "");
  assert.equal(photoOf("<p>no picture</p>"), "");
  assert.equal(fileKey("export/images/A1_0.JPG"), "a1_0.jpg");
  assert.equal(fileKey("images\\b%202.jpg"), "b 2.jpg");

  const env = makeEnv(), ryan = await cook(env);
  const first = (await api(ryan, "POST", "recipes/import", { pages: [...pages, "<p>nothing</p>"] })).json;
  assert.deepEqual(first.pages.map(p => p && { image: p.image }), [{ image: false }, { image: false }, null]);
  const [a, b] = first.pages;
  assert.equal(a.id, first.added[0].id);

  // Its picture, kept here.
  const set = await api(ryan, "POST", `recipes/${a.id}/photo`, { data: JPEG });
  assert.equal(set.status, 200, set.text);
  assert.match(set.json.image, /^\/recipes\/api\/photos\/p_[0-9a-f]{10}$/);
  const pic = await ryan.get(set.json.image);
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get("Content-Type"), "image/jpeg");
  assert.equal(pic.headers.get("Content-Security-Policy"), "default-src 'none'");
  assert.equal((await api(ryan, "POST", `recipes/${a.id}/photo`, { data: btoa("not a picture") })).status, 400);
  assert.equal((await api(ryan, "POST", `recipes/${a.id}/photo`, { data: "%%%" })).status, 400);
  // A new one replaces it; the old one is gone.
  const again = (await api(ryan, "POST", `recipes/${a.id}/photo`, { data: JPEG })).json;
  assert.notEqual(again.image, set.json.image);
  assert.equal((await ryan.get(set.json.image)).status, 404);
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM recipe_photos").n, 1);
  // Editing the recipe keeps its picture; one can't be pointed at by hand except as a link.
  assert.equal((await api(ryan, "PATCH", `recipes/${a.id}`, { notes: "x", image: again.image })).json.image, again.image);
  assert.equal((await api(ryan, "PATCH", `recipes/${a.id}`, { image: "/recipes/api/photos/../../admin" })).status, 400);

  // Importing again says which are already there, and whether they have a picture.
  const second = (await api(ryan, "POST", "recipes/import", { pages })).json;
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.pages, [{ id: a.id, image: true }, { id: b.id, image: false }]);

  // Someone else can't set one on ryan's recipe; deleting the recipe takes its picture.
  const sam = await cook(env, "sam");
  assert.equal((await api(sam, "POST", `recipes/${a.id}/photo`, { data: JPEG })).status, 404);
  assert.equal((await sam.get(again.image)).status, 200);
  await api(ryan, "DELETE", `recipes/${a.id}`);
  assert.equal((await ryan.get(again.image)).status, 404);
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM recipe_photos").n, 0);
});

test("a zip is read in the browser: stored and deflated files", async () => {
  // A zip by hand: one stored file, one deflated, and a folder entry.
  const entries = [["export/", Buffer.alloc(0), 0], ["export/recipes.html", Buffer.from(EXPORT), 8], ["export/images/a1_0.jpg", Buffer.from(JPEG, "base64"), 0]];
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, body, method] of entries) {
    const data = method ? deflateRawSync(body) : body, n = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data); centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(dir.length, 12); eocd.writeUInt32LE(offset, 16);
  const files = await unzip(new Blob([...locals, dir, eocd]));
  assert.deepEqual(files.map(f => f.name), ["export/recipes.html", "export/images/a1_0.jpg"]);
  assert.equal(await (await files[0].blob()).text(), EXPORT);
  assert.equal(Buffer.from(await (await files[1].blob()).arrayBuffer()).toString("base64"), JPEG);
  await assert.rejects(unzip(new Blob(["not a zip"])), /isn't a zip/);
});
