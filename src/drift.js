// Drift's storage: collections and items, one set per signed-in user, in D1.
//
// An item is base data (title, notes, tags, collection) plus item.meta, where
// each plugin keeps its own slice under its id. The plugins live in
// public/todo/plugins/ and are shared with the page; here they only validate.
//
// `owner` is the signed-in user's id.

import { db } from "./db.js";
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

// Everything the page needs in one go. Also brings over tasks from the old
// todo list the first time, and makes sure there's at least one collection.
export async function state(env, user) {
  const d = await db(env);
  await migrateTasks(d, user.id);
  let collections = (await rows(d, "drift_collections", user.id)).map(toCollection).filter(c => !c.deleted);
  if (!collections.length) collections = [await createCollection(env, user.id, { name: "Inbox", plugins: STARTER, view: "checklist" })];
  const live = new Set(collections.map(c => c.id));
  const items = (await rows(d, "drift_items", user.id)).map(toItem).filter(it => !it.deleted && live.has(it.collection));
  collections.sort((a, b) => a.order - b.order || a.created.localeCompare(b.created));
  return {
    version: await version(env, user.id),
    user: { name: user.display_name || user.username },
    plugins: PLUGINS.map(({ id, name, description }) => ({ id, name, description })),
    collections, items,
  };
}

// A short fingerprint of everything a user has. The page checks it every few
// seconds and reloads only when it changes, so edits from other devices show
// up quickly without sending the whole list each time.
export async function version(env, owner) {
  const d = await db(env);
  const part = table => `SELECT COUNT(*) || ':' || IFNULL(SUM(rev), 0) || ':' || IFNULL(MAX(updated), '') FROM ${table} WHERE owner = ?1`;
  const row = await d.prepare(`SELECT (${part("drift_items")}) || '/' || (${part("drift_collections")}) AS v`).bind(owner).first();
  return row.v;
}

async function getRow(d, table, owner, id, to) {
  const row = await d.prepare(`SELECT id, data, updated FROM ${table} WHERE owner = ? AND id = ?`).bind(owner, id).first();
  return row ? to(row) : null;
}

async function ownsCollection(d, owner, id) {
  const c = await getRow(d, "drift_collections", owner, id, toCollection);
  return Boolean(c && !c.deleted);
}

// ── items ──────────────────────────────────────────────────────────────────

export async function createItem(env, owner, fields) {
  const d = await db(env);
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM drift_items WHERE owner = ?").bind(owner).first();
  if (n >= LIMITS.items) fail(`item limit reached (${LIMITS.items})`);
  const data = cleanItem(fields);
  if (!data.title) fail("title is required");
  if (!data.collection || !(await ownsCollection(d, owner, data.collection))) fail("collection not found");
  data.meta = Object.fromEntries(Object.entries(data.meta || {}).filter(([, v]) => v !== null));
  const item = { ...ITEM, ...data, created: nowStamp(), deleted: false };
  const id = newId("i"), updated = updatedNow();
  await d.prepare("INSERT INTO drift_items (owner, id, data, updated) VALUES (?, ?, ?, ?)")
    .bind(owner, id, JSON.stringify(item), updated).run();
  return { ...item, id, updated };
}

// Merges only what was sent, in one SQL statement, so two devices changing
// different fields (or different plugins' metadata) of one item both keep
// their change. Each plugin's slice is replaced as a whole.
export async function updateItem(env, owner, id, changes) {
  const d = await db(env);
  const { meta, ...core } = cleanItem(changes);
  if (core.collection && !(await ownsCollection(d, owner, core.collection))) fail("collection not found");
  let expr = "json_patch(data, ?)";
  const args = [JSON.stringify({ ...core, meta: {} })];          // {meta:{}} makes sure meta exists
  for (const [pid, v] of Object.entries(meta || {})) {           // pid is a known plugin id, safe in a path
    if (v === null) expr = `json_remove(${expr}, '$.meta.${pid}')`;
    else { expr = `json_set(${expr}, '$.meta.${pid}', json(?))`; args.push(JSON.stringify(v)); }
  }
  const res = await d.prepare(`UPDATE drift_items SET data = ${expr}, updated = ?, rev = rev + 1 WHERE owner = ? AND id = ?`)
    .bind(...args, updatedNow(), owner, id).run();
  if (!res.meta.changes) return null;
  return getRow(d, "drift_items", owner, id, toItem);
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
