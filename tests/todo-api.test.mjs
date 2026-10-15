// Tests for the per-user todo API behind the site's own sign-in.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, ORIGIN } from "./helpers.mjs";

async function signedIn(env, name) {
  const b = new Browser(env);
  assert.equal((await b.signup(name)).status, 303);
  return b;
}
const api = (b, method, path, json) => b.req(method, "/todo/api/tasks" + path, json === undefined ? {} : { json });

test("serves the page to a signed-in user and marks it uncacheable", async () => {
  const b = await signedIn(makeEnv(), "ryan");
  const r = await b.get("/todo/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("Cache-Control"), /no-store/);
});

test("each user only ever sees and edits their own tasks", async () => {
  const env = makeEnv();
  const ryan = await signedIn(env, "ryan"), josh = await signedIn(env, "josh");

  const made = await api(ryan, "POST", "", { title: "Pay rent", project: "home", tags: ["#Bills"], priority: 3, due: "2026-11-01" });
  assert.equal(made.status, 201);
  assert.match(made.json.id, /^t_[0-9a-f]{10}$/);
  assert.deepEqual(made.json.tags, ["bills"]);

  const mine = await api(ryan, "GET", "");
  assert.equal(mine.json.tasks.length, 1);
  assert.deepEqual(mine.json.projects, ["home"]);
  assert.equal((await api(josh, "GET", "")).json.tasks.length, 0);

  // Josh can't edit or delete Ryan's task even knowing its id.
  assert.equal((await api(josh, "PATCH", `/${made.json.id}`, { title: "hacked" })).status, 404);
  assert.equal((await api(josh, "DELETE", `/${made.json.id}`)).status, 404);
  assert.equal((await api(ryan, "GET", "")).json.tasks[0].title, "Pay rent");
});

test("updates merge per field, done stamps completion, delete is undoable", async () => {
  const b = await signedIn(makeEnv(), "ryan");
  const { json: t } = await api(b, "POST", "", { title: "Water plants", due: "2026-10-20", notes: "ferns" });

  const done = await api(b, "PATCH", `/${t.id}`, { done: true });
  assert.equal(done.json.done, true);
  assert.match(done.json.completed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(done.json.notes, "ferns", "fields not sent are kept");

  const cleared = await api(b, "PATCH", `/${t.id}`, { due: null, done: false });
  assert.equal(cleared.json.due, null);
  assert.equal(cleared.json.completed_at, null);

  assert.equal((await api(b, "DELETE", `/${t.id}`)).status, 200);
  assert.equal((await api(b, "GET", "")).json.tasks.length, 0);
  await api(b, "PATCH", `/${t.id}`, { deleted: false });
  assert.equal((await api(b, "GET", "")).json.tasks.length, 1);
});

test("rejects bad input", async () => {
  const b = await signedIn(makeEnv(), "ryan");
  const post = body => api(b, "POST", "", body);
  assert.equal((await post({ title: "" })).status, 400);
  assert.equal((await post({ title: "x", owner: "someone_else" })).status, 400, "unknown fields refused");
  assert.equal((await post({ title: "x", due: "next tuesday" })).status, 400);
  assert.equal((await post({ title: "x".repeat(501) })).status, 400);
  assert.equal((await post([1, 2])).status, 400);
  assert.equal((await api(b, "PATCH", "/bad%20id", {})).status, 404);
});

test("only /todo and the account pages run code; the rest of the site is served as-is", async () => {
  const b = new Browser(makeEnv());
  assert.equal((await b.get("/")).status, 200);
  assert.equal((await b.get("/friends/")).status, 200);
  const bare = await b.get("/todo?x=1");
  assert.equal(bare.status, 308, "/todo redirects to /todo/");
  assert.equal(bare.location, ORIGIN + "/todo/?x=1");
  assert.equal((await b.get("/todo/index.html")).status, 303, "signed-out visitors go to sign in");
  assert.equal((await b.get("/todoish")).status, 200, "a different path that merely starts with 'todo'");
  assert.equal((await b.get("/login")).status, 200);
});
