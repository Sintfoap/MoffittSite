// Pantry amounts: reading "10 lb", "2 1/2 cups" or "500 g" into one base unit
// (grams for weight, millilitres for volume), and writing a base amount back in
// the unit someone thinks in. Shared by the page and the Worker (src/pantry.js),
// which does the real work; the page only uses it to show what a typed amount
// means before it's saved.
//
// Cups and grams are bridged by an item's grams per cup. guess() suggests that,
// the item's kind and where it's kept from its name, the first time it's added.

// Numbers are read and written as in public/recipes/scale.js, but kept here:
// /recipes/ is only served to people with Recipe box, and Pantry stands alone.
const GLYPH = { "¼": 1 / 4, "½": 1 / 2, "¾": 3 / 4, "⅓": 1 / 3, "⅔": 2 / 3, "⅕": 1 / 5, "⅖": 2 / 5, "⅗": 3 / 5, "⅘": 4 / 5,
  "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8 };
function number(text) {
  const s = text.trim();
  let m;
  if ((m = s.match(/^(\d+)\s*(\D)$/)) && GLYPH[m[2]] !== undefined) return +m[1] + GLYPH[m[2]];
  if ((m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/))) return +m[3] ? +m[1] + m[2] / m[3] : NaN;
  if ((m = s.match(/^(\d+)\/(\d+)$/))) return +m[2] ? m[1] / m[2] : NaN;
  if (GLYPH[s] !== undefined) return GLYPH[s];
  return Number(s.replace(",", "."));
}
// The nearest kitchen fraction when it's close, otherwise two decimals.
const NICE = [[0, ""], [1 / 8, "⅛"], [1 / 4, "¼"], [1 / 3, "⅓"], [3 / 8, "⅜"], [1 / 2, "½"], [5 / 8, "⅝"], [2 / 3, "⅔"], [3 / 4, "¾"], [7 / 8, "⅞"], [1, ""]];
export function format(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const whole = Math.floor(n), frac = n - whole;
  let best = NICE[0];
  for (const c of NICE) if (Math.abs(frac - c[0]) < Math.abs(frac - best[0])) best = c;
  if (Math.abs(frac - best[0]) <= 0.04) {
    const w = best[0] === 1 ? whole + 1 : whole;
    return best[1] ? (w ? `${w}${best[1]}` : best[1]) : String(w);
  }
  return String(Math.round(n * 100) / 100);
}

// Each unit: what it measures, its size in the base unit, and how it's written.
export const UNITS = {
  g: { measure: "weight", base: 1, one: "g", many: "g" },
  kg: { measure: "weight", base: 1000, one: "kg", many: "kg" },
  mg: { measure: "weight", base: 0.001, one: "mg", many: "mg" },
  oz: { measure: "weight", base: 28.349523125, one: "oz", many: "oz" },
  lb: { measure: "weight", base: 453.59237, one: "lb", many: "lb" },
  ml: { measure: "volume", base: 1, one: "ml", many: "ml" },
  l: { measure: "volume", base: 1000, one: "L", many: "L" },
  tsp: { measure: "volume", base: 4.92892159375, one: "tsp", many: "tsp" },
  tbsp: { measure: "volume", base: 14.78676478125, one: "tbsp", many: "tbsp" },
  cup: { measure: "volume", base: 236.5882365, one: "cup", many: "cups" },
  floz: { measure: "volume", base: 29.5735295625, one: "fl oz", many: "fl oz" },
  pint: { measure: "volume", base: 473.176473, one: "pint", many: "pints" },
  quart: { measure: "volume", base: 946.352946, one: "quart", many: "quarts" },
  gallon: { measure: "volume", base: 3785.411784, one: "gallon", many: "gallons" },
};
export const ML_PER_CUP = UNITS.cup.base;

// What people type, to the unit it means.
const SAID = {
  g: "g", gs: "g", gm: "g", gms: "g", gr: "g", gram: "g", grams: "g", gramme: "g", grammes: "g",
  kg: "kg", kgs: "kg", kilo: "kg", kilos: "kg", kilogram: "kg", kilograms: "kg",
  mg: "mg", milligram: "mg", milligrams: "mg",
  oz: "oz", ozs: "oz", ounce: "oz", ounces: "oz",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  ml: "ml", mls: "ml", millilitre: "ml", millilitres: "ml", milliliter: "ml", milliliters: "ml", cc: "ml",
  l: "l", ls: "l", litre: "l", litres: "l", liter: "l", liters: "l", ltr: "l",
  tsp: "tsp", tsps: "tsp", teaspoon: "tsp", teaspoons: "tsp",
  tbsp: "tbsp", tbsps: "tbsp", tbs: "tbsp", tbl: "tbsp", tblsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
  cup: "cup", cups: "cup", c: "cup",
  floz: "floz", "fl oz": "floz", "fl. oz": "floz", "fluid ounce": "floz", "fluid ounces": "floz",
  pt: "pint", pts: "pint", pint: "pint", pints: "pint",
  qt: "quart", qts: "quart", quart: "quart", quarts: "quart",
  gal: "gallon", gals: "gallon", gallon: "gallon", gallons: "gallon",
};

const GLYPHS = "¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞";
const NUMBER = `(\\d+\\s*[${GLYPHS}]|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d*[.,]\\d+|\\d+|[${GLYPHS}])`;
const AMOUNT = new RegExp(`^\\s*${NUMBER}\\s*(.*?)\\s*\\.?\\s*$`, "i");

// "2 1/2 cups" → {n: 2.5, unit: "cup"}; "3" → {n: 3, unit: null}; "3 cans" → {n: 3, unit: null, word: "cans"}.
// Anything without a number at the start is null.
export function readAmount(text) {
  const m = String(text ?? "").replace(/\s+/g, " ").match(AMOUNT);
  if (!m) return null;
  const n = number(m[1].replace(/^\./, "0."));
  if (!Number.isFinite(n) || n < 0) return null;
  const rest = m[2].toLowerCase().replace(/\s*\.\s*/g, ". ").trim().replace(/\.$/, "");
  if (!rest) return { n, unit: null };
  const unit = SAID[rest] ?? SAID[rest.replace(/\.\s*/g, " ").trim()] ?? SAID[rest.replace(/[.\s]/g, "")];
  return unit ? { n, unit } : { n, unit: null, word: rest };
}

// A base amount (g or ml) in a unit, as a cook would write it: kitchen
// fractions for cups and pounds, whole numbers for grams and millilitres.
export function inUnit(base, unit) {
  const u = UNITS[unit];
  const v = base / u.base;
  const shown = unit === "g" || unit === "ml" ? String(Math.round(v)) : format(v) === "0" && v > 0 ? String(Math.round(v * 100) / 100 || "<0.01") : format(v);
  return `${shown} ${v < 1.005 ? u.one : u.many}`;
}

// The units of a measure, smallest first (for picking how to show an amount).
export const unitsOf = measure => Object.entries(UNITS).filter(([, u]) => u.measure === measure).map(([k]) => k);

// Counted things: "can" → "cans", "box" → "boxes", "loaf" → "loaves".
const IRREGULAR = { loaf: "loaves", knife: "knives", leaf: "leaves", half: "halves", potato: "potatoes", tomato: "tomatoes", mango: "mangoes" };
export function plural(word) {
  const w = String(word || "").trim();
  if (!w) return w;
  if (IRREGULAR[w.toLowerCase()]) return IRREGULAR[w.toLowerCase()];
  if (/(s|x|z|ch|sh)$/i.test(w)) return w + "es";
  if (/[^aeiou]y$/i.test(w)) return w.slice(0, -1) + "ies";
  return w + "s";
}
export function singular(word) {
  const w = String(word || "").trim();
  const back = Object.entries(IRREGULAR).find(([, many]) => many === w.toLowerCase());
  if (back) return back[0];
  if (/ies$/i.test(w) && w.length > 4) return w.slice(0, -3) + "y";
  if (/(ses|xes|zes|ches|shes)$/i.test(w)) return w.slice(0, -2);
  if (/[^s]s$/i.test(w) && w.length > 2) return w.slice(0, -1);
  return w;
}
export const counted = (n, unit) => `${format(n) === "0" && n > 0 ? n : format(n)} ${n === 1 ? unit : plural(unit)}`;

// A gauged item's level: 5 is full, 0 is empty.
export const LEVELS = ["Empty", "Almost out", "¼ left", "½ left", "¾ left", "Full"];

// ── guessing from a name ────────────────────────────────────────────────────
// Only a starting point: the kind, place and grams per cup can all be changed.

// Grams in one US cup of common staples (King Arthur's ingredient weight chart, rounded).
const PER_CUP = [
  [/powdered sugar|icing sugar|confectioner/, 120], [/brown sugar/, 213], [/sugar/, 200],
  [/bread flour/, 120], [/cake flour/, 120], [/almond flour/, 96], [/flour/, 120],
  [/cornmeal|polenta/, 138], [/cornstarch|corn starch/, 112], [/cocoa/, 84], [/rolled oats|oats|oatmeal/, 89],
  [/rice/, 198], [/quinoa/, 170], [/lentil/, 192], [/dried beans|black beans|pinto|chickpea/, 184],
  [/butter/, 227], [/shortening/, 184], [/honey|molasses|maple syrup|corn syrup/, 336],
  [/oil/, 198], [/milk/, 227], [/water/, 236], [/salt/, 288], [/baking soda/, 220], [/baking powder/, 192],
  [/chocolate chip/, 170], [/raisin/, 149], [/walnut|pecan/, 113], [/almond/, 142], [/peanut butter/, 270], [/breadcrumb/, 112],
  [/pasta|macaroni/, 105],
];
const SPICES = /\b(salt|pepper|peppercorns?|cumin|paprika|cinnamon|nutmeg|oregano|basil|thyme|rosemary|sage|parsley|dill|bay leaf|bay leaves|cayenne|chili powder|chilli|curry|turmeric|ginger|garlic powder|onion powder|cloves|allspice|cardamom|coriander|fennel|mustard seed|seasoning|spice|vanilla|extract|bouillon|msg|sprinkles|food colou?ring|baking soda|baking powder|yeast|cream of tartar|soy sauce|vinegar|hot sauce|worcestershire|ketchup|mustard|mayo|mayonnaise|sriracha|honey|syrup)\b/;
const STAPLES = /\b(flour|sugar|oil|rice|oats|oatmeal|cornmeal|cornstarch|quinoa|lentils|butter|milk|cocoa|shortening|polenta|semolina|breadcrumbs|coffee|tea)\b/;
const FRIDGE = /\b(milk|butter|cheese|yogurt|yoghurt|eggs?|cream|tofu|lettuce|spinach|leftovers?|ham|bacon|chicken|beef|pork|fish|salmon|sausages?|steaks?|juice|mayo|mayonnaise|hummus|salsa)\b/;
const FREEZER = /\b(frozen|ice cream|peas)\b/;

// {kind, place, unit?, perCup?} for a new item called `name`.
export function guess(name) {
  const n = ` ${String(name || "").toLowerCase()} `;
  // An explicit container wins (a can of soup is counted, whatever's in it).
  const container = n.match(/\b(can|tin|jar|box|bottle|carton|pack|packet|bag|loaf)s?\b/)?.[1];
  const kind = container ? "counted" : STAPLES.test(n) ? "staple" : SPICES.test(n) ? "gauged" : "counted";
  const place = FREEZER.test(n) ? "Freezer" : FRIDGE.test(n) ? "Fridge" : kind === "gauged" ? "Spice rack" : "Cupboard";
  const out = { kind, place };
  if (kind === "counted") out.unit = container || (/\beggs?\b/.test(n) ? "egg" : /\b(loaf|bread)\b/.test(n) ? "loaf" : /\bsoup|beans|tuna|broth\b/.test(n) ? "can" : "");
  const cup = PER_CUP.find(([re]) => re.test(n));
  if (cup) out.perCup = cup[1];
  return out;
}

// ── how long things keep ────────────────────────────────────────────────────
// Days a thing usually keeps once bought, for an expiry date when nothing
// better is known (a receipt doesn't print them). Shown as an estimate, never
// as the real date. Rough figures in the spirit of the USDA's FoodKeeper,
// erring on the short side; the first match wins.
const KEEPS = [
  [/\b(cans?|canned|tins?|tinned|soup|broth|stock|tuna)\b/, 730],
  [/\b(ground (beef|turkey|pork|chicken|meat)|mince)\b/, 2], [/\b(fish|salmon|shrimp|tilapia|cod)\b/, 2],
  [/\b(chicken|turkey|pork|beef|steaks?|chops?|lamb)\b/, 3], [/\b(berries|strawberr|raspberr|blueberr|blackberr)\w*/, 5],
  [/\b(lettuce|spinach|greens|salad|herbs?|cilantro|parsley|basil)\b/, 6], [/\bmilk\b/, 7], [/\b(bread|buns?|rolls?|bagels?|tortillas?)\b/, 7],
  [/\b(bananas?|avocados?|tomato(es)?|peaches|pears?|grapes)\b/, 6], [/\b(bacon|ham|deli|sausages?|hot dogs?|lunch meat)\b/, 7],
  [/\b(yogh?urt|sour cream|cottage cheese|cream cheese|cream)\b/, 14], [/\b(hummus|salsa|tofu)\b/, 7],
  [/\b(peppers?|cucumbers?|zucchini|broccoli|cauliflower|mushrooms?|celery)\b/, 7], [/\b(cheese)\b/, 28], [/\beggs?\b/, 28],
  [/\b(apples?|oranges?|lemons?|limes?|carrots?|cabbage)\b/, 21], [/\b(potato(es)?|onions?|garlic|squash|sweet potato(es)?)\b/, 30],
  [/\bbutter\b/, 60], [/\b(juice)\b/, 10], [/\bfrozen\b/, 180], [/\bwhole wheat flour|whole grain flour\b/, 90], [/\b(flour|cornmeal)\b/, 180],
  [/\b(nuts|almonds|walnuts|pecans|peanuts)\b/, 120], [/\b(cereal|crackers|chips|cookies)\b/, 90], [/\b(oil)\b/, 365],
  [/\b(rice|beans|pasta|noodles|spaghetti|macaroni|oats|lentils|sugar|honey|salt)\b/, 730],
];
export function keepsFor(name, kind = "counted", place = "Cupboard") {
  const n = ` ${String(name || "").toLowerCase()} `;
  if (place === "Freezer" && !/\bfrozen\b/.test(n)) return 180;
  const hit = KEEPS.find(([re]) => re.test(n));
  if (hit) return hit[1];
  return kind === "gauged" ? 730 : place === "Fridge" ? 7 : place === "Freezer" ? 180 : 365;
}
// That as a date, from `day` (YYYY-MM-DD).
export function estimateExpiry(name, kind, place, day) {
  return new Date(Date.parse(day + "T00:00:00Z") + keepsFor(name, kind, place) * 864e5).toISOString().slice(0, 10);
}
