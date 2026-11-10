// Tests for Suggest labels: Recipe box finding labels from the Recipe labels
// list in a recipe's own words (src/autolabel.js), checked, then added in bulk.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps } from "./helpers.mjs";
import { suggestFor, splitKeywords, normalize } from "../src/autolabel.js";

const L = (id, key, value, keywords = "") => ({ id, key, value, keywords });
const LIST = [
  L("l_0000000001", "Cuisine", "Irish"),
  L("l_0000000002", "Season", "Fall", "pumpkin, squash, apple cider, -fall apart"),
  L("l_0000000003", "Diet", "Vegetarian"),
  L("l_0000000004", "Favorite", ""),
  L("l_0000000005", "Course", "Dessert", "cake, cookie, brownie"),
  L("l_0000000006", "Main", "Berry", ""),
];
const names = list => list.map(l => `${l.value || l.key}:${l.word}@${l.where}`);

test("a label's value and keywords are matched as whole words, any case or accent, plurals too", () => {
  assert.equal(normalize("Crème  Brûlée!"), " creme brulee ");
  const r = { title: "Irish Stew", ingredients: ["2 cups PUMPKINS, cubed", "1 tsp salt"], steps: ["Simmer."], notes: "" };
  assert.deepEqual(names(suggestFor(r, LIST)), ["Irish:irish@title", "Fall:pumpkins@ingredients"]);
  // A phrase, with its last word's plural; -y words to -ies.
  assert.deepEqual(names(suggestFor({ title: "Warm apple ciders", ingredients: ["mixed berries"] }, LIST)), ["Fall:apple ciders@title", "Berry:berries@ingredients"]);
  // Not inside another word: "cake" isn't in "pancakes", "irish" isn't in "irishman" (well, it isn't a plural of it).
  assert.deepEqual(names(suggestFor({ title: "Pancakes", ingredients: ["squashed garlic"], steps: ["Serve the irishman"] }, LIST)), []);
  // A label with no value (Favorite) only matches its keywords, and it has none.
  assert.deepEqual(names(suggestFor({ title: "My favorite cookies" }, LIST)), ["Dessert:cookies@title"]);
});

test("a -keyword is a phrase to ignore, and labels the recipe has aren't suggested again", () => {
  const r = { title: "Pot roast", steps: ["Cook until it falls apart.", "Let the meat fall apart"] };
  assert.deepEqual(suggestFor(r, LIST), []);
  // The ignored phrase doesn't hide a real match elsewhere.
  assert.deepEqual(names(suggestFor({ ...r, notes: "Best in the fall" }, LIST)), ["Fall:fall@notes"]);
  const pie = { title: "Pumpkin cake", labels: [{ id: "l_0000000002" }] };
  assert.deepEqual(names(suggestFor(pie, LIST)), ["Dessert:cake@title"]);
  assert.deepEqual(splitKeywords(" pumpkin,Squash ,, pumpkin, - fall apart, -"), ["pumpkin", "Squash", "-fall apart"]);
});

async function member(env, name, ...apps) {
  const b = new Browser(env);
  await b.signup(name);
  grantApps(env, name, ...apps);
  return b;
}

test("Suggest labels across the box, then adding the ones kept", async () => {
  const env = makeEnv(), kim = await member(env, "kim", "labels", "recipes"), ryan = await member(env, "ryan", "recipes");
  const [fall] = (await kim.req("POST", "/labels/api/labels", { json: { key: "Season", values: "Fall, Winter" } })).json.added;
  const [irish] = (await kim.req("POST", "/labels/api/labels", { json: { key: "Cuisine", values: "Irish" } })).json.added;
  // Keywords are set on a label in Recipe labels, and read back there.
  const set = await kim.req("PATCH", `/labels/api/labels/${fall.id}`, { json: { keywords: "pumpkin, squash, pumpkin" } });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.json.keywords, "pumpkin, squash");
  assert.equal((await kim.get("/labels/api/labels")).json.labels.find(l => l.id === fall.id).keywords, "pumpkin, squash");
  assert.equal((await kim.req("PATCH", `/labels/api/labels/${fall.id}`, { json: { keywords: "x".repeat(61) } })).status, 400);
  assert.equal((await kim.req("PATCH", `/labels/api/labels/${fall.id}`, { json: { keywords: 5 } })).status, 400);

  const add = json => ryan.req("POST", "/recipes/api/recipes", { json });
  const pie = (await add({ title: "Pumpkin pie", ingredients: ["1 can pumpkin"] })).json;
  const stew = (await add({ title: "Irish stew", ingredients: ["2 lb lamb", "1 butternut squash"], labels: [irish.id] })).json;
  await add({ title: "Toast", ingredients: ["bread"] });
  const kims = (await kim.req("POST", "/recipes/api/recipes", { json: { title: "Kim's pumpkin bread" } })).json;

  const out = (await ryan.get("/recipes/api/recipes/suggest-labels")).json;
  assert.equal(out.checked, 3);
  assert.equal(out.labels, 3);
  assert.deepEqual(out.suggestions.map(s => [s.title, s.labels.map(l => `${l.key}: ${l.value} (${l.word} in ${l.where})`)]), [
    ["Irish stew", ["Season: Fall (squash in ingredients)"]],
    ["Pumpkin pie", ["Season: Fall (pumpkin in title)"]],
  ]);

  // Only your own recipes are changed, and what they have is kept.
  const done = await ryan.req("POST", "/recipes/api/recipes/add-labels", { json: { add: [
    { id: pie.id, labels: [fall.id] }, { id: stew.id, labels: [fall.id, irish.id] }, { id: kims.id, labels: [fall.id] },
  ] } });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(done.json, { recipes: 2, labels: 2, full: 0 });
  const box = (await ryan.get("/recipes/api/recipes")).json.recipes;
  assert.deepEqual(box.map(r => [r.title, r.labels.map(l => l.value)]), [["Irish stew", ["Irish", "Fall"]], ["Pumpkin pie", ["Fall"]], ["Toast", []]]);
  assert.deepEqual((await kim.get("/recipes/api/recipes")).json.recipes[0].labels, []);
  assert.deepEqual((await ryan.get("/recipes/api/recipes/suggest-labels")).json.suggestions, []);

  for (const bad of [{}, { add: [{ id: "nope", labels: [] }] }, { add: [{ id: pie.id, labels: ["l_00000000ff"] }] },
    { add: Array.from({ length: 201 }, () => ({ id: pie.id, labels: [] })) }]) {
    assert.equal((await ryan.req("POST", "/recipes/api/recipes/add-labels", { json: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await ryan.req("POST", "/recipes/api/recipes/suggest-labels")).status, 405);
  assert.equal((await ryan.req("POST", "/recipes/api/recipes/add-labels", { json: { add: [] }, origin: "https://evil.test" })).status, 403);
});

test("a recipe with its 20 labels gets no more", async () => {
  const env = makeEnv(), kim = await member(env, "kim", "labels", "recipes");
  const many = (await kim.req("POST", "/labels/api/labels", { json: { key: "Tag", values: Array.from({ length: 21 }, (_, i) => `t${i}`) } })).json.added;
  const r = (await kim.req("POST", "/recipes/api/recipes", { json: { title: "t0 t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 t11 t12 t13 t14 t15 t16 t17 t18 t19 t20", labels: many.slice(0, 19).map(l => l.id) } })).json;
  const s = (await kim.get("/recipes/api/recipes/suggest-labels")).json.suggestions;
  assert.deepEqual(s.map(x => x.labels.length), [1]);
  const out = (await kim.req("POST", "/recipes/api/recipes/add-labels", { json: { add: [{ id: r.id, labels: many.slice(19).map(l => l.id) }] } })).json;
  assert.deepEqual(out, { recipes: 1, labels: 1, full: 1 });
});
