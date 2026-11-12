// Pantry: filling it from a grocery receipt. A photo (or a few, for a long
// receipt) is read into its lines, the way Recipe box reads recipe photos
// (src/recipe_photo.js: your Claude key, or Workers AI without one). Each food
// line is matched to something in your pantry, or offered as something new
// with its kind guessed from its name, and given an estimated expiry date.
// Nothing is saved until the lines are checked and sent back to /add.
//
// Store abbreviations ("GV WW FLR 10LB") are learned: once a line is added to
// an item, that store's line always means that item.
//
// /pantry/api/receipt      POST {images: [{data (base64)}, ...]} → {store, date, by, lines: [...]}: what to add, to check
// /pantry/api/receipt/add  POST {store, lines: [{key?, printed, barcode?, item? (an id) | name, kind?, staple?, place?, unit?, size?, low?, amount, level? (gauged, 0-5; full when left out), expires?, expires_by?}]}
//                          → {added: [{key?, printed, id, name, text}], failed: [{key?, printed, error}], ticked: [{id, title, list}], items}
//   (also /pantry/api/add, for lines that aren't from a receipt: the scanner app's barcodes). A line with a barcode
//   remembers it as that item (src/pantry_scanner.js); and whatever comes in is ticked off your Drift shopping list.

import { db } from "./db.js";
import { BadRequest, SHOPPING, writableCollections, collectionWithItems, updateItem } from "./drift.js";
import { readPictures } from "./recipe_photo.js";
import { readAmount, guess, estimateExpiry, singular, UNITS } from "../public/pantry/units.js";
import { addItem, addLot, editItem, listItems } from "./pantry.js";
import { BARCODE, rememberProduct } from "./pantry_scanner.js";

const fail = msg => { throw new BadRequest(msg); };
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
export const RECEIPT_LIMITS = { images: 4, lines: 80, printed: 120, name: 80, store: 60 };
const today = () => new Date().toISOString().slice(0, 10);
const tidy = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

const SYSTEM = `You read photos of grocery store receipts and list what was bought, for someone adding their groceries to a pantry app.

For every item line on the receipt, in order, give:
- printed: the item's text exactly as printed, abbreviations and all ("GV WW FLR 10LB"), without the price or item codes.
- name: what it is in plain words, as someone would call it in their kitchen ("Whole wheat flour", "Tomato soup", "Eggs", "Bananas"). Leave out brand names unless they're the only clue.
- count: how many were bought (a "2 @ 1.29" line, or the same line printed twice, is 2). 1 when it doesn't say.
- size: the size of one, when the receipt says it, with its unit ("10 lb", "16 oz", "1 gal", "12 ct"); for things sold by weight, the weight bought ("2.31 lb"). "" when it doesn't say.
- food: true for food and drink; false for everything else (bags, bottle deposits, coupons, discounts, tax, totals, gift cards, household goods, toiletries).
- price: the line's price as a number, or 0.

store is the store's name as printed at the top ("Walmart", "Kroger"), or "". date is the receipt's date as YYYY-MM-DD, or "". Leave out anything you can't read rather than guessing. If the pictures aren't a receipt, set found to false and say what you see in notes.`;

const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["found", "store", "date", "lines", "notes"],
  properties: {
    found: { type: "boolean" },
    store: { type: "string" },
    date: { type: "string" },
    notes: { type: "string" },
    lines: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["printed", "name", "count", "size", "food", "price"],
        properties: { printed: { type: "string" }, name: { type: "string" }, count: { type: "number" }, size: { type: "string" }, food: { type: "boolean" }, price: { type: "number" } },
      },
    },
  },
};
const RECEIPT = {
  what: "the receipt", images: RECEIPT_LIMITS.images, system: SYSTEM, schema: SCHEMA,
  ask: n => n > 1 ? `These ${n} pictures are one receipt, top to bottom. List what was bought.` : "List what was bought on this receipt.",
  aiSystem: SYSTEM + "\n\nNever make up a line that isn't on the receipt. Answer only with the JSON object.",
  aiSchema: SCHEMA,
};

// A receipt line as printed, for remembering: capitals, single spaces, no prices.
export const said = s => tidy(s, RECEIPT_LIMITS.printed).toUpperCase().replace(/\s+\d+[.,]\d{2}\s*[A-Z]?$/, "").trim();
const storeKey = s => tidy(s, RECEIPT_LIMITS.store).toLowerCase();
const plainWords = s => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(singular);
// Words that don't make it a different food.
const PLAIN = new Set(["whole", "large", "medium", "small", "extra", "jumbo", "organic", "fresh", "natural", "store", "brand", "value", "family", "size", "pack", "grade", "all", "purpose", "a", "aa", "of", "the", "and"]);
const sameName = (a, b) => { const x = plainWords(a).join(" "); return x && x === plainWords(b).join(" "); };
// `name` is `mine` with only plain words added ("Whole milk" for Milk, not "Brown sugar" for Sugar).
const plainerName = (mine, name) => {
  const a = plainWords(mine), b = plainWords(name);
  return a.length > 0 && a.every(w => b.includes(w)) && b.every(w => a.includes(w) || PLAIN.has(w));
};
// Whether a shopping list line ("2 lb whole wheat flour", "Eggs (for Pancakes)") is clearly this item.
const LEAD = /^[\s\d½¼¾⅓⅔⅛.,/-]*(?:(?:x|×)\s*)?(?:(?:cups?|c|tbsps?|tablespoons?|tsps?|teaspoons?|lbs?|pounds?|oz|ounces?|g|grams?|kg|ml|l|liters?|litres?|gallons?|gal|quarts?|qt|pints?|pt|cans?|jars?|bottles?|boxes?|bags?|packs?|packages?|dozen|bunch(?:es)?|heads?|cloves?|sticks?|loaf|loaves|pieces?|pcs?)\.?\s+)?(?:of\s+)?/i;
export function listLineIs(item, title) {
  const bare = String(title || "").replace(/\s*[(,;].*$/, "").replace(LEAD, "").trim();
  if (!bare) return false;
  return [item.name, ...String(item.words || "").split(",")].some(n => n.trim() && (sameName(n, bare) || plainerName(n, bare)));
}

// The model's answer, tidied: [{printed, name, count, size, food, price}].
export function linesFrom(found) {
  if (!isObj(found) || !found.found || !Array.isArray(found.lines)) return null;
  return found.lines.slice(0, RECEIPT_LIMITS.lines).map(l => ({
    printed: tidy(l?.printed, RECEIPT_LIMITS.printed), name: tidy(l?.name, RECEIPT_LIMITS.name),
    count: Number(l?.count) > 0 && Number(l?.count) <= 100 ? Math.round(Number(l.count) * 1000) / 1000 : 1,
    size: tidy(l?.size, 40), food: l?.food !== false, price: Number(l?.price) || 0,
  })).filter(l => l.printed || l.name);
}

// What one line adds: to an item already in the pantry, or as a new one.
// The amount is written the way the add form takes it ("10 lb", or how many).
export function proposal(line, items, aliases, day) {
  const out = { printed: line.printed, name: line.name || line.printed, count: line.count, size: line.size, price: line.price, skip: !line.food, match: null };
  const known = aliases.get(said(line.printed));
  let item = known && items.find(i => i.id === known);
  let how = item ? "remembered" : "";
  if (!item) {
    item = items.find(i => sameName(i.name, line.name) || (i.words || "").split(",").some(w => sameName(w, line.name)));
    // Or the one thing whose name is the line's with only plain words added
    // (Milk for "Whole milk", but not Sugar for "Brown sugar").
    if (!item) {
      const fits = items.filter(i => plainerName(i.name, line.name));
      if (fits.length === 1) item = fits[0];
    }
    if (item) how = "name";
  }
  const size = readAmount(line.size);
  const kind = item ? item.kind : guess(out.name).kind;
  // A measured thing's amount is how many times the size; counted things are how many.
  let amount = "";
  if (kind === "measured" || kind === "staple") amount = size?.unit ? `${Math.round(size.n * line.count * 1000) / 1000} ${size.unit === "floz" ? "fl oz" : UNITS[size.unit].one}` : "";
  else if (kind === "counted") {
    // "12 ct" (or a dozen) is that many of them in each one bought.
    const each = /^(ct|cnt|count|pk|pack|pc|pcs|piece|pieces)$/.test(size?.word || "") ? size.n : size?.word === "dozen" ? size.n * 12 : 1;
    amount = String(Math.round(line.count * each * 1000) / 1000);
  }
  out.amount = amount;
  if (item) {
    out.match = { id: item.id, name: item.name, kind: item.kind, how, text: item.text };
    out.expires = kind === "gauged" ? "" : estimateExpiry(item.name, item.kind, item.place, day);
  } else {
    const g = guess(out.name);
    out.new = { kind: g.kind, place: g.place, unit: g.unit || "", size: kind === "counted" && size?.unit ? line.size : "", low: "" };
    out.expires = g.kind === "gauged" ? "" : estimateExpiry(out.name, g.kind, g.place, day);
  }
  out.expires_by = out.expires ? "estimated" : "";
  return out;
}

async function aliasesOf(d, owner, store) {
  const { results } = await d.prepare("SELECT said, item FROM pantry_aliases WHERE owner = ? AND store = ?").bind(owner, storeKey(store)).all();
  return new Map(results.map(r => [r.said, r.item]));
}

// Read with the reader's own key (or the site's AI), matched against `owner`'s pantry (theirs, or one shared with them).
export async function readReceipt(env, user, body, day = today(), owner = user) {
  const { found, by, why } = await readPictures(env, user, body, RECEIPT);
  const lines = linesFrom(found);
  if (!lines?.length) fail(`couldn't find a receipt in that picture${found?.notes ? ` (${by === "claude" ? "Claude" : "it"} saw: ${tidy(found.notes, 200)})` : ""}`);
  const store = tidy(found.store, RECEIPT_LIMITS.store);
  const { items } = await listItems(env, owner, day);
  const aliases = await aliasesOf(await db(env), owner.id, store);
  const out = { store, date: /^\d{4}-\d{2}-\d{2}$/.test(found.date || "") ? found.date : "", by, lines: lines.map(l => proposal(l, items, aliases, day)) };
  return why ? { ...out, why } : out;
}

// The checked lines, into the pantry: each one bought again of an item, or a new item.
// Into `user`'s pantry (theirs, or a household's shared with `by`), ticking off the shopping lists `by` can write to.
export async function addReceipt(env, user, body, by = user) {
  if (!isObj(body) || !Array.isArray(body.lines)) fail("send {store, lines: [...]}");
  if (body.lines.length > RECEIPT_LIMITS.lines) fail(`send at most ${RECEIPT_LIMITS.lines} lines at once`);
  const d = await db(env), store = storeKey(body.store);
  const kinds = new Map((await listItems(env, user)).items.map(i => [i.id, i.kind]));
  const added = [], failed = [], learn = [], products = [], into = new Map();
  for (const line of body.lines) {
    const printed = tidy(line?.printed, RECEIPT_LIMITS.printed);
    // The app's own name for a line (a barcode line has nothing printed), said back with what happened to it.
    const key = isObj(line) && line.key != null ? tidy(line.key, 40) : undefined;
    try {
      if (!isObj(line)) fail("each line is an object");
      const lot = { amount: line.amount, expires: line.expires, expires_by: line.expires_by };
      let out;
      if (line.item && kinds.get(String(line.item)) === "gauged") {
        // Bought again: full, unless you said how full (a jar you found half used).
        out = await editItem(env, user, String(line.item), { level: line.level ?? 5 });
      } else if (line.item) {
        out = await addLot(env, user, String(line.item), lot);
        if (!out) fail("that's no longer in your pantry");
      } else {
        const { item, ...rest } = line;
        out = await addItem(env, user, { name: rest.name, kind: rest.kind, place: rest.place, unit: rest.unit, size: rest.size, low: rest.low, words: rest.words, ...(rest.level != null ? { level: rest.level } : {}), ...(rest.staple != null ? { staple: rest.staple } : {}), ...lot });
        kinds.set(out.id, out.kind);
      }
      added.push({ ...(key !== undefined ? { key } : {}), printed, id: out.id, name: out.name, text: out.text });
      into.set(out.id, out);
      if (printed && store) learn.push([said(printed), out.id]);
      const code = String(line.barcode ?? "");
      if (BARCODE.test(code)) products.push([code, out, line]);
    } catch (e) {
      if (!(e instanceof BadRequest)) throw e;
      failed.push({ ...(key !== undefined ? { key } : {}), printed, name: tidy(line?.name, RECEIPT_LIMITS.name), error: e.message });
    }
  }
  if (learn.length || products.length) {
    const t = new Date().toISOString().slice(0, 19);
    await d.batch([
      ...learn.map(([s, id]) => d.prepare(`INSERT INTO pantry_aliases (owner, store, said, item, updated) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (owner, store, said) DO UPDATE SET item = excluded.item, updated = excluded.updated`).bind(user.id, store, s, id, t)),
      ...products.map(([code, item, line]) => rememberProduct(d, user.id, code, item, line)),
    ]);
  }
  const ticked = await tickOff(env, by, [...into.values()]);
  return { added, failed, ticked, items: (await listItems(env, user)).items };
}

// What came in is ticked off your shopping list: each open line there that's clearly one of these
// ("2 lb whole wheat flour" for Whole wheat flour, but not "brown sugar" for Sugar). → [{id, title, list}]
async function tickOff(env, user, items) {
  if (!items.length || !user.areas.has("todo")) return [];
  const out = [];
  for (const list of (await writableCollections(env, user)).filter(c => c.name.toLowerCase() === SHOPPING.toLowerCase())) {
    const found = await collectionWithItems(env, user, list.id);
    for (const it of found?.items || []) {
      const check = it.meta?.checklist;
      if (!check || check.done || !items.some(i => listLineIs(i, it.title))) continue;
      if (await updateItem(env, user, it.id, { meta: { checklist: { ...check, done: true } } })) out.push({ id: it.id, title: it.title, list: list.name });
    }
  }
  return out;
}
