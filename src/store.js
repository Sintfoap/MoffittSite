// The plugin store: people write Drift plugins in the browser, submit them for
// review, and an admin approves each version before anyone else can see it.
//
// A plugin has an id (also its key in Drift's item.meta), an owner, and a
// numbered list of versions. Each version carries its own name, description
// and code, so what reviewers approve is exactly what the store shows.
//
//   draft     being edited by its author; at most one per plugin
//   pending   submitted, waiting in the review queue; at most one per plugin
//   approved  reviewed and live; the newest approved version is what the store serves
//   rejected  reviewed and turned down, with a note saying why
//
// Code is stored and sent only as text. Nothing here or on the store page
// runs it.

import { withRail } from "./pages.js";
import { db, now } from "./db.js";
import { sameOrigin } from "./account.js";
import { BY_ID } from "../public/todo/plugins/index.js";

export class BadRequest extends Error {}
const fail = msg => { throw new BadRequest(msg); };

const LIMITS = { name: 60, description: 300, note: 1000, code: 64 * 1024, body: 80 * 1024, plugins: 20 };
export const PLUGIN_ID = /^[a-z]{2,30}$/;
// Ids Drift's own plugins use, and a few it may want. Store plugins can't take them.
const RESERVED = new Set([...Object.keys(BY_ID), "events", "meta", "core", "drift", "store", "plugin", "plugins"]);

const isObj = v => v && typeof v === "object" && !Array.isArray(v);

export async function readJson(request) {
  const text = await request.text();
  if (text.length > LIMITS.body) fail("request too large");
  if (!text) return {};
  try { return JSON.parse(text); } catch { fail("invalid JSON"); }
}

function str(field, v, max, { required = false, trim = true } = {}) {
  if (v != null && typeof v !== "string") fail(`${field} must be text`);
  const s = trim ? String(v ?? "").trim() : String(v ?? "");
  if (required && !s.trim()) fail(`${field} is required`);
  if (s.length > max) fail(`${field} is longer than ${max} characters`);
  return s;
}

// The fields a version carries. `base` fills in whatever wasn't sent.
function cleanVersion(body, base = { name: "", description: "", code: "" }) {
  if (!isObj(body)) fail("body must be a JSON object");
  for (const k of Object.keys(body)) if (!["id", "name", "description", "code"].includes(k)) fail(`unknown field ${JSON.stringify(k)}`);
  return {
    name: "name" in body ? str("name", body.name, LIMITS.name, { required: true }) : base.name,
    description: "description" in body ? str("description", body.description, LIMITS.description) : base.description,
    code: "code" in body ? str("code", body.code, LIMITS.code, { trim: false }) : base.code,
  };
}

// ── reading ────────────────────────────────────────────────────────────────

const AUTHOR = "(SELECT display_name FROM users WHERE users.id = p.owner)";

async function versions(d, id) {
  const { results } = await d.prepare(
    "SELECT version, status, name, description, code, note, review_note, created_at, reviewed_at FROM store_versions WHERE plugin_id = ? ORDER BY version"
  ).bind(id).all();
  return results;
}
const latest = (vs, status) => vs.filter(v => v.status === status).at(-1) || null;
const summary = v => v && { version: v.version, status: v.status, name: v.name, description: v.description, created_at: v.created_at };

// What everyone can see: each plugin's newest approved version.
export async function storeList(env) {
  const d = await db(env);
  const { results } = await d.prepare(`
    SELECT p.id, ${AUTHOR} AS author, v.version, v.name, v.description, v.reviewed_at AS updated
    FROM store_plugins p JOIN store_versions v ON v.plugin_id = p.id
    WHERE v.version = (SELECT MAX(version) FROM store_versions WHERE plugin_id = p.id AND status = 'approved')
    ORDER BY v.name COLLATE NOCASE`).all();
  return results;
}

// One plugin's newest approved version, code included. Drift installs from this.
export async function storeGet(env, id) {
  if (!PLUGIN_ID.test(id)) return null;
  const d = await db(env);
  return d.prepare(`
    SELECT p.id, ${AUTHOR} AS author, v.version, v.name, v.description, v.code, v.reviewed_at AS updated
    FROM store_plugins p JOIN store_versions v ON v.plugin_id = p.id
    WHERE p.id = ? AND v.status = 'approved' ORDER BY v.version DESC LIMIT 1`).bind(id).first();
}

// ── Drift's side: which store plugins it may use, and installing them ─────

// Ids of every plugin with an approved version. Drift accepts these as well as its own.
export async function approvedIds(env) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT DISTINCT plugin_id FROM store_versions WHERE status = 'approved'").all();
  return new Set(results.map(r => r.plugin_id));
}

// The newest approved version of each of these plugins, code included.
export async function approvedPlugins(env, ids) {
  ids = [...new Set(ids)].filter(id => PLUGIN_ID.test(id));
  if (!ids.length) return [];
  const d = await db(env);
  const { results } = await d.prepare(`
    SELECT p.id, ${AUTHOR} AS author, v.version, v.name, v.description, v.code
    FROM store_plugins p JOIN store_versions v ON v.plugin_id = p.id
    WHERE p.id IN (${ids.map(() => "?").join(",")}) AND v.status = 'approved'
      AND v.version = (SELECT MAX(version) FROM store_versions WHERE plugin_id = p.id AND status = 'approved')
    ORDER BY v.name COLLATE NOCASE`).bind(...ids).all();
  return results;
}

const MAX_INSTALLS = 50;

export async function installed(env, owner) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT plugin_id FROM drift_installs WHERE owner = ? ORDER BY installed_at").bind(owner).all();
  return results.map(r => r.plugin_id);
}

export async function install(env, owner, id) {
  if (!PLUGIN_ID.test(id) || !(await storeGet(env, id))) return null;
  const d = await db(env);
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM drift_installs WHERE owner = ?").bind(owner).first();
  if (n >= MAX_INSTALLS) fail(`install limit reached (${MAX_INSTALLS})`);
  await d.prepare("INSERT OR IGNORE INTO drift_installs (owner, plugin_id, installed_at) VALUES (?, ?, ?)").bind(owner, id, now()).run();
  return { installed: await installed(env, owner) };
}

// Collections that use it keep its data; the plugin just stops being offered.
export async function uninstall(env, owner, id) {
  const d = await db(env);
  await d.prepare("DELETE FROM drift_installs WHERE owner = ? AND plugin_id = ?").bind(owner, id).run();
  return { installed: await installed(env, owner) };
}

// The signed-in user's own plugins, with the version they're working on.
export async function mine(env, owner) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT id, created_at FROM store_plugins WHERE owner = ? ORDER BY created_at").bind(owner).all();
  const out = [];
  for (const p of results) out.push(await ownView(d, p));
  return out;
}

async function ownView(d, p) {
  const vs = await versions(d, p.id);
  const work = latest(vs, "draft") || latest(vs, "pending") || vs.at(-1);
  return {
    id: p.id, created_at: p.created_at,
    // What the editor shows: the draft, else what's waiting for review, else the newest version.
    working: { version: work.version, status: work.status, name: work.name, description: work.description, code: work.code },
    published: summary(latest(vs, "approved")),
    pending: summary(latest(vs, "pending")),
    // The newest review, so a rejection's reason stays visible while the author fixes it.
    lastReview: (() => { const r = vs.filter(v => v.reviewed_at).at(-1); return r && { version: r.version, status: r.status, note: r.review_note, at: r.reviewed_at }; })(),
  };
}

async function owned(d, owner, id) {
  if (!PLUGIN_ID.test(id)) return null;
  return d.prepare("SELECT id, owner, created_at FROM store_plugins WHERE id = ? AND owner = ?").bind(id, owner).first();
}

// ── writing (authors) ──────────────────────────────────────────────────────

export async function createPlugin(env, owner, body) {
  const d = await db(env);
  if (!isObj(body)) fail("body must be a JSON object");
  const id = String(body.id ?? "").trim();
  if (!PLUGIN_ID.test(id)) fail("id must be 2 to 30 lowercase letters");
  if (RESERVED.has(id)) fail("that id is taken by one of Drift's own plugins");
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM store_plugins WHERE owner = ?").bind(owner).first();
  if (n >= LIMITS.plugins) fail(`plugin limit reached (${LIMITS.plugins})`);
  if (await d.prepare("SELECT 1 AS x FROM store_plugins WHERE id = ?").bind(id).first()) fail("that id is taken");
  const v = cleanVersion(body);
  if (!v.name) fail("name is required");
  const t = now();
  await d.batch([
    d.prepare("INSERT INTO store_plugins (id, owner, created_at) VALUES (?, ?, ?)").bind(id, owner, t),
    d.prepare("INSERT INTO store_versions (plugin_id, version, status, name, description, code, created_at) VALUES (?, 1, 'draft', ?, ?, ?, ?)")
      .bind(id, v.name, v.description, v.code, t),
  ]);
  return ownView(d, { id, created_at: t });
}

// Saves into the draft, starting a new one from the newest version if there isn't one.
// A version waiting for review stays as it was submitted.
export async function saveDraft(env, owner, id, body) {
  const d = await db(env);
  const p = await owned(d, owner, id);
  if (!p) return null;
  const vs = await versions(d, id);
  const draft = latest(vs, "draft");
  const v = cleanVersion(body, draft || vs.at(-1));
  if (draft) {
    await d.prepare("UPDATE store_versions SET name = ?, description = ?, code = ? WHERE plugin_id = ? AND version = ?")
      .bind(v.name, v.description, v.code, id, draft.version).run();
  } else {
    await d.prepare("INSERT INTO store_versions (plugin_id, version, status, name, description, code, created_at) VALUES (?, ?, 'draft', ?, ?, ?, ?)")
      .bind(id, vs.at(-1).version + 1, v.name, v.description, v.code, now()).run();
  }
  return ownView(d, p);
}

// Sends the draft to the review queue. Anything already waiting is replaced by it.
export async function submit(env, owner, id, body) {
  const d = await db(env);
  const p = await owned(d, owner, id);
  if (!p) return null;
  const note = str("note", isObj(body) ? body.note : "", LIMITS.note);
  const draft = latest(await versions(d, id), "draft");
  if (!draft) fail("there's no draft to submit");
  if (!draft.code.trim()) fail("the plugin has no code yet");
  await d.batch([
    d.prepare("DELETE FROM store_versions WHERE plugin_id = ? AND status = 'pending'").bind(id),
    d.prepare("UPDATE store_versions SET status = 'pending', note = ?, created_at = ? WHERE plugin_id = ? AND version = ?")
      .bind(note, now(), id, draft.version),
  ]);
  return ownView(d, p);
}

// Takes a submitted version back out of the queue so it can be edited again.
export async function withdraw(env, owner, id) {
  const d = await db(env);
  const p = await owned(d, owner, id);
  if (!p) return null;
  const vs = await versions(d, id);
  const pending = latest(vs, "pending");
  if (!pending) fail("nothing is waiting for review");
  const stmts = [d.prepare("UPDATE store_versions SET status = 'draft' WHERE plugin_id = ? AND version = ?").bind(id, pending.version)];
  // Edits made after submitting win over the version that was waiting.
  if (latest(vs, "draft")) stmts[0] = d.prepare("DELETE FROM store_versions WHERE plugin_id = ? AND version = ?").bind(id, pending.version);
  await d.batch(stmts);
  return ownView(d, p);
}

// Removes a plugin and every version of it, including from the store.
export async function removePlugin(env, owner, id) {
  const d = await db(env);
  const p = await owned(d, owner, id);
  if (!p) return false;
  await d.batch([
    d.prepare("DELETE FROM store_versions WHERE plugin_id = ?").bind(id),
    d.prepare("DELETE FROM store_plugins WHERE id = ?").bind(id),
  ]);
  return true;
}

// ── review (admins) ────────────────────────────────────────────────────────

// Everything waiting, oldest first, with the approved code it would replace
// so the reviewer can compare.
export async function queue(env) {
  const d = await db(env);
  const { results } = await d.prepare(`
    SELECT p.id, ${AUTHOR} AS author, v.version, v.name, v.description, v.code, v.note, v.created_at AS submitted_at,
      (SELECT code FROM store_versions a WHERE a.plugin_id = p.id AND a.status = 'approved' ORDER BY a.version DESC LIMIT 1) AS live_code
    FROM store_versions v JOIN store_plugins p ON p.id = v.plugin_id
    WHERE v.status = 'pending' ORDER BY v.created_at`).all();
  return results;
}

export async function review(env, reviewer, id, version, body) {
  const d = await db(env);
  if (!isObj(body)) fail("body must be a JSON object");
  const decision = body.decision;
  if (decision !== "approve" && decision !== "reject") fail("decision must be approve or reject");
  const note = str("note", body.note, LIMITS.note);
  if (decision === "reject" && !note) fail("say why it's rejected, so the author can fix it");
  if (!PLUGIN_ID.test(id) || !/^\d{1,9}$/.test(version)) return null;
  const res = await d.prepare(`UPDATE store_versions SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?
    WHERE plugin_id = ? AND version = ? AND status = 'pending'`)
    .bind(decision === "approve" ? "approved" : "rejected", note, reviewer.id, now(), id, Number(version)).run();
  if (!res.meta.changes) return null;
  return { id, version: Number(version), status: decision === "approve" ? "approved" : "rejected" };
}

// ── routes: everything under /plugins/ for a signed-in Drift user ──────────
//
//   GET    /plugins/api/state                    the store, your plugins, and whether you review
//   GET    /plugins/api/store/<id>               an approved plugin with its code (Drift installs from this)
//   POST   /plugins/api/mine                     {id, name, description, code} → new plugin with a draft
//   PATCH  /plugins/api/mine/<id>                any of {name, description, code} → saved to the draft
//   DELETE /plugins/api/mine/<id>                removes the plugin from the store and deletes it
//   POST   /plugins/api/mine/<id>/submit         {note} → the draft goes to review
//   POST   /plugins/api/mine/<id>/withdraw       takes it back out of review
//   GET    /plugins/api/review                   admins: what's waiting
//   POST   /plugins/api/review/<id>/<version>    admins: {decision: "approve" | "reject", note}

const ROUTE = /^\/plugins\/api\/(state|store|mine|review)(?:\/([^/]+))?(?:\/([^/]+))?\/?$/;

// The frame Drift and the store page run plugins in (public/sandbox/). It's
// loaded with sandbox="allow-scripts", so it has no origin and no cookies; this
// policy also takes away the network, so plugin code can't send data anywhere.
export const SANDBOX_CSP = [
  "default-src 'none'", "script-src 'self' blob:", "worker-src blob:", "connect-src 'none'",
  "frame-ancestors 'self'", "base-uri 'none'", "form-action 'none'",
].join("; ");

// The page shows other people's code, so it gets a strict policy: no inline
// scripts, nothing loaded from elsewhere except fonts.
const PAGE_CSP = [
  "default-src 'none'", "script-src 'self'", "connect-src 'self'", "frame-src 'self'", "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data:", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");

export async function plugins(request, env, user, pathname) {
  if (!pathname.startsWith("/plugins/api/")) {
    const asset = await withRail(await env.ASSETS.fetch(request), user, "plugins");
    const res = new Response(asset.body, asset);
    if ((res.headers.get("Content-Type") || "").startsWith("text/html")) {
      res.headers.set("Content-Security-Policy", PAGE_CSP);
      res.headers.set("X-Content-Type-Options", "nosniff");
    }
    return res;
  }
  const method = request.method;
  const isAdmin = user.areas.has("admin");
  try {
    if (method !== "GET" && !sameOrigin(request)) return json({ error: "cross-origin request refused" }, 403);
    const m = pathname.match(ROUTE);
    if (!m) return json({ error: "not found" }, 404);
    const [, kind, id, extra] = m;
    const notFound = () => json({ error: "not found" }, 404);
    const only = want => method === want ? null : json({ error: "method not allowed" }, 405);

    if (kind === "state") {
      if (id) return notFound();
      return only("GET") || json({
        user: { name: user.display_name || user.username, reviewer: isAdmin },
        store: await storeList(env), mine: await mine(env, user.id),
        waiting: isAdmin ? (await queue(env)).length : 0,
      });
    }
    if (kind === "store") {
      if (!id || extra) return notFound();
      const p = await storeGet(env, id);
      return only("GET") || (p ? json(p) : notFound());
    }
    if (kind === "mine") {
      if (!id) return only("POST") || json(await createPlugin(env, user.id, await readJson(request)), 201);
      let out;
      if (!extra && method === "PATCH") out = await saveDraft(env, user.id, id, await readJson(request));
      else if (!extra && method === "DELETE") out = (await removePlugin(env, user.id, id)) && { deleted: true };
      else if (extra === "submit" && method === "POST") out = await submit(env, user.id, id, await readJson(request));
      else if (extra === "withdraw" && method === "POST") out = await withdraw(env, user.id, id);
      else return extra && !["submit", "withdraw"].includes(extra) ? notFound() : json({ error: "method not allowed" }, 405);
      return out ? json(out) : notFound();
    }
    // review
    if (!isAdmin) return json({ error: "only admins review plugins" }, 403);
    if (!id) return only("GET") || json(await queue(env));
    if (!extra) return notFound();
    const out = only("POST") || await review(env, user, id, extra, await readJson(request));
    return out instanceof Response ? out : out ? json(out) : json({ error: "nothing waiting for review at that version" }, 404);
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    console.error("plugin store error:", e);
    return json({ error: "server error" }, 500);
  }
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
