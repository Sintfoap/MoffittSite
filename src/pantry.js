// Pantry: the food each person has, in real amounts, kept in step with the
// shelf. One pantry per person, like Recipe box.
//
// Every item is one of three kinds, which decides how it's counted and used up:
//   measured  flour, sugar, oil: an exact measure (grams or millilitres underneath,
//             shown in the unit you typed)
//   counted   cans, eggs, boxes: whole units. Using any of one uses all of it
//             (an egg white is still an egg; half a can is still the can)
//   gauged    spices, vanilla: a level from Full to Empty that you slide down yourself
// Any of them can also be a staple: something you keep stocked, with a low point
// you set (an amount, a count, or a level like ½ left). A staple at or under its
// low point is running low, and goes on the shopping list. Items saved before
// staple was a tag were kind "staple", and read as measured staples; "staple" is
// still taken as a kind, meaning the same.
// A measured or counted item holds lots: one per purchase, each with its own
// amount and expiry date, used oldest-expiry first. Units, plurals and the
// first guess at an item's kind are public/pantry/units.js, shared with the page.
//
// Receipts fill it (src/pantry_receipt.js), and so does the phone scanner app with
// barcodes and expiry dates (src/pantry_scanner.js, scanner/). Taking from it for
// recipes on a shopping list comes next (the Pantry plan doc).
//
// /pantry/api/items                  GET ?day=YYYY-MM-DD → {items, places, counts, limits}
//                                    POST {name, kind?, staple?, place?, amount?, expires?, low?, unit?, size?, level?, per_cup?, words?} → the new item
//                                      (kind, place, unit and grams per cup are guessed from the name when left out)
// /pantry/api/items/<id>             PATCH {name?, place?, words?, staple?, low?, per_cup?, unit?, size?, shows?, level?, expires?, kind?, amount?} → the item
//                                      (changing kind needs the amount you have now, in the new kind's terms); DELETE → gone
// /pantry/api/items/<id>/lots        POST {amount, expires?} → the item, with another purchase of it
// /pantry/api/items/<id>/lots/<lot>  PATCH {amount?, expires?} → the item; DELETE → the item without that lot
// /pantry/api/items/<id>/use         POST {amount} (measured: "1 cup"; counted: how many) or {all: true}, and {tossed?: true};
//                                      or {level} for a gauged item → the item, with that taken out
// /pantry/api/shares                 GET → {shares: who yours is shared with, shared: pantries shared with you};
//                                      PUT {username, role} shares yours ("use" or "stock") or changes their role
// /pantry/api/shares/<username>      DELETE: stop sharing yours with them → {shares, shared}
// /pantry/api/shared/<username>      DELETE: leave theirs → {shares, shared}
//   Any items route takes ?of=<username> to work on a pantry shared with you: "use" can see it and
//   take things out, "stock" can also add purchases (receipts, barcodes, + More). Only its owner
//   changes items, their kinds and low points, or who it's shared with.
// /pantry/api/key                    PUT {key} → {photo}; DELETE → {photo}: the Anthropic key receipts are read with (Sweep's and Recipe box's too)
// /pantry/api/receipt                POST {images} → what a receipt adds, to check; /pantry/api/receipt/add POST {store, lines} adds it (src/pantry_receipt.js)
// /pantry/api/add                    POST {store?, lines}: the same, for lines not from a receipt (the scanner's barcodes)
// /pantry/api/barcode/<digits>       GET → what a barcode is, and what it would add
// /pantry/api/scanners[/<id>]        GET the paired phones, POST a pairing code, DELETE unpairs one (src/pantry_scanner.js)
// /pantry/scanner/pair, /pantry/scanner/latest.json   the app's pairing (no session), and its newest release (and the iPhone app's link)
//   Lots record where their expiry date came from: by is "typed", "estimated" (from how long such things keep) or "scanned".

import { db } from "./db.js";
import { sameOrigin } from "./account.js";
import { withRail } from "./pages.js";
import { readJson, BadRequest } from "./drift.js";
import { readPhotoBody, photoState, saveKey, forgetKey } from "./recipe_photo.js";
import { readReceipt, addReceipt } from "./pantry_receipt.js";
import { latestOf } from "./phone.js";
import { startPairing, finishPairing, listScanners, unpair, scannerUser, lookUp } from "./pantry_scanner.js";
import { UNITS, ML_PER_CUP, LEVELS, readAmount, inUnit, unitsOf, plural, singular, counted, guess } from "../public/pantry/units.js";

const fail = msg => { throw new BadRequest(msg); };
export const LIMITS = { items: 500, lots: 50, name: 80, place: 30, words: 200, unit: 20, size: 40, count: 10000, base: 1e8 };
export const KINDS = ["measured", "counted", "gauged"];
export const PLACES = ["Fridge", "Freezer", "Cupboard", "Spice rack"];
const SOON_DAYS = 5;
const ID = /^i_[0-9a-f]{10}$/;
export const SCANNER_TAG = /^scanner-v(\d{1,6})$/;
export const SCANNER_APK = "pantry-scanner.apk";
// The iPhone scanner's TestFlight (or App Store) link, if there is one.
const iosScanner = env => /^https:\/\/(testflight|apps)\.apple\.com\/[\w/.-]+$/.test(env.SCANNER_IOS_URL || "") ? env.SCANNER_IOS_URL : null;
const ROUTE = /^\/pantry\/api\/(?:key|add|(?:shares|shared)(?:\/[a-z0-9][a-z0-9_-]{2,31})?|receipt(?:\/add)?|scanners(?:\/[0-9a-f]{16})?|barcode\/\d{6,14}|items(?:\/(i_[0-9a-f]{10})(?:\/(use|lots)(?:\/(t_[0-9a-f]{8}))?)?)?)\/?$/;
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const today = () => new Date().toISOString().slice(0, 10);
const stamp = () => new Date().toISOString().slice(0, 19);
const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(x => x.toString(16).padStart(2, "0")).join("");
const round = n => Math.round(n * 1000) / 1000;

// ── cleaning ───────────────────────────────────────────────────────────────

function text(f, v, max) {
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length > max) fail(`${f} can be at most ${max} characters`);
  return s;
}
function cleanName(v) {
  const s = text("the name", v, LIMITS.name);
  if (!s) fail("give it a name, like Whole wheat flour");
  return s;
}
function cleanKind(v) {
  if (v === "staple") return "measured";
  if (!KINDS.includes(v)) fail("kind is measured, counted or gauged");
  return v;
}
function cleanPlace(v) {
  const s = text("where it's kept", v, LIMITS.place);
  return PLACES.find(p => p.toLowerCase() === s.toLowerCase()) || s || "Cupboard";
}
function cleanDate(v) {
  if (v === null || v === undefined || v === "") return "";
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + "T00:00:00Z"))) fail("an expiry date is YYYY-MM-DD");
  return s;
}
// Where an expiry date came from: typed in, estimated from how long such things
// keep (a receipt doesn't say), or scanned off the package.
const BY = ["typed", "estimated", "scanned"];
function cleanBy(v, expires) {
  if (!expires) return "";
  return BY.includes(v) ? v : "typed";
}
function cleanLevel(v) {
  const i = typeof v === "number" ? v : LEVELS.findIndex(l => l.toLowerCase() === String(v ?? "").trim().toLowerCase());
  if (!Number.isInteger(i) || i < 0 || i >= LEVELS.length) fail(`a level is 0 (empty) to 5 (full), or one of ${LEVELS.join(", ")}`);
  return i;
}
function cleanPerCup(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!(n > 0 && n <= 2000)) fail("grams per cup is a number, like 120 for flour");
  return round(n);
}

// A measured item's amount, typed ("10 lb", "2 cups"), in the item's base unit.
// Weight and volume cross over by its grams per cup.
function baseOf(item, raw, what = "the amount") {
  if (typeof raw === "number") raw = String(raw);
  const a = readAmount(raw);
  if (!a) fail(`${what} needs a number and a unit, like 10 lb or 2 cups`);
  if (!a.unit) fail(`${what} needs a unit, like ${item.measure === "volume" ? "2 cups or 500 ml" : "10 lb or 500 g"}`);
  const u = UNITS[a.unit];
  let base = a.n * u.base;
  if (u.measure !== item.measure) {
    if (!item.perCup) fail(`${item.name} is measured by ${item.measure}. Give it in ${item.measure === "weight" ? "lb, oz, g or kg" : "cups, ml or L"}, or say how many grams a cup of it weighs`);
    base = item.measure === "weight" ? base / ML_PER_CUP * item.perCup : base / item.perCup * ML_PER_CUP;
  }
  if (base > LIMITS.base) fail(`${what} is more than this can keep track of`);
  return round(base);
}
// A counted item's amount: "3", or "3 cans".
function countOf(item, raw, what = "how many") {
  const a = typeof raw === "number" ? { n: raw, unit: null } : readAmount(raw);
  if (!a || a.unit) fail(`${what} is a number of ${plural(item.unit || "item")}, like 3`);
  if (a.n > LIMITS.count) fail(`${what} is more than this can keep track of`);
  return a.n;
}
const amountOf = (item, raw, what) => item.kind === "measured" ? baseOf(item, raw, what) : countOf(item, raw, what);

// ── reading out ────────────────────────────────────────────────────────────

const shown = (item, n) => item.kind === "measured" ? inUnit(n, item.shows) : counted(n, item.unit || "item");
const left = item => item.kind === "gauged" ? null : round((item.lots || []).reduce((s, l) => s + l.amount, 0));
// Oldest expiry first; lots without a date after them, oldest bought first.
const order = lots => [...lots].sort((a, b) => (a.expires || "9999") < (b.expires || "9999") ? -1 : (a.expires || "9999") > (b.expires || "9999") ? 1 : a.added < b.added ? -1 : 1);
const addDays = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);

// A staple's low point, as it's shown: "2 lb", "3 cans", "¼ left".
const lowText = item => !item.staple || item.low == null ? "" : item.kind === "gauged" ? LEVELS[item.low] : shown(item, item.low);

// What the page and the terminal show for an item; `day` is the viewer's own date.
export function view(item, day = today()) {
  const have = left(item);
  const lots = item.kind === "gauged" ? [] : order(item.lots || []).map(l => ({ ...l, text: shown(item, l.amount) }));
  const first = item.kind === "gauged" ? null : lots.find(l => l.expires && l.amount > 0);
  const expires = item.kind === "gauged" ? item.expires || "" : first?.expires || "";
  const out = item.kind === "gauged" ? item.level === 0 : have <= 0;
  const low = !out && !!item.staple && item.low != null && (item.kind === "gauged" ? item.level <= item.low : have <= item.low);
  return {
    id: item.id, name: item.name, kind: item.kind, staple: !!item.staple, place: item.place, words: item.words || "",
    measure: item.measure || null, shows: item.shows || null, per_cup: item.perCup ?? null, units: item.kind === "measured" ? unitsOf(item.measure) : [],
    unit: item.unit || "", size: item.size || "",
    low: item.staple ? item.low ?? null : null, low_text: lowText(item),
    level: item.kind === "gauged" ? item.level : null,
    left: have, text: item.kind === "gauged" ? LEVELS[item.level] : shown(item, have),
    lots, expires, expires_by: first?.by || (expires ? "typed" : ""), expired: !!expires && expires < day, soon: !!expires && expires <= addDays(day, SOON_DAYS),
    is_low: low, is_out: out, updated: item.updated,
  };
}

// The places in use, the usual ones first in their order, then the rest by name.
function placesOf(items) {
  const used = new Set(items.map(i => i.place));
  return [...PLACES.filter(p => used.has(p)), ...[...used].filter(p => !PLACES.includes(p)).sort((a, b) => a.localeCompare(b))];
}

// ── storage ────────────────────────────────────────────────────────────────

// An item as saved; one saved when staple was a kind is a measured staple.
function read(r) {
  const item = { ...JSON.parse(r.data), id: r.id, updated: r.updated };
  if (item.kind === "staple") { item.kind = "measured"; item.staple = true; }
  return item;
}
async function load(d, owner) {
  const { results } = await d.prepare("SELECT id, data, updated FROM pantry_items WHERE owner = ?").bind(owner).all();
  return results.map(read);
}
async function loadOne(d, owner, id) {
  const r = await d.prepare("SELECT id, data, updated FROM pantry_items WHERE owner = ? AND id = ?").bind(owner, id).first();
  return r ? read(r) : null;
}
async function save(d, owner, item) {
  const { id, updated, ...data } = item;
  item.updated = stamp();
  await d.prepare("INSERT INTO pantry_items (owner, id, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT (owner, id) DO UPDATE SET data = excluded.data, updated = excluded.updated")
    .bind(owner, id, JSON.stringify(data), item.updated).run();
}
async function nameTaken(d, owner, name, except = "") {
  const all = await load(d, owner);
  return all.some(i => i.id !== except && i.name.toLowerCase() === name.toLowerCase());
}

export async function listItems(env, user, day = today()) {
  const items = (await load(await db(env), user.id)).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })).map(i => view(i, day));
  return {
    items, places: placesOf(items), kinds: KINDS, levels: LEVELS, usual_places: PLACES,
    counts: { all: items.length, soon: items.filter(i => i.soon).length, low: items.filter(i => i.is_low || i.is_out).length },
    limits: LIMITS,
  };
}

// The kind's own fields, from what was sent (or guessed), onto a fresh item.
function setKind(item, kind, body, hint) {
  item.kind = kind;
  for (const k of ["measure", "shows", "perCup", "low", "unit", "size", "level", "expires"]) delete item[k];
  if (kind === "gauged") {
    item.level = "level" in body ? cleanLevel(body.level) : 5;
    item.expires = cleanDate(body.expires);
    item.lots = [];
  } else if (kind === "counted") {
    item.unit = singular(text("the unit", body.unit ?? hint.unit ?? "", LIMITS.unit).toLowerCase()) || "item";
    item.size = text("the size of one", body.size, LIMITS.size);
  } else {
    // Measured by weight or volume: whichever the amount (or the low point) was typed in.
    const said = [body.amount, body.low].map(v => readAmount(v ?? "")).find(a => a?.unit);
    if (!said) fail(`say how much ${item.name} you have, with a unit, like 10 lb or 2 cups`);
    item.measure = UNITS[said.unit].measure;
    item.shows = said.unit;
    item.perCup = "per_cup" in body ? cleanPerCup(body.per_cup) : hint.perCup ?? null;
  }
  setLow(item, body);
}

// A staple's low point, in the kind's own terms: an amount, a count, or a level.
const blank = v => v === undefined || v === null || String(v).trim() === "";
function setLow(item, body) {
  item.low = null;
  if (!item.staple) return;
  if (blank(body.low)) {
    fail(`say when ${item.name} is running low, like ${item.kind === "gauged" ? "¼ left" : item.kind === "counted" ? "2" : "2 lb"} (a staple goes on your shopping list once it's that low)`);
  }
  item.low = item.kind === "gauged" ? cleanLevel(typeof body.low === "string" && /^\d$/.test(body.low.trim()) ? Number(body.low) : body.low)
    : item.kind === "counted" ? countOf(item, body.low, "the low point") : baseOf(item, body.low, "the low point");
}
// Whether it's a staple: said outright; or by sending "staple" as the kind (as it once was),
// or a low point, which only a staple has.
const stapleOf = (body, was = false) => "staple" in body ? body.staple === true || body.staple === "true"
  : body.kind === "staple" || !blank(body.low) || was;

export async function addItem(env, user, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  const d = await db(env);
  const name = cleanName(body.name);
  const all = await load(d, user.id);
  if (all.length >= LIMITS.items) fail(`a pantry holds at most ${LIMITS.items} things`);
  if (all.some(i => i.name.toLowerCase() === name.toLowerCase())) fail(`${name} is already in your pantry. Add more to it instead`);
  const hint = guess(name);
  const item = { id: "i_" + hex(5), name, place: cleanPlace(body.place ?? hint.place), words: text("other names", body.words, LIMITS.words), lots: [], created: stamp() };
  item.staple = stapleOf(body);
  setKind(item, body.kind === undefined || body.kind === null || body.kind === "" ? hint.kind : cleanKind(body.kind), body, hint);
  const amount = body.amount;
  if (item.kind !== "gauged" && amount !== undefined && amount !== null && String(amount).trim() !== "") {
    const n = amountOf(item, amount);
    const expires = cleanDate(body.expires);
    if (n > 0) item.lots.push({ id: "t_" + hex(4), amount: n, expires, by: cleanBy(body.expires_by, expires), added: today() });
  }
  await save(d, user.id, item);
  return view(item);
}

export async function editItem(env, user, id, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  const d = await db(env);
  const item = await loadOne(d, user.id, id);
  if (!item) return null;
  if ("name" in body) {
    const name = cleanName(body.name);
    if (await nameTaken(d, user.id, name, id)) fail(`${name} is already in your pantry`);
    item.name = name;
  }
  if ("place" in body) item.place = cleanPlace(body.place);
  if ("words" in body) item.words = text("other names", body.words, LIMITS.words);
  const staple = stapleOf(body, !!item.staple);
  if ("kind" in body && cleanKind(body.kind) !== item.kind) {
    // A new kind counts differently, so it starts again from what you have now, keeping the soonest expiry.
    const kind = cleanKind(body.kind);
    const soonest = view(item).expires;
    const was = item.kind;
    const keep = { ...(item.perCup ? { per_cup: item.perCup } : {}), ...(item.unit ? { unit: item.unit } : {}), ...(item.size ? { size: item.size } : {}) };
    if (kind !== "gauged" && (body.amount === undefined || String(body.amount ?? "").trim() === "")) {
      fail(kind === "measured" ? `say how much ${item.name} you have now, like 10 lb` : `say how many ${item.name} you have now, like 3`);
    }
    // A low point is in the kind's terms, so a staple changing kind says its new one.
    item.staple = staple;
    if (kind === "gauged" && !("level" in body)) body = { ...body, level: was === "gauged" ? item.level : left(item) > 0 ? 5 : 0 };
    setKind(item, kind, { ...keep, expires: soonest, ...body }, guess(item.name));
    item.lots = [];
    if (kind !== "gauged") {
      const n = amountOf(item, body.amount);
      const expires = "expires" in body ? cleanDate(body.expires) : soonest;
      if (n > 0) item.lots.push({ id: "t_" + hex(4), amount: n, expires, by: cleanBy(body.expires_by, expires), added: today() });
    }
  } else {
    if ("per_cup" in body && item.kind === "measured") item.perCup = cleanPerCup(body.per_cup);
    if (staple !== !!item.staple || "low" in body) {
      item.staple = staple;
      setLow(item, "low" in body ? body : { low: null });
    }
    if ("shows" in body && item.kind === "measured") {
      if (!unitsOf(item.measure).includes(body.shows)) fail(`show it in one of ${unitsOf(item.measure).join(", ")}`);
      item.shows = body.shows;
    }
    if ("unit" in body && item.kind === "counted") item.unit = singular(text("the unit", body.unit, LIMITS.unit).toLowerCase()) || "item";
    if ("size" in body && item.kind === "counted") item.size = text("the size of one", body.size, LIMITS.size);
    if ("level" in body && item.kind === "gauged") item.level = cleanLevel(body.level);
    if ("expires" in body && item.kind === "gauged") item.expires = cleanDate(body.expires);
  }
  await save(d, user.id, item);
  return view(item);
}

export async function deleteItem(env, user, id) {
  const d = await db(env);
  const r = await d.prepare("DELETE FROM pantry_items WHERE owner = ? AND id = ?").bind(user.id, id).run();
  if (!r.meta.changes) return null;
  await d.prepare("DELETE FROM pantry_aliases WHERE owner = ? AND item = ?").bind(user.id, id).run();
  return { removed: true };
}

// Another purchase of something already in the pantry.
export async function addLot(env, user, id, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  const d = await db(env);
  const item = await loadOne(d, user.id, id);
  if (!item) return null;
  if (item.kind === "gauged") fail(`${item.name} goes by how full it is. Set it to Full instead`);
  if (item.lots.length >= LIMITS.lots) fail(`${item.name} can have at most ${LIMITS.lots} purchases kept apart`);
  const n = amountOf(item, body.amount);
  if (!(n > 0)) fail("say how much you bought");
  const expires = cleanDate(body.expires);
  item.lots.push({ id: "t_" + hex(4), amount: n, expires, by: cleanBy(body.expires_by, expires), added: today() });
  await save(d, user.id, item);
  return view(item);
}

export async function editLot(env, user, id, lotId, body, remove = false) {
  if (!remove && !isObj(body)) fail("body must be a JSON object");
  const d = await db(env);
  const item = await loadOne(d, user.id, id);
  const lot = item?.lots?.find(l => l.id === lotId);
  if (!lot) return null;
  if (remove) item.lots = item.lots.filter(l => l !== lot);
  else {
    if ("amount" in body) lot.amount = amountOf(item, body.amount);
    if ("expires" in body) { lot.expires = cleanDate(body.expires); lot.by = cleanBy(body.expires_by, lot.expires); }
    if (!(lot.amount > 0)) item.lots = item.lots.filter(l => l !== lot);
  }
  await save(d, user.id, item);
  return view(item);
}

// Taking some out: from the soonest-expiring lot first. A counted item goes by
// whole units, so using part of one uses it all.
export function take(item, n) {
  let need = item.kind === "counted" ? Math.ceil(n - 1e-9) : n;
  for (const lot of order(item.lots)) {
    if (need <= 0) break;
    const off = Math.min(lot.amount, need);
    lot.amount = round(lot.amount - off);
    need = round(need - off);
  }
  item.lots = item.lots.filter(l => l.amount > 0);
  return need;
}

export async function useItem(env, user, id, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  const d = await db(env);
  const item = await loadOne(d, user.id, id);
  if (!item) return null;
  if (item.kind === "gauged") {
    if (body.all || body.tossed) item.level = 0;
    else if ("level" in body) item.level = cleanLevel(body.level);
    else fail(`${item.name} goes by how full it is: send the level it's at now`);
  } else if (body.all || (body.tossed && (body.amount === undefined || body.amount === ""))) {
    item.lots = [];
  } else {
    const n = amountOf(item, body.amount, "how much you used");
    if (!(n > 0)) fail("say how much you used");
    const have = left(item);
    if (n > have + 1e-6) fail(`there's only ${shown(item, have)} of ${item.name} in your pantry. Use it all instead?`);
    take(item, n);
  }
  await save(d, user.id, item);
  return view(item);
}

// ── a household's pantry ───────────────────────────────────────────────────
// The owner shares it by username; it stays stored under the owner, whoever adds or takes.

export const SHARE_ROLES = ["use", "stock"];
const MAX_SHARES = 20;
const nameOf = r => r.display_name || r.username;

export async function listShares(env, user) {
  const d = await db(env);
  const { results: out } = await d.prepare(`SELECT u.username, u.display_name, s.role FROM pantry_shares s JOIN users u ON u.id = s.user_id
    WHERE s.owner = ? ORDER BY s.created_at`).bind(user.id).all();
  const { results: inn } = await d.prepare(`SELECT u.username, u.display_name, s.role FROM pantry_shares s JOIN users u ON u.id = s.owner
    WHERE s.user_id = ? AND u.disabled = 0 ORDER BY u.username`).bind(user.id).all();
  return {
    shares: out.map(r => ({ username: r.username, name: nameOf(r), role: r.role })),
    shared: inn.map(r => ({ username: r.username, name: nameOf(r), role: r.role })),
    roles: SHARE_ROLES,
  };
}

// Shares your pantry with another account that has Pantry, or changes their role.
export async function sharePantry(env, user, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  const role = String(body.role ?? "use");
  if (!SHARE_ROLES.includes(role)) fail("role is use (see it and take things out) or stock (also add what's bought)");
  const username = String(body.username ?? "").trim().toLowerCase().replace(/^@/, "");
  const d = await db(env);
  const who = username && await d.prepare(`SELECT u.id, u.username, u.display_name FROM users u
    JOIN user_areas a ON a.user_id = u.id AND a.area = 'pantry' WHERE u.username = ? AND u.disabled = 0`).bind(username).first();
  if (!who) fail("there's no one with Pantry by that username");
  if (who.id === user.id) fail("that's you");
  const { n, mine } = await d.prepare("SELECT COUNT(*) AS n, SUM(user_id = ?) AS mine FROM pantry_shares WHERE owner = ?").bind(who.id, user.id).first();
  if (!mine && n >= MAX_SHARES) fail(`a pantry can be shared with at most ${MAX_SHARES} people`);
  await d.prepare(`INSERT INTO pantry_shares (owner, user_id, role, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (owner, user_id) DO UPDATE SET role = excluded.role`).bind(user.id, who.id, role, Date.now()).run();
  return listShares(env, user);
}

// The owner stops sharing with someone, or (leave) you leave the pantry they shared with you.
export async function unsharePantry(env, user, username, leave = false) {
  const d = await db(env);
  const who = await d.prepare("SELECT id FROM users WHERE username = ?").bind(String(username).toLowerCase()).first();
  if (!who) return null;
  const [owner, member] = leave ? [who.id, user.id] : [user.id, who.id];
  const res = await d.prepare("DELETE FROM pantry_shares WHERE owner = ? AND user_id = ?").bind(owner, member).run();
  return res.meta.changes ? listShares(env, user) : null;
}

// Whose pantry a request works on: yours, or ?of=<username> shared with you. → {owner, role} or null.
async function pantryOf(env, user, of) {
  if (!of || of.toLowerCase() === String(user.username || "").toLowerCase()) return { owner: user, role: "owner" };
  const r = await (await db(env)).prepare(`SELECT u.id, u.username, u.display_name, s.role FROM pantry_shares s JOIN users u ON u.id = s.owner
    WHERE u.username = ? AND s.user_id = ? AND u.disabled = 0`).bind(of.toLowerCase(), user.id).first();
  return r ? { owner: { id: r.id, username: r.username, display_name: r.display_name }, role: r.role } : null;
}

// For the dashboard's card: what needs looking at first.
export async function pantryLine(env, user, day) {
  const { counts } = await listItems(env, user, day);
  if (!counts.all) return "Nothing in your pantry yet";
  if (counts.soon) return `${counts.soon} ${counts.soon === 1 ? "thing" : "things"} to use soon`;
  if (counts.low) return `${counts.low} running low`;
  return `${counts.all} ${counts.all === 1 ? "thing" : "things"} in your pantry`;
}

// ── the page and its API ───────────────────────────────────────────────────

const PAGE_CSP = [
  "default-src 'none'", "script-src 'self'", "connect-src 'self'", "manifest-src 'self'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com", "img-src 'self' data:",
  "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");

// The viewer's own date, sent as ?day=, or today where the site is.
const dayOf = request => { const day = new URL(request.url).searchParams.get("day"); return /^\d{4}-\d{2}-\d{2}$/.test(day || "") ? day : today(); };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// A paired phone's request (Authorization: Bearer ps_…, from the scanner app): as its owner, but only
// to Pantry's API, and never to the Anthropic key or pairing. Pairing itself is the app's one
// request without a key. → a Response, or null when it's neither (and the session decides).
export async function pantryScanner(request, env, pathname) {
  const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (pathname === "/pantry/scanner/pair") {
    if (request.method !== "POST") return reply({ error: "method not allowed" }, 405);
    try { return reply(await finishPairing(env, await readJson(request), new URL(request.url).origin)); }
    catch (e) {
      if (e instanceof BadRequest) return reply({ error: e.message }, 400);
      console.error("pantry pairing:", e);
      return reply({ error: "server error" }, 500);
    }
  }
  if (pathname === "/pantry/scanner/latest.json") {
    // The newest scanner app on GitHub (a scanner-v<N> release, .github/workflows/scanner.yml), for the page's
    // download link and the app's own update check. {version: null} before the first. ios is where the
    // iPhone app is (scanner-ios/, on TestFlight): the SCANNER_IOS_URL variable, or null until it's set.
    if (request.method !== "GET") return reply({ error: "method not allowed" }, 405);
    return reply({ version: null, ...await latestOf(env, SCANNER_TAG, SCANNER_APK), ios: iosScanner(env) });
  }
  if (!/^Bearer\s/i.test(request.headers.get("Authorization") || "")) return null;
  if (!pathname.startsWith("/pantry/api/") || /^\/pantry\/api\/(key|scanners)(\/|$)/.test(pathname)) return reply({ error: "a scanner can't do that" }, 403);
  const user = await scannerUser(env, request);
  if (!user) return reply({ error: "this phone isn't paired any more; pair it again from your Pantry page" }, 401);
  return pantry(request, env, user, pathname, { scanner: true });
}

export async function pantry(request, env, user, pathname, { scanner = false } = {}) {
  if (!pathname.startsWith("/pantry/api/")) {
    const asset = await withRail(await env.ASSETS.fetch(request), user, "pantry");
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
    // A scanner's key is sent by the app itself, never by a browser, so there's no other site to refuse.
    if (method !== "GET" && !scanner && !sameOrigin(request)) return json({ error: "cross-origin request refused" }, 403);
    const notAllowed = () => json({ error: "method not allowed" }, 405);
    const path = pathname.replace(/\/$/, "");
    if (path.startsWith("/pantry/api/share")) {
      if (scanner) return json({ error: "a scanner can't do that" }, 403);
      const [, , , what, who] = path.split("/");
      if (what === "shares" && !who && method === "GET") return json(await listShares(env, user));
      if (what === "shares" && !who && method === "PUT") return json(await sharePantry(env, user, await readJson(request)));
      if (who && method === "DELETE") {
        const left = await unsharePantry(env, user, who, what === "shared");
        return left ? json(left) : json({ error: "not found" }, 404);
      }
      return notAllowed();
    }
    // Yours, or a household's shared with you (?of=), and what you may do in it.
    const of = new URL(request.url).searchParams.get("of");
    const access = await pantryOf(env, user, of);
    if (!access) return json({ error: "that pantry isn't shared with you" }, 404);
    const { owner, role } = access;
    const may = need => role === "owner" || (need === "stock" ? role === "stock" : need === "use");
    const refuse = need => json({ error: need === "owner" ? "only the pantry's owner can do that"
      : "you can take things out of this pantry, but not add to it" }, 403);
    if (role !== "owner" && /^\/pantry\/api\/(key|scanners)(\/|$)/.test(path)) return refuse("owner");
    if (path.startsWith("/pantry/api/scanners")) {
      const sid = path.split("/")[4];
      if (!sid && method === "GET") return json(await listScanners(env, user));
      if (!sid && method === "POST") return json(await startPairing(env, user, new URL(request.url).origin));
      if (sid && method === "DELETE") { const left = await unpair(env, user, sid); return left ? json(left) : json({ error: "not found" }, 404); }
      return notAllowed();
    }
    if (path.startsWith("/pantry/api/barcode/")) {
      if (method !== "GET") return notAllowed();
      return json(await lookUp(env, owner, path.split("/")[4], dayOf(request)));
    }
    if (path === "/pantry/api/add") {
      if (method !== "POST") return notAllowed();
      if (!may("stock")) return refuse("stock");
      return json(await addReceipt(env, owner, { store: "", ...await readJson(request) }, user));
    }
    const [, id, sub, lot] = m;
    let out;
    if (pathname.replace(/\/$/, "") === "/pantry/api/key") {
      if (method === "PUT") return json(await saveKey(env, user, await readJson(request)));
      if (method === "DELETE") return json(await forgetKey(env, user));
      return notAllowed();
    }
    if (pathname.startsWith("/pantry/api/receipt")) {
      if (method !== "POST") return notAllowed();
      if (!may("stock")) return refuse("stock");
      if (pathname.replace(/\/$/, "").endsWith("/add")) return json(await addReceipt(env, owner, await readJson(request), user));
      return json(await readReceipt(env, user, await readPhotoBody(request), dayOf(request), owner));
    }
    if (!id) {
      if (method === "GET") {
        return json({ ...await listItems(env, owner, dayOf(request)), photo: await photoState(env, user),
          pantry: { owner: owner.username || "", name: role === "owner" ? "" : owner.display_name || owner.username, role } });
      }
      if (method === "POST") { if (!may("owner")) return refuse("owner"); return json(await addItem(env, owner, await readJson(request)), 201); }
      return notAllowed();
    }
    if (!ID.test(id)) return json({ error: "not found" }, 404);
    if (sub === "use") {
      if (method !== "POST") return notAllowed();
      out = await useItem(env, owner, id, await readJson(request));
    } else if (sub === "lots" && !lot) {
      if (method !== "POST") return notAllowed();
      if (!may("stock")) return refuse("stock");
      out = await addLot(env, owner, id, await readJson(request));
      if (out) return json(out, 201);
    } else if (sub === "lots") {
      if (!may("owner")) return refuse("owner");
      if (method === "PATCH") out = await editLot(env, owner, id, lot, await readJson(request));
      else if (method === "DELETE") out = await editLot(env, owner, id, lot, null, true);
      else return notAllowed();
    } else if (method === "PATCH" || method === "DELETE") {
      if (!may("owner")) return refuse("owner");
      out = method === "PATCH" ? await editItem(env, owner, id, await readJson(request)) : await deleteItem(env, owner, id);
    }
    else return notAllowed();
    return out ? json(out) : json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    console.error("pantry error:", e);
    return json({ error: "server error" }, 500);
  }
}
