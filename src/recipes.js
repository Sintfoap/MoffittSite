// Recipe box: recipes saved from a link (or typed in), scaled to any number
// of servings, and their ingredients sent to a Drift list to shop from.
//
// Saving from a link reads the page's schema.org Recipe data (the JSON-LD
// almost every recipe site publishes for search engines), falling back to
// microdata. Scaling is public/recipes/scale.js, shared with the page.
//
// /recipes/api/recipes             GET → {recipes, lists, drift}; POST {url} or {title, ...} → a new recipe
// /recipes/api/recipes/<id>        PATCH → change the fields sent; DELETE → remove it
// /recipes/api/recipes/<id>/shop   POST {servings | factor, lines?, list?} → its ingredients onto a Drift list

import { db } from "./db.js";
import { sameOrigin } from "./account.js";
import { withRail } from "./pages.js";
import { readJson, BadRequest, writableCollections, addToList } from "./drift.js";
import { scaleLine, servingsOf, factorFor, format } from "../public/recipes/scale.js";

const fail = msg => { throw new BadRequest(msg); };
class NotARecipe extends Error {}

const LIMITS = { recipes: 500, title: 200, url: 2000, yield: 100, time: 50, lines: 100, ingredient: 300, step: 3000, notes: 5000, page: 3 * 1024 * 1024 };
const ID = /^r_[0-9a-f]{10}$/;
const ROUTE = /^\/recipes\/api\/recipes(?:\/(r_[0-9a-f]{10})(?:\/(shop))?)?\/?$/;
const nowStamp = () => new Date().toISOString().slice(0, 19);
const isObj = v => v && typeof v === "object" && !Array.isArray(v);

const RECIPE = { title: "", source: "", image: "", yield: "", servings: null, time: "", ingredients: [], steps: [], notes: "", created: "" };

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

function clean(changes) {
  if (!isObj(changes)) fail("body must be a JSON object");
  const out = {};
  for (const [f, v] of Object.entries(changes)) {
    switch (f) {
      case "title": out.title = str(f, v, LIMITS.title); if (!out.title) fail("a recipe needs a title"); break;
      case "source": out.source = link(f, v); break;
      case "image": out.image = link(f, v, { https: true }); break;
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
      default: fail(`unknown field ${JSON.stringify(f)}`);
    }
  }
  return out;
}

// ── storage ────────────────────────────────────────────────────────────────

const toRecipe = row => ({ ...RECIPE, ...JSON.parse(row.data), id: row.id, updated: row.updated });

export async function list(env, user) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT id, data, updated FROM recipes WHERE owner = ?").bind(user.id).all();
  return results.map(toRecipe).sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
}

async function get(d, owner, id) {
  const row = await d.prepare("SELECT id, data, updated FROM recipes WHERE owner = ? AND id = ?").bind(owner, id).first();
  return row ? toRecipe(row) : null;
}

export async function create(env, user, fields) {
  const d = await db(env);
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM recipes WHERE owner = ?").bind(user.id).first();
  if (n >= LIMITS.recipes) fail(`recipe limit reached (${LIMITS.recipes})`);
  const data = clean(fields);
  if (!data.title) fail("a recipe needs a title");
  if (data.servings === undefined) data.servings = servingsOf(data.yield);
  const recipe = { ...RECIPE, ...data, created: nowStamp() };
  const id = newId(), updated = new Date().toISOString();
  await d.prepare("INSERT INTO recipes (owner, id, data, updated) VALUES (?, ?, ?, ?)").bind(user.id, id, JSON.stringify(recipe), updated).run();
  return { ...recipe, id, updated };
}

export async function update(env, user, id, changes) {
  const d = await db(env);
  const patch = clean(changes);
  const res = await d.prepare("UPDATE recipes SET data = json_patch(data, ?), updated = ? WHERE owner = ? AND id = ?")
    .bind(JSON.stringify(patch), new Date().toISOString(), user.id, id).run();
  return res.meta.changes ? get(d, user.id, id) : null;
}

export async function remove(env, user, id) {
  const d = await db(env);
  const res = await d.prepare("DELETE FROM recipes WHERE owner = ? AND id = ?").bind(user.id, id).run();
  return res.meta.changes ? { removed: true } : null;
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

// "PT1H30M" → "1 hr 30 min".
function duration(v) {
  const m = String(v ?? "").match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+(?:\.\d+)?S)?)?$/i);
  if (!m) return "";
  const hours = (+m[1] || 0) * 24 + (+m[2] || 0), mins = +m[3] || 0;
  return [hours && `${hours} hr`, mins && `${mins} min`].filter(Boolean).join(" ");
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
        time: duration(n.totalTime) || duration(n.cookTime) || duration(n.prepTime),
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
// of its own: recipeIngredients and recipeDirections hold every line as <p>s,
// times and the yield are <meta content>, and the picture is itemprop="photo0".
const itemprop = name => `itemprop\\s*=\\s*["'](?:[^"']*\\s)?${name}(?:\\s[^"']*)?["']`;
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

function fromMicrodata(html, url) {
  const VOID = /^(meta|img|br|hr|input|link)$/i;
  const inner = (tag, at) => VOID.test(tag) ? "" : html.slice(at, closing(html, tag, at));
  // The inside of each element with that itemprop, up to its own closing tag.
  const els = name => [...html.matchAll(new RegExp(`<([a-z0-9]+)\\b[^>]*${itemprop(name)}[^>]*>`, "gi"))].map(m => inner(m[1], m.index + m[0].length));
  const lines = (...names) => names.flatMap(els).flatMap(inner => inner.replace(BREAKS, "\n").split(/\n+/).map(text)).filter(Boolean);
  const metas = name => [...html.matchAll(new RegExp(`<meta\\b[^>]*${itemprop(name)}[^>]*>`, "gi"))]
    .map(m => text(m[0].match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? "")).filter(Boolean);
  const value = name => metas(name)[0] || text(els(name)[0] ?? "");

  const ingredients = lines("recipeIngredient", "recipeIngredients", "ingredients");
  if (!ingredients.length) return null;
  const y = value("recipeYield");
  const time = ["totalTime", "cookTime", "prepTime"].map(value).map(t => duration(t) || (/^P/i.test(t) ? "" : t)).find(Boolean) || "";
  const pic = html.match(new RegExp(`<img\\b[^>]*${itemprop("(?:photo0|photo|image)")}[^>]*>`, "i"))?.[0].match(/src\s*=\s*["']([^"']+)["']/i)?.[1];
  let img = "";
  try { img = pic ? image(new URL(decode(pic), url || undefined).toString()) : ""; } catch {}
  const from = value("recipeSource");
  const notes = [lines("recipeNotes", "description").join("\n"), from && `Source: ${from}`].filter(Boolean).join("\n\n");
  return {
    title: value("name"), yield: y, servings: servingsOf(y), ingredients, time, image: img, notes,
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

// ── the page and its API ───────────────────────────────────────────────────

// Pictures come from the recipe sites themselves, so img-src allows https.
const PAGE_CSP = [
  "default-src 'none'", "script-src 'self'", "connect-src 'self'", "manifest-src 'self'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com", "img-src 'self' data: https:",
  "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");

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
    const m = pathname.match(ROUTE);
    if (!m) return json({ error: "not found" }, 404);
    const [, id, sub] = m;
    const notAllowed = () => json({ error: "method not allowed" }, 405);
    if (!id) {
      if (method === "GET") {
        const drift = user.areas.has("todo");
        return json({ recipes: await list(env, user), drift, lists: drift ? await writableCollections(env, user) : [] });
      }
      if (method !== "POST") return notAllowed();
      const body = await readJson(request);
      // {url} alone: read it from the page. Anything else is typed in.
      if (isObj(body) && Object.keys(body).length === 1 && "url" in body) return json(await create(env, user, await importFrom(body.url)), 201);
      return json(await create(env, user, body), 201);
    }
    if (!ID.test(id)) return json({ error: "not found" }, 404);
    let out;
    if (sub) out = method === "POST" ? await shop(env, user, id, await readJson(request)) : undefined;
    else if (method === "PATCH") out = await update(env, user, id, await readJson(request));
    else if (method === "DELETE") out = await remove(env, user, id);
    if (out === undefined) return notAllowed();
    return out ? json(out) : json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    if (e instanceof NotARecipe) return json({ error: e.message, manual: true }, 422);
    console.error("recipes error:", e);
    return json({ error: "server error" }, 500);
  }
}
