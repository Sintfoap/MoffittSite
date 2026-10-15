// Checklist: things to tick off, with an optional priority.
// meta.checklist = { done, done_at, priority }

import { esc, icon, nowStamp, STAMP } from "../lib.js";

const PRI = [[0, "None"], [1, "Low"], [2, "Medium"], [3, "High"]];
const tick = icon('<path d="m6 12.5 4 4 8-9" stroke="var(--accent-ink)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>', 14);

const rank = it => [-(it.meta.checklist.priority || 0), it.meta.event?.start || "9999", it.meta.list?.order ?? 0, it.created || ""];
const byRank = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };

function toggle(item, ctx) {
  const m = item.meta.checklist;
  if (!m) return false;
  ctx.setMeta(item.id, "checklist", { done: !m.done, priority: m.priority }, { celebrate: !m.done });
}

export default {
  id: "checklist",
  name: "Checklist",
  description: "Tick items off as done, with an optional priority.",
  icon: '<rect x="4.5" y="4.5" width="15" height="15" rx="4" stroke="currentColor" stroke-width="1.8"/><path d="m8.5 12 2.5 2.5 4.5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',

  clean(v, fail) {
    if (!v || typeof v !== "object" || Array.isArray(v)) fail("checklist must be an object");
    const done = Boolean(v.done);
    let done_at = null;
    if (done) {
      if (v.done_at == null || v.done_at === "") done_at = nowStamp();
      else if (STAMP.test(String(v.done_at))) done_at = String(v.done_at);
      else fail("checklist.done_at must be YYYY-MM-DDTHH:MM:SS");
    }
    return { done, done_at, priority: Math.max(0, Math.min(3, Math.trunc(Number(v.priority) || 0))) };
  },

  fresh: quick => ({ done: false, priority: quick.priority || 0 }),

  lead: item => {
    const done = item.meta.checklist.done;
    return `<button class="check" data-act="checklist:toggle" aria-label="${done ? "Mark not done" : "Mark done"}">${tick}</button>`;
  },
  rowClass: item => `p${item.meta.checklist.priority || 0}${item.meta.checklist.done ? " done" : ""}`,

  editor(item) {
    const m = item.meta.checklist;
    return `<label class="inline"><input type="checkbox" name="done" ${m.done ? "checked" : ""}> Done</label>
      <label>Priority<select name="priority">${PRI.map(([p, l]) => `<option value="${p}" ${m.priority === p ? "selected" : ""}>${l}</option>`).join("")}</select></label>`;
  },
  read: (f, item) => ({
    done: Boolean(f.done), priority: +f.priority || 0,
    done_at: f.done && item.meta.checklist?.done ? item.meta.checklist.done_at : null,
  }),

  actions: {
    toggle,
    showDone: (_, ctx) => { ctx.viewState.showDone = !ctx.viewState.showDone; ctx.render(); },
  },
  keys: {
    x: toggle, " ": toggle,
    ...Object.fromEntries([0, 1, 2, 3].map(p => [String(p), (item, ctx) =>
      item.meta.checklist ? ctx.setMeta(item.id, "checklist", { ...item.meta.checklist, priority: p }) : false])),
  },

  view: {
    label: "Checklist",
    render(ctx) {
      const all = ctx.items.filter(it => it.meta.checklist);
      const open = all.filter(it => !it.meta.checklist.done || ctx.pending.has(it.id)).sort(byRank);
      const done = all.filter(it => it.meta.checklist.done && !ctx.pending.has(it.id))
        .sort((a, b) => (b.meta.checklist.done_at || "").localeCompare(a.meta.checklist.done_at || ""));
      if (!all.length) return ctx.empty("Nothing to check off", "Add an item above and it lands here.");
      let html = ctx.group("Open", open, open.length ? "" : `<p class="hint">All done.</p>`);
      if (done.length) {
        const shown = ctx.viewState.showDone ? done : [];
        html += `<div class="group"><h2>Done<small>${done.length}</small>
          <button class="ghost tiny" data-act="checklist:showDone">${ctx.viewState.showDone ? "Hide" : "Show"}</button></h2>
          <ul class="items">${shown.map(it => ctx.row(it)).join("")}</ul></div>`;
      }
      return html;
    },
  },
};
