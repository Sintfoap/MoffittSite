// Recipe text, as it comes off a cookbook page (read by text recognition, or
// pasted), cut into a recipe: title, servings, time, ingredients, steps and
// notes. No AI: it goes by how recipes are laid out. Headings ("Ingredients",
// "Method") when there are any; otherwise the run of lines that start with an
// amount ("2 cups flour") is the ingredients, what comes after is the steps,
// and what comes before is the title and notes. It's a first draft for the
// editor, not the final word. Shared by the page and the Worker (POST
// /recipes/api/text, which the terminal uses).


const GLYPHS = "¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞";
// A line that starts with an amount: "2 cups", "1½", "½", "1/2", "2-3", "a pinch", "one".
const AMOUNT = new RegExp(`^(?:[-*•·]\\s*)?(?:\\d|[${GLYPHS}]|(?:a|an|one|two|three|four|five|six|half|a few|several)\\s+(?:pinch|dash|handful|cup|cups|tbsp|tsp|tablespoons?|teaspoons?|large|medium|small|clove|cloves|can|cans|sprig|sprigs|bunch|stick|sticks|lb|pound|ounce|oz)\\b|(?:pinch|dash|handful)\\b)`, "i");
const UNIT = /\b(cups?|c\.|tbsp|tbs|tsp|tablespoons?|teaspoons?|oz|ounces?|lbs?|pounds?|g|grams?|kg|ml|l|liters?|litres?|cloves?|cans?|pinch|dash|sticks?|slices?|large|medium|small|whole|sprigs?|bunch|handful|packages?|pkg)\b/i;
const NUMBERED = /^(?:step\s*)?(\d{1,2})\s*[.):]\s*(?=\S)/i;
const INGREDIENTS = /^(?:ingredients?|what you(?:'|’)?ll need|you(?:'|’)?ll need|you will need|shopping list)\s*:?$/i;
const STEPS = /^(?:directions?|method|instructions?|preparation|steps?|how to make(?: it)?|to make|procedure)\s*:?$/i;
const NOTES = /^(?:notes?|tips?|cook(?:'|’)?s notes?|variations?|to serve|serving suggestions?|make ahead)\s*:?/i;
const SECTION = /^(?:for (?:the )?.{2,40}|.{2,40}\s(?:sauce|dressing|filling|topping|glaze|frosting|icing|crust|dough|marinade|garnish)):$/i;
const NUMBER = "(?:\\d+|one|two|three|four|five|six|eight|ten|twelve|a dozen|about \\d+)";
const YIELD = new RegExp(`\\b(?:serves|servings?|makes|yields?|portions?)\\b\\s*:?\\s*${NUMBER}\\b`, "i");
const TIME = /\b(?:total|prep(?:aration)?|cook(?:ing)?|bake|baking|active|ready in|time)\b[^.\n]*?\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b/i;

const LIMITS = { title: 200, yield: 100, time: 50, lines: 100, ingredient: 300, step: 3000, notes: 5000, text: 50000 };

// What text recognition gets wrong in recipes, put right: fraction slashes, ligatures, stray marks.
function tidy(text) {
  return String(text ?? "").slice(0, LIMITS.text)
    .replace(/\r\n?/g, "\n").replace(/[⁄∕]/g, "/").replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/[ \t ]+/g, " ")
    .split("\n").map(l => l.trim().replace(/^[|_~]+\s*|\s*[|_~]+$/g, "").replace(/\s+[;,.'‘’`]+$/, ""));
}

const isAmount = l => AMOUNT.test(l);
// Short, with an amount or a unit: an ingredient. A long sentence with a number in it is a step.
const isIngredient = l => !isMeta(l) && (isAmount(l) && l.length <= 90 && !/[.!?]\s+[A-Z]/.test(l)) || (UNIT.test(l) && l.length <= 50 && !/[.!?]$/.test(l) && /\d/.test(l));
const isJunk = l => !l || /^\d{1,3}$/.test(l) || /^[^\p{L}\p{N}]+$/u.test(l) || (l.length <= 2 && !/\d/.test(l));
const isMeta = l => YIELD.test(l) || TIME.test(l);
// "Salt and pepper", "Juice of 1 lemon": a short line among the ingredients is one too.
const isShort = l => l.length <= 45 && !/[.!?:]$/.test(l) && !isMeta(l);
const cut = (s, n) => s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;

// "Serves 4", "Makes 24 cookies" → the number; "Makes one 9x5-inch loaf" → null (9 isn't servings).
function servingsIn(y) {
  const m = y.match(/\b(?:serves|servings?|portions?|makes|yields?)\b\s*:?\s*(?:about\s*)?(\d+)(?:\s*(?:-|–|to)\s*\d+)?(?![\dx×/.]|-?\s*(?:inch|in\b|cm|"))/i);
  const n = m ? Number(m[1]) : NaN;
  return n > 0 && n <= 1000 ? n : null;
}

// Amounts text recognition often misreads: ½ ⅓ ¾ come out as %, ¥, Y2 and the like, or as
// a number that can't be right before a single cup or spoon ("14 cup" for ½ cup).
const MISREAD = /^(?:\d*\s*[%¥£§®©°¢»«]|\d*\s*[Yy]\d\b|[Il|]\s*\/\s*\d|(?:[2-9]|\d{2,})\s+(?:cup|teaspoon|tablespoon)\b)/i;

// "Prep 15 min · Cook 1 hr" → "1 hr 15 min"; "Total time: 45 minutes" → "45 min".
function minutesIn(s) {
  let n = 0, any = false;
  for (const [, v, u] of s.matchAll(/(\d+(?:[.,]\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/gi)) {
    any = true;
    n += /^h/i.test(u) ? parseFloat(v.replace(",", ".")) * 60 : parseFloat(v);
  }
  return any ? Math.round(n) : null;
}
const span = n => [n >= 60 && `${Math.floor(n / 60)} hr`, n % 60 && `${n % 60} min`].filter(Boolean).join(" ");

function timeOf(lines) {
  const text = lines.join("\n");
  const total = text.match(/\b(?:total(?: time)?|ready in)\b\s*:?\s*([^\n·|,;]*?\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b(?:\s*(?:and\s*)?\d+\s*(?:minutes?|mins?|m)\b)?)/i);
  if (total) { const n = minutesIn(total[1]); if (n) return span(n); }
  let sum = 0;
  for (const part of text.matchAll(/\b(?:prep(?:aration)?|cook(?:ing)?|bake|baking|chill|rest(?:ing)?|active)\b(?: time)?\s*:?\s*(\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b(?:\s*(?:and\s*)?\d+\s*(?:minutes?|mins?|m)\b)?)/gi)) {
    sum += minutesIn(part[1]) || 0;
  }
  if (sum) return span(sum);
  // A time on its own in a short line of facts ("makes 24 · 45 min"): the total.
  for (const l of lines) {
    if (l.length > 60) continue;
    for (const part of l.split(/\s+[·•|+~*©:–—-]\s+|\s{2,}/)) {
      if (/^(?:about\s+)?\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m)\.?(?:\s*\d+\s*(?:minutes?|mins?|m)\.?)?$/i.test(part.trim())) return span(minutesIn(part));
    }
  }
  return "";
}

function yieldOf(lines) {
  for (const l of lines) {
    const m = l.match(new RegExp(`\\b((?:serves|servings?|makes|yields?|portions?)\\b\\s*:?\\s*${NUMBER}(?:\\s*(?:-|–|to)\\s*\\d+(?!\\d)(?!\\s*(?:hours?|hrs?|h|minutes?|mins?|m)\\b))?(?:\\s+(?!\\d+\\s*(?:hours?|hrs?|h|minutes?|mins?|m)\\b)[a-z0-9][\\w-]*){0,3})`, "i"));
    if (m) return m[1].replace(/\s+(?:prep|cook|total|time|bake)\b.*$/i, "").trim();
  }
  return "";
}

// Ingredient lines, with wrapped ones put back together ("1 cup flour, plus more" / "for dusting").
function ingredientLines(lines) {
  const out = [];
  for (const l of lines) {
    if (isJunk(l) || INGREDIENTS.test(l)) continue;
    const prev = out[out.length - 1];
    const wrapped = prev && !isAmount(l) && !SECTION.test(l) && !SECTION.test(prev) && (/^[a-z(]/.test(l) || /[,(-]$/.test(prev) || /\b(?:or|and|plus|for|of|to)$/i.test(prev));
    if (wrapped) out[out.length - 1] = `${prev} ${l}`;
    else out.push(l.replace(/^[-*•·]\s*/, ""));
  }
  return out;
}

// Step lines: by their numbers when they're numbered, otherwise by sentences
// that end a line, so a step wrapped over several lines is one step again.
function stepLines(lines) {
  const steps = [];
  const numbered = lines.filter(l => NUMBERED.test(l)).length >= 2;
  let gap = false;
  for (const l of lines) {
    if (!l) { gap = true; continue; }
    if (isJunk(l) || STEPS.test(l)) continue;
    const prev = steps[steps.length - 1];
    const starts = numbered ? NUMBERED.test(l) : !prev || gap || (/[.!?:)]$/.test(prev) && /^[A-Z"“(]/.test(l));
    if (starts || !prev) steps.push(l.replace(NUMBERED, ""));
    else steps[steps.length - 1] = prev.endsWith("-") ? prev.slice(0, -1) + l : `${prev} ${l}`;
    gap = false;
  }
  return steps;
}

// The recipe in the text, or null when there's nothing in it that reads like one.
// `title` is a hint: the line text recognition saw in the biggest type.
export function readRecipe(text, { title = "" } = {}) {
  const lines = tidy(text);
  const at = re => lines.findIndex(l => re.test(l));
  let ing = at(INGREDIENTS), dir = at(STEPS);
  let head, ingredients, steps, tail = [];

  if (ing >= 0 || dir >= 0) {
    // Laid out with headings.
    if (ing < 0) {
      // Only a steps heading: the ingredients are the amount lines before it.
      const before = lines.slice(0, dir);
      let start = before.length;
      const ingish = l => isIngredient(l) || SECTION.test(l);
      while (start > 0) {
        const l = before[start - 1];
        if (ingish(l) || !l || (/^[a-z(]/.test(l) && start < before.length)) start--;
        else if (isShort(l) && start >= 2 && ingish(before[start - 2])) start--;
        else break;
      }
      while (start < before.length && !before[start]) start++;
      head = before.slice(0, start);
      ingredients = before.slice(start);
      steps = lines.slice(dir + 1);
    } else if (dir < 0 || dir < ing) {
      head = lines.slice(0, dir >= 0 ? dir : ing);
      const rest = lines.slice(ing + 1);
      // No steps heading after the ingredients: they end where the amount lines stop.
      let end = 0;
      for (let i = 0; i < rest.length; i++) {
        const l = rest[i];
        if (isIngredient(l) || SECTION.test(l)) { end = i + 1; continue; }
        if (!l) continue;
        if ((/^[a-z(]/.test(l) || isShort(l)) && end === i) { end = i + 1; continue; }  // wrapped, or short
        break;
      }
      ingredients = rest.slice(0, end);
      steps = dir >= 0 && dir < ing ? lines.slice(dir + 1, ing) : rest.slice(end);
      if (dir >= 0 && dir < ing) steps = steps.concat(rest.slice(end));
    } else {
      head = lines.slice(0, ing);
      ingredients = lines.slice(ing + 1, dir);
      steps = lines.slice(dir + 1);
    }
  } else {
    // No headings: the longest run of ingredient lines (blank lines and wrapped bits allowed inside).
    let best = [0, 0], start = -1, lastIng = -1;
    for (let i = 0; i <= lines.length; i++) {
      const l = lines[i];
      const ingLine = i < lines.length && (isIngredient(l) || SECTION.test(l));
      const glue = i < lines.length && start >= 0 && (!l || (lastIng === i - 1 && ((/^[a-z(]/.test(l) && l.length < 60) || isShort(l))));
      if (ingLine) { if (start < 0) start = i; lastIng = i; continue; }
      if (glue) { if (l) lastIng = i; continue; }
      if (start >= 0) {
        const n = lines.slice(start, lastIng + 1).filter(isIngredient).length;
        const bestN = lines.slice(best[0], best[1]).filter(isIngredient).length;
        if (n > bestN) best = [start, lastIng + 1];
        start = -1;
      }
    }
    const n = lines.slice(best[0], best[1]).filter(isIngredient).length;
    if (n < 2) return null;
    head = lines.slice(0, best[0]);
    ingredients = lines.slice(best[0], best[1]);
    steps = lines.slice(best[1]);
  }

  // Notes, tips and the like at the end go to the notes, not the steps.
  const noteAt = steps.findIndex((l, i) => i > 0 && NOTES.test(l));
  if (noteAt > 0) { tail = steps.slice(noteAt); steps = steps.slice(0, noteAt); }

  const headLines = head.filter(l => !isJunk(l));
  const same = (a, b) => a.toLowerCase().replace(/\W+/g, "") === b.toLowerCase().replace(/\W+/g, "");
  const titleLine = (title && headLines.find(l => same(l, title))) ||
    headLines.find(l => !isMeta(l) && l.length <= 80 && !/[.!?,;]$/.test(l) && /\p{L}{2}/u.test(l));
  const time = timeOf(headLines.concat(steps.slice(0, 2), tail));
  const yld = yieldOf(headLines.concat(tail));
  // Not the title, the times and servings, or a cookbook's running head ("BREADS & BAKES").
  const notes = headLines.filter(l => l !== titleLine && !isMeta(l) && !(l === l.toUpperCase() && l.length <= 30)).join(" ").replace(/\s+/g, " ").trim();
  const tailNotes = stepLines(tail).join("\n");

  const r = {
    title: cut(titleCase(titleLine || "") || "Untitled recipe", LIMITS.title),
    yield: cut(yld, LIMITS.yield),
    servings: servingsIn(yld),
    time: cut(time, LIMITS.time),
    ingredients: ingredientLines(ingredients).slice(0, LIMITS.lines).map(l => cut(l, LIMITS.ingredient)),
    steps: stepLines(steps)
      // A line that's only the times ("Prep 15 min · Cook 1 hr") isn't a step; a sentence with a time in it is.
      .filter(l => !(isMeta(l) && !/[.!?]$/.test(l) && l.length <= 50)).slice(0, LIMITS.lines).map(l => cut(l, LIMITS.step)),
    notes: cut([notes, tailNotes].filter(Boolean).join("\n\n"), LIMITS.notes),
    source: "",
  };
  if (!r.ingredients.length && !r.steps.length) return null;
  // Lines to look at twice, for the editor to point out.
  r.check = r.ingredients.filter(l => MISREAD.test(l));
  return r;
}

// Cookbooks often set titles in capitals: "CLASSIC BANANA BREAD" → "Classic Banana Bread".
function titleCase(s) {
  if (!s || s !== s.toUpperCase() || !/[A-Z]{3}/.test(s)) return s;
  const small = new Set(["a", "an", "and", "the", "of", "with", "in", "on", "for", "or", "to", "at", "by"]);
  return s.toLowerCase().split(" ").map((w, i) => i && small.has(w) ? w : w.replace(/^\p{L}/u, c => c.toUpperCase())).join(" ");
}
