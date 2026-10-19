// API keys for AI agents: created and revoked on /account (see src/apikeys.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, sql, sqlOne, run } from "./helpers.mjs";

const PW = "correct horse battery";
async function signedIn(env, name) {
  const b = new Browser(env);
  assert.equal((await b.signup(name)).status, 303);
  return b;
}
const keyOf = r => r.text.match(/sf_[A-Za-z0-9_-]{20,}/)?.[0];

test("creating a key needs the password and shows the key once", async () => {
  const env = makeEnv(), b = await signedIn(env, "ryan");
  const bad = await b.post("/account/apikeys", { name: "agent", password: "wrong wrong wrong" });
  assert.equal(bad.status, 401);
  assert.equal(sql(env, "SELECT * FROM api_keys").length, 0);

  const r = await b.post("/account/apikeys", { name: "my agent", password: PW });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("Cache-Control"), /no-store/);
  const key = keyOf(r);
  assert.ok(key, "key is on the page");

  const rows = sql(env, "SELECT * FROM api_keys");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "my agent");
  assert.equal(rows[0].prefix, key.slice(0, 8));
  assert.notEqual(rows[0].id_hash, key);
  assert.ok(!JSON.stringify(rows).includes(key), "only a hash is stored");

  const again = await b.get("/account");
  assert.ok(!again.text.includes(key), "not shown again");
  assert.match(again.text, /my agent/);
  assert.match(again.text, new RegExp(key.slice(0, 8)));
});

test("keys can be revoked, only by their owner", async () => {
  const env = makeEnv(), ryan = await signedIn(env, "ryan"), josh = await signedIn(env, "josh");
  await ryan.post("/account/apikeys", { name: "a", password: PW });
  const { id_hash } = sqlOne(env, "SELECT id_hash FROM api_keys");
  await josh.post("/account/apikeys/revoke", { id: id_hash });
  assert.equal(sql(env, "SELECT * FROM api_keys").length, 1, "josh can't revoke ryan's key");
  await ryan.post("/account/apikeys/revoke", { id: id_hash });
  assert.equal(sql(env, "SELECT * FROM api_keys").length, 0);
});

test("names are required and limited; ten keys per account", async () => {
  const env = makeEnv(), b = await signedIn(env, "ryan");
  assert.equal((await b.post("/account/apikeys", { name: "  ", password: PW })).status, 400);
  assert.equal((await b.post("/account/apikeys", { name: "x".repeat(61), password: PW })).status, 400);
  for (let i = 0; i < 10; i++) assert.equal((await b.post("/account/apikeys", { name: "k" + i, password: PW })).status, 200);
  assert.equal((await b.post("/account/apikeys", { name: "one more", password: PW })).status, 400);
  assert.equal(sql(env, "SELECT * FROM api_keys").length, 10);
});

test("the section only shows for accounts with Drift; creating without it is refused", async () => {
  const env = makeEnv(), b = await signedIn(env, "ryan");
  assert.match((await b.get("/account")).text, /API keys/);
  run(env, "DELETE FROM user_areas WHERE area = 'todo'");
  assert.doesNotMatch((await b.get("/account")).text, /API keys/);
  assert.equal((await b.post("/account/apikeys", { name: "a", password: PW })).status, 403);
});

test("deleting an account deletes its keys", async () => {
  const env = makeEnv(), admin = await signedIn(env, "boss"), b = await signedIn(env, "ryan");
  await b.post("/account/apikeys", { name: "a", password: PW });
  run(env, "INSERT INTO user_areas (user_id, area) SELECT id, 'admin' FROM users WHERE username = 'boss'");
  run(env, "UPDATE users SET totp_secret = 'AAAAAAAAAAAAAAAA' WHERE username = 'boss'");
  const res = await admin.post("/admin/delete", { user_id: sqlOne(env, "SELECT id FROM users WHERE username='ryan'").id, confirm: "ryan" });
  assert.ok(res.status < 400, "admin delete worked: " + res.status);
  assert.equal(sql(env, "SELECT * FROM api_keys").length, 0);
});
