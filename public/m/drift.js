// Drift on the phone: Today, a week-at-a-time Calendar, and each collection
// with its views, plus quick-add at the bottom and a sheet for each item.
// Reads and writes /todo/api/ (src/drift.js), like the web page and the
// terminal, and checks every few seconds for changes made elsewhere.

import { $, esc, api, icon, toast, failed, sheet, plural, every } from "./ui.js";
import { today, addDays, dayOf, timeOf, niceDay, niceTime, parseQuick } from "../todo/lib.js";
import * as L from "./drift-logic.js";
import { baseFor, baseScope, niceDuration, PROFILES } from "../todo/route.js";

const POLL_EVERY = 5000;
const LAST_VIEW = "m:drift-view";
const data = { state: null, loading: null };
const ui = { view: "today", day: today(), tabs: {}, showDone: false, q: "", route: false, profile: "driving-car", option: 0 };
const VERB = { "driving-car": "drive", "foot-walking": "walk", "cycling-regular": "ride" };
let stopPoll = null, main = null;

const remember = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const recall = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };

/* ── data ───────────────────────────────────────── */
export function load(force = false) {
  if (data.state && !force) return Promise.resolve(data.state);
  return data.loading ||= api("GET", "/todo/api/state")
    .then(s => { data.state = s; return s; })
    .finally(() => { data.loading = null; });
}
const col = id => data.state.collections.find(c => c.id === id);
const item = id => data.state.items.find(i => i.id === id);
const canEdit = it => L.writable(col(it.collection));
function put(it) {
  const i = data.state.items.findIndex(x => x.id === it.id);
  if (i >= 0) data.state.items[i] = it; else data.state.items.push(it);
}
async function patch(it, changes) {
  const before = structuredClone(it);
  Object.assign(it, changes.meta ? { ...changes, meta: { ...it.meta, ...changes.meta } } : changes);
  redraw();
  try { put(await api("PATCH", "/todo/api/items/" + it.id, changes)); }
  catch (e) { put(before); failed(e); }
  redraw();
}
async function toggle(it) {
  const ck = it.meta.checklist || { done: false, priority: 0 };
  await patch(it, { meta: { checklist: { done: !ck.done, priority: ck.priority || 0 } } });
}
async function poll() {
  if (!data.state || document.querySelector("dialog[open]")) return;
  try {
    const { version } = await api("GET", "/todo/api/version");
    if (version !== data.state.version) { await load(true); redraw(); }
  } catch {}
}
let redraw = () => {};

/* ── one item's row ─────────────────────────────── */
function row(it, { depth = 0, showCol = false, skipEvent = false, time = "", links = "" } = {}) {
  const ck = it.meta.checklist, done = !!ck?.done, pri = ck?.priority || 0, ev = it.meta.event;
  const chips = [];
  if (time) chips.push(`<span class="chip gold">${esc(time)}</span>`);
  if (ev && !skipEvent) chips.push(`<span class="chip ${L.isLate(it) ? "bad" : dayOf(ev.start) === today() ? "gold" : ""}">${icon("cal", 12)}${esc(L.whenChip(ev))}</span>`);
  if (showCol && col(it.collection)) chips.push(`<span class="chip col">${esc(col(it.collection).name)}</span>`);
  for (const g of it.tags || []) chips.push(`<span class="chip tag">#${esc(g)}</span>`);
  if (it.meta.location && L.placeLabel(it.meta.location)) chips.push(`<span class="chip ${it.meta.location.lat != null ? "gold" : ""}">${icon("pin", 12)}${esc(L.placeLabel(it.meta.location))}</span>`);
  if (it.notes) chips.push(`<span class="chip">${icon("note", 12)}</span>`);
  return `<li class="item p${pri}${done ? " done" : ""}" data-id="${esc(it.id)}" style="--depth:${depth}">
    ${ck ? `<button class="check" data-toggle aria-label="${done ? "Mark not done" : "Mark done"}">${icon("check", 16)}</button>` : `<span class="dot" aria-hidden="true"></span>`}
    <button class="body" data-open><span class="t">${esc(it.title)}</span>${chips.length ? `<span class="chips">${chips.join("")}</span>` : ""}${links ? `<span class="links">${esc(links)}</span>` : ""}</button>
  </li>`;
}
const group = (title, items, opts, n = items.length) =>
  `<section class="group"><h2 class="label">${esc(title)}${n ? `<small>${n}</small>` : ""}</h2><ul class="items">${items.map(it => row(it, opts)).join("")}</ul></section>`;
const empty = (title, text) => `<div class="empty"><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`;

/* ── the screen ─────────────────────────────────── */
function current() {
  if (/^[a-z]_/.test(ui.view)) {
    const c = col(ui.view);
    if (c) return { kind: "col", col: c, tab: L.tabFor(c, ui.tabs[c.id]) };
    ui.view = "today";
  }
  return { kind: ui.view === "calendar" ? "calendar" : "today", col: null, tab: ui.view === "calendar" ? "event" : null };
}

function draw() {
  const s = data.state, cur = current();
  const live = s.items.filter(it => it.meta.event && L.isOpen(it));
  const nToday = live.filter(it => dayOf(it.meta.event.start) <= today()).length;
  const openIn = c => s.items.filter(it => it.collection === c.id && L.isOpen(it)).length;
  const viewChip = (id, label, n, ico) => `<a class="pill${ui.view === id ? " on" : ""}" href="#drift/${id}">${ico ? icon(ico, 15) : ""}${esc(label)}${n ? `<small>${n}</small>` : ""}</a>`;
  const scope = s.items.filter(it => !cur.col || it.collection === cur.col.id);
  const shown = scope.filter(it => L.matches(it, ui.q));

  let title = "", sub = "", body = "";
  if (cur.kind === "today") {
    title = "Today";
    const { late, on } = L.todayGroups(shown);
    const left = on.filter(L.isOpen).length;
    sub = on.length ? `${left} of ${on.length} still open` : "Nothing scheduled";
    if (late.length) body += group("Overdue", late, { showCol: true });
    if (on.length) body += `<section class="group"><h2 class="label">Today<small>${on.length}</small></h2><ul class="items">${on.map(it =>
      row(it, { showCol: true, skipEvent: true, time: timeOf(it.meta.event.start) && dayOf(it.meta.event.start) === today() ? niceTime(timeOf(it.meta.event.start)) : "" })).join("")}</ul></section>`;
    if (!body) body = empty("Nothing for today", "Items dated today, from any collection, show up here. Add one below.");
  } else if (cur.kind === "calendar" || cur.tab === "event") {
    if (cur.kind === "calendar") { title = "Calendar"; sub = "Events from every collection"; }
    body = calendar(shown, !cur.col);
  } else if (cur.tab === "checklist") {
    const { open, done } = L.checklistSplit(shown);
    if (!open.length && !done.length) body = empty("Nothing to check off", "Add an item below and it lands here.");
    else {
      body = open.length ? group("Open", open) : `<section class="group"><h2 class="label">Open</h2><p class="hint">All done.</p></section>`;
      if (done.length) body += `<section class="group"><h2 class="label">Done<small>${done.length}</small><button class="link" data-showdone>${ui.showDone ? "Hide" : "Show"}</button></h2>
        ${ui.showDone ? `<ul class="items">${done.map(it => row(it)).join("")}</ul>` : ""}</section>`;
    }
  } else if (cur.tab === "list") {
    body = !shown.length ? empty("This list is empty", "Add an item below, then open it to move it up, down or under another.")
      : ui.q ? group("Matches", shown)
      : `<section class="group outline"><ul class="items">${L.outline(shown).map(([it, depth]) => row(it, { depth })).join("")}</ul></section>`;
  } else if (cur.tab === "location") {
    body = places(shown, cur.col);
  } else if (cur.tab === "graph") {
    const titles = Object.fromEntries(scope.map(it => [it.id, it.title]));
    const linked = shown.filter(it => it.meta.graph);
    body = `<p class="hint">Links between items, as a list. The network you can drag around is on the full site.</p>` +
      `<section class="group"><ul class="items">${linked.map(it => {
        const g = it.meta.graph, rel = g.rel || {};
        const to = (g.links || []).filter(x => titles[x]).map(x => (rel[x] ? rel[x] + " " : "→ ") + titles[x]);
        return row({ ...it, tags: [...(g.kind ? [g.kind] : []), ...(it.tags || [])] }, { links: to.join(" · ") });
      }).join("")}</ul></section>`;
  } else {
    body = (shown.length ? group("Items", shown) : "") +
      `<p class="hint">${cur.col.plugins.some(p => !L.BY_ID[p]) ? "This collection's view comes from the plugin store, and draws on the full site." : "Turn on a plugin in this collection's settings for checklists, calendars and lists."}
      <a href="/todo/">Open Drift on the full site</a></p>`;
  }

  if (cur.kind === "col") {
    title = cur.col.name;
    const bits = [plural(scope.length, "item")];
    if (cur.col.role !== "owner") bits.push(`Shared by ${cur.col.owner_name}${cur.col.role === "view" ? ", view only" : ""}`);
    else if (cur.col.shares?.length) bits.push("Shared with " + cur.col.shares.map(x => x.name).join(", "));
    sub = bits.join(" · ");
  }
  if (ui.q) sub = `Matching “${ui.q}”`;

  const tabs = cur.kind === "col" && L.viewTabs(cur.col).length > 1
    ? `<div class="seg" role="tablist">${L.viewTabs(cur.col).map(p => `<button role="tab" data-tab="${p}" aria-selected="${p === cur.tab}">${L.VIEW_LABELS[p]}</button>`).join("")}</div>` : "";
  const ro = cur.kind === "col" && !L.writable(cur.col);

  main.innerHTML = `<header class="bar"><div><h1>${esc(title)}</h1><p class="sub">${esc(sub)}</p></div>
      <span class="acts">
        <button class="icon-btn" data-search aria-label="Search">${icon("search")}</button>
        ${cur.kind === "col" ? `<button class="icon-btn" data-settings aria-label="${cur.col.role === "owner" ? "Collection settings" : "About this collection"}">${icon("more")}</button>` : ""}
      </span></header>
    ${ui.searching ? `<div class="search"><input id="q" type="search" placeholder="Search titles, notes and tags" value="${esc(ui.q)}" enterkeyhint="search"><button class="link" data-endsearch>Done</button></div>` : ""}
    <nav class="pills" aria-label="Drift views">
      ${viewChip("today", "Today", nToday, "sun")}${viewChip("calendar", "Calendar", 0, "cal")}
      ${s.collections.map(c => viewChip(c.id, c.name, openIn(c))).join("")}
      <button class="pill ghost" data-newcol>${icon("plus", 15)}New</button>
    </nav>
    ${tabs}
    <div class="content">${body}</div>
    <form class="composer" id="addForm" autocomplete="off">
      <div class="preview" id="preview"></div>
      <div class="row"><input id="add" ${ro ? "disabled" : ""} placeholder="${ro ? "View only for you" : "Add an item"}" enterkeyhint="send" aria-label="Add an item. #tag +collection !1-3 ^date @time">
      <button class="send" aria-label="Add" ${ro ? "disabled" : ""}>${icon("plus")}</button></div>
    </form>`;
  document.body.classList.add("composing");
  main.querySelector(".pill.on")?.scrollIntoView({ inline: "center", block: "nearest" });
  if (ui.searching) { const q = $("#q"); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}

// The week as a strip of days to pick from, for the Calendar and the Map.
function weekStrip(items) {
  const week = L.weekOf(ui.day), busy = L.busyDays(items, week);
  const label = new Date(week[3] + "T00:00").toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return `<div class="week">
    <div class="week-head"><h2>${esc(label)}</h2><span>
      <button class="icon-btn" data-week="-7" aria-label="Previous week">${icon("left")}</button>
      <button class="link" data-week="0">Today</button>
      <button class="icon-btn" data-week="7" aria-label="Next week">${icon("right")}</button></span></div>
    <div class="days">${week.map(d => {
      const dt = new Date(d + "T00:00");
      return `<button class="day${d === ui.day ? " sel" : ""}${d === today() ? " now" : ""}" data-day="${d}" aria-label="${esc(niceDay(d))}, ${plural(busy[d], "item")}">
        <span class="wd">${esc(dt.toLocaleDateString(undefined, { weekday: "narrow" }))}</span><b>${dt.getDate()}</b><i>${busy[d] ? "•".repeat(Math.min(3, busy[d])) : ""}</i></button>`;
    }).join("")}</div></div>`;
}

function calendar(items, showCol) {
  const { untimed, timed, later } = L.dayAgenda(items, ui.day);
  let html = weekStrip(items);
  const n = untimed.length + timed.length;
  html += `<section class="group"><h2 class="label">${esc(niceDay(ui.day))}${n ? `<small>${n}</small>` : ""}</h2>`;
  if (!n) html += `<p class="hint">Nothing on this day. Items you add here get this date.</p>`;
  html += `<ul class="items">${untimed.map(it => row(it, { showCol, skipEvent: true, time: timeOf(it.meta.event.start) ? "Continues" : "All day" })).join("")}
    ${timed.map(it => row(it, { showCol, skipEvent: true, time: L.timeRange(it.meta.event) })).join("")}</ul></section>`;
  if (later.length) html += group("Next two weeks", later, { showCol });
  return html;
}

// The Map: the picked day's events that have a place, in the order they
// happen, or with Route on, in the order the site plans from the day's base
// and back (src/routing.js). The map itself is on the full site; here each
// stop opens in the phone's maps app for directions.
let planned = { key: null, r: null };
function routeFor(c, stops) {
  const key = JSON.stringify([c.id, ui.day, ui.profile, ui.option, c.bases || [], stops.map(({ item: it }) => [it.id, it.meta.event, it.meta.location, it.meta.graph])]);
  if (planned.key !== key) {
    planned = { key, r: null };
    const q = new URLSearchParams({ collection: c.id, day: ui.day, profile: ui.profile, option: ui.option });
    api("GET", "/todo/api/route?" + q).then(r => { if (planned.key === key) { planned.r = r; draw(); } })
      .catch(() => { if (planned.key === key) { planned.r = { error: true, options: [] }; draw(); } });
  }
  return planned.r;
}

function places(items, c) {
  const plan = L.dayStops(items, ui.day), { unplaced, elsewhere } = plan;
  const miles = /^en-(US|LR|MM)$/i.test(navigator.language || "");
  const base = baseFor(c.bases, ui.day), r = ui.route && plan.stops.length ? routeFor(c, plan.stops) : null;
  let stops = plan.stops, bar = "";
  const leg = l => l ? `${niceDuration(l.duration)} ${VERB[r.profile] || "drive"}` : "";
  if (r?.options.length) {
    const by = new Map(plan.stops.map(s => [s.item.id, s.item])), opt = r.options[r.option], shift = r.base?.lat != null ? 0 : -1;
    stops = opt.order.filter(id => by.has(id)).map((id, i) => ({ item: by.get(id), n: i + 1, leg: r.legs[i + shift], late: opt.late.includes(id) }));
    bar = `<p class="hint route">${r.options.length > 1 ? `<button class="btn ghost" data-option="-1" aria-label="Previous route">‹</button>` : ""}
      <span><b>${r.options.length > 1 ? `Route ${r.option + 1} of ${r.options.length}` : "Route"}</b> · ${esc(niceDuration(opt.duration))} of travel${r.estimated ? " (estimated)" : ""}</span>
      ${r.options.length > 1 ? `<button class="btn ghost" data-option="1" aria-label="Next route">›</button>` : ""}</p>`;
  } else if (ui.route && plan.stops.length) bar = `<p class="hint">${r?.error ? "Couldn’t plan the route just now." : "Planning the route…"}</p>`;
  let html = weekStrip(items) + `<section class="group"><h2 class="label">${esc(niceDay(ui.day))}${plan.stops.length ? `<small>${plan.stops.length}</small>` : ""}</h2>`;
  html += `<p class="hint base">${base ? `⌂ ${esc(baseScope(base, niceDay))}: ${esc(L.placeLabel(base))}` : "⌂ No base for this day. Set one on the full site’s Map."}</p>`;
  if (plan.stops.length) html += `<p class="routing"><button class="btn ${ui.route ? "" : "ghost"}" data-route>${ui.route ? "Route on" : "Plan a route"}</button>
    ${ui.route ? `<select data-profile aria-label="How you get around">${Object.entries(PROFILES).map(([k, v]) => `<option value="${k}" ${k === ui.profile ? "selected" : ""}>${v}</option>`).join("")}</select>` : ""}</p>` + bar;
  if (!plan.stops.length) html += `<p class="hint">${!c.plugins.includes("event") ? "Turn on Events in this collection's settings too, so items have a day to be on the map."
    : "Nothing with a place on this day. Give an event a place, or add one with ~ and its name."}</p>`;
  html += `<ul class="items stops">${stops.map(({ item: it, n, from, leg: l, late }) => {
    const m = it.meta.location;
    const how = r?.options.length ? (l ? ` · ${leg(l)}` : "") + (late ? " · probably late" : "") : from != null ? ` · ${L.niceDistance(from, miles)} from ${n - 1}` : "";
    return row(it, { skipEvent: true, time: `${n} · ${L.timeRange(it.meta.event)}${how}`,
    }).replace("</li>", `<a class="go" href="https://www.google.com/maps/dir/?api=1&amp;destination=${m.lat},${m.lng}" target="_blank" rel="noopener">Directions</a></li>`);
  }).join("")}</ul>`;
  if (r?.options.length && r.base?.lat != null && r.legs.length) html += `<p class="hint">⌂ Back to ${esc(L.placeLabel(r.base))} · ${esc(leg(r.legs.at(-1)))}</p>`;
  if (unplaced.length) html += `<p class="hint">Not found on the map yet: ${unplaced.map(it => esc(it.title)).join(", ")}. Open one to search again, or pin it on the full site.</p>`;
  if (elsewhere.length) html += `<p class="hint">${plural(elsewhere.length, "more item")} on this day with no place.</p>`;
  return html + `<p class="hint"><a href="/todo/">See the map on the full site</a></p></section>`;
}

/* ── taps ───────────────────────────────────────── */
function wire() {
  main.onclick = async e => {
    const t = e.target;
    const li = t.closest(".item"), it = li && item(li.dataset.id);
    if (it && t.closest("[data-toggle]")) { if (canEdit(it)) toggle(it); else toast("You can view this collection but not change it."); return; }
    if (it && t.closest("[data-open]")) return itemSheet(it);
    const tab = t.closest("[data-tab]");
    if (tab) {
      const c = current().col;
      ui.tabs[c.id] = tab.dataset.tab;
      if (c.role === "owner") api("PATCH", "/todo/api/collections/" + c.id, { view: tab.dataset.tab }).then(x => { c.view = x.view; }).catch(() => {});
      return draw();
    }
    const day = t.closest("[data-day]");
    if (day) { ui.day = day.dataset.day; ui.option = 0; return draw(); }
    const wk = t.closest("[data-week]");
    if (wk) { ui.day = +wk.dataset.week ? addDays(+wk.dataset.week, ui.day) : today(); ui.option = 0; return draw(); }
    if (t.closest("[data-showdone]")) { ui.showDone = !ui.showDone; return draw(); }
    if (t.closest("[data-route]")) { ui.route = !ui.route; ui.option = 0; return draw(); }
    const step = t.closest("[data-option]");
    if (step) { const n = planned.r?.options.length || 1; ui.option = ((ui.option + +step.dataset.option) % n + n) % n; return draw(); }
    if (t.closest("[data-search]")) { ui.searching = true; return draw(); }
    if (t.closest("[data-endsearch]")) { ui.searching = false; ui.q = ""; return draw(); }
    if (t.closest("[data-newcol]")) return collectionSheet(null);
    if (t.closest("[data-settings]")) return collectionSheet(current().col);
  };
  main.onchange = e => {
    if (e.target.matches("[data-profile]")) { ui.profile = e.target.value; ui.option = 0; draw(); }
  };
  main.oninput = e => {
    if (e.target.id === "q") { ui.q = e.target.value; const pos = e.target.selectionStart; draw(); $("#q").setSelectionRange(pos, pos); }
    if (e.target.id === "add") preview(e.target.value);
  };
  main.onsubmit = e => {
    if (e.target.id !== "addForm") return;
    e.preventDefault();
    add();
  };
}

function preview(v) {
  const [, f] = parseQuick(v.trim()), ch = [];
  if (f.date || f.time) ch.push(`<span class="chip gold">${icon("cal", 12)}${esc(f.date ? niceDay(f.date) : "Today")}${f.time ? " " + esc(niceTime(f.time)) : ""}</span>`);
  if (f.priority) ch.push(`<span class="chip p${f.priority}">${L.PRIORITY[f.priority]} priority</span>`);
  if (f.collection) ch.push(`<span class="chip col">${esc(f.collection)}</span>`);
  (f.tags || []).forEach(g => ch.push(`<span class="chip tag">#${esc(g)}</span>`));
  $("#preview").innerHTML = ch.length ? ch.join("") : v.trim() ? `<span class="fine">#tag  +collection  !1–3  ^fri  @3pm</span>` : "";
}

async function add() {
  const input = $("#add"), text = input.value.trim();
  if (!text) return;
  const [title, quick] = parseQuick(text);
  if (!title) return toast("Give the item a name before the tags.");
  const cur = current();
  const { col: target, error } = L.targetFor(data.state.collections, cur.col, quick);
  if (error) return toast(error);
  const dated = cur.kind !== "col" || (target === cur.col && (cur.tab === "event" || cur.tab === "location"));
  const meta = L.freshMeta(target, quick, { dated, day: cur.kind === "calendar" || cur.tab === "event" || cur.tab === "location" ? ui.day : null });
  input.value = ""; preview("");
  try {
    const it = await api("POST", "/todo/api/items", { title, collection: target.id, tags: quick.tags || [], meta });
    data.state.items.push(it);
    redraw();
    toast(target === cur.col || !cur.col && !quick.collection ? `Added “${title}”` : `Added “${title}” to ${target.name}`);
    $("#add")?.focus();
  } catch (e) { input.value = text; failed(e); }
}

/* ── the item sheet ─────────────────────────────── */
function itemSheet(it) {
  const c = col(it.collection), ro = !L.writable(c), m = it.meta;
  const hasCheck = c.plugins.includes("checklist") || !!m.checklist, hasEvent = c.plugins.includes("event") || !!m.event;
  const hasPlace = c.plugins.includes("location") || !!m.location;
  const ck = m.checklist, ev = m.event;
  const moveTo = data.state.collections.filter(x => x.id === it.collection || (L.writable(x) && x.owner === c.owner));
  const cur = current();
  const canMove = !ro && cur.kind === "col" && cur.tab === "list" && !ui.q;
  const d = sheet(`<form class="form" method="dialog">
    <h2>${ro ? "Item" : "Edit item"}</h2>
    ${ro ? `<p class="hint">Shared by ${esc(c.owner_name)}. You can view it but not change it.</p>` : ""}
    <label>Title<input name="title" value="${esc(it.title)}" ${ro ? "disabled" : ""} required></label>
    <label>Notes<textarea name="notes" rows="4" ${ro ? "disabled" : ""}>${esc(it.notes || "")}</textarea></label>
    ${hasCheck ? `<div class="pair">
      <label class="toggle"><input type="checkbox" name="onList" ${ck ? "checked" : ""} ${ro ? "disabled" : ""}> On the checklist</label>
      <label class="toggle"><input type="checkbox" name="done" ${ck?.done ? "checked" : ""} ${ro ? "disabled" : ""}> Done</label></div>
      <div class="seg small" role="radiogroup" aria-label="Priority">${L.PRIORITY.map((p, i) =>
        `<label><input type="radio" name="priority" value="${i}" ${(ck?.priority || 0) === i ? "checked" : ""} ${ro ? "disabled" : ""}><span>${p}</span></label>`).join("")}</div>` : ""}
    ${hasEvent ? `<div class="pair">
      <label>Date<input type="date" name="day" value="${esc(dayOf(ev?.start))}" ${ro ? "disabled" : ""}></label>
      <label>Time<input type="time" name="time" value="${esc(timeOf(ev?.start))}" ${ro ? "disabled" : ""}></label></div>
      ${ro ? "" : `<div class="quick"><button type="button" class="pill" data-date="${today()}">Today</button><button type="button" class="pill" data-date="${addDays(1)}">Tomorrow</button><button type="button" class="pill" data-date="${addDays(7)}">In a week</button><button type="button" class="pill" data-date="">No date</button></div>`}` : ""}
    ${hasPlace ? `<label>Place<input name="place" value="${m.location ? esc(L.placeLabel(m.location)) : ""}" placeholder="An address, a place's name, or lat, lng" autocomplete="off" ${ro ? "disabled" : ""}></label>
      <p class="hint">${m.location?.lat != null ? `<a href="${esc(L.osmLink(m.location))}" target="_blank" rel="noopener">See it on OpenStreetMap</a>`
        : m.location?.place ? "Not found on the map yet." : "The site finds it on the map when you save."}</p>` : ""}
    <div class="pair">
      <label>Tags<input name="tags" value="${esc((it.tags || []).join(" "))}" placeholder="Separate with spaces" autocapitalize="none" ${ro ? "disabled" : ""}></label>
      <label>Collection<select name="collection" ${ro ? "disabled" : ""}>${moveTo.map(x => `<option value="${esc(x.id)}" ${x.id === it.collection ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
    </div>
    ${canMove ? `<div class="moves"><span class="fine">Move in the list</span>
      <button type="button" class="icon-btn" data-move="up" aria-label="Move up">${icon("up")}</button>
      <button type="button" class="icon-btn" data-move="down" aria-label="Move down">${icon("down")}</button>
      <button type="button" class="icon-btn" data-move="out" aria-label="Move out">${icon("left")}</button>
      <button type="button" class="icon-btn" data-move="in" aria-label="Move under the one above">${icon("right")}</button></div>` : ""}
    <p class="err" role="alert"></p>
    <div class="buttons">${ro ? `<button class="btn" value="close">Close</button>` :
      `<button type="button" class="btn ghost bad" data-delete>Delete</button><button class="btn" value="save">Save</button>`}</div>
  </form>`);
  const f = d.querySelector("form");
  f.addEventListener("click", async e => {
    const q = e.target.closest("[data-date]");
    if (q) { f.day.value = q.dataset.date; if (!q.dataset.date) f.time.value = ""; return; }
    const mv = e.target.closest("[data-move]");
    if (mv) {
      const next = L.listMove(it, data.state.items.filter(x => x.collection === it.collection), mv.dataset.move);
      if (next) await patch(it, { meta: { list: next } });
      return;
    }
    if (e.target.closest("[data-delete]")) {
      d.close();
      try {
        await api("DELETE", "/todo/api/items/" + it.id);
        data.state.items = data.state.items.filter(x => x.id !== it.id);
        redraw();
        toast(`Deleted “${it.title}”`, async () => { try { put(await api("PATCH", "/todo/api/items/" + it.id, { deleted: false })); redraw(); } catch (err) { failed(err); } });
      } catch (err) { failed(err); }
    }
  });
  f.done?.addEventListener("change", () => { if (f.done.checked) f.onList.checked = true; });
  f.addEventListener("submit", e => {
    if (e.submitter?.value !== "save") return;
    const fd = new FormData(f);
    const out = L.itemChanges(it, {
      title: fd.get("title"), notes: fd.get("notes"), tags: fd.get("tags"), collection: fd.get("collection"),
      onList: !!fd.get("onList"), done: !!fd.get("done"), priority: fd.get("priority"), day: fd.get("day"), time: fd.get("time"), place: fd.get("place"),
    }, { hasCheck, hasEvent, hasPlace });
    if (out.error) { e.preventDefault(); f.querySelector(".err").textContent = out.error; return; }
    if (Object.keys(out).length) patch(it, out);
  });
}

/* ── collections ────────────────────────────────── */
const BUILT_IN = [["checklist", "Checklist", "Tick items off, with a priority"], ["event", "Events", "Dates and times, on a calendar"],
  ["list", "List", "Your own order, nested as an outline"], ["graph", "Graph", "Link items to each other"],
  ["location", "Locations", "Places on a map of the day"]];

function collectionSheet(c) {
  if (c && c.role !== "owner") {
    sheet(`<div class="form"><h2>${esc(c.name)}</h2><p>Shared with you by ${esc(c.owner_name)}${c.role === "view" ? ". You can view it but not change it." : ". You can add and change items."}</p>
      <p class="hint">Leaving a shared collection is on the full site.</p><a class="btn" href="/todo/">Open Drift on the full site</a></div>`);
    return;
  }
  const on = new Set(c ? c.plugins : ["checklist", "event", "list"]);
  const store = c ? c.plugins.filter(p => !L.BY_ID[p]) : [];
  const d = sheet(`<form class="form" method="dialog">
    <h2>${c ? "Collection settings" : "New collection"}</h2>
    <label>Name<input name="name" maxlength="100" value="${esc(c?.name || "")}" required></label>
    <fieldset><legend>Plugins</legend>${BUILT_IN.map(([id, name, what]) =>
      `<label class="toggle wide"><input type="checkbox" name="p" value="${id}" ${on.has(id) ? "checked" : ""}><span><b>${name}</b><small>${what}</small></span></label>`).join("")}
    ${store.length ? `<p class="hint">Plus ${store.length} from the plugin store, kept as they are.</p>` : ""}</fieldset>
    ${c ? `<p class="hint">Sharing with other people is on the full site.</p>` : ""}
    <p class="err" role="alert"></p>
    <div class="buttons">${c ? `<button type="button" class="btn ghost bad" data-delete>Delete</button>` : ""}<button class="btn" value="save">${c ? "Save" : "Create"}</button></div>
  </form>`);
  const f = d.querySelector("form");
  f.addEventListener("submit", async e => {
    if (e.submitter?.value !== "save") return;
    const name = f.elements.namedItem("name").value.trim();
    const plugins = [...f.querySelectorAll("[name=p]:checked")].map(x => x.value).concat(store);
    if (!name) { e.preventDefault(); f.querySelector(".err").textContent = "Give it a name."; return; }
    try {
      if (c) Object.assign(c, await api("PATCH", "/todo/api/collections/" + c.id, { name, plugins }));
      else {
        const made = await api("POST", "/todo/api/collections", { name, plugins, view: plugins.find(p => L.VIEW_LABELS[p]) || null });
        await load(true);
        location.hash = "#drift/" + made.id;
        return;
      }
      redraw();
    } catch (err) { failed(err); }
  });
  f.querySelector("[data-delete]")?.addEventListener("click", async () => {
    if (!confirm(`Delete “${c.name}” and its items?`)) return;
    d.close();
    try {
      await api("DELETE", "/todo/api/collections/" + c.id);
      await load(true);
      location.hash = "#drift/today";
      toast(`Deleted “${c.name}”`, async () => {
        try { await api("PATCH", "/todo/api/collections/" + c.id, { deleted: false }); await load(true); location.hash = "#drift/" + c.id; } catch (err) { failed(err); }
      });
    } catch (err) { failed(err); }
  });
}

/* ── the screen's life ──────────────────────────── */
export async function show(el, [view]) {
  main = el;
  ui.view = view || recall(LAST_VIEW, "today");
  remember(LAST_VIEW, ui.view);
  if (!data.state) main.innerHTML = `<div class="loading" aria-busy="true"></div>`;
  await load(true);
  redraw = draw;
  wire();
  draw();
  stopPoll = every(POLL_EVERY, poll);
}
export function hide() {
  stopPoll?.(); stopPoll = null;
  redraw = () => {};
  document.body.classList.remove("composing");
  if (main) { main.onclick = main.oninput = main.onsubmit = null; }
}

// Home's card: what's overdue and on today, to tick off right there.
export async function homeCard(el) {
  const draw = () => {
    const { late, on } = L.todayGroups(data.state.items);
    const list = [...late, ...on];
    const left = on.filter(L.isOpen).length;
    el.innerHTML = `<section class="card"><a class="card-head" href="#drift/today"><h2>Today in Drift</h2>
      <span class="sub">${late.length ? `<b class="bad">${late.length} overdue</b> · ` : ""}${on.length ? `${left} of ${on.length} open` : "Nothing scheduled"}</span>${icon("right", 18)}</a>
      ${list.length ? `<ul class="items">${list.slice(0, 8).map(it => row(it, { showCol: true })).join("")}</ul>${list.length > 8 ? `<a class="more" href="#drift/today">${list.length - 8} more</a>` : ""}`
        : `<p class="hint">Add something for today with ^today, or from the Drift tab.</p>`}</section>`;
  };
  await load(true);
  redraw = draw;
  draw();
  el.onclick = e => {
    const li = e.target.closest(".item"), it = li && item(li.dataset.id);
    if (!it) return;
    if (e.target.closest("[data-toggle]")) { if (canEdit(it)) toggle(it); return; }
    if (e.target.closest("[data-open]")) itemSheet(it);
  };
}
