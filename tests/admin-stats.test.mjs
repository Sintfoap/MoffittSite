// Tests for the admin stats page (/admin/stats) and its API for the terminal.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, sqlOne, run } from "./helpers.mjs";
import { bytes, ago } from "../src/pages.js";

async function admin(env, name = "ryan") {
  const b = new Browser(env);
  assert.equal((await b.signup(name)).status, 303);
  const { id } = sqlOne(env, "SELECT id FROM users WHERE username = ?", name);
  run(env, "INSERT INTO user_areas (user_id, area) VALUES (?, 'admin')", id);
  run(env, "UPDATE users SET totp_secret = 'AAAAAAAAAAAAAAAA' WHERE id = ?", id);
  return b;
}

test("stats count each person's things and pictures, and where the pictures are", async () => {
  const env = makeEnv({ MAX_USERS: "10" }), ryan = await admin(env), josh = new Browser(env);
  await josh.signup("josh");
  const j = sqlOne(env, "SELECT id FROM users WHERE username = 'josh'").id;
  const t = new Date().toISOString();
  for (const id of ["r_1", "r_2"]) run(env, "INSERT INTO recipes (owner, id, data, updated) VALUES (?, ?, ?, ?)", j, id, JSON.stringify({ title: "Soup" }), t);
  run(env, "INSERT INTO pantry_items (owner, id, data, updated) VALUES (?, 'i_1', '{}', ?)", j, t);
  // One picture still in D1 (base64), one moved to R2 (data emptied).
  run(env, "INSERT INTO recipe_photos (id, owner, recipe, type, data, created) VALUES ('p_1', ?, 'r_1', 'image/png', ?, ?)", j, "A".repeat(4000), t);
  run(env, "INSERT INTO recipe_photos (id, owner, recipe, type, data, created) VALUES ('p_2', ?, 'r_2', 'image/png', '', ?)", j, t);
  run(env, "INSERT INTO trips (id, owner, data, updated) VALUES ('t_1', ?, '{}', ?)", j, t);
  run(env, "INSERT INTO trip_entries (trip, id, kind, data, created) VALUES ('t_1', 'e_1', 'pack', '{\"x\":1}', ?)", t);

  const s = (await ryan.get("/admin/api/stats")).json;
  assert.equal(s.accounts.total, 2);
  assert.equal(s.accounts.max, 10);
  assert.equal(s.accounts.left, 8);
  assert.equal(s.accounts.joined_7d, 2);
  assert.equal(s.accounts.active_7d, 2, "both just signed in");
  const u = s.users.find(x => x.username === "josh");
  assert.equal(s.users[0].username, "josh", "biggest first");
  assert.equal(u.counts.recipes, 2);
  assert.equal(u.counts.pantry_items, 1);
  assert.equal(u.counts.recipe_photos, 2);
  assert.equal(u.counts.trips, 1);
  assert.deepEqual(u.photos, { count: 2, d1_bytes: 4000, r2_bytes: 0, r2_count: 1 });
  assert.ok(u.data_bytes > 0 && u.total_bytes === u.data_bytes + 4000);
  assert.equal(s.storage.d1.photo_bytes, 4000);
  assert.equal(s.storage.d1.photo_count, 1);
  assert.deepEqual(s.storage.r2, { bound: false, bytes: null, photo_count: 1, partial: false });
  assert.equal(s.totals.counts.recipes, 2);
  assert.equal(s.storage.d1.limit_bytes, 500 * 1024 * 1024);

  const page = (await ryan.get("/admin/stats"));
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1>Stats<\/h1>/);
  assert.match(page.text, /2<small[^>]*> \/ 10<\/small>/);
  assert.match(page.text, /id="s-u_[0-9a-f]+"/);
  assert.match(page.text, /photos in D1 3\.9 KB · photos in R2 1/);
  assert.match((await ryan.get("/admin")).text, /href="\/admin\/stats"/);
});

test("R2 sizes come from the bucket's listing when it's bound", async () => {
  const objects = [{ key: "recipe_photos/p_2", size: 900000 }];
  const PHOTOS = { list: async ({ prefix }) => ({ objects: objects.filter(o => o.key.startsWith(prefix)), truncated: false }) };
  const env = makeEnv({ PHOTOS, D1_LIMIT_MB: "10240" }), ryan = await admin(env);
  const r = sqlOne(env, "SELECT id FROM users WHERE username = 'ryan'").id;
  run(env, "INSERT INTO recipe_photos (id, owner, recipe, type, data, created) VALUES ('p_2', ?, 'r_2', 'image/png', '', 'x')", r);
  const s = (await ryan.get("/admin/api/stats")).json;
  assert.deepEqual(s.storage.r2, { bound: true, bytes: 900000, photo_count: 1, partial: false });
  assert.equal(s.users[0].photos.r2_bytes, 900000);
  assert.equal(s.storage.d1.limit_bytes, 10240 * 1024 * 1024);
  assert.match((await ryan.get("/admin/stats")).text, /879 KB<\/b> in R2 across 1 picture/);
});

test("only admins see stats", async () => {
  const env = makeEnv(), josh = new Browser(env);
  await admin(env);
  await josh.signup("josh");
  assert.equal((await josh.get("/admin/api/stats")).status, 403);
  assert.equal((await josh.get("/admin/stats")).status, 403);
});

test("bytes and ago read like people write them", () => {
  assert.equal(bytes(0), "0 B");
  assert.equal(bytes(1536), "1.5 KB");
  assert.equal(bytes(500 * 1024 * 1024), "500 MB");
  assert.equal(bytes(null), "—");
  assert.equal(ago(null), "never");
  assert.equal(ago(1000, 1030), "just now");
  assert.equal(ago(1000, 1000 + 3 * 86400), "3 days ago");
});
