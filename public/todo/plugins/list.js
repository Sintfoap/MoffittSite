// Lists: items in your own order, nested as an outline.
// meta.list = { order, parent }   parent is another item's id, or null at the top

import { icon } from "../lib.js";

const ID = /^[a-z]_[0-9a-z]{1,32}$/;
const btn = (act, label, path) => `<button class="ghost tiny" data-act="list:${act}" title="${label}" aria-label="${label}">${icon(path, 14)}</button>`;
const TRAIL = btn("outdent", "Move out", '<path d="M14 7l-5 5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>')
  + btn("indent", "Move in", '<path d="M10 7l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>')
  + btn("up", "Move up", '<path d="M7 14l5-5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>')
  + btn("down", "Move down", '<path d="M7 10l5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>');

// Items that were never placed sort by when they were made.
const orderOf = it => it.meta.list?.order ?? (Date.parse((it.created || "1970-01-01T00:00:00") + "Z") / 1000);

// parent → ordered children, ignoring parents that are gone or would loop.
function outline(items) {
  const byId = new Map(items.map(it => [it.id, it]));
  const parentOf = new Map();
  const raw = it => { const p = it.meta.list?.parent; return byId.has(p) ? p : null; };
  for (const it of items) {
    let p = raw(it);
    // Walk up the ancestors; an item caught in a loop goes to the top.
    for (let q = p, seen = new Set([it.id]); q; q = raw(byId.get(q))) {
      if (seen.has(q)) { p = null; break; }
      seen.add(q);
    }
    parentOf.set(it.id, p);
  }
  const kids = new Map();
  for (const it of items) { const p = parentOf.get(it.id); if (!kids.has(p)) kids.set(p, []); kids.get(p).push(it); }
  for (const l of kids.values()) l.sort((a, b) => orderOf(a) - orderOf(b));
  return { parentOf, kids: p => kids.get(p) || [] };
}

// Returns false when there's nothing to do, so the key keeps its usual job.
function move(item, ctx, how) {
  if (ctx.tab !== "list") return false;
  const { parentOf, kids } = outline(ctx.scopeItems);
  const parent = parentOf.get(item.id) ?? null, sibs = kids(parent), i = sibs.findIndex(s => s.id === item.id);
  const set = (p, order) => ctx.setMeta(item.id, "list", { parent: p, order });
  if (how === "indent") {
    if (i < 1) return false;
    const np = sibs[i - 1], last = kids(np.id).at(-1);
    return set(np.id, last ? orderOf(last) + 1 : orderOf(np));
  }
  if (how === "outdent") {
    if (!parent) return false;
    const grand = parentOf.get(parent) ?? null, up = kids(grand), j = up.findIndex(s => s.id === parent);
    const p = up[j], next = up[j + 1];
    return set(grand, next ? (orderOf(p) + orderOf(next)) / 2 : orderOf(p) + 1);
  }
  if (how === "up" && i > 0) {
    const a = sibs[i - 2], b = sibs[i - 1];
    return set(parent, a ? (orderOf(a) + orderOf(b)) / 2 : orderOf(b) - 1);
  }
  if (how === "down" && i < sibs.length - 1) {
    const a = sibs[i + 1], b = sibs[i + 2];
    return set(parent, b ? (orderOf(a) + orderOf(b)) / 2 : orderOf(a) + 1);
  }
  return false;
}

export default {
  id: "list",
  name: "List",
  description: "Arrange items in your own order and nest them as an outline.",
  icon: '<path d="M9 6.5h11M9 12h11M9 17.5h11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="4.5" cy="6.5" r="1.3" fill="currentColor"/><circle cx="4.5" cy="12" r="1.3" fill="currentColor"/><circle cx="4.5" cy="17.5" r="1.3" fill="currentColor"/>',

  clean(v, fail) {
    if (!v || typeof v !== "object" || Array.isArray(v)) fail("list must be an object");
    const order = Number(v.order);
    if (!Number.isFinite(order)) fail("list.order must be a number");
    const parent = v.parent == null || v.parent === "" ? null : String(v.parent);
    if (parent !== null && !ID.test(parent)) fail("list.parent must be an item id");
    return { order, parent };
  },

  fresh: () => ({ order: Date.now() / 1000, parent: null }),

  // Placement is done in the List view, so the item dialog has nothing to edit.
  editor: () => `<p class="hint">Use the List view to reorder and nest this item.</p>`,
  read: (_, item) => item.meta.list ?? { order: Date.now() / 1000, parent: null },

  actions: {
    indent: (item, ctx) => move(item, ctx, "indent"),
    outdent: (item, ctx) => move(item, ctx, "outdent"),
    up: (item, ctx) => move(item, ctx, "up"),
    down: (item, ctx) => move(item, ctx, "down"),
  },
  keys: {
    Tab: (item, ctx) => move(item, ctx, "indent"),
    "S-Tab": (item, ctx) => move(item, ctx, "outdent"),
    "A-ArrowUp": (item, ctx) => move(item, ctx, "up"),
    "A-ArrowDown": (item, ctx) => move(item, ctx, "down"),
  },

  view: {
    label: "List",
    render(ctx) {
      if (!ctx.items.length) return ctx.empty("This list is empty", "Add an item above. Tab nests it under the one before.");
      if (ctx.filtered) return ctx.group("Matches", [...ctx.items].sort((a, b) => orderOf(a) - orderOf(b)));
      const { kids } = outline(ctx.items);
      const walk = (p, depth) => kids(p).map(it => ctx.row(it, { depth, trail: TRAIL }) + walk(it.id, depth + 1)).join("");
      return `<div class="group outline"><ul class="items">${walk(null, 0)}</ul></div>`;
    },
  },
};
