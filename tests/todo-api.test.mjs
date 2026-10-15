// Tests for the Access check and the per-user todo API.
// Run with:  node --no-warnings --test tests/*.test.mjs
// Uses Node's built-in SQLite as a stand-in for D1 and a locally generated
// RSA key as a stand-in for the Cloudflare Access team's signing key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import worker from "../src/worker.js";

const TEAM = "testteam.cloudflareaccess.com";
const AUD = "aud-todo-123";
const ORIGIN = "https://example.com";

// ── fake Access signing key + certs endpoint ─────────────────────────────
const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1", alg: "RS256" };
const realFetch = globalThis.fetch;
globalThis.fetch = async url => {
  if (String(url) === `https://${TEAM}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [jwk] }));
  return realFetch(url);
};

const b64url = bytes => Buffer.from(bytes).toString("base64url");
async function token(claims = {}, { key = privateKey, kid = "k1" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const body = b64url(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], email: "ryan@example.com", iat: now, exp: now + 3600, ...claims }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head + "." + body));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

// ── minimal D1 shim over node:sqlite ─────────────────────────────────────
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { prepare: sql => stmt(sql) };
}

// Stands in for Cloudflare's static-asset server (public/).
const ASSETS = { fetch: async () => new Response("<!doctype html>static page", { headers: { "Content-Type": "text/html" } }) };
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD_TODO: AUD, TODO_DB: fakeD1(), ASSETS };

// Sends a request through the Worker the way Cloudflare would.
async function call(method, path, { jwt, body, origin, envOverride } = {}) {
  const headers = new Headers();
  if (jwt) headers.set("Cf-Access-Jwt-Assertion", jwt);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (origin) headers.set("Origin", origin);
  const request = new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await worker.fetch(request, envOverride || env);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

// ── Access check ─────────────────────────────────────────────────────────
test("refuses requests with no Access token, page and API alike", async () => {
  assert.equal((await call("GET", "/todo/")).status, 401);
  assert.equal((await call("GET", "/todo/api/tasks")).status, 401);
});

test("fails closed when Access is not configured", async () => {
  const r = await call("GET", "/todo/", { jwt: await token(), envOverride: { TODO_DB: env.TODO_DB, ASSETS } });
  assert.equal(r.status, 500);
});

test("refuses forged, expired, wrong-app and wrong-issuer tokens", async () => {
  const other = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await call("GET", "/todo/api/tasks", { jwt: await token({}, { key: other.privateKey }) })).status, 401);
  assert.equal((await call("GET", "/todo/api/tasks", { jwt: await token({ exp: now - 600 }) })).status, 401);
  assert.equal((await call("GET", "/todo/api/tasks", { jwt: await token({ aud: ["some-other-app"] }) })).status, 403);
  assert.equal((await call("GET", "/todo/api/tasks", { jwt: await token({ iss: "https://evil.cloudflareaccess.com" }) })).status, 401);
  assert.equal((await call("GET", "/todo/api/tasks", { jwt: await token({ email: undefined }) })).status, 403);
  assert.equal((await call("GET", "/todo/api/tasks", { jwt: "not.a.jwt" })).status, 401);
  // A valid header/payload with the signature stripped must not pass.
  const [h, p] = (await token()).split(".");
  assert.equal((await call("GET", "/todo/api/tasks", { jwt: `${h}.${p}.` })).status, 401);
});

test("serves the page to a signed-in user and marks it uncacheable", async () => {
  const r = await call("GET", "/todo/", { jwt: await token() });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("Cache-Control"), /no-store/);
});

// ── per-user task API ────────────────────────────────────────────────────
test("each user only ever sees and edits their own tasks", async () => {
  const ryan = await token({ email: "Ryan@Example.com" });
  const josh = await token({ email: "josh@example.com" });

  const made = await call("POST", "/todo/api/tasks", { jwt: ryan, body: { title: "Pay rent", project: "home", tags: ["#Bills"], priority: 3, due: "2026-11-01" } });
  assert.equal(made.status, 201);
  assert.match(made.json.id, /^t_[0-9a-f]{10}$/);
  assert.deepEqual(made.json.tags, ["bills"]);

  const mine = await call("GET", "/todo/api/tasks", { jwt: ryan });
  assert.equal(mine.json.tasks.length, 1);
  assert.equal(mine.json.stats.user, "ryan@example.com");
  assert.deepEqual(mine.json.projects, ["home"]);

  const theirs = await call("GET", "/todo/api/tasks", { jwt: josh });
  assert.equal(theirs.json.tasks.length, 0);

  // Josh can't edit or delete Ryan's task even knowing its id.
  assert.equal((await call("PATCH", `/todo/api/tasks/${made.json.id}`, { jwt: josh, body: { title: "hacked" } })).status, 404);
  assert.equal((await call("DELETE", `/todo/api/tasks/${made.json.id}`, { jwt: josh })).status, 404);
  assert.equal((await call("GET", "/todo/api/tasks", { jwt: ryan })).json.tasks[0].title, "Pay rent");
});

test("updates merge per field, done stamps completion, delete is undoable", async () => {
  const jwt = await token({ email: "merge@example.com" });
  const { json: t } = await call("POST", "/todo/api/tasks", { jwt, body: { title: "Water plants", due: "2026-10-20", notes: "ferns" } });

  const done = await call("PATCH", `/todo/api/tasks/${t.id}`, { jwt, body: { done: true } });
  assert.equal(done.json.done, true);
  assert.match(done.json.completed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(done.json.notes, "ferns", "fields not sent are kept");

  const cleared = await call("PATCH", `/todo/api/tasks/${t.id}`, { jwt, body: { due: null, done: false } });
  assert.equal(cleared.json.due, null);
  assert.equal(cleared.json.completed_at, null);

  assert.equal((await call("DELETE", `/todo/api/tasks/${t.id}`, { jwt })).status, 200);
  assert.equal((await call("GET", "/todo/api/tasks", { jwt })).json.tasks.length, 0);
  await call("PATCH", `/todo/api/tasks/${t.id}`, { jwt, body: { deleted: false } });
  assert.equal((await call("GET", "/todo/api/tasks", { jwt })).json.tasks.length, 1);
});

test("rejects bad input", async () => {
  const jwt = await token({ email: "bad@example.com" });
  const post = body => call("POST", "/todo/api/tasks", { jwt, body });
  assert.equal((await post({ title: "" })).status, 400);
  assert.equal((await post({ title: "x", owner: "someone@else.com" })).status, 400, "unknown fields refused");
  assert.equal((await post({ title: "x", due: "next tuesday" })).status, 400);
  assert.equal((await post({ title: "x".repeat(501) })).status, 400);
  assert.equal((await post([1, 2])).status, 400);
  assert.equal((await call("PATCH", "/todo/api/tasks/bad%20id", { jwt, body: {} })).status, 404);
});

test("refuses writes from another website", async () => {
  const jwt = await token({ email: "csrf@example.com" });
  const r = await call("POST", "/todo/api/tasks", { jwt, body: { title: "x" }, origin: "https://evil.example" });
  assert.equal(r.status, 403);
  assert.equal((await call("POST", "/todo/api/tasks", { jwt, body: { title: "x" }, origin: ORIGIN })).status, 201);
});

test("only /todo is protected; the rest of the site is served as-is", async () => {
  assert.equal((await call("GET", "/")).status, 200);
  assert.equal((await call("GET", "/friends/")).status, 200);
  assert.equal((await call("GET", "/todo")).status, 401);
  assert.equal((await call("GET", "/todo/index.html")).status, 401);
  assert.equal((await call("GET", "/todoish")).status, 200, "a different path that merely starts with 'todo'");
});
