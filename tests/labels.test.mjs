// Tests for Recipe labels: the one list of labels recipes tick and the Recipe
// board files posts under, kept by whoever has the app.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps, sql } from "./helpers.mjs";
import { splitValues } from "../src/labels.js";

async function member(env, name, ...apps) {
  const b = new Browser(env);
  await b.signup(name);
  if (apps.length) grantApps(env, name, ...apps);
  return b;
}
const api = (b, method, path, json) => b.req(method, "/labels/api/" + path, { json });
const pairs = async b => (await api(b, "GET", "labels")).json.labels.map(l => l.value ? `${l.key}: ${l.value}` : l.key);

test("Recipe labels is an app of its own, off until an admin turns it on", async () => {
  const env = makeEnv(), kim = await member(env, "kim");
  assert.equal((await kim.get("/labels/")).status, 403);
  assert.equal((await api(kim, "GET", "labels")).status, 403);
  assert.equal((await api(kim, "POST", "labels", { key: "Season", values: "Fall" })).status, 403);
  grantApps(env, "kim", "labels");
  assert.equal((await kim.get("/labels/")).status, 200);
  assert.equal((await kim.get("/labels")).status, 308);
  assert.deepEqual((await api(kim, "GET", "labels")).json.labels, []);
  // It's gone from the admin page.
  assert.equal((await kim.req("GET", "/admin/api/labels")).status, 403);
});

test("values split on commas, once each, whatever their case", () => {
  assert.deepEqual(splitValues(" Fall,  winter , ,FALL, Early  spring"), ["Fall", "winter", "Early spring"]);
  assert.deepEqual(splitValues(["Fall", "Fall", " "]), ["Fall"]);
  assert.deepEqual(splitValues(""), []);
});

test("adding many values at once, and more under a key that's already there", async () => {
  const env = makeEnv(), kim = await member(env, "kim", "labels");
  const first = await api(kim, "POST", "labels", { key: " Season ", values: "Fall, Winter,Spring" });
  assert.equal(first.status, 201, first.text);
  assert.deepEqual(first.json.added.map(l => l.value), ["Fall", "Winter", "Spring"]);
  assert.deepEqual(first.json.skipped, []);
  // More under Season, typed in another case: the list's spelling wins, and what's there is skipped.
  const more = (await api(kim, "POST", "labels", { key: "season", values: ["summer", "fall"] })).json;
  assert.deepEqual(more.added.map(l => `${l.key}: ${l.value}`), ["Season: summer"]);
  assert.deepEqual(more.skipped, [{ key: "Season", value: "fall", why: "already on the list" }]);
  // One at a time still works, and a key with no value is a label too.
  assert.equal((await api(kim, "POST", "labels", { key: "Cuisine", value: "Irish" })).status, 201);
  assert.deepEqual((await api(kim, "POST", "labels", { key: "Favorite" })).json.added.map(l => l.value), [""]);
  assert.deepEqual(await pairs(kim), ["Cuisine: Irish", "Favorite", "Season: Fall", "Season: Spring", "Season: summer", "Season: Winter"]);
  const keys = (await api(kim, "GET", "labels")).json.keys;
  assert.deepEqual(keys.map(k => [k.key, k.values]), [["Cuisine", 1], ["Favorite", 1], ["Season", 4]]);

  for (const bad of [{ key: "", values: "x" }, { key: "x".repeat(31) }, { key: "Season", values: "y".repeat(61) },
    { key: "Season: Fall" }, { key: "Course", values: Array.from({ length: 51 }, (_, i) => `v${i}`) }, "Season"]) {
    assert.equal((await api(kim, "POST", "labels", bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await kim.req("POST", "/labels/api/labels", { json: { key: "Evil" }, origin: "https://evil.test" })).status, 403);
});

test("renaming and removing a label, or a whole key, applies to every recipe", async () => {
  const env = makeEnv(), kim = await member(env, "kim", "labels", "recipes"), ryan = await member(env, "ryan", "recipes");
  const [fall, winter] = (await api(kim, "POST", "labels", { key: "Season", values: "Fall, Winter" })).json.added;
  const [irish] = (await api(kim, "POST", "labels", { key: "Cuisine", values: "Irish" })).json.added;
  const stew = (await ryan.req("POST", "/recipes/api/recipes", { json: { title: "Stew", labels: [fall.id, irish.id] } })).json;
  assert.equal(stew.labels.length, 2);
  const read = async () => (await ryan.get("/recipes/api/recipes")).json.recipes[0].labels.map(l => `${l.key}: ${l.value}`);
  assert.equal((await api(kim, "GET", "labels")).json.labels.find(l => l.id === fall.id).recipes, 1);

  // One value renamed.
  assert.equal((await api(kim, "PATCH", `labels/${fall.id}`, { value: "Autumn" })).json.value, "Autumn");
  assert.deepEqual(await read(), ["Cuisine: Irish", "Season: Autumn"]);
  assert.match((await api(kim, "PATCH", `labels/${fall.id}`, { value: "winter" })).json.error, /already/);
  assert.equal((await api(kim, "PATCH", "labels/l_00000000ff", { value: "x" })).status, 404);

  // A key renamed, then merged into another that has none of the same values.
  assert.deepEqual((await api(kim, "PATCH", "keys/season", { key: "Time of year" })).json, { key: "Time of year", values: 2 });
  assert.deepEqual(await read(), ["Cuisine: Irish", "Time of year: Autumn"]);
  assert.equal((await api(kim, "POST", "labels", { key: "Cuisine", values: "Autumn" })).status, 201);
  assert.match((await api(kim, "PATCH", "keys/Time%20of%20year", { key: "Cuisine" })).json.error, /Cuisine: Autumn is already/);
  assert.equal((await api(kim, "PATCH", "keys/Colour", { key: "Hue" })).status, 404);

  // One value removed, then a whole key.
  assert.equal((await api(kim, "DELETE", `labels/${winter.id}`)).json.removed, true);
  assert.equal((await api(kim, "DELETE", `labels/${winter.id}`)).status, 404);
  assert.deepEqual((await api(kim, "DELETE", "keys/cuisine")).json, { removed: 2 });
  assert.deepEqual(await read(), ["Time of year: Autumn"]);
  assert.equal((await api(kim, "DELETE", "keys/Cuisine")).status, 404);
  assert.equal(sql(env, "SELECT * FROM recipe_labels").length, 1);
  // Recipes pick from the list, and only from it.
  assert.equal((await ryan.req("PATCH", `/recipes/api/recipes/${stew.id}`, { json: { labels: [winter.id] } })).status, 400);
});
