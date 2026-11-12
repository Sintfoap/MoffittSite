// Recipe box's share links (src/recipe_share.js): a recipe anyone can read at
// /r/<token> without signing in, until its owner turns the link off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps, sqlOne, run } from "./helpers.mjs";

async function cook(env, name = "ryan") {
  const b = new Browser(env);
  await b.signup(name);
  grantApps(env, name, "recipes");
  return b;
}
const api = (b, method, path, json) => b.req(method, "/recipes/api/" + path, { json });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function recipe(b, fields = {}) {
  return (await api(b, "POST", "recipes", { title: "Grandma's <Chili>", servings: 6, time: "1 hr", ingredients: ["1 lb beef", "2 cans beans"],
    steps: ["Brown the beef.", "Simmer."], notes: "Better the next day.", source: "https://food.test/chili", ...fields })).json;
}

test("a share link shows the recipe to someone signed out, and the same link comes back each time", async () => {
  const env = makeEnv(), ryan = await cook(env), r = await recipe(ryan);
  assert.deepEqual((await api(ryan, "GET", `recipes/${r.id}/share`)).json, { share: null });
  const made = await api(ryan, "POST", `recipes/${r.id}/share`);
  assert.equal(made.status, 200);
  assert.match(made.json.share, /^\/r\/[A-Za-z0-9_-]{32}$/);
  assert.equal((await api(ryan, "POST", `recipes/${r.id}/share`)).json.share, made.json.share);
  assert.equal((await api(ryan, "GET", "recipes")).json.recipes[0].share, made.json.share);

  const stranger = new Browser(env);
  const page = await stranger.get(made.json.share);
  assert.equal(page.status, 200);
  assert.match(page.text, /Grandma&#39;s &lt;Chili&gt;/);
  assert.match(page.text, /2 cans beans/);
  assert.match(page.text, /Simmer\./);
  assert.match(page.text, /Better the next day\./);
  assert.match(page.text, /Serves 6/);
  assert.match(page.text, /food\.test/);
  assert.equal(page.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(page.headers.get("Cache-Control"), "no-store");
  assert.match(page.headers.get("X-Robots-Tag"), /noindex/);
  assert.match(page.headers.get("Content-Security-Policy"), /default-src 'none'/);
  assert.doesNotMatch(page.headers.get("Content-Security-Policy"), /script-src/);
  // Edits show up on the link.
  await api(ryan, "PATCH", `recipes/${r.id}`, { title: "Chili, again" });
  assert.match((await stranger.get(made.json.share)).text, /Chili, again/);
});

test("nothing private is on the page: ids, the owner, dates or anything outside the recipe's own fields", async () => {
  const env = makeEnv(), ryan = await cook(env), r = await recipe(ryan);
  // A mark only the owner should see, as if Recipe box kept one on the recipe.
  run(env, "UPDATE recipes SET data = json_set(data, '$.made', json('[\"2026-11-01\"]'), '$.rating', 5, '$.private_note', 'SECRET-MARK') WHERE id = ?", r.id);
  const { share } = (await api(ryan, "POST", `recipes/${r.id}/share`)).json;
  const text = (await new Browser(env).get(share)).text;
  const owner = sqlOne(env, "SELECT id FROM users WHERE username = 'ryan'").id;
  for (const bad of [r.id, owner, "ryan", "SECRET-MARK", "2026-11-01", r.created]) assert.ok(!text.includes(bad), `page shows ${bad}`);
});

test("turning the link off, or deleting the recipe, stops it working; a new link is a new address", async () => {
  const env = makeEnv(), ryan = await cook(env), r = await recipe(ryan), stranger = new Browser(env);
  const first = (await api(ryan, "POST", `recipes/${r.id}/share`)).json.share;
  assert.deepEqual((await api(ryan, "DELETE", `recipes/${r.id}/share`)).json, { share: null });
  const off = await stranger.get(first);
  assert.equal(off.status, 404);
  assert.doesNotMatch(off.text, /Chili/);
  const second = (await api(ryan, "POST", `recipes/${r.id}/share`)).json.share;
  assert.notEqual(second, first);
  assert.equal((await stranger.get(second)).status, 200);
  await api(ryan, "DELETE", `recipes/${r.id}`);
  assert.equal((await stranger.get(second)).status, 404);
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM recipe_shares").n, 0);
});

test("only the owner can make, see or turn off a recipe's link; made-up tokens find nothing", async () => {
  const env = makeEnv(), ryan = await cook(env), josh = await cook(env, "josh"), r = await recipe(ryan);
  assert.equal((await api(josh, "POST", `recipes/${r.id}/share`)).status, 404);
  const share = (await api(ryan, "POST", `recipes/${r.id}/share`)).json.share;
  assert.equal((await api(josh, "GET", `recipes/${r.id}/share`)).status, 404);
  assert.equal((await api(josh, "DELETE", `recipes/${r.id}/share`)).status, 404);
  assert.equal((await new Browser(env).get(share)).status, 200);
  assert.equal((await new Browser(env).get("/r/" + "A".repeat(32))).status, 404);
  assert.equal((await new Browser(env).get("/r/short")).status, 404);
  // Making one needs a same-origin request, like everything else in Recipe box.
  assert.equal((await ryan.req("POST", `/recipes/api/recipes/${r.id}/share`, { origin: "https://evil.test" })).status, 403);
  assert.equal((await new Browser(env).req("POST", share)).status, 405);
});

test("the recipe's own picture is served through the link, and only that picture", async () => {
  const env = makeEnv(), ryan = await cook(env), r = await recipe(ryan), other = await recipe(ryan, { title: "Toast" });
  await api(ryan, "POST", `recipes/${r.id}/photo`, { data: PNG.toString("base64") });
  await api(ryan, "POST", `recipes/${other.id}/photo`, { data: PNG.toString("base64") });
  const share = (await api(ryan, "POST", `recipes/${r.id}/share`)).json.share;
  const toast = (await api(ryan, "POST", `recipes/${other.id}/share`)).json.share;
  const page = await new Browser(env).get(share);
  assert.match(page.text, new RegExp(`src="${share}/photo"`));
  assert.doesNotMatch(page.text, /\/recipes\/api\/photos\//);
  const pic = await new Browser(env).get(share + "/photo");
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get("Content-Type"), "image/png");
  // Taking the picture off, or a recipe linking a site's picture, has nothing at /photo.
  await api(ryan, "DELETE", `recipes/${other.id}/photo`);
  assert.equal((await new Browser(env).get(toast + "/photo")).status, 404);
  await api(ryan, "PATCH", `recipes/${other.id}`, { image: "https://food.test/toast.jpg" });
  assert.match((await new Browser(env).get(toast)).text, /src="https:\/\/food\.test\/toast\.jpg"/);
  assert.equal((await new Browser(env).get(toast + "/photo")).status, 404);
});

test("deleting the account turns its links off", async () => {
  const env = makeEnv(), ryan = await cook(env), r = await recipe(ryan);
  const share = (await api(ryan, "POST", `recipes/${r.id}/share`)).json.share;
  const boss = new Browser(env);
  await boss.signup("boss");
  run(env, "INSERT INTO user_areas (user_id, area) SELECT id, 'admin' FROM users WHERE username = 'boss'");
  run(env, "UPDATE users SET totp_secret = 'AAAAAAAAAAAAAAAA' WHERE username = 'boss'");
  await boss.post("/admin/delete", { user_id: sqlOne(env, "SELECT id FROM users WHERE username = 'ryan'").id, confirm: "ryan" });
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM users WHERE username = 'ryan'").n, 0, "account deleted");
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM recipe_shares").n, 0);
  assert.equal((await new Browser(env).get(share)).status, 404);
});
