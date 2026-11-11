// Food club: like the book club, but everyone cooks. Each month one member
// picks a food (a meal, a dessert, anything) and gives the recipe, everyone
// makes it, and the club keeps what happened: who made it, who loved it
// (favorites), and photos of everyone's attempts, month after month.
//
// The club is everyone with Food club turned on. Whoever picks a month can
// change or delete that pick (so can admins); anyone can mark it made or a
// favorite and add photos of their own attempt. A pick's recipe can come from
// a link (read the same way Recipe box reads one), from your Recipe box, or be
// typed in, and anyone with Recipe box can save it to theirs.
//
// /food/api/club                          GET → {picks, you, recipe_box, recipes}
// /food/api/picks                         POST {month, title, kind, blurb, recipe? | url? | recipe_id?} → the new pick
// /food/api/picks/<id>                    GET → the whole pick; PATCH → change the fields sent; DELETE → remove it
// /food/api/picks/<id>/mine               PUT {made?, favorite?} → the pick
// /food/api/picks/<id>/photos             POST {type, data (base64), caption} → the pick, with your photo
// /food/api/picks/<id>/photos/<photo>     DELETE → the pick, without it
// /food/api/picks/<id>/save               POST → {recipe}: the pick's recipe, saved to your Recipe box
// /food/api/photos/<photo>                GET → the picture
//
// Photos are kept in D1 (base64, at most PHOTO_BYTES each); the page shrinks
// them before sending, so a phone's 6 MB picture arrives as a few hundred KB.

import { db } from "./db.js";
import { sameOrigin } from "./account.js";
import { withRail } from "./pages.js";
import { BadRequest } from "./drift.js";
import { clean as cleanRecipe, get as getRecipe, create as createRecipe, importFrom, NotARecipe } from "./recipes.js";

const fail = msg => { throw new BadRequest(msg); };

export const KINDS = ["meal", "side", "dessert", "baking", "snack", "drink"];
export const PHOTO_BYTES = 1200 * 1024;
const LIMITS = { title: 200, blurb: 3000, caption: 300, photosEach: 12, body: 1800 * 1024 };
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const ROUTE = /^\/food\/api\/picks(?:\/(f_[0-9a-f]{10})(?:\/(mine|photos|save)(?:\/(p_[0-9a-f]{10}))?)?)?\/?$/;
const PHOTO = /^\/food\/api\/photos\/(p_[0-9a-f]{10})$/;
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const PICK = { title: "", kind: "meal", blurb: "", recipe: null, created: "" };
const RECIPE_FIELDS = ["source", "image", "yield", "servings", "time", "ingredients", "steps", "notes"];
const BLANK_RECIPE = { source: "", image: "", yield: "", servings: null, time: "", ingredients: [], steps: [], notes: "" };

function newId(prefix) {
  const b = crypto.getRandomValues(new Uint8Array(5));
  return prefix + "_" + [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

function str(f, v, max) {
  const s = String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (s.length > max) fail(`${f} is longer than ${max} characters`);
  return s;
}

// A month as YYYY-MM, from 2000 to two years from now.
function month(v) {
  const s = String(v ?? "").trim(), m = s.match(MONTH);
  if (!m) fail("month must be like 2026-11");
  const limit = new Date();
  limit.setUTCFullYear(limit.getUTCFullYear() + 2);
  if (+m[1] < 2000 || s > limit.toISOString().slice(0, 7)) fail("pick a month from 2000 up to two years ahead");
  return s;
}

// Only the fields a pick's recipe keeps (its title is the pick's), cleaned as Recipe box cleans them.
function recipeFields(v) {
  if (v === null) return null;
  if (!isObj(v)) fail("recipe must be an object");
  const kept = Object.fromEntries(Object.entries(v).filter(([k]) => RECIPE_FIELDS.includes(k)));
  const out = { ...BLANK_RECIPE, ...cleanRecipe(kept) };
  return out.ingredients.length || out.steps.length || out.source || out.notes ? out : null;
}

function cleanPick(changes) {
  if (!isObj(changes)) fail("body must be a JSON object");
  const out = {};
  for (const [f, v] of Object.entries(changes)) {
    switch (f) {
      case "month": out.month = month(v); break;
      case "title": out.title = str(f, v, LIMITS.title); break;
      case "kind": out.kind = String(v ?? ""); if (!KINDS.includes(out.kind)) fail(`kind is one of ${KINDS.join(", ")}`); break;
      case "blurb": out.blurb = str(f, v, LIMITS.blurb); break;
      case "recipe": out.recipe = recipeFields(v); break;
      case "url": case "recipe_id": out[f] = String(v ?? "").trim(); break;
      default: fail(`unknown field ${JSON.stringify(f)}`);
    }
  }
  return out;
}

// {url} or {recipe_id} on a new pick or an edit: the recipe they stand for.
async function recipeFrom(d, user, { url, recipe_id }) {
  if (url) {
    const r = await importFrom(url);
    return { title: r.title, recipe: recipeFields(Object.fromEntries(RECIPE_FIELDS.filter(k => k in r).map(k => [k, r[k]]))) };
  }
  if (recipe_id) {
    if (!user.areas.has("recipes")) fail("you need Recipe box to pick from it");
    const r = await getRecipe(d, user.id, recipe_id);
    if (!r) fail("that recipe isn't in your Recipe box");
    return { title: r.title, recipe: recipeFields(Object.fromEntries(RECIPE_FIELDS.map(k => [k, r[k]]))) };
  }
  return null;
}

// ── reading ────────────────────────────────────────────────────────────────

const isAdmin = user => user.areas.has("admin");
const nameOf = r => r.display_name || r.username || "A former member";

async function row(d, id) {
  return d.prepare(`SELECT p.*, u.username, u.display_name FROM food_picks p LEFT JOIN users u ON u.id = p.chooser WHERE p.id = ?`).bind(id).first();
}

// Every pick, newest month first, with how it went.
export async function listPicks(env, user) {
  const d = await db(env);
  const { results } = await d.prepare(`SELECT p.id, p.month, p.chooser, p.data, u.username, u.display_name,
      (SELECT COUNT(*) FROM food_marks m WHERE m.pick = p.id AND m.made = 1) AS made,
      (SELECT COUNT(*) FROM food_marks m WHERE m.pick = p.id AND m.favorite = 1) AS favorites,
      (SELECT COUNT(*) FROM food_photos f WHERE f.pick = p.id) AS photos,
      (SELECT id FROM food_photos f WHERE f.pick = p.id ORDER BY created DESC LIMIT 1) AS cover,
      (SELECT made FROM food_marks m WHERE m.pick = p.id AND m.user_id = ?) AS my_made,
      (SELECT favorite FROM food_marks m WHERE m.pick = p.id AND m.user_id = ?) AS my_favorite
    FROM food_picks p LEFT JOIN users u ON u.id = p.chooser ORDER BY p.month DESC`).bind(user.id, user.id).all();
  return results.map(r => {
    const data = { ...PICK, ...JSON.parse(r.data) };
    return { id: r.id, month: r.month, title: data.title, kind: data.kind, by: nameOf(r), yours: r.chooser === user.id,
      made: r.made, favorites: r.favorites, photos: r.photos, cover: r.cover || null,
      mine: { made: !!r.my_made, favorite: !!r.my_favorite } };
  });
}

export async function getPick(env, user, id) {
  const d = await db(env);
  const r = await row(d, id);
  if (!r) return null;
  const data = { ...PICK, ...JSON.parse(r.data) };
  const { results: marks } = await d.prepare(`SELECT m.user_id, m.made, m.favorite, u.username, u.display_name FROM food_marks m
    JOIN users u ON u.id = m.user_id WHERE m.pick = ? AND (m.made = 1 OR m.favorite = 1) ORDER BY m.updated`).bind(id).all();
  const { results: photos } = await d.prepare(`SELECT f.id, f.user_id, f.caption, f.created, u.username, u.display_name FROM food_photos f
    LEFT JOIN users u ON u.id = f.user_id WHERE f.pick = ? ORDER BY f.created`).bind(id).all();
  const me = marks.find(m => m.user_id === user.id);
  // Your Recipe box's copy, matched by name, so the page can link to it (and to Meal plan) instead of offering to save it again.
  let inBox = null;
  if (user.areas.has("recipes")) {
    const t = String(data.title || "").trim().toLowerCase();
    const { results: mine } = await d.prepare("SELECT id, data FROM recipes WHERE owner = ?").bind(user.id).all();
    inBox = mine.find(x => String(JSON.parse(x.data).title || "").trim().toLowerCase() === t)?.id || null;
  }
  return {
    in_box: inBox,
    id, month: r.month, ...data, recipe: data.recipe ? { ...BLANK_RECIPE, ...data.recipe } : null,
    by: nameOf(r), yours: r.chooser === user.id, can_edit: r.chooser === user.id || isAdmin(user), updated: r.updated,
    made_by: marks.filter(m => m.made).map(nameOf), favorite_of: marks.filter(m => m.favorite).map(nameOf),
    mine: { made: !!me?.made, favorite: !!me?.favorite },
    photos: photos.map(p => ({ id: p.id, by: nameOf(p), caption: p.caption, created: p.created, yours: p.user_id === user.id,
      can_remove: p.user_id === user.id || isAdmin(user) })),
  };
}

// ── changing ───────────────────────────────────────────────────────────────

async function monthTaken(d, m, except = "") {
  const other = await d.prepare("SELECT p.id, u.username, u.display_name FROM food_picks p LEFT JOIN users u ON u.id = p.chooser WHERE p.month = ? AND p.id != ?").bind(m, except).first();
  if (other) fail(`${nameOf(other)} already picked for ${m}`);
}

export async function createPick(env, user, fields) {
  const d = await db(env);
  const { url, recipe_id, ...data } = cleanPick(fields);
  if (!data.month) fail("say which month it's for");
  await monthTaken(d, data.month);
  const from = await recipeFrom(d, user, { url, recipe_id });
  if (from) { data.title ||= from.title; data.recipe = from.recipe; }
  if (!data.title) fail("say what the food is");
  const { month: m, ...rest } = data;
  const id = newId("f"), t = new Date().toISOString();
  await d.prepare("INSERT INTO food_picks (id, month, chooser, data, updated) VALUES (?, ?, ?, ?, ?)")
    .bind(id, m, user.id, JSON.stringify({ ...PICK, ...rest, created: t.slice(0, 19) }), t).run();
  return getPick(env, user, id);
}

export async function updatePick(env, user, id, changes) {
  const d = await db(env);
  const r = await row(d, id);
  if (!r) return null;
  if (r.chooser !== user.id && !isAdmin(user)) fail("only whoever picked it can change it");
  const { url, recipe_id, month: m, ...patch } = cleanPick(changes);
  const from = await recipeFrom(d, user, { url, recipe_id });
  if (from) patch.recipe = from.recipe;
  if (patch.title === "") fail("say what the food is");
  if (m) await monthTaken(d, m, id);
  const data = { ...PICK, ...JSON.parse(r.data), ...patch };
  await d.prepare("UPDATE food_picks SET month = ?, data = ?, updated = ? WHERE id = ?")
    .bind(m || r.month, JSON.stringify(data), new Date().toISOString(), id).run();
  return getPick(env, user, id);
}

export async function deletePick(env, user, id) {
  const d = await db(env);
  const r = await row(d, id);
  if (!r) return null;
  if (r.chooser !== user.id && !isAdmin(user)) fail("only whoever picked it can delete it");
  await d.batch(["food_photos", "food_marks"].map(t => d.prepare(`DELETE FROM ${t} WHERE pick = ?`).bind(id))
    .concat(d.prepare("DELETE FROM food_picks WHERE id = ?").bind(id)));
  return { removed: true };
}

// Made it, and (a favorite is something you've made) loved it.
export async function mark(env, user, id, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  for (const k of Object.keys(body)) if (k !== "made" && k !== "favorite") fail(`unknown field ${JSON.stringify(k)}`);
  const d = await db(env);
  if (!await row(d, id)) return null;
  const before = await d.prepare("SELECT made, favorite FROM food_marks WHERE pick = ? AND user_id = ?").bind(id, user.id).first() || { made: 0, favorite: 0 };
  let made = "made" in body ? !!body.made : !!before.made;
  let favorite = "favorite" in body ? !!body.favorite : !!before.favorite;
  if (favorite && "favorite" in body) made = true;
  if (!made) favorite = false;
  await d.prepare(`INSERT INTO food_marks (pick, user_id, made, favorite, updated) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (pick, user_id) DO UPDATE SET made = excluded.made, favorite = excluded.favorite, updated = excluded.updated`)
    .bind(id, user.id, +made, +favorite, new Date().toISOString()).run();
  return getPick(env, user, id);
}

// What the bytes say the picture is, whatever the upload claims.
export function imageType(bytes) {
  const b = i => bytes[i];
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return "image/png";
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return "image/gif";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

function decode(data) {
  const s = String(data ?? "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!s || !/^[A-Za-z0-9+/]+=*$/.test(s)) fail("send the photo as base64");
  try { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); } catch { fail("send the photo as base64"); }
}

export async function addPhoto(env, user, id, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  const d = await db(env);
  if (!await row(d, id)) return null;
  const bytes = decode(body.data);
  if (bytes.length > PHOTO_BYTES) fail(`that photo is too big (at most ${Math.round(PHOTO_BYTES / 1024)} KB); make it smaller first`);
  const type = imageType(bytes);
  if (!type) fail("that isn't a JPEG, PNG, WebP or GIF picture");
  const caption = str("caption", body.caption, LIMITS.caption);
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM food_photos WHERE pick = ? AND user_id = ?").bind(id, user.id).first();
  if (n >= LIMITS.photosEach) fail(`you can add at most ${LIMITS.photosEach} photos to one month`);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const t = new Date().toISOString();
  await d.batch([
    d.prepare("INSERT INTO food_photos (id, pick, user_id, type, data, caption, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(newId("p"), id, user.id, type, btoa(bin), caption, t),
    // A photo of your attempt means you made it.
    d.prepare(`INSERT INTO food_marks (pick, user_id, made, favorite, updated) VALUES (?, ?, 1, 0, ?)
      ON CONFLICT (pick, user_id) DO UPDATE SET made = 1, updated = excluded.updated`).bind(id, user.id, t),
  ]);
  return getPick(env, user, id);
}

export async function removePhoto(env, user, id, photo) {
  const d = await db(env);
  const p = await d.prepare("SELECT user_id FROM food_photos WHERE id = ? AND pick = ?").bind(photo, id).first();
  if (!p) return null;
  if (p.user_id !== user.id && !isAdmin(user)) fail("only whoever added a photo can take it off");
  await d.prepare("DELETE FROM food_photos WHERE id = ?").bind(photo).run();
  return getPick(env, user, id);
}

async function photoFile(env, photo) {
  const d = await db(env);
  const p = await d.prepare("SELECT type, data FROM food_photos WHERE id = ?").bind(photo).first();
  if (!p) return new Response("not found", { status: 404 });
  return new Response(Uint8Array.from(atob(p.data), c => c.charCodeAt(0)), { headers: {
    "Content-Type": p.type, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'",
    "Content-Disposition": "inline", "Cache-Control": "private, max-age=31536000, immutable",
  } });
}

// The pick's recipe, into your own Recipe box.
export async function saveToBox(env, user, id) {
  if (!user.areas.has("recipes")) fail("you need Recipe box to save recipes");
  const p = await getPick(env, user, id);
  if (!p) return null;
  if (!p.recipe) fail("this pick has no recipe to save");
  const { image, ...r } = p.recipe;
  return { recipe: await createRecipe(env, user, { title: p.title, ...r, ...(image.startsWith("https:") ? { image } : {}),
    notes: [r.notes, `Food club pick for ${p.month}, from ${p.by}.`].filter(Boolean).join("\n\n") }) };
}

// ── the page and its API ───────────────────────────────────────────────────

// Recipe pictures come from wherever the recipe lives; photos from here.
const PAGE_CSP = [
  "default-src 'none'", "script-src 'self'", "connect-src 'self'", "manifest-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com", "img-src 'self' data: blob: https:",
  "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function readBody(request) {
  const text = await request.text();
  if (text.length > LIMITS.body) fail("that's too big to send");
  if (!text) return {};
  try { return JSON.parse(text); } catch { fail("invalid JSON"); }
}

export async function food(request, env, user, pathname) {
  if (!pathname.startsWith("/food/api/")) {
    const asset = await withRail(await env.ASSETS.fetch(request), user, "food");
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
    if (method !== "GET" && !sameOrigin(request)) return json({ error: "cross-origin request refused" }, 403);
    const notAllowed = () => json({ error: "method not allowed" }, 405);
    if (pathname === "/food/api/club") {
      if (method !== "GET") return notAllowed();
      const box = user.areas.has("recipes");
      let recipes = [];
      if (box) {
        const { results } = await (await db(env)).prepare("SELECT id, json_extract(data, '$.title') AS title FROM recipes WHERE owner = ?").bind(user.id).all();
        recipes = results.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
      }
      return json({ picks: await listPicks(env, user), you: user.id, kinds: KINDS, recipe_box: box, meals: user.areas.has("meals"), recipes });
    }
    const ph = pathname.match(PHOTO);
    if (ph) return method === "GET" ? photoFile(env, ph[1]) : notAllowed();
    const m = pathname.match(ROUTE);
    if (!m) return json({ error: "not found" }, 404);
    const [, id, sub, photo] = m;
    if (!id) return method === "POST" ? json(await createPick(env, user, await readBody(request)), 201) : notAllowed();
    let out;
    if (!sub) {
      if (method === "GET") out = await getPick(env, user, id);
      else if (method === "PATCH") out = await updatePick(env, user, id, await readBody(request));
      else if (method === "DELETE") out = await deletePick(env, user, id);
    } else if (sub === "mine" && !photo) {
      if (method === "PUT") out = await mark(env, user, id, await readBody(request));
    } else if (sub === "save" && !photo) {
      if (method === "POST") out = await saveToBox(env, user, id);
    } else if (sub === "photos") {
      if (!photo && method === "POST") out = await addPhoto(env, user, id, await readBody(request));
      else if (photo && method === "DELETE") out = await removePhoto(env, user, id, photo);
    }
    if (out === undefined) return notAllowed();
    return out ? json(out, sub === "save" ? 201 : 200) : json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    if (e instanceof NotARecipe) return json({ error: e.message, manual: true }, 422);
    console.error("food club error:", e);
    return json({ error: "server error" }, 500);
  }
}
