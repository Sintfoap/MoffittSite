// Drift: the page. Items are plain base data; plugins (./plugins/) add their
// own metadata and views on top. This file draws the shell (collections,
// tabs, the composer, the item dialog) and hands each view to its plugin.

import { esc, icon, today, parseQuick, niceDay, niceTime, dayOf } from "./lib.js";
import { PLUGINS, BY_ID } from "./plugins/index.js";

const $ = (s, el = document) => el.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem("drift:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("drift:" + k, JSON.stringify(v)); } catch {} },
};
const fail = msg => { throw new Error(msg); };
const cal = icon(BY_ID.event.icon), sun = icon('<circle cx="12" cy="12" r="4.5" fill="currentColor"/><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8"/>');
const notesIco = icon('<path d="M6 4h9l3 3v13H6z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 11h6M9 15h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>', 13);

const state = {
  user: null, collections: [], items: [],
  view: store.get("view", "today"),     // "today" | "calendar" | "c:<collection id>"
  q: "", sel: null, pending: new Set(), viewState: {}, editing: null,
};

/* ── server ────────────────────────────────────── */
async function req(method, path, body) {
  const r = await fetch("/todo/api/" + path, {
    method, credentials: "same-origin", cache: "no-store", redirect: "manual",
    headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  // The session ran out: reload, and the site sends you to sign in.
  if (r.type === "opaqueredirect" || r.status === 401 || r.status === 403) { location.reload(); throw new Error("signed out"); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
let loading = null;
function refresh() {
  return loading ||= (async () => {
    try {
      const s = await req("GET", "state");
      Object.assign(state, { user: s.user, collections: s.collections, items: s.items, version: s.version });
    } catch (e) { if (e.message !== "signed out") toast("Couldn’t reach the server"); }
    loading = null;
    if (!$("#itemDlg").open && !$("#colDlg").open) render();
  })();
}
const replaceItem = it => { const i = state.items.findIndex(x => x.id === it.id); if (i >= 0) state.items[i] = it; else state.items.push(it); };

async function update(id, changes) {
  const it = state.items.find(x => x.id === id); if (!it) return;
  Object.assign(it, changes); render();
  try { replaceItem(await req("PATCH", "items/" + id, changes)); }
  catch (e) { toast("Couldn’t save: " + e.message); refresh(); }
  render();
}

// Sets (or with null, removes) one plugin's metadata on an item.
async function setMeta(id, pid, value, { celebrate = false } = {}) {
  const it = state.items.find(x => x.id === id); if (!it) return;
  const apply = async () => {
    try { if (value === null) delete it.meta[pid]; else it.meta[pid] = BY_ID[pid].clean(value, fail); }
    catch (e) { return toast(e.message); }
    render();
    try { replaceItem(await req("PATCH", "items/" + id, { meta: { [pid]: value } })); }
    catch (e) { toast("Couldn’t save: " + e.message); refresh(); }
    if (state.editing === id) renderItemDialog();
    render();
  };
  if (!celebrate) return apply();
  state.pending.add(id); render();
  setTimeout(() => { state.pending.delete(id); apply(); }, 650);
}

async function removeItem(id) {
  const it = state.items.find(x => x.id === id); if (!it) return;
  state.items = state.items.filter(x => x.id !== id);
  if (state.sel === id) state.sel = null;
  render();
  try { await req("DELETE", "items/" + id); }
  catch (e) { toast("Couldn’t delete: " + e.message); return refresh(); }
  toast(`Deleted “${it.title}”`, async () => { replaceItem(await req("PATCH", "items/" + id, { deleted: false })); render(); });
}

/* ── what's on screen ──────────────────────────── */
const colById = id => state.collections.find(c => c.id === id);
const viewPlugins = col => col.plugins.map(id => BY_ID[id]).filter(p => p?.view);
const isOpen = it => !it.meta.checklist?.done;
function tabFor(col) {
  const tabs = viewPlugins(col).map(p => p.id);
  const t = state.viewState["tab:" + col.id] || col.view;
  return tabs.includes(t) ? t : tabs[0] || null;
}
function current() {
  if (state.view.startsWith("c:")) {
    const col = colById(state.view.slice(2));
    if (col) return { kind: "col", col, tab: tabFor(col) };
    state.view = "today";
  }
  return { kind: state.view === "calendar" ? "calendar" : "today", col: null, tab: state.view === "calendar" ? "event" : null };
}
function matches(it) {
  if (!state.q) return true;
  const q = state.q.toLowerCase();
  return [it.title, it.notes, ...it.tags].some(s => (s || "").toLowerCase().includes(q));
}
const scope = cur => cur.col ? state.items.filter(it => it.collection === cur.col.id) : state.items;

/* ── rows and groups, handed to plugins as ctx ─── */
function row(it, opts = {}) {
  const cur = current();
  const on = PLUGINS.filter(p => it.meta[p.id] !== undefined);
  const lead = on.find(p => p.lead)?.lead(it, ctx()) || `<span class="bullet"></span>`;
  const cls = ["item", ...on.map(p => p.rowClass?.(it) || ""), state.pending.has(it.id) ? "completing" : "", state.sel === it.id ? "sel" : ""];
  const chips = [
    ...on.filter(p => p.chips && !(opts.skip || []).includes(p.id)).flatMap(p => p.chips(it, ctx())),
    ...(opts.chips?.(it) || []),
    ...(cur.kind !== "col" && colById(it.collection) ? [`<span class="chip col">${esc(colById(it.collection).name)}</span>`] : []),
    ...it.tags.map(g => `<span class="chip tag">#${esc(g)}</span>`),
    ...(it.notes ? [`<span class="chip" title="Has notes">${notesIco}Notes</span>`] : []),
  ];
  return `<li class="${cls.join(" ")}" data-id="${esc(it.id)}" style="--depth:${opts.depth || 0}"><span class="pbar"></span>
    <div class="line"><span class="lead">${lead}</span>
      <div class="body" data-open tabindex="0"><div class="title">${esc(it.title)}</div><div class="meta">${chips.join("")}</div></div>
      <span class="trail">${opts.trail || ""}</span></div></li>`;
}
const group = (title, items, extra = "", opts = {}) =>
  `<div class="group ${opts.cls || ""}"><h2>${esc(title)}<small>${items.length || ""}</small></h2><ul class="items">${items.map(it => row(it, opts)).join("")}</ul>${extra}</div>`;
const empty = (title, msg) => `<div class="empty"><b>${esc(title)}</b>${esc(msg)}</div>`;

function ctx() {
  const cur = current(), all = scope(cur);
  const key = cur.kind === "col" ? `${cur.col.id}:${cur.tab}` : cur.kind;
  return {
    collection: cur.col, tab: cur.tab, items: all.filter(matches), scopeItems: all, filtered: Boolean(state.q),
    pending: state.pending, viewState: (state.viewState[key] ||= {}),
    row, group, empty, render, setMeta, update,
  };
}

/* ── render ────────────────────────────────────── */
function render() {
  renderNav();
  const cur = current(), c = ctx(), el = $("#list");
  let sub = "", tabs = "", body, view = null;
  if (cur.kind === "today") {
    const now = new Date();
    $("#h1").textContent = now.toLocaleDateString(undefined, { weekday: "long" });
    const ev = c.items.filter(it => it.meta.event);
    const late = ev.filter(it => isOpen(it) && dayOf(it.meta.event.end || it.meta.event.start) < today());
    const on = ev.filter(it => dayOf(it.meta.event.start) <= today() && today() <= dayOf(it.meta.event.end || it.meta.event.start))
      .sort((a, b) => (a.meta.event.start.length - b.meta.event.start.length) || a.meta.event.start.localeCompare(b.meta.event.start));
    const left = on.filter(isOpen).length;
    sub = `<span>${esc(now.toLocaleDateString(undefined, { month: "long", day: "numeric" }))}</span><span>${on.length ? `${left} of ${on.length} still open` : "Nothing scheduled"}</span>`;
    body = (late.length ? group("Overdue", late, "", { cls: "overdue" }) : "") +
      (on.length ? group("Today", on, "", { skip: ["event"], chips: it => it.meta.event.start.includes("T") ? [`<span class="chip">${esc(niceTime(it.meta.event.start.slice(11)))}</span>`] : [] }) : "");
    if (!body) body = empty("Nothing for today", "Items with today’s date, from any collection, show up here. Add one above.");
    document.title = "Today · Drift";
  } else if (cur.kind === "calendar") {
    $("#h1").textContent = "Calendar";
    sub = `<span>Events from every collection</span>`;
    view = BY_ID.event;
    document.title = "Calendar · Drift";
  } else {
    const col = cur.col, n = c.scopeItems.length;
    $("#h1").textContent = col.name;
    sub = `<span>${n} item${n === 1 ? "" : "s"}</span>`;
    tabs = viewPlugins(col).map(p => `<button data-tab="${p.id}" aria-pressed="${p.id === cur.tab}">${icon(p.icon, 15)}${esc(p.view.label)}</button>`).join("")
      + `<button class="gear" data-settings>Plugins and settings</button>`;
    if (cur.tab) view = BY_ID[cur.tab];
    else body = c.items.length ? group("Items", c.items) + `<p class="hint">Turn on a plugin in settings to get more views.</p>`
      : empty("Nothing here yet", "Add an item above. Turn on plugins in settings for checklists, calendars and lists.");
    document.title = `${col.name} · Drift`;
  }
  $("#sub").innerHTML = sub;
  $("#tabs").innerHTML = tabs;
  if (view) showView(view, c);
  else { unmountView(); el.innerHTML = body; }
  $("#who").textContent = state.user?.name || "";
}

// A plugin view either returns HTML from render(), redrawn on every change, or
// has mount(el, ctx) to build its own DOM once (a zoomable graph, a canvas),
// then update(ctx) on each change and unmount() when you leave it.
let mounted = null;
function showView(p, c) {
  if (!p.view.mount) { unmountView(); $("#list").innerHTML = p.view.render(c); return; }
  const key = `${state.view}:${p.id}`;
  if (mounted?.key === key) return p.view.update?.(c);
  unmountView();
  const host = document.createElement("div");
  host.className = "view-host";
  $("#list").replaceChildren(host);
  mounted = { key, p };
  p.view.mount(host, c);
}
function unmountView() {
  if (!mounted) return;
  const { p } = mounted; mounted = null;
  try { p.view.unmount?.(); } catch (e) { console.error(e); }
}

function renderNav() {
  const live = state.items.filter(it => it.meta.event && isOpen(it));
  const late = live.some(it => dayOf(it.meta.event.end || it.meta.event.start) < today());
  const nToday = live.filter(it => dayOf(it.meta.event.start) <= today()).length;
  const btn = (view, label, ico, n, hot) =>
    `<button data-view="${esc(view)}" aria-current="${state.view === view}"><span class="ico">${ico}</span><span>${esc(label)}</span><span class="n ${hot ? "hot" : ""}">${n || ""}</span></button>`;
  $("#views").innerHTML = btn("today", "Today", sun, nToday, late) + btn("calendar", "Calendar", cal, 0);
  $("#cols").innerHTML = `<h3>Collections</h3>` + state.collections.map(col =>
    btn("c:" + col.id, col.name, icon(BY_ID[col.plugins[0]]?.icon || '<circle cx="12" cy="12" r="3" fill="currentColor"/>'),
      state.items.filter(it => it.collection === col.id && isOpen(it)).length)).join("")
    + `<button class="add" data-newcol><span class="ico">${icon('<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>')}</span><span>New collection</span><span></span></button>`;
}

function setView(v) { state.view = v; state.sel = null; store.set("view", v); render(); window.scrollTo({ top: 0 }); }

/* ── item dialog ───────────────────────────────── */
function openItem(id) { state.editing = id; state.sel = id; renderItemDialog(); $("#itemDlg").showModal(); }
function renderItemDialog() {
  const it = state.items.find(x => x.id === state.editing);
  if (!it) { $("#itemDlg").close(); return; }
  const col = colById(it.collection);
  const shown = PLUGINS.filter(p => col?.plugins.includes(p.id) || it.meta[p.id] !== undefined);
  $("#itemForm").innerHTML = `
    <input type="text" class="t" name="title" value="${esc(it.title)}" aria-label="Title" required>
    <label>Notes<textarea name="notes" placeholder="Details, links, anything">${esc(it.notes)}</textarea></label>
    <div class="grid">
      <label>Tags<input type="text" name="tags" value="${esc(it.tags.join(" "))}" placeholder="Separate with spaces"></label>
      <label>Collection<select name="collection">${state.collections.map(c => `<option value="${esc(c.id)}" ${c.id === it.collection ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
    </div>
    ${shown.map(p => it.meta[p.id] !== undefined
      ? `<fieldset data-plugin="${p.id}"><legend>${icon(p.icon, 15)}${esc(p.name)}</legend>${p.editor(it, ctx())}
          <div class="row"><span></span><button type="button" class="link" data-detach="${p.id}">Remove from ${esc(p.name)}</button></div></fieldset>`
      : `<fieldset class="off"><legend>${icon(p.icon, 15)}${esc(p.name)}</legend>
          <div class="row"><span class="hint">${esc(p.description)}</span><button type="button" class="link" data-attach="${p.id}">Add</button></div></fieldset>`).join("")}
    <div class="acts"><button type="button" class="danger" data-del>Delete item</button><button class="btn primary" value="close">Done</button></div>`;
}
function readFieldset(fs) {
  const out = {};
  for (const el of fs.querySelectorAll("[name]")) out[el.name] = el.type === "checkbox" ? el.checked : el.value;
  return out;
}
$("#itemForm").addEventListener("change", e => {
  const it = state.items.find(x => x.id === state.editing); if (!it) return;
  const fs = e.target.closest("fieldset[data-plugin]");
  if (fs) { const p = BY_ID[fs.dataset.plugin]; return setMeta(it.id, p.id, p.read(readFieldset(fs), it)); }
  const { name, value } = e.target;
  if (name === "title") { if (value.trim()) update(it.id, { title: value }); }
  else if (name === "notes") update(it.id, { notes: value });
  else if (name === "tags") update(it.id, { tags: value.split(/[,\s]+/).map(x => x.replace(/^#/, "").toLowerCase()).filter(Boolean) });
  else if (name === "collection") { update(it.id, { collection: value }).then(renderItemDialog); }
});
$("#itemForm").addEventListener("click", e => {
  const it = state.items.find(x => x.id === state.editing); if (!it) return;
  const set = e.target.closest("[data-set]");
  if (set) {
    const [k, v] = set.dataset.set.split("="), input = set.closest("fieldset").querySelector(`[name="${k}"]`);
    input.value = v; input.dispatchEvent(new Event("change", { bubbles: true })); return;
  }
  const at = e.target.closest("[data-attach]");
  if (at) { const p = BY_ID[at.dataset.attach]; return setMeta(it.id, p.id, p.fresh?.({}, { tab: p.id, viewState: {} }) ?? p.read({}, it)); }
  const de = e.target.closest("[data-detach]");
  if (de) return setMeta(it.id, de.dataset.detach, null);
  if (e.target.closest("[data-del]")) { $("#itemDlg").close(); removeItem(it.id); }
});
$("#itemDlg").addEventListener("close", () => {
  const t = $("#itemForm [name=title]");                 // save a title still being typed
  const it = state.items.find(x => x.id === state.editing);
  if (it && t && t.value.trim() && t.value !== it.title) update(it.id, { title: t.value });
  state.editing = null; render();
});

/* ── collection dialog ─────────────────────────── */
let editingCol = null;
function openCollection(col) {
  editingCol = col;
  $("#colForm").innerHTML = `
    <h2>${col ? "Collection settings" : "New collection"}</h2>
    <label>Name<input type="text" name="name" value="${esc(col?.name || "")}" required maxlength="100" placeholder="e.g. Home, Work, Reading"></label>
    <div><p>Plugins decide what you can add to items here and how you can see them.</p>
      <div style="display:grid;gap:8px">${PLUGINS.map(p => `<label class="plug"><input type="checkbox" name="plugin" value="${p.id}" ${(col ? col.plugins.includes(p.id) : true) ? "checked" : ""}>
        <b>${esc(p.name)}</b><span>${esc(p.description)}</span></label>`).join("")}</div></div>
    <div class="acts">${col ? `<button type="button" class="danger" data-delcol>Delete collection</button>` : "<span></span>"}
      <span><button class="btn" value="cancel" formnovalidate>Cancel</button> <button class="btn primary" value="save">${col ? "Save" : "Create"}</button></span></div>`;
  $("#colDlg").showModal();
  $("#colForm [name=name]").focus();
}
$("#colForm").addEventListener("submit", async e => {
  if (e.submitter?.value !== "save") return;
  const name = $("#colForm [name=name]").value.trim();
  const plugins = [...$("#colForm").querySelectorAll("[name=plugin]:checked")].map(x => x.value);
  try {
    if (editingCol) {
      const c = await req("PATCH", "collections/" + editingCol.id, { name, plugins });
      state.collections = state.collections.map(x => x.id === c.id ? c : x);
      render();
    } else {
      const c = await req("POST", "collections", { name, plugins, view: plugins.find(id => BY_ID[id].view) || "" });
      state.collections.push(c); setView("c:" + c.id);
    }
  } catch (err) { toast(err.message); }
});
$("#colForm").addEventListener("click", async e => {
  if (!e.target.closest("[data-delcol]")) return;
  const col = editingCol;
  if (!confirm(`Delete “${col.name}” and the items in it?`)) return;
  $("#colDlg").close();
  try { await req("DELETE", "collections/" + col.id); }
  catch (err) { return toast(err.message); }
  state.collections = state.collections.filter(c => c.id !== col.id);
  setView("today");
  toast(`Deleted “${col.name}”`, async () => { await req("PATCH", "collections/" + col.id, { deleted: false }); await refresh(); setView("c:" + col.id); });
});

/* ── toast ─────────────────────────────────────── */
let toastT;
function toast(msg, undo) {
  $("#toastMsg").textContent = msg; const b = $("#toastBtn");
  b.hidden = !undo; b.onclick = () => { undo?.(); $("#toast").classList.remove("on"); };
  $("#toast").classList.add("on"); clearTimeout(toastT);
  toastT = setTimeout(() => $("#toast").classList.remove("on"), undo ? 5000 : 2600);
}

/* ── composer ──────────────────────────────────── */
const add = $("#add");
if (matchMedia("(max-width:760px)").matches) add.placeholder = "Add an item";
add.addEventListener("input", () => {
  const v = add.value.trim(); $("#go").disabled = !v;
  if (!v) { $("#preview").innerHTML = ""; return; }
  const [, f] = parseQuick(v), ch = [];
  if (f.date || f.time) ch.push(`<span class="chip due today">${icon(BY_ID.event.icon, 13)}${esc(f.date ? niceDay(f.date) : "Today")}${f.time ? " " + esc(niceTime(f.time)) : ""}</span>`);
  if (f.priority) ch.push(`<span class="chip" style="color:var(--${["", "blue", "amber", "red"][f.priority]})">${["", "Low", "Medium", "High"][f.priority]} priority</span>`);
  if (f.collection) ch.push(`<span class="chip col">+${esc(f.collection)}</span>`);
  (f.tags || []).forEach(g => ch.push(`<span class="chip tag">#${esc(g)}</span>`));
  $("#preview").innerHTML = ch.join("");
});
$("#composer").addEventListener("submit", async e => {
  e.preventDefault(); const text = add.value.trim(); if (!text) return;
  const [title, quick] = parseQuick(text);
  if (!title) return toast("Give the item a name before the tags.");
  const cur = current();
  let col = cur.col || state.collections[0];
  if (quick.collection) {
    col = state.collections.find(c => c.name.toLowerCase() === quick.collection.toLowerCase());
    if (!col) return toast(`There’s no collection called “${quick.collection}”.`);
  }
  // Each plugin that's on decides what a new item starts with. On Today and
  // Calendar, items always get a date so they show up where you added them.
  const c = { ...ctx(), tab: col === cur.col ? cur.tab : cur.kind === "col" ? null : "event" };
  const meta = {};
  for (const p of PLUGINS) {
    if (!col.plugins.includes(p.id) && !(p.id === "event" && cur.kind !== "col")) continue;
    const m = p.fresh?.(quick, c);
    if (m !== undefined) meta[p.id] = m;
  }
  add.value = ""; add.dispatchEvent(new Event("input"));
  try {
    const it = await req("POST", "items", { title, collection: col.id, tags: quick.tags || [], meta });
    state.items.push(it); render();
    toast(col === cur.col ? `Added “${title}”` : `Added “${title}” to ${col.name}`);
  } catch (err) { toast("Couldn’t add: " + err.message); add.value = text; }
});
$("#q").addEventListener("input", e => { state.q = e.target.value; render(); });

/* ── clicks ────────────────────────────────────── */
$("aside").addEventListener("click", e => {
  const b = e.target.closest("[data-view]"); if (b) return setView(b.dataset.view);
  if (e.target.closest("[data-newcol]")) openCollection(null);
});
$("#tabs").addEventListener("click", e => {
  const cur = current();
  const t = e.target.closest("[data-tab]");
  if (t) {
    state.viewState["tab:" + cur.col.id] = t.dataset.tab; render();
    req("PATCH", "collections/" + cur.col.id, { view: t.dataset.tab }).then(c => { cur.col.view = c.view; }).catch(() => {});
    return;
  }
  if (e.target.closest("[data-settings]")) openCollection(cur.col);
});
$("#list").addEventListener("click", e => {
  const li = e.target.closest(".item"), it = li && state.items.find(x => x.id === li.dataset.id);
  const act = e.target.closest("[data-act]");
  if (act) {
    const [pid, name] = act.dataset.act.split(":");
    if (it) state.sel = it.id;
    return BY_ID[pid]?.actions?.[name]?.(it, ctx(), act);
  }
  if (it && e.target.closest("[data-open]")) openItem(it.id);
});
$("#list").addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.matches("[data-open]")) { e.preventDefault(); e.target.click(); }
});

/* ── keyboard ──────────────────────────────────── */
document.addEventListener("keydown", e => {
  const typing = e.target.matches("input, textarea, select") || e.target.isContentEditable;
  if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
    if (typing) { e.target.blur(); if (e.target.id === "q") { state.q = ""; e.target.value = ""; render(); } return; }
    if (state.sel) { state.sel = null; render(); return; }
  }
  if (typing || e.metaKey || e.ctrlKey || document.querySelector("dialog[open]")) return;
  const ids = [...document.querySelectorAll("#list .item")].map(li => li.dataset.id);
  const i = ids.indexOf(state.sel);
  const sel = id => { state.sel = id; render(); document.querySelector(`#list [data-id="${id}"]`)?.scrollIntoView({ block: "nearest" }); };
  const it = state.items.find(x => x.id === state.sel);

  // Plugin keys for the selected item: the current view's plugin, then any the item uses.
  if (it) {
    const name = (e.altKey ? "A-" : "") + (e.shiftKey && e.key === "Tab" ? "S-" : "") + e.key;
    const c = ctx();
    const order = [BY_ID[c.tab], ...PLUGINS.filter(p => it.meta[p.id] !== undefined)].filter(Boolean);
    for (const p of order) {
      const fn = p.keys?.[name];
      if (fn && fn(it, c) !== false) { e.preventDefault(); return; }
    }
  }
  if (e.altKey) return;
  switch (e.key) {
    case "n": case "a": e.preventDefault(); add.focus(); break;
    case "/": e.preventDefault(); $("#q").focus(); break;
    case "?": $("#keys").showModal(); break;
    case "j": case "ArrowDown": if (ids.length) { e.preventDefault(); sel(ids[Math.min(i + 1, ids.length - 1)]); } break;
    case "k": case "ArrowUp": if (ids.length) { e.preventDefault(); sel(ids[Math.max(i - 1, 0)]); } break;
    case "e": case "Enter": if (it) { e.preventDefault(); openItem(it.id); } break;
    case "Backspace": case "Delete": if (it) { const nx = ids[i + 1] || ids[i - 1]; removeItem(it.id); state.sel = nx || null; render(); } break;
  }
});

$("#keysBtn").onclick = () => $("#keys").showModal();
$("#themeBtn").onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "light" : "dark"; store.set("theme", document.documentElement.dataset.theme);
};
{ const th = store.get("theme", null); if (th) document.documentElement.dataset.theme = th; }

/* ── boot ──────────────────────────────────────── */
// No push channel: every 5s while the tab is visible, ask whether anything
// changed and reload only if it did. Also re-sync on return to the tab.
const poll = () => { if (!document.hidden) refresh(); };
setInterval(async () => {
  if (document.hidden || loading || document.querySelector("dialog[open]")) return;
  try { const { version } = await req("GET", "version"); if (version !== state.version) refresh(); } catch {}
}, 5_000);
document.addEventListener("visibilitychange", poll);
window.addEventListener("focus", poll);
setInterval(() => { if (!document.querySelector("dialog[open]")) render(); }, 60_000);   // midnight rollover
refresh();
