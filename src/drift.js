// Drift's storage: collections and items, one set per signed-in user, in D1.
//
// An item is base data (title, notes, tags, collection) plus item.meta, where
// each plugin keeps its own slice under its id. The plugins live in
// public/todo/plugins/ and are shared with the page; here they only validate.
//
// `owner` is the signed-in user's id.

import { db, now } from "./db.js";
import { PLUGINS, BY_ID } from "../public/todo/plugins/index.js";

export class BadRequest extends Error {}
const fail = msg => { throw new BadRequest(msg); };

const LIMITS = { title: 500, notes: 20000, name: 100, tag: 50, tags: 50, items: 5000, collections: 100, body: 64 * 1024 };
export const ID = /^[a-z]_[0-9a-z]{1,32}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const nowStamp = () => new Date().toISOString().slice(0, 19);
// The `updated` column keeps milliseconds; `rev` counts edits for the sync check.
const updatedNow = () => new Date().toISOString();

// What a brand-new collection has switched on.
const STARTER = ["checklist", "event", "list"];

function newId(prefix) {
  const b = crypto.getRandomValues(new Uint8Array(5));
  return prefix + "_" + [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

function str(f, v, max) {
  const s = String(v ?? "").trim();
  if (s.length > max) fail(`${f} is longer than ${max} characters`);
  return s;
}
const isObj = v => v && typeof v === "object" && !Array.isArray(v);

export async function readJson(request) {
  const text = await request.text();
  if (text.length > LIMITS.body) fail("request too large");
  if (!text) return {};
  try { return JSON.parse(text); } catch { fail("invalid JSON"); }
}

// ── cleaning ───────────────────────────────────────────────────────────────

function cleanTags(v) {
  const list = Array.isArray(v) ? v : String(v ?? "").split(/[,\s]+/);
  const out = [...new Set(list.map(x => String(x).replace(/^#+/, "").trim().toLowerCase()).filter(Boolean))].sort();
  if (out.length > LIMITS.tags || out.some(t => t.length > LIMITS.tag)) fail("too many or too long tags");
  return out;
}

// meta: { pluginId: value | null }. null means "take this item off that plugin".
function cleanMeta(v) {
  if (!isObj(v)) fail("meta must be an object");
  const out = {};
  for (const [id, m] of Object.entries(v)) {
    const p = BY_ID[id];
    if (!p) fail(`unknown plugin ${JSON.stringify(id)}`);
    out[id] = m === null ? null : p.clean(m, fail);
  }
  return out;
}

function cleanItem(changes) {
  if (!isObj(changes)) fail("body must be a JSON object");
  const out = {};
  for (const [f, v] of Object.entries(changes)) {
    switch (f) {
      case "title": out.title = str(f, v, LIMITS.title); break;
      case "notes": out.notes = str(f, v, LIMITS.notes); break;
      case "tags": out.tags = cleanTags(v); break;
      case "collection": if (!ID.test(String(v))) fail("collection must be a collection id"); out.collection = String(v); break;
      case "deleted": out.deleted = Boolean(v); break;
      case "meta": out.meta = cleanMeta(v); break;
      default: fail(`unknown field ${JSON.stringify(f)}`);
    }
  }
  return out;
}

function cleanCollection(changes) {
  if (!isObj(changes)) fail("body must be a JSON object");
  const out = {};
  for (const [f, v] of Object.entries(changes)) {
    switch (f) {
      case "name": out.name = str(f, v, LIMITS.name); if (!out.name) fail("name is required"); break;
      case "plugins": {
        if (!Array.isArray(v)) fail("plugins must be a list");
        const ids = [...new Set(v.map(String))];
        for (const id of ids) if (!BY_ID[id]) fail(`unknown plugin ${JSON.stringify(id)}`);
        out.plugins = ids;
        break;
      }
      case "view": out.view = v == null || v === "" ? "" : String(v); if (out.view && !BY_ID[out.view]) fail("view must be a plugin id"); break;
      case "order": { const n = Number(v); if (!Number.isFinite(n)) fail("order must be a number"); out.order = n; break; }
      case "deleted": out.deleted = Boolean(v); break;
      default: fail(`unknown field ${JSON.stringify(f)}`);
    }
  }
  return out;
}

// ── reading ────────────────────────────────────────────────────────────────

const ITEM = { collection: "", title: "", notes: "", tags: [], created: "", deleted: false, meta: {} };
const COLLECTION = { name: "", plugins: [], view: "", order: 0, created: "", deleted: false };
const toItem = row => ({ ...ITEM, ...JSON.parse(row.data), id: row.id, updated: row.updated });
const toCollection = row => ({ ...COLLECTION, ...JSON.parse(row.data), id: row.id, updated: row.updated });

async function rows(d, table, owner) {
  const { results } = await d.prepare(`SELECT id, data, updated FROM ${table} WHERE owner = ?`).bind(owner).all();
  return results;
}

// ── access ─────────────────────────────────────────────────────────────────
// A collection is yours ("owner"), or shared with you as "edit" or "view".
// Items always live under their collection's owner, whoever added them.

const canWrite = role => role === "owner" || role === "edit";

async function collectionAccess(d, user, id) {
  const own = await getRow(d, "drift_collections", user.id, id, toCollection);
  if (own) return own.deleted ? null : { owner: user.id, role: "owner", collection: own };
  const share = await d.prepare(`SELECT s.owner, s.role FROM drift_shares s JOIN users u ON u.id = s.owner
    WHERE s.collection = ? AND s.user_id = ? AND u.disabled = 0`).bind(id, user.id).first();
  if (!share) return null;
  const c = await getRow(d, "drift_collections", share.owner, id, toCollection);
  return c && !c.deleted ? { owner: share.owner, role: share.role, collection: c } : null;
}

async function itemAccess(d, user, id) {
  const own = await d.prepare("SELECT 1 FROM drift_items WHERE owner = ? AND id = ?").bind(user.id, id).first();
  if (own) return { owner: user.id, role: "owner" };
  return d.prepare(`SELECT i.owner, s.role FROM drift_items i
    JOIN drift_shares s ON s.owner = i.owner AND s.collection = json_extract(i.data, '$.collection')
    JOIN users u ON u.id = i.owner
    WHERE i.id = ? AND s.user_id = ? AND u.disabled = 0`).bind(id, user.id).first();
}

// Everything the page needs in one go. Also brings over tasks from the old
// todo list the first time, and makes sure there's at least one collection.
export async function state(env, user) {
  const d = await db(env);
  await migrateTasks(d, user.id);
  let own = (await rows(d, "drift_collections", user.id)).map(toCollection).filter(c => !c.deleted);
  if (!own.length) own = [await createCollection(env, user.id, { name: "Inbox", plugins: STARTER, view: "checklist" })];
  own.sort((a, b) => a.order - b.order || a.created.localeCompare(b.created));

  const { results: outShares } = await d.prepare(`SELECT s.collection, s.role, u.username, u.display_name FROM drift_shares s
    JOIN users u ON u.id = s.user_id WHERE s.owner = ? ORDER BY u.username`).bind(user.id).all();
  const { results: inShares } = await d.prepare(`SELECT s.owner, s.role, c.id, c.data, c.updated, u.username, u.display_name
    FROM drift_shares s JOIN drift_collections c ON c.owner = s.owner AND c.id = s.collection JOIN users u ON u.id = s.owner
    WHERE s.user_id = ? AND u.disabled = 0`).bind(user.id).all();
  const shared = inShares.map(r => ({ ...toCollection(r), owner: r.owner, role: r.role, owner_name: r.display_name || r.username }))
    .filter(c => !c.deleted).sort((a, b) => a.name.localeCompare(b.name));

  const collections = [
    ...own.map(c => ({ ...c, owner: user.id, role: "owner",
      shares: outShares.filter(s => s.collection === c.id).map(s => ({ username: s.username, name: s.display_name || s.username, role: s.role })) })),
    ...shared,
  ];
  const live = new Set(collections.map(c => c.id));
  const { results: sharedItems } = await d.prepare(`SELECT i.id, i.data, i.updated FROM drift_items i
    JOIN drift_shares s ON s.owner = i.owner AND s.collection = json_extract(i.data, '$.collection')
    JOIN users u ON u.id = i.owner WHERE s.user_id = ? AND u.disabled = 0`).bind(user.id).all();
  const items = [...await rows(d, "drift_items", user.id), ...sharedItems].map(toItem).filter(it => !it.deleted && live.has(it.collection));
  return {
    version: await version(env, user.id),
    user: { id: user.id, username: user.username, name: user.display_name || user.username },
    plugins: PLUGINS.map(({ id, name, description }) => ({ id, name, description })),
    collections, items,
  };
}

// A short fingerprint of everything a user can see. The page checks it every
// few seconds and reloads only when it changes, so edits from other devices
// (and from people you share with) show up quickly without sending the whole
// list each time.
export async function version(env, userId) {
  const d = await db(env);
  const sum = "COUNT(*) || ':' || IFNULL(SUM(rev), 0) || ':' || IFNULL(MAX(updated), '')";
  const row = await d.prepare(`SELECT
      (SELECT ${sum} FROM drift_items WHERE owner = ?1) || '/' ||
      (SELECT ${sum} FROM drift_collections WHERE owner = ?1) || '/' ||
      (SELECT COUNT(*) || ':' || IFNULL(SUM(rev), 0) FROM drift_shares WHERE owner = ?1 OR user_id = ?1) || '/' ||
      (SELECT ${sum.replace(/rev|updated/g, "i.$&")} FROM drift_items i JOIN drift_shares s ON s.owner = i.owner
         AND s.collection = json_extract(i.data, '$.collection') WHERE s.user_id = ?1) || '/' ||
      (SELECT ${sum.replace(/rev|updated/g, "c.$&")} FROM drift_collections c JOIN drift_shares s ON s.owner = c.owner
         AND s.collection = c.id WHERE s.user_id = ?1) AS v`).bind(userId).first();
  return row.v;
}

async function getRow(d, table, owner, id, to) {
  const row = await d.prepare(`SELECT id, data, updated FROM ${table} WHERE owner = ? AND id = ?`).bind(owner, id).first();
  return row ? to(row) : null;
}

// ── items ──────────────────────────────────────────────────────────────────

export async function createItem(env, user, fields) {
  const d = await db(env);
  const data = cleanItem(fields);
  if (!data.title) fail("title is required");
  const acc = data.collection && await collectionAccess(d, user, data.collection);
  if (!acc) fail("collection not found");
  if (!canWrite(acc.role)) fail("that collection is view-only for you");
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM drift_items WHERE owner = ?").bind(acc.owner).first();
  if (n >= LIMITS.items) fail(`item limit reached (${LIMITS.items})`);
  data.meta = Object.fromEntries(Object.entries(data.meta || {}).filter(([, v]) => v !== null));
  const item = { ...ITEM, ...data, created: nowStamp(), deleted: false };
  const id = newId("i"), updated = updatedNow();
  await d.prepare("INSERT INTO drift_items (owner, id, data, updated) VALUES (?, ?, ?, ?)")
    .bind(acc.owner, id, JSON.stringify(item), updated).run();
  return { ...item, id, updated };
}

// Merges only what was sent, in one SQL statement, so two devices changing
// different fields (or different plugins' metadata) of one item both keep
// their change. Each plugin's slice is replaced as a whole.
export async function updateItem(env, user, id, changes) {
  const d = await db(env);
  const { meta, ...core } = cleanItem(changes);
  const acc = await itemAccess(d, user, id);
  if (!acc) return null;
  if (!canWrite(acc.role)) fail("that collection is view-only for you");
  if (core.collection) {
    const to = await collectionAccess(d, user, core.collection);
    if (!to) fail("collection not found");
    if (!canWrite(to.role)) fail("that collection is view-only for you");
    if (to.owner !== acc.owner) fail("items can only move between collections with the same owner");
  }
  let expr = "json_patch(data, ?)";
  const args = [JSON.stringify({ ...core, meta: {} })];          // {meta:{}} makes sure meta exists
  for (const [pid, v] of Object.entries(meta || {})) {           // pid is a known plugin id, safe in a path
    if (v === null) expr = `json_remove(${expr}, '$.meta.${pid}')`;
    else { expr = `json_set(${expr}, '$.meta.${pid}', json(?))`; args.push(JSON.stringify(v)); }
  }
  const res = await d.prepare(`UPDATE drift_items SET data = ${expr}, updated = ?, rev = rev + 1 WHERE owner = ? AND id = ?`)
    .bind(...args, updatedNow(), acc.owner, id).run();
  if (!res.meta.changes) return null;
  return getRow(d, "drift_items", acc.owner, id, toItem);
}

// ── sharing ────────────────────────────────────────────────────────────────

const ROLES = ["edit", "view"];
const MAX_SHARES = 50;

// Shares one of your collections with another account, or changes their role.
export async function shareCollection(env, user, id, body) {
  const d = await db(env);
  if (!isObj(body)) fail("body must be a JSON object");
  const c = await getRow(d, "drift_collections", user.id, id, toCollection);
  if (!c || c.deleted) return null;
  const role = String(body.role ?? "edit");
  if (!ROLES.includes(role)) fail("role must be edit or view");
  const username = String(body.username ?? "").trim().toLowerCase();
  const who = username && await d.prepare(`SELECT u.id, u.username, u.display_name FROM users u
    JOIN user_areas a ON a.user_id = u.id AND a.area = 'todo' WHERE u.username = ? AND u.disabled = 0`).bind(username).first();
  if (!who) fail("there's no Drift account with that username");
  if (who.id === user.id) fail("that's you");
  const { n, mine } = await d.prepare("SELECT COUNT(*) AS n, SUM(user_id = ?) AS mine FROM drift_shares WHERE owner = ? AND collection = ?")
    .bind(who.id, user.id, id).first();
  if (!mine && n >= MAX_SHARES) fail(`a collection can be shared with at most ${MAX_SHARES} people`);
  await d.prepare(`INSERT INTO drift_shares (owner, collection, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (owner, collection, user_id) DO UPDATE SET role = excluded.role, rev = rev + 1`)
    .bind(user.id, id, who.id, role, now()).run();
  return { username: who.username, name: who.display_name || who.username, role };
}

// The owner can remove anyone; someone it's shared with can remove themselves.
export async function unshareCollection(env, user, id, username) {
  const d = await db(env);
  const who = await d.prepare("SELECT id FROM users WHERE username = ?").bind(String(username).toLowerCase()).first();
  if (!who) return null;
  const res = await d.prepare(`DELETE FROM drift_shares WHERE collection = ? AND user_id = ? AND (owner = ? OR user_id = ?)`)
    .bind(id, who.id, user.id, user.id).run();
  return res.meta.changes ? { removed: true } : null;
}

// ── collections ────────────────────────────────────────────────────────────

export async function createCollection(env, owner, fields) {
  const d = await db(env);
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM drift_collections WHERE owner = ?").bind(owner).first();
  if (n >= LIMITS.collections) fail(`collection limit reached (${LIMITS.collections})`);
  const data = cleanCollection({ plugins: STARTER, ...fields });
  if (!data.name) fail("name is required");
  const c = { ...COLLECTION, order: Date.now() / 1000, ...data, created: nowStamp(), deleted: false };
  const id = newId("c"), updated = updatedNow();
  await d.prepare("INSERT INTO drift_collections (owner, id, data, updated) VALUES (?, ?, ?, ?)")
    .bind(owner, id, JSON.stringify(c), updated).run();
  return { ...c, id, updated };
}

export async function updateCollection(env, owner, id, changes) {
  const d = await db(env);
  const patch = cleanCollection(changes);
  if (patch.deleted) {
    const { n } = await d.prepare("SELECT COUNT(*) AS n FROM drift_collections WHERE owner = ? AND id != ? AND json_extract(data, '$.deleted') IS NOT 1")
      .bind(owner, id).first();
    if (!n) fail("you need at least one collection");
  }
  const res = await d.prepare("UPDATE drift_collections SET data = json_patch(data, ?), updated = ?, rev = rev + 1 WHERE owner = ? AND id = ?")
    .bind(JSON.stringify(patch), updatedNow(), owner, id).run();
  if (!res.meta.changes) return null;
  return getRow(d, "drift_collections", owner, id, toCollection);
}

// ── the old todo list ──────────────────────────────────────────────────────
// Tasks from before collections and plugins (table todo_tasks) become items:
// each project becomes a collection (no project → "Inbox"), done and priority
// become checklist metadata, and a due date becomes an all-day event.
// The old rows are removed in the same transaction as the last insert, and
// inserts are idempotent, so an interrupted run just finishes next time.

async function migrateTasks(d, owner) {
  const old = await d.prepare("SELECT id, data FROM todo_tasks WHERE owner = ?").bind(owner).all();
  if (!old.results.length) return;
  const tasks = old.results.map(r => ({ id: r.id, ...JSON.parse(r.data) })).filter(t => !t.deleted);

  const existing = (await rows(d, "drift_collections", owner)).map(toCollection).filter(c => !c.deleted);
  const byName = new Map(existing.map(c => [c.name.toLowerCase(), c.id]));
  const stmts = [];
  const created = nowStamp();
  for (const name of [...new Set(tasks.map(t => String(t.project || "").trim() || "Inbox"))].sort()) {
    if (byName.has(name.toLowerCase())) continue;
    const id = newId("c");
    byName.set(name.toLowerCase(), id);
    const c = { ...COLLECTION, name: name.slice(0, LIMITS.name), plugins: ["checklist", "event", "list"], view: "checklist",
      order: name === "Inbox" ? 0 : stmts.length + 1, created };
    stmts.push(d.prepare("INSERT INTO drift_collections (owner, id, data, updated) VALUES (?, ?, ?, ?)").bind(owner, id, JSON.stringify(c), created));
  }
  for (const t of tasks) {
    const meta = {
      checklist: {
        done: Boolean(t.done), priority: Math.max(0, Math.min(3, Math.trunc(Number(t.priority) || 0))),
        done_at: t.done ? (STAMP.test(String(t.completed_at)) ? t.completed_at : created) : null,
      },
      list: { order: Number.isFinite(Number(t.order)) ? Number(t.order) : 0, parent: null },
    };
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(t.due))) meta.event = { start: t.due, end: null };
    const item = {
      ...ITEM, collection: byName.get((String(t.project || "").trim() || "Inbox").toLowerCase()),
      title: String(t.title || "Untitled").slice(0, LIMITS.title), notes: String(t.notes || "").slice(0, LIMITS.notes),
      tags: Array.isArray(t.tags) ? t.tags.map(String).slice(0, LIMITS.tags) : [],
      created: STAMP.test(String(t.created)) ? t.created : created, deleted: false, meta,
    };
    stmts.push(d.prepare("INSERT OR IGNORE INTO drift_items (owner, id, data, updated) VALUES (?, ?, ?, ?)")
      .bind(owner, t.id, JSON.stringify(item), created));
  }
  stmts.push(d.prepare("DELETE FROM todo_tasks WHERE owner = ?").bind(owner));
  // D1 runs each batch as one transaction; keep batches a sensible size.
  for (let i = 0; i < stmts.length; i += 200) await d.batch(stmts.slice(i, i + 200));
}
