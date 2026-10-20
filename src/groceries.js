// Grocery autopilot: builds a grocery order out of what you already have on
// the site, a Drift shopping list and the recipes you pick from Recipe box,
// and hands it to a store, so nothing is typed in twice.
//
// The order is worked out fresh each time: the list's unticked items and each
// picked recipe's ingredients (scaled to the servings you chose) are read for
// an amount, a unit and the thing itself ("2 cups flour, sifted" → 2 cup,
// flour), and lines for the same thing are added together. Things you've said
// you always have (salt, pepper, water to start with) are set aside.
//
// What a store can be sent, honestly:
// - Kroger (and its stores: Ralphs, Fred Meyer, King Soopers, Smith's, Fry's,
//   Harris Teeter, ...) has a public API that puts products in your own cart.
//   You connect your Kroger account once, pick a store, and each line is
//   matched to a product there; the match you send is remembered for next
//   time, so after the first order it's hands off. Kroger has no checkout in
//   its API, so you pay in Kroger's app or site.
// - Instacart's Developer Platform makes a shopping-list page from the order;
//   you open it, pick any store Instacart shops at, and check out there.
// - Walmart has no API for shoppers' carts or orders (its APIs are for sellers
//   and advertisers), so each line gets a walmart.com search link instead.
//
// Sending an order ticks its Drift items off (unless you say not to) and
// unpicks its recipes. Every order sent is kept, line by line, so a scanner can later mark when
// groceries arrived and when they go off.
//
// /groceries/api/state                    GET → {drift, recipes_on, lists, recipes, plan, list, lines, have, kroger, instacart, orders}
// /groceries/api/plan                     PUT {list?, recipes?, pantry?} → state
// /groceries/api/pantry                   PUT {name, have} → state
// /groceries/api/instacart                POST {skip?, check_off?} → {url, order, state}
// /groceries/api/kroger                   DELETE → state (disconnects)
// /groceries/api/kroger/stores?zip=       GET → {stores}
// /groceries/api/kroger/store             PUT {id, modality?} → state
// /groceries/api/kroger/match             POST {} → {matches: {<key>: {match, choices, remembered}}}
// /groceries/api/kroger/search?q=         GET → {choices}
// /groceries/api/kroger/cart              POST {lines: [{key, upc, quantity}], check_off?} → {added, order, state}
// /groceries/api/matches/<key>            PUT {upc, description, ...} → {match}; DELETE → {removed}
// /groceries/kroger/connect               GET → off to Kroger to sign in
// /groceries/kroger/callback              GET ← back from Kroger
//
// KROGER_CLIENT_ID and KROGER_CLIENT_SECRET (developer.kroger.com) turn
// Kroger on; the app there needs <site>/groceries/kroger/callback as its
// redirect URI. Each person's Kroger sign-in is kept sealed under the
// CHAT_BRIDGE_KEY secret. INSTACART_API_KEY turns Instacart on
// (INSTACART_API_URL points it at Instacart's development server instead).

import { db, now } from "./db.js";
import { sameOrigin } from "./account.js";
import { withRail } from "./pages.js";
import { bridgeReady } from "./bridges.js";
import { seal, unseal, randomToken } from "./crypto.js";
import { readJson, BadRequest, writableCollections, state as driftState, updateItem, SHOPPING } from "./drift.js";
import { list as recipeList } from "./recipes.js";
import { amount, format, scaleLine, factorFor } from "../public/recipes/scale.js";

const fail = msg => { throw new BadRequest(msg); };
class StoreError extends Error {}

const KROGER = "https://api.kroger.com";
const SCOPES = "cart.basic:write product.compact profile.compact";
const INSTACART = "https://connect.instacart.com";
const LIMITS = { recipes: 20, pantry: 200, name: 100, lines: 150, match: 60, orders: 20, text: 300 };
const DEFAULT_PANTRY = ["salt", "pepper", "salt and pepper", "black pepper", "kosher salt", "water", "ice"];
const MODALITIES = ["PICKUP", "DELIVERY"];
const KEY = /^[\p{L}\p{N} ]{1,100}$/u;
const ROUTE = /^\/groceries\/api\/(state|plan|pantry|instacart|kroger|matches)(?:\/([^/]+))?\/?$/;
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const text = (v, n = LIMITS.text) => clip(String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(), n);
const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(x => x.toString(16).padStart(2, "0")).join("");

// ── reading a line ─────────────────────────────────────────────────────────

// Each unit's spellings, by the name it's shown and added up under.
const UNITS = {
  cup: ["cup", "cups", "c"], tbsp: ["tablespoon", "tablespoons", "tbsp", "tbs", "tbl", "tbsps"], tsp: ["teaspoon", "teaspoons", "tsp", "tsps"],
  oz: ["ounce", "ounces", "oz"], "fl oz": ["fl oz", "fluid ounce", "fluid ounces"], lb: ["pound", "pounds", "lb", "lbs"],
  g: ["g", "gram", "grams"], kg: ["kg", "kilogram", "kilograms"], ml: ["ml", "milliliter", "milliliters", "millilitre", "millilitres"],
  l: ["l", "liter", "liters", "litre", "litres"], pint: ["pint", "pints", "pt"], quart: ["quart", "quarts", "qt"], gallon: ["gallon", "gallons", "gal"],
  can: ["can", "cans"], jar: ["jar", "jars"], bottle: ["bottle", "bottles"], package: ["package", "packages", "pkg", "packet", "packets"],
  bag: ["bag", "bags"], box: ["box", "boxes"], bunch: ["bunch", "bunches"], head: ["head", "heads"], clove: ["clove", "cloves"],
  slice: ["slice", "slices"], stick: ["stick", "sticks"], stalk: ["stalk", "stalks"], sprig: ["sprig", "sprigs"], pinch: ["pinch", "pinches"],
  dash: ["dash", "dashes"], dozen: ["dozen"],
};
const SPELLING = new Map(Object.entries(UNITS).flatMap(([unit, names]) => names.map(n => [n, unit])));
const UNIT_RE = new RegExp(`^(${[...SPELLING.keys()].sort((a, b) => b.length - a.length).map(s => s.replace(" ", "\\s+")).join("|")})\\.?(?=\\s|$)`, "i");
// The words Instacart knows these by (docs.instacart.com, units of measurement).
const INSTACART_UNIT = { cup: "cup", tbsp: "tablespoon", tsp: "teaspoon", oz: "ounce", "fl oz": "fl oz", lb: "pound", g: "gram", kg: "kilogram",
  ml: "milliliter", l: "liter", pint: "pint", quart: "quart", gallon: "gallon", can: "can", jar: "jar", bottle: "bottle", package: "package",
  bag: "bag", box: "box", bunch: "bunch", head: "head", clove: "clove", slice: "slice", stick: "stick", stalk: "stalk", sprig: "sprig", dozen: "dozen", "": "each" };

const GLYPHS = "¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞";
const AMOUNT = `(?:\\d+\\s*[${GLYPHS}]|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:[.,]\\d+)?|[${GLYPHS}])`;
const LEAD = new RegExp(`^(${AMOUNT})(?:\\s*(?:-|–|—|to|or)\\s*(${AMOUNT}))?\\s*`, "i");
// Words about how it's cut or cooked, not what to buy.
const PREP = /^(?:fresh(?:ly)?|large|small|medium|extra[- ]large|chopped|finely|roughly|coarsely|thinly|diced|minced|sliced|grated|shredded|crushed|softened|melted|packed|heaping|level|cold|warm|hot|room[- ]temperature|peeled|halved|quartered|cubed|beaten|sifted|rinsed|drained|divided|optional|about|approximately|plus|more|a|an|of)\s+/i;

// "eggs" and "egg", "tomatoes" and "tomato", "berries" and "berry" are the same thing.
function singular(w) {
  if (w.length <= 3 || /(ss|us|is)$/.test(w)) return w;
  if (/ies$/.test(w)) return w.slice(0, -3) + "y";
  if (/(oes|ches|shes|xes)$/.test(w)) return w.slice(0, -2);
  return w.endsWith("s") ? w.slice(0, -1) : w;
}
// What lines for the same thing have in common: lower case, plain letters, each word singular.
export const keyOf = name => String(name ?? "").toLowerCase().replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim()
  .split(" ").filter(Boolean).map(singular).join(" ").slice(0, LIMITS.name);

// One line of a list or recipe → {quantity, unit, name}; quantity is null when it doesn't say.
export function parseLine(raw) {
  let s = text(raw).replace(/^[-*•]\s+/, "");
  let quantity = null, unit = "";
  const m = s.match(LEAD);
  if (m) {
    const a = amount(m[1]), b = m[2] === undefined ? null : amount(m[2]);
    if (Number.isFinite(a)) { quantity = Number.isFinite(b) ? Math.max(a, b) : a; s = s.slice(m[0].length); }
  }
  // "2 (15 oz) cans beans": the size in brackets says which can, not how many.
  s = s.replace(/^\([^)]*\)\s*/, "");
  // Recipe shorthand: a capital T is a tablespoon, a small t a teaspoon.
  const short = quantity !== null && s.match(/^([Tt])\.?\s+/);
  if (short) { unit = short[1] === "T" ? "tbsp" : "tsp"; s = s.slice(short[0].length); }
  const u = !short && s.match(UNIT_RE);
  // A lone "c" or "l" is a unit only after a number ("2 c sugar"), not a word ("l" in "lettuce" can't match anyway).
  if (u && (quantity !== null || u[1].length > 1)) { unit = SPELLING.get(u[1].toLowerCase().replace(/\s+/g, " ")); s = s.slice(u[0].length).trim(); }
  s = s.replace(/^of\s+/i, "");
  // What's after a comma or in brackets is how to prepare it; "to taste" and "for serving" aren't things to buy.
  let name = s.split(/,|;|\s\(|\sfor\s(?:serving|garnish|the\s)/i)[0].replace(/\(.*?\)/g, " ").replace(/\b(?:to taste|as needed|or more|or to taste)\b/gi, " ");
  for (let prev; prev !== name;) { prev = name; name = name.trim().replace(PREP, ""); }
  name = name.replace(/\s+/g, " ").trim();
  if (!name) name = text(raw);
  return { quantity, unit, name: clip(name, LIMITS.name) };
}

// "2 cup + 1 tbsp", or "" when nothing says how much.
export function amountText(amounts) {
  return Object.entries(amounts).map(([unit, q]) => `${format(q)}${unit ? " " + unit : ""}`).join(" + ");
}

// Adds lines for the same thing together: [{key, name, amounts, from, items, texts}], in the order first seen.
export function combine(entries) {
  const out = new Map();
  for (const e of entries) {
    const p = parseLine(e.text);
    const key = keyOf(p.name);
    if (!key) continue;
    let line = out.get(key);
    if (!line) out.set(key, line = { key, name: p.name, amounts: {}, unsized: false, from: [], items: [], texts: [] });
    if (p.quantity === null) line.unsized = true;
    else line.amounts[p.unit] = (line.amounts[p.unit] ?? 0) + p.quantity;
    if (!line.from.includes(e.from)) line.from.push(e.from);
    if (e.item) line.items.push(e.item);
    line.texts.push(e.text);
  }
  return [...out.values()].map(({ unsized, ...l }) => ({ ...l, amount: amountText(l.amounts), walmart: walmartSearch(l.name) }));
}

const walmartSearch = name => "https://www.walmart.com/search?q=" + encodeURIComponent(name);

// ── the plan: which list and recipes the order is made from ────────────────

async function planOf(d, user) {
  const row = await d.prepare("SELECT data FROM grocery_plans WHERE user_id = ?").bind(user.id).first();
  const p = row ? JSON.parse(row.data) : {};
  return { list: p.list ?? null, recipes: Array.isArray(p.recipes) ? p.recipes : [], pantry: Array.isArray(p.pantry) ? p.pantry : DEFAULT_PANTRY };
}

async function savePlan(d, user, plan) {
  await d.prepare(`INSERT INTO grocery_plans (user_id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).bind(user.id, JSON.stringify(plan), now()).run();
}

export async function setPlan(env, user, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  const d = await db(env);
  const plan = await planOf(d, user);
  for (const [f, v] of Object.entries(body)) {
    if (f === "list") {
      if (v === null || v === "") { plan.list = null; continue; }
      if (!user.areas.has("todo")) fail("you need Drift to shop from a list");
      if (!(await writableCollections(env, user)).some(c => c.id === v)) fail("that list isn't one you can use");
      plan.list = String(v);
    } else if (f === "recipes") {
      if (!Array.isArray(v)) fail("recipes must be a list of {id, servings}");
      if (v.length > LIMITS.recipes) fail(`pick at most ${LIMITS.recipes} recipes`);
      const mine = user.areas.has("recipes") ? new Set((await recipeList(env, user)).map(r => r.id)) : new Set();
      plan.recipes = [];
      for (const r of v) {
        if (!isObj(r) || !mine.has(r.id)) fail("that recipe isn't in your Recipe box");
        const servings = r.servings == null || r.servings === "" ? null : Number(r.servings);
        if (servings !== null && !(servings > 0 && servings <= 1000)) fail("servings must be a number from 1 to 1000");
        if (!plan.recipes.some(x => x.id === r.id)) plan.recipes.push({ id: r.id, servings: servings === null ? null : Math.round(servings * 100) / 100 });
      }
    } else if (f === "pantry") {
      if (!Array.isArray(v)) fail("pantry must be a list of names");
      plan.pantry = [...new Set(v.map(keyOf).filter(Boolean))];
      if (plan.pantry.length > LIMITS.pantry) fail(`the pantry can hold at most ${LIMITS.pantry} things`);
    } else fail(`unknown field ${JSON.stringify(f)}`);
  }
  await savePlan(d, user, plan);
  return state(env, user);
}

// Says you always have something (it's left out of orders), or that you don't any more.
export async function setPantry(env, user, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  const key = keyOf(body.name);
  if (!key) fail("name what you have");
  const d = await db(env);
  const plan = await planOf(d, user);
  plan.pantry = plan.pantry.map(keyOf).filter(k => k !== key);
  if (body.have) plan.pantry.push(key);
  if (plan.pantry.length > LIMITS.pantry) fail(`the pantry can hold at most ${LIMITS.pantry} things`);
  await savePlan(d, user, plan);
  return state(env, user);
}

// The list the order is made from: the one picked, or your "Shopping list".
async function listOf(env, user, plan) {
  if (!user.areas.has("todo")) return null;
  const lists = await writableCollections(env, user);
  return lists.find(c => c.id === plan.list) ?? lists.find(c => !c.owner_name && c.name.toLowerCase() === SHOPPING.toLowerCase()) ?? null;
}

// Everything the order is made of, before it's added up: [{text, from, item?}].
async function entries(env, user, plan, list) {
  const out = [];
  if (list) {
    const drift = await driftState(env, user);
    for (const it of drift.items) {
      if (it.collection !== list.id || it.meta?.checklist?.done) continue;
      out.push({ text: it.title, from: list.name, item: it.id });
    }
  }
  if (user.areas.has("recipes") && plan.recipes.length) {
    const box = new Map((await recipeList(env, user)).map(r => [r.id, r]));
    for (const pick of plan.recipes) {
      const r = box.get(pick.id);
      if (!r) continue;
      const factor = pick.servings ? factorFor(r, { servings: pick.servings }) : 1;
      for (const line of r.ingredients) out.push({ text: scaleLine(line, factor), from: r.title });
    }
  }
  return out.slice(0, LIMITS.lines * 4);
}

async function order(env, user, d, plan) {
  const list = await listOf(env, user, plan);
  const pantry = new Set(plan.pantry.map(keyOf));
  const all = combine(await entries(env, user, plan, list)).slice(0, LIMITS.lines);
  const { results } = await d.prepare("SELECT key, data FROM grocery_matches WHERE user_id = ?").bind(user.id).all();
  const matches = new Map(results.map(r => [r.key, JSON.parse(r.data)]));
  for (const l of all) l.match = matches.get(l.key) ?? null;
  return { list, lines: all.filter(l => !pantry.has(l.key)), have: all.filter(l => pantry.has(l.key)) };
}

// ── state ──────────────────────────────────────────────────────────────────

const krogerReady = env => !!(env.KROGER_CLIENT_ID && env.KROGER_CLIENT_SECRET) && bridgeReady(env);

const toOrder = r => ({ id: r.id, store: r.store, created_at: r.created_at, ...JSON.parse(r.data) });

export async function state(env, user) {
  const d = await db(env);
  const plan = await planOf(d, user);
  const drift = user.areas.has("todo"), recipesOn = user.areas.has("recipes");
  const { list, lines, have } = await order(env, user, d, plan);
  const kroger = await d.prepare("SELECT store, modality, connected_at FROM grocery_kroger WHERE user_id = ?").bind(user.id).first();
  const { results: orders } = await d.prepare("SELECT * FROM grocery_orders WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .bind(user.id, LIMITS.orders).all();
  return {
    drift, recipes_on: recipesOn,
    lists: drift ? (await writableCollections(env, user)).map(c => ({ id: c.id, name: c.name, owner_name: c.owner_name })) : [],
    recipes: recipesOn ? (await recipeList(env, user)).map(r => ({ id: r.id, title: r.title, servings: r.servings, yield: r.yield })) : [],
    plan: { ...plan, list: list?.id ?? null }, list: list ? { id: list.id, name: list.name } : null,
    lines, have,
    kroger: {
      ready: krogerReady(env), connected: !!kroger, connected_at: kroger?.connected_at ?? null,
      store: kroger?.store ? JSON.parse(kroger.store) : null, modality: kroger?.modality ?? "PICKUP",
    },
    instacart: { ready: !!env.INSTACART_API_KEY },
    orders: orders.map(toOrder),
  };
}

// The lines to send: the order's, less any skipped.
function chosen(st, skip) {
  const out = new Set(Array.isArray(skip) ? skip.map(String) : []);
  const lines = st.lines.filter(l => !out.has(l.key));
  if (!lines.length) fail("there's nothing on the order to send");
  return lines;
}

async function record(env, user, store, lines, extra = {}) {
  const id = "o_" + hex(6), t = now();
  const data = { lines: lines.map(l => ({ key: l.key, name: l.name, amount: l.amount ?? "", ...(l.product ? { product: l.product } : {}) })), ...extra };
  const d = await db(env);
  await d.prepare("INSERT INTO grocery_orders (id, user_id, store, data, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, user.id, store, JSON.stringify(data), t).run();
  return { id, store, created_at: t, ...data };
}

// Once an order's sent, its recipes are shopped for: they're unpicked, so the next order doesn't buy them again.
async function shopped(env, user) {
  const d = await db(env);
  const plan = await planOf(d, user);
  if (plan.recipes.length) await savePlan(d, user, { ...plan, recipes: [] });
}

// Ticks the Drift items that went into an order.
async function checkOff(env, user, lines) {
  const drift = await driftState(env, user);
  const byId = new Map(drift.items.map(it => [it.id, it]));
  let n = 0;
  for (const id of lines.flatMap(l => l.items)) {
    const it = byId.get(id);
    if (!it) continue;
    await updateItem(env, user, id, { meta: { checklist: { priority: 0, ...it.meta?.checklist, done: true } } });
    n++;
  }
  return n;
}

// ── Instacart ──────────────────────────────────────────────────────────────

export async function toInstacart(env, user, request, body) {
  if (!env.INSTACART_API_KEY) throw new StoreError("Instacart isn't set up on this site yet: it needs the INSTACART_API_KEY secret.");
  if (!isObj(body)) fail("body must be a JSON object");
  const st = await state(env, user);
  const lines = chosen(st, body.skip);
  const origin = new URL(request.url).origin;
  const payload = {
    title: `Groceries from ${st.list?.name || "sintfoap.xyz"}`.slice(0, 100),
    link_type: "shopping_list",
    expires_in: 30,
    line_items: lines.map(l => {
      const measures = Object.entries(l.amounts).map(([unit, quantity]) => ({ quantity: Math.round(quantity * 100) / 100, unit: INSTACART_UNIT[unit] ?? "each" }));
      return { name: l.name, display_text: l.amount ? `${l.name} (${l.amount})` : l.name, ...(measures.length ? { line_item_measurements: measures } : {}) };
    }),
    landing_page_configuration: { partner_linkback_url: origin + "/groceries/" },
  };
  let res;
  try {
    res = await fetch((env.INSTACART_API_URL || INSTACART).replace(/\/$/, "") + "/idp/v1/products/products_link", {
      method: "POST", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${env.INSTACART_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
  } catch { throw new StoreError("Instacart couldn't be reached. Try again in a minute."); }
  const out = await res.json().catch(() => ({}));
  const url = out.products_link_url;
  if (!res.ok || typeof url !== "string" || !/^https:\/\//.test(url)) {
    console.error("instacart answered", res.status, JSON.stringify(out).slice(0, 300));
    throw new StoreError(res.status === 401 || res.status === 403 ? "Instacart didn't accept this site's API key." : "Instacart couldn't make the list right now.");
  }
  const checked = body.check_off === false ? 0 : await checkOff(env, user, lines);
  const made = await record(env, user, "instacart", lines, { url });
  await shopped(env, user);
  return { url, order: made, checked, state: await state(env, user) };
}

// ── Kroger ─────────────────────────────────────────────────────────────────

const krogerBase = env => (env.KROGER_API_URL || KROGER).replace(/\/$/, "");
const tokenContext = user => `kroger tokens\0${user.id}`;
let appToken = null;   // {token, expires}: the site's own token, for stores and products

async function tokenCall(env, form) {
  let res;
  try {
    res = await fetch(krogerBase(env) + "/v1/connect/oauth2/token", {
      method: "POST", signal: AbortSignal.timeout(15000),
      headers: { Authorization: "Basic " + btoa(`${env.KROGER_CLIENT_ID}:${env.KROGER_CLIENT_SECRET}`), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  } catch { throw new StoreError("Kroger couldn't be reached. Try again in a minute."); }
  const out = await res.json().catch(() => ({}));
  return { ok: res.ok && typeof out.access_token === "string", status: res.status, out };
}

async function siteToken(env) {
  if (!krogerReady(env)) throw new StoreError("Kroger isn't set up on this site yet: it needs the KROGER_CLIENT_ID and KROGER_CLIENT_SECRET secrets.");
  if (appToken && appToken.client === env.KROGER_CLIENT_ID && appToken.expires > Date.now() + 60000) return appToken.token;
  const r = await tokenCall(env, { grant_type: "client_credentials", scope: "product.compact" });
  if (!r.ok) throw new StoreError("Kroger didn't accept this site's app credentials.");
  appToken = { token: r.out.access_token, expires: Date.now() + (Number(r.out.expires_in) || 1800) * 1000, client: env.KROGER_CLIENT_ID };
  return appToken.token;
}

async function saveTokens(env, user, out) {
  const tokens = { access: out.access_token, refresh: out.refresh_token, expires: now() + (Number(out.expires_in) || 1800) };
  await (await db(env)).prepare(`INSERT INTO grocery_kroger (user_id, secret, store, modality, connected_at) VALUES (?, ?, NULL, 'PICKUP', ?)
    ON CONFLICT (user_id) DO UPDATE SET secret = excluded.secret`).bind(user.id, await seal(env.CHAT_BRIDGE_KEY, tokenContext(user), JSON.stringify(tokens)), now()).run();
  return tokens;
}

// Your own Kroger token, refreshed when it's run out.
async function userToken(env, user) {
  if (!krogerReady(env)) throw new StoreError("Kroger isn't set up on this site yet.");
  const row = await (await db(env)).prepare("SELECT secret FROM grocery_kroger WHERE user_id = ?").bind(user.id).first();
  const opened = row && await unseal(env.CHAT_BRIDGE_KEY, tokenContext(user), row.secret);
  if (!opened) fail("connect your Kroger account first");
  let tokens = JSON.parse(opened);
  if (tokens.expires > now() + 60) return tokens.access;
  if (!tokens.refresh) fail("your Kroger sign-in ran out: connect your Kroger account again");
  const r = await tokenCall(env, { grant_type: "refresh_token", refresh_token: tokens.refresh });
  if (!r.ok) fail("your Kroger sign-in ran out: connect your Kroger account again");
  tokens = await saveTokens(env, user, { refresh_token: tokens.refresh, ...r.out });
  return tokens.access;
}

async function krogerGet(env, path, token) {
  let res;
  try { res = await fetch(krogerBase(env) + path, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(15000) }); }
  catch { throw new StoreError("Kroger couldn't be reached. Try again in a minute."); }
  if (!res.ok) throw new StoreError(`Kroger couldn't answer that right now (it said ${res.status}).`);
  return res.json().catch(() => ({}));
}

const toStore = l => ({
  id: String(l.locationId), name: text(l.name, 100), chain: text(l.chain, 50),
  address: text([l.address?.addressLine1, l.address?.city, [l.address?.state, l.address?.zipCode].filter(Boolean).join(" ")].filter(Boolean).join(", "), 200),
});

export async function stores(env, zip) {
  if (!/^\d{5}$/.test(String(zip ?? ""))) fail("give a 5-digit ZIP code");
  const out = await krogerGet(env, `/v1/locations?filter.zipCode.near=${zip}&filter.limit=10`, await siteToken(env));
  return { stores: (Array.isArray(out.data) ? out.data : []).filter(l => l?.locationId).map(toStore) };
}

export async function setStore(env, user, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  const d = await db(env);
  const row = await d.prepare("SELECT store, modality FROM grocery_kroger WHERE user_id = ?").bind(user.id).first();
  if (!row) fail("connect your Kroger account first");
  let store = row.store, modality = row.modality;
  if (body.id !== undefined) {
    const id = String(body.id);
    if (!/^[0-9A-Za-z]{1,20}$/.test(id)) fail("that isn't a Kroger store");
    const out = await krogerGet(env, `/v1/locations/${id}`, await siteToken(env));
    if (!out.data?.locationId) fail("Kroger doesn't know that store");
    store = JSON.stringify(toStore(out.data));
  }
  if (body.modality !== undefined) {
    if (!MODALITIES.includes(body.modality)) fail(`modality must be ${MODALITIES.join(" or ")}`);
    modality = body.modality;
  }
  await d.prepare("UPDATE grocery_kroger SET store = ?, modality = ? WHERE user_id = ?").bind(store, modality, user.id).run();
  return state(env, user);
}

export async function disconnect(env, user) {
  await (await db(env)).prepare("DELETE FROM grocery_kroger WHERE user_id = ?").bind(user.id).run();
  return state(env, user);
}

// A product as the order keeps it.
function toProduct(p) {
  const item = Array.isArray(p.items) ? p.items[0] ?? {} : {};
  const front = (p.images ?? []).find(i => i.perspective === "front") ?? (p.images ?? [])[0];
  const pic = (front?.sizes ?? []).find(s => s.size === "thumbnail") ?? (front?.sizes ?? [])[0];
  const price = item.price?.promo || item.price?.regular;
  return {
    upc: String(p.upc || p.productId || ""), description: text(p.description, 200), brand: text(p.brand, 80), size: text(item.size, 60),
    price: Number.isFinite(price) && price > 0 ? price : null, image: typeof pic?.url === "string" && /^https:\/\//.test(pic.url) ? pic.url : "",
  };
}

async function search(env, user, term, limit = 5) {
  const row = await (await db(env)).prepare("SELECT store FROM grocery_kroger WHERE user_id = ?").bind(user.id).first();
  const store = row?.store ? JSON.parse(row.store) : null;
  if (!store) fail("pick your Kroger store first");
  const q = text(term, 100);
  if (q.length < 2) fail("search for at least two letters");
  const out = await krogerGet(env, `/v1/products?filter.term=${encodeURIComponent(q)}&filter.locationId=${encodeURIComponent(store.id)}&filter.limit=${limit}`, await siteToken(env));
  return (Array.isArray(out.data) ? out.data : []).map(toProduct).filter(p => /^\d{6,14}$/.test(p.upc));
}

export async function searchProducts(env, user, q) {
  return { choices: await search(env, user, q, 10) };
}

// A product at your store for each line: the one you sent last time, or the best Kroger finds.
export async function match(env, user) {
  const st = await state(env, user);
  if (!st.kroger.connected) fail("connect your Kroger account first");
  if (!st.kroger.store) fail("pick your Kroger store first");
  const matches = {};
  const todo = st.lines.filter(l => !l.match).slice(0, LIMITS.match);
  for (const l of st.lines) if (l.match) matches[l.key] = { match: l.match, choices: [], remembered: true };
  for (let i = 0; i < todo.length; i += 5) {
    await Promise.all(todo.slice(i, i + 5).map(async l => {
      const choices = await search(env, user, l.name).catch(e => { if (e instanceof StoreError) return []; throw e; });
      matches[l.key] = { match: choices[0] ?? null, choices, remembered: false };
    }));
  }
  return { matches };
}

function cleanProduct(body) {
  if (!isObj(body)) fail("body must be a JSON object");
  const upc = String(body.upc ?? "");
  if (!/^\d{6,14}$/.test(upc)) fail("that isn't a product code");
  const price = Number(body.price);
  return { upc, description: text(body.description, 200) || upc, brand: text(body.brand, 80), size: text(body.size, 60),
    price: Number.isFinite(price) && price > 0 ? price : null, image: /^https:\/\//.test(String(body.image ?? "")) ? text(body.image, 500) : "" };
}

async function remember(d, user, key, product) {
  await d.prepare(`INSERT INTO grocery_matches (user_id, key, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).bind(user.id, key, JSON.stringify(product), now()).run();
}

export async function setMatch(env, user, key, body) {
  if (!KEY.test(key)) return null;
  const product = cleanProduct(body);
  await remember(await db(env), user, key, product);
  return { key, match: product };
}

export async function forgetMatch(env, user, key) {
  if (!KEY.test(key)) return null;
  await (await db(env)).prepare("DELETE FROM grocery_matches WHERE user_id = ? AND key = ?").bind(user.id, key).run();
  return { removed: true };
}

// Puts the products into your Kroger cart, and remembers each one for that line.
export async function toKroger(env, user, body) {
  if (!isObj(body) || !Array.isArray(body.lines)) fail("send the lines to add as {lines: [{key, upc, quantity}]}");
  const st = await state(env, user);
  if (!st.kroger.connected) fail("connect your Kroger account first");
  if (!st.kroger.store) fail("pick your Kroger store first");
  const byKey = new Map(st.lines.map(l => [l.key, l]));
  const picks = [];
  for (const raw of body.lines.slice(0, LIMITS.lines)) {
    const line = isObj(raw) && byKey.get(String(raw.key));
    if (!line) fail("a line isn't on your order any more: refresh and try again");
    const product = cleanProduct(raw.product ?? { ...line.match, upc: raw.upc });
    const quantity = Number(raw.quantity ?? 1);
    if (!(Number.isInteger(quantity) && quantity >= 1 && quantity <= 50)) fail("quantities are whole numbers from 1 to 50");
    picks.push({ line, product, quantity });
  }
  if (!picks.length) fail("there's nothing on the order to send");
  const token = await userToken(env, user);
  let res;
  try {
    res = await fetch(krogerBase(env) + "/v1/cart/add", {
      method: "PUT", signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ items: picks.map(p => ({ upc: p.product.upc, quantity: p.quantity, modality: st.kroger.modality })) }),
    });
  } catch { throw new StoreError("Kroger couldn't be reached. Try again in a minute."); }
  if (res.status === 401) fail("your Kroger sign-in ran out: connect your Kroger account again");
  if (!res.ok) throw new StoreError(`Kroger didn't take the order (it said ${res.status}).`);
  const d = await db(env);
  for (const p of picks) await remember(d, user, p.line.key, p.product);
  const lines = picks.map(p => ({ ...p.line, product: { ...p.product, quantity: p.quantity } }));
  const checked = body.check_off === false ? 0 : await checkOff(env, user, lines);
  await shopped(env, user);
  const made = await record(env, user, "kroger", lines, { place: st.kroger.store.name, modality: st.kroger.modality });
  return { added: picks.length, checked, order: made, state: await state(env, user) };
}

// Off to Kroger to sign in, and back.
async function connect(env, user, request) {
  if (!krogerReady(env)) return Response.redirect(new URL("/groceries/?kroger=unready", request.url).toString(), 302);
  const d = await db(env), s = randomToken(24);
  await d.prepare("DELETE FROM grocery_oauth WHERE created_at < ?").bind(now() - 600).run();
  await d.prepare("INSERT INTO grocery_oauth (state, user_id, created_at) VALUES (?, ?, ?)").bind(s, user.id, now()).run();
  const to = new URL(krogerBase(env) + "/v1/connect/oauth2/authorize");
  to.search = new URLSearchParams({ scope: SCOPES, response_type: "code", client_id: env.KROGER_CLIENT_ID,
    redirect_uri: new URL("/groceries/kroger/callback", request.url).toString(), state: s }).toString();
  return Response.redirect(to.toString(), 302);
}

async function callback(env, user, request) {
  const url = new URL(request.url);
  const back = what => Response.redirect(new URL(`/groceries/?kroger=${what}`, request.url).toString(), 302);
  const s = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "";
  const d = await db(env);
  const row = await d.prepare("SELECT user_id, created_at FROM grocery_oauth WHERE state = ?").bind(s).first();
  if (row) await d.prepare("DELETE FROM grocery_oauth WHERE state = ?").bind(s).run();
  if (!row || row.user_id !== user.id || row.created_at < now() - 600) return back("expired");
  if (!code) return back("declined");
  const r = await tokenCall(env, { grant_type: "authorization_code", code, redirect_uri: new URL("/groceries/kroger/callback", request.url).toString() });
  if (!r.ok) return back("failed");
  await saveTokens(env, user, r.out);
  return back("connected");
}

// ── routes ─────────────────────────────────────────────────────────────────

// Product pictures come from Kroger's image server.
const PAGE_CSP = [
  "default-src 'none'", "script-src 'self'", "connect-src 'self'", "manifest-src 'self'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com", "img-src 'self' data: https:",
  "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function groceries(request, env, user, pathname) {
  const method = request.method;
  if (pathname === "/groceries/kroger/connect" || pathname === "/groceries/kroger/callback") {
    if (method !== "GET") return json({ error: "method not allowed" }, 405);
    return pathname.endsWith("connect") ? connect(env, user, request) : callback(env, user, request);
  }
  if (!pathname.startsWith("/groceries/api/")) {
    const asset = await withRail(await env.ASSETS.fetch(request), user, "groceries");
    const res = new Response(asset.body, asset);
    if ((res.headers.get("Content-Type") || "").startsWith("text/html")) {
      res.headers.set("Content-Security-Policy", PAGE_CSP);
      res.headers.set("X-Content-Type-Options", "nosniff");
      res.headers.set("Referrer-Policy", "no-referrer");
    }
    return res;
  }
  try {
    if (method !== "GET" && !sameOrigin(request)) return json({ error: "cross-origin request refused" }, 403);
    const m = pathname.match(ROUTE);
    if (!m) return json({ error: "not found" }, 404);
    const [, kind, raw] = m;
    const sub = raw ? decodeURIComponent(raw) : "";
    const q = new URL(request.url).searchParams;
    const notAllowed = () => json({ error: "method not allowed" }, 405);
    const one = (want, fn) => method === want ? fn() : notAllowed();
    if (kind === "matches") {
      if (!sub) return json({ error: "not found" }, 404);
      const out = method === "PUT" ? await setMatch(env, user, sub, await readJson(request))
        : method === "DELETE" ? await forgetMatch(env, user, sub) : undefined;
      if (out === undefined) return notAllowed();
      return out ? json(out) : json({ error: "not found" }, 404);
    }
    if (kind === "kroger") {
      switch (sub) {
        case "": return await one("DELETE", async () => json(await disconnect(env, user)));
        case "stores": return await one("GET", async () => json(await stores(env, q.get("zip"))));
        case "store": return await one("PUT", async () => json(await setStore(env, user, await readJson(request))));
        case "match": return await one("POST", async () => json(await match(env, user)));
        case "search": return await one("GET", async () => json(await searchProducts(env, user, q.get("q"))));
        case "cart": return await one("POST", async () => json(await toKroger(env, user, await readJson(request))));
        default: return json({ error: "not found" }, 404);
      }
    }
    if (sub) return json({ error: "not found" }, 404);
    switch (kind) {
      case "state": return await one("GET", async () => json(await state(env, user)));
      case "plan": return await one("PUT", async () => json(await setPlan(env, user, await readJson(request))));
      case "pantry": return await one("PUT", async () => json(await setPantry(env, user, await readJson(request))));
      case "instacart": return await one("POST", async () => json(await toInstacart(env, user, request, await readJson(request))));
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    if (e instanceof StoreError) return json({ error: e.message }, 503);
    console.error("groceries error:", e);
    return json({ error: "server error" }, 500);
  }
}
