// What a recipe's ingredient line puts on a shopping list: the thing to buy,
// plainly ("Flour" for "3 cups all-purpose flour, sifted"), with the amount
// and the recipe it's for kept for the item's notes. Recipe box (src/recipes.js)
// and Meal plan (src/meals.js) send ingredients through here, so:
//   - each item is just the food's name;
//   - the same food twice (from two recipes, or already open on the list) is one
//     item, with each amount on its own line of the notes;
//   - with Pantry, things your pantry has (not out, not running low) are left
//     off, and the answer says which.

import { singular } from "../public/pantry/units.js";
import { listLineIs } from "./pantry_receipt.js";
import { listItems } from "./pantry.js";
import { listFor, collectionWithItems, createItem, updateItem, BadRequest } from "./drift.js";

const fail = msg => { throw new BadRequest(msg); };

const G = "¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞";
const NUM = `(?:\\d+\\s*[${G}]|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:[.,]\\d+)?|[${G}]|(?:an?|one|two|three|four|five|six|half|a few|few|several|some)\\b)`;
const AMOUNT = `${NUM}(?:\\s*(?:-|–|—|to|or)\\s*${NUM})?`;
const UNIT = [
  "cups?", "c", "tbsps?", "tbs", "tbl", "tablespoons?", "tsps?", "teaspoons?", "lbs?", "pounds?", "fl\\.?\\s*oz", "oz", "ounces?",
  "g", "grams?", "kg", "kilos?", "kilograms?", "mg", "ml", "millilit(?:er|re)s?", "l", "lit(?:er|re)s?", "gallons?", "gal", "quarts?", "qts?",
  "pints?", "pts?", "cans?", "tins?", "jars?", "bottles?", "boxes?", "bags?", "packs?", "packets?", "packages?", "pkgs?", "dozen",
  "bunch(?:es)?", "heads?", "cloves?", "sticks?", "slices?", "loaf", "loaves", "pieces?", "pcs?", "pinch(?:es)?", "dash(?:es)?",
  "handfuls?", "sprigs?", "stalks?", "cubes?", "containers?", "cartons?", "envelopes?", "sheets?", "fillets?", "strips?", "drops?",
  "splash(?:es)?", "scoops?", "knobs?", "ears?", "wedges?", "rashers?",
].join("|");
// An amount at the start ("1 1/2 cups", "2-3", "a pinch of"), maybe "plus 2 tbsp" after it.
const LEAD = new RegExp(`^(?:${AMOUNT})(?:\\s*(?:${UNIT})\\b\\.?)?(?:\\s+(?:plus|\\+)\\s+(?:${AMOUNT})(?:\\s*(?:${UNIT})\\b\\.?)?)*(?:\\s+of\\b)?\\s*`, "i");
const UNIT_ONLY = new RegExp(`^(?:${UNIT})\\b\\.?(?:\\s+of\\b)?\\s+`, "i");
// Words about size or preparation, not what to buy.
const FRONT = /^(?:fresh(?:ly)?|large|medium|small|extra[- ]large|jumbo|big|finely|roughly|coarsely|thinly|chopped|diced|minced|sliced|grated|shredded|crushed|packed|lightly|firmly|heaping|heaped|level|softened|melted|room[- ]temperature|cold|warm|hot|boneless|skinless|peeled|halved|cubed|beaten|sifted|rinsed|drained|(?:about|approx\.?|approximately|roughly))\b,?\s*/i;
const BACK = /\s+(?:to taste|for (?:serving|garnish|the pan|greasing|dusting|frying|topping)|as needed|if needed|optional|or more|or less|to serve|divided|plus more.*|at room temperature|room temperature)$/i;

// One line → {name, amount}: "3 cups all-purpose flour, sifted" → {name: "All-purpose flour", amount: "3 cups"}.
export function itemOf(line) {
  const raw = String(line ?? "").replace(/^\s*[-*•]\s+/, "").replace(/\s+/g, " ").trim();
  let s = raw.replace(/\s*\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  let amount = "";
  const take = re => { const m = s.match(re); if (m && m[0]) { amount += (amount ? " " : "") + m[0].trim(); s = s.slice(m[0].length); return true; } return false; };
  for (let i = 0; i < 4; i++) {
    let moved = take(LEAD) || take(UNIT_ONLY);
    // "juice of 1 lemon", "zest of 2 limes": the lemon is what to buy.
    const of = s.match(/^(?:the\s+)?(?:juice|zest|zest and juice|juice and zest)\s+of\s+/i);
    if (of) { s = s.slice(of[0].length); moved = true; }
    const front = s.match(FRONT);
    if (front) { s = s.slice(front[0].length); moved = true; }
    if (!moved) break;
  }
  // What's after a comma is how to prepare it ("butter, melted").
  s = s.split(/\s*[,;:]\s*|\s+[-–—]\s+/)[0];
  while (BACK.test(s)) s = s.replace(BACK, "");
  s = s.replace(/\s+/g, " ").replace(/^[\s.,]+|[\s.,]+$/g, "");
  amount = amount.replace(/\s+of$/i, "").replace(/\s+/g, " ").trim();
  if (!s || !/[a-z]/i.test(s)) return { name: cap(raw.slice(0, 200)) || "?", amount: "" };
  return { name: cap(s.slice(0, 200)), amount };
}

const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

// What makes two names the same thing on a list: case, plurals and punctuation aside.
export const keyOf = name => String(name ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(singular).join(" ");

// [{line, for}] (scaled ingredient lines and who they're for) →
// [{name, for: ["Pancakes"], needs: ["3 cups for Pancakes"]}], one per food, in the order they first come.
export function gather(wants) {
  const out = new Map();
  for (const w of wants) {
    const { name, amount } = itemOf(w.line);
    const key = keyOf(name) || name.toLowerCase();
    if (!out.has(key)) out.set(key, { name, for: [], needs: [] });
    const f = out.get(key);
    if (w.for && !f.for.includes(w.for)) f.for.push(w.for);
    const need = amount ? (w.for ? `${amount} for ${w.for}` : amount) : (w.for ? `For ${w.for}` : "");
    if (need && !f.needs.includes(need)) f.needs.push(need);
  }
  return [...out.values()];
}

// The pantry item you have of `name` (in stock, not running low), or null.
export function inPantry(items, name) {
  return items.find(i => !i.is_out && !i.is_low && listLineIs(i, name)) || null;
}

export async function pantryItems(env, user) {
  if (!user.areas.has("pantry")) return [];
  return (await listItems(env, user)).items;
}

// Foods from gather() onto list `id` (or your Shopping list): each once, merged into
// an open item already there, and left off when your pantry has it.
// → {list, added, merged, have: [{name, text, pantry}]}
// With `pantry: false` (Meal plan, where you've seen what Pantry has and ticked what to buy) nothing is left off.
export async function shopFor(env, user, id, foods, { pantry = true } = {}) {
  const stock = pantry ? await pantryItems(env, user) : [];
  const have = [], buy = [];
  for (const f of foods) {
    const p = inPantry(stock, f.name);
    if (p) have.push({ name: f.name, text: p.text, pantry: p.name });
    else buy.push(f);
  }
  const list = await listFor(env, user, id);
  let added = 0, merged = 0;
  if (buy.length) {
    const open = new Map();
    for (const it of (await collectionWithItems(env, user, list.id))?.items || []) {
      const k = keyOf(itemOf(it.title).name);
      if (it.meta?.checklist && !it.meta.checklist.done && !open.has(k)) open.set(k, it);
    }
    for (const f of buy) {
      const notes = f.needs.join("\n");
      const there = open.get(keyOf(f.name));
      if (there) {
        const old = String(there.notes || "").split("\n");
        const more = f.needs.filter(n => !old.includes(n));
        if (more.length) await updateItem(env, user, there.id, { notes: [...old.filter(Boolean), ...more].join("\n").slice(0, 20000) });
        merged++;
      } else {
        const it = await createItem(env, user, { title: f.name, notes, collection: list.id, meta: { checklist: { done: false, priority: 0 } } });
        open.set(keyOf(f.name), it);
        added++;
      }
    }
  }
  return { list: { id: list.id, name: list.name }, added, merged, have };
}

// Pantry's staples that are running low or out (of `owner`'s pantry, yours or one
// shared with you) onto your list `id` (or your Shopping list), each once: one already
// open there gets the note added. → {list, added, merged, have: [], low, summary}
export async function shopLow(env, user, owner, id, day) {
  if (!user.areas.has("todo")) fail("you need Drift to make a shopping list");
  const low = (await listItems(env, owner, day)).items.filter(i => i.staple && (i.is_low || i.is_out));
  if (!low.length) fail("nothing's running low");
  const foods = low.map(i => ({ name: i.name, for: [], needs: [i.is_out ? "Out, says Pantry" : `${i.text} left, says Pantry (low at ${i.low_text})`] }));
  const out = await shopFor(env, user, id ? String(id) : null, foods, { pantry: false });
  const n = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
  const summary = !out.merged ? `Added ${n(out.added, "item")} to ${out.list.name}.`
    : !out.added ? `${out.merged === 1 ? "It's" : "They're all"} already on ${out.list.name}.`
    : `Added ${n(out.added, "item")} to ${out.list.name}; ${out.merged} ${out.merged === 1 ? "was" : "were"} already on it.`;
  return { ...out, low: low.length, summary };
}

// Which of a recipe's ingredient lines your pantry already has (in stock, not running
// low): [{index, text, pantry}], for the page to show and leave unticked.
export async function haveFor(env, user, lines) {
  const stock = await pantryItems(env, user);
  if (!stock.length) return [];
  return lines.map((line, index) => { const p = inPantry(stock, itemOf(line).name); return p ? { index, text: p.text, pantry: p.name } : null; }).filter(Boolean);
}

// "Added 3 to Shopping list" + what was merged and left off, for the pages and the terminal.
export function shopSummary(out) {
  const n = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
  let s = `Added ${n(out.added, "item")} to ${out.list.name}`;
  if (out.merged) s += `; ${out.merged} already there got the amounts added`;
  if (out.have?.length) s += `. Left off what Pantry has: ${out.have.map(h => h.name.toLowerCase()).join(", ")}`;
  return s + ".";
}
