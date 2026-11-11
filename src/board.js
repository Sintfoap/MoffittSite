// Recipe board: a shared board where members post recipes, follow the
// categories they like, and see what's new in those in their own feed.
// Anything on the board can be saved into your Recipe box with one button,
// and anything in your Recipe box can be posted to the board.
//
// A post shared from someone's Recipe box is that recipe, kept in step both
// ways: a change in the box shows on the board (src/recipes.js, syncBoard), and
// a change to the post here is made to the box recipe. Deleting the recipe
// leaves the post as it last was.
//
// The categories are the label keys from Recipe labels (src/labels.js):
// Season, Cuisine, Course... A post shows under every key its recipe's labels
// use, so nobody picks a category, and one recipe can be in several. Removing
// a key there (or here, for whoever has Recipe labels) removes the category.
//
// The board is everyone with Recipe board turned on. A post's author (or an
// admin) can change or delete it.
//
// /board/api/board?day=YYYY-MM-DD          GET → {categories, label_list, recipe_box, recipes, unread, featured, you, can_label}:
//                                            featured is the recipe of the day, the same post for everyone that day (day is your local date)
// /board/api/categories/<key>              DELETE → the key and its labels gone (needs Recipe labels)
// /board/api/categories/<key>/follow       PUT {follow} → the category
// /board/api/posts?view=&category=&label=&before=
//                                          GET → {posts, more, unread}: view is feed (the categories you follow;
//                                            reading it marks it read), all, mine or saved; category is a key, label one value's id
// /board/api/posts                         POST {title?, note?, labels?, recipe? | url? | recipe_id?} → the new post
// /board/api/posts/<id>                    GET → the post; PATCH → change the fields sent; DELETE → remove it
// /board/api/posts/<id>/translate         POST → {language, english, fields}: the post in English, for anyone to read (src/translate.js)
// /board/api/posts/<id>/save               POST → {recipe, already}: the post's recipe, in your Recipe box

import { db } from "./db.js";
import { sameOrigin } from "./account.js";
import { withRail } from "./pages.js";
import { BadRequest } from "./drift.js";
import { clean as cleanRecipe, get as getRecipe, create as createRecipe, updateFor as updateRecipe, syncBoard, boardRecipe, BOARD_FIELDS, importFrom, NotARecipe, labelList, withLabels, cleanLabels, checkLabels } from "./recipes.js";
import { deleteKey } from "./labels.js";
import { translate, recipeText, TranslateError } from "./translate.js";

const fail = msg => { throw new BadRequest(msg); };

const LIMITS = { title: 200, note: 2000, page: 40, posts: 2000, body: 256 * 1024 };
const LABEL = /^l_[0-9a-f]{10}$/;
const ROUTE_LABEL = /^\/board\/api\/labels\/([^/]+)\/follow\/?$/;
const ROUTE_CAT = /^\/board\/api\/categories\/([^/]+?)(?:\/(follow))?\/?$/;
const ROUTE_POST = /^\/board\/api\/posts(?:\/(b_[0-9a-f]{10})(?:\/(save|translate))?)?\/?$/;
const VIEWS = ["feed", "all", "mine", "saved"];
const RECIPE_FIELDS = BOARD_FIELDS;
const BLANK_RECIPE = { source: "", image: "", yield: "", servings: null, time: "", ingredients: [], steps: [], notes: "", labels: [] };
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
      case "labels": out.labels = cleanLabels(v); break;
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
    return { title: r.title, recipe: recipeFields(Object.fromEntries(RECIPE_FIELDS.map(k => [k, r[k]]))), from: r.id };
  }
  return null;
}

// ── categories: the label keys ─────────────────────────────────────────────

// A post's recipe has one of key's labels (or the label with that id).
const HAS_KEY = "EXISTS (SELECT 1 FROM json_each(p.data, '$.recipe.labels') j JOIN recipe_labels l ON l.id = j.value WHERE l.key = ?)";
const HAS_LABEL = "EXISTS (SELECT 1 FROM json_each(p.data, '$.recipe.labels') j WHERE j.value = ?)";
const FOLLOWED = `EXISTS (SELECT 1 FROM json_each(p.data, '$.recipe.labels') j JOIN recipe_labels l ON l.id = j.value
  JOIN board_follows f ON f.user_id = ? AND (l.key = f.category OR f.category = l.id))`;
const canLabel = user => user.areas.has("labels") || isAdmin(user);

// Every key on the label list, by name, with its values, how many posts each has, and whether you follow it.
export async function listCategories(env, user) {
  const d = await db(env);
  const labels = await labelList(d);
  const count = async sql => Object.fromEntries((await d.prepare(sql).all()).results.map(r => [r.k.toLowerCase(), r]));
  const perKey = await count(`SELECT l.key AS k, COUNT(DISTINCT p.id) AS n, MAX(p.created) AS latest
    FROM board_posts p, json_each(p.data, '$.recipe.labels') j JOIN recipe_labels l ON l.id = j.value GROUP BY l.key`);
  const perLabel = await count(`SELECT j.value AS k, COUNT(*) AS n FROM board_posts p, json_each(p.data, '$.recipe.labels') j GROUP BY j.value`);
  const mine = new Set((await d.prepare("SELECT category FROM board_follows WHERE user_id = ?").bind(user.id).all()).results.map(r => r.category.toLowerCase()));
  const followers = await count("SELECT category AS k, COUNT(*) AS n FROM board_follows GROUP BY category COLLATE NOCASE");
  const out = [];
  for (const l of labels) {
    const k = l.key.toLowerCase();
    let c = out.at(-1);
    if (!c || c.id.toLowerCase() !== k) {
      out.push(c = { id: l.key, name: l.key, values: [], posts: perKey[k]?.n || 0, latest: perKey[k]?.latest || null,
        following: mine.has(k), followers: followers[k]?.n || 0, can_delete: canLabel(user) });
    }
    if (l.value) {
      const i = l.id.toLowerCase();
      c.values.push({ id: l.id, value: l.value, posts: perLabel[i]?.n || 0, following: mine.has(i), followers: followers[i]?.n || 0 });
    }
  }
  return out;
}

const keyOf = async (d, key) => (await d.prepare("SELECT key FROM recipe_labels WHERE key = ? LIMIT 1").bind(key).first())?.key || null;
const categoryOut = async (env, user, key) => (await listCategories(env, user)).find(c => c.id.toLowerCase() === key.toLowerCase()) || null;

// Removing a category is removing its key from Recipe labels, so it's for whoever keeps that list.
export async function deleteCategory(env, user, key) {
  if (!canLabel(user)) fail("categories come from Recipe labels; whoever keeps that list can remove one");
  return deleteKey(env, key);
}

export async function follow(env, user, key, body) {
  if (!isObj(body) || typeof body.follow !== "boolean") fail("send {follow: true} or {follow: false}");
  const d = await db(env);
  const name = await keyOf(d, key);
  if (!name) return null;
  await (body.follow
    ? d.prepare("INSERT OR IGNORE INTO board_follows (user_id, category, added) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM board_follows WHERE user_id = ? AND category = ? COLLATE NOCASE)")
      .bind(user.id, name, new Date().toISOString(), user.id, name)
    : d.prepare("DELETE FROM board_follows WHERE user_id = ? AND category = ? COLLATE NOCASE").bind(user.id, name)).run();
  return categoryOut(env, user, name);
}

// Following one value of a key (like Season: Fall) puts just its posts in your feed.
export async function followLabel(env, user, id, body) {
  if (!isObj(body) || typeof body.follow !== "boolean") fail("send {follow: true} or {follow: false}");
  if (!LABEL.test(id)) return null;
  const d = await db(env);
  const l = await d.prepare("SELECT id, key FROM recipe_labels WHERE id = ?").bind(id).first();
  if (!l) return null;
  await (body.follow
    ? d.prepare("INSERT OR IGNORE INTO board_follows (user_id, category, added) VALUES (?, ?, ?)").bind(user.id, l.id, new Date().toISOString())
    : d.prepare("DELETE FROM board_follows WHERE user_id = ? AND category = ?").bind(user.id, l.id)).run();
  return (await categoryOut(env, user, l.key))?.values.find(v => v.id === l.id) || null;
}

// ── posts ──────────────────────────────────────────────────────────────────

const POST_SELECT = `SELECT p.*, u.username, u.display_name,
    (SELECT COUNT(*) FROM board_saves s WHERE s.post = p.id) AS saves,
    (SELECT recipe_id FROM board_saves s WHERE s.post = p.id AND s.user_id = ?) AS saved_as
  FROM board_posts p LEFT JOIN users u ON u.id = p.author`;

// A post's recipe keeps label ids, like Recipe box; `labels` is the site's list to read them with.
// Its categories are the keys of those labels.
function toPost(r, user, seen, labels = []) {
  const data = JSON.parse(r.data);
  const mine = data.recipe ? withLabels(labels, data.recipe.labels) : [];
  const categories = [...new Map(mine.map(l => [l.key.toLowerCase(), l.key])).values()];
  return {
    id: r.id, categories, title: data.title, note: data.note || "",
    recipe: data.recipe ? { ...BLANK_RECIPE, ...data.recipe, labels: mine } : null,
    by: nameOf(r), yours: r.author === user.id, can_edit: r.author === user.id || isAdmin(user),
    // The Recipe box recipe it's kept in step with (only its author's to open).
    from_box: !!data.from, ...(data.from && r.author === user.id ? { recipe_id: data.from } : {}),
    created: r.created, updated: r.updated, saves: r.saves, saved: !!r.saved_as,
    ...(seen !== undefined ? { new: r.author !== user.id && (!seen || r.created > seen) } : {}),
  };
}

export async function getPost(env, user, id) {
  const d = await db(env);
  const r = await d.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(user.id, id).first();
  return r ? toPost(r, user, undefined, await labelList(d)) : null;
}

const seenAt = async (d, user) => (await d.prepare("SELECT seen FROM board_seen WHERE user_id = ?").bind(user.id).first())?.seen || "";

// How many posts in the categories you follow are newer than your feed was last read (not counting yours).
export async function unread(d, user) {
  const seen = await seenAt(d, user);
  const { n } = await d.prepare(`SELECT COUNT(*) AS n FROM board_posts p WHERE ${FOLLOWED} AND p.author != ? AND p.created > ?`)
    .bind(user.id, user.id, seen).first();
  return n;
}

// A page of posts, newest first. `before` is the `created` of the last post on the page before.
export async function listPosts(env, user, { view = "feed", category: cat = "", label = "", before = "" } = {}) {
  if (!VIEWS.includes(view)) fail(`view is one of ${VIEWS.join(", ")}`);
  if (label && !LABEL.test(label)) fail("no such label");
  const d = await db(env);
  const where = [], args = [user.id];
  if (label) { where.push(HAS_LABEL); args.push(label); }
  else if (cat) { where.push(HAS_KEY); args.push(cat); }
  else if (view === "feed") { where.push(FOLLOWED); args.push(user.id); }
  else if (view === "mine") { where.push("p.author = ?"); args.push(user.id); }
  else if (view === "saved") { where.push("p.id IN (SELECT post FROM board_saves WHERE user_id = ?)"); args.push(user.id); }
  if (before) { where.push("p.created < ?"); args.push(String(before)); }
  const { results } = await d.prepare(`${POST_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY p.created DESC, p.id DESC LIMIT ?`).bind(...args, LIMITS.page + 1).all();
  const seen = await seenAt(d, user);
  const labels = await labelList(d);
  const posts = results.slice(0, LIMITS.page).map(r => toPost(r, user, seen, labels));
  // Reading the top of your feed marks it read.
  const isFeed = view === "feed" && !cat && !label;
  const count = await unread(d, user);
  if (isFeed && !before) {
    await d.prepare(`INSERT INTO board_seen (user_id, seen) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET seen = excluded.seen`)
      .bind(user.id, new Date().toISOString()).run();
  }
  return { posts, more: results.length > LIMITS.page, unread: isFeed && !before ? 0 : count };
}

// The recipe of the day: one post off the shared board, picked by the day alone,
// so everyone gets the same one (yours too, when it's your turn). It's drawn from
// the posts shared before that day began, so a post shared or taken down later in
// the day doesn't change it; a board that's newer than that draws from what it has.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export async function featured(env, user, day = "") {
  if (!DAY.test(day)) day = new Date().toISOString().slice(0, 10);
  const d = await db(env);
  let pool = "WHERE p.created < ?", args = [`${day}T00:00:00.000Z`];
  let { n } = await d.prepare(`SELECT COUNT(*) AS n FROM board_posts p ${pool}`).bind(...args).first();
  if (!n) {
    pool = "", args = [];
    ({ n } = await d.prepare("SELECT COUNT(*) AS n FROM board_posts").first());
  }
  if (!n) return null;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`recipe-of-the-day|${day}`)));
  const at = ((hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]) >>> 0;
  const r = await d.prepare(`${POST_SELECT} ${pool} ORDER BY p.id LIMIT 1 OFFSET ?`).bind(user.id, ...args, at % n).first();
  return r ? { ...toPost(r, user, undefined, await labelList(d)), day } : null;
}

async function postRow(d, id) {
  return d.prepare("SELECT * FROM board_posts WHERE id = ?").bind(id).first();
}

export async function createPost(env, user, fields) {
  const d = await db(env);
  const { url, recipe_id, labels, ...data } = cleanPost(fields);
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM board_posts WHERE author = ?").bind(user.id).first();
  if (n >= LIMITS.posts) fail(`you've posted as many recipes as the board holds for one person (${LIMITS.posts})`);
  const from = await recipeFrom(d, user, { url, recipe_id });
  if (from) { data.title ||= from.title; data.recipe = from.recipe; }
  if (!data.title) fail("give the recipe a title");
  if (!data.recipe) fail("add the recipe: a link, one from your Recipe box, or its ingredients and steps");
  // Labels sent with the post are the recipe's (and so its categories).
  if (labels) data.recipe.labels = labels;
  await checkLabels(d, data.recipe.labels);
  // From your box, it's that recipe: the title and labels given here are made to it there too.
  if (from?.from) {
    const r = await updateRecipe(d, user.id, from.from, { title: data.title, labels: data.recipe.labels });
    data.title = r.title;
    data.recipe = boardRecipe({ ...r, labels: data.recipe.labels });
    data.from = from.from;
  }
  // Each post a moment after the last, so two in the same millisecond still have an order
  // (the feed, its unread count and its pages all go by created).
  const { last } = await d.prepare("SELECT MAX(created) AS last FROM board_posts").first();
  const now = Date.now(), t = new Date(last && Date.parse(last) >= now ? Date.parse(last) + 1 : now).toISOString();
  const id = newId("b");
  await d.prepare("INSERT INTO board_posts (id, author, category, data, created, updated) VALUES (?, ?, '', ?, ?, ?)")
    .bind(id, user.id, JSON.stringify({ title: data.title, note: data.note || "", recipe: data.recipe, ...(data.from ? { from: data.from } : {}) }), t, t).run();
  return getPost(env, user, id);
}

export async function updatePost(env, user, id, changes) {
  const d = await db(env);
  const r = await postRow(d, id);
  if (!r) return null;
  if (r.author !== user.id && !isAdmin(user)) fail("only whoever posted it can change it");
  const { url, recipe_id, labels, ...patch } = cleanPost(changes);
  const from = await recipeFrom(d, user, { url, recipe_id });
  if (from) patch.recipe = from.recipe;
  if (patch.title === "") fail("give the recipe a title");
  const data = { ...JSON.parse(r.data), ...patch };
  if (!data.recipe) fail("a post needs its recipe");
  if (labels) data.recipe = { ...data.recipe, labels };
  await checkLabels(d, data.recipe.labels);
  // A recipe from a link replaces it outright; one from your box is kept in step with that one now.
  if (url) delete data.from;
  if (from?.from) data.from = from.from;
  await d.prepare("UPDATE board_posts SET data = ?, updated = ? WHERE id = ?")
    .bind(JSON.stringify(data), new Date().toISOString(), id).run();
  // Kept in step with a box recipe: the change is the recipe's, so it's made there, and from there to
  // every post of it. (Gone from the box, the post just keeps what it has.)
  if (data.from && (patch.title || patch.recipe || labels || from)) {
    const kept = await updateRecipe(d, r.author, data.from, { title: data.title, ...data.recipe });
    if (!kept) await d.prepare("UPDATE board_posts SET data = json_remove(data, '$.from') WHERE id = ?").bind(id).run();
  } else if (data.from) await syncBoard(d, r.author, data.from);
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
    notes: [r.notes, p.note, `From the Recipe board, shared by ${p.by}.`].filter(Boolean).join("\n\n").slice(0, 5000) });
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
        // With their labels, so sharing one starts with them ticked.
        const { results } = await d.prepare("SELECT id, json_extract(data, '$.title') AS title, json_extract(data, '$.labels') AS labels FROM recipes WHERE owner = ?").bind(user.id).all();
        recipes = results.map(r => ({ ...r, labels: JSON.parse(r.labels || "[]").map(x => typeof x === "string" ? x : x?.id).filter(Boolean) })).sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
      }
      const categories = await listCategories(env, user);
      const day = new URL(request.url).searchParams.get("day") || "";
      return json({ categories, label_list: await labelList(d), recipe_box: box, recipes, unread: await unread(d, user),
        featured: await featured(env, user, day), you: user.id, can_label: canLabel(user) });
    }
    let m = pathname.match(ROUTE_LABEL);
    if (m) {
      if (method !== "PUT") return notAllowed();
      const out = await followLabel(env, user, m[1], await readBody(request));
      return out ? json(out) : json({ error: "not found" }, 404);
    }
    m = pathname.match(ROUTE_CAT);
    if (m) {
      const [, raw, sub] = m;
      let key, out;
      try { key = decodeURIComponent(raw); } catch { return json({ error: "not found" }, 404); }
      if (sub && method === "PUT") out = await follow(env, user, key, await readBody(request));
      else if (!sub && method === "DELETE") out = await deleteCategory(env, user, key);
      if (out === undefined) return notAllowed();
      return out ? json(out) : json({ error: "not found" }, 404);
    }
    m = pathname.match(ROUTE_POST);
    if (!m) return json({ error: "not found" }, 404);
    const [, id, sub] = m;
    if (!id) {
      if (method === "GET") {
        const q = new URL(request.url).searchParams;
        return json(await listPosts(env, user, { view: q.get("view") || "feed", category: q.get("category") || "", label: q.get("label") || "", before: q.get("before") || "" }));
      }
      return method === "POST" ? json(await createPost(env, user, await readBody(request)), 201) : notAllowed();
    }
    let out;
    if (sub === "translate") {
      if (method !== "POST") return notAllowed();
      const p = await getPost(env, user, id);
      return p ? json(await translate(env, user, { ...(p.recipe ? recipeText(p.recipe) : {}), title: p.title, note: p.note })) : json({ error: "not found" }, 404);
    }
    if (sub) out = method === "POST" ? await saveToBox(env, user, id) : undefined;
    else if (method === "GET") out = await getPost(env, user, id);
    else if (method === "PATCH") out = await updatePost(env, user, id, await readBody(request));
    else if (method === "DELETE") out = await deletePost(env, user, id);
    if (out === undefined) return notAllowed();
    return out ? json(out, sub && !out.already ? 201 : 200) : json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    if (e instanceof NotARecipe) return json({ error: e.message, manual: true }, 422);
    if (e instanceof TranslateError) return json({ error: e.message }, 503);
    console.error("recipe board error:", e);
    return json({ error: "server error" }, 500);
  }
}
