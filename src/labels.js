// Recipe labels: the site's one list of labels, like "Season: Fall" or
// "Cuisine: Irish", that recipes in Recipe box tick and the Recipe board files
// posts under (each key is one of the board's categories). It's an app of its
// own in APPS, so an admin turns it on for whoever should keep the list.
//
// A label is a key and a value ("Season", "Fall"); a key can have many values,
// and a label with no value is just its key ("Favorite"). Recipes keep label
// ids (src/recipes.js), so renaming one renames it everywhere and removing one
// takes it off every recipe and board post.
//
// /labels/api/labels         GET → {labels: [{id, key, value, recipes, posts}], keys: [{key, values, recipes, posts}]}
//                            POST {key, values: ["Fall", "Winter"] or "Fall, Winter"} (or {key, value}) →
//                            {added: [{id, key, value}], skipped: [{key, value, why}]}: many at once, under a new key or one already there
// /labels/api/labels/<id>    PATCH {key?, value?} → renamed; DELETE → gone
// /labels/api/keys/<key>     PATCH {key} → every label under it renamed to the new key; DELETE → the key and all its values gone

import { db } from "./db.js";
import { sameOrigin } from "./account.js";
import { withRail } from "./pages.js";
import { readJson, BadRequest } from "./drift.js";
import { labelList } from "./recipes.js";

const fail = msg => { throw new BadRequest(msg); };
export const LIMITS = { list: 300, key: 30, value: 60, batch: 50 };
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const text = (f, v) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
const named = l => l.value ? `${l.key}: ${l.value}` : l.key;

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(5));
  return "l_" + [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

function cleanKey(v) {
  const key = text("key", v);
  if (!key) fail("give the label a name, like Season");
  if (key.length > LIMITS.key) fail(`a label's name can be at most ${LIMITS.key} characters`);
  if (key.includes(":")) fail("a label's name can't have a colon in it (that's what splits the name from the value)");
  return key;
}
function cleanValue(v) {
  const value = text("value", v);
  if (value.length > LIMITS.value) fail(`a label's value can be at most ${LIMITS.value} characters`);
  return value;
}

// "Fall, Winter" or ["Fall", "Winter"]: each value once, ignoring case, in the order given.
export function splitValues(v) {
  const parts = Array.isArray(v) ? v.map(x => String(x ?? "")) : String(v ?? "").split(",");
  const out = [], seen = new Set();
  for (const p of parts) {
    const value = cleanValue(p);
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push(value);
  }
  return out;
}

// How many recipes and board posts have each label: {id: {recipes, posts}}.
export async function labelUse(d) {
  const use = {};
  const add = (rows, f) => { for (const r of rows) (use[r.id] ||= { recipes: 0, posts: 0 })[f] = r.n; };
  add((await d.prepare("SELECT j.value AS id, COUNT(*) AS n FROM recipes r, json_each(r.data, '$.labels') j GROUP BY j.value").all()).results, "recipes");
  add((await d.prepare("SELECT j.value AS id, COUNT(*) AS n FROM board_posts p, json_each(p.data, '$.recipe.labels') j GROUP BY j.value").all()).results, "posts");
  return use;
}

export async function listLabels(env) {
  const d = await db(env);
  const use = await labelUse(d);
  const labels = (await labelList(d)).map(l => ({ ...l, recipes: use[l.id]?.recipes || 0, posts: use[l.id]?.posts || 0 }));
  const keys = [];
  for (const l of labels) {
    let k = keys.at(-1);
    if (!k || k.key.toLowerCase() !== l.key.toLowerCase()) keys.push(k = { key: l.key, values: 0, recipes: 0, posts: 0 });
    k.values++;
    k.recipes += l.recipes;
    k.posts += l.posts;
  }
  return { labels, keys, limits: LIMITS };
}

// New values, under a key that may already be on the list (its spelling there wins).
// Ones already there are skipped, not an error, so pasting a list twice is harmless.
export async function addLabels(env, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  let key = cleanKey(body.key);
  const values = "values" in body ? splitValues(body.values) : [cleanValue(body.value)];
  if (!values.length) values.push("");
  if (values.length > LIMITS.batch) fail(`add at most ${LIMITS.batch} at once`);
  const d = await db(env);
  const have = (await d.prepare("SELECT key, value FROM recipe_labels WHERE key = ?").bind(key).all()).results;
  if (have.length) key = have[0].key;
  const there = new Set(have.map(l => l.value.toLowerCase()));
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM recipe_labels").first();
  const added = [], skipped = [], t = new Date().toISOString();
  for (const value of values) {
    if (there.has(value.toLowerCase())) { skipped.push({ key, value, why: "already on the list" }); continue; }
    if (n + added.length >= LIMITS.list) { skipped.push({ key, value, why: `the list holds at most ${LIMITS.list}` }); continue; }
    added.push({ id: newId(), key, value });
  }
  if (added.length) await d.batch(added.map(l => d.prepare("INSERT INTO recipe_labels (id, key, value, created) VALUES (?, ?, ?, ?)").bind(l.id, l.key, l.value, t)));
  return { added, skipped };
}

async function clash(d, key, value, except) {
  const other = await d.prepare("SELECT id FROM recipe_labels WHERE key = ? AND value = ? AND id != ?").bind(key, value, except).first();
  if (other) fail(`${named({ key, value })} is already on the list`);
}

// Renaming one renames it on every recipe and post that has it.
export async function renameLabel(env, id, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  const d = await db(env);
  const l = await d.prepare("SELECT id, key, value FROM recipe_labels WHERE id = ?").bind(id).first();
  if (!l) return null;
  const key = "key" in body ? cleanKey(body.key) : l.key, value = "value" in body ? cleanValue(body.value) : l.value;
  await clash(d, key, value, id);
  await d.prepare("UPDATE recipe_labels SET key = ?, value = ? WHERE id = ?").bind(key, value, id).run();
  return { id, key, value };
}

export async function deleteLabel(env, id) {
  const d = await db(env);
  const r = await d.prepare("DELETE FROM recipe_labels WHERE id = ?").bind(id).run();
  return r.meta.changes ? { removed: true } : null;
}

// A key, renamed on all its values (or merged into another key that has none of the same values).
export async function renameKey(env, from, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  const key = cleanKey(body.key), d = await db(env);
  const mine = (await d.prepare("SELECT id, value FROM recipe_labels WHERE key = ?").bind(from).all()).results;
  if (!mine.length) return null;
  if (key.toLowerCase() !== from.toLowerCase()) {
    const theirs = new Set((await d.prepare("SELECT value FROM recipe_labels WHERE key = ?").bind(key).all()).results.map(l => l.value.toLowerCase()));
    const both = mine.find(l => theirs.has(l.value.toLowerCase()));
    if (both) fail(`${named({ key, value: both.value })} is already on the list`);
  }
  const other = key.toLowerCase() !== from.toLowerCase();
  await d.batch([
    d.prepare("UPDATE recipe_labels SET key = ? WHERE key = ?").bind(key, from),
    // Its followers on the board follow it under the new name (once, when two keys become one).
    d.prepare("UPDATE OR IGNORE board_follows SET category = ? WHERE category = ? COLLATE NOCASE").bind(key, from),
    ...(other ? [d.prepare("DELETE FROM board_follows WHERE category = ? COLLATE NOCASE").bind(from)] : []),
  ]);
  return { key, values: mine.length };
}

// A whole key: all its values, off every recipe, and off the board as a category.
export async function deleteKey(env, key) {
  const d = await db(env);
  const r = await d.prepare("DELETE FROM recipe_labels WHERE key = ?").bind(key).run();
  if (!r.meta.changes) return null;
  await d.prepare("DELETE FROM board_follows WHERE category = ? COLLATE NOCASE").bind(key).run();
  return { removed: r.meta.changes };
}

// ── the page and its API ───────────────────────────────────────────────────

const PAGE_CSP = [
  "default-src 'none'", "script-src 'self'", "connect-src 'self'", "manifest-src 'self'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com", "img-src 'self' data:",
  "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const ROUTE = /^\/labels\/api\/(?:labels(?:\/(l_[0-9a-f]{10}))?|keys\/([^/]+))\/?$/;

export async function labels(request, env, user, pathname) {
  if (!pathname.startsWith("/labels/api/")) {
    const asset = await withRail(await env.ASSETS.fetch(request), user, "labels");
    const res = new Response(asset.body, asset);
    if ((res.headers.get("Content-Type") || "").startsWith("text/html")) {
      res.headers.set("Content-Security-Policy", PAGE_CSP);
      res.headers.set("X-Content-Type-Options", "nosniff");
      res.headers.set("Referrer-Policy", "no-referrer");
    }
    return res;
  }
  const method = request.method;
  try {
    const m = pathname.match(ROUTE);
    if (!m) return json({ error: "not found" }, 404);
    if (method !== "GET" && !sameOrigin(request)) return json({ error: "cross-origin request refused" }, 403);
    const notAllowed = () => json({ error: "method not allowed" }, 405);
    const [, id, rawKey] = m;
    let out;
    if (rawKey !== undefined) {
      let key;
      try { key = decodeURIComponent(rawKey); } catch { return json({ error: "not found" }, 404); }
      if (method === "PATCH") out = await renameKey(env, key, await readJson(request));
      else if (method === "DELETE") out = await deleteKey(env, key);
      else return notAllowed();
    } else if (!id) {
      if (method === "GET") return json(await listLabels(env));
      if (method === "POST") return json(await addLabels(env, await readJson(request)), 201);
      return notAllowed();
    } else if (method === "PATCH") out = await renameLabel(env, id, await readJson(request));
    else if (method === "DELETE") out = await deleteLabel(env, id);
    else return notAllowed();
    return out ? json(out) : json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    console.error("recipe labels error:", e);
    return json({ error: "server error" }, 500);
  }
}
