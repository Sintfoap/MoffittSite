// Meal plan: a week of dinners picked from your Recipe box, fitted around
// your Drift calendar. A night with something on in the evening (or a packed
// day) gets a quick recipe; the week's ingredients, scaled to each night's
// servings, go onto a Drift list in one go.
//
// A week is stored per account under its Monday. Each night has a recipe (or
// none), the servings to cook, whether you're out that night (nothing to
// cook), and whether it's locked (filling the week leaves it alone).
//
// /meals/api/week?start=<day>               GET → the week holding that day (this week without it)
// /meals/api/week/<monday>/<day>            PUT {recipe?, servings?, out?, locked?} → the week
// /meals/api/week/<monday>/fill             POST {redo?} → recipes for the empty nights (redo: every unlocked night)
// /meals/api/week/<monday>/shop             POST {lines?, list?} → the week's ingredients onto a Drift list
// /meals/api/tonight                        GET → tonight's dinner {id, title, time, out} or {} (Drift's Today shows it)
//
// Only recipes labeled as dinners (a label value like Dinner or Main) are
// planned, when any are; nights on a Trip planner trip are left out as away;
// the week's Food club pick is offered for a night; and the shopping leaves
// out nights already past, adds the same ingredient up into one line and files
// each line under its part of the shop (src/shopping.js).

import { db } from "./db.js";
import { sameOrigin } from "./account.js";
import { withRail } from "./pages.js";
import { readJson, BadRequest, state, visitorNow, writableCollections, addToList } from "./drift.js";
import { list as allRecipes, timeText } from "./recipes.js";
import { scaleLine, factorFor } from "../public/recipes/scale.js";
import { arrange } from "./shopping.js";
import { listPicks } from "./food.js";
import { listTrips } from "./trips.js";

const fail = msg => { throw new BadRequest(msg); };
const isObj = v => v && typeof v === "object" && !Array.isArray(v);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ROUTE = /^\/meals\/api\/week(?:\/(\d{4}-\d{2}-\d{2})(?:\/(fill|shop|\d{4}-\d{2}-\d{2}))?)?\/?$/;
const WEEKS_KEPT = 104;                     // older weeks are dropped as new ones are planned
export const QUICK = 30;                    // minutes: what counts as a quick meal
const EVENING = ["16:00", "21:00"];         // something on in this window makes a night busy
const FULL_DAY = 3;                         // or this many timed things that day
const NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const NIGHT = { recipe: null, servings: null, out: false, locked: false };

// ── dates ──────────────────────────────────────────────────────────────────

const toDate = s => new Date(s + "T00:00:00Z");
const fromDate = d => d.toISOString().slice(0, 10);
export const addDays = (s, n) => fromDate(new Date(toDate(s).getTime() + n * 864e5));
function realDay(s) {
  return DAY.test(s) && fromDate(toDate(s)) === s;
}
// The Monday on or before a day.
export function mondayOf(s) {
  if (!realDay(s)) fail("dates are YYYY-MM-DD");
  return addDays(s, -((toDate(s).getUTCDay() + 6) % 7));
}
const weekDays = monday => NAMES.map((_, i) => addDays(monday, i));

// ── how long a recipe takes, and how busy a night is ───────────────────────

// "1 hr 5 min", "45 mins", "1½ hours", "PT20M", "45" → minutes, or null when it doesn't say.
export function minutesOf(time) {
  if (/^\s*\d+(?:\.\d+)?\s*$/.test(String(time ?? ""))) return Math.round(Number(time)) || null;   // a bare number is minutes
  const s = String(time ?? "").toLowerCase().replace(/½/g, ".5").replace(/¼/g, ".25").replace(/¾/g, ".75");
  const iso = s.trim().match(/^p(?:(\d+)d)?(?:t(?:(\d+)h)?(?:(\d+)m)?)?$/);
  if (iso) return ((+iso[1] || 0) * 24 + (+iso[2] || 0)) * 60 + (+iso[3] || 0) || null;
  let total = 0, any = false;
  for (const [, n, unit] of s.matchAll(/(\d*\.?\d+)\s*(h(?:ou)?rs?|h\b|min(?:ute)?s?|m\b)/g)) {
    total += Number(n) * (unit.startsWith("h") ? 60 : 1);
    any = true;
  }
  return any && total > 0 ? Math.round(total) : null;
}
export const isQuick = r => { const m = minutesOf(r.time); return m != null && m <= QUICK; };

// "18:30" → "6:30 pm".
const clock = t => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "am" : "pm"}`; };

// What's on each day of the week, from the open dated items in every Drift
// collection you can see, and whether that makes it a busy night.
export function nightsOut(items, days) {
  const out = Object.fromEntries(days.map(d => [d, { busy: false, why: "", events: [] }]));
  for (const it of items) {
    const ev = it.meta?.event;
    if (!ev?.start || it.meta.checklist?.done || it.deleted) continue;
    const first = ev.start.slice(0, 10), last = (ev.end || ev.start).slice(0, 10);
    for (const d of days) {
      if (d < first || d > last) continue;
      const timed = ev.start.includes("T") && first === d;
      out[d].events.push({ title: it.title, time: timed ? ev.start.slice(11, 16) : "", end: timed && ev.end?.slice(0, 10) === d ? ev.end.slice(11, 16) : "" });
    }
  }
  for (const d of days) {
    const day = out[d];
    day.events.sort((a, b) => (a.time ? 1 : 0) - (b.time ? 1 : 0) || a.time.localeCompare(b.time));
    const timed = day.events.filter(e => e.time);
    // An event with no end is taken to last an hour.
    const hourLater = t => `${String(Math.min(23, +t.slice(0, 2) + 1)).padStart(2, "0")}:${t.slice(3)}`;
    const evening = timed.find(e => e.time < EVENING[1] && (e.end || hourLater(e.time)) > EVENING[0]);
    if (evening) Object.assign(day, { busy: true, why: `${evening.title} at ${clock(evening.time)}` });
    else if (timed.length >= FULL_DAY) Object.assign(day, { busy: true, why: `${timed.length} things on` });
  }
  return out;
}

// ── picking recipes ────────────────────────────────────────────────────────

// A recipe is a dinner when one of its labels says so (Course: Dinner, Meal: Main…).
const DINNER = /^(?:dinners?|suppers?|mains?|main (?:course|dish)e?s?|entr[ée]es?)$/i;
export const isDinner = r => (r.labels || []).some(l => DINNER.test(String(l.value || "").trim()) || (!l.value && DINNER.test(String(l.key || "").trim())));
// What filling the week picks from: the dinners, or every recipe when none is labeled one.
export function dinnersOf(recipes) {
  const d = recipes.filter(isDinner);
  return d.length ? d : recipes;
}

const pickOne = list => list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];

// Fills the nights that need a recipe. Busy nights get a quick one (the
// quickest there is, when none are quick); no recipe twice in a week while
// there are others to choose, and last week's dinners only when nothing else is left.
export function fillWeek(nights, days, busy, recipes, lastWeek = new Set(), redo = false) {
  const out = structuredClone(nights);
  const ids = new Set(recipes.map(r => r.id));
  const needs = d => !out[d].out && !out[d].locked && !busy[d]?.away && (redo || !ids.has(out[d].recipe));
  const used = new Set(days.filter(d => !needs(d) && out[d].recipe).map(d => out[d].recipe));
  // Busy nights first, so the quick recipes go to them.
  for (const d of [...days.filter(d => busy[d]?.busy), ...days.filter(d => !busy[d]?.busy)]) {
    if (!needs(d)) continue;
    let pool = recipes;
    if (busy[d]?.busy) {
      const quick = recipes.filter(isQuick);
      if (quick.length) pool = quick;
      else {
        const timed = recipes.filter(r => minutesOf(r.time) != null);
        if (timed.length) { const least = Math.min(...timed.map(r => minutesOf(r.time))); pool = timed.filter(r => minutesOf(r.time) === least); }
      }
    }
    const fresh = pool.filter(r => !used.has(r.id));
    const choices = [fresh.filter(r => !lastWeek.has(r.id)), fresh, pool].find(c => c.length);
    if (!choices) { out[d].recipe = null; out[d].servings = null; continue; }
    const r = pickOne(choices);
    used.add(r.id);
    out[d].recipe = r.id;
    out[d].servings = r.servings ?? null;
  }
  return out;
}

// ── storage ────────────────────────────────────────────────────────────────

async function loadNights(d, owner, monday) {
  const row = await d.prepare("SELECT data FROM meal_plans WHERE owner = ? AND week = ?").bind(owner, monday).first();
  const saved = row ? JSON.parse(row.data) : {};
  return {
    nights: Object.fromEntries(weekDays(monday).map(day => [day, { ...NIGHT, ...(saved.nights?.[day] || {}) }])),
    shopped: saved.shopped || null,
  };
}

// Tonight's dinner, for the dashboard and Drift's Today: {id, title, time} from
// Recipe box, {out: true}, or null when nothing's planned.
export async function tonight(env, user, day) {
  const d = await db(env);
  const n = (await loadNights(d, user.id, mondayOf(day))).nights[day];
  if (!n) return null;
  if (n.out) return { out: true };
  if (!n.recipe) return null;
  const row = await d.prepare("SELECT data FROM recipes WHERE owner = ? AND id = ?").bind(user.id, n.recipe).first();
  if (!row) return null;
  const r = JSON.parse(row.data);
  return { id: n.recipe, title: r.title, time: timeText(r.time) };
}

async function saveNights(d, owner, monday, plan) {
  await d.prepare(`INSERT INTO meal_plans (owner, week, data, updated) VALUES (?, ?, ?, ?)
    ON CONFLICT (owner, week) DO UPDATE SET data = excluded.data, updated = excluded.updated`)
    .bind(owner, monday, JSON.stringify(plan), new Date().toISOString()).run();
  await d.prepare(`DELETE FROM meal_plans WHERE owner = ? AND week NOT IN
    (SELECT week FROM meal_plans WHERE owner = ? ORDER BY week DESC LIMIT ${WEEKS_KEPT})`).bind(owner, owner).run();
}

async function calendar(env, user, days) {
  const cal = user.areas.has("todo") ? nightsOut((await state(env, user)).items, days) : null;
  if (!user.areas.has("trips")) return cal;
  // A night on a trip is away: nothing to cook at home.
  const trips = (await listTrips(env, user)).filter(t => t.start && t.start <= days[6] && (t.end || t.start) >= days[0]);
  if (!trips.length) return cal;
  const out = cal || Object.fromEntries(days.map(d => [d, { busy: false, why: "", events: [] }]));
  for (const d of days) {
    const t = trips.find(t => t.start <= d && (t.end || t.start) >= d);
    if (t) out[d].away = t.title;
  }
  return out;
}

// The week's shopping: every planned recipe's ingredients, scaled to that
// night's servings, from `today` on (nights already past are bought for). The
// same ingredient from two recipes is added up into one line, and the lines
// come filed by aisle (src/shopping.js): [{line, for, aisle, staple}].
export function shoppingFor(nights, days, byId, today = "") {
  const lines = new Map();
  for (const [i, d] of days.entries()) {
    const n = nights[d], r = byId.get(n.recipe);
    if (!r || n.out || d < today) continue;
    const f = factorFor(r, { servings: n.servings });
    for (const raw of r.ingredients) {
      const line = scaleLine(raw, f).slice(0, 500);
      const key = line.toLowerCase();
      if (!lines.has(key)) lines.set(key, { line, for: [] });
      const tag = `${r.title} (${NAMES[i]})`;
      if (!lines.get(key).for.includes(tag)) lines.get(key).for.push(tag);
    }
  }
  return arrange([...lines.values()]);
}

// The Food club pick for the month a week is in, when there is one: {id, title,
// month, recipe (your Recipe box's copy, matched by title, or null), made, planned}.
async function clubPick(env, user, month, nights) {
  if (!user.areas.has("food")) return null;
  const pick = (await listPicks(env, user)).find(p => p.month === month);
  if (!pick) return null;
  const mine = (await allRecipes(env, user)).find(r => r.title.trim().toLowerCase() === pick.title.trim().toLowerCase());
  return { id: pick.id, title: pick.title, month: pick.month, recipe: mine?.id || null, made: pick.mine.made,
    planned: Boolean(mine && Object.values(nights).some(n => n.recipe === mine.id && !n.out)) };
}

// Everything the page shows for a week.
async function week(env, user, monday, plan, today = "") {
  const d = await db(env);
  plan ??= await loadNights(d, user.id, monday);
  const days = weekDays(monday);
  const recipes = await allRecipes(env, user);
  const byId = new Map(recipes.map(r => [r.id, r]));
  const cal = await calendar(env, user, days);
  const drift = Boolean(cal);
  return {
    start: monday,
    prev: addDays(monday, -7), next: addDays(monday, 7),
    days: days.map((day, i) => {
      const n = plan.nights[day], r = byId.get(n.recipe);
      return {
        day, name: NAMES[i], ...(cal?.[day] || { busy: false, why: "", events: [] }),
        recipe: r ? r.id : null, servings: r ? n.servings ?? r.servings ?? null : null, out: n.out, locked: n.locked,
        // A busy night with a recipe that isn't quick: worth a second look.
        slow: Boolean(r && cal?.[day]?.busy && !n.out && !isQuick(r)),
        away: cal?.[day]?.away || "", past: Boolean(today && day < today),
      };
    }),
    recipes: recipes.map(r => ({ id: r.id, title: r.title, time: r.time, minutes: minutesOf(r.time), quick: isQuick(r), servings: r.servings, dinner: isDinner(r) })),
    shopping: shoppingFor(plan.nights, days, byId, today),
    today,
    club: await clubPick(env, user, (today && days.includes(today) ? today : monday).slice(0, 7), plan.nights).catch(() => null),
    shopped: plan.shopped,
    quick: QUICK,
    drift,
    recipe_box: user.areas.has("recipes"),
    lists: drift ? await writableCollections(env, user) : [],
  };
}

function cleanNight(body, recipes) {
  if (!isObj(body)) fail("body must be a JSON object");
  const out = {};
  for (const [f, v] of Object.entries(body)) {
    switch (f) {
      case "recipe":
        if (v === null || v === "") { out.recipe = null; out.servings = null; break; }
        if (!recipes.some(r => r.id === v)) fail("that recipe isn't in your Recipe box");
        out.recipe = String(v);
        if (!("servings" in body)) out.servings = recipes.find(r => r.id === v).servings ?? null;
        break;
      case "servings": {
        if (v === null || v === "") { out.servings = null; break; }
        const n = Number(v);
        if (!(n > 0 && n <= 1000)) fail("servings must be a number from 1 to 1000");
        out.servings = Math.round(n * 100) / 100;
        break;
      }
      case "out": out.out = Boolean(v); break;
      case "locked": out.locked = Boolean(v); break;
      default: fail(`unknown field ${JSON.stringify(f)}`);
    }
  }
  return out;
}

export async function setNight(env, user, monday, day, body, today = "") {
  if (!weekDays(monday).includes(day)) fail("that day isn't in this week");
  const d = await db(env);
  const plan = await loadNights(d, user.id, monday);
  const change = cleanNight(body, await allRecipes(env, user));
  plan.nights[day] = { ...plan.nights[day], ...change };
  // Choosing a recipe yourself keeps it when the week is filled again.
  if (change.recipe) plan.nights[day].locked = body.locked ?? true;
  await saveNights(d, user.id, monday, plan);
  return week(env, user, monday, plan, today);
}

export async function fill(env, user, monday, body, today = "") {
  if (!isObj(body)) fail("body must be a JSON object");
  const d = await db(env);
  const plan = await loadNights(d, user.id, monday);
  const recipes = await allRecipes(env, user);
  if (!recipes.length) fail("add some recipes to your Recipe box first");
  const days = weekDays(monday);
  const last = await loadNights(d, user.id, addDays(monday, -7));
  const lastWeek = new Set(Object.values(last.nights).map(n => n.recipe).filter(Boolean));
  // Nights already past are left as they were.
  const ahead = days.filter(day => !today || day >= today);
  plan.nights = fillWeek(plan.nights, ahead.length ? ahead : days, (await calendar(env, user, days)) || {}, dinnersOf(recipes), lastWeek, Boolean(body.redo));
  await saveNights(d, user.id, monday, plan);
  return week(env, user, monday, plan, today);
}

// The week's ingredients onto a Drift list. `lines` picks which (by their
// place in the week's shopping); without it, all of them.
export async function shop(env, user, monday, body, today = "") {
  if (!user.areas.has("todo")) fail("you need Drift to make a shopping list");
  if (!isObj(body)) fail("body must be a JSON object");
  const d = await db(env);
  const plan = await loadNights(d, user.id, monday);
  const recipes = await allRecipes(env, user);
  const all = shoppingFor(plan.nights, weekDays(monday), new Map(recipes.map(r => [r.id, r])), today);
  if (!all.length) fail("plan some dinners first");
  const pick = Array.isArray(body.lines) ? new Set(body.lines.map(Number)) : null;
  const chosen = all.filter((_, i) => !pick || pick.has(i));
  if (!chosen.length) fail("pick at least one thing to buy");
  const out = await addToList(env, user, body.list ? String(body.list) : null, chosen.map(c => c.line), chosen.map(c => `For ${c.for.join(", ")}`));
  plan.shopped = { at: new Date().toISOString().slice(0, 19), list: out.list.name, added: out.added };
  await saveNights(d, user.id, monday, plan);
  return { ...out, shopped: plan.shopped };
}

// ── the page and its API ───────────────────────────────────────────────────

const PAGE_CSP = [
  "default-src 'none'", "script-src 'self'", "connect-src 'self'", "manifest-src 'self'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com", "img-src 'self' data:",
  "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function meals(request, env, user, pathname) {
  if (!pathname.startsWith("/meals/api/")) {
    const asset = await withRail(await env.ASSETS.fetch(request), user, "meals");
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
    const today = visitorNow(request).day;
    if (/^\/meals\/api\/tonight\/?$/.test(pathname)) {
      if (method !== "GET") return json({ error: "method not allowed" }, 405);
      return json((await tonight(env, user, new URL(request.url).searchParams.get("day") || today)) || {});
    }
    const m = pathname.match(ROUTE);
    if (!m) return json({ error: "not found" }, 404);
    const [, start, sub] = m;
    const notAllowed = () => json({ error: "method not allowed" }, 405);
    if (!start) {
      if (method !== "GET") return notAllowed();
      const asked = new URL(request.url).searchParams.get("start");
      return json(await week(env, user, mondayOf(asked || today), undefined, today));
    }
    if (mondayOf(start) !== start) fail("a week starts on a Monday");
    if (!sub) return method === "GET" ? json(await week(env, user, start, undefined, today)) : notAllowed();
    if (sub === "fill") return method === "POST" ? json(await fill(env, user, start, await readJson(request), today)) : notAllowed();
    if (sub === "shop") return method === "POST" ? json(await shop(env, user, start, await readJson(request), today)) : notAllowed();
    if (!realDay(sub)) return json({ error: "not found" }, 404);
    return method === "PUT" ? json(await setNight(env, user, start, sub, await readJson(request), today)) : notAllowed();
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    console.error("meals error:", e);
    return json({ error: "server error" }, 500);
  }
}
