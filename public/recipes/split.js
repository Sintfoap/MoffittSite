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

// The picture a Recipe Keeper export piece points at ("images/<id>_0.jpg"),
// a file beside the export, or "" when it has none or links to the web.
export function photoOf(page) {
  const img = page.match(/<img\b[^>]*class\s*=\s*["']?recipe-photo\b[^>]*>/i)?.[0]
    || page.match(/<img\b[^>]*itemprop\s*=\s*["']?photo0\b[^>]*>/i)?.[0] || "";
  const src = img.match(/src\s*=\s*["']([^"']+)["']/i)?.[1] || "";
  return src && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src) ? src : "";
}

// Matching a picture to a file: by its name alone, whatever folder it came in.
export function fileKey(path) {
  const name = String(path).split(/[\\/]/).pop() || "";
  try { return decodeURIComponent(name).toLowerCase(); } catch { return name.toLowerCase(); }
}
