// Suggested labels: labels from the Recipe labels list that a recipe's own
// words point to, for Recipe box's "Suggest labels" button (and the terminal's
// L). No AI and no key: plain keyword matching, so it's quick across a box of
// hundreds and always gives the same answer.
//
// What a label matches:
//   - its value, as a whole word or phrase: Cuisine: Irish matches "Irish stew";
//     a label with no value (Favorite) matches only its keywords
//   - its keywords, set on the label in Recipe labels: Season: Fall with
//     "pumpkin, squash, apple cider" matches a recipe with any of them
//   - a keyword starting with "-" is a phrase to ignore: Season: Fall with
//     "-fall apart" doesn't count "falls apart" in the steps
// Matching ignores case and accents, and a word's plural counts too
// (tomato → tomatoes, berry → berries). It reads the title, ingredients, steps
// and notes (where an import keeps Recipe Keeper's own categories), and says
// which word matched where, so a suggestion can be checked before it's added.
//
// /recipes/api/recipes/suggest-labels  GET → {suggestions: [{id, title, labels: [{id, key, value, word, where}]}], checked, labels}
// /recipes/api/recipes/add-labels      POST {add: [{id, labels: [label ids]}]} → {recipes, labels, full}: added to what's there

export const KEYWORD_LIMITS = { keywords: 40, keyword: 60 };
const FIELDS = ["title", "ingredients", "steps", "notes"];

// Lowercase letters and digits, one space between words, a space at each end.
export function normalize(s) {
  const flat = String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return flat ? ` ${flat} ` : " ";
}

// "pumpkin, Squash, pumpkin" → ["pumpkin", "Squash"]: once each, ignoring case.
export function splitKeywords(v) {
  const parts = Array.isArray(v) ? v.map(x => String(x ?? "")) : String(v ?? "").split(",");
  const out = [], seen = new Set();
  for (const p of parts) {
    const k = p.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().replace(/^-\s+/, "-");
    if (!k || k === "-" || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
  }
  return out;
}

// A word's plural allowed: tomato → tomatoes, berry → berries.
const plural = w => /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}(?:y|ies)` : `${w}(?:s|es)?`;

// A word or phrase as a pattern over normalized text, its last word's plural
// allowed (every word's, for a phrase to ignore: "falls apart" too).
function pattern(term, everyWord = false) {
  const words = normalize(term).trim().split(" ").filter(Boolean);
  if (!words.length) return null;
  const last = words.pop();
  return new RegExp(` (${[...(everyWord ? words.map(plural) : words), plural(last)].join(" ")}) `);
}

// What one label looks for: [{term, re}] to find and [re] to ignore.
export function termsOf(label) {
  const find = [], ignore = [];
  const kws = splitKeywords(label.keywords);
  for (const t of [label.value, ...kws.filter(k => !k.startsWith("-"))]) {
    const re = t && pattern(t);
    if (re && !find.some(f => f.re.source === re.source)) find.push({ term: t, re });
  }
  for (const k of kws.filter(k => k.startsWith("-"))) {
    const re = pattern(k.slice(1), true);
    if (re) ignore.push(new RegExp(re.source, "g"));
  }
  return { find, ignore };
}

const textOf = (r, f) => normalize(Array.isArray(r[f]) ? r[f].join(" \n ") : r[f]);

// The labels a recipe doesn't have yet that its words point to, in the list's
// order, each with the word that matched and where: [{id, key, value, word, where}].
// terms: label id → termsOf(label), worked out once for the whole box.
export function suggestFor(recipe, labels, terms = new Map(labels.map(l => [l.id, termsOf(l)]))) {
  const have = new Set((recipe.labels || []).map(l => typeof l === "string" ? l : l.id));
  const texts = FIELDS.map(f => [f, textOf(recipe, f)]);
  const out = [];
  for (const l of labels) {
    if (have.has(l.id)) continue;
    const { find, ignore } = terms.get(l.id) || termsOf(l);
    if (!find.length) continue;
    let hit = null;
    for (const [where, raw] of texts) {
      // Space-padded, so an ignored phrase leaves the words either side apart.
      const text = ignore.reduce((t, re) => t.replace(re, "  "), raw);
      for (const f of find) {
        const m = text.match(f.re);
        if (m) { hit = { word: m[1], where }; break; }
      }
      if (hit) break;
    }
    if (hit) out.push({ id: l.id, key: l.key, value: l.value, ...hit });
  }
  return out;
}
