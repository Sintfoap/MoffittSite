// Tests for Food club: a pick a month, made and loved by the club, with photos.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps, sql, sqlOne } from "./helpers.mjs";
import { imageType, PHOTO_BYTES } from "../src/food.js";

async function member(env, name, ...more) {
  const b = new Browser(env);
  await b.signup(name, undefined, name[0].toUpperCase() + name.slice(1));
  grantApps(env, name, "food", ...more);
  return b;
}
const api = (b, method, path, json) => b.req(method, "/food/api/" + path, { json });
// A real (1×1) JPEG's first bytes are enough for the checks.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString("base64");

test("Food club is off until an admin turns it on", async () => {
  const env = makeEnv(), josh = new Browser(env);
  await josh.signup("josh");
  assert.equal((await josh.get("/food/")).status, 403);
  assert.equal((await josh.get("/food/api/club")).status, 403);
  grantApps(env, "josh", "food");
  const page = await josh.get("/food/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("Content-Security-Policy"), /img-src 'self' data: blob: https:/);
  assert.equal((await josh.get("/food")).status, 308);
  const club = (await josh.get("/food/api/club")).json;
  assert.deepEqual([club.picks, club.recipe_box, club.recipes], [[], false, []]);
});

test("one pick a month, changed only by whoever picked it", async () => {
  const env = makeEnv(), moffitt = await member(env, "moffitt"), sam = await member(env, "sam");
  const p = await api(moffitt, "POST", "picks", { month: "2026-11", title: "Shakshuka", kind: "meal", blurb: "Eggs in spicy tomato.",
    recipe: { ingredients: "6 eggs\n1 can tomatoes", steps: ["Simmer the sauce", "Crack in the eggs"], time: "30 min" } });
  assert.equal(p.status, 201, p.text);
  assert.equal(p.json.by, "Moffitt");
  assert.deepEqual(p.json.recipe.ingredients, ["6 eggs", "1 can tomatoes"]);
  assert.equal(p.json.can_edit, true);
  const id = p.json.id;

  for (const bad of [{ title: "x" }, { month: "2026-13", title: "x" }, { month: "1999-01", title: "x" }, { month: "2026-12" },
    { month: "2026-12", title: "x", kind: "brunch" }, { month: "2026-12", title: "x", colour: "red" }]) {
    assert.equal((await api(sam, "POST", "picks", bad)).status, 400, JSON.stringify(bad));
  }
  assert.match((await api(sam, "POST", "picks", { month: "2026-11", title: "Pie" })).json.error, /Moffitt already picked/);

  const mine = await api(sam, "POST", "picks", { month: "2026-12", title: "Pavlova", kind: "dessert" });
  assert.equal(mine.json.recipe, null);
  const list = (await api(sam, "GET", "club")).json.picks;
  assert.deepEqual(list.map(x => [x.month, x.title, x.by, x.yours]), [["2026-12", "Pavlova", "Sam", true], ["2026-11", "Shakshuka", "Moffitt", false]]);

  // sam can't change or delete moffitt's pick; moffitt can, and can't move it onto sam's month.
  assert.equal((await api(sam, "GET", `picks/${id}`)).json.can_edit, false);
  assert.equal((await api(sam, "PATCH", `picks/${id}`, { title: "Nope" })).status, 400);
  assert.equal((await api(sam, "DELETE", `picks/${id}`)).status, 400);
  assert.match((await api(moffitt, "PATCH", `picks/${id}`, { month: "2026-12" })).json.error, /Sam already picked/);
  const changed = await api(moffitt, "PATCH", `picks/${id}`, { blurb: "Brunch for dinner.", recipe: { ingredients: ["8 eggs"] } });
  assert.equal(changed.json.blurb, "Brunch for dinner.");
  assert.deepEqual(changed.json.recipe.ingredients, ["8 eggs"]);
  assert.deepEqual((await api(moffitt, "DELETE", `picks/${mine.json.id}`)).status, 400);
  assert.equal((await api(sam, "DELETE", `picks/${mine.json.id}`)).json.removed, true);
});

test("made it, favorites, and photos of everyone's attempts", async () => {
  const env = makeEnv(), moffitt = await member(env, "moffitt"), sam = await member(env, "sam"), lee = await member(env, "lee");
  const id = (await api(moffitt, "POST", "picks", { month: "2026-10", title: "Ramen" })).json.id;

  // A favorite is something you made; un-making takes the favorite off too.
  let p = (await api(sam, "PUT", `picks/${id}/mine`, { favorite: true })).json;
  assert.deepEqual([p.mine, p.made_by, p.favorite_of], [{ made: true, favorite: true }, ["Sam"], ["Sam"]]);
  p = (await api(sam, "PUT", `picks/${id}/mine`, { made: false })).json;
  assert.deepEqual([p.mine, p.made_by, p.favorite_of], [{ made: false, favorite: false }, [], []]);
  assert.equal((await api(sam, "PUT", `picks/${id}/mine`, { tasty: 1 })).status, 400);

  // A photo marks you as having made it.
  p = (await api(lee, "POST", `picks/${id}/photos`, { data: JPEG, caption: "Too much chili" })).json;
  assert.deepEqual(p.made_by, ["Lee"]);
  assert.deepEqual(p.photos.map(x => [x.by, x.caption, x.yours]), [["Lee", "Too much chili", true]]);
  const photo = p.photos[0].id;
  const img = await lee.get(`/food/api/photos/${photo}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("Content-Type"), "image/jpeg");
  assert.equal(img.headers.get("X-Content-Type-Options"), "nosniff");
  const outsider = new Browser(env);
  await outsider.signup("outsider");
  assert.equal((await outsider.get(`/food/api/photos/${photo}`)).status, 403);

  // Only pictures, and not huge ones.
  assert.match((await api(lee, "POST", `picks/${id}/photos`, { data: Buffer.from("<svg onload=alert(1)>").toString("base64") })).json.error, /isn't a JPEG/);
  assert.match((await api(lee, "POST", `picks/${id}/photos`, { data: "not base64!" })).json.error, /base64/);
  const big = Buffer.alloc(PHOTO_BYTES + 10); big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
  assert.match((await api(lee, "POST", `picks/${id}/photos`, { data: big.toString("base64") })).json.error, /too big/);

  // The list shows how it went.
  await api(sam, "PUT", `picks/${id}/mine`, { favorite: true });
  const row = (await api(sam, "GET", "club")).json.picks[0];
  assert.deepEqual([row.made, row.favorites, row.photos, row.cover, row.mine], [2, 1, 1, photo, { made: true, favorite: true }]);

  // sam can't take lee's photo off; lee can.
  assert.equal((await api(sam, "DELETE", `picks/${id}/photos/${photo}`)).status, 400);
  assert.deepEqual((await api(lee, "DELETE", `picks/${id}/photos/${photo}`)).json.photos, []);

  // Deleting the pick takes its photos and marks.
  await api(lee, "POST", `picks/${id}/photos`, { data: JPEG });
  await api(moffitt, "DELETE", `picks/${id}`);
  assert.equal(sql(env, "SELECT * FROM food_photos").length + sql(env, "SELECT * FROM food_marks").length, 0);
});

test("recipes come from and go to Recipe box", async () => {
  const env = makeEnv(), moffitt = await member(env, "moffitt", "recipes"), sam = await member(env, "sam");
  const r = (await moffitt.req("POST", "/recipes/api/recipes", { json: { title: "Nan's banana bread", ingredients: "3 bananas\n2 cups flour", steps: "Mash\nBake", servings: 8 } })).json;
  const club = (await api(moffitt, "GET", "club")).json;
  assert.equal(club.recipe_box, true);
  assert.deepEqual(club.recipes, [{ id: r.id, title: "Nan's banana bread" }]);

  // Picking from your Recipe box takes its title and recipe; sam has no Recipe box to pick from.
  const p = (await api(moffitt, "POST", "picks", { month: "2026-09", kind: "baking", recipe_id: r.id })).json;
  assert.equal(p.title, "Nan's banana bread");
  assert.deepEqual([p.recipe.ingredients, p.recipe.servings], [["3 bananas", "2 cups flour"], 8]);
  assert.match((await api(sam, "POST", "picks", { month: "2026-08", title: "x", recipe_id: r.id })).json.error, /Recipe box/);
  assert.match((await api(sam, "POST", `picks/${p.id}/save`)).json.error, /Recipe box/);

  // Saving it puts a copy in your own box, noting where it came from.
  grantApps(env, "sam", "recipes");
  const saved = await api(sam, "POST", `picks/${p.id}/save`);
  assert.equal(saved.status, 201, saved.text);
  assert.equal(saved.json.recipe.title, "Nan's banana bread");
  assert.match(saved.json.recipe.notes, /Food club pick for 2026-09, from Moffitt/);
  const samId = sqlOne(env, "SELECT id FROM users WHERE username = 'sam'").id;
  assert.equal(sql(env, "SELECT * FROM recipes WHERE owner = ?", samId).length, 1);
});

test("what a picture is comes from its bytes", () => {
  assert.equal(imageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0])), "image/png");
  assert.equal(imageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(imageType(Buffer.from("GIF89a")), "image/gif");
  assert.equal(imageType(Buffer.from("<svg>")), null);
});
