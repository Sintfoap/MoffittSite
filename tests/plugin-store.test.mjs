// Tests for the plugin store: drafts, review, and what the store shows.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, run, sqlOne } from "./helpers.mjs";

async function signedIn(env, name) {
  const b = new Browser(env);
  assert.equal((await b.signup(name)).status, 303);
  return b;
}
// An admin who has finished setting up (two-factor on), made straight in the database.
async function reviewer(env, name = "ryan") {
  const b = await signedIn(env, name);
  const { id } = sqlOne(env, "SELECT id FROM users WHERE username = ?", name);
  run(env, "INSERT INTO user_areas (user_id, area) VALUES (?, 'admin')", id);
  run(env, "UPDATE users SET totp_secret = 'AAAAAAAAAAAAAAAA' WHERE id = ?", id);
  return b;
}
const api = (b, method, path, json) => b.req(method, "/plugins/api" + path, json === undefined ? {} : { json });
const CODE = "export default { id: 'mood', name: 'Mood', clean: v => v };";

test("the store page needs a signed-in Drift account", async () => {
  const env = makeEnv();
  const anon = new Browser(env);
  assert.match((await anon.get("/plugins/")).location, /^\/login\?next=%2Fplugins%2F/);
  assert.equal((await anon.get("/plugins/api/state")).status, 401);
  assert.equal((await anon.get("/plugins")).status, 308);

  const b = await signedIn(env, "josh");
  const page = await b.get("/plugins/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("Cache-Control"), /no-store/);
  assert.match(page.headers.get("Content-Security-Policy"), /script-src 'self'(;|$)/);
  assert.match((await b.get("/dashboard")).text, /href="\/plugins\/"/);
});

test("a plugin is private until an admin approves it", async () => {
  const env = makeEnv();
  const admin = await reviewer(env);
  const josh = await signedIn(env, "josh"), sam = await signedIn(env, "sam");

  const made = await api(josh, "POST", "/mine", { id: "mood", name: "Mood", description: "How you felt.", code: CODE });
  assert.equal(made.status, 201);
  assert.equal(made.json.working.status, "draft");
  assert.equal(made.json.published, null);

  // Not in the store, and nobody else can fetch or change it.
  assert.deepEqual((await api(sam, "GET", "/state")).json.store, []);
  assert.equal((await api(sam, "GET", "/store/mood")).status, 404);
  assert.equal((await api(sam, "PATCH", "/mine/mood", { code: "x" })).status, 404);
  assert.equal((await api(sam, "POST", "/mine/mood/submit", {})).status, 404);
  assert.equal((await api(sam, "DELETE", "/mine/mood")).status, 404);

  // Submitting puts it in the queue; only admins see the queue or decide.
  assert.equal((await api(josh, "POST", "/mine/mood/submit", { note: "First version" })).json.pending.version, 1);
  assert.equal((await api(josh, "GET", "/review")).status, 403);
  assert.equal((await api(josh, "POST", "/review/mood/1", { decision: "approve" })).status, 403);
  const state = (await api(admin, "GET", "/state")).json;
  assert.equal(state.user.reviewer, true);
  assert.equal(state.waiting, 1);
  const [waiting] = (await api(admin, "GET", "/review")).json;
  assert.equal(waiting.author, "josh");
  assert.equal(waiting.note, "First version");
  assert.equal(waiting.live_code, null);

  assert.equal((await api(admin, "POST", "/review/mood/1", { decision: "approve", note: "" })).status, 200);
  const listed = (await api(sam, "GET", "/state")).json.store;
  assert.deepEqual(listed.map(p => [p.id, p.name, p.author, p.version]), [["mood", "Mood", "josh", 1]]);
  assert.equal(listed[0].code, undefined, "the list leaves code out");
  assert.equal((await api(sam, "GET", "/store/mood")).json.code, CODE);
  assert.deepEqual((await api(admin, "GET", "/review")).json, []);
});

test("edits after approval stay private until the next approval", async () => {
  const env = makeEnv();
  const admin = await reviewer(env);
  const josh = await signedIn(env, "josh");
  await api(josh, "POST", "/mine", { id: "mood", name: "Mood", code: CODE });
  await api(josh, "POST", "/mine/mood/submit", {});
  await api(admin, "POST", "/review/mood/1", { decision: "approve" });

  const saved = await api(josh, "PATCH", "/mine/mood", { name: "Mood 2", code: CODE + "// v2" });
  assert.equal(saved.json.working.version, 2);
  assert.equal(saved.json.working.status, "draft");
  assert.equal((await api(josh, "GET", "/store/mood")).json.name, "Mood", "the store keeps the approved version");

  // A rejection needs a reason, keeps the live version, and the next save starts from the rejected code.
  await api(josh, "POST", "/mine/mood/submit", {});
  assert.equal((await api(admin, "GET", "/review")).json[0].live_code, CODE);
  assert.equal((await api(admin, "POST", "/review/mood/2", { decision: "reject" })).status, 400);
  assert.equal((await api(admin, "POST", "/review/mood/2", { decision: "reject", note: "Reads every item's notes." })).status, 200);
  assert.equal((await api(admin, "POST", "/review/mood/2", { decision: "approve" })).status, 404, "already decided");
  const mine = (await api(josh, "GET", "/state")).json.mine[0];
  assert.equal(mine.lastReview.status, "rejected");
  assert.equal(mine.lastReview.note, "Reads every item's notes.");
  assert.equal(mine.published.version, 1);
  const again = await api(josh, "PATCH", "/mine/mood", { description: "fixed" });
  assert.equal(again.json.working.version, 3);
  assert.equal(again.json.working.code, CODE + "// v2");
  assert.equal((await api(josh, "GET", "/store/mood")).json.version, 1);
});

test("withdrawing and resubmitting", async () => {
  const env = makeEnv();
  const josh = await signedIn(env, "josh");
  await api(josh, "POST", "/mine", { id: "mood", name: "Mood", code: CODE });
  assert.equal((await api(josh, "POST", "/mine/mood/withdraw")).status, 400, "nothing to withdraw");
  await api(josh, "POST", "/mine/mood/submit", {});
  assert.equal((await api(josh, "POST", "/mine/mood/submit", {})).status, 400, "no draft left to submit");

  // Saving while it waits makes a new draft; the submitted version is untouched.
  const edited = await api(josh, "PATCH", "/mine/mood", { code: CODE + "// edit" });
  assert.equal(edited.json.working.version, 2);
  assert.equal(edited.json.pending.version, 1);
  // Submitting the new draft replaces what was waiting.
  const resub = await api(josh, "POST", "/mine/mood/submit", {});
  assert.equal(resub.json.pending.version, 2);
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM store_versions WHERE status = 'pending'").n, 1);

  const back = await api(josh, "POST", "/mine/mood/withdraw");
  assert.equal(back.json.pending, null);
  assert.equal(back.json.working.status, "draft");
  assert.equal(back.json.working.code, CODE + "// edit");
});

test("rejects bad input", async () => {
  const env = makeEnv();
  const josh = await signedIn(env, "josh"), sam = await signedIn(env, "sam");
  const bad = async (body, msg) => {
    const r = await api(josh, "POST", "/mine", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.json.error, msg);
  };
  await bad({ id: "Mood", name: "x" }, /lowercase letters/);
  await bad({ id: "m", name: "x" }, /lowercase letters/);
  await bad({ id: "checklist", name: "x" }, /Drift's own/);
  await bad({ id: "mood" }, /name is required/);
  await bad({ id: "mood", name: "x", code: 5 }, /code must be text/);
  await bad({ id: "mood", name: "x", extra: 1 }, /unknown field/);
  await bad({ id: "mood", name: "x", code: "a".repeat(64 * 1024 + 1) }, /longer than/);

  await api(josh, "POST", "/mine", { id: "mood", name: "Mood" });
  assert.match((await api(sam, "POST", "/mine", { id: "mood", name: "Mine" })).json.error, /taken/);
  assert.match((await api(josh, "POST", "/mine/mood/submit", {})).json.error, /no code/);

  // Writes from another site are refused.
  const r = await josh.req("POST", "/plugins/api/mine", { json: { id: "other", name: "x" }, origin: "https://evil.test" });
  assert.equal(r.status, 403);
});

test("deleting a plugin or its author removes it from the store", async () => {
  const env = makeEnv();
  const admin = await reviewer(env);
  const josh = await signedIn(env, "josh");
  for (const id of ["mood", "habit"]) {
    await api(josh, "POST", "/mine", { id, name: id, code: CODE });
    await api(josh, "POST", `/mine/${id}/submit`, {});
    await api(admin, "POST", `/review/${id}/1`, { decision: "approve" });
  }
  assert.equal((await api(josh, "DELETE", "/mine/mood")).status, 200);
  assert.deepEqual((await api(admin, "GET", "/state")).json.store.map(p => p.id), ["habit"]);

  const { id } = sqlOne(env, "SELECT id FROM users WHERE username = 'josh'");
  await admin.post("/admin/delete", { user_id: id, confirm: "josh" });
  assert.deepEqual((await api(admin, "GET", "/state")).json.store, []);
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM store_versions").n, 0);
});
