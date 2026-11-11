// Tests for where pictures are kept (src/photos.js): R2 when the PHOTOS bucket
// is bound, D1 without it, and older D1 pictures moved over by the 5-minute job.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { Browser, ORIGIN, makeEnv, grantApps, sqlOne, run, enable2fa } from "./helpers.mjs";

// Stands in for an R2 bucket: put, get (with a body) and delete (one key or many).
function fakeR2() {
  const objects = new Map();
  return {
    objects,
    put: async (key, value, opts) => { objects.set(key, { bytes: new Uint8Array(value), type: opts?.httpMetadata?.contentType }); },
    get: async key => { const o = objects.get(key); return o ? { body: o.bytes, httpMetadata: { contentType: o.type } } : null; },
    delete: async keys => { for (const k of [].concat(keys)) objects.delete(k); },
  };
}

const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1];
const JPEG = Buffer.from(JPEG_BYTES).toString("base64");

async function person(env, name, ...apps) {
  const b = new Browser(env);
  await b.signup(name, undefined, name[0].toUpperCase() + name.slice(1));
  grantApps(env, name, ...apps);
  return b;
}
const api = (b, app, method, path, json) => b.req(method, `/${app}/api/${path}`, { json });
// A picture's bytes, fetched straight from the Worker (Browser keeps only text).
async function bytesOf(b, path) {
  const res = await worker.fetch(new Request(ORIGIN + path, { headers: { Cookie: `__Host-sid=${b.cookie}`, "CF-Connecting-IP": b.ip } }), b.env);
  return [...new Uint8Array(await res.arrayBuffer())];
}

test("with the bucket, new pictures go to R2 and their rows keep no data", async () => {
  const PHOTOS = fakeR2(), env = makeEnv({ PHOTOS });
  const lee = await person(env, "lee", "food", "recipes", "feedback");

  // Food club
  const pick = (await api(lee, "food", "POST", "picks", { month: "2026-11", title: "Shakshuka" })).json.id;
  const p = (await api(lee, "food", "POST", `picks/${pick}/photos`, { data: JPEG })).json;
  const food = p.photos[0].id;
  assert.equal(sqlOne(env, "SELECT data FROM food_photos WHERE id = ?", food).data, "");
  assert.equal(PHOTOS.objects.get(`food_photos/${food}`).type, "image/jpeg");
  const pic = await lee.req("GET", `/food/api/photos/${food}`);
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get("Content-Type"), "image/jpeg");
  assert.deepEqual(await bytesOf(lee, `/food/api/photos/${food}`), JPEG_BYTES);
  await api(lee, "food", "DELETE", `picks/${pick}/photos/${food}`);
  assert.equal(PHOTOS.objects.has(`food_photos/${food}`), false);

  // Recipe box: a new picture replaces the old one in R2 too.
  const recipe = (await api(lee, "recipes", "POST", "recipes", { title: "Pavlova" })).json.id;
  const first = (await api(lee, "recipes", "POST", `recipes/${recipe}/photo`, { data: JPEG })).json.image.split("/").pop();
  const second = (await api(lee, "recipes", "POST", `recipes/${recipe}/photo`, { data: JPEG })).json.image.split("/").pop();
  assert.deepEqual([...PHOTOS.objects.keys()], [`recipe_photos/${second}`]);
  assert.deepEqual(await bytesOf(lee, `/recipes/api/photos/${second}`), JPEG_BYTES);
  assert.equal((await lee.req("GET", `/recipes/api/photos/${first}`)).status, 404);
  await api(lee, "recipes", "DELETE", `recipes/${recipe}`);
  assert.equal(PHOTOS.objects.size, 0);

  // Feedback: deleting the note takes its pictures.
  const note = (await api(lee, "feedback", "POST", "items", { message: "Look" })).json.id;
  await api(lee, "feedback", "POST", `items/${note}/photos`, { data: JPEG });
  assert.equal(PHOTOS.objects.size, 1);
  await api(lee, "feedback", "DELETE", `items/${note}`);
  assert.equal(PHOTOS.objects.size, 0);
});

test("older pictures in D1 still show, and the 5-minute job moves them to R2", async () => {
  // Saved before there was a bucket...
  const env = makeEnv(), lee = await person(env, "lee", "food");
  const pick = (await api(lee, "food", "POST", "picks", { month: "2026-11", title: "Shakshuka" })).json.id;
  for (let i = 0; i < 5; i++) await api(lee, "food", "POST", `picks/${pick}/photos`, { data: JPEG });
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM food_photos WHERE data = ?", JPEG).n, 5);

  // ...then the bucket is bound.
  env.PHOTOS = fakeR2();
  const id = sqlOne(env, "SELECT id FROM food_photos LIMIT 1").id;
  assert.deepEqual(await bytesOf(lee, `/food/api/photos/${id}`), JPEG_BYTES);
  const tick = async () => { const waits = []; await worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil: p => waits.push(p) }); await Promise.all(waits); };
  await tick();
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM food_photos WHERE data != ''").n, 2, "a few per run");
  await tick();
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM food_photos WHERE data != ''").n, 0);
  assert.equal(env.PHOTOS.objects.size, 5);
  assert.deepEqual(await bytesOf(lee, `/food/api/photos/${id}`), JPEG_BYTES);
});

test("deleting an account takes its pictures out of R2", async () => {
  const PHOTOS = fakeR2(), env = makeEnv({ PHOTOS });
  const boss = await person(env, "boss");
  run(env, "INSERT INTO user_areas (user_id, area) SELECT id, 'admin' FROM users WHERE username = 'boss'");
  await enable2fa(boss, env);
  const lee = await person(env, "lee", "food", "recipes", "feedback");
  const pick = (await api(lee, "food", "POST", "picks", { month: "2026-11", title: "Shakshuka" })).json.id;
  await api(lee, "food", "POST", `picks/${pick}/photos`, { data: JPEG });
  const recipe = (await api(lee, "recipes", "POST", "recipes", { title: "Pavlova" })).json.id;
  await api(lee, "recipes", "POST", `recipes/${recipe}/photo`, { data: JPEG });
  const note = (await api(lee, "feedback", "POST", "items", { message: "Look" })).json.id;
  await api(lee, "feedback", "POST", `items/${note}/photos`, { data: JPEG });
  assert.equal(PHOTOS.objects.size, 3);
  const res = await boss.post("/admin/delete", { user_id: sqlOne(env, "SELECT id FROM users WHERE username = 'lee'").id, confirm: "lee" });
  assert.match(res.text, /lee and their tasks are deleted/);
  assert.equal(PHOTOS.objects.size, 0);
});
