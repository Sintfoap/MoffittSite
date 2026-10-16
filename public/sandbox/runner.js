// The plugin sandbox. This page is loaded in a frame with sandbox="allow-scripts",
// so it has no origin, no cookies and (from its Content-Security-Policy) no
// network. Each plugin runs in its own worker, so one that loops forever is
// stopped without holding up the others or the page.
//
// The parent page (Drift, or the store's "Try it") sends requests:
//   { seq, op: "load", plugins: [{ id, code }] }  → { id: description | { error } }
//   { seq, op: "call", id, fn, args, snap }       → { value, effects, viewState }
//   { seq, op: "compute", snap }                   → { id: { rows, view, editor, error } }
// and gets back { seq, ok, value } or { seq, ok: false, error }.

"use strict";

const TIMEOUT = 2000;   // ms a plugin gets for any one request

// ── what runs in each worker ───────────────────────────────────────────────
// Written as a function so it can be turned into the worker's source text.
function harness() {
  let P = null;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fail = msg => { throw new Error(String(msg)); };
  const fn = (o, k) => typeof o?.[k] === "function";

  // The ctx a built-in plugin gets, rebuilt from a snapshot. Things that change
  // Drift (setMeta, open, render) are collected as effects for the page to apply.
  function makeCtx(s, fx) {
    const c = {
      collection: s.collection, tab: s.tab, items: s.items, scopeItems: s.scopeItems, filtered: s.filtered,
      pending: new Set(s.pending), viewState: s.viewState || {}, all: s.all, selected: s.selected,
      open: id => { fx.push(["open", String(id)]); },
      render: () => { fx.push(["render"]); },
      setMeta: (id, pid, value, opts) => { fx.push(["setMeta", String(id), String(pid), value, { celebrate: Boolean(opts?.celebrate) }]); },
      update: () => fail("store plugins can only change their own data on an item"),
      // Rows are drawn by Drift: these placeholders are swapped for the real thing.
      row: (it, o = {}) => `<drift-row data-id="${esc(it?.id)}" data-depth="${Math.max(0, Math.min(20, Math.trunc(Number(o.depth) || 0)))}"></drift-row>`,
      group: (title, items, extra = "", o = {}) =>
        `<div class="group ${esc(o.cls || "")}"><h2>${esc(title)}<small>${items.length || ""}</small></h2><ul class="items">${items.map(it => c.row(it, o)).join("")}</ul>${extra}</div>`,
      empty: (title, msg) => `<div class="empty"><b>${esc(title)}</b>${esc(msg)}</div>`,
    };
    return c;
  }
  const html = v => (v == null || v === false ? "" : String(v));
  const cleanOwn = v => (v === undefined ? undefined : P.clean(v, fail));

  async function load({ id, code }) {
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    let mod;
    try { mod = await import(url); } finally { URL.revokeObjectURL(url); }
    P = mod.default;
    if (!P || typeof P !== "object") fail("the plugin must `export default` an object");
    if (P.id !== id) fail(`the plugin's id is ${JSON.stringify(P.id)} but it was published as ${JSON.stringify(id)}`);
    if (!fn(P, "clean")) fail("the plugin needs a clean(value, fail) function");
    if (P.view && !fn(P.view, "render")) fail("a store plugin's view needs render(ctx); mount() views aren't supported yet");
    return {
      id: P.id, name: html(P.name) || P.id, description: html(P.description), icon: html(P.icon),
      has: Object.fromEntries(["lead", "rowClass", "chips", "editor", "read", "fresh"].map(k => [k, fn(P, k)])),
      view: P.view ? { label: html(P.view.label) || html(P.name) || P.id } : null,
      actions: Object.keys(P.actions || {}).filter(k => fn(P.actions, k)),
      keys: Object.keys(P.keys || {}).filter(k => fn(P.keys, k)),
    };
  }

  function call({ fn: name, args, snap }) {
    const fx = [], c = makeCtx(snap || {}, fx);
    const item = args.item;
    let value;
    switch (name) {
      case "clean": value = P.clean(args.value, fail); break;
      // Data for a new item; with an item (the "Add" button), falls back to read({}).
      case "fresh":
        value = fn(P, "fresh") ? P.fresh(args.quick || {}, c) : undefined;
        if (value === undefined && item && fn(P, "read")) value = P.read({}, item);
        value = cleanOwn(value);
        break;
      case "read": value = cleanOwn(fn(P, "read") ? P.read(args.fields || {}, item) : undefined); break;
      case "action": value = P.actions[args.name](item, c, { dataset: args.dataset || {} }); break;
      case "key": value = P.keys[args.name](item, c); break;
      default: fail("unknown request");
    }
    if (value instanceof Promise) fail("plugins must answer straight away, without promises");
    return { value: value === false ? false : name === "action" || name === "key" ? null : value, effects: fx, viewState: c.viewState };
  }

  // Everything Drift needs to draw: each item's lead, classes and chips, the
  // open item's editor, and the view if it's this plugin's.
  function compute({ snap }) {
    const fx = [], c = makeCtx(snap, fx), rows = {}, out = { rows };
    let error = null;
    const safe = (f, fallback) => { try { return f(); } catch (e) { error ||= String(e?.message || e); return fallback; } };
    for (const it of snap.all) {
      if (it.meta?.[P.id] === undefined) continue;
      rows[it.id] = {
        lead: fn(P, "lead") ? safe(() => html(P.lead(it, c)), "") : "",
        cls: fn(P, "rowClass") ? safe(() => html(P.rowClass(it, c)), "") : "",
        chips: fn(P, "chips") ? safe(() => { const v = P.chips(it, c); return Array.isArray(v) ? v.map(html) : []; }, []) : [],
      };
    }
    const editing = snap.all.find(it => it.id === snap.editing);
    if (editing && editing.meta?.[P.id] !== undefined && fn(P, "editor")) out.editor = safe(() => html(P.editor(editing, c)), "");
    if (snap.tab === P.id && P.view) out.view = safe(() => html(P.view.render(c)), "");
    out.error = error;
    return out;
  }

  self.onmessage = async ({ data: m }) => {
    try {
      const value = m.op === "load" ? await load(m) : m.op === "call" ? call(m) : m.op === "compute" ? compute(m) : fail("unknown request");
      postMessage({ seq: m.seq, ok: true, value });
    } catch (e) {
      postMessage({ seq: m.seq, ok: false, error: String(e?.message || e) });
    }
  };
}

const SOURCE = URL.createObjectURL(new Blob([`(${harness})()`], { type: "text/javascript" }));

// ── one worker per plugin ──────────────────────────────────────────────────

class Box {
  constructor(id, code) {
    this.id = id; this.code = code; this.seq = 0; this.waiting = new Map();
    this.ready = this.start();
  }
  start() {
    // A classic worker: Chrome won't start a module worker from a page with no
    // origin. The plugin itself is still a module, loaded with import().
    this.worker = new Worker(SOURCE, { name: "plugin:" + this.id });
    this.worker.onmessage = ({ data }) => {
      const w = this.waiting.get(data.seq);
      if (!w) return;
      this.waiting.delete(data.seq); clearTimeout(w.timer);
      data.ok ? w.resolve(data.value) : w.reject(new Error(data.error));
    };
    this.worker.onerror = e => { e.preventDefault(); this.failAll(e.message || "the plugin crashed"); };
    return this.send({ op: "load", id: this.id, code: this.code });
  }
  send(msg) {
    return new Promise((resolve, reject) => {
      const seq = ++this.seq;
      const timer = setTimeout(() => {
        // Too slow: stop it for good (until the page reloads), so it can't hold
        // up every redraw after this one.
        this.waiting.delete(seq);
        this.dead = `${this.id} took longer than ${TIMEOUT / 1000} seconds and was stopped`;
        reject(new Error(this.dead));
        this.stop(this.dead);
      }, TIMEOUT);
      this.waiting.set(seq, { resolve, reject, timer });
      this.worker.postMessage({ ...msg, seq });
    });
  }
  failAll(msg) {
    for (const [seq, w] of this.waiting) { clearTimeout(w.timer); w.reject(new Error(msg)); this.waiting.delete(seq); }
  }
  async run(msg) {
    await this.ready;
    if (this.dead) throw new Error(this.dead);
    return this.send(msg);
  }
  stop(why = `${this.id} was unloaded`) { this.worker.terminate(); this.failAll(why); }
}

const boxes = new Map();

async function handle(m) {
  if (m.op === "load") {
    const want = new Map(m.plugins.map(p => [String(p.id), String(p.code)]));
    for (const [id, box] of boxes) if (want.get(id) !== box.code) { box.stop(); boxes.delete(id); }
    const out = {};
    await Promise.all([...want].map(async ([id, code]) => {
      if (!boxes.has(id)) boxes.set(id, new Box(id, code));
      try { out[id] = await boxes.get(id).ready; } catch (e) { out[id] = { error: e.message }; }
    }));
    return out;
  }
  if (m.op === "call") {
    const box = boxes.get(m.id);
    if (!box) throw new Error(`${m.id} isn't loaded`);
    return box.run({ op: "call", fn: m.fn, args: m.args || {}, snap: m.snap });
  }
  if (m.op === "compute") {
    const out = {};
    await Promise.all([...boxes].map(async ([id, box]) => {
      try { out[id] = await box.run({ op: "compute", snap: m.snap }); } catch (e) { out[id] = { rows: {}, error: e.message }; }
    }));
    return out;
  }
  throw new Error("unknown request");
}

window.addEventListener("message", async e => {
  if (e.source !== parent || !e.data || typeof e.data.seq !== "number") return;
  const { seq } = e.data;
  try { parent.postMessage({ seq, ok: true, value: await handle(e.data) }, "*"); }
  catch (err) { parent.postMessage({ seq, ok: false, error: String(err?.message || err) }, "*"); }
});
parent.postMessage({ ready: true }, "*");
