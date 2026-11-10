// Cuts an export file into one piece per recipe, for POST /recipes/api/recipes/import
// (src/recipes.js). Recipe Keeper's HTML export puts each recipe in a
// <div class="recipe-details">; anything else is one page, sent whole.
// The terminal does the same in cli/sintfoap/recipe_rules.py (split_pages).

const START = /<div\b[^>]*class\s*=\s*["']?recipe-details\b[^>]*>/gi;

export function splitPages(html) {
  const at = [...html.matchAll(START)].map(m => m.index);
  if (!at.length) return html.trim() ? [html] : [];
  return at.map((from, i) => html.slice(from, at[i + 1] ?? html.length));
}

// Pages in groups to send: at most `count` a request, and about `bytes` of HTML.
export function batches(pages, count = 10, bytes = 1024 * 1024) {
  const out = [];
  let cur = [], size = 0;
  for (const p of pages) {
    if (cur.length && (cur.length >= count || size + p.length > bytes)) { out.push(cur); cur = []; size = 0; }
    cur.push(p);
    size += p.length;
  }
  if (cur.length) out.push(cur);
  return out;
}
