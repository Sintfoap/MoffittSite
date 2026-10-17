// Runs plugins from the plugin store. Their code never runs in this page: it
// runs in a sandboxed frame (public/sandbox/), and what comes back is HTML
// that's cleaned before it's shown. Each store plugin gets a stand-in here
// with the same shape as a built-in plugin, so Drift can use either.
//
// Drawing has to be immediate, but the sandbox answers later. So after each
// render Drift hands over a snapshot of what's on screen; the sandbox works
// out every store plugin's chips, editor and view, and when the answers come
// back Drift draws again from them.

import { esc } from "./lib.js";

// ── cleaning HTML from plugins ─────────────────────────────────────────────
// Only plain markup gets through: no scripts, styles, links, images, ids or
// event handlers, buttons can't submit forms, and data-act may only name the
// plugin's own actions.

const TAGS = new Set(("div span b strong i em small p ul ol li label input select option optgroup textarea button "
  + "h2 h3 h4 table thead tbody tfoot tr th td caption br hr code pre time mark abbr kbd sub sup progress meter details summary drift-row").split(" "));
const SVG_TAGS = new Set("svg path circle rect line polyline polygon ellipse g".split(" "));
const ATTRS = new Set(("class title name type value min max step checked selected placeholder disabled readonly rows cols for role "
  + "tabindex maxlength minlength multiple colspan rowspan datetime hidden open size label low high optimum").split(" "));
const SVG_ATTRS = new Set(("viewBox width height d cx cy r rx ry x y x1 y1 x2 y2 points fill stroke stroke-width stroke-linecap "
  + "stroke-linejoin stroke-dasharray opacity fill-rule transform").split(" "));
// Drift's own data- attributes do things when clicked (delete, detach, share…),
// so plugins get only these, plus data-p-* for their own use.
const DATA = new Set(["data-open", "data-set", "data-id", "data-depth"]);
const INPUT_TYPES = new Set("text number checkbox radio date time datetime-local month week range color hidden search".split(" "));

function cleanNode(node, ownId) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); continue; }
    const tag = child.localName, svg = child.namespaceURI === "http://www.w3.org/2000/svg";
    if (!(svg ? SVG_TAGS : TAGS).has(tag)) { child.remove(); continue; }
    for (const { name, value } of [...child.attributes]) {
      const n = name.toLowerCase();
      const ok = svg ? SVG_ATTRS.has(name) && !/url\s*\(/i.test(value)
        : ATTRS.has(n) || n.startsWith("aria-") || DATA.has(n) || n.startsWith("data-p-") || (n === "data-act" && value.startsWith(ownId + ":"));
      if (!ok) child.removeAttribute(name);
    }
    if (tag === "drift-row") for (const a of [...child.attributes]) if (a.name !== "data-id" && a.name !== "data-depth") child.removeAttribute(a.name);
    if (tag === "button") child.setAttribute("type", "button");
    if (tag === "input" && !INPUT_TYPES.has((child.getAttribute("type") || "text").toLowerCase())) child.setAttribute("type", "text");
    cleanNode(child, ownId);
  }
}

// Returns safe HTML. `ownId` limits data-act to the plugin's own actions.
export function sanitize(html, ownId = "") {
  const t = document.createElement("template");
  t.innerHTML = String(html ?? "");
  cleanNode(t.content, ownId);
  return t.innerHTML;
}
// An icon is the inside of a 24×24 SVG.
export function sanitizeIcon(markup) {
  const t = document.createElement("template");
  t.innerHTML = `<svg>${String(markup ?? "")}</svg>`;
  cleanNode(t.content, "");
  return t.content.firstElementChild?.innerHTML || "";
}

// ── the sandbox frame ──────────────────────────────────────────────────────

export class Sandbox {
  constructor() {
    this.seq = 0; this.waiting = new Map();
    this.frame = document.createElement("iframe");
    this.frame.setAttribute("sandbox", "allow-scripts");
    this.frame.title = "Plugin sandbox";
    this.frame.hidden = true;
    this.frame.src = "/sandbox/";
    this.ready = new Promise(resolve => { this.markReady = resolve; });
    window.addEventListener("message", e => {
      if (e.source !== this.frame.contentWindow || !e.data) return;
      if (e.data.ready) return this.markReady();
      const w = this.waiting.get(e.data.seq);
      if (!w) return;
      this.waiting.delete(e.data.seq);
      e.data.ok ? w.resolve(e.data.value) : w.reject(new Error(e.data.error));
    });
    document.body.append(this.frame);
  }
  async send(msg, transfer = []) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const seq = ++this.seq;
      this.waiting.set(seq, { resolve, reject });
      this.frame.contentWindow.postMessage({ ...msg, seq }, "*", transfer);
    });
  }
  load(plugins) { return this.send({ op: "load", plugins: plugins.map(({ id, code }) => ({ id, code })) }); }
  call(id, fn, args, snap) { return this.send({ op: "call", id, fn, args, snap }); }
  compute(snap) { return this.send({ op: "compute", snap }); }
  view(id, kind, args = {}) { return this.send({ op: "view", id, kind, ...args }, args.canvas ? [args.canvas] : []); }
}

// ── interactive views ──────────────────────────────────────────────────────
// A store plugin's mount() view draws on a canvas from inside its worker: the
// canvas's drawing is handed over (transferControlToOffscreen), so its code
// never touches this page. What the person does on the canvas is passed on as
// plain events; what comes back is effects (open, setMeta…) and a cursor.
//
//   box        the Sandbox
//   snapshot() plain data for the plugin's ctx
//   done(r)    called with each answer: { effects, viewState, cursor }
//   fail(e)    called when the plugin errors

const COLORS = ["bg", "surface", "raise", "line", "line-2", "ink", "muted", "faint", "accent", "accent-ink", "accent-soft", "red", "amber", "blue", "green", "violet"];
const colors = () => {
  const cs = getComputedStyle(document.documentElement);
  return Object.fromEntries(COLORS.map(k => [k.replace(/-(\w)/g, (_, c) => c.toUpperCase()), cs.getPropertyValue("--" + k).trim()]));
};

export function mountCanvas(el, { box, id, label, snapshot, done, fail }) {
  const canvas = document.createElement("canvas");
  canvas.className = "plugin-canvas";
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", label || "Plugin view");
  el.append(canvas);
  let alive = true, said = "", theme = JSON.stringify(colors());   // said: the last error shown, so one isn't repeated per event
  const send = (kind, args) => alive && box.view(id, kind, args).then(r => {
    if (!alive || !r) return;
    if (r.cursor) canvas.style.cursor = r.cursor;
    done(r);
  }).catch(e => { if (alive && e.message !== said) { said = e.message; fail(e); } });

  const box0 = () => ({ width: canvas.clientWidth, height: canvas.clientHeight, dpr: Math.min(3, window.devicePixelRatio || 1) });
  const first = box0();
  let last = JSON.stringify(first);
  send("mount", { canvas: canvas.transferControlToOffscreen(), ...first, colors: JSON.parse(theme), snap: snapshot() });

  // One event in flight at a time; moves and wheels that pile up meanwhile are
  // merged, so a slow plugin sees the latest position rather than a backlog.
  let busy = false, queued = [];
  const pump = () => {
    if (busy || !queued.length || !alive) return;
    const event = queued.shift();
    busy = true;
    Promise.resolve(send("event", { event })).finally(() => { busy = false; pump(); });
  };
  const push = event => {
    const last = queued.at(-1);
    if (last && last.type === event.type && (event.type === "pointermove" || event.type === "wheel")) {
      if (event.type === "wheel") { event.dx += last.dx; event.dy += last.dy; }
      queued[queued.length - 1] = event;
    } else queued.push(event);
    pump();
  };
  const at = e => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, button: e.button, buttons: e.buttons,
      shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey };
  };
  const on = (type, fn, opts) => canvas.addEventListener(type, fn, opts);
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointerleave", "click", "dblclick"]) {
    on(type, e => {
      if (type === "pointerdown") { canvas.focus({ preventScroll: true }); canvas.setPointerCapture?.(e.pointerId); }
      push({ type, pointerId: e.pointerId, pointerType: e.pointerType, ...at(e) });
    });
  }
  on("wheel", e => { e.preventDefault(); push({ type: "wheel", dx: e.deltaX, dy: e.deltaY, ...at(e) }); }, { passive: false });
  on("contextmenu", e => e.preventDefault());
  // Keys typed on the canvas are the plugin's, except the ones for getting out.
  on("keydown", e => {
    if (e.key === "Escape" || e.key === "Tab") return;
    e.stopPropagation();
    if (e.key.startsWith("Arrow") || e.key === " ") e.preventDefault();
    push({ type: "keydown", key: e.key, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey });
  });
  const ro = new ResizeObserver(() => {
    const b = box0(), k = JSON.stringify(b);
    if (k !== last) { last = k; send("resize", b); }
  });
  ro.observe(canvas);
  // Light/dark can change from the theme button or from the system.
  const recolor = () => {
    const now = JSON.stringify(colors());
    if (now !== theme) { theme = now; send("theme", { colors: JSON.parse(now) }); }
  };
  const mo = new MutationObserver(recolor), dark = matchMedia("(prefers-color-scheme: dark)");
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
  dark.addEventListener("change", recolor);

  return {
    refresh: recolor,
    unmount() {
      if (!alive) return;
      box.view(id, "unmount").catch(() => {});
      alive = false; ro.disconnect(); mo.disconnect(); dark.removeEventListener("change", recolor); canvas.remove();
    },
  };
}

// ── stand-ins for store plugins ────────────────────────────────────────────
// `drift` gives the host what it needs from the page:
//   snapshot()                  what's on screen (plain data)
//   redraw({ editor })          draw again; editor = the item dialog changed
//   apply(effects, pluginId)    carry out setMeta/open/render asked for by a plugin
//   row(item, opts)             Drift's own row HTML, for views that list items
//   toast(message)

export class StorePlugins {
  constructor(drift) {
    this.drift = drift;
    this.box = new Sandbox();
    this.list = []; this.errors = {};
    this.cache = {}; this.sent = ""; this.busy = null; this.again = false;
  }

  // Loads (or reloads) the plugins; returns their stand-ins.
  async load(store) {
    const key = JSON.stringify(store.map(p => [p.id, p.version]));
    if (key === this.loadedKey) return this.list;
    let infos = {};
    try { infos = await this.box.load(store); } catch (e) { this.drift.toast("Store plugins couldn't start: " + e.message); }
    this.loadedKey = key; this.sent = ""; this.cache = {};
    this.list = store.map(p => this.standIn(p, infos[p.id] || { error: "didn't load" }));
    return this.list;
  }

  standIn(p, info) {
    const host = this, id = p.id, broken = info.error;
    if (broken) this.errors[id] = broken; else delete this.errors[id];
    const has = info.has || {};
    const rowOf = it => host.cache[id]?.rows?.[it.id];
    const run = (fn, args) => {
      const snap = host.drift.snapshot();
      return host.box.call(id, fn, args, snap).then(r => {
        // snap.viewState is the page's own object: keep what the plugin changed in it.
        if (r.viewState && snap.viewState) Object.assign(snap.viewState, r.viewState);
        if (r.effects?.length) host.drift.apply(r.effects, id);
        return r.value;
      });
    };
    const act = (fn, name) => (it, _ctx, el) => {
      run(fn, { name, item: it, dataset: el?.dataset ? { ...el.dataset } : {} }).catch(e => host.drift.toast(`${p.name}: ${e.message}`));
    };
    const plugin = {
      id, store: true, installed: p.installed, author: p.author, version: p.version, broken,
      name: broken ? p.name : info.name || p.name,
      description: broken ? `Couldn't start: ${broken}` : info.description || p.description,
      icon: sanitizeIcon(info.icon) || '<rect x="5" y="5" width="14" height="14" rx="4" stroke="currentColor" stroke-width="1.8"/>',
      // Checked in the sandbox; Drift awaits these.
      clean: value => broken ? Promise.reject(new Error(`${p.name} isn't working: ${broken}`)) : run("clean", { value }),
      fresh: (quick, _ctx, item) => broken ? undefined : run("fresh", { quick, item }),
      read: (fields, item) => run("read", { fields, item }),
      // Drawn from the last answers.
      rowClass: has.rowClass ? it => rowOf(it)?.cls || "" : undefined,
      lead: has.lead ? it => rowOf(it)?.lead || "" : undefined,
      chips: has.chips ? it => rowOf(it)?.chips || [] : undefined,
      editor: it => broken ? `<p class="hint">${esc(p.name)} isn't working: ${esc(broken)}</p>`
        : host.cache[id]?.editorFor === it.id ? host.cache[id].editor : `<p class="hint">Loading…</p>`,
      actions: Object.fromEntries((info.actions || []).map(n => [n, act("action", n)])),
      keys: Object.fromEntries((info.keys || []).map(n => [n, (it, c) => act("key", n)(it, c)])),
      view: info.view?.mount ? {
        label: info.view.label,
        mount(el) {
          this.live?.unmount();
          this.live = mountCanvas(el, {
            box: host.box, id, label: info.view.label, snapshot: () => host.drift.snapshot(),
            done: r => {
              const vs = host.drift.snapshot().viewState;
              if (r.viewState && vs) Object.assign(vs, r.viewState);
              if (r.effects?.length) host.drift.apply(r.effects, id);
            },
            fail: e => host.drift.toast(`${p.name}: ${e.message}`),
          });
        },
        // The sandbox passes each change on to the view itself (see sync).
        update() { this.live?.refresh(); },
        unmount() { this.live?.unmount(); this.live = null; },
      } : info.view ? {
        label: info.view.label,
        render: c => {
          const v = host.cache[id]?.view;
          if (v == null) return c.empty("Loading…", `${p.name} is drawing this view.`);
          const byId = new Map(c.all.map(it => [it.id, it]));
          return v.replace(/<drift-row data-id="([^"]*)" data-depth="(\d+)"><\/drift-row>/g,
            (_, rid, depth) => byId.has(rid) ? host.drift.row(byId.get(rid), { depth: +depth }) : "");
        },
      } : undefined,
    };
    return plugin;
  }

  // Called after every render. Sends the snapshot if it changed, and draws again
  // when the answers come back.
  sync() {
    if (!this.list.some(p => !p.broken)) return;
    const snap = this.drift.snapshot(), key = JSON.stringify(snap);
    if (key === this.sent) return;
    if (this.busy) { this.again = true; return; }
    this.sent = key;
    this.busy = this.box.compute(snap).then(res => {
      let editor = false;
      for (const p of this.list) {
        const r = res[p.id];
        if (!r) continue;
        const rows = {};
        for (const [iid, x] of Object.entries(r.rows || {})) {
          rows[iid] = { lead: sanitize(x.lead, p.id), cls: String(x.cls || "").replace(/[^\w -]/g, ""), chips: (x.chips || []).map(h => sanitize(h, p.id)) };
        }
        const ed = r.editor == null ? null : sanitize(r.editor, p.id);
        const old = this.cache[p.id];
        if (snap.editing && (old?.editor !== ed || old?.editorFor !== snap.editing)) editor = true;
        this.cache[p.id] = { rows, view: r.view == null ? null : sanitize(r.view, p.id), editor: ed, editorFor: snap.editing };
        if (r.error && r.error !== this.errors[p.id]) { this.errors[p.id] = r.error; this.drift.toast(`${p.name}: ${r.error}`); }
      }
      this.drift.redraw({ editor });
    }).catch(e => this.drift.toast("Store plugins: " + e.message)).finally(() => {
      this.busy = null;
      if (this.again) { this.again = false; this.sync(); }
    });
  }
}
