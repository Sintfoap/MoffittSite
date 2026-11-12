// Recipe box: recipes saved from a link (or typed in), scaled to any number
// of servings, and their ingredients sent to a Drift list to shop from.
//
// Saving from a link reads the page's schema.org Recipe data (the JSON-LD
// almost every recipe site publishes for search engines), falling back to
// microdata. Scaling is public/recipes/scale.js, shared with the page.
//
// /recipes/api/recipes             GET → {recipes, label_list, lists, drift, board (has Recipe board), labels (keeps Recipe labels), photo}; POST {url} or {title, ...} → a new recipe
// /recipes/api/recipes/import      POST {pages: [html, ...]} → {added, skipped}: many at once, from an export file
// /recipes/api/recipes/<id>/photo  POST {data (base64)} → the recipe, with that as its picture (kept here); DELETE → without a picture
// /recipes/api/photos/<photo>      GET → a picture kept here
// /recipes/api/recipes/<id>        PATCH → change the fields sent; DELETE → remove it
//   Your own marks go the same way: made ("YYYY-MM-DD", the day you last made it, or "" for not yet)
//   and rating (1 to 5 stars, 0 for none). They're yours alone: never sent to the board or Food club.
//   A recipe's labels come from the site's list (see labelList): sent as ids, read back as [{id, key, value}].
//   GET also sends label_list, the whole list to pick from.
// /recipes/api/recipes/suggest-labels  GET → labels each recipe's words point to, to check before adding (src/autolabel.js)
// /recipes/api/recipes/add-labels      POST {add: [{id, labels: [label ids]}], at most 200} → {recipes, labels, full}: added to the ones they have
// /recipes/api/recipes/<id>/translate  POST → {language, english, fields}: the recipe in English, saved only by a PATCH (src/translate.js)
// /recipes/api/recipes/<id>/shop   POST {servings | factor, lines?, list?} → its ingredients onto a Drift list
// /recipes/api/reviews             GET → {reviews, unread}: what people who made the recipes you shared on the board thought of them,
//                                    newest first (each with new, since you last looked); POST /recipes/api/reviews/seen → the same, all read
// /recipes/api/photo, /recipes/api/key   a recipe read from a photo, and the API key it's read with (src/recipe_photo.js)

import { db } from "./db.js";
import { sameOrigin } from "./account.js";
import { withRail } from "./pages.js";
import { readJson, BadRequest, writableCollections, addToList } from "./drift.js";
import { imageType } from "./food.js";
import { scaleLine, servingsOf, factorFor, format } from "../public/recipes/scale.js";
import { photoState, readPhoto, readPhotoBody, saveKey, forgetKey, readText } from "./recipe_photo.js";
import { SweepError } from "./sweep.js";
import { storePhoto, unstorePhoto, photoResponse, photoIds, dropPhotos } from "./photos.js";
import { suggestFor, termsOf } from "./autolabel.js";
import { translate, recipeText, TranslateError } from "./translate.js";

const fail = msg => { throw new BadRequest(msg); };
export class NotARecipe extends Error {}

const LIMITS = { labels: 20, recipes: 1000, importPages: 10, importBody: 4 * 1024 * 1024, title: 200, url: 2000, yield: 100, time: 50, lines: 100, ingredient: 300, step: 3000, notes: 5000, page: 3 * 1024 * 1024 };
const ID = /^r_[0-9a-f]{10}$/;
const ROUTE = /^\/recipes\/api\/recipes(?:\/(import|suggest-labels|add-labels)|\/(r_[0-9a-f]{10})(?:\/(shop|photo|translate))?)?\/?$/;
const PHOTO = /^\/recipes\/api\/photos\/(p_[0-9a-f]{10})$/;
const REVIEWS = /^\/recipes\/api\/reviews(?:\/(seen))?\/?$/;
// A picture kept here (an imported recipe's own photo) instead of a link to a site's.
const OWN_PHOTO = /^\/recipes\/api\/photos\/p_[0-9a-f]{10}$/;
export const PHOTO_BYTES = 600 * 1024;
const nowStamp = () => new Date().toISOString().slice(0, 19);
const isObj = v => v && typeof v === "object" && !Array.isArray(v);

export const RECIPE = { title: "", source: "", image: "", yield: "", servings: null, time: "", ingredients: [], steps: [], notes: "", labels: [], made: "", rating: 0, created: "" };

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(5));
  return "r_" + [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

// ── cleaning ───────────────────────────────────────────────────────────────

function str(f, v, max) {
  const s = String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (s.length > max) fail(`${f} is longer than ${max} characters`);
  return s;
}

// A list of lines: an array, or text with one per line.
function lines(f, v, max) {
  const list = Array.isArray(v) ? v : String(v ?? "").split(/\r?\n/);
  const out = list.map(x => str(f, x, max).replace(/\s+/g, " ")).filter(Boolean);
  if (out.length > LIMITS.lines) fail(`${f} can have at most ${LIMITS.lines} lines`);
  return out;
}

function link(f, v, { https = false } = {}) {
  const s = str(f, v, LIMITS.url);
  if (!s) return "";
  let u;
  try { u = new URL(s); } catch { fail(`${f} must be a web address`); }
  if (!(https ? ["https:"] : ["https:", "http:"]).includes(u.protocol)) fail(`${f} must start with ${https ? "https" : "http"}://`);
  return u.toString();
}

// Labels: the site's one list of them, kept in the Recipe labels app
// (src/labels.js), like "Season: Fall" or "Cuisine: Mediterranean", so everyone
// picks the same ones instead of typing "Fall" and "Autumn". A recipe keeps the
// ids of its labels and reads back [{id, key, value}]; a label that's removed
// drops off every recipe. Ids can be sent as "l_…" or {id}.
const LABEL = /^l_[0-9a-f]{10}$/;
export function cleanLabels(v) {
  if (!Array.isArray(v)) fail("labels must be a list of label ids");
  const out = [];
  for (const item of v) {
    const id = String(isObj(item) ? item.id : item ?? "");
    if (!LABEL.test(id)) fail("labels must be ids from the site's label list");
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > LIMITS.labels) fail(`a recipe can have at most ${LIMITS.labels} labels`);
  return out;
}

// Every label on the list, by key then value: [{id, key, value}].
export async function labelList(d) {
  const { results } = await d.prepare("SELECT id, key, value FROM recipe_labels ORDER BY key COLLATE NOCASE, value COLLATE NOCASE").all();
  return results;
}
// A recipe's stored ids as {id, key, value}, in the list's order, leaving out deleted ones.
export function withLabels(list, ids) {
  const want = new Set(Array.isArray(ids) ? ids.map(x => isObj(x) ? x.id : x) : []);
  return list.filter(l => want.has(l.id));
}
export async function checkLabels(d, ids) {
  if (!ids?.length) return;
  const known = new Set((await labelList(d)).map(l => l.id));
  if (ids.some(id => !known.has(id))) fail("that label isn't on the site's list (someone may have just removed it)");
}

// Also the Recipe board's (src/board.js) and Food club's (src/food.js): a post's or pick's recipe is cleaned the same way.
export function clean(changes) {
  if (!isObj(changes)) fail("body must be a JSON object");
  const out = {};
  for (const [f, v] of Object.entries(changes)) {
    switch (f) {
      case "title": out.title = str(f, v, LIMITS.title); if (!out.title) fail("a recipe needs a title"); break;
      case "source": out.source = link(f, v); break;
      case "image": out.image = OWN_PHOTO.test(String(v ?? "").trim()) ? String(v).trim() : link(f, v, { https: true }); break;
      case "yield": out.yield = str(f, v, LIMITS.yield); break;
      case "servings": {
        if (v === null || v === "") { out.servings = null; break; }
        const n = Number(v);
        if (!(n > 0 && n <= 1000)) fail("servings must be a number from 1 to 1000");
        out.servings = Math.round(n * 100) / 100;
        break;
      }
      case "time": out.time = str(f, v, LIMITS.time); break;
      case "ingredients": out.ingredients = lines(f, v, LIMITS.ingredient); break;
      case "steps": out.steps = lines(f, v, LIMITS.step); break;
      case "notes": out.notes = str(f, v, LIMITS.notes); break;
      case "labels": out.labels = cleanLabels(v); break;
      default: fail(`unknown field ${JSON.stringify(f)}`);
    }
  }
  return out;
}

// "Made this" and your stars: only on a recipe in your own box (create and
// updateFor), so clean() (the board's and Food club's too) never takes them.
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export function cleanMine(changes) {
  if (!isObj(changes)) fail("body must be a JSON object");
  const { made, rating, ...rest } = changes;
  const out = clean(rest);
  if (made !== undefined) {
    const v = made === null || made === false ? "" : String(made).trim();
    if (v && !(DAY.test(v) && !Number.isNaN(Date.parse(v)))) fail("made must be a date (YYYY-MM-DD), or \"\" for not made yet");
    out.made = v;
  }
  if (rating !== undefined) {
    const n = rating === null || rating === "" ? 0 : Number(rating);
    if (!Number.isInteger(n) || n < 0 || n > 5) fail("rating must be a whole number of stars from 1 to 5, or 0 for none");
    out.rating = n;
  }
  return out;
}

// ── storage ────────────────────────────────────────────────────────────────

const toRecipe = (row, labels = []) => {
  const data = JSON.parse(row.data);
  return { ...RECIPE, ...data, labels: withLabels(labels, data.labels), id: row.id, updated: row.updated };
};

export async function list(env, user) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT id, data, updated FROM recipes WHERE owner = ?").bind(user.id).all();
  const labels = await labelList(d);
  return results.map(r => toRecipe(r, labels)).sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
}

export async function get(d, owner, id) {
  const row = await d.prepare("SELECT id, data, updated FROM recipes WHERE owner = ? AND id = ?").bind(owner, id).first();
  return row ? toRecipe(row, await labelList(d)) : null;
}

export async function create(env, user, fields) {
  const d = await db(env);
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM recipes WHERE owner = ?").bind(user.id).first();
  if (n >= LIMITS.recipes) fail(`recipe limit reached (${LIMITS.recipes})`);
  const data = cleanMine(fields);
  if (!data.title) fail("a recipe needs a title");
  await checkLabels(d, data.labels);
  if (data.servings === undefined) data.servings = servingsOf(data.yield);
  const recipe = { ...RECIPE, ...data, created: nowStamp() };
  const id = newId(), updated = new Date().toISOString();
  await d.prepare("INSERT INTO recipes (owner, id, data, updated) VALUES (?, ?, ?, ?)").bind(user.id, id, JSON.stringify(recipe), updated).run();
  return { ...recipe, labels: withLabels(await labelList(d), recipe.labels), id, updated };
}

export async function update(env, user, id, changes) {
  return updateFor(await db(env), user.id, id, changes);
}

// Also the Recipe board's: a change to a post that's someone's box recipe is made to the recipe.
export async function updateFor(d, owner, id, changes) {
  const patch = cleanMine(changes);
  await checkLabels(d, patch.labels);
  const before = await rawRecipe(d, owner, id);
  if (!before) return null;
  await d.prepare("UPDATE recipes SET data = json_patch(data, ?), updated = ? WHERE owner = ? AND id = ?")
    .bind(JSON.stringify(patch), new Date().toISOString(), owner, id).run();
  await syncBoard(d, owner, id, before);
  return get(d, owner, id);
}

// ── suggested labels ───────────────────────────────────────────────────────

// Every recipe in the box that its words say should have labels it hasn't got,
// by title: {suggestions: [{id, title, labels: [{id, key, value, word, where}]}], checked, labels}.
// A recipe with its 20 labels already gets none; one near it, only as many as fit.
export async function suggestLabels(env, user) {
  const d = await db(env);
  const kw = new Map((await d.prepare("SELECT id, keywords FROM recipe_labels").all()).results.map(r => [r.id, r.keywords]));
  const labels = (await labelList(d)).map(l => ({ ...l, keywords: kw.get(l.id) || "" }));
  const terms = new Map(labels.map(l => [l.id, termsOf(l)]));
  const box = await list(env, user);
  const suggestions = [];
  for (const r of box) {
    const room = LIMITS.labels - r.labels.length;
    const found = room > 0 ? suggestFor(r, labels, terms).slice(0, room) : [];
    if (found.length) suggestions.push({ id: r.id, title: r.title, labels: found });
  }
  return { suggestions, checked: box.length, labels: labels.length };
}

// Clients send a big box in batches of this many (a request's body is capped at 64 KB).
export const ADD_BATCH = 200;

// Adds labels to many recipes at once, keeping the ones they have:
// {recipes: how many changed, labels: how many added, full: recipes that had no room for them all}.
export async function addLabels(env, user, body) {
  if (!isObj(body) || !Array.isArray(body.add)) fail("send {add: [{id, labels: [label ids]}]}");
  if (body.add.length > ADD_BATCH) fail(`send at most ${ADD_BATCH} recipes at a time`);
  const want = new Map();
  for (const a of body.add) {
    if (!isObj(a) || !ID.test(String(a.id ?? ""))) fail("each one needs a recipe's id");
    want.set(a.id, [...new Set([...(want.get(a.id) || []), ...cleanLabels(a.labels ?? [])])]);
  }
  const d = await db(env);
  await checkLabels(d, [...new Set([...want.values()].flat())]);
  const { results } = await d.prepare("SELECT id, json_extract(data, '$.labels') AS labels FROM recipes WHERE owner = ?").bind(user.id).all();
  const mine = new Map(results.map(r => [r.id, JSON.parse(r.labels || "[]")]));
  const t = new Date().toISOString(), writes = [];
  let added = 0, full = 0;
  for (const [id, ids] of want) {
    const have = mine.get(id);
    if (!have) continue;
    const fresh = ids.filter(x => !have.includes(x));
    const fits = fresh.slice(0, Math.max(0, LIMITS.labels - have.length));
    if (fits.length < fresh.length) full++;
    if (!fits.length) continue;
    added += fits.length;
    writes.push(d.prepare("UPDATE recipes SET data = json_set(data, '$.labels', json(?)), updated = ? WHERE owner = ? AND id = ?")
      .bind(JSON.stringify([...have, ...fits]), t, user.id, id));
  }
  for (let i = 0; i < writes.length; i += 100) await d.batch(writes.slice(i, i + 100));
  return { recipes: writes.length, labels: added, full };
}

export async function remove(env, user, id) {
  const d = await db(env);
  const photos = await photoIds(d, "SELECT id FROM recipe_photos WHERE owner = ? AND recipe = ?", user.id, id);
  const res = await d.prepare("DELETE FROM recipes WHERE owner = ? AND id = ?").bind(user.id, id).run();
  if (!res.meta.changes) return null;
  await d.batch([
    d.prepare("DELETE FROM recipe_photos WHERE owner = ? AND recipe = ?").bind(user.id, id),
    // Its posts on the board stay, as it last was.
    d.prepare("UPDATE board_posts SET data = json_remove(data, '$.from') WHERE author = ? AND json_extract(data, '$.from') = ?").bind(user.id, id),
  ]);
  await dropPhotos(env, "recipe_photos", photos);
  return { removed: true };
}

// ── the Recipe board's copy ────────────────────────────────────────────────

// A recipe shared on the Recipe board (src/board.js) is the same recipe there,
// not a copy that goes stale: its posts keep `from`, the recipe's id, and every
// change to it here (labels, ingredients, its picture, its title) is made to
// them too. That keeps the board's categories, which go by a post's labels, right.
export const BOARD_FIELDS = ["source", "image", "yield", "servings", "time", "ingredients", "steps", "notes", "labels"];
export const boardRecipe = r => Object.fromEntries(BOARD_FIELDS.map(k => [k, r[k] ?? RECIPE[k]]));

async function rawRecipe(d, owner, id) {
  const row = await d.prepare("SELECT data FROM recipes WHERE owner = ? AND id = ?").bind(owner, id).first();
  return row ? { ...RECIPE, ...JSON.parse(row.data) } : null;
}

// `before` is the recipe as it was: posts shared before they were linked (by
// their title and ingredients, as sharing copied them) are linked to it now.
export async function syncBoard(d, owner, id, before = null) {
  const r = await rawRecipe(d, owner, id);
  if (!r) return;
  const now = new Date().toISOString();
  const stmts = [];
  if (before) {
    stmts.push(d.prepare(`UPDATE board_posts SET data = json_set(data, '$.from', ?) WHERE author = ?
      AND json_extract(data, '$.from') IS NULL AND json_extract(data, '$.title') = ? COLLATE NOCASE
      AND json(COALESCE(json_extract(data, '$.recipe.ingredients'), '[]')) = json(?)`)
      .bind(id, owner, before.title, JSON.stringify(before.ingredients || [])));
  }
  stmts.push(d.prepare(`UPDATE board_posts SET data = json_set(data, '$.title', ?, '$.recipe', json(?)), updated = ?
    WHERE author = ? AND json_extract(data, '$.from') = ?`).bind(r.title, JSON.stringify(boardRecipe(r)), now, owner, id));
  await d.batch(stmts);
}

// Its ingredients, scaled, onto a Drift list. `lines` picks which (by index);
// without it, all of them.
export async function shop(env, user, id, body) {
  if (!user.areas.has("todo")) fail("you need Drift to make a shopping list");
  if (!isObj(body)) fail("body must be a JSON object");
  const recipe = await get(await db(env), user.id, id);
  if (!recipe) return null;
  const factor = factorFor(recipe, body);
  const pick = Array.isArray(body.lines) ? new Set(body.lines.map(Number)) : null;
  const titles = recipe.ingredients.filter((_, i) => !pick || pick.has(i)).map(l => scaleLine(l, factor).slice(0, 500));
  if (!titles.length) fail("pick at least one ingredient");
  const servings = recipe.servings ? Math.round(recipe.servings * factor * 100) / 100 : null;
  const notes = `For ${recipe.title}` + (servings ? ` (${servings} serving${servings === 1 ? "" : "s"})` : factor !== 1 ? ` (×${format(factor)})` : "");
  const list = body.list ? String(body.list) : null;
  return addToList(env, user, list, titles, notes);
}

// ── reading a recipe from a web page ───────────────────────────────────────

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", frac12: "½", frac14: "¼", frac34: "¾", deg: "°",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", eacute: "é", egrave: "è", times: "×", reg: "®", trade: "™", copy: "©" };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
  if (e[0] === "#") {
    const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
  }
  return ENTITIES[e.toLowerCase()] ?? m;
});
// Text from a bit of HTML: tags out, entities decoded (twice; sites often double-encode), spaces tidied.
const text = v => decode(decode(String(v ?? "").replace(/<[^>]*>/g, " "))).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const types = node => [].concat(node?.["@type"] ?? []).map(String);

// Every object in a JSON-LD document, through arrays, @graph and mainEntity.
function* nodes(v, depth = 0) {
  if (depth > 6 || !v || typeof v !== "object") return;
  if (Array.isArray(v)) { for (const x of v) yield* nodes(x, depth + 1); return; }
  yield v;
  for (const k of ["@graph", "mainEntity", "mainEntityOfPage"]) if (v[k] && typeof v[k] === "object") yield* nodes(v[k], depth + 1);
}

// "PT1H30M" → 90, or null if it isn't one.
function minutes(v) {
  const m = String(v ?? "").trim().match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+(?:\.\d+)?S)?)?$/i);
  return m ? ((+m[1] || 0) * 24 + (+m[2] || 0)) * 60 + (+m[3] || 0) : null;
}
// 90 → "1 hr 30 min".
const span = n => [n >= 60 && `${Math.floor(n / 60)} hr`, n % 60 && `${n % 60} min`].filter(Boolean).join(" ");
// "PT1H30M" → "1 hr 30 min".
const duration = v => span(minutes(v) ?? 0);
// The total time, or prep and cook added up when a page gives only those.
function totalTime(total, cook, prep) {
  if (duration(total)) return duration(total);
  const c = minutes(cook), p = minutes(prep);
  return c != null && p != null ? span(c + p) : duration(cook) || duration(prep);
}

function steps(v, depth = 0) {
  if (depth > 4 || v == null) return [];
  if (typeof v === "string") return v.replace(/<\/(p|li)>|<br\s*\/?>/gi, "\n").split(/\n+/).map(text).filter(Boolean);
  if (Array.isArray(v)) return v.flatMap(x => steps(x, depth + 1));
  if (typeof v === "object") {
    if (types(v).includes("HowToSection") || v.itemListElement) return steps(v.itemListElement, depth + 1);
    return steps(v.text ?? v.name ?? "", depth + 1);
  }
  return [];
}

function image(v) {
  const first = Array.isArray(v) ? v[0] : v;
  const url = typeof first === "string" ? first : first?.url ?? first?.contentUrl;
  return typeof url === "string" && /^https:\/\//i.test(url) && url.length <= LIMITS.url ? url : "";
}

const first = v => Array.isArray(v) ? v.find(x => x != null && String(x).trim()) : v;

function fromJsonLd(html) {
  for (const [, body] of html.matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(body.trim().replace(/^<!\[CDATA\[|\]\]>$/g, "")); } catch { continue; }
    for (const n of nodes(data)) {
      if (!types(n).some(t => /(^|\/)Recipe$/.test(t))) continue;
      const y = first(n.recipeYield);
      return {
        title: text(n.name || n.headline),
        image: image(n.image),
        yield: text(y ?? ""),
        servings: servingsOf(text([].concat(n.recipeYield ?? []).join(" "))),
        time: totalTime(n.totalTime, n.cookTime, n.prepTime),
        ingredients: [].concat(n.recipeIngredient ?? n.ingredients ?? []).map(text).filter(Boolean),
        steps: steps(n.recipeInstructions),
        notes: text(n.description),
      };
    }
  }
  return null;
}

// Older sites mark the parts up in the page itself instead. So does Recipe
// Keeper's shared recipe pages (recipekeeperonline.com/recipe/…), with names
// of its own: each ingredient is an <li itemprop="ingredient"> (older pages put
// them all in recipeIngredients as <p>s), the directions are <li>s or <p>s,
// times and the yield are <meta content>, and the picture is itemprop="photo0".
// The attribute quoted or not (Recipe Keeper writes itemprop=photo0).
const itemprop = name => `itemprop\\s*=\\s*(?:["'](?:[^"']*\\s)?${name}(?:\\s[^"']*)?["']|${name}(?=[\\s/>]))`;
const BREAKS = /<\/(p|li|div|h\d)>|<br\s*\/?>/gi;

// From `from` to the tag that closes the one just opened, counting nested ones of the same name.
function closing(html, tag, from) {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = from;
  for (let depth = 1, m; (m = re.exec(html));) {
    if (m[0].endsWith("/>")) continue;
    depth += m[1] ? -1 : 1;
    if (!depth) return m.index;
  }
  return html.length;
}

// `loose` keeps a recipe that's only a title (an export has those: meal ideas
// with nothing filled in yet); a web page without ingredients isn't a recipe.
function fromMicrodata(html, url, { loose = false } = {}) {
  const VOID = /^(meta|img|br|hr|input|link)$/i;
  const inner = (tag, at) => VOID.test(tag) ? "" : html.slice(at, closing(html, tag, at));
  // The inside of each element with that itemprop, up to its own closing tag.
  const els = name => [...html.matchAll(new RegExp(`<([a-z0-9]+)\\b[^>]*${itemprop(name)}[^>]*>`, "gi"))].map(m => inner(m[1], m.index + m[0].length));
  const lines = (...names) => names.flatMap(els).flatMap(inner => inner.replace(BREAKS, "\n").split(/\n+/).map(text)).filter(Boolean);
  const metas = name => [...html.matchAll(new RegExp(`<meta\\b[^>]*${itemprop(name)}[^>]*>`, "gi"))]
    .map(m => text(m[0].match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? "")).filter(Boolean);
  const value = name => metas(name)[0] || text(els(name)[0] ?? "");

  const ingredients = lines("recipeIngredient", "recipeIngredients", "ingredients", "ingredient");
  if (!ingredients.length && !(loose && value("name"))) return null;
  const y = value("recipeYield");
  const [total, cook, prep] = ["totalTime", "cookTime", "prepTime"].map(value);
  const time = totalTime(total, cook, prep) || [total, cook, prep].find(t => t && !/^P/i.test(t)) || "";
  const pic = html.match(new RegExp(`<img\\b[^>]*${itemprop("(?:photo0|photo|image)")}[^>]*>`, "i"))?.[0].match(/src\s*=\s*["']([^"']+)["']/i)?.[1];
  let img = "";
  try { img = pic ? image(new URL(decode(pic), url || undefined).toString()) : ""; } catch {}
  return {
    title: value("name"), yield: y, servings: servingsOf(y), ingredients, time, image: img,
    notes: lines("recipeNotes", "description").join("\n"), from: value("recipeSource"),
    // Recipe Keeper numbers its directions ("1. Mix"); the page numbers them already.
    steps: lines("recipeInstructions", "recipeDirections").map(l => l.replace(/^\d+[.)]\s+/, "")).filter(Boolean),
  };
}

const meta = (html, prop) => {
  const m = html.match(new RegExp(`<meta[^>]*(?:property|name)\\s*=\\s*["']${prop}["'][^>]*>`, "i"));
  const c = m && m[0].match(/content\s*=\s*["']([^"']*)["']/i);
  return c ? text(c[1]) : "";
};

// The recipe on a page, or null if there isn't one.
export function parseRecipe(html, url = "") {
  const r = fromJsonLd(html) || fromMicrodata(html, url);
  if (!r) return null;
  if (r.from) r.notes = [r.notes, `Source: ${r.from}`].filter(Boolean).join("\n\n");
  return tidy(r, html, url);
}

// Cut to fit, with the page's own title and picture when the recipe has none.
function tidy(r, html, url) {
  const title = r.title || meta(html, "og:title") || text(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || "Untitled recipe";
  const cut = (s, n) => s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
  return {
    title: cut(title, LIMITS.title), source: url, image: r.image || image(meta(html, "og:image")),
    yield: cut(r.yield, LIMITS.yield), servings: r.servings, time: cut(r.time, LIMITS.time),
    ingredients: r.ingredients.slice(0, LIMITS.lines).map(l => cut(l, LIMITS.ingredient)),
    steps: r.steps.slice(0, LIMITS.lines).map(l => cut(l, LIMITS.step)),
    notes: cut(r.notes, LIMITS.notes),
  };
}

// Only ordinary public web addresses: no other schemes, passwords, IP literals or local names.
function fetchable(raw) {
  let u;
  try { u = new URL(String(raw ?? "").trim()); } catch { return null; }
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return null;
  if (/(^|\.)(localhost|local|internal|home\.arpa)$/.test(host)) return null;
  return u;
}

async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size >= LIMITS.page) { reader.cancel().catch(() => {}); break; }
  }
  const all = new Uint8Array(Math.min(size, LIMITS.page));
  let at = 0;
  for (const c of chunks) { const part = c.subarray(0, all.length - at); all.set(part, at); at += part.length; if (at >= all.length) break; }
  return new TextDecoder().decode(all);
}

// Fetches a page (following up to 5 redirects, each checked) and reads its recipe.
export async function importFrom(rawUrl) {
  let u = fetchable(rawUrl);
  if (!u) fail("that doesn't look like a web address for a recipe");
  for (let hop = 0; hop < 6; hop++) {
    let res;
    try {
      res = await fetch(u.toString(), {
        redirect: "manual", signal: AbortSignal.timeout(10000),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; sintfoap-recipes/1.0; +https://sintfoap.xyz)", Accept: "text/html,application/xhtml+xml" },
      });
    } catch { fail("couldn't load that page"); }
    if (res.status >= 300 && res.status < 400 && res.headers.get("Location")) {
      const next = fetchable(new URL(res.headers.get("Location"), u).toString());
      if (!next) fail("that page redirects somewhere it can't be read from");
      u = next;
      continue;
    }
    if (!res.ok) fail(`couldn't load that page (the site answered ${res.status})`);
    const type = res.headers.get("Content-Type") || "";
    if (type && !/html|xml/i.test(type)) fail("that link isn't a web page");
    const r = parseRecipe(await readCapped(res), u.toString());
    if (!r) throw new NotARecipe("couldn't find a recipe on that page; you can add it by hand");
    return r;
  }
  fail("that page redirects too many times");
}

// ── importing many at once ─────────────────────────────────────────────────

// Recipe Keeper's export (Settings → Export → HTML, a recipes.html beside an
// images folder) is one page with every recipe in a <div class="recipe-details">,
// marked up like its shared pages, plus courses, categories, collections, a
// rating and nutrition. The page and the terminal cut the file into one piece
// per recipe (public/recipes/split.js, cli/sintfoap/recipe_rules.py) and send
// them a few at a time, so no one request has much to read. Any other saved
// recipe page is sent whole and read like a link would be.

// The values of everything with that itemprop: a <meta>'s content, or an element's text.
function props(html, name) {
  return [...html.matchAll(new RegExp(`<(meta|span|div|a)\\b[^>]*${itemprop(name)}[^>]*>(?=([^<]*))`, "gi"))]
    .map(m => text(m[1].toLowerCase() === "meta" ? m[0].match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? "" : m[2] ?? "")).filter(Boolean);
}

const NUTRITION = [["Calories", "Calories", ""], ["TotalFat", "Fat", "g"], ["SaturatedFat", "Saturated fat", "g"], ["Cholesterol", "Cholesterol", "mg"],
  ["Sodium", "Sodium", "mg"], ["TotalCarbohydrate", "Carbs", "g"], ["DietaryFiber", "Fiber", "g"], ["Sugars", "Sugars", "g"], ["Protein", "Protein", "g"]];

// What Recipe Keeper knows about a recipe that the box has no place for, as lines for its notes.
function keeperExtras(html) {
  const list = (label, name) => { const v = [...new Set(props(html, name))]; return v.length ? `${label}: ${v.join(", ")}` : ""; };
  const stars = Number(props(html, "recipeRating")[0]);
  const nut = NUTRITION.map(([k, label, unit]) => { const v = props(html, "recipeNut" + k)[0]; return v ? `${label} ${v}${unit}` : ""; }).filter(Boolean);
  const size = props(html, "recipeNutServingSize")[0];
  return [
    list("Courses", "recipeCourse"), list("Categories", "recipeCategory"), list("Collections", "recipeCollection"),
    stars > 0 && stars <= 5 ? `Rating: ${"★".repeat(stars)}${"☆".repeat(5 - stars)}` : "",
    /^true$/i.test(props(html, "recipeIsFavourite")[0] ?? "") ? "Favourite" : "",
    nut.length ? `Nutrition${size ? ` (per ${size})` : " per serving"}: ${nut.join(" · ")}` : "",
  ].filter(Boolean);
}

// One piece of an export (or one saved page) as a recipe, or null.
export function parseImported(html) {
  const keeper = /itemprop\s*=\s*["']?recipeId\b/i.test(html);
  const r = keeper ? fromMicrodata(html, "", { loose: true }) : fromJsonLd(html) || fromMicrodata(html, "");
  if (!r) return null;
  let source = "";
  if (r.from) {
    // A link goes in the recipe's link; anything else ("Grandma's cookbook") in its notes.
    try { if (/^https?:\/\/\S+$/i.test(r.from) && r.from.length <= LIMITS.url) source = new URL(r.from).toString(); } catch {}
    if (!source) r.notes = [r.notes, `Source: ${r.from}`].filter(Boolean).join("\n\n");
  }
  if (keeper) {
    const extra = keeperExtras(html);
    if (extra.length) r.notes = [r.notes, extra.join("\n")].filter(Boolean).join("\n\n");
  }
  return { ...tidy(r, html, ""), source };
}

// The same recipe twice: one title, the same ingredients.
const sameness = r => [r.title, ...r.ingredients].join("\n").toLowerCase().replace(/\s+/g, " ").trim();

// Saves what's in each page, skipping ones already in the box. {added, skipped: [{title, why}], pages}:
// pages says, for each page in order, which recipe it is in the box ({id, image: whether it has a
// picture}, whether just added or already there) or null, so the export's photos can follow.
export async function importPages(env, user, body) {
  if (!isObj(body) || !Array.isArray(body.pages) || !body.pages.length) fail("send {pages: [html, ...]}");
  if (body.pages.length > LIMITS.importPages) fail(`send at most ${LIMITS.importPages} pages at a time`);
  const d = await db(env);
  // Only what sameness needs, so a box of hundreds is cheap to check each time.
  const { results } = await d.prepare(`SELECT id, json_extract(data, '$.title') AS title, json_extract(data, '$.ingredients') AS ingredients,
    json_extract(data, '$.image') AS image FROM recipes WHERE owner = ?`).bind(user.id).all();
  const have = new Map(results.map(row => [sameness({ title: row.title ?? "", ingredients: JSON.parse(row.ingredients || "[]") }), { id: row.id, image: !!row.image }]));
  let room = LIMITS.recipes - results.length;
  const added = [], skipped = [], inserts = [], pages = [];
  for (const page of body.pages) {
    pages.push(null);
    const r = typeof page === "string" ? parseImported(page) : null;
    if (!r) { skipped.push({ title: "", why: "had no recipe" }); continue; }
    const key = sameness(r);
    if (have.has(key)) { pages[pages.length - 1] = have.get(key); skipped.push({ title: r.title, why: "already in your box" }); continue; }
    if (room <= 0) { skipped.push({ title: r.title, why: `didn't fit (the box holds ${LIMITS.recipes})` }); continue; }
    let data;
    try { data = clean(r); } catch (e) { if (!(e instanceof BadRequest)) throw e; skipped.push({ title: r.title, why: e.message }); continue; }
    const recipe = { ...RECIPE, ...data, servings: data.servings ?? servingsOf(data.yield), created: nowStamp() };
    const id = newId(), updated = new Date().toISOString();
    inserts.push(d.prepare("INSERT INTO recipes (owner, id, data, updated) VALUES (?, ?, ?, ?)").bind(user.id, id, JSON.stringify(recipe), updated));
    added.push({ ...recipe, id, updated });
    have.set(key, pages[pages.length - 1] = { id, image: !!recipe.image });
    room--;
  }
  if (inserts.length) await d.batch(inserts);
  return { added, skipped, pages };
}

// ── pictures kept here ─────────────────────────────────────────────────────

// An export's photos, and pictures added by hand, are kept as Food club's are
// (src/photos.js: in R2, their rows in D1), one per recipe: a new one replaces the old.
export async function setPhoto(env, user, id, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  const d = await db(env);
  if (!await get(d, user.id, id)) return null;
  const bytes = decodePhoto(body.data);
  if (bytes.length > PHOTO_BYTES) fail(`that picture is too big (at most ${Math.round(PHOTO_BYTES / 1024)} KB); make it smaller first`);
  const type = imageType(bytes);
  if (!type) fail("that isn't a JPEG, PNG, WebP or GIF picture");
  const photo = "p_" + newId().slice(2), now = new Date().toISOString();
  const old = await photoIds(d, "SELECT id FROM recipe_photos WHERE owner = ? AND recipe = ?", user.id, id);
  const data = await storePhoto(env, "recipe_photos", photo, bytes, type);
  try {
    await d.batch([
      d.prepare("DELETE FROM recipe_photos WHERE owner = ? AND recipe = ?").bind(user.id, id),
      d.prepare("INSERT INTO recipe_photos (id, owner, recipe, type, data, created) VALUES (?, ?, ?, ?, ?, ?)").bind(photo, user.id, id, type, data, now),
      d.prepare("UPDATE recipes SET data = json_set(data, '$.image', ?), updated = ? WHERE owner = ? AND id = ?").bind(`/recipes/api/photos/${photo}`, now, user.id, id),
    ]);
  } catch (e) { await unstorePhoto(env, "recipe_photos", photo); throw e; }
  await dropPhotos(env, "recipe_photos", old);
  await syncBoard(d, user.id, id);
  return get(d, user.id, id);
}

// Takes the recipe's picture off: one kept here, or a link to a site's.
export async function removePhoto(env, user, id) {
  const d = await db(env);
  if (!await get(d, user.id, id)) return null;
  const old = await photoIds(d, "SELECT id FROM recipe_photos WHERE owner = ? AND recipe = ?", user.id, id);
  await d.batch([
    d.prepare("DELETE FROM recipe_photos WHERE owner = ? AND recipe = ?").bind(user.id, id),
    d.prepare("UPDATE recipes SET data = json_set(data, '$.image', ''), updated = ? WHERE owner = ? AND id = ?").bind(new Date().toISOString(), user.id, id),
  ]);
  await dropPhotos(env, "recipe_photos", old);
  await syncBoard(d, user.id, id);
  return get(d, user.id, id);
}

function decodePhoto(data) {
  const s = String(data ?? "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!s || !/^[A-Za-z0-9+/]+=*$/.test(s)) fail("send the picture as base64");
  try { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); } catch { fail("send the picture as base64"); }
}

// Anyone with Recipe box who has the link can see one (a recipe shared on to them carries it);
// the ids are random.
async function photoFile(env, photo) {
  const d = await db(env);
  const p = await d.prepare("SELECT id, type, data FROM recipe_photos WHERE id = ?").bind(photo).first();
  if (!p) return new Response("not found", { status: 404 });
  return photoResponse(env, "recipe_photos", p);
}

async function readImport(request) {
  const raw = await request.text();
  if (raw.length > LIMITS.importBody) fail("too much at once; send fewer pages");
  try { return JSON.parse(raw); } catch { fail("invalid JSON"); }
}

// ── the page and its API ───────────────────────────────────────────────────

// Pictures come from the recipe sites themselves, so img-src allows https; blob: is a picked picture's preview.
const PAGE_CSP = [
  // worker-src: text recognition (vendor/tesseract) reads photos in a worker, on the device;
  // wasm-unsafe-eval lets it run where the worker is held to this page's policy (Safari).
  "default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com", "img-src 'self' data: blob: https:",
  "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");

// ── reviews of yours: Recipe box's notification box ───────────────────────
// Reviews (src/board.js) left on the board posts you shared, newest change first.
// A review is new until you open the box after it was written or changed.

const REVIEW_INBOX = 50;
const reviewSeen = async (d, user) => (await d.prepare("SELECT seen FROM board_review_seen WHERE user_id = ?").bind(user.id).first())?.seen || "";

export async function reviewsForYou(env, user) {
  const d = await db(env);
  const seen = await reviewSeen(d, user);
  const yours = "FROM board_reviews v JOIN board_posts p ON p.id = v.post LEFT JOIN users u ON u.id = v.user_id WHERE p.author = ? AND v.user_id != ?";
  const { results } = await d.prepare(`SELECT v.*, u.username, u.display_name, json_extract(p.data, '$.title') AS title, json_extract(p.data, '$.from') AS from_id
    ${yours} ORDER BY v.updated DESC, v.id DESC LIMIT ?`).bind(user.id, user.id, REVIEW_INBOX).all();
  const { n } = await d.prepare(`SELECT COUNT(*) AS n ${yours} AND v.updated > ?`).bind(user.id, user.id, seen).first();
  // The Recipe box recipe the post was shared from, while it's still there.
  const ids = [...new Set(results.map(r => r.from_id).filter(Boolean))];
  const have = new Set(ids.length ? (await d.prepare(`SELECT id FROM recipes WHERE owner = ? AND id IN (${ids.map(() => "?").join(",")})`).bind(user.id, ...ids).all()).results.map(r => r.id) : []);
  return {
    unread: n,
    reviews: results.map(r => ({
      id: r.id, post: r.post, title: r.title || "", recipe_id: have.has(r.from_id) ? r.from_id : null,
      by: r.display_name || r.username || "A former member", rating: r.rating ?? null, note: r.note, changes: r.changes,
      created: r.created, updated: r.updated, edited: r.updated !== r.created, new: r.updated > seen,
    })),
  };
}

export async function markReviewsSeen(env, user) {
  const d = await db(env);
  await d.prepare("INSERT INTO board_review_seen (user_id, seen) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET seen = excluded.seen")
    .bind(user.id, new Date().toISOString()).run();
  return reviewsForYou(env, user);
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function recipes(request, env, user, pathname) {
  if (!pathname.startsWith("/recipes/api/")) {
    const asset = await withRail(await env.ASSETS.fetch(request), user, "recipes");
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
    if (/^\/recipes\/api\/photo\/?$/.test(pathname)) return method === "POST" ? json(await readPhoto(env, user, await readPhotoBody(request))) : notAllowed();
    if (/^\/recipes\/api\/text\/?$/.test(pathname)) return method === "POST" ? json(readText(await readPhotoBody(request))) : notAllowed();
    if (/^\/recipes\/api\/key\/?$/.test(pathname)) {
      if (method === "PUT") return json(await saveKey(env, user, await readJson(request)));
      return method === "DELETE" ? json(await forgetKey(env, user)) : notAllowed();
    }
    const ph = pathname.match(PHOTO);
    if (ph) return method === "GET" ? await photoFile(env, ph[1]) : notAllowed();
    const rv = pathname.match(REVIEWS);
    if (rv) {
      if (rv[1]) return method === "POST" ? json(await markReviewsSeen(env, user)) : notAllowed();
      return method === "GET" ? json(await reviewsForYou(env, user)) : notAllowed();
    }
    const m = pathname.match(ROUTE);
    if (!m) return json({ error: "not found" }, 404);
    const [, bulk, id, sub] = m;
    if (bulk === "suggest-labels") return method === "GET" ? json(await suggestLabels(env, user)) : notAllowed();
    if (bulk === "add-labels") return method === "POST" ? json(await addLabels(env, user, await readJson(request))) : notAllowed();
    if (bulk) return method === "POST" ? json(await importPages(env, user, await readImport(request))) : notAllowed();
    if (!id) {
      if (method === "GET") {
        const drift = user.areas.has("todo");
        return json({ recipes: await list(env, user), label_list: await labelList(await db(env)), drift, board: user.areas.has("board"), labels: user.areas.has("labels"), lists: drift ? await writableCollections(env, user) : [], photo: await photoState(env, user) });
      }
      if (method !== "POST") return notAllowed();
      const body = await readJson(request);
      // {url} alone: read it from the page. Anything else is typed in.
      if (isObj(body) && Object.keys(body).length === 1 && "url" in body) return json(await create(env, user, await importFrom(body.url)), 201);
      return json(await create(env, user, body), 201);
    }
    if (!ID.test(id)) return json({ error: "not found" }, 404);
    let out;
    if (sub === "translate") {
      if (method !== "POST") return notAllowed();
      const r = await get(await db(env), user.id, id);
      return r ? json(await translate(env, user, recipeText(r))) : json({ error: "not found" }, 404);
    }
    if (sub === "photo") out = method === "POST" ? await setPhoto(env, user, id, await readImport(request)) : method === "DELETE" ? await removePhoto(env, user, id) : undefined;
    else if (sub) out = method === "POST" ? await shop(env, user, id, await readJson(request)) : undefined;
    else if (method === "PATCH") out = await update(env, user, id, await readJson(request));
    else if (method === "DELETE") out = await remove(env, user, id);
    if (out === undefined) return notAllowed();
    return out ? json(out) : json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    if (e instanceof NotARecipe) return json({ error: e.message, manual: true }, 422);
    if (e instanceof SweepError || e instanceof TranslateError) return json({ error: e.message }, 503);
    console.error("recipes error:", e);
    return json({ error: "server error" }, 500);
  }
}
