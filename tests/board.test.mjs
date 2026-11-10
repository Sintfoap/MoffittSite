// Tests for the Recipe board: recipes shared under categories, following the
// categories you like, the feed of what's new in them, and saving a post into
// your Recipe box.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps, sql } from "./helpers.mjs";
import { STARTING_CATEGORIES } from "../src/board.js";

async function member(env, name, ...apps) {
  const b = new Browser(env);
  await b.signup(name, undefined, name[0].toUpperCase() + name.slice(1));
  grantApps(env, name, "board", ...apps);
  return b;
}
const api = (b, method, path, json) => b.req(method, "/board/api/" + path, { json });
const RECIPE = { ingredients: ["2 cups flour", "1 egg"], steps: ["Mix", "Bake"], servings: 4 };
const catId = async (b, name) => (await api(b, "GET", "board")).json.categories.find(c => c.name === name).id;

test("Recipe board is off until an admin turns it on", async () => {
  const env = makeEnv(), josh = new Browser(env);
  await josh.signup("josh");
  assert.equal((await josh.get("/board/")).status, 403);
  assert.equal((await josh.get("/board/api/board")).status, 403);
  grantApps(env, "josh", "board");
  assert.equal((await josh.get("/board/")).status, 200);
  assert.equal((await josh.get("/board")).status, 308);
  const b = (await josh.get("/board/api/board")).json;
  assert.deepEqual(b.categories.map(c => c.name), [...STARTING_CATEGORIES].sort());
  assert.equal(b.recipe_box, false);
  assert.equal(b.unread, 0);
  assert.ok(b.categories.every(c => !c.following && c.posts === 0));
});

test("categories: anyone can start one, and follows what they start", async () => {
  const env = makeEnv(), ryan = await member(env, "ryan"), sam = await member(env, "sam");
  const c = await api(ryan, "POST", "categories", { name: "  Grilling  " });
  assert.equal(c.status, 201, c.text);
  assert.equal(c.json.name, "Grilling");
  assert.equal(c.json.following, true);
  assert.equal(c.json.can_delete, true);
  assert.match((await api(sam, "POST", "categories", { name: "grilling" })).json.error, /already/);
  assert.equal((await api(sam, "POST", "categories", { name: "" })).status, 400);
  assert.equal((await api(sam, "POST", "categories", { name: "x".repeat(41) })).status, 400);
  // Only whoever started it can delete it, and only while it's empty.
  assert.match((await api(sam, "DELETE", `categories/${c.json.id}`)).json.error, /only/);
  await api(ryan, "POST", "posts", { category: c.json.id, title: "Ribs", recipe: RECIPE });
  assert.match((await api(ryan, "DELETE", `categories/${c.json.id}`)).json.error, /first/);
  const empty = (await api(ryan, "POST", "categories", { name: "Smoking" })).json.id;
  assert.equal((await api(ryan, "DELETE", `categories/${empty}`)).json.removed, true);
  assert.equal((await api(ryan, "DELETE", `categories/${empty}`)).status, 404);
});

test("posting: typed in, with a title and a recipe", async () => {
  const env = makeEnv(), ryan = await member(env, "ryan");
  const dinner = await catId(ryan, "Dinner");
  for (const bad of [{ title: "x", recipe: RECIPE }, { category: "c_0000000000", title: "x", recipe: RECIPE },
    { category: dinner, recipe: RECIPE }, { category: dinner, title: "x" }, { category: dinner, title: "x", recipe: { ingredients: [] } },
    { category: dinner, title: "x", recipe: RECIPE, colour: "red" }]) {
    assert.equal((await api(ryan, "POST", "posts", bad)).status, 400, JSON.stringify(bad));
  }
  const p = await api(ryan, "POST", "posts", { category: dinner, title: "Lasagne", note: "Best on day two.", recipe: { ...RECIPE, title: "ignored" } });
  assert.equal(p.status, 201, p.text);
  assert.equal(p.json.title, "Lasagne");
  assert.equal(p.json.category_name, "Dinner");
  assert.equal(p.json.by, "Ryan");
  assert.equal(p.json.can_edit, true);
  assert.deepEqual(p.json.recipe.ingredients, RECIPE.ingredients);
  assert.equal(p.json.recipe.servings, 4);
  // Sharing from your Recipe box needs it turned on.
  assert.match((await api(ryan, "POST", "posts", { category: dinner, recipe_id: "r_0000000000" })).json.error, /Recipe box/);
});

test("the feed: new posts in the categories you follow, marked read when you look", async () => {
  const env = makeEnv(), ryan = await member(env, "ryan"), sam = await member(env, "sam");
  const [baking, dinner] = [await catId(ryan, "Baking"), await catId(ryan, "Dinner")];
  assert.equal((await api(sam, "PUT", `categories/${baking}/follow`, { follow: true })).json.following, true);
  assert.equal((await api(sam, "PUT", `categories/${baking}/follow`, {})).status, 400);
  assert.equal((await api(sam, "PUT", "categories/c_0000000000/follow", { follow: true })).status, 404);

  await api(ryan, "POST", "posts", { category: baking, title: "Scones", recipe: RECIPE });
  await api(ryan, "POST", "posts", { category: dinner, title: "Curry", recipe: RECIPE });
  await api(sam, "POST", "posts", { category: baking, title: "Sam's bread", recipe: RECIPE });

  assert.equal((await api(sam, "GET", "board")).json.unread, 1, "your own posts aren't news to you");
  const feed = (await api(sam, "GET", "posts?view=feed")).json;
  assert.deepEqual(feed.posts.map(p => [p.title, p.new]), [["Sam's bread", false], ["Scones", true]]);
  assert.equal(feed.more, false);
  assert.equal((await api(sam, "GET", "board")).json.unread, 0);
  assert.deepEqual((await api(sam, "GET", "posts?view=feed")).json.posts.map(p => p.new), [false, false]);

  // Other views, and one category whether you follow it or not.
  assert.deepEqual((await api(sam, "GET", "posts?view=all")).json.posts.map(p => p.title), ["Sam's bread", "Curry", "Scones"]);
  assert.deepEqual((await api(sam, "GET", "posts?view=mine")).json.posts.map(p => p.title), ["Sam's bread"]);
  assert.deepEqual((await api(sam, "GET", `posts?category=${dinner}`)).json.posts.map(p => p.title), ["Curry"]);
  assert.equal((await api(sam, "GET", "posts?view=nope")).status, 400);

  // Unfollowing takes it out of the feed.
  await api(sam, "PUT", `categories/${baking}/follow`, { follow: false });
  assert.deepEqual((await api(sam, "GET", "posts?view=feed")).json.posts, []);
});

test("the feed pages back through older posts", async () => {
  const env = makeEnv(), ryan = await member(env, "ryan");
  const quick = await catId(ryan, "Quick");
  await api(ryan, "PUT", `categories/${quick}/follow`, { follow: true });
  for (let i = 0; i < 45; i++) {
    await api(ryan, "POST", "posts", { category: quick, title: `Dish ${i}`, recipe: RECIPE });
    await new Promise(r => setTimeout(r, 2));
  }
  const one = (await api(ryan, "GET", "posts?view=feed")).json;
  assert.equal(one.posts.length, 40);
  assert.equal(one.more, true);
  const two = (await api(ryan, "GET", `posts?view=feed&before=${encodeURIComponent(one.posts.at(-1).created)}`)).json;
  assert.equal(two.posts.length, 5);
  assert.equal(two.more, false);
  assert.equal(two.posts.at(-1).title, "Dish 0");
});

test("saving a post to your Recipe box, and sharing from it", async () => {
  const env = makeEnv(), ryan = await member(env, "ryan", "recipes"), sam = await member(env, "sam");
  const baking = await catId(ryan, "Baking");
  const mine = (await ryan.req("POST", "/recipes/api/recipes", { json: { title: "Banana bread", ...RECIPE, notes: "Use brown bananas" } })).json;
  const shared = await api(ryan, "POST", "posts", { category: baking, recipe_id: mine.id, note: "Freezes well" });
  assert.equal(shared.status, 201, shared.text);
  assert.equal(shared.json.title, "Banana bread");
  assert.equal(shared.json.recipe.notes, "Use brown bananas");

  // sam has no Recipe box to save to.
  assert.match((await api(sam, "POST", `posts/${shared.json.id}/save`)).json.error, /Recipe box/);
  const other = (await api(sam, "POST", "posts", { category: baking, title: "Shortbread", recipe: RECIPE })).json;
  const saved = await api(ryan, "POST", `posts/${other.id}/save`);
  assert.equal(saved.status, 201, saved.text);
  assert.equal(saved.json.already, false);
  assert.equal(saved.json.recipe.title, "Shortbread");
  assert.match(saved.json.recipe.notes, /Recipe board \(Baking\), shared by Sam/);
  const again = await api(ryan, "POST", `posts/${other.id}/save`);
  assert.equal(again.status, 200);
  assert.equal(again.json.already, true);
  assert.equal(again.json.recipe.id, saved.json.recipe.id);
  assert.equal((await ryan.get("/recipes/api/recipes")).json.recipes.length, 2);
  const post = (await api(ryan, "GET", `posts/${other.id}`)).json;
  assert.equal(post.saved, true);
  assert.equal(post.saves, 1);
  assert.deepEqual((await api(ryan, "GET", "posts?view=saved")).json.posts.map(p => p.title), ["Shortbread"]);
  // Deleting it from your box and saving again makes a new copy.
  await ryan.req("DELETE", `/recipes/api/recipes/${saved.json.recipe.id}`);
  assert.equal((await api(ryan, "POST", `posts/${other.id}/save`)).json.already, false);
});

test("only the author (or an admin) changes or deletes a post", async () => {
  const env = makeEnv(), ryan = await member(env, "ryan"), sam = await member(env, "sam");
  const [baking, dessert] = [await catId(ryan, "Baking"), await catId(ryan, "Dessert")];
  const p = (await api(ryan, "POST", "posts", { category: baking, title: "Brownies", recipe: RECIPE })).json;
  assert.equal((await api(sam, "GET", `posts/${p.id}`)).json.can_edit, false);
  assert.match((await api(sam, "PATCH", `posts/${p.id}`, { title: "Mine now" })).json.error, /only/);
  assert.match((await api(sam, "DELETE", `posts/${p.id}`)).json.error, /only/);
  const moved = await api(ryan, "PATCH", `posts/${p.id}`, { category: dessert, title: "Fudgy brownies" });
  assert.equal(moved.json.category_name, "Dessert");
  assert.equal(moved.json.title, "Fudgy brownies");
  assert.equal((await api(ryan, "PATCH", `posts/${p.id}`, { title: "" })).status, 400);
  assert.equal((await api(ryan, "PATCH", `posts/${p.id}`, { recipe: null })).status, 400);
  assert.equal((await api(ryan, "DELETE", `posts/${p.id}`)).json.removed, true);
  assert.equal((await api(ryan, "GET", `posts/${p.id}`)).status, 404);
});

test("cross-origin writes are refused", async () => {
  const env = makeEnv(), ryan = await member(env, "ryan");
  const r = await ryan.req("POST", "/board/api/categories", { json: { name: "Evil" }, origin: "https://evil.test" });
  assert.equal(r.status, 403);
  assert.equal(sql(env, "SELECT * FROM board_categories WHERE name = 'Evil'").length, 0);
});

test("the recipe of the day is someone else's, the same all day", async () => {
  const env = makeEnv(), ryan = await member(env, "ryan"), sam = await member(env, "sam"), kim = await member(env, "kim");
  const baking = await catId(ryan, "Baking");
  assert.equal((await api(ryan, "GET", "board")).json.featured, null, "nothing on the board yet");
  await api(ryan, "POST", "posts", { category: baking, title: "Ryan's own", recipe: RECIPE });
  assert.equal((await api(ryan, "GET", "board")).json.featured, null, "never your own");
  for (const [b, t] of [[sam, "Scones"], [kim, "Flapjacks"], [sam, "Rolls"]]) await api(b, "POST", "posts", { category: baking, title: t, recipe: RECIPE });
  const day = d => api(ryan, "GET", `board?day=${d}`);
  const today = (await day("2026-11-10")).json.featured;
  assert.ok(["Scones", "Flapjacks", "Rolls"].includes(today.title));
  assert.equal(today.day, "2026-11-10");
  assert.ok(today.recipe.ingredients.length);
  assert.equal((await day("2026-11-10")).json.featured.id, today.id);
  // Over a month, more than one recipe gets a turn.
  const picks = new Set();
  for (let i = 1; i <= 30; i++) picks.add((await day(`2026-12-${String(i).padStart(2, "0")}`)).json.featured.title);
  assert.ok(picks.size > 1, [...picks].join());
  assert.ok(![...picks].includes("Ryan's own"));
  // A bad day falls back to today (UTC).
  assert.equal((await day("tomorrow")).json.featured.day, new Date().toISOString().slice(0, 10));
});
