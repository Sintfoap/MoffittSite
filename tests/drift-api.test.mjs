// Tests for Drift's API (collections, items, plugin metadata) behind the site's sign-in.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, ORIGIN, run, sql } from "./helpers.mjs";

async function signedIn(env, name) {
  const b = new Browser(env);
  assert.equal((await b.signup(name)).status, 303);
  return b;
}
const api = (b, method, path, json) => b.req(method, "/todo/api/" + path, json === undefined ? {} : { json });
const inbox = async b => (await api(b, "GET", "state")).json.collections[0];

test("serves the page to a signed-in user and marks it uncacheable", async () => {
  const b = await signedIn(makeEnv(), "ryan");
  const r = await b.get("/todo/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("Cache-Control"), /no-store/);
});

test("a new account starts with an Inbox and the built-in plugins", async () => {
  const b = await signedIn(makeEnv(), "ryan");
  const s = (await api(b, "GET", "state")).json;
  assert.deepEqual(s.plugins.map(p => p.id), ["checklist", "event", "list"]);
  assert.equal(s.collections.length, 1);
  assert.equal(s.collections[0].name, "Inbox");
  assert.deepEqual(s.collections[0].plugins, ["checklist", "event", "list"]);
  assert.deepEqual(s.items, []);
  assert.equal((await api(b, "GET", "state")).json.collections.length, 1, "only made once");
});

test("each user only ever sees and edits their own collections and items", async () => {
  const env = makeEnv();
  const ryan = await signedIn(env, "ryan"), josh = await signedIn(env, "josh");
  const col = await inbox(ryan);

  const made = await api(ryan, "POST", "items", { title: "Pay rent", collection: col.id, tags: ["#Bills"], meta: { checklist: { done: false, priority: 3 } } });
  assert.equal(made.status, 201);
  assert.match(made.json.id, /^i_[0-9a-f]{10}$/);
  assert.deepEqual(made.json.tags, ["bills"]);
  assert.deepEqual(made.json.meta, { checklist: { done: false, done_at: null, priority: 3 } });

  assert.equal((await api(ryan, "GET", "state")).json.items.length, 1);
  assert.equal((await api(josh, "GET", "state")).json.items.length, 0);

  // Josh can't touch Ryan's item or collection, or add to Ryan's collection, even knowing the ids.
  assert.equal((await api(josh, "PATCH", `items/${made.json.id}`, { title: "hacked" })).status, 404);
  assert.equal((await api(josh, "DELETE", `items/${made.json.id}`)).status, 404);
  assert.equal((await api(josh, "PATCH", `collections/${col.id}`, { name: "hacked" })).status, 404);
  assert.equal((await api(josh, "POST", "items", { title: "x", collection: col.id })).status, 400);
  const joshCol = await inbox(josh);
  assert.equal((await api(ryan, "PATCH", `items/${made.json.id}`, { collection: joshCol.id })).status, 400, "can't move into someone else's collection");
  assert.equal((await api(ryan, "GET", "state")).json.items[0].title, "Pay rent");
});

test("plugin metadata merges per plugin; null takes an item off a plugin", async () => {
  const b = await signedIn(makeEnv(), "ryan");
  const col = await inbox(b);
  const { json: it } = await api(b, "POST", "items", {
    title: "Dentist", notes: "bring card", collection: col.id,
    meta: { checklist: { done: false }, event: { start: "2026-10-20T15:00" } },
  });
  assert.deepEqual(it.meta.event, { start: "2026-10-20T15:00", end: null });

  const done = await api(b, "PATCH", `items/${it.id}`, { meta: { checklist: { done: true, priority: 1 } } });
  assert.equal(done.json.meta.checklist.done, true);
  assert.match(done.json.meta.checklist.done_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  assert.deepEqual(done.json.meta.event, it.meta.event, "other plugins' metadata is kept");
  assert.equal(done.json.notes, "bring card", "base fields not sent are kept");

  const moved = await api(b, "PATCH", `items/${it.id}`, { title: "Dentist (moved)", meta: { event: null, list: { order: 2, parent: null } } });
  assert.equal(moved.json.meta.event, undefined);
  assert.deepEqual(moved.json.meta.list, { order: 2, parent: null });
  assert.equal(moved.json.meta.checklist.done, true);
  assert.equal(moved.json.title, "Dentist (moved)");

  const undone = await api(b, "PATCH", `items/${it.id}`, { meta: { checklist: { done: false, priority: 1 } } });
  assert.equal(undone.json.meta.checklist.done_at, null);
});

test("deletes are undoable, and a deleted collection hides its items", async () => {
  const b = await signedIn(makeEnv(), "ryan");
  const first = await inbox(b);
  const { json: col } = await api(b, "POST", "collections", { name: "Reading", plugins: ["list"] });
  assert.deepEqual(col.plugins, ["list"]);
  const { json: it } = await api(b, "POST", "items", { title: "Dune", collection: col.id });

  assert.equal((await api(b, "DELETE", `items/${it.id}`)).status, 200);
  assert.equal((await api(b, "GET", "state")).json.items.length, 0);
  await api(b, "PATCH", `items/${it.id}`, { deleted: false });
  assert.equal((await api(b, "GET", "state")).json.items.length, 1);

  assert.equal((await api(b, "DELETE", `collections/${col.id}`)).status, 200);
  let s = (await api(b, "GET", "state")).json;
  assert.deepEqual(s.collections.map(c => c.id), [first.id]);
  assert.equal(s.items.length, 0);
  assert.equal((await api(b, "DELETE", `collections/${first.id}`)).status, 400, "the last collection stays");

  await api(b, "PATCH", `collections/${col.id}`, { deleted: false });
  s = (await api(b, "GET", "state")).json;
  assert.equal(s.collections.length, 2);
  assert.equal(s.items.length, 1);
});

test("the version fingerprint changes with every edit, and only the owner's", async () => {
  const env = makeEnv();
  const b = await signedIn(env, "ryan"), other = await signedIn(env, "josh");
  const v = async who => (await api(who, "GET", "version")).json.version;
  const s = (await api(b, "GET", "state")).json;
  assert.equal(await v(b), s.version, "state carries the same version");
  const v0 = await v(b), joshV = await v(other);
  const { json: it } = await api(b, "POST", "items", { title: "a", collection: s.collections[0].id });
  const v1 = await v(b);
  assert.notEqual(v1, v0);
  await api(b, "PATCH", `items/${it.id}`, { meta: { checklist: { done: false, priority: 1 } } });
  const v2 = await v(b);
  await api(b, "PATCH", `items/${it.id}`, { meta: { checklist: { done: false, priority: 2 } } });
  assert.notEqual(await v(b), v2, "two quick same-size edits still count");
  assert.notEqual(v2, v1);
  assert.equal(await v(other), joshV, "someone else's edits don't touch your version");
});

test("rejects bad input", async () => {
  const b = await signedIn(makeEnv(), "ryan");
  const col = await inbox(b);
  const post = body => api(b, "POST", "items", { collection: col.id, ...body });
  assert.equal((await post({ title: "" })).status, 400);
  assert.equal((await post({ title: "x", owner: "someone_else" })).status, 400, "unknown fields refused");
  assert.equal((await post({ title: "x", meta: { graph: {} } })).status, 400, "unknown plugin refused");
  assert.equal((await post({ title: "x", meta: { event: { start: "next tuesday" } } })).status, 400);
  assert.equal((await post({ title: "x", meta: { event: { start: "2026-10-20T10:00", end: "2026-10-20T09:00" } } })).status, 400);
  assert.equal((await post({ title: "x", meta: { event: { start: "2026-10-20", end: "2026-10-21T09:00" } } })).status, 400);
  assert.equal((await post({ title: "x", meta: { list: { order: "soon" } } })).status, 400);
  assert.equal((await post({ title: "x", meta: { list: { order: 1, parent: "../etc" } } })).status, 400);
  assert.equal((await post({ title: "x", meta: { checklist: "yes" } })).status, 400);
  assert.equal((await post({ title: "x".repeat(501) })).status, 400);
  assert.equal((await api(b, "POST", "items", { title: "x" })).status, 400, "needs a collection");
  assert.equal((await api(b, "POST", "items", [1, 2])).status, 400);
  assert.equal((await api(b, "POST", "collections", { name: "x", plugins: ["nope"] })).status, 400);
  assert.equal((await api(b, "POST", "collections", { name: "" })).status, 400);
  assert.equal((await api(b, "PATCH", "items/bad%20id", {})).status, 404);
  assert.equal((await api(b, "GET", "items")).status, 405);
  assert.equal((await api(b, "GET", "nothing")).status, 404);
});

test("old todo tasks become items the first time their owner opens Drift", async () => {
  const env = makeEnv();
  const b = await signedIn(env, "ryan");
  const { id: owner } = sql(env, "SELECT id FROM users WHERE username = 'ryan'")[0];
  await b.get("/todo/");                                       // tables exist
  const task = (id, data) => run(env, "INSERT INTO todo_tasks (owner, id, data, updated) VALUES (?, ?, ?, ?)", owner, id, JSON.stringify(data), "2026-01-01T00:00:00");
  task("t_aaaaaaaaaa", { title: "Pay rent", project: "home", priority: 3, due: "2026-11-01", tags: ["bills"], order: 5, created: "2026-01-01T00:00:00" });
  task("t_bbbbbbbbbb", { title: "Call mom", done: true, completed_at: "2026-02-01T10:00:00" });
  task("t_cccccccccc", { title: "Gone", deleted: true });

  const s = (await api(b, "GET", "state")).json;
  assert.deepEqual(s.collections.map(c => c.name).sort(), ["Inbox", "home"]);
  const home = s.collections.find(c => c.name === "home");
  const rent = s.items.find(i => i.id === "t_aaaaaaaaaa");
  assert.equal(rent.collection, home.id);
  assert.deepEqual(rent.meta, { checklist: { done: false, priority: 3, done_at: null }, list: { order: 5, parent: null }, event: { start: "2026-11-01", end: null } });
  assert.deepEqual(rent.tags, ["bills"]);
  const mom = s.items.find(i => i.id === "t_bbbbbbbbbb");
  assert.deepEqual(mom.meta.checklist, { done: true, priority: 0, done_at: "2026-02-01T10:00:00" });
  assert.equal(mom.meta.event, undefined);
  assert.equal(s.items.length, 2, "deleted tasks aren't brought over");
  assert.equal(sql(env, "SELECT COUNT(*) AS n FROM todo_tasks")[0].n, 0, "the old rows are gone");

  // The migrated items work like any other.
  assert.equal((await api(b, "PATCH", "items/t_aaaaaaaaaa", { meta: { checklist: { done: true } } })).status, 200);
  assert.equal((await api(b, "GET", "state")).json.collections.length, 2, "nothing is migrated twice");
});

test("only /todo and the account pages run code; the rest of the site is served as-is", async () => {
  const b = new Browser(makeEnv());
  assert.equal((await b.get("/")).status, 200);
  assert.equal((await b.get("/friends/")).status, 200);
  const bare = await b.get("/todo?x=1");
  assert.equal(bare.status, 308, "/todo redirects to /todo/");
  assert.equal(bare.location, ORIGIN + "/todo/?x=1");
  assert.equal((await b.get("/todo/index.html")).status, 303, "signed-out visitors go to sign in");
  assert.equal((await b.get("/todo/app.js")).status, 303, "the app's scripts too");
  assert.equal((await b.get("/todoish")).status, 200, "a different path that merely starts with 'todo'");
  assert.equal((await b.get("/login")).status, 200);
});
