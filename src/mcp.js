// The MCP server for Drift: lets an AI agent do what a signed-in person can do
// in Drift, using an API key made on /account (src/apikeys.js).
//
// Streamable HTTP, stateless, plain JSON replies (no streaming):
//   POST /mcp   one JSON-RPC message, or an array of them. `Authorization: Bearer sf_…`.
// Cookies are ignored, so a browser can't be tricked into calling this, and
// requests that carry an Origin header (browsers, DNS rebinding) are refused.
// Every tool calls the same functions as Drift's web API (src/drift.js), so
// validation, ownership and sharing rules are identical.

import { findKey, touchKey } from "./apikeys.js";
import { getUser, areaOf } from "./auth.js";
import { state, agenda, createItem, updateItem, createCollection, updateCollection, setBases, shareCollection, unshareCollection, BadRequest, ID } from "./drift.js";
import { planDay } from "./routing.js";
import { PROFILES } from "../public/todo/route.js";
import { install, uninstall, PLUGIN_ID } from "./store.js";

export const MCP_PATHS = /^\/mcp\/?$/;
const MAX_BODY = 64 * 1024;
const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const USERNAME = /^[a-z0-9_.-]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const reply = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
// Refusals before any message is read are JSON-RPC errors too, so a client can show the reason.
const CODES = { 401: -32001, 403: -32002, 405: -32600, 413: -32600, 500: -32603 };
const denied = (status, message, headers = {}) =>
  reply(rpcError(null, CODES[status], message), status, status === 401 ? { "WWW-Authenticate": 'Bearer realm="drift"', ...headers } : headers);

// ── what a tool can fail with, in words the model can act on ───────────────
class ToolError extends Error {}
const fail = msg => { throw new ToolError(msg); };
const found = v => v ?? fail("not found");
const needId = (args, prefix, key = "id") => {
  const id = String(args[key] ?? "");
  if (!ID.test(id) || !id.startsWith(prefix + "_")) fail(`${key} must be ${prefix === "i" ? "an item" : "a collection"} id like ${prefix}_0123456789`);
  return id;
};
const rest = ({ id, ...fields }) => fields;

// ── tools ──────────────────────────────────────────────────────────────────
const PAGE_DEFAULT = 200, PAGE_MAX = 500;

async function getState(env, user, a) {
  const limit = a.limit ?? PAGE_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) fail(`limit must be a whole number from 1 to ${PAGE_MAX}`);
  const cursor = a.cursor ?? "0";
  if (!/^\d{1,9}$/.test(String(cursor))) fail("cursor must be a next_cursor from a previous result");
  const s = await state(env, user);
  let items = s.items;
  if (a.collection != null) {
    const id = needId(a, "c", "collection");
    if (!s.collections.some(c => c.id === id)) fail("collection not found");
    items = items.filter(it => it.collection === id);
  }
  items = [...items].sort((x, y) => x.created.localeCompare(y.created) || x.id.localeCompare(y.id));
  const from = Number(cursor), page = items.slice(from, from + limit);
  const out = { ...s, items: a.include_notes === false ? page.map(({ notes, ...it }) => it) : page, total_items: items.length };
  if (from + limit < items.length) out.next_cursor = String(from + limit);
  return out;
}

const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const idProp = (what, prefix) => ({ type: "string", description: `${what} id, like ${prefix}_0123456789 (from drift_get_state)` });

const META = `meta maps a plugin id to that plugin's data for this item; null removes the item from that plugin. Built-in plugins: ` +
  `checklist {done: boolean, priority: 0-3}; event {start, end} where each is "YYYY-MM-DD" (all day) or "YYYY-MM-DDTHH:MM" and end may be null; ` +
  `list {order: number, parent: item id or null} (an outline); graph {links: [item ids], rel?: {item id: link type}, kind?} ` +
  `(a typed link like "leads to" points from this item to the other; on a day's route, linked places are visited one after the other); ` +
  `location {place, lat, lng}: send {place: "an address or a place's name"} and the site finds it on the map, or {lat, lng} and it names the spot. Store plugins use their own ids. ` +
  `A plugin only applies to an item if it is switched on for the item's collection.`;
const ITEM_FIELDS = {
  title: { type: "string", description: "Up to 500 characters." },
  notes: { type: "string", description: "Up to 20000 characters." },
  tags: { type: "array", items: { type: "string" }, description: "Lowercased, without #." },
  collection: idProp("Collection", "c"),
  meta: { type: "object", description: META },
};
const COLLECTION_FIELDS = {
  name: { type: "string", description: "Up to 100 characters." },
  plugins: { type: "array", items: { type: "string" }, description: "Plugin ids switched on: built-in (checklist, event, list, graph, location) or installed store plugins." },
  view: { type: "string", description: "Plugin id whose view opens first, or empty." },
  order: { type: "number", description: "Sort position among your collections." },
};

const TOOLS = [
  { name: "drift_get_state", description: "Read your collections (with who they're shared with and your role in each), items, built-in and store plugins, and your username. Call this first to learn the ids. " +
      `Items come ${PAGE_DEFAULT} at a time in a stable order: when the result has next_cursor, call again with that cursor for more. ` +
      "To keep results small, pass collection to get only one collection's items, include_notes: false to leave out notes, or a smaller limit. Collections and plugins are always complete. " +
      "Items can change between pages; the version field changes whenever your data does.",
    inputSchema: obj({
      collection: idProp("Only return items in this collection;", "c"),
      include_notes: { type: "boolean", description: "Whether items include their notes. Default true." },
      limit: { type: "integer", minimum: 1, maximum: PAGE_MAX, description: `Items per page. Default ${PAGE_DEFAULT}, at most ${PAGE_MAX}.` },
      cursor: { type: "string", description: "The next_cursor from the previous page." },
    }), run: getState },
  { name: "drift_get_agenda", description: "Events (items with an event start, not ticked done) that are late or due on a day.",
    inputSchema: obj({ day: { type: "string", description: "YYYY-MM-DD, the date to treat as today." } }, ["day"]),
    run: (env, user, a) => DAY.test(String(a.day)) ? agenda(env, user, a.day) : fail("day must be YYYY-MM-DD") },
  { name: "drift_create_item", description: "Add an item to a collection you own or can edit. Plugin data goes in meta, e.g. {checklist: {done: false, priority: 2}} for a task or {event: {start: \"2026-03-01T09:00\"}} for an event.",
    inputSchema: obj(ITEM_FIELDS, ["title", "collection"]), run: (env, user, a) => createItem(env, user, a) },
  { name: "drift_update_item", description: "Change only the fields you send. meta replaces each named plugin's data as a whole. Moving to another collection works within one owner. Send deleted: false to restore a deleted item.",
    inputSchema: obj({ id: idProp("Item", "i"), ...ITEM_FIELDS, deleted: { type: "boolean" } }, ["id"]),
    run: async (env, user, a) => found(await updateItem(env, user, needId(a, "i"), rest(a))) },
  { name: "drift_delete_item", description: "Delete an item (it can be restored with drift_update_item deleted: false).",
    inputSchema: obj({ id: idProp("Item", "i") }, ["id"]),
    run: async (env, user, a) => found(await updateItem(env, user, needId(a, "i"), { deleted: true })) },
  { name: "drift_create_collection", description: "Make a collection. Starts with checklist, event and list switched on unless you pass plugins.",
    inputSchema: obj(COLLECTION_FIELDS, ["name"]), run: (env, user, a) => createCollection(env, user.id, a) },
  { name: "drift_update_collection", description: "Change a collection you own: rename, switch plugins on or off, set its view or order, or deleted: true/false. You can't delete your last collection.",
    inputSchema: obj({ id: idProp("Collection", "c"), ...COLLECTION_FIELDS, deleted: { type: "boolean" } }, ["id"]),
    run: async (env, user, a) => found(await updateCollection(env, user.id, needId(a, "c"), rest(a))) },
  { name: "drift_delete_collection", description: "Delete a collection you own (restorable with drift_update_collection deleted: false). Refuses your last collection.",
    inputSchema: obj({ id: idProp("Collection", "c") }, ["id"]),
    run: async (env, user, a) => found(await updateCollection(env, user.id, needId(a, "c"), { deleted: true })) },
  { name: "drift_share_collection", description: "Share a collection you own with another Drift user, or change their role. Role edit lets them add and change items; view is read-only.",
    inputSchema: obj({ id: idProp("Collection", "c"), username: { type: "string" }, role: { type: "string", enum: ["edit", "view"] } }, ["id", "username"]),
    run: async (env, user, a) => found(await shareCollection(env, user, needId(a, "c"), { username: a.username, role: a.role })) },
  { name: "drift_unshare_collection", description: "Stop sharing a collection with someone (or, with your own username, leave a collection shared with you).",
    inputSchema: obj({ id: idProp("Collection", "c"), username: { type: "string" } }, ["id", "username"]),
    run: async (env, user, a) => {
      const who = String(a.username ?? "").toLowerCase();
      if (!USERNAME.test(who)) fail("username isn't valid");
      return found(await unshareCollection(env, user, needId(a, "c"), who));
    } },
  { name: "drift_set_bases", description: "Set where a collection's days start and end, for route planning. Replaces all its bases. " +
      "Each base is {place: \"an address or a place's name\"} (the site finds it) or {lat, lng}, plus from and to (YYYY-MM-DD) for the days it covers: " +
      "from = to for one day, or leave both out for the home base, used on any day nothing else covers. A day's base is the one that covers it most closely. " +
      "Anyone who can edit the collection can set them.",
    inputSchema: obj({ id: idProp("Collection", "c"), bases: { type: "array", items: { type: "object" }, description: "[{place, lat, lng, from, to}]" } }, ["id", "bases"]),
    run: async (env, user, a) => found(await setBases(env, user, needId(a, "c"), a.bases)) },
  { name: "drift_plan_route", description: "Plan a day's route for a collection with Locations: its events with a place, from the day's base and back. " +
      "Timed events stay in time order, linked items (Graph) are visited one after the other, and the rest is shortest travel first. " +
      "Returns the few best orders (options, each with order of item ids, duration in seconds, distance in metres, and late: timed stops you'd likely reach late), " +
      "and for the chosen option the legs and the path along the streets. estimated: true means straight-line estimates (no routing key on the site).",
    inputSchema: obj({
      collection: idProp("Collection", "c"),
      day: { type: "string", description: "YYYY-MM-DD" },
      profile: { type: "string", enum: Object.keys(PROFILES), description: "How you get around. Default driving-car." },
      option: { type: "integer", minimum: 0, description: "Which of the options to give legs and the path for. Default 0, the best." },
    }, ["collection", "day"]),
    run: async (env, user, a) => {
      if (!DAY.test(String(a.day))) fail("day must be YYYY-MM-DD");
      const out = found(await planDay(env, user, needId({ id: a.collection }, "c"), a.day, a.profile, a.option));
      return { ...out, path: undefined };
    } },
  { name: "drift_install_plugin", description: "Add an approved plugin from the plugin store to your Drift. Its id is in drift_get_state's store list.",
    inputSchema: obj({ id: { type: "string", description: "Store plugin id." } }, ["id"]),
    run: async (env, user, a) => found(PLUGIN_ID.test(String(a.id)) ? await install(env, user.id, String(a.id)) : null) },
  { name: "drift_uninstall_plugin", description: "Remove a store plugin from your Drift. Collections using it keep their data.",
    inputSchema: obj({ id: { type: "string", description: "Store plugin id." } }, ["id"]),
    run: async (env, user, a) => PLUGIN_ID.test(String(a.id)) ? uninstall(env, user.id, String(a.id)) : fail("not found") },
];
const BY_NAME = Object.fromEntries(TOOLS.map(t => [t.name, t]));
export const TOOL_NAMES = TOOLS.map(t => t.name);

// ── JSON-RPC ───────────────────────────────────────────────────────────────
async function callTool(env, user, params) {
  const tool = BY_NAME[params?.name];
  if (!tool) return { error: [-32602, `unknown tool: ${params?.name}`] };
  const args = params.arguments ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) return { error: [-32602, "arguments must be an object"] };
  try {
    const out = await tool.run(env, user, args);
    return { result: { content: [{ type: "text", text: JSON.stringify(out) }] } };
  } catch (e) {
    if (e instanceof ToolError || e instanceof BadRequest) return { result: { isError: true, content: [{ type: "text", text: e.message }] } };
    throw e;
  }
}

async function dispatch(env, user, msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id, -32600, "invalid request");
  }
  const notification = !("id" in msg);
  const ok = result => notification ? null : { jsonrpc: "2.0", id: msg.id, result };
  const bad = (code, text) => notification ? null : rpcError(msg.id, code, text);
  try {
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        return ok({
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "drift", version: "1.0.0" },
          instructions: "Drift is a personal collection-and-items organiser. Call drift_get_state first to learn collection and item ids. Full guide: /llm.txt on this site.",
        });
      }
      case "ping": return ok({});
      case "tools/list": return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const out = await callTool(env, user, msg.params);
        return out.error ? bad(...out.error) : ok(out.result);
      }
      default: return msg.method.startsWith("notifications/") ? null : bad(-32601, `method not found: ${msg.method}`);
    }
  } catch (e) {
    console.error("mcp error:", e);
    return bad(-32603, "internal error");
  }
}

// ── the endpoint ───────────────────────────────────────────────────────────
async function authenticate(env, request) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(\S+)$/i);
  const key = m && await findKey(env, m[1]);
  if (!key) return { res: denied(401, "missing or invalid API key") };
  const user = await getUser(env, { id: key.user_id });
  if (!user) return { res: denied(401, "missing or invalid API key") };
  // The same conditions protect() applies to a signed-in person.
  if (user.disabled) return { res: denied(403, "this account is disabled") };
  if (user.must_change_pw || (user.areas.has("admin") && !user.totp_secret)) return { res: denied(403, "finish setting up your account first") };
  if (!user.areas.has(areaOf("drift"))) return { res: denied(403, "no access to Drift") };
  await touchKey(env, key);
  return { user };
}

export async function mcp(request, env) {
  if (request.method !== "POST") return denied(405, "method not allowed", { Allow: "POST" });
  if (request.headers.get("Origin")) return denied(403, "browser requests are refused");
  let auth;
  try { auth = await authenticate(env, request); }
  catch (e) { console.error("mcp auth failed:", e); return denied(500, "server error"); }
  if (auth.res) return auth.res;

  if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY) return denied(413, "request too large");
  const text = await request.text();
  if (text.length > MAX_BODY) return denied(413, "request too large");
  let body;
  try { body = JSON.parse(text); } catch { return reply(rpcError(null, -32700, "parse error"), 400); }

  if (Array.isArray(body)) {
    if (!body.length) return reply(rpcError(null, -32600, "empty batch"), 400);
    const out = (await Promise.all(body.map(m => dispatch(env, auth.user, m)))).filter(Boolean);
    return out.length ? reply(out) : new Response(null, { status: 202 });
  }
  const out = await dispatch(env, auth.user, body);
  return out ? reply(out) : new Response(null, { status: 202 });
}
