// Tests for the admin page's per-account app toggles, which come from APPS.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, sql, sqlOne, run } from "./helpers.mjs";
import { APPS } from "../src/auth.js";

async function admin(env, name = "ryan") {
  const b = new Browser(env);
  assert.equal((await b.signup(name)).status, 303);
  const { id } = sqlOne(env, "SELECT id FROM users WHERE username = ?", name);
  run(env, "INSERT INTO user_areas (user_id, area) VALUES (?, 'admin')", id);
  run(env, "UPDATE users SET totp_secret = 'AAAAAAAAAAAAAAAA' WHERE id = ?", id);
  return b;
}
const areas = (env, name) => sql(env, "SELECT area FROM user_areas a JOIN users u ON u.id = a.user_id WHERE u.username = ? ORDER BY area", name).map(r => r.area);
// Chat connections is part of Chat, so it's tried with Chat on.
const PATHS = { drift: "/todo/", plugins: "/plugins/", chat: "/chat/", "chat-bridges": "/chat/api/connections", admin: "/admin", notifications: "/notifications/", recipes: "/recipes/", sweep: "/sweep/", trips: "/trips/" };

test("every app is its own area, and new accounts only get the ones marked onForNew", async () => {
  assert.equal(new Set(APPS.map(a => a.area)).size, APPS.length, "two apps sharing an area couldn't be toggled apart");
  const env = makeEnv(), josh = new Browser(env);
  await josh.signup("josh");
  assert.deepEqual(areas(env, "josh"), APPS.filter(a => a.onForNew).map(a => a.area).sort());
  assert.equal((await josh.get("/todo/")).status, 200);
  assert.equal((await josh.get("/chat/")).status, 403);
  assert.equal((await josh.get("/plugins/")).status, 403);
  assert.doesNotMatch((await josh.get("/dashboard")).text, /href="\/chat\/"/);
});

test("the admin page has a toggle for every app on every account, and they work", async () => {
  const env = makeEnv(), ryan = await admin(env), josh = new Browser(env);
  await josh.signup("josh");
  const page = (await ryan.get("/admin")).text;
  for (const a of APPS) {
    assert.match(page, new RegExp(`name="app" value="${a.id}"[\\s\\S]*?aria-label="${a.name} for josh"`), `${a.name} toggle for josh`);
  }
  assert.match(page, /aria-pressed="true" disabled title="You can't remove your own admin access\."/);

  const id = sqlOne(env, "SELECT id FROM users WHERE username = 'josh'").id;
  for (const a of APPS.filter(a => a.id !== "admin")) {
    if (a.parent) await ryan.post("/admin/access", { user_id: id, app: a.parent, on: "1" });
    const on = await ryan.post("/admin/access", { user_id: id, app: a.id, on: "1" });
    assert.match(on.text, new RegExp(`${a.name} is on for josh`));
    assert.match(on.text, new RegExp(`aria-pressed="true" aria-label="${a.name} for josh"`));
    assert.equal((await josh.get(PATHS[a.id])).status, 200, `${a.id} on`);
    await ryan.post("/admin/access", { user_id: id, app: a.id, on: "0" });
    assert.equal((await josh.get(PATHS[a.id])).status, 403, `${a.id} off`);
    if (a.parent) await ryan.post("/admin/access", { user_id: id, app: a.parent, on: "0" });
  }
  assert.equal((await ryan.post("/admin/access", { user_id: id, app: "nope", on: "1" })).status, 400);
  const me = sqlOne(env, "SELECT id FROM users WHERE username = 'ryan'").id;
  assert.equal((await ryan.post("/admin/access", { user_id: me, app: "admin", on: "0" })).status, 400);
  assert.equal((await josh.post("/admin/access", { user_id: id, app: "chat", on: "1" })).status, 403, "only admins");
});

test("the terminal's admin API lists and changes the same toggles", async () => {
  const env = makeEnv(), ryan = await admin(env), josh = new Browser(env);
  await josh.signup("josh");
  const list = (await ryan.get("/admin/api/access")).json;
  assert.deepEqual(list.apps, APPS.map(a => ({ id: a.id, name: a.name })));
  const j = list.users.find(u => u.username === "josh");
  assert.deepEqual(j.apps, ["drift"]);
  assert.equal(list.users.find(u => u.username === "ryan").you, true);

  const after = (await ryan.req("POST", "/admin/api/access", { json: { user_id: j.id, app: "chat", on: true } })).json;
  assert.deepEqual(after.users.find(u => u.username === "josh").apps, ["drift", "chat"]);
  assert.equal((await josh.get("/chat/api/state")).status, 200);

  const me = list.users.find(u => u.you).id;
  const self = await ryan.req("POST", "/admin/api/access", { json: { user_id: me, app: "admin", on: false } });
  assert.equal(self.status, 400);
  assert.match(self.json.error, /own admin access/);
  assert.equal((await josh.get("/admin/api/access")).status, 403);
  assert.equal((await ryan.req("POST", "/admin/api/access", { json: { user_id: j.id, app: "chat", on: true }, origin: "https://evil.test" })).status, 403);
});

test("accounts that had Drift before the split keep the plugin store and chat, once", async () => {
  const env = makeEnv(), ryan = await admin(env), josh = new Browser(env);
  await josh.signup("josh");
  assert.deepEqual(areas(env, "josh"), ["todo"]);
  // A database from before apps had their own areas: no record of the split yet.
  run(env, "DELETE FROM area_splits");
  const old = { ...env, TODO_DB: { ...env.TODO_DB } };   // a fresh Worker instance on the same data
  const b = new Browser(old); b.cookie = josh.cookie;
  assert.equal((await b.get("/chat/")).status, 200);
  assert.deepEqual(areas(env, "josh"), ["chat", "plugins", "todo"]);

  // An admin turns chat off; the next instance doesn't give it back.
  const id = sqlOne(env, "SELECT id FROM users WHERE username = 'josh'").id;
  const r = new Browser(old); r.cookie = ryan.cookie;
  await r.post("/admin/access", { user_id: id, app: "chat", on: "0" });
  const again = new Browser({ ...env, TODO_DB: { ...env.TODO_DB } }); again.cookie = josh.cookie;
  assert.equal((await again.get("/chat/")).status, 403);
  assert.deepEqual(areas(env, "josh"), ["plugins", "todo"]);
});
