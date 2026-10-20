// Drift: the page. Items are plain base data; plugins (./plugins/) add their
// own metadata and views on top. This file draws the shell (collections,
// tabs, the composer, the item dialog) and hands each view to its plugin.

import { esc, icon, today, parseQuick, niceDay, niceTime, dayOf } from "./lib.js";
import { PLUGINS as BUILT_IN } from "./plugins/index.js";
import { StorePlugins } from "./plugin-host.js";

// Drift's own plugins plus any from the plugin store (see plugin-host.js).
let PLUGINS = [...BUILT_IN], BY_ID = Object.fromEntries(PLUGINS.map(p => [p.id, p]));

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
      const extra = await storePlugins.load(s.store || []);
      PLUGINS = [...BUILT_IN, ...extra]; BY_ID = Object.fromEntries(PLUGINS.map(p => [p.id, p]));
    } catch (e) { if (e.message !== "signed out") toast("Couldn’t reach the server"); }
    loading = null;
    if (!$("#itemDlg").open && !$("#colDlg").open) render();
  })();
}
const replaceItem = it => { const i = state.items.findIndex(x => x.id === it.id); if (i >= 0) state.items[i] = it; else state.items.push(it); };

async function update(id, changes) {
  const it = state.items.find(x => x.id === id); if (!it || !canEdit(it)) return;
  Object.assign(it, changes); render();
  try { replaceItem(await req("PATCH", "items/" + id, changes)); }
  catch (e) { toast("Couldn’t save: " + e.message); refresh(); }
  render();
}

// Sets (or with null, removes) one plugin's metadata on an item.
async function setMeta(id, pid, value, { celebrate = false } = {}) {
  const it = state.items.find(x => x.id === id); if (!it || !canEdit(it)) return;
  const apply = async () => {
    // Store plugins check their data in the sandbox, so clean() may be a promise.
    try { if (value === null) delete it.meta[pid]; else it.meta[pid] = await (BY_ID[pid] || fail("that plugin isn't loaded")).clean(value, fail); }
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

// A collection's bases (Locations' Map view): anyone who can edit its items can change them.
// Saved before it's shown, since the route the map asks for depends on it.
async function setBases(id, bases) {
  if (!writable(colById(id))) return toast("You can view this collection but not change it.");
  try { const { bases: saved } = await req("PATCH", "collections/" + id, { bases }); if (colById(id)) colById(id).bases = saved; }
  catch (e) { toast("Couldn’t save the base: " + e.message); }
  render();
}

async function removeItem(id) {
  const it = state.items.find(x => x.id === id); if (!it || !canEdit(it)) return;
  state.items = state.items.filter(x => x.id !== id);
  if (state.sel === id) state.sel = null;
  render();
  try { await req("DELETE", "items/" + id); }
  catch (e) { toast("Couldn’t delete: " + e.message); return refresh(); }
  toast(`Deleted “${it.title}”`, async () => { replaceItem(await req("PATCH", "items/" + id, { deleted: false })); render(); });
}

// View-only shared collections can be read but not changed.
const writable = col => Boolean(col) && col.role !== "view";
function canEdit(it) {
  if (writable(colById(it?.collection))) return true;
  toast("You can view this collection but not change it.");
  return false;
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
    all: state.items, selected: state.sel, open: openItem,
    row, group, empty, render, setMeta, update, toast,
    setBases: bases => cur.col && setBases(cur.col.id, bases),
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
    sub = `<span>${n} item${n === 1 ? "" : "s"}</span>` + (col.role !== "owner"
      ? `<span>Shared by ${esc(col.owner_name)}${col.role === "view" ? ", view only" : ""}</span>`
      : col.shares?.length ? `<span>Shared with ${esc(col.shares.map(x => x.name).join(", "))}</span>` : "");
    tabs = viewPlugins(col).map(p => `<button data-tab="${p.id}" aria-pressed="${p.id === cur.tab}">${icon(p.icon, 15)}${esc(p.view.label)}</button>`).join("")
      + `<button class="gear" data-settings>${col.role === "owner" ? "Plugins, sharing and settings" : "About this collection"}</button>`;
    if (cur.tab) view = BY_ID[cur.tab];
    else body = c.items.length ? group("Items", c.items) + `<p class="hint">Turn on a plugin in settings to get more views.</p>`
      : empty("Nothing here yet", "Add an item above. Turn on plugins in settings for checklists, calendars and lists.");
    document.title = `${col.name} · Drift`;
  }
  const ro = cur.kind === "col" && !writable(cur.col);
  add.disabled = ro; add.placeholder = ro ? "This collection is view-only for you" : addHint;
  $("#sub").innerHTML = sub;
  $("#tabs").innerHTML = tabs;
  if (view) showView(view, c);
  else { unmountView(); el.innerHTML = body; }
  storePlugins.sync();
}

// A plugin view either returns HTML from render(), redrawn on every change, or
// has mount(el, ctx) to build its own DOM once (a zoomable graph, a canvas),
// then update(ctx) on each change and unmount() when you leave it.
let mounted = null;
function showView(p, c) {
  if (!p.view.mount) { unmountView(); $("#list").innerHTML = p.view.render(c); return; }
  const key = `${state.view}:${p.id}`;
  if (mounted?.key === key && mounted.p === p) return p.view.update?.(c);
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
  const colBtn = col => btn("c:" + col.id, col.name, icon(BY_ID[col.plugins[0]]?.icon || '<circle cx="12" cy="12" r="3" fill="currentColor"/>'),
    state.items.filter(it => it.collection === col.id && isOpen(it)).length);
  const shared = state.collections.filter(c => c.role !== "owner");
  $("#cols").innerHTML = `<h3>Collections</h3>` + state.collections.filter(c => c.role === "owner").map(colBtn).join("")
    + `<button class="add" data-newcol><span class="ico">${icon('<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>')}</span><span>New collection</span><span></span></button>`
    + (shared.length ? `<h3 class="sh">Shared with you</h3>` + shared.map(colBtn).join("") : "");
}

function setView(v) { state.view = v; state.sel = null; store.set("view", v); render(); window.scrollTo({ top: 0 }); }

/* ── item dialog ───────────────────────────────── */
function openItem(id) { state.editing = id; state.sel = id; renderItemDialog(); $("#itemDlg").showModal(); storePlugins.sync(); }
function renderItemDialog() {
  const it = state.items.find(x => x.id === state.editing);
  if (!it) { $("#itemDlg").close(); return; }
  const col = colById(it.collection), ro = !writable(col);
  const shown = PLUGINS.filter(p => col?.plugins.includes(p.id) || it.meta[p.id] !== undefined);
  const moveTo = state.collections.filter(c => c.id === it.collection || (writable(c) && c.owner === col?.owner));
  $("#itemForm").innerHTML = `<fieldset class="bare" ${ro ? "disabled" : ""}>
    ${ro ? `<p class="hint">Shared by ${esc(col.owner_name)}. You can view it but not change it.</p>` : ""}
    <input type="text" class="t" name="title" value="${esc(it.title)}" aria-label="Title" required>
    <label>Notes<textarea name="notes" placeholder="Details, links, anything">${esc(it.notes)}</textarea></label>
    <div class="grid">
      <label>Tags<input type="text" name="tags" value="${esc(it.tags.join(" "))}" placeholder="Separate with spaces"></label>
      <label>Collection<select name="collection">${moveTo.map(c => `<option value="${esc(c.id)}" ${c.id === it.collection ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
    </div>
    ${shown.map(p => it.meta[p.id] !== undefined
      ? `<fieldset data-plugin="${p.id}"><legend>${icon(p.icon, 15)}${esc(p.name)}</legend>${p.editor(it, ctx())}
          <div class="row"><span></span><button type="button" class="link" data-detach="${p.id}">Remove from ${esc(p.name)}</button></div></fieldset>`
      : `<fieldset class="off"><legend>${icon(p.icon, 15)}${esc(p.name)}</legend>
          <div class="row"><span class="hint">${esc(p.description)}</span><button type="button" class="link" data-attach="${p.id}">Add</button></div></fieldset>`).join("")}
    </fieldset>
    <div class="acts">${ro ? "<span></span>" : `<button type="button" class="danger" data-del>Delete item</button>`}<button class="btn primary" value="close">Done</button></div>`;
  // Editors that need more than inputs (Locations' search) wire themselves up.
  if (!ro) for (const fs of $("#itemForm").querySelectorAll("fieldset[data-plugin]")) {
    const p = BY_ID[fs.dataset.plugin];
    if (!p?.store && typeof p?.mountEditor === "function") p.mountEditor(fs, it, ctx());
  }
}
function readFieldset(fs) {
  const out = {};
  for (const el of fs.querySelectorAll("[name]")) {
    // A tick box with its own value is one of a list: collect the ticked values.
    if (el.type === "checkbox" && el.hasAttribute("value")) { (out[el.name] ||= []); if (el.checked) out[el.name].push(el.value); }
    else out[el.name] = el.type === "checkbox" ? el.checked : el.value;
  }
  return out;
}
$("#itemForm").addEventListener("change", e => {
  const it = state.items.find(x => x.id === state.editing); if (!it) return;
  const fs = e.target.closest("fieldset[data-plugin]");
  if (fs) {
    const p = BY_ID[fs.dataset.plugin];
    return Promise.resolve(p.read(readFieldset(fs), it)).then(v => setMeta(it.id, p.id, v)).catch(err => toast(err.message));
  }
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
  if (at) {
    const p = BY_ID[at.dataset.attach];
    return Promise.resolve(p.fresh?.({}, { tab: p.id, viewState: {} }, it) ?? p.read({}, it))
      .then(v => setMeta(it.id, p.id, v ?? {})).catch(err => toast(err.message));
  }
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
  if (col && col.role !== "owner") {
    $("#colForm").innerHTML = `
      <h2>${esc(col.name)}</h2>
      <p>Shared with you by <b>${esc(col.owner_name)}</b>. You can ${col.role === "edit" ? "add and change items" : "view items but not change them"}.
        Only ${esc(col.owner_name)} can rename it, change its plugins or share it.</p>
      <p>Plugins: ${col.plugins.map(id => esc(BY_ID[id]?.name || id)).join(", ") || "none"}.</p>
      <div class="acts"><button type="button" class="danger" data-leave>Leave collection</button>
        <button class="btn primary" value="cancel" formnovalidate>Done</button></div>`;
    return $("#colDlg").showModal();
  }
  $("#colForm").innerHTML = `
    <h2>${col ? "Collection settings" : "New collection"}</h2>
    <label>Name<input type="text" name="name" value="${esc(col?.name || "")}" required maxlength="100" placeholder="e.g. Home, Work, Reading"></label>
    <div><p>Plugins decide what you can add to items here and how you can see them.</p>
      <div style="display:grid;gap:8px">${PLUGINS.filter(p => !p.store || p.installed || col?.plugins.includes(p.id)).map(p => `<label class="plug"><input type="checkbox" name="plugin" value="${p.id}" ${(col ? col.plugins.includes(p.id) : !p.store) ? "checked" : ""}>
        <b>${esc(p.name)}</b><span>${esc(p.description)}${p.store ? ` <small>From the plugin store, by ${esc(p.author || "a removed account")}</small>` : ""}</span></label>`).join("")}</div>
      <p class="hint"><a href="/plugins/">Find more plugins in the plugin store</a></p></div>
    ${col ? `<div class="sharing"><p>Sharing. People you add see this collection in their Drift. Editors can add and change items; viewers can only look.</p>
      <ul class="people">${(col.shares || []).map(x => `<li><span>${esc(x.name)} <small>@${esc(x.username)}</small></span>
        <select data-role="${esc(x.username)}" aria-label="Role for ${esc(x.username)}"><option value="edit" ${x.role === "edit" ? "selected" : ""}>Can edit</option><option value="view" ${x.role === "view" ? "selected" : ""}>Can view</option></select>
        <button type="button" class="link" data-unshare="${esc(x.username)}">Remove</button></li>`).join("") || `<li class="hint">Only you.</li>`}</ul>
      <div class="row"><input type="text" name="shareWith" placeholder="Their username" autocomplete="off" autocapitalize="none">
        <select name="shareRole"><option value="edit">Can edit</option><option value="view">Can view</option></select>
        <button type="button" class="btn" data-share>Share</button></div></div>` : ""}
    <div class="acts">${col ? `<button type="button" class="danger" data-delcol>Delete collection</button>` : "<span></span>"}
      <span><button class="btn" value="cancel" formnovalidate>Cancel</button> <button class="btn primary" value="save">${col ? "Save" : "Create"}</button></span></div>`;
  $("#colDlg").showModal();
  $("#colForm [name=name]").focus();
}
// Merges a collection from the server into what the page knows (the server's
// copy of your own collection doesn't carry role or sharing).
function putCollection(c) {
  const old = colById(c.id);
  const merged = { owner: state.user?.id, role: "owner", shares: [], ...old, ...c };
  state.collections = old ? state.collections.map(x => x.id === c.id ? merged : x) : [...state.collections, merged];
  return merged;
}
$("#colForm").addEventListener("submit", async e => {
  if (e.submitter?.value !== "save") return;
  const name = $("#colForm [name=name]").value.trim();
  const plugins = [...$("#colForm").querySelectorAll("[name=plugin]:checked")].map(x => x.value);
  try {
    if (editingCol) { putCollection(await req("PATCH", "collections/" + editingCol.id, { name, plugins })); render(); }
    else {
      const c = putCollection(await req("POST", "collections", { name, plugins, view: plugins.find(id => BY_ID[id].view) || "" }));
      setView("c:" + c.id);
    }
  } catch (err) { toast(err.message); }
});
async function share(username, role) {
  const col = editingCol;
  try {
    const x = await req("POST", `collections/${col.id}/shares`, { username, role });
    col.shares = [...(col.shares || []).filter(s => s.username !== x.username), x].sort((a, b) => a.username.localeCompare(b.username));
    openCollection(col); render();
    toast(`${x.name} can now ${role === "edit" ? "edit" : "view"} “${col.name}”`);
  } catch (err) { toast(err.message); }
}
$("#colForm").addEventListener("change", e => {
  const r = e.target.closest("[data-role]"); if (r) share(r.dataset.role, r.value);
});
$("#colForm").addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.name === "shareWith") { e.preventDefault(); $("#colForm [data-share]").click(); }
});
$("#colForm").addEventListener("click", async e => {
  const col = editingCol;
  if (e.target.closest("[data-share]")) {
    const u = $("#colForm [name=shareWith]").value.trim().replace(/^@/, "");
    if (u) share(u, $("#colForm [name=shareRole]").value);
    return;
  }
  const un = e.target.closest("[data-unshare]");
  if (un) {
    try { await req("DELETE", `collections/${col.id}/shares/${encodeURIComponent(un.dataset.unshare)}`); }
    catch (err) { return toast(err.message); }
    col.shares = col.shares.filter(s => s.username !== un.dataset.unshare);
    openCollection(col); render();
    return;
  }
  if (e.target.closest("[data-leave]")) {
    if (!confirm(`Leave “${col.name}”? ${col.owner_name} can share it with you again.`)) return;
    $("#colDlg").close();
    try { await req("DELETE", `collections/${col.id}/shares/${encodeURIComponent(state.user.username)}`); }
    catch (err) { return toast(err.message); }
    state.collections = state.collections.filter(c => c.id !== col.id);
    state.items = state.items.filter(it => it.collection !== col.id);
    setView("today");
    return toast(`You left “${col.name}”`);
  }
  if (!e.target.closest("[data-delcol]")) return;
  if (!confirm(`Delete “${col.name}” and the items in it?${col.shares?.length ? " The people you shared it with lose it too." : ""}`)) return;
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
const addHint = matchMedia("(max-width:760px)").matches ? "Add an item" : add.placeholder;
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
    col = state.collections.find(c => writable(c) && c.name.toLowerCase() === quick.collection.toLowerCase());
    if (!col) return toast(`There’s no collection called “${quick.collection}” you can add to.`);
  }
  if (!writable(col)) return toast("You can view this collection but not add to it.");
  // Each plugin that's on decides what a new item starts with. On Today and
  // Calendar, items always get a date so they show up where you added them.
  const c = { ...ctx(), tab: col === cur.col ? cur.tab : cur.kind === "col" ? null : "event" };
  const meta = {};
  for (const p of PLUGINS) {
    if (!col.plugins.includes(p.id) && !(p.id === "event" && cur.kind !== "col")) continue;
    try {
      const m = await p.fresh?.(quick, c);
      if (m !== undefined) meta[p.id] = m;
    } catch (err) { toast(`${p.name}: ${err.message}`); }
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
    if (cur.col.role === "owner") req("PATCH", "collections/" + cur.col.id, { view: t.dataset.tab }).then(c => { cur.col.view = c.view; }).catch(() => {});
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
// What store plugins see and may change. They only ever get plain data, and
// may only change their own slice of an item.
const storePlugins = new StorePlugins({
  snapshot() {
    const c = ctx(), plain = ({ id, name, plugins, view, role }) => ({ id, name, plugins, view, role });
    return {
      collection: c.collection && plain(c.collection), tab: c.tab, items: c.items, scopeItems: c.scopeItems, filtered: c.filtered,
      pending: [...state.pending], viewState: c.viewState, all: state.items, selected: state.sel, editing: state.editing,
    };
  },
  redraw({ editor }) {
    if (editor && $("#itemDlg").open) renderItemDialog();
    if (!$("#colDlg").open) render();
  },
  apply(effects, pid) {
    for (const [kind, ...a] of effects) {
      if (kind === "setMeta") { if (a[1] === pid) setMeta(a[0], pid, a[2], a[3]); else toast(`A plugin can only change its own data`); }
      else if (kind === "open") { if (state.items.some(x => x.id === a[0])) openItem(a[0]); }
      else if (kind === "render") render();
    }
  },
  row: (it, opts) => row(it, opts),
  toast,
});
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
