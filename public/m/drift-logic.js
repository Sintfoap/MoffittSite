// Drift's rules for the phone app: which items each screen shows, in what
// order, and what a new item starts with. No DOM here, so the tests can run
// it. The rules themselves are Drift's own (public/todo/lib.js and plugins/),
// the same ones the web page and the terminal use.

import { today, addDays, dayOf, timeOf, niceDay, niceTime, parseDate, parseTime, parseWords } from "../todo/lib.js";
import { PLUGINS, BY_ID } from "../todo/plugins/index.js";
import { dayStops, niceDistance, w3wLink } from "../todo/plugins/location.js";

export { PLUGINS, BY_ID, dayStops, niceDistance, w3wLink };

// Drift's own plugins that bring a view, in the order the web page shows them.
export const VIEW_LABELS = { checklist: "Checklist", event: "Calendar", list: "List", graph: "Graph", location: "Map" };
export const PRIORITY = ["None", "Low", "Medium", "High"];

export const writable = col => !!col && col.role !== "view";
export const isOpen = it => !it.meta.checklist?.done;
export const isLate = it => { const e = it.meta.event; return !!e && isOpen(it) && dayOf(e.end || e.start) < today(); };
export const onDay = (e, d) => dayOf(e.start) <= d && d <= dayOf(e.end || e.start);
export const byStart = (a, b) => (a.meta.event.start.length - b.meta.event.start.length) || a.meta.event.start.localeCompare(b.meta.event.start);

const rank = it => [-(it.meta.checklist?.priority || 0), it.meta.event?.start || "9999", it.meta.list?.order ?? 0, it.created || ""];
export function byRank(a, b) {
  const x = rank(a), y = rank(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// The Today screen: overdue items, then today's by time, from every collection.
export function todayGroups(items, day = today()) {
  const ev = items.filter(it => it.meta.event);
  return {
    late: ev.filter(isLate).sort(byStart),
    on: ev.filter(it => onDay(it.meta.event, day) && !isLate(it)).sort(byStart),
  };
}

// The Calendar on a phone: one week as a strip of days, and the chosen day's
// items (all-day first, then by time) with what's coming in the next two weeks.
export function weekOf(day) {
  const d = new Date(day + "T00:00");
  const monday = addDays(-((d.getDay() + 6) % 7), day);
  return [...Array(7)].map((_, i) => addDays(i, monday));
}
export function dayAgenda(items, day) {
  const ev = items.filter(it => it.meta.event);
  const on = ev.filter(it => onDay(it.meta.event, day));
  // Untimed that day: all-day ones, and timed ones carried over from an earlier day.
  const untimed = on.filter(it => !timeOf(it.meta.event.start) || dayOf(it.meta.event.start) !== day).sort(byStart);
  const timed = on.filter(it => !untimed.includes(it)).sort(byStart);
  const later = ev.filter(it => dayOf(it.meta.event.start) > day && dayOf(it.meta.event.start) <= addDays(14, day)).sort(byStart);
  return { untimed, timed, later };
}
export const busyDays = (items, days) => Object.fromEntries(days.map(d => [d, items.filter(it => it.meta.event && onDay(it.meta.event, d)).length]));

// A collection's Checklist: open by priority, done newest first.
export function checklistSplit(items) {
  const all = items.filter(it => it.meta.checklist);
  return {
    open: all.filter(it => !it.meta.checklist.done).sort(byRank),
    done: all.filter(it => it.meta.checklist.done).sort((a, b) => (b.meta.checklist.done_at || "").localeCompare(a.meta.checklist.done_at || "")),
  };
}

// A collection's List as an outline: [[item, depth]] in order.
const orderOf = it => it.meta.list?.order ?? (Date.parse((it.created || "1970-01-01T00:00:00") + "Z") / 1000);
function tree(items) {
  const byId = new Map(items.map(it => [it.id, it]));
  const raw = it => { const p = it.meta.list?.parent; return byId.has(p) ? p : null; };
  const parentOf = new Map(), kids = new Map();
  for (const it of items) {
    let p = raw(it);
    // Walk up the ancestors; an item caught in a loop goes to the top.
    for (let q = p, seen = new Set([it.id]); q; q = raw(byId.get(q))) {
      if (seen.has(q)) { p = null; break; }
      seen.add(q);
    }
    parentOf.set(it.id, p);
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(it);
  }
  for (const l of kids.values()) l.sort((a, b) => orderOf(a) - orderOf(b));
  return { parentOf: id => parentOf.get(id) ?? null, kids: p => kids.get(p) || [] };
}
export function outline(items) {
  const { kids } = tree(items), out = [];
  const walk = (p, depth) => { for (const it of kids(p)) { out.push([it, depth]); walk(it.id, depth + 1); } };
  walk(null, 0);
  return out;
}

// The new meta.list for moving an item up, down, in (under the one above) or
// out of the outline, or null when it can't go that way. The List view's own rule.
export function listMove(item, scope, how) {
  const { parentOf, kids } = tree(scope);
  const parent = parentOf(item.id), sibs = kids(parent), i = sibs.findIndex(s => s.id === item.id);
  if (i < 0) return null;
  if (how === "in") {
    if (i < 1) return null;
    const np = sibs[i - 1], last = kids(np.id).at(-1);
    return { parent: np.id, order: last ? orderOf(last) + 1 : orderOf(np) };
  }
  if (how === "out") {
    if (!parent) return null;
    const grand = parentOf(parent), up = kids(grand), j = up.findIndex(s => s.id === parent), next = up[j + 1];
    return { parent: grand, order: next ? (orderOf(up[j]) + orderOf(next)) / 2 : orderOf(up[j]) + 1 };
  }
  if (how === "up" && i > 0) {
    const a = sibs[i - 2], b = sibs[i - 1];
    return { parent, order: a ? (orderOf(a) + orderOf(b)) / 2 : orderOf(b) - 1 };
  }
  if (how === "down" && i < sibs.length - 1) {
    const a = sibs[i + 1], b = sibs[i + 2];
    return { parent, order: b ? (orderOf(a) + orderOf(b)) / 2 : orderOf(a) + 1 };
  }
  return null;
}

// The tabs a collection's screen offers: its plugins that bring a view.
export const viewTabs = col => col.plugins.filter(p => VIEW_LABELS[p]);
export function tabFor(col, picked) {
  const tabs = viewTabs(col), t = picked || col.view;
  return tabs.includes(t) ? t : tabs[0] || null;
}

// What a new item starts with: each plugin that's on decides (its fresh()), as
// on the web page. On Today, the Calendar and the Map every item gets a date,
// so it shows up where you added it.
export function freshMeta(col, quick, { dated = false, day = null } = {}) {
  const meta = {};
  const ctx = { tab: dated ? "event" : null, viewState: { day: day || today() } };
  for (const p of PLUGINS) {
    if (!col.plugins.includes(p.id) && !(p.id === "event" && dated)) continue;
    const m = p.fresh?.(quick, ctx);
    if (m !== undefined) meta[p.id] = m;
  }
  return meta;
}

// Where a quick-add line goes: the collection it names (+name), else the one on
// screen, else the first. Returns {col} or {error}.
export function targetFor(collections, current, quick) {
  if (quick.collection) {
    const want = quick.collection.toLowerCase();
    const col = collections.find(c => writable(c) && c.name.toLowerCase() === want);
    return col ? { col } : { error: `There's no collection called “${quick.collection}” you can add to.` };
  }
  const col = current || collections.find(writable);
  if (!writable(col)) return { error: "You can view this collection but not add to it." };
  return { col };
}

// The item sheet's fields → the changes to send ({} when nothing changed), or
// {error}. f: {title, notes, tags, collection, onList, priority, done, day, time}.
export function itemChanges(it, f, { hasCheck, hasEvent, hasPlace = false }) {
  const out = {}, m = it.meta;
  const title = String(f.title || "").trim();
  if (!title) return { error: "Give the item a title." };
  if (title !== it.title) out.title = title;
  if ((f.notes ?? "") !== (it.notes ?? "")) out.notes = f.notes ?? "";
  const tags = [...new Set(String(f.tags || "").replace(/,/g, " ").split(/\s+/).map(g => g.replace(/^#+/, "").toLowerCase()).filter(Boolean))].sort();
  if (tags.join(" ") !== [...(it.tags || [])].sort().join(" ")) out.tags = tags;
  if (f.collection && f.collection !== it.collection) out.collection = f.collection;
  const meta = {};
  if (hasCheck) {
    const old = m.checklist;
    if (!f.onList) { if (old) meta.checklist = null; }
    else {
      const pri = +f.priority || 0, done = !!f.done;
      if (!old || !!old.done !== done || (old.priority || 0) !== pri)
        meta.checklist = { done, priority: pri, done_at: old?.done && done ? old.done_at : null };
    }
  }
  if (hasEvent) {
    const old = m.event, rawDay = String(f.day || "").trim(), rawTime = String(f.time || "").trim();
    if (!rawDay && !rawTime) { if (old) meta.event = null; }
    else {
      const day = rawDay ? parseDate(rawDay) : today();
      const tm = rawTime ? parseTime(rawTime) : "";
      if (!day) return { error: `“${rawDay}” isn't a date Drift understands. Try today, fri, +3d or 2026-11-02.` };
      if (tm === null) return { error: `“${rawTime}” isn't a time. Try 9, 3pm or 15:30.` };
      const start = tm ? `${day}T${tm}` : day;
      let end = old?.end || null;
      if (end && (end.includes("T") !== start.includes("T") || end < start)) end = null;
      if (!old || old.start !== start || (old.end || null) !== end) meta.event = { start, end };
    }
  }
  if (hasPlace) {
    const old = m.location, raw = String(f.words || "").trim();
    if (!raw) { if (old?.words) meta.location = null; }
    else {
      const words = parseWords(raw);
      if (!words) return { error: `“${raw}” isn't a what3words address. It's three words with dots, like ///filled.count.soap.` };
      if (old?.words !== words) meta.location = { words, lat: null, lng: null, place: "" };
    }
  }
  if (Object.keys(meta).length) out.meta = meta;
  return out;
}

// The date chip on an item: "Today 3pm", "Fri", "Nov 2 – Nov 4".
export function whenChip(e) {
  const d = dayOf(e.start), t = timeOf(e.start);
  let s = niceDay(d) + (t ? " " + niceTime(t) : "");
  if (e.end && dayOf(e.end) !== d) s += " – " + niceDay(dayOf(e.end));
  return s;
}
export function timeRange(e) {
  const t = timeOf(e.start), et = timeOf(e.end);
  return t ? niceTime(t) + (et && dayOf(e.end) === dayOf(e.start) ? "–" + niceTime(et) : "") : "All day";
}

export const matches = (it, q) => !q || [it.title, it.notes, ...(it.tags || [])].some(s => (s || "").toLowerCase().includes(q.toLowerCase()));
