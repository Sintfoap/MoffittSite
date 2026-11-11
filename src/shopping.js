// The week's shopping, made shorter: the same ingredient from several recipes
// is added up into one line (1 egg, 2 eggs and 6 eggs are 9 eggs), every line
// is filed under the part of the shop it's in, and staples most kitchens keep
// (salt, pepper, oil, water) are marked so the page can leave them unticked.
// Pure functions; src/meals.js feeds them the week's scaled lines.

import { amount, format } from "../public/recipes/scale.js";

const GLYPHS = "¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞";
const QTY = new RegExp(`^\\s*(\\d+\\s*[${GLYPHS}]|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:\\.\\d+)?|[${GLYPHS}])\\s*`);

// Units, by every way they're written, to the one name they're added up under.
const UNITS = {
  cup: ["cup", "cups", "c"], tbsp: ["tbsp", "tbsps", "tablespoon", "tablespoons", "tbs", "tbl"], tsp: ["tsp", "tsps", "teaspoon", "teaspoons"],
  lb: ["lb", "lbs", "pound", "pounds"], oz: ["oz", "ounce", "ounces"], g: ["g", "gram", "grams"], kg: ["kg", "kilogram", "kilograms"],
  ml: ["ml", "milliliter", "milliliters", "millilitre", "millilitres"], l: ["l", "liter", "liters", "litre", "litres"],
  can: ["can", "cans", "tin", "tins"], jar: ["jar", "jars"], clove: ["clove", "cloves"], bunch: ["bunch", "bunches"],
  pinch: ["pinch", "pinches"], slice: ["slice", "slices"], stick: ["stick", "sticks"], package: ["package", "packages", "pkg", "packet", "packets"],
};
const UNIT_OF = new Map(Object.entries(UNITS).flatMap(([k, ws]) => ws.map(w => [w, k])));
const UNIT_RE = new RegExp(`^(${[...UNIT_OF.keys()].sort((a, b) => b.length - a.length).join("|")})\\.?\\s+(?:of\\s+)?`, "i");

// "eggs" → "egg", "tomatoes" → "tomato", "leaves" stays close enough: only for matching, never shown.
const singular = w => w.replace(/(?:oes)$/, "o").replace(/ies$/, "y").replace(/([^s])s$/, "$1");
const keyName = name => name.toLowerCase().replace(/\(.*?\)/g, "").replace(/,.*$/, "").replace(/[^a-z0-9 ]+/g, " ").trim().split(/\s+/).map(singular).join(" ");

// A line as {qty, unit, unitText, name}, or null when it doesn't start with a number.
export function parseLine(line) {
  const m = String(line).match(QTY);
  if (!m) return null;
  const qty = amount(m[1]);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  let rest = String(line).slice(m[0].length);
  if (/^(?:-|–|to|or)\s*\d/.test(rest)) return null;   // a range: left as it is
  const u = rest.match(UNIT_RE);
  let unit = "", unitText = "";
  if (u) { unit = UNIT_OF.get(u[1].toLowerCase()); unitText = u[1]; rest = rest.slice(u[0].length); }
  const name = rest.trim();
  return name ? { qty, unit, unitText, name } : null;
}

// A merged line, in words: "2 cups flour", "9 eggs".
function written({ qty, unit, unitText, name }) {
  const many = qty > 1;
  if (unit) {
    const plural = UNITS[unit].find(w => w === unitText.toLowerCase() + "s" || w === unitText.toLowerCase() + "es");
    return `${format(qty)} ${many && plural ? plural : unitText} ${name}`;
  }
  if (many && /[a-z]$/i.test(name) && !/s$/i.test(name)) name = /[^aeiou]o$/i.test(name) ? name + "es" : /[^aeiou]y$/i.test(name) ? name.slice(0, -1) + "ies" : name + "s";
  return `${format(qty)} ${name}`;
}

// Lines that are the same thing in the same unit are added up; the rest stay
// as they are. Each item is {line, for: [...]} and keeps the order it first came in.
export function mergeLines(items) {
  const out = [], byKey = new Map();
  for (const it of items) {
    const p = parseLine(it.line);
    const key = p ? `${p.unit}|${keyName(p.name)}` : `=${it.line.toLowerCase()}`;
    const have = byKey.get(key);
    if (!have) { const e = { ...it, for: [...it.for], parsed: p }; byKey.set(key, e); out.push(e); continue; }
    for (const f of it.for) if (!have.for.includes(f)) have.for.push(f);
    if (p && have.parsed) {
      // Keep the words of whichever line had more (so "6 eggs", not "1 egg").
      const words = p.qty > have.parsed.qty ? p : have.parsed;
      have.parsed = { ...words, qty: have.parsed.qty + p.qty };
      have.line = written(have.parsed);
    }
  }
  return out.map(({ parsed, ...rest }) => rest);
}

// ── where in the shop ──────────────────────────────────────────────────────

export const AISLES = ["Produce", "Meat & fish", "Dairy & eggs", "Bakery", "Pantry"];
const words = s => new RegExp(`\\b(?:${s.trim().split(/\s*\|\s*/).join("|")})(?:e?s)?\\b`, "i");
// Checked in this order, so "chicken stock" is Pantry and "coconut milk" isn't Dairy.
const RULES = [
  ["Pantry", words(`stock | broth | sauce | paste | powder | can | jar | tin | dried | ground | flour | sugar | rice | noodle | pasta | spaghetti | oil | vinegar
    | cumin | cinnamon | paprika | oregano | nutmeg | chili flake | baking | yeast | oat | coconut milk | chocolate | honey | syrup | bean | lentil | chickpea
    | breadcrumb | cornstarch | extract | marinara | salsa | ketchup | mustard | mayo | mayonnaise | chipotle | arborio | quinoa | couscous | nut | almond | raisin`)],
  ["Meat & fish", words("chicken | beef | lamb | pork | sausage | bacon | turkey | ham | steak | mince | fish | salmon | tuna | cod | shrimp | prawn | chorizo | shoulder | thigh | breast")],
  ["Dairy & eggs", words("egg | milk | butter | cheese | parmesan | mozzarella | ricotta | feta | cotija | cheddar | cream | yogurt | yoghurt | buttermilk | creme fraiche")],
  ["Bakery", words("tortilla | bread | bun | roll | pita | naan | baguette | pie crust | pastry | wrap")],
  ["Produce", words(`onion | garlic | carrot | potato | apple | banana | pepper | avocado | lime | lemon | orange | basil | thyme | sage | rosemary | cilantro | coriander
    | parsley | mint | dill | broccoli | eggplant | aubergine | squash | zucchini | courgette | tomato | corn | ginger | scallion | shallot | leek | lettuce
    | spinach | kale | cabbage | mushroom | celery | cucumber | pumpkin | berry | berries | pear | grape | herb | chive | bok choy | green bean | pea | sprout`)],
];
const STAPLE = /^(?:(?:kosher |sea |table |fine )?salt|(?:freshly )?(?:ground )?(?:black )?pepper|salt and (?:black )?pepper|water|(?:cold |warm |hot |boiling )?water|ice|(?:extra[- ]virgin )?olive oil|(?:vegetable|canola|neutral|cooking) oil|cooking spray)\b/i;

export function aisleOf(line) {
  const p = parseLine(line);
  const name = (p ? p.name : String(line)).toLowerCase();
  if (p && (p.unit === "can" || p.unit === "jar")) return "Pantry";
  for (const [aisle, re] of RULES) if (re.test(name)) return aisle;
  return "Pantry";
}

export function isStaple(line) {
  const p = parseLine(line);
  const name = (p ? p.name : String(line)).replace(/\bto taste\b.*$/i, "").trim();
  return STAPLE.test(name) || /^\s*(?:salt|pepper)[^a-z]*(?:to taste)?\s*$/i.test(name);
}

// Merged, filed and ordered: [{line, for, aisle, staple}], the aisles in AISLES
// order and the staples last of all.
export function arrange(items) {
  const merged = mergeLines(items).map(it => ({ ...it, aisle: aisleOf(it.line), staple: isStaple(it.line) }));
  const rank = it => it.staple ? AISLES.length : AISLES.indexOf(it.aisle);
  return merged.map((it, i) => [it, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([it]) => it);
}
