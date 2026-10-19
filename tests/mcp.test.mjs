// The MCP server for Drift (src/mcp.js): API-key sign-in, the protocol, and each tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Browser, makeEnv, sql, sqlOne, run, ORIGIN } from "./helpers.mjs";
import worker from "../src/worker.js";
import { TOOL_NAMES } from "../src/mcp.js";

const PW = "correct horse battery";
let rid = 0;

// A person with an API key, like an agent would hold.
async function agent(env, name) {
  const b = new Browser(env);
  assert.equal((await b.signup(name)).status, 303);
  const r = await b.post("/account/apikeys", { name: "agent", password: PW });
  const key = r.text.match(/sf_[A-Za-z0-9_-]{20,}/)[0];
  const raw = (body, { headers = {}, method = "POST", cookie = null, auth = "Bearer " + key } = {}) =>
    b.req(method, "/mcp", { json: method === "POST" ? body : undefined, origin: null, cookie, headers: { ...(auth ? { Authorization: auth } : {}), ...headers } });
  const rpc = async (method, params) => (await raw({ jsonrpc: "2.0", id: ++rid, method, params })).json;
  // Calls a tool; returns the parsed JSON, or { error } when the tool reported one.
  const call = async (tool, args = {}) => {
    const j = await rpc("tools/call", { name: tool, arguments: args });
    assert.ok(j.result, JSON.stringify(j));
    const text = j.result.content[0].text;
    return j.result.isError ? { error: text } : JSON.parse(text);
  };
  return { b, key, raw, rpc, call, env, name };
}

test("a missing, malformed, unknown or revoked key is refused", async () => {
  const env = makeEnv(), a = await agent(env, "ryan");
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  for (const auth of [null, "Bearer", "Bearer nope", "Bearer sf_" + "a".repeat(43), "Basic " + a.key]) {
    const r = await a.raw(ping, { auth });
    assert.equal(r.status, 401, String(auth));
    assert.match(r.headers.get("WWW-Authenticate"), /^Bearer/);
    assert.equal(r.json.jsonrpc, "2.0");
    assert.equal(r.json.error.code, -32001);
    assert.match(r.json.error.message, /API key/);
  }
  assert.equal((await a.raw(ping)).status, 200);
  const { id_hash } = sqlOne(env, "SELECT id_hash FROM api_keys");
  await a.b.post("/account/apikeys/revoke", { id: id_hash });
  assert.equal((await a.raw(ping)).status, 401, "revoked key stops working");
});

test("the key's owner must still be allowed to use Drift", async () => {
  const env = makeEnv(), a = await agent(env, "ryan");
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  run(env, "UPDATE users SET must_change_pw = 1");
  const refused = await a.raw(ping);
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code, -32002);
  run(env, "UPDATE users SET must_change_pw = 0, disabled = 1");
  assert.equal((await a.raw(ping)).status, 403);
  run(env, "UPDATE users SET disabled = 0");
  run(env, "DELETE FROM user_areas WHERE area = 'todo'");
  assert.equal((await a.raw(ping)).status, 403);
});

test("a browser session alone can't use /mcp, and a key can't use /todo/api", async () => {
  const env = makeEnv(), a = await agent(env, "ryan");
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  const withCookie = await a.b.req("POST", "/mcp", { json: ping, origin: null });
  assert.equal(withCookie.status, 401);
  const viaKey = await new Browser(env).req("GET", "/todo/api/state", { headers: { Authorization: "Bearer " + a.key } });
  assert.equal(viaKey.status, 401);
  assert.equal((await a.raw(ping, { headers: { Origin: "https://evil.example" } })).status, 403, "requests from a browser are refused");
});

test("only POST is allowed", async () => {
  const a = await agent(makeEnv(), "ryan");
  for (const method of ["GET", "DELETE"]) {
    const r = await a.raw(undefined, { method });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get("Allow"), "POST");
    assert.equal(r.json.error.message, "method not allowed");
  }
});

test("protocol: initialize, ping, tools/list, notifications, errors, batches", async () => {
  const a = await agent(makeEnv(), "ryan");
  const init = await a.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.deepEqual(Object.keys(init.result.capabilities), ["tools"]);
  assert.equal((await a.rpc("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion, "2025-06-18");
  assert.deepEqual((await a.rpc("ping")).result, {});

  const list = (await a.rpc("tools/list")).result.tools;
  assert.deepEqual(list.map(t => t.name), TOOL_NAMES);
  for (const t of list) { assert.ok(t.description.length > 20, t.name); assert.equal(t.inputSchema.type, "object", t.name); }

  const note = await a.raw({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(note.status, 202);
  assert.equal(note.text, "");

  assert.equal((await a.rpc("nope")).error.code, -32601);
  assert.equal((await a.rpc("tools/call", { name: "nope" })).error.code, -32602);
  assert.equal((await a.rpc("tools/call", { name: "drift_get_state", arguments: [] })).error.code, -32602);
  assert.equal((await a.raw({ hello: 1 })).json.error.code, -32600);

  const batch = await a.raw([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "ping" }]);
  assert.deepEqual(batch.json.map(m => m.id), [1, 2]);
  assert.equal((await a.raw([])).status, 400);
});

test("bad JSON and oversize bodies get clean errors", async () => {
  const a = await agent(makeEnv(), "ryan");
  const send = (body, headers = {}) => worker.fetch(new Request(ORIGIN + "/mcp", { method: "POST", body, headers: { Authorization: "Bearer " + a.key, ...headers } }), a.env);
  const bad = await send("{nope");
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);
  const empty = await send("");
  assert.equal(empty.status, 400);

  const big = await a.raw({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(70 * 1024) } });
  assert.equal(big.status, 413);
  assert.equal(big.json.error.code, -32600);
  // A declared size over the limit is refused without reading the body.
  const declared = await send("{}", { "Content-Length": String(70 * 1024) });
  assert.equal(declared.status, 413);
});

test("drift_get_state can narrow by collection, drop notes, and page through items", async () => {
  const a = await agent(makeEnv(), "ryan");
  const inbox = (await a.call("drift_get_state")).collections[0].id;
  const other = (await a.call("drift_create_collection", { name: "Other" })).id;
  for (let i = 1; i <= 5; i++) await a.call("drift_create_item", { title: "item " + i, collection: i === 5 ? other : inbox, notes: "notes " + i });
  const all = await a.call("drift_get_state");
  assert.equal(all.items.length, 5);
  assert.equal(all.total_items, 5);
  assert.equal(all.next_cursor, undefined, "everything fit on one page");
  assert.ok(all.items.every(i => i.notes === i.title.replace("item", "notes")));

  const only = await a.call("drift_get_state", { collection: other });
  assert.deepEqual(only.items.map(i => i.title), ["item 5"]);
  assert.equal(only.collections.length, 2, "collections are always complete");

  const bare = await a.call("drift_get_state", { include_notes: false });
  assert.ok(bare.items.every(i => !("notes" in i)));

  // Pages follow next_cursor until it runs out, with no repeats or gaps.
  const seen = [];
  let cursor;
  for (let n = 0; n < 5; n++) {
    const page = await a.call("drift_get_state", { limit: 2, ...(cursor ? { cursor } : {}) });
    assert.equal(page.total_items, 5);
    seen.push(...page.items.map(i => i.id));
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5);
  assert.deepEqual(seen, all.items.map(i => i.id), "same order as an unpaged read");

  assert.match((await a.call("drift_get_state", { limit: 0 })).error, /limit must be/);
  assert.match((await a.call("drift_get_state", { limit: 501 })).error, /limit must be/);
  assert.match((await a.call("drift_get_state", { limit: "2" })).error, /limit must be/);
  assert.match((await a.call("drift_get_state", { cursor: "abc" })).error, /cursor must be/);
  assert.match((await a.call("drift_get_state", { collection: "c_ffffffffff" })).error, /collection not found/);
  assert.match((await a.call("drift_get_state", { collection: "nope" })).error, /collection must be/);
  assert.deepEqual((await a.call("drift_get_state", { cursor: "99" })).items, []);
});

test("using a key records last_used, but not on every call", async () => {
  const env = makeEnv(), a = await agent(env, "ryan");
  assert.equal(sqlOne(env, "SELECT last_used FROM api_keys").last_used, null);
  await a.rpc("ping");
  const first = sqlOne(env, "SELECT last_used FROM api_keys").last_used;
  assert.ok(first > 0);
  run(env, "UPDATE api_keys SET last_used = ?", first - 60);
  await a.rpc("ping");
  assert.equal(sqlOne(env, "SELECT last_used FROM api_keys").last_used, first - 60, "recent use isn't rewritten");
  run(env, "UPDATE api_keys SET last_used = ?", first - 3600);
  await a.rpc("ping");
  assert.ok(sqlOne(env, "SELECT last_used FROM api_keys").last_used >= first, "stale use is refreshed");
});

test("items: create, read, update, delete and restore", async () => {
  const a = await agent(makeEnv(), "ryan");
  const s = await a.call("drift_get_state");
  assert.equal(s.user.username, "ryan");
  assert.equal(s.collections[0].name, "Inbox");
  const col = s.collections[0].id;

  const it = await a.call("drift_create_item", { title: "Pay rent", collection: col, tags: ["#Bills"], meta: { checklist: { done: false, priority: 3 }, event: { start: "2026-03-01T09:00" } } });
  assert.match(it.id, /^i_/);
  assert.deepEqual(it.tags, ["bills"]);

  const up = await a.call("drift_update_item", { id: it.id, title: "Pay rent now", meta: { event: null } });
  assert.equal(up.title, "Pay rent now");
  assert.equal(up.meta.event, undefined);
  assert.equal(up.meta.checklist.priority, 3);

  await a.call("drift_delete_item", { id: it.id });
  assert.equal((await a.call("drift_get_state")).items.length, 0);
  await a.call("drift_update_item", { id: it.id, deleted: false });
  assert.equal((await a.call("drift_get_state")).items.length, 1);
});

test("mistakes come back as readable tool errors, not protocol errors", async () => {
  const a = await agent(makeEnv(), "ryan");
  const col = (await a.call("drift_get_state")).collections[0].id;
  assert.match((await a.call("drift_create_item", { collection: col })).error, /title is required/);
  assert.match((await a.call("drift_create_item", { title: "x", collection: "c_ffffffffff" })).error, /collection not found/);
  assert.match((await a.call("drift_update_item", { id: "i_ffffffffff", title: "x" })).error, /not found/);
  assert.match((await a.call("drift_update_item", { id: "nonsense" })).error, /id must be/);
  assert.match((await a.call("drift_update_item", { id: "c_ffffffffff" })).error, /id must be/);
  assert.match((await a.call("drift_get_agenda", { day: "tomorrow" })).error, /YYYY-MM-DD/);
  assert.match((await a.call("drift_create_item", { title: "x".repeat(501), collection: col })).error, /longer than 500/);
});

test("collections: create, rename, delete, and never the last one", async () => {
  const a = await agent(makeEnv(), "ryan");
  const inbox = (await a.call("drift_get_state")).collections[0].id;
  const c = await a.call("drift_create_collection", { name: "Groceries", plugins: ["checklist"] });
  assert.match(c.id, /^c_/);
  assert.equal((await a.call("drift_update_collection", { id: c.id, name: "Food" })).name, "Food");
  await a.call("drift_delete_collection", { id: c.id });
  assert.equal((await a.call("drift_get_state")).collections.length, 1);
  assert.match((await a.call("drift_delete_collection", { id: inbox })).error, /at least one collection/);
  assert.match((await a.call("drift_create_collection", {})).error, /name is required/);
});

test("agenda lists events due and late for the day you give", async () => {
  const a = await agent(makeEnv(), "ryan");
  const col = (await a.call("drift_get_state")).collections[0].id;
  await a.call("drift_create_item", { title: "Dentist", collection: col, meta: { event: { start: "2026-03-05T14:30" } } });
  await a.call("drift_create_item", { title: "Old", collection: col, meta: { event: { start: "2026-03-01" } } });
  const ag = await a.call("drift_get_agenda", { day: "2026-03-05" });
  assert.deepEqual(ag.due.map(e => e.title), ["Dentist"]);
  assert.equal(ag.due[0].when, "2:30 pm");
  assert.deepEqual(ag.late.map(e => e.title), ["Old"]);
});

test("one person's key never reaches another's data, even with the ids", async () => {
  const env = makeEnv(), ryan = await agent(env, "ryan"), josh = await agent(env, "josh");
  const col = (await ryan.call("drift_get_state")).collections[0].id;
  const it = await ryan.call("drift_create_item", { title: "secret", collection: col });
  assert.equal((await josh.call("drift_get_state")).items.length, 0);
  assert.match((await josh.call("drift_update_item", { id: it.id, title: "hacked" })).error, /not found/);
  assert.match((await josh.call("drift_delete_item", { id: it.id })).error, /not found/);
  assert.match((await josh.call("drift_update_collection", { id: col, name: "hacked" })).error, /not found/);
  assert.match((await josh.call("drift_create_item", { title: "x", collection: col })).error, /collection not found/);
  assert.match((await josh.call("drift_share_collection", { id: col, username: "josh" })).error, /not found/);
  assert.equal((await ryan.call("drift_get_state")).items[0].title, "secret");
});

test("sharing: edit lets them write, view doesn't, and unsharing takes it away", async () => {
  const env = makeEnv(), ryan = await agent(env, "ryan"), josh = await agent(env, "josh");
  const col = (await ryan.call("drift_get_state")).collections[0].id;
  assert.match((await ryan.call("drift_share_collection", { id: col, username: "nobody" })).error, /no Drift account/);

  assert.equal((await ryan.call("drift_share_collection", { id: col, username: "Josh", role: "view" })).role, "view");
  assert.match((await josh.call("drift_create_item", { title: "x", collection: col })).error, /view-only/);
  assert.equal((await josh.call("drift_get_state")).collections.find(c => c.id === col).role, "view");

  await ryan.call("drift_share_collection", { id: col, username: "josh", role: "edit" });
  const it = await josh.call("drift_create_item", { title: "from josh", collection: col });
  assert.equal((await ryan.call("drift_get_state")).items[0].id, it.id);

  await ryan.call("drift_unshare_collection", { id: col, username: "josh" });
  assert.match((await josh.call("drift_create_item", { title: "x", collection: col })).error, /collection not found/);
  assert.match((await ryan.call("drift_unshare_collection", { id: col, username: "josh" })).error, /not found/);
});

test("store plugins can be installed and removed", async () => {
  const env = makeEnv(), a = await agent(env, "ryan");
  const owner = sqlOne(env, "SELECT id FROM users WHERE username = 'ryan'").id;
  assert.match((await a.call("drift_install_plugin", { id: "mood" })).error, /not found/, "not in the store yet");
  assert.match((await a.call("drift_install_plugin", { id: "Bad Id!" })).error, /not found/);

  run(env, "INSERT INTO store_plugins (id, owner, created_at) VALUES ('mood', ?, 1)", owner);
  run(env, "INSERT INTO store_versions (plugin_id, version, status, name, description, code, created_at, reviewed_at) VALUES ('mood', 1, 'approved', 'Mood', 'd', 'x', 1, 1)");
  assert.deepEqual((await a.call("drift_install_plugin", { id: "mood" })).installed, ["mood"]);
  assert.equal((await a.call("drift_get_state")).store.find(p => p.id === "mood").installed, true);
  assert.deepEqual((await a.call("drift_uninstall_plugin", { id: "mood" })).installed, []);
});

test("llm.txt names every tool", () => {
  const txt = readFileSync(new URL("../public/llm.txt", import.meta.url), "utf8");
  for (const name of TOOL_NAMES) assert.ok(txt.includes(name), `llm.txt should mention ${name}`);
});
