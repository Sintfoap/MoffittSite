// Scaling a recipe's ingredient lines: the quantity at the start of a line
// ("1 1/2 cups", "1½", "2-3 cloves", "0.5 kg") is multiplied and written back
// as a kitchen fraction where one is close. Lines without a leading number
// ("salt to taste") stay as they are. Shared by the page and the Worker (which
// scales what it sends to Drift); cli/sintfoap/recipe_rules.py is the same in
// Python, and cli/tests/scale_cases.json keeps the two in step.

const GLYPHS = { "¼": 1 / 4, "½": 1 / 2, "¾": 3 / 4, "⅓": 1 / 3, "⅔": 2 / 3, "⅕": 1 / 5, "⅖": 2 / 5, "⅗": 3 / 5, "⅘": 4 / 5,
  "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8 };
const G = Object.keys(GLYPHS).join("");
// One amount: 1 1/2, 1½, 1/2, 1.5, ½, 2.
const AMOUNT = `(?:\\d+\\s*[${G}]|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:[.,]\\d+)?|[${G}])`;
// An amount at the start of the line, maybe a range (2-3, 2 to 3).
const LEAD = new RegExp(`^(\\s*(?:[-*•]\\s+)?)(${AMOUNT})(?:(\\s*(?:-|–|—|to|or)\\s*)(${AMOUNT}))?`, "i");

// The nearest of these, if it's within NEAR, is written as its glyph.
const NICE = [[0, ""], [1 / 8, "⅛"], [1 / 4, "¼"], [1 / 3, "⅓"], [3 / 8, "⅜"], [1 / 2, "½"], [5 / 8, "⅝"], [2 / 3, "⅔"], [3 / 4, "¾"], [7 / 8, "⅞"], [1, ""]];
const NEAR = 0.04;

export function amount(text) {
  const s = text.trim();
  let m;
  if ((m = s.match(new RegExp(`^(\\d+)\\s*([${G}])$`)))) return +m[1] + GLYPHS[m[2]];
  if ((m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/))) return +m[3] ? +m[1] + m[2] / m[3] : NaN;
  if ((m = s.match(/^(\d+)\/(\d+)$/))) return +m[2] ? m[1] / m[2] : NaN;
  if (GLYPHS[s] !== undefined) return GLYPHS[s];
  return Number(s.replace(",", "."));
}

export function format(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const whole = Math.floor(n), frac = n - whole;
  let best = NICE[0];
  for (const c of NICE) if (Math.abs(frac - c[0]) < Math.abs(frac - best[0])) best = c;
  if (Math.abs(frac - best[0]) <= NEAR) {
    const w = best[0] === 1 ? whole + 1 : whole;
    return best[1] ? (w ? `${w}${best[1]}` : best[1]) : String(w);
  }
  return String(Math.round(n * 100) / 100);
}

// One line, multiplied by `factor`.
export function scaleLine(line, factor) {
  const text = String(line ?? "");
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return text;
  const m = text.match(LEAD);
  if (!m) return text;
  const a = amount(m[2]), b = m[4] === undefined ? null : amount(m[4]);
  if (!Number.isFinite(a) || (b !== null && !Number.isFinite(b))) return text;
  const out = format(a * factor) + (b === null ? "" : m[3] + format(b * factor));
  return m[1] + out + text.slice(m[0].length);
}

// The serving count in a recipe's yield ("4", "Serves 4-6", "12 cookies"), or null.
export function servingsOf(yieldText) {
  const m = String(yieldText ?? "").match(/\d+(?:\.\d+)?/);
  const n = m ? Number(m[0]) : NaN;
  return n > 0 && n <= 1000 ? n : null;
}

// How much to multiply by: new servings over the recipe's, or a plain factor
// when the recipe doesn't say how many it serves.
export function factorFor(recipe, { servings, factor } = {}) {
  const f = recipe?.servings && Number(servings) > 0 ? Number(servings) / recipe.servings : Number(factor) || 1;
  return Math.min(100, Math.max(0.05, f));
}
