// Recipe box's tools on the MCP server (src/mcp_recipes.js): who gets them,
// and each tool. Run with:  node --no-warnings --test tests/*.test.mjs
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps, sqlOne, run } from "./helpers.mjs";

const PW = "correct horse battery";
let rid = 0;

async function agent(env, name, ...apps) {
  const b = new Browser(env);
  assert.equal((await b.signup(name)).status, 303);
  grantApps(env, name, ...apps);
  const made = await b.post("/account/apikeys", { name: "agent", password: PW });
  const key = made.text.match(/sf_[A-Za-z0-9_-]{20,}/)?.[0];
  const raw = body => b.req("POST", "/mcp", { json: body, origin: null, cookie: null, headers: { Authorization: "Bearer " + key } });
  const rpc = async (method, params) => (await raw({ jsonrpc: "2.0", id: ++rid, method, params })).json;
  const call = async (tool, args = {}) => {
    const j = await rpc("tools/call", { name: tool, arguments: args });
    assert.ok(j.result, JSON.stringify(j));
    const text = j.result.content[0].text;
    return j.result.isError ? { error: text } : JSON.parse(text);
  };
  return { b, key, made, raw, rpc, call };
}
const names = async a => (await a.rpc("tools/list")).result.tools.map(t => t.name);
const userId = (env, name) => sqlOne(env, "SELECT id FROM users WHERE username = ?", name).id;

let realFetch, pages;
beforeEach(() => {
  realFetch = globalThis.fetch;
  pages = new Map();
  globalThis.fetch = async url => pages.has(String(url))
    ? new Response(pages.get(String(url)), { headers: { "Content-Type": "text/html" } }) : new Response("nope", { status: 404 });
});
afterEach(() => { globalThis.fetch = realFetch; });

test("recipe tools need Recipe box and its own toggle, which starts off", async () => {
  const env = makeEnv();
  const plain = await agent(env, "josh", "recipes");
  assert.ok((await names(plain)).every(n => n.startsWith("drift_")), "Recipe box alone isn't enough");
  assert.match((await plain.rpc("tools/call", { name: "recipes_search", arguments: {} })).error.message, /unknown tool/);

  const a = await agent(env, "ryan", "recipes", "recipes-mcp");
  const tools = await names(a);
  assert.ok(tools.includes("drift_get_state") && tools.includes("recipes_search") && tools.includes("recipes_shop"));
  const init = (await a.rpc("initialize", {})).result;
  assert.match(init.instructions, /Drift/);
  assert.match(init.instructions, /recipes_search/);

  // Without Drift, a key still works for recipes alone.
  run(env, "DELETE FROM user_areas WHERE area = 'todo' AND user_id = ?", userId(env, "ryan"));
  assert.ok((await names(a)).every(n => n.startsWith("recipes_")));
  assert.match((await a.rpc("tools/call", { name: "drift_get_state", arguments: {} })).error.message, /unknown tool/);
  const page = (await a.b.get("/account")).text;
  assert.match(page, /in Recipe box: find/);
  assert.doesNotMatch(page, /in Drift:/);

  // And with neither, the key is refused.
  run(env, "DELETE FROM user_areas WHERE area = 'recipes-mcp' AND user_id = ?", userId(env, "ryan"));
  const refused = await a.raw({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(refused.status, 403);
});

test("a person with Recipe box for AI agents but no Drift can make a key", async () => {
  const env = makeEnv(), b = new Browser(env);
  await b.signup("sam");
  run(env, "DELETE FROM user_areas WHERE area = 'todo'");
  assert.doesNotMatch((await b.get("/account")).text, /id="apikeys"/);
  assert.equal((await b.post("/account/apikeys", { name: "x", password: PW })).status, 403);
  grantApps(env, "sam", "recipes", "recipes-mcp");
  const made = await b.post("/account/apikeys", { name: "x", password: PW });
  assert.match(made.text, /claude mcp add --transport http recipes /);
});

test("create, search, get scaled, update, made it, and labels", async () => {
  const env = makeEnv(), a = await agent(env, "ryan", "recipes", "recipes-mcp");
  run(env, "INSERT INTO recipe_labels (id, key, value, created) VALUES ('l_00000000aa', 'Season', 'Fall', '2026-01-01'), ('l_00000000bb', 'Course', 'Dinner', '2026-01-01')");
  assert.equal((await a.call("recipes_labels")).labels.length, 2);

  const soup = await a.call("recipes_create", { title: "Squash soup", yield: "Serves 4", ingredients: ["2 cups squash", "1 onion", "salt"], steps: ["Roast.", "Blend."], labels: ["l_00000000aa"] });
  assert.match(soup.id, /^r_[0-9a-f]{10}$/);
  assert.equal(soup.servings, 4);
  assert.deepEqual(soup.labels.map(l => l.value), ["Fall"]);
  const salad = await a.call("recipes_create", { title: "Walnut salad", ingredients: ["1 cup walnuts", "spinach"] });
  assert.match((await a.call("recipes_create", {})).error, /title/);
  assert.match((await a.call("recipes_create", { title: "x", labels: ["l_ffffffffff"] })).error, /label/);

  const all = await a.call("recipes_search");
  assert.equal(all.total, 2);
  assert.deepEqual(all.recipes.map(r => r.title), ["Squash soup", "Walnut salad"]);
  assert.equal(all.recipes[0].steps, undefined, "summaries leave out steps");
  assert.deepEqual((await a.call("recipes_search", { query: "BLEND" })).recipes.map(r => r.id), [], "steps aren't searched");
  assert.deepEqual((await a.call("recipes_search", { query: "fall" })).recipes.map(r => r.id), [soup.id]);
  const byIngredient = await a.call("recipes_search", { ingredients: "onions, -nuts" });
  assert.deepEqual(byIngredient.recipes.map(r => r.id), [soup.id]);
  assert.deepEqual(byIngredient.recipes[0].matching_ingredients, ["1 onion"]);
  assert.deepEqual((await a.call("recipes_search", { ingredients: "-nuts" })).recipes.map(r => r.id), [soup.id]);
  assert.deepEqual((await a.call("recipes_search", { labels: ["season: fall"] })).recipes.map(r => r.id), [soup.id]);
  assert.deepEqual((await a.call("recipes_search", { labels: ["Season"] })).recipes.map(r => r.id), [soup.id]);
  assert.match((await a.call("recipes_search", { labels: ["Mood: Happy"] })).error, /no label/);
  const paged = await a.call("recipes_search", { limit: 1 });
  assert.equal(paged.next_cursor, "1");
  assert.equal((await a.call("recipes_search", { limit: 1, cursor: paged.next_cursor })).recipes[0].id, salad.id);

  const scaled = await a.call("recipes_get", { id: soup.id, servings: 8 });
  assert.deepEqual(scaled.ingredients, ["4 cups squash", "2 onion", "salt"]);
  assert.deepEqual(scaled.original_ingredients, soup.ingredients);
  assert.equal(scaled.scaled.servings, 8);
  assert.deepEqual((await a.call("recipes_get", { id: soup.id })).steps, ["Roast.", "Blend."]);
  assert.match((await a.call("recipes_get", { id: "r_0000000000" })).error, /not found/);
  assert.match((await a.call("recipes_get", { id: "nope" })).error, /recipe id/);

  const changed = await a.call("recipes_update", { id: salad.id, notes: "Toast the nuts.", labels: ["l_00000000bb"] });
  assert.equal(changed.notes, "Toast the nuts.");
  assert.equal(changed.title, "Walnut salad");
  assert.match((await a.call("recipes_update", { id: salad.id, rating: 9 })).error, /rating/);

  const made = await a.call("recipes_made_it", { id: soup.id, day: "2026-03-05", rating: 5 });
  assert.equal(made.made, "2026-03-05");
  assert.equal(made.rating, 5);
  assert.match((await a.call("recipes_made_it", { id: soup.id, day: "yesterday" })).error, /YYYY-MM-DD/);
  assert.deepEqual((await a.call("recipes_search", { made: true })).recipes.map(r => r.id), [soup.id]);
  assert.deepEqual((await a.call("recipes_search", { made: false })).recipes.map(r => r.id), [salad.id]);
  assert.deepEqual((await a.call("recipes_search", { min_rating: 4 })).recipes.map(r => r.id), [soup.id]);
  assert.equal((await a.call("recipes_search", { sort: "rating" })).recipes[0].id, soup.id);
});

test("recipes_create reads a recipe page from a link", async () => {
  const env = makeEnv(), a = await agent(env, "ryan", "recipes", "recipes-mcp");
  pages.set("https://food.test/pie", `<html><head><script type="application/ld+json">{"@type":"Recipe","name":"Apple pie","recipeYield":"8",
    "recipeIngredient":["6 apples","1 crust"],"recipeInstructions":["Bake."]}</script></head></html>`);
  pages.set("https://food.test/blog", "<html><body>just words</body></html>");
  const pie = await a.call("recipes_create", { url: "https://food.test/pie", rating: 4 });
  assert.equal(pie.title, "Apple pie");
  assert.equal(pie.servings, 8);
  assert.equal(pie.rating, 4);
  assert.equal(pie.source, "https://food.test/pie");
  assert.match((await a.call("recipes_create", { url: "https://food.test/blog" })).error, /couldn't find a recipe/);
});

test("someone else's recipes can't be read or changed", async () => {
  const env = makeEnv(), a = await agent(env, "ryan", "recipes", "recipes-mcp"), s = await agent(env, "sam", "recipes", "recipes-mcp");
  const mine = await a.call("recipes_create", { title: "Secret sauce" });
  assert.equal((await s.call("recipes_search")).total, 0);
  assert.match((await s.call("recipes_get", { id: mine.id })).error, /not found/);
  assert.match((await s.call("recipes_update", { id: mine.id, title: "Mine now" })).error, /not found/);
  assert.equal((await a.call("recipes_get", { id: mine.id })).title, "Secret sauce");
});

test("recipes_shop puts the scaled ingredients on a Drift list", async () => {
  const env = makeEnv(), a = await agent(env, "ryan", "recipes", "recipes-mcp");
  const r = await a.call("recipes_create", { title: "Pancakes", yield: "4", ingredients: ["2 eggs", "1 cup milk", "flour"] });
  const out = await a.call("recipes_shop", { id: r.id, servings: 8, lines: [0, 1] });
  assert.equal(out.added, 2);
  assert.equal(out.list.name, "Shopping list");
  assert.match(out.summary, /Added 2 items to Shopping list/);
  const items = (await a.call("drift_get_state", { collection: out.list.id })).items;
  assert.deepEqual(items.map(i => i.title).sort(), ["Eggs", "Milk"].sort());
  assert.ok(items.some(i => i.notes === "4 for Pancakes (8 servings)"), JSON.stringify(items));

  run(env, "DELETE FROM user_areas WHERE area = 'todo'");
  assert.match((await a.call("recipes_shop", { id: r.id })).error, /need Drift/);
});
