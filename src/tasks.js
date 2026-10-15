// Task storage for the todo app, one list per signed-in user, in Cloudflare D1.
// Field names and rules mirror apps/todo-esque/drift/core.py so the web UI
// (and later a terminal client) can talk to it unchanged.
//
// `owner` is the signed-in user's id.

import { db } from "./db.js";

export const DEFAULTS = {
  title: "", notes: "", done: false, priority: 0, due: null,
  project: "", tags: [], order: 0, created: "", completed_at: null, deleted: false,
};

const LIMITS = { title: 500, notes: 20000, project: 100, tag: 50, tags: 50, tasksPerUser: 5000, body: 64 * 1024 };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

export class BadRequest extends Error {}

const nowStamp = () => new Date().toISOString().slice(0, 19);

function str(f, v, max) {
  const s = String(v ?? "").trim();
  if (s.length > max) throw new BadRequest(`${f} is longer than ${max} characters`);
  return s;
}

// Normalises one field the way core.py's _coerce does, plus size limits.
function coerce(f, v) {
  switch (f) {
    case "title": return str(f, v, LIMITS.title);
    case "notes": return str(f, v, LIMITS.notes);
    case "project": return str(f, v, LIMITS.project);
    case "priority": return Math.max(0, Math.min(3, Math.trunc(Number(v) || 0)));
    case "done": case "deleted": return Boolean(v);
    case "order": { const n = Number(v); if (!Number.isFinite(n)) throw new BadRequest("order must be a number"); return n; }
    case "tags": {
      const list = Array.isArray(v) ? v : String(v ?? "").split(/[,\s]+/);
      const out = [...new Set(list.map(x => String(x).replace(/^#+/, "").trim().toLowerCase()).filter(Boolean))].sort();
      if (out.length > LIMITS.tags || out.some(t => t.length > LIMITS.tag)) throw new BadRequest("too many or too long tags");
      return out;
    }
    case "due":
      if (v == null || v === "") return null;
      if (!DATE.test(String(v))) throw new BadRequest("due must be YYYY-MM-DD");
      return String(v);
    case "created": case "completed_at":
      if (v == null || v === "") return f === "created" ? "" : null;
      if (!STAMP.test(String(v))) throw new BadRequest(`${f} must be YYYY-MM-DDTHH:MM:SS`);
      return String(v);
    default:
      throw new BadRequest(`unknown field ${JSON.stringify(f)}`);
  }
}

export function clean(changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new BadRequest("body must be a JSON object");
  const out = {};
  for (const [f, v] of Object.entries(changes)) out[f] = coerce(f, v);
  if ("done" in out && !("completed_at" in changes)) out.completed_at = out.done ? nowStamp() : null;
  return out;
}

export async function readJson(request) {
  const text = await request.text();
  if (text.length > LIMITS.body) throw new BadRequest("request too large");
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new BadRequest("invalid JSON"); }
}

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(5));
  return "t_" + [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

const toTask = row => ({ ...DEFAULTS, ...JSON.parse(row.data), id: row.id, updated: row.updated });

export async function list(env, owner, label = owner) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT id, data, updated FROM todo_tasks WHERE owner = ?").bind(owner).all();
  const tasks = results.map(toTask).filter(t => !t.deleted);
  return {
    tasks,
    projects: [...new Set(tasks.map(t => t.project).filter(Boolean))].sort(),
    tags: [...new Set(tasks.flatMap(t => t.tags))].sort(),
    stats: { user: label, open: tasks.filter(t => !t.done).length, done: tasks.filter(t => t.done).length },
  };
}

export async function get(env, owner, id) {
  const d = await db(env);
  const row = await d.prepare("SELECT id, data, updated FROM todo_tasks WHERE owner = ? AND id = ?").bind(owner, id).first();
  return row ? toTask(row) : null;
}

export async function create(env, owner, fields) {
  const d = await db(env);
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM todo_tasks WHERE owner = ?").bind(owner).first();
  if (n >= LIMITS.tasksPerUser) throw new BadRequest(`task limit reached (${LIMITS.tasksPerUser})`);
  const data = clean({ created: nowStamp(), order: Date.now() / 1000, ...fields });
  if (!data.title) throw new BadRequest("title is required");
  const id = newId(), updated = nowStamp();
  await d.prepare("INSERT INTO todo_tasks (owner, id, data, updated) VALUES (?, ?, ?, ?)")
    .bind(owner, id, JSON.stringify(data), updated).run();
  return { ...DEFAULTS, ...data, id, updated };
}

// Merges only the fields sent, atomically in SQL, so two devices editing
// different fields of the same task at once both keep their change.
export async function update(env, owner, id, changes) {
  const d = await db(env);
  const patch = clean(changes);
  const res = await d.prepare("UPDATE todo_tasks SET data = json_patch(data, ?), updated = ? WHERE owner = ? AND id = ?")
    .bind(JSON.stringify(patch), nowStamp(), owner, id).run();
  if (!res.meta.changes) return null;
  return get(env, owner, id);
}
