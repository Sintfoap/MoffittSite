// Recipe board: a shared board where members post recipes under categories
// (Dinner, Baking, Vegetarian, ...), follow the categories they like, and see
// what's new in those in their own feed. Anything on the board can be saved
// into your Recipe box with one button, and anything in your Recipe box can
// be posted to the board.
//
// The board is everyone with Recipe board turned on. Anyone can start a
// category; whoever started it (or an admin) can delete it while it's empty.
// A post's author (or an admin) can change or delete it.
//
// /board/api/board?day=YYYY-MM-DD          GET → {categories, recipe_box, recipes, unread, featured, you}: featured is
//                                            the recipe of the day, someone else's post (day is your local date)
// /board/api/categories                    POST {name} → the new category
// /board/api/categories/<id>               DELETE → remove it (only while it has no posts)
// /board/api/categories/<id>/follow        PUT {follow} → the category
// /board/api/posts?view=&category=&before= GET → {posts, more, unread}: view is feed (the categories you
//                                            follow; reading it marks it read), all, mine or saved
// /board/api/posts                         POST {category, title?, note?, recipe? | url? | recipe_id?} → the new post
// /board/api/posts/<id>                    GET → the post; PATCH → change the fields sent; DELETE → remove it
// /board/api/posts/<id>/save               POST → {recipe, already}: the post's recipe, in your Recipe box

import { db } from "./db.js";
import { sameOrigin } from "./account.js";
import { withRail } from "./pages.js";
import { BadRequest } from "./drift.js";
import { clean as cleanRecipe, get as getRecipe, create as createRecipe, importFrom, NotARecipe } from "./recipes.js";

const fail = msg => { throw new BadRequest(msg); };

// What a new board starts with; members add their own.
export const STARTING_CATEGORIES = ["Dinner", "Breakfast", "Baking", "Dessert", "Vegetarian", "Quick", "Soups", "Drinks"];
const LIMITS = { categories: 60, name: 40, title: 200, note: 2000, page: 40, posts: 2000, body: 256 * 1024 };
const CAT = /^c_[0-9a-f]{10}$/;
const ROUTE_CAT = /^\/board\/api\/categories(?:\/(c_[0-9a-f]{10})(?:\/(follow))?)?\/?$/;
const ROUTE_POST = /^\/board\/api\/posts(?:\/(b_[0-9a-f]{10})(?:\/(save))?)?\/?$/;
const VIEWS = ["feed", "all", "mine", "saved"];
const RECIPE_FIELDS = ["source", "image", "yield", "servings", "time", "ingredients", "steps", "notes"];
const BLANK_RECIPE = { source: "", image: "", yield: "", servings: null, time: "", ingredients: [], steps: [], notes: "" };
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const isAdmin = user => user.areas.has("admin");
const nameOf = r => r.display_name || r.username || "A former member";

function newId(prefix) {
  const b = crypto.getRandomValues(new Uint8Array(5));
  return prefix + "_" + [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

function str(f, v, max) {
  const s = String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (s.length > max) fail(`${f} is longer than ${max} characters`);
  return s;
}

// Only the fields a post's recipe keeps (its title is the post's), cleaned as Recipe box cleans them.
function recipeFields(v) {
  if (v === null) return null;
  if (!isObj(v)) fail("recipe must be an object");
  const kept = Object.fromEntries(Object.entries(v).filter(([k]) => RECIPE_FIELDS.includes(k)));
  const out = { ...BLANK_RECIPE, ...cleanRecipe(kept) };
  return out.ingredients.length || out.steps.length || out.source ? out : null;
}

function cleanPost(changes) {
  if (!isObj(changes)) fail("body must be a JSON object");
  const out = {};
  for (const [f, v] of Object.entries(changes)) {
    switch (f) {
      case "category": out.category = String(v ?? ""); if (!CAT.test(out.category)) fail("pick a category"); break;
      case "title": out.title = str(f, v, LIMITS.title); break;
      case "note": out.note = str(f, v, LIMITS.note); break;
      case "recipe": out.recipe = recipeFields(v); break;
      case "url": case "recipe_id": out[f] = String(v ?? "").trim(); break;
      default: fail(`unknown field ${JSON.stringify(f)}`);
    }
  }
  return out;
}

// {url} or {recipe_id}: the recipe they stand for, and its title.
async function recipeFrom(d, user, { url, recipe_id }) {
  if (url) {
    const r = await importFrom(url);
    return { title: r.title, recipe: recipeFields(Object.fromEntries(RECIPE_FIELDS.filter(k => k in r).map(k => [k, r[k]]))) };
  }
  if (recipe_id) {
    if (!user.areas.has("recipes")) fail("you need Recipe box to share from it");
    const r = await getRecipe(d, user.id, recipe_id);
    if (!r) fail("that recipe isn't in your Recipe box");
    return { title: r.title, recipe: recipeFields(Object.fromEntries(RECIPE_FIELDS.map(k => [k, r[k]]))) };
  }
  return null;
}

// ── categories ─────────────────────────────────────────────────────────────

async function seed(d) {
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM board_categories").first();
  if (n) return;
  const t = new Date().toISOString();
  await d.batch(STARTING_CATEGORIES.map(name =>
    d.prepare("INSERT OR IGNORE INTO board_categories (id, name, created_by, created) VALUES (?, ?, NULL, ?)").bind(newId("c"), name, t)));
}

// Every category, by name, with how many posts it has and whether you follow it.
export async function listCategories(env, user) {
  const d = await db(env);
  await seed(d);
  const { results } = await d.prepare(`SELECT c.id, c.name, c.created_by,
      (SELECT COUNT(*) FROM board_posts p WHERE p.category = c.id) AS posts,
      (SELECT MAX(created) FROM board_posts p WHERE p.category = c.id) AS latest,
      EXISTS (SELECT 1 FROM board_follows f WHERE f.category = c.id AND f.user_id = ?) AS following,
      (SELECT COUNT(*) FROM board_follows f WHERE f.category = c.id) AS followers
    FROM board_categories c ORDER BY c.name COLLATE NOCASE`).bind(user.id).all();
  return results.map(c => ({ id: c.id, name: c.name, posts: c.posts, followers: c.followers, latest: c.latest || null,
    following: !!c.following, can_delete: !c.posts && (c.created_by === user.id || isAdmin(user)) }));
}

const category = (d, id) => d.prepare("SELECT * FROM board_categories WHERE id = ?").bind(id).first();
const categoryOut = async (env, user, id) => (await listCategories(env, user)).find(c => c.id === id) || null;

export async function createCategory(env, user, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  const name = str("name", body.name, LIMITS.name).replace(/\s+/g, " ");
  if (!name) fail("give the category a name");
  const d = await db(env);
  await seed(d);
  const same = await d.prepare("SELECT id FROM board_categories WHERE name = ?").bind(name).first();
  if (same) fail(`there's already a ${name} category`);
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM board_categories").first();
  if (n >= LIMITS.categories) fail(`the board has as many categories as it can hold (${LIMITS.categories})`);
  const id = newId("c");
  await d.batch([
    d.prepare("INSERT INTO board_categories (id, name, created_by, created) VALUES (?, ?, ?, ?)").bind(id, name, user.id, new Date().toISOString()),
    // You follow what you start.
    d.prepare("INSERT OR IGNORE INTO board_follows (user_id, category, added) VALUES (?, ?, ?)").bind(user.id, id, new Date().toISOString()),
  ]);
  return categoryOut(env, user, id);
}

export async function deleteCategory(env, user, id) {
  const d = await db(env);
  const c = await category(d, id);
  if (!c) return null;
  if (c.created_by !== user.id && !isAdmin(user)) fail("only whoever started a category (or an admin) can delete it");
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM board_posts WHERE category = ?").bind(id).first();
  if (n) fail("move or delete its recipes first");
  await d.batch([
    d.prepare("DELETE FROM board_follows WHERE category = ?").bind(id),
    d.prepare("DELETE FROM board_categories WHERE id = ?").bind(id),
  ]);
  return { removed: true };
}

export async function follow(env, user, id, body) {
  if (!isObj(body) || typeof body.follow !== "boolean") fail("send {follow: true} or {follow: false}");
  const d = await db(env);
  if (!await category(d, id)) return null;
  await (body.follow
    ? d.prepare("INSERT OR IGNORE INTO board_follows (user_id, category, added) VALUES (?, ?, ?)").bind(user.id, id, new Date().toISOString())
    : d.prepare("DELETE FROM board_follows WHERE user_id = ? AND category = ?").bind(user.id, id)).run();
  return categoryOut(env, user, id);
}

// ── posts ──────────────────────────────────────────────────────────────────

const POST_SELECT = `SELECT p.*, c.name AS category_name, u.username, u.display_name,
    (SELECT COUNT(*) FROM board_saves s WHERE s.post = p.id) AS saves,
    (SELECT recipe_id FROM board_saves s WHERE s.post = p.id AND s.user_id = ?) AS saved_as
  FROM board_posts p LEFT JOIN board_categories c ON c.id = p.category LEFT JOIN users u ON u.id = p.author`;

function toPost(r, user, seen) {
  const data = JSON.parse(r.data);
  return {
    id: r.id, category: r.category, category_name: r.category_name || "", title: data.title, note: data.note || "",
    recipe: data.recipe ? { ...BLANK_RECIPE, ...data.recipe } : null,
    by: nameOf(r), yours: r.author === user.id, can_edit: r.author === user.id || isAdmin(user),
    created: r.created, updated: r.updated, saves: r.saves, saved: !!r.saved_as,
    ...(seen !== undefined ? { new: r.author !== user.id && (!seen || r.created > seen) } : {}),
  };
}

export async function getPost(env, user, id) {
  const d = await db(env);
  const r = await d.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(user.id, id).first();
  return r ? toPost(r, user) : null;
}

const seenAt = async (d, user) => (await d.prepare("SELECT seen FROM board_seen WHERE user_id = ?").bind(user.id).first())?.seen || "";

// How many posts in the categories you follow are newer than your feed was last read (not counting yours).
export async function unread(d, user) {
  const seen = await seenAt(d, user);
  const { n } = await d.prepare(`SELECT COUNT(*) AS n FROM board_posts p JOIN board_follows f ON f.category = p.category AND f.user_id = ?
    WHERE p.author != ? AND p.created > ?`).bind(user.id, user.id, seen).first();
  return n;
}

// A page of posts, newest first. `before` is the `created` of the last post on the page before.
export async function listPosts(env, user, { view = "feed", category: cat = "", before = "" } = {}) {
  if (!VIEWS.includes(view)) fail(`view is one of ${VIEWS.join(", ")}`);
  if (cat && !CAT.test(cat)) fail("no such category");
  const d = await db(env);
  const where = [], args = [user.id];
  if (cat) { where.push("p.category = ?"); args.push(cat); }
  else if (view === "feed") { where.push("p.category IN (SELECT category FROM board_follows WHERE user_id = ?)"); args.push(user.id); }
  else if (view === "mine") { where.push("p.author = ?"); args.push(user.id); }
  else if (view === "saved") { where.push("p.id IN (SELECT post FROM board_saves WHERE user_id = ?)"); args.push(user.id); }
  if (before) { where.push("p.created < ?"); args.push(String(before)); }
  const { results } = await d.prepare(`${POST_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY p.created DESC, p.id DESC LIMIT ?`).bind(...args, LIMITS.page + 1).all();
  const seen = await seenAt(d, user);
  const posts = results.slice(0, LIMITS.page).map(r => toPost(r, user, seen));
  // Reading the top of your feed marks it read.
  const isFeed = view === "feed" && !cat;
  const count = await unread(d, user);
  if (isFeed && !before) {
    await d.prepare(`INSERT INTO board_seen (user_id, seen) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET seen = excluded.seen`)
      .bind(user.id, new Date().toISOString()).run();
  }
  return { posts, more: results.length > LIMITS.page, unread: isFeed && !before ? 0 : count };
}

// The recipe of the day: one of everyone else's posts, picked by the day and
// who's asking, so it stays the same all day and differs from person to person.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export async function featured(env, user, day = "") {
  if (!DAY.test(day)) day = new Date().toISOString().slice(0, 10);
  const d = await db(env);
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM board_posts WHERE author != ?").bind(user.id).first();
  if (!n) return null;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${user.id}|${day}`)));
  const at = ((hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]) >>> 0;
  const r = await d.prepare(`${POST_SELECT} WHERE p.author != ? ORDER BY p.id LIMIT 1 OFFSET ?`).bind(user.id, user.id, at % n).first();
  return r ? { ...toPost(r, user), day } : null;
}

async function postRow(d, id) {
  return d.prepare("SELECT * FROM board_posts WHERE id = ?").bind(id).first();
}

export async function createPost(env, user, fields) {
  const d = await db(env);
  const { url, recipe_id, ...data } = cleanPost(fields);
  if (!data.category || !await category(d, data.category)) fail("pick a category");
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM board_posts WHERE author = ?").bind(user.id).first();
  if (n >= LIMITS.posts) fail(`you've posted as many recipes as the board holds for one person (${LIMITS.posts})`);
  const from = await recipeFrom(d, user, { url, recipe_id });
  if (from) { data.title ||= from.title; data.recipe = from.recipe; }
  if (!data.title) fail("give the recipe a title");
  if (!data.recipe) fail("add the recipe: a link, one from your Recipe box, or its ingredients and steps");
  const id = newId("b"), t = new Date().toISOString();
  await d.prepare("INSERT INTO board_posts (id, author, category, data, created, updated) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, user.id, data.category, JSON.stringify({ title: data.title, note: data.note || "", recipe: data.recipe }), t, t).run();
  return getPost(env, user, id);
}

export async function updatePost(env, user, id, changes) {
  const d = await db(env);
  const r = await postRow(d, id);
  if (!r) return null;
  if (r.author !== user.id && !isAdmin(user)) fail("only whoever posted it can change it");
  const { url, recipe_id, category: cat, ...patch } = cleanPost(changes);
  if (cat && !await category(d, cat)) fail("pick a category");
  const from = await recipeFrom(d, user, { url, recipe_id });
  if (from) patch.recipe = from.recipe;
  if (patch.title === "") fail("give the recipe a title");
  const data = { ...JSON.parse(r.data), ...patch };
  if (!data.recipe) fail("a post needs its recipe");
  await d.prepare("UPDATE board_posts SET category = ?, data = ?, updated = ? WHERE id = ?")
    .bind(cat || r.category, JSON.stringify(data), new Date().toISOString(), id).run();
  return getPost(env, user, id);
}

export async function deletePost(env, user, id) {
  const d = await db(env);
  const r = await postRow(d, id);
  if (!r) return null;
  if (r.author !== user.id && !isAdmin(user)) fail("only whoever posted it can delete it");
  // Copies already saved to someone's Recipe box stay theirs.
  await d.batch([d.prepare("DELETE FROM board_saves WHERE post = ?").bind(id), d.prepare("DELETE FROM board_posts WHERE id = ?").bind(id)]);
  return { removed: true };
}

// The post's recipe, into your own Recipe box (once: saving it again gives back the copy you have).
export async function saveToBox(env, user, id) {
  if (!user.areas.has("recipes")) fail("you need Recipe box to save recipes");
  const d = await db(env);
  const p = await getPost(env, user, id);
  if (!p) return null;
  const had = await d.prepare("SELECT recipe_id FROM board_saves WHERE post = ? AND user_id = ?").bind(id, user.id).first();
  if (had) {
    const r = await getRecipe(d, user.id, had.recipe_id);
    if (r) return { recipe: r, already: true };
  }
  const { image, ...r } = p.recipe;
  const recipe = await createRecipe(env, user, { title: p.title, ...r, ...(image.startsWith("https:") ? { image } : {}),
    notes: [r.notes, p.note, `From the Recipe board (${p.category_name}), shared by ${p.by}.`].filter(Boolean).join("\n\n").slice(0, 5000) });
  await d.prepare(`INSERT INTO board_saves (post, user_id, recipe_id, created) VALUES (?, ?, ?, ?)
    ON CONFLICT (post, user_id) DO UPDATE SET recipe_id = excluded.recipe_id, created = excluded.created`)
    .bind(id, user.id, recipe.id, new Date().toISOString()).run();
  return { recipe, already: false };
}

// ── the page and its API ───────────────────────────────────────────────────

// Recipe pictures come from wherever the recipe lives.
const PAGE_CSP = [
  "default-src 'none'", "script-src 'self'", "connect-src 'self'", "manifest-src 'self'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com", "img-src 'self' data: https:",
  "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function readBody(request) {
  const text = await request.text();
  if (text.length > LIMITS.body) fail("that's too big to send");
  if (!text) return {};
  try { return JSON.parse(text); } catch { fail("invalid JSON"); }
}

export async function board(request, env, user, pathname) {
  if (!pathname.startsWith("/board/api/")) {
    const asset = await withRail(await env.ASSETS.fetch(request), user, "board");
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
    if (pathname === "/board/api/board") {
      if (method !== "GET") return notAllowed();
      const d = await db(env), box = user.areas.has("recipes");
      let recipes = [];
      if (box) {
        const { results } = await d.prepare("SELECT id, json_extract(data, '$.title') AS title FROM recipes WHERE owner = ?").bind(user.id).all();
        recipes = results.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
      }
      const categories = await listCategories(env, user);
      const day = new URL(request.url).searchParams.get("day") || "";
      return json({ categories, recipe_box: box, recipes, unread: await unread(d, user), featured: await featured(env, user, day), you: user.id });
    }
    let m = pathname.match(ROUTE_CAT);
    if (m) {
      const [, id, sub] = m;
      if (!id) return method === "POST" ? json(await createCategory(env, user, await readBody(request)), 201) : notAllowed();
      let out;
      if (sub && method === "PUT") out = await follow(env, user, id, await readBody(request));
      else if (!sub && method === "DELETE") out = await deleteCategory(env, user, id);
      if (out === undefined) return notAllowed();
      return out ? json(out) : json({ error: "not found" }, 404);
    }
    m = pathname.match(ROUTE_POST);
    if (!m) return json({ error: "not found" }, 404);
    const [, id, sub] = m;
    if (!id) {
      if (method === "GET") {
        const q = new URL(request.url).searchParams;
        return json(await listPosts(env, user, { view: q.get("view") || "feed", category: q.get("category") || "", before: q.get("before") || "" }));
      }
      return method === "POST" ? json(await createPost(env, user, await readBody(request)), 201) : notAllowed();
    }
    let out;
    if (sub) out = method === "POST" ? await saveToBox(env, user, id) : undefined;
    else if (method === "GET") out = await getPost(env, user, id);
    else if (method === "PATCH") out = await updatePost(env, user, id, await readBody(request));
    else if (method === "DELETE") out = await deletePost(env, user, id);
    if (out === undefined) return notAllowed();
    return out ? json(out, sub && !out.already ? 201 : 200) : json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    if (e instanceof NotARecipe) return json({ error: e.message, manual: true }, 422);
    console.error("recipe board error:", e);
    return json({ error: "server error" }, 500);
  }
}
