// Tests for the admin stats page (/admin/stats) and its API for the terminal.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, sqlOne, run } from "./helpers.mjs";
import { bytes, ago } from "../src/pages.js";
import { PHOTOS } from "../src/stats.js";
import { PHOTO_TABLES } from "../src/photos.js";

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
  assert.deepEqual(s.storage.r2, { bound: false, bytes: null, photo_count: 1, partial: false,
    bucket_bytes: null, objects: null, loose_count: null, loose_bytes: null, limit_bytes: 10 * 1024 ** 3 });
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
  // p_2 is a picture's; old/x is left over from one that's gone.
  const objects = [{ key: "recipe_photos/p_2", size: 900000 }, { key: "food_photos/old", size: 1000 }];
  const PHOTOS = { list: async ({ prefix = "" }) => ({ objects: objects.filter(o => o.key.startsWith(prefix)), truncated: false }) };
  const env = makeEnv({ PHOTOS, D1_LIMIT_MB: "10240", R2_LIMIT_GB: "20" }), ryan = await admin(env);
  const r = sqlOne(env, "SELECT id FROM users WHERE username = 'ryan'").id;
  run(env, "INSERT INTO recipe_photos (id, owner, recipe, type, data, created) VALUES ('p_2', ?, 'r_2', 'image/png', '', 'x')", r);
  const s = (await ryan.get("/admin/api/stats")).json;
  assert.deepEqual(s.storage.r2, { bound: true, bytes: 900000, photo_count: 1, partial: false,
    bucket_bytes: 901000, objects: 2, loose_count: 1, loose_bytes: 1000, limit_bytes: 20 * 1024 ** 3 });
  assert.equal(s.users[0].photos.r2_bytes, 900000);
  assert.equal(s.storage.d1.limit_bytes, 10240 * 1024 * 1024);
  const text = (await ryan.get("/admin/stats")).text;
  assert.match(text, /879 KB<\/b> in R2 across 1 picture/);
  assert.match(text, /880 KB<\/b> of R2's 20 GB is used \(0%\), in 2 objects/);
  assert.match(text, /1 object \(1000 B\) in the bucket isn't any picture's any more/);
});

test("stats show this week's changes, who has each app, sign-ups by week, devices and D1's tables", async () => {
  const env = makeEnv(), ryan = await admin(env), josh = new Browser(env);
  await josh.signup("josh");
  const j = sqlOne(env, "SELECT id FROM users WHERE username = 'josh'").id;
  const old = new Date(Date.now() - 30 * 86400e3).toISOString(), fresh = new Date().toISOString();
  run(env, "INSERT INTO recipes (owner, id, data, updated) VALUES (?, 'r_1', '{}', ?), (?, 'r_2', '{}', ?)", j, old, j, fresh);
  run(env, "INSERT INTO user_areas (user_id, area) VALUES (?, 'recipes')", j);
  run(env, "INSERT INTO api_keys (id_hash, user_id, name, prefix, created_at, last_used) VALUES ('h', ?, 'agent', 'sk', 1, ?)", j, Math.floor(Date.now() / 1000));
  run(env, "UPDATE users SET created_at = created_at - 14 * 86400 WHERE id = ?", j);

  const s = (await ryan.get("/admin/api/stats")).json;
  assert.equal(s.totals.counts.recipes, 2);
  assert.equal(s.totals.changed_7d.recipes, 1, "only the one changed this week");
  assert.equal(s.activity.changed_7d, 1);
  assert.equal(s.activity.devices, 2);
  assert.equal(s.activity.api_keys, 1);
  assert.equal(s.activity.api_keys_used_30d, 1);
  assert.equal(s.accounts.active_1d, 2);
  const rec = s.apps.find(a => a.id === "recipes"), drift = s.apps.find(a => a.id === "drift");
  assert.deepEqual([rec.people, rec.active_30d], [1, 1]);
  assert.equal(drift.people, 2);
  assert.ok(!s.apps.some(a => a.id === "admin"));
  assert.equal(s.weeks.length, 12);
  assert.equal(s.weeks.at(-1).joined, 1, "ryan this week");
  assert.equal(s.weeks.at(-3).joined, 1, "josh two weeks ago");
  assert.equal(s.weeks.reduce((n, w) => n + w.joined, 0), 2);
  const users = s.storage.tables.find(t => t.name === "users");
  assert.equal(users.rows, 2);
  assert.ok(s.storage.tables.every((t, i, l) => !i || l[i - 1].rows >= t.rows), "most rows first");

  const page = (await ryan.get("/admin/stats")).text;
  assert.match(page, /<h2>Activity<\/h2>/);
  assert.match(page, /1 used in 30 days/);
  assert.match(page, /<h2>Who has each app<\/h2>/);
  assert.match(page, /<h2>D1 tables<\/h2>/);
  assert.match(page, /aria-label="Sign-ups in each of the last 12 weeks: 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1"/);
});

test("stats count pictures from every table photos.js keeps them in", () => {
  assert.deepEqual(PHOTOS.map(p => p.table), PHOTO_TABLES);
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
