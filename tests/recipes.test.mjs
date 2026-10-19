// Tests for Recipe box: reading recipes from pages, scaling, the API, and
// sending ingredients to a Drift list.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Browser, makeEnv, grantApps, sqlOne, run } from "./helpers.mjs";
import { parseRecipe } from "../src/recipes.js";
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
  assert.equal(r.time, "1 hr");
  assert.equal(r.image, "https://recipekeeperonline.com/images/abc.jpg");
  assert.deepEqual(r.ingredients, ["1 lb beef", "2 (15 oz) cans beans", "1 onion, diced"]);
  assert.deepEqual(r.steps, ["Brown the beef.", "Add the rest and simmer."]);
  assert.equal(r.notes, "Better the next day.\n\nSource: Aunt May");
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
