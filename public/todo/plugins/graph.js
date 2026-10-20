// Graph: link items to each other and see them as a network you can drag,
// pan and zoom.
// meta.graph = { links, rel?, kind?, x, y }
//   links  other items' ids this item links to
//   rel    optional { id: type } for links with a type, like "depends on". A typed
//          link points one way, from this item to the other, and is drawn as an
//          arrow; a link with no type is a plain two-way "related" line.
//   kind   optional type of the item itself, like "person" or "idea", which
//          colours its node and can be filtered on
//   x, y   where you pinned the node (null lets the layout place it)

import { esc } from "../lib.js";

const ID = /^[a-z]_[0-9a-z]{1,32}$/;
const MAX_LINKS = 200;
const SVG = "http://www.w3.org/2000/svg";
export const LINK_TYPES = ["leads to", "depends on", "blocks", "part of"];
const COLORS = ["blue", "green", "violet", "red", "amber"];
const isDone = it => Boolean(it.meta.checklist?.done);
// Lower case, single spaces, at most 32 characters; "" for none.
export const label = s => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 32);
// The same name always gets the same colour.
const colorOf = name => {
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `var(--${COLORS[h % COLORS.length]})`;
};
const blank = () => ({ links: [], x: null, y: null });
const typeOf = (g, to) => g?.rel?.[to] || "";

// Every link once, whichever item it's stored on, between items in view.
// A plain link between two items is one line whichever side stores it;
// typed links keep their direction.
export function edges(items) {
  const here = new Set(items.map(it => it.id)), seen = new Set(), out = [];
  for (const it of items) for (const to of it.meta.graph?.links || []) {
    if (to === it.id || !here.has(to)) continue;
    const type = typeOf(it.meta.graph, to);
    const key = type ? `${it.id}>${to}>${type}` : it.id < to ? `${it.id} ${to}` : `${to} ${it.id}`;
    if (!seen.has(key)) { seen.add(key); out.push({ a: it.id, b: to, type }); }
  }
  return out;
}

export function withLink(g, to, type) {
  const rel = { ...(g.rel || {}) };
  if (type) rel[to] = type; else delete rel[to];
  const out = { ...g, links: g.links.includes(to) ? g.links : [...g.links, to], rel };
  if (!Object.keys(rel).length) delete out.rel;
  return out;
}
export function withoutLink(g, to) {
  const rel = { ...(g.rel || {}) }; delete rel[to];
  const out = { ...g, links: g.links.filter(x => x !== to), rel };
  if (!Object.keys(rel).length) delete out.rel;
  return out;
}

// Links a to b as `type` ("" for a plain link). Doing the same link again
// removes it; a different type replaces the link a stores to b.
export function toggleLink(a, b, type, ctx) {
  const ga = a.meta.graph || blank(), gb = b.meta.graph || blank();
  if (ga.links.includes(b.id) && typeOf(ga, b.id) === type) return ctx.setMeta(a.id, "graph", withoutLink(ga, b.id));
  if (!type && gb.links.includes(a.id) && !typeOf(gb, a.id)) return ctx.setMeta(b.id, "graph", withoutLink(gb, a.id));
  return ctx.setMeta(a.id, "graph", withLink(ga, b.id, type));
}

// The live view. Lives between renders so the layout, zoom and any drag in
// progress survive changes to the data.
class GraphView {
  constructor(el, ctx) {
    this.ctx = ctx; this.nodes = new Map(); this.links = [];
    this.zoom = { k: 1, x: 0, y: 0 }; this.linkFrom = null; this.linking = false;
    this.hidden = new Set();                                         // "k:<kind>" and "t:<link type>" switched off
    el.innerHTML = `<div class="graph">
      <div class="graph-bar">
        <button class="ghost" data-g="link" aria-pressed="false">Link items</button>
        <label class="as">as <input data-g="type" list="graph-types" placeholder="related" size="11" aria-label="Type of link to make"></label>
        <datalist id="graph-types">${LINK_TYPES.map(t => `<option value="${esc(t)}">`).join("")}</datalist>
        <button class="ghost" data-g="fit">Fit</button>
        <button class="ghost" data-g="in" aria-label="Zoom in">+</button>
        <button class="ghost" data-g="out" aria-label="Zoom out">−</button>
        <span class="hint" data-g="hint">Drag to move, scroll to zoom, click to open.</span>
      </div>
      <div class="graph-legend" data-g="legend"></div>
      <svg role="img" aria-label="Graph of linked items"><g class="vp"><g class="edges"></g><g class="nodes"></g></g></svg>
    </div>`;
    this.svg = el.querySelector("svg"); this.vp = el.querySelector(".vp");
    this.gEdges = el.querySelector(".edges"); this.gNodes = el.querySelector(".nodes");
    this.hint = el.querySelector('[data-g="hint"]'); this.linkBtn = el.querySelector('[data-g="link"]');
    this.typeIn = el.querySelector('[data-g="type"]'); this.legend = el.querySelector('[data-g="legend"]');
    this.typeIn.addEventListener("focus", () => { if (!this.linking) this.setLinking(true); });
    this.legend.addEventListener("click", e => {
      const b = e.target.closest("[data-hide]"); if (!b) return;
      const k = b.dataset.hide;
      if (this.hidden.has(k)) this.hidden.delete(k); else this.hidden.add(k);
      this.sync(this.ctx);
    });
    el.querySelector(".graph-bar").addEventListener("click", e => {
      const b = e.target.closest("[data-g]"); if (!b) return;
      if (b.dataset.g === "link") this.setLinking(!this.linking);
      if (b.dataset.g === "fit") this.fit();
      if (b.dataset.g === "in" || b.dataset.g === "out") this.zoomBy(b.dataset.g === "in" ? 1.3 : 1 / 1.3);
    });
    this.bindPointer();
    this.sync(ctx, true);
  }

  setLinking(on) {
    this.linking = on; this.linkFrom = null;
    this.linkBtn.setAttribute("aria-pressed", on);
    this.hint.textContent = on ? "Click one item, then the one it points to. Again to unlink." : "Drag to move, scroll to zoom, click to open.";
    this.paint();
  }

  // Brings nodes and links in line with the items, keeping positions.
  sync(ctx, first = false) {
    this.ctx = ctx;
    this.drawLegend(ctx.items);
    const items = ctx.items.filter(it => !this.hidden.has("k:" + (it.meta.graph?.kind || ""))),
      w = this.svg.clientWidth || 800, h = this.svg.clientHeight || 520;
    const keep = new Set(items.map(it => it.id));
    for (const id of [...this.nodes.keys()]) if (!keep.has(id)) this.nodes.delete(id);
    items.forEach((it, i) => {
      let n = this.nodes.get(it.id);
      if (!n) {
        const a = i * 2.4, r = 30 + 12 * Math.sqrt(i);            // a loose spiral to start from
        n = { id: it.id, x: w / 2 + r * Math.cos(a), y: h / 2 + r * Math.sin(a), vx: 0, vy: 0 };
        this.nodes.set(it.id, n);
      }
      n.item = it;
      const g = it.meta.graph;
      n.pinned = g && Number.isFinite(g.x) && Number.isFinite(g.y);
      if (n.pinned && !n.dragging) { n.x = g.x; n.y = g.y; }
    });
    this.links = edges(items).filter(e => !this.hidden.has("t:" + e.type));
    this.draw();
    this.heat(first ? 1 : 0.4);
    if (first) requestAnimationFrame(() => this.fit());
  }

  // Kinds of item and types of link in view, as switches that hide or show them.
  drawLegend(items) {
    const kinds = new Set(items.map(it => it.meta.graph?.kind || "").filter(Boolean));
    const types = new Set(edges(items).map(e => e.type));
    const chip = (key, name, color, arrow) => `<button class="ghost" data-hide="${esc(key)}" aria-pressed="${!this.hidden.has(key)}" style="--c:${color}">${
      arrow ? `<i class="arrow"></i>` : `<i class="dot"></i>`}${esc(name)}</button>`;
    const html = (kinds.size ? `<span class="hint">Kinds</span>` + [...kinds].sort().map(k => chip("k:" + k, k, colorOf(k))).join("") : "")
      + (types.size > 1 || [...types].some(Boolean) ? `<span class="hint">Links</span>` + [...types].sort().map(t => chip("t:" + t, t || "related", t ? colorOf(t) : "var(--line-2)", Boolean(t))).join("") : "");
    this.legend.innerHTML = html;
    this.legend.hidden = !html;
  }

  draw() {
    this.gEdges.replaceChildren(...this.links.map(({ a, b, type }) => {
      const g = document.createElementNS(SVG, "g");
      g.dataset.a = a; g.dataset.b = b;
      g.setAttribute("class", type ? "edge typed" : "edge");
      if (type) g.setAttribute("style", `--c:${colorOf(type)}`);
      g.innerHTML = `<line></line>${type ? `<path class="arrow" d="M0 0L-9 -4.5L-9 4.5Z"></path><text>${esc(type)}</text>` : ""}`;
      return g;
    }));
    this.gNodes.replaceChildren(...[...this.nodes.values()].map(n => {
      const g = document.createElementNS(SVG, "g"), kind = n.item.meta.graph?.kind;
      g.dataset.id = n.id;
      if (kind) g.setAttribute("style", `--c:${colorOf(kind)}`);
      g.innerHTML = `<title>${esc(n.item.title)}${kind ? ` (${esc(kind)})` : ""}</title><circle r="9"></circle><text x="14" y="4">${esc(n.item.title.length > 40 ? n.item.title.slice(0, 39) + "…" : n.item.title)}</text>`;
      return g;
    }));
    this.paint();
  }

  paint() {
    const { k, x, y } = this.zoom;
    this.vp.setAttribute("transform", `translate(${x} ${y}) scale(${k})`);
    for (const e of this.gEdges.children) {
      const a = this.nodes.get(e.dataset.a), b = this.nodes.get(e.dataset.b), [l, arrow, text] = e.children;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      const end = arrow ? Math.max(0, d - 12) / d : 1;                // stop arrows at the node's edge
      l.setAttribute("x1", a.x); l.setAttribute("y1", a.y); l.setAttribute("x2", a.x + dx * end); l.setAttribute("y2", a.y + dy * end);
      if (arrow) {
        const deg = Math.atan2(dy, dx) * 180 / Math.PI;
        arrow.setAttribute("transform", `translate(${a.x + dx * end} ${a.y + dy * end}) rotate(${deg})`);
        const flip = deg > 90 || deg < -90;                           // keep labels the right way up
        text.setAttribute("transform", `translate(${(a.x + b.x) / 2} ${(a.y + b.y) / 2}) rotate(${flip ? deg + 180 : deg}) translate(0 -5)`);
      }
    }
    for (const g of this.gNodes.children) {
      const n = this.nodes.get(g.dataset.id);
      g.setAttribute("transform", `translate(${n.x} ${n.y})`);
      g.setAttribute("class", ["node", isDone(n.item) ? "done" : "", n.pinned ? "pinned" : "", this.linkFrom === n.id ? "from" : "",
        this.ctx.selected === n.id ? "sel" : ""].join(" "));
    }
  }

  // A small force layout: links pull, everything repels, a weak pull to the centre.
  heat(a) { this.alpha = Math.max(this.alpha || 0, a); if (!this.raf) this.raf = requestAnimationFrame(() => this.tick()); }
  tick() {
    this.raf = null;
    const ns = [...this.nodes.values()], cx = (this.svg.clientWidth || 800) / 2, cy = (this.svg.clientHeight || 520) / 2;
    const a = this.alpha;
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
      const p = ns[i], q = ns[j]; let dx = q.x - p.x, dy = q.y - p.y, d2 = dx * dx + dy * dy || 0.01;
      if (d2 > 250000) continue;
      const f = 2500 / d2 * a, d = Math.sqrt(d2); dx /= d; dy /= d;
      p.vx -= dx * f; p.vy -= dy * f; q.vx += dx * f; q.vy += dy * f;
    }
    for (const { a: ia, b: ib } of this.links) {
      const p = this.nodes.get(ia), q = this.nodes.get(ib), dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1;
      const f = (d - 110) * 0.04 * a;
      p.vx += dx / d * f; p.vy += dy / d * f; q.vx -= dx / d * f; q.vy -= dy / d * f;
    }
    for (const n of ns) {
      if (n.pinned || n.dragging) { n.vx = n.vy = 0; continue; }
      n.vx += (cx - n.x) * 0.002 * a; n.vy += (cy - n.y) * 0.002 * a;
      n.vx *= 0.6; n.vy *= 0.6; n.x += n.vx; n.y += n.vy;
    }
    this.paint();
    this.alpha *= 0.97;
    if (this.alpha > 0.02) this.raf = requestAnimationFrame(() => this.tick());
  }

  fit() {
    const ns = [...this.nodes.values()]; if (!ns.length) return;
    const w = this.svg.clientWidth || 800, h = this.svg.clientHeight || 520;
    const xs = ns.map(n => n.x), ys = ns.map(n => n.y);
    const x0 = Math.min(...xs) - 40, x1 = Math.max(...xs) + 160, y0 = Math.min(...ys) - 40, y1 = Math.max(...ys) + 40;
    const k = Math.min(2, w / (x1 - x0), h / (y1 - y0));
    this.zoom = { k, x: (w - (x1 + x0) * k) / 2, y: (h - (y1 + y0) * k) / 2 };
    this.paint();
  }

  // Zooms around a point on screen (the middle by default).
  zoomBy(f, px = (this.svg.clientWidth || 800) / 2, py = (this.svg.clientHeight || 520) / 2) {
    const z = this.zoom, k = Math.min(4, Math.max(0.2, z.k * f));
    this.zoom = { k, x: px - (px - z.x) * k / z.k, y: py - (py - z.y) * k / z.k };
    this.paint();
  }

  toGraph(e) {
    const r = this.svg.getBoundingClientRect(), { k, x, y } = this.zoom;
    return [(e.clientX - r.left - x) / k, (e.clientY - r.top - y) / k];
  }

  bindPointer() {
    let drag = null;
    this.svg.addEventListener("pointerdown", e => {
      const g = e.target.closest(".node");
      this.svg.setPointerCapture(e.pointerId);
      if (g) { const n = this.nodes.get(g.dataset.id); n.dragging = true; drag = { n, sx: e.clientX, sy: e.clientY, moved: false }; }
      else drag = { pan: true, sx: e.clientX, sy: e.clientY, zx: this.zoom.x, zy: this.zoom.y };
    });
    this.svg.addEventListener("pointermove", e => {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) drag.moved = true;
      if (drag.pan) { this.zoom.x = drag.zx + e.clientX - drag.sx; this.zoom.y = drag.zy + e.clientY - drag.sy; this.paint(); }
      else if (drag.moved && !this.linking) { [drag.n.x, drag.n.y] = this.toGraph(e); drag.n.pinned = true; this.paint(); this.heat(0.3); }
    });
    const end = () => {
      if (!drag) return;
      const d = drag; drag = null;
      if (d.pan) return;
      d.n.dragging = false;
      if (d.moved && !this.linking) {                               // pin it where it was dropped
        const g = d.n.item.meta.graph || blank();
        this.ctx.setMeta(d.n.id, "graph", { ...g, x: Math.round(d.n.x), y: Math.round(d.n.y) });
      } else if (this.linking) {
        if (!this.linkFrom) { this.linkFrom = d.n.id; this.paint(); }
        else if (this.linkFrom === d.n.id) { this.linkFrom = null; this.paint(); }
        else { toggleLink(this.nodes.get(this.linkFrom).item, d.n.item, label(this.typeIn.value), this.ctx); this.linkFrom = null; }
      } else this.ctx.open(d.n.id);
    };
    this.svg.addEventListener("pointerup", end);
    this.svg.addEventListener("pointercancel", end);
    this.svg.addEventListener("wheel", e => {
      e.preventDefault();
      const r = this.svg.getBoundingClientRect();
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
  }

  destroy() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; }
}

let live = null;

export default {
  id: "graph",
  name: "Graph",
  description: "Link items to each other and see them as a network.",
  icon: '<circle cx="6" cy="7" r="2.5" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="6" r="2.5" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="18" r="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M8.3 8.3l2.6 7.4M15.6 7.1l-8.9-.2M16.8 8.2l-3.6 7.6" stroke="currentColor" stroke-width="1.6"/>',

  clean(v, fail) {
    if (!v || typeof v !== "object" || Array.isArray(v)) fail("graph must be an object");
    const links = v.links == null ? [] : v.links;
    if (!Array.isArray(links) || links.length > MAX_LINKS) fail(`graph.links must be a list of at most ${MAX_LINKS} item ids`);
    const ids = [...new Set(links.map(String))];
    if (ids.some(id => !ID.test(id))) fail("graph.links must be item ids");
    const relIn = v.rel == null ? {} : v.rel;
    if (typeof relIn !== "object" || Array.isArray(relIn)) fail("graph.rel must be an object of item id to link type");
    const rel = {};
    for (const [to, t] of Object.entries(relIn)) {
      if (!ids.includes(to)) fail("graph.rel can only type links in graph.links");
      if (typeof t !== "string") fail("graph.rel types must be text");
      if (label(t)) rel[to] = label(t);
    }
    if (v.kind != null && typeof v.kind !== "string") fail("graph.kind must be text");
    const kind = label(v.kind);
    const coord = c => {
      if (c == null || c === "") return null;
      const n = Number(c);
      if (!Number.isFinite(n) || Math.abs(n) > 1e6) fail("graph.x and graph.y must be numbers");
      return Math.round(n);
    };
    const out = { links: ids, x: coord(v.x), y: coord(v.y) };
    if (Object.keys(rel).length) out.rel = rel;
    if (kind) out.kind = kind;
    return out;
  },

  fresh: () => ({ links: [], x: null, y: null }),

  chips(item, ctx) {
    const g = item.meta.graph, n = g.links.length + ctx.all.filter(o => o.meta.graph?.links.includes(item.id)).length;
    return [
      ...(g.kind ? [`<span class="chip" style="color:${colorOf(g.kind)}">${esc(g.kind)}</span>`] : []),
      ...(n ? [`<span class="chip">${n} link${n === 1 ? "" : "s"}</span>`] : []),
    ];
  },

  // The item's kind, then links stored on this item as tick boxes, each with
  // an optional type. Links other items made to this one are listed below;
  // change those from the other item or in the graph.
  editor(item, ctx) {
    const g = item.meta.graph, mates = ctx.all.filter(o => o.collection === item.collection);
    const others = mates.filter(o => o.id !== item.id);
    const kinds = [...new Set(mates.map(o => o.meta.graph?.kind).filter(Boolean))].sort();
    const types = [...new Set([...LINK_TYPES, ...mates.flatMap(o => Object.values(o.meta.graph?.rel || {}))])];
    const from = ctx.all.filter(o => o.meta.graph?.links.includes(item.id));
    return `<input type="hidden" name="x" value="${g.x ?? ""}"><input type="hidden" name="y" value="${g.y ?? ""}">
      <label>Kind<input name="kind" value="${esc(g.kind || "")}" list="graph-kinds-ed" placeholder="Like person, idea or place" maxlength="32"></label>
      <datalist id="graph-kinds-ed">${kinds.map(k => `<option value="${esc(k)}">`).join("")}</datalist>
      <datalist id="graph-types-ed">${types.map(t => `<option value="${esc(t)}">`).join("")}</datalist>
      ${others.length ? `<div class="picks links">${others.map(o => `<span class="linkpick"><label class="inline"><input type="checkbox" name="links" value="${esc(o.id)}" ${g.links.includes(o.id) ? "checked" : ""}> ${esc(o.title)}</label>
          <input name="rel:${esc(o.id)}" value="${esc(typeOf(g, o.id))}" list="graph-types-ed" placeholder="related" maxlength="32" aria-label="Type of link to ${esc(o.title)}"></span>`).join("")}</div>
          <p class="hint">A link with a type, like “depends on”, points from this item to the other one.</p>`
        : `<p class="hint">Add more items to this collection to link them.</p>`}
      ${from.length ? `<p class="hint">Linked from ${from.map(o => `“${esc(o.title)}”${typeOf(o.meta.graph, item.id) ? ` (${esc(typeOf(o.meta.graph, item.id))})` : ""}`).join(", ")}.</p>` : ""}`;
  },
  read(f) {
    // Giving a link a type ticks it too.
    const typed = Object.keys(f).filter(k => k.startsWith("rel:") && label(f[k])).map(k => k.slice(4));
    const links = [...new Set([...(f.links || []), ...typed])], rel = {};
    for (const to of links) if (label(f["rel:" + to])) rel[to] = label(f["rel:" + to]);
    const out = { links, x: f.x === "" ? null : f.x, y: f.y === "" ? null : f.y };
    if (Object.keys(rel).length) out.rel = rel;
    if (label(f.kind)) out.kind = label(f.kind);
    return out;
  },

  view: {
    label: "Graph",
    mount(el, ctx) { live = new GraphView(el, ctx); },
    update(ctx) { live?.sync(ctx); },
    unmount() { live?.destroy(); live = null; },
  },
};
