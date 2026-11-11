// Tests for the Recipe board: recipes shared on it, filed under the keys of
// their labels (Recipe labels' list), following the keys you like, the feed of
// what's new in them, and saving a post into your Recipe box.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps, sql, run } from "./helpers.mjs";
import { db } from "../src/db.js";

async function member(env, name, ...apps) {
  const b = new Browser(env);
  await b.signup(name, undefined, name[0].toUpperCase() + name.slice(1));
  grantApps(env, name, "board", ...apps);
  return b;
}
const api = (b, method, path, json) => b.req(method, "/board/api/" + path, { json });
const RECIPE = { ingredients: ["2 cups flour", "1 egg"], steps: ["Mix", "Bake"], servings: 4 };
// The label list the board's categories come from: Course (Baking, Dinner, Dessert, Quick), Season (Fall), Cuisine (Irish).
const L = { baking: "l_0000000001", dinner: "l_0000000002", dessert: "l_0000000003", quick: "l_0000000004", fall: "l_0000000005", irish: "l_0000000006" };
function labelList(env) {
  const t = new Date().toISOString();
  for (const [k, id] of Object.entries(L)) {
    const key = k === "fall" ? "Season" : k === "irish" ? "Cuisine" : "Course";
    run(env, "INSERT INTO recipe_labels (id, key, value, created) VALUES (?, ?, ?, ?)", id, key, k[0].toUpperCase() + k.slice(1), t);
  }
}
const board = async () => { const env = makeEnv(); await db(env); labelList(env); return env; };

test("Recipe board is off until an admin turns it on", async () => {
  const env = await board(), josh = new Browser(env);
  await josh.signup("josh");
  assert.equal((await josh.get("/board/")).status, 403);
  assert.equal((await josh.get("/board/api/board")).status, 403);
  grantApps(env, "josh", "board");
  assert.equal((await josh.get("/board/")).status, 200);
  assert.equal((await josh.get("/board")).status, 308);
  const b = (await josh.get("/board/api/board")).json;
  // The categories are the label keys, by name, each with its values.
  assert.deepEqual(b.categories.map(c => c.name), ["Course", "Cuisine", "Season"]);
  assert.deepEqual(b.categories[0].values.map(v => v.value), ["Baking", "Dessert", "Dinner", "Quick"]);
  assert.equal(b.label_list.length, 6);
  assert.equal(b.recipe_box, false);
  assert.equal(b.can_label, false);
  assert.equal(b.unread, 0);
  assert.ok(b.categories.every(c => !c.following && c.posts === 0 && !c.can_delete));
});

test("posting: typed in, with a title, a recipe, and labels that file it", async () => {
  const env = await board(), ryan = await member(env, "ryan");
  for (const bad of [{ recipe: RECIPE }, { title: "x" }, { title: "x", recipe: { ingredients: [] } },
    { title: "x", recipe: RECIPE, colour: "red" }, { title: "x", recipe: RECIPE, category: "c_0000000000" },
    { title: "x", recipe: RECIPE, labels: ["l_00000000ff"] }, { title: "x", recipe: RECIPE, labels: "Course: Dinner" }]) {
    assert.equal((await api(ryan, "POST", "posts", bad)).status, 400, JSON.stringify(bad));
  }
  const p = await api(ryan, "POST", "posts", { title: "Lasagne", note: "Best on day two.", labels: [L.dinner, L.irish, L.quick], recipe: { ...RECIPE, title: "ignored" } });
  assert.equal(p.status, 201, p.text);
  assert.equal(p.json.title, "Lasagne");
  // In both of its keys, once each.
  assert.deepEqual(p.json.categories, ["Course", "Cuisine"]);
  assert.deepEqual(p.json.recipe.labels.map(l => l.value), ["Dinner", "Quick", "Irish"]);
  assert.equal(p.json.by, "Ryan");
  assert.equal(p.json.can_edit, true);
  assert.deepEqual(p.json.recipe.ingredients, RECIPE.ingredients);
  assert.equal(p.json.recipe.servings, 4);
  // No labels is fine: it's on the board, just in no category.
  assert.deepEqual((await api(ryan, "POST", "posts", { title: "Toast", recipe: RECIPE })).json.categories, []);
  const course = (await api(ryan, "GET", "board")).json.categories[0];
  assert.equal(course.posts, 1);
  assert.deepEqual(course.values.map(v => [v.value, v.posts]), [["Baking", 0], ["Dessert", 0], ["Dinner", 1], ["Quick", 1]]);
  // Sharing from your Recipe box needs it turned on.
  assert.match((await api(ryan, "POST", "posts", { recipe_id: "r_0000000000" })).json.error, /Recipe box/);
});

test("the feed: new posts in the keys you follow, marked read when you look", async () => {
  const env = await board(), ryan = await member(env, "ryan"), sam = await member(env, "sam");
  assert.equal((await api(sam, "PUT", "categories/course/follow", { follow: true })).json.following, true, "any case");
  assert.equal((await api(sam, "PUT", "categories/Course/follow", { follow: true })).json.followers, 1, "once");
  assert.equal((await api(sam, "PUT", "categories/Course/follow", {})).status, 400);
  assert.equal((await api(sam, "PUT", "categories/Colour/follow", { follow: true })).status, 404);

  await api(ryan, "POST", "posts", { labels: [L.baking], title: "Scones", recipe: RECIPE });
  await api(ryan, "POST", "posts", { labels: [L.irish], title: "Curry", recipe: RECIPE });
  await api(sam, "POST", "posts", { labels: [L.baking, L.fall], title: "Sam's bread", recipe: RECIPE });

  assert.equal((await api(sam, "GET", "board")).json.unread, 1, "your own posts aren't news to you");
  const feed = (await api(sam, "GET", "posts?view=feed")).json;
  assert.deepEqual(feed.posts.map(p => [p.title, p.new]), [["Sam's bread", false], ["Scones", true]]);
  assert.equal(feed.more, false);
  assert.equal((await api(sam, "GET", "board")).json.unread, 0);
  assert.deepEqual((await api(sam, "GET", "posts?view=feed")).json.posts.map(p => p.new), [false, false]);

  // Other views, one key whether you follow it or not, and one value of a key.
  assert.deepEqual((await api(sam, "GET", "posts?view=all")).json.posts.map(p => p.title), ["Sam's bread", "Curry", "Scones"]);
  assert.deepEqual((await api(sam, "GET", "posts?view=mine")).json.posts.map(p => p.title), ["Sam's bread"]);
  assert.deepEqual((await api(sam, "GET", "posts?category=cuisine")).json.posts.map(p => p.title), ["Curry"]);
  assert.deepEqual((await api(sam, "GET", "posts?category=Season")).json.posts.map(p => p.title), ["Sam's bread"]);
  assert.deepEqual((await api(sam, "GET", `posts?label=${L.baking}`)).json.posts.map(p => p.title), ["Sam's bread", "Scones"]);
  assert.equal((await api(sam, "GET", "posts?label=Baking")).status, 400);
  assert.equal((await api(sam, "GET", "posts?view=nope")).status, 400);

  // Unfollowing takes it out of the feed.
  await api(sam, "PUT", "categories/Course/follow", { follow: false });
  assert.deepEqual((await api(sam, "GET", "posts?view=feed")).json.posts, []);
});

test("following one value of a key: just its posts reach your feed", async () => {
  const env = await board(), ryan = await member(env, "ryan"), sam = await member(env, "sam"), kim = await member(env, "kim", "labels");
  await api(ryan, "POST", "posts", { labels: [L.baking, L.fall], title: "Apple cake", recipe: RECIPE });
  await api(ryan, "POST", "posts", { labels: [L.dinner], title: "Stew", recipe: RECIPE });
  await api(ryan, "POST", "posts", { labels: [L.irish], title: "Soda bread", recipe: RECIPE });

  // Course: Baking, not all of Course.
  const v = (await api(sam, "PUT", `labels/${L.baking}/follow`, { follow: true })).json;
  assert.deepEqual([v.id, v.value, v.following, v.followers], [L.baking, "Baking", true, 1]);
  assert.equal((await api(sam, "PUT", `labels/${L.baking}/follow`, { follow: true })).json.followers, 1, "once");
  assert.equal((await api(sam, "PUT", `labels/${L.baking}/follow`, {})).status, 400);
  assert.equal((await api(sam, "PUT", "labels/l_00000000ff/follow", { follow: true })).status, 404);
  assert.equal((await api(sam, "PUT", "labels/Baking/follow", { follow: true })).status, 404);
  assert.equal((await api(sam, "GET", `labels/${L.baking}/follow`)).status, 405);
  let b = (await api(sam, "GET", "board")).json;
  const course = b.categories.find(c => c.name === "Course");
  assert.equal(course.following, false);
  assert.deepEqual(course.values.filter(x => x.following).map(x => x.value), ["Baking"]);
  assert.equal(b.unread, 1);
  assert.deepEqual((await api(sam, "GET", "posts?view=feed")).json.posts.map(p => p.title), ["Apple cake"]);

  // Following a value and the whole key of another: both, once each.
  await api(sam, "PUT", "categories/Cuisine/follow", { follow: true });
  await api(sam, "PUT", `labels/${L.fall}/follow`, { follow: true });
  assert.deepEqual((await api(sam, "GET", "posts?view=feed")).json.posts.map(p => p.title), ["Soda bread", "Apple cake"]);

  // Unfollowing the value takes it back out; the key's follow is its own.
  await api(sam, "PUT", `labels/${L.baking}/follow`, { follow: false });
  await api(sam, "PUT", `labels/${L.fall}/follow`, { follow: false });
  assert.deepEqual((await api(sam, "GET", "posts?view=feed")).json.posts.map(p => p.title), ["Soda bread"]);

  // A value taken off Recipe labels (or its whole key) takes its follows with it.
  await api(sam, "PUT", `labels/${L.dinner}/follow`, { follow: true });
  await api(sam, "PUT", `labels/${L.fall}/follow`, { follow: true });
  assert.equal((await kim.req("DELETE", `/labels/api/labels/${L.dinner}`)).status, 200);
  assert.equal((await api(kim, "DELETE", "categories/Season")).json.removed, 1);
  assert.deepEqual(sql(env, "SELECT category FROM board_follows").map(r => r.category), ["Cuisine"]);
});

test("the feed pages back through older posts", async () => {
  const env = await board(), ryan = await member(env, "ryan");
  await api(ryan, "PUT", "categories/Course/follow", { follow: true });
  for (let i = 0; i < 45; i++) {
    await api(ryan, "POST", "posts", { labels: [L.quick], title: `Dish ${i}`, recipe: RECIPE });
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
  const env = await board(), ryan = await member(env, "ryan", "recipes"), sam = await member(env, "sam");
  const mine = (await ryan.req("POST", "/recipes/api/recipes", { json: { title: "Banana bread", ...RECIPE, notes: "Use brown bananas" } })).json;
  const shared = await api(ryan, "POST", "posts", { recipe_id: mine.id, note: "Freezes well" });
  assert.equal(shared.status, 201, shared.text);
  assert.equal(shared.json.title, "Banana bread");
  assert.equal(shared.json.recipe.notes, "Use brown bananas");

  // sam has no Recipe box to save to.
  assert.match((await api(sam, "POST", `posts/${shared.json.id}/save`)).json.error, /Recipe box/);
  const other = (await api(sam, "POST", "posts", { labels: [L.baking], title: "Shortbread", recipe: RECIPE })).json;
  const saved = await api(ryan, "POST", `posts/${other.id}/save`);
  assert.equal(saved.status, 201, saved.text);
  assert.equal(saved.json.already, false);
  assert.equal(saved.json.recipe.title, "Shortbread");
  assert.match(saved.json.recipe.notes, /From the Recipe board, shared by Sam/);
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
  const env = await board(), ryan = await member(env, "ryan"), sam = await member(env, "sam");
  const p = (await api(ryan, "POST", "posts", { labels: [L.baking], title: "Brownies", recipe: RECIPE })).json;
  assert.equal((await api(sam, "GET", `posts/${p.id}`)).json.can_edit, false);
  assert.match((await api(sam, "PATCH", `posts/${p.id}`, { title: "Mine now" })).json.error, /only/);
  assert.match((await api(sam, "DELETE", `posts/${p.id}`)).json.error, /only/);
  const moved = await api(ryan, "PATCH", `posts/${p.id}`, { labels: [L.dessert, L.fall], title: "Fudgy brownies" });
  assert.deepEqual(moved.json.categories, ["Course", "Season"]);
  assert.deepEqual(moved.json.recipe.labels.map(l => l.value), ["Dessert", "Fall"]);
  assert.equal((await api(ryan, "PATCH", `posts/${p.id}`, { labels: ["l_00000000ff"] })).status, 400);
  assert.equal(moved.json.title, "Fudgy brownies");
  assert.equal((await api(ryan, "PATCH", `posts/${p.id}`, { title: "" })).status, 400);
  assert.equal((await api(ryan, "PATCH", `posts/${p.id}`, { recipe: null })).status, 400);
  assert.equal((await api(ryan, "DELETE", `posts/${p.id}`)).json.removed, true);
  assert.equal((await api(ryan, "GET", `posts/${p.id}`)).status, 404);
});

test("cross-origin writes are refused", async () => {
  const env = await board(), ryan = await member(env, "ryan");
  const r = await ryan.req("POST", "/board/api/posts", { json: { title: "Evil", recipe: RECIPE }, origin: "https://evil.test" });
  assert.equal(r.status, 403);
  assert.equal(sql(env, "SELECT * FROM board_posts").length, 0);
});

test("the recipe of the day is someone else's, the same all day", async () => {
  const env = await board(), ryan = await member(env, "ryan"), sam = await member(env, "sam"), kim = await member(env, "kim");
  assert.equal((await api(ryan, "GET", "board")).json.featured, null, "nothing on the board yet");
  await api(ryan, "POST", "posts", { title: "Ryan's own", recipe: RECIPE });
  assert.equal((await api(ryan, "GET", "board")).json.featured, null, "never your own");
  for (const [b, t] of [[sam, "Scones"], [kim, "Flapjacks"], [sam, "Rolls"]]) await api(b, "POST", "posts", { title: t, recipe: RECIPE });
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

test("a recipe's labels go to the board and back into Recipe box", async () => {
  const env = await board(), ryan = await member(env, "ryan", "recipes"), sam = await member(env, "sam", "recipes");
  const mine = (await ryan.req("POST", "/recipes/api/recipes", { json: { title: "Stew", ...RECIPE, labels: [L.fall, L.irish] } })).json;
  const p = (await api(ryan, "POST", "posts", { recipe_id: mine.id })).json;
  assert.deepEqual(p.recipe.labels, mine.labels);
  assert.deepEqual(p.categories, ["Cuisine", "Season"]);
  const saved = (await api(sam, "POST", `posts/${p.id}/save`)).json.recipe;
  assert.deepEqual(saved.labels.map(l => l.value), ["Irish", "Fall"]);
  // A label taken off the list comes off posts too.
  run(env, "DELETE FROM recipe_labels WHERE id = ?", L.irish);
  assert.deepEqual((await api(sam, "GET", `posts/${p.id}`)).json.recipe.labels.map(l => l.value), ["Fall"]);
});

test("a post from your Recipe box is that recipe: changes either side show on the other", async () => {
  const env = await board(), ryan = await member(env, "ryan", "recipes"), sam = await member(env, "sam");
  const mine = (await ryan.req("POST", "/recipes/api/recipes", { json: { title: "Stew", ...RECIPE, labels: [L.fall] } })).json;
  const p = (await api(ryan, "POST", "posts", { recipe_id: mine.id, note: "Good cold too" })).json;
  assert.equal(p.from_box, true);
  assert.equal(p.recipe_id, mine.id);
  const theirs = async () => (await api(sam, "GET", `posts/${p.id}`)).json;
  assert.equal((await theirs()).recipe_id, undefined);

  // A label added in the box files the post under its key, for everyone.
  await ryan.req("PATCH", `/recipes/api/recipes/${mine.id}`, { json: { labels: [L.fall, L.irish], ingredients: ["3 potatoes"], title: "Irish stew" } });
  let seen = await theirs();
  assert.deepEqual(seen.categories, ["Cuisine", "Season"]);
  assert.deepEqual(seen.recipe.ingredients, ["3 potatoes"]);
  assert.equal(seen.title, "Irish stew");
  assert.equal(seen.note, "Good cold too");
  assert.deepEqual((await api(sam, "GET", "posts?category=Cuisine")).json.posts.map(x => x.id), [p.id]);
  // Its picture too.
  await ryan.req("PATCH", `/recipes/api/recipes/${mine.id}`, { json: { image: "https://example.com/stew.jpg" } });
  assert.equal((await theirs()).recipe.image, "https://example.com/stew.jpg");
  await ryan.req("DELETE", `/recipes/api/recipes/${mine.id}/photo`);
  assert.equal((await theirs()).recipe.image, "");

  // Editing the post edits the box recipe.
  const e = await api(ryan, "PATCH", `posts/${p.id}`, { title: "Stew for a crowd", labels: [L.dinner], recipe: { ingredients: "6 potatoes", steps: "Simmer" } });
  assert.equal(e.status, 200, e.text);
  const box = (await ryan.req("GET", "/recipes/api/recipes")).json.recipes.find(r => r.id === mine.id);
  assert.equal(box.title, "Stew for a crowd");
  assert.deepEqual(box.labels.map(l => l.value), ["Dinner"]);
  assert.deepEqual(box.ingredients, ["6 potatoes"]);
  // Labels picked while sharing are the recipe's in the box too.
  const pie = (await ryan.req("POST", "/recipes/api/recipes", { json: { title: "Pie", ...RECIPE } })).json;
  await api(ryan, "POST", "posts", { recipe_id: pie.id, labels: [L.dessert] });
  assert.deepEqual((await ryan.req("GET", "/recipes/api/recipes")).json.recipes.find(r => r.id === pie.id).labels.map(l => l.value), ["Dessert"]);

  // Deleted from the box, the post stays as it last was.
  await ryan.req("DELETE", `/recipes/api/recipes/${mine.id}`);
  seen = await theirs();
  assert.equal(seen.title, "Stew for a crowd");
  assert.equal(seen.from_box, false);
});

test("a post shared before posts kept in step is linked to its recipe on the recipe's next change", async () => {
  const env = await board(), ryan = await member(env, "ryan", "recipes");
  const mine = (await ryan.req("POST", "/recipes/api/recipes", { json: { title: "Soda bread", ...RECIPE } })).json;
  const p = (await api(ryan, "POST", "posts", { recipe_id: mine.id })).json;
  // As posts were stored before: a copy, with nothing pointing back at the recipe.
  run(env, "UPDATE board_posts SET data = json_remove(data, '$.from') WHERE id = ?", p.id);
  const typed = (await api(ryan, "POST", "posts", { title: "Soda bread", recipe: { ...RECIPE, ingredients: ["something else"] } })).json;
  await ryan.req("PATCH", `/recipes/api/recipes/${mine.id}`, { json: { labels: [L.irish] } });
  const after = (await api(ryan, "GET", `posts/${p.id}`)).json;
  assert.deepEqual(after.categories, ["Cuisine"]);
  assert.equal(after.recipe_id, mine.id);
  // One typed in with the same name but a different recipe is left alone.
  assert.deepEqual((await api(ryan, "GET", `posts/${typed.id}`)).json.categories, []);
});

test("removing a category is removing its key, for whoever keeps Recipe labels", async () => {
  const env = await board(), ryan = await member(env, "ryan"), kim = await member(env, "kim", "labels");
  await api(ryan, "PUT", "categories/Season/follow", { follow: true });
  const p = (await api(ryan, "POST", "posts", { labels: [L.fall, L.baking], title: "Apple cake", recipe: RECIPE })).json;
  assert.match((await api(ryan, "DELETE", "categories/Season")).json.error, /Recipe labels/);
  assert.equal((await api(kim, "GET", "board")).json.can_label, true);
  assert.equal((await api(kim, "DELETE", "categories/season")).json.removed, 1);
  assert.equal((await api(kim, "DELETE", "categories/Season")).status, 404);
  assert.deepEqual((await api(ryan, "GET", "board")).json.categories.map(c => c.name), ["Course", "Cuisine"]);
  assert.equal(sql(env, "SELECT * FROM board_follows").length, 0);
  // The post stays, under the keys it has left.
  assert.deepEqual((await api(ryan, "GET", `posts/${p.id}`)).json.categories, ["Course"]);
});
