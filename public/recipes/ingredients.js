// Finding recipes by what's in them: "eggs, spinach" finds the recipes with
// both, and "-nuts" leaves out any with nuts. A word matches where a word in
// an ingredient line starts, so "oil" finds "olive oil" but not "boil" (one
// to leave out matches anywhere, so "-nuts" leaves out walnuts too), and
// singular and plural find each other ("tomato", "tomatoes"; "berry",
// "berries"). Case and accents don't matter ("jalapeno", "Jalapeño").
// cli/sintfoap/recipe_rules.py is the same in Python, and
// cli/tests/ingredient_cases.json keeps the two in step.

const plain = s => String(s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// The part of a word both its forms start with: tomatoes → tomato, berries → berr, eggs → egg.
export function stem(word) {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return word.slice(0, -3);
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1);
  if (/(?:o|s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/[^s]s$/.test(word)) return word.slice(0, -1);
  return word;
}

// "Eggs, -nuts" → [{text: "eggs", without: false}, {text: "nuts", without: true}].
export function ingredientTerms(text) {
  const out = [];
  for (const piece of String(text || "").split(/[,;]/)) {
    let t = plain(piece).replace(/\s+/g, " ").trim();
    const without = /^(?:-|no |without )/.test(t);
    if (without) t = t.replace(/^(?:-|no |without )\s*/, "");
    if (!t) continue;
    const words = t.split(" ");
    words.push(stem(words.pop()));
    const esc = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    out.push({ text: t, without, re: new RegExp(`${without ? "" : "(?:^|[^\\p{L}\\p{N}])"}${esc}`, "u") });
  }
  return out;
}

// The indexes of the recipe's ingredient lines that a term looks for, or null
// if the recipe doesn't have every one (or has one it's meant to be without).
export function ingredientHits(recipe, terms) {
  const lines = (recipe.ingredients || []).map(plain);
  const hits = new Set();
  for (const t of terms) {
    const at = lines.flatMap((l, i) => t.re.test(l) ? [i] : []);
    if (t.without ? at.length : !at.length) return null;
    if (!t.without) at.forEach(i => hits.add(i));
  }
  return [...hits].sort((a, b) => a - b);
}
