// Graph: link items to each other and see them as a network you can drag,
// pan and zoom.
// meta.graph = { links, x, y }   links: other items' ids; x, y: where you
// pinned the node (null lets the layout place it)

import { esc } from "../lib.js";

const ID = /^[a-z]_[0-9a-z]{1,32}$/;
const MAX_LINKS = 200;
const SVG = "http://www.w3.org/2000/svg";
const isDone = it => Boolean(it.meta.checklist?.done);

// Every link once, whichever item it's stored on, between items in view.
function edges(items) {
  const here = new Set(items.map(it => it.id)), seen = new Set(), out = [];
  for (const it of items) for (const to of it.meta.graph?.links || []) {
    if (to === it.id || !here.has(to)) continue;
    const key = it.id < to ? `${it.id} ${to}` : `${to} ${it.id}`;
    if (!seen.has(key)) { seen.add(key); out.push([it.id, to]); }
  }
  return out;
}

// Links a to b, or unlinks them if they're already linked (from either side).
function toggleLink(a, b, ctx) {
  const ga = a.meta.graph || { links: [], x: null, y: null }, gb = b.meta.graph || { links: [], x: null, y: null };
  if (ga.links.includes(b.id)) return ctx.setMeta(a.id, "graph", { ...ga, links: ga.links.filter(x => x !== b.id) });
  if (gb.links.includes(a.id)) return ctx.setMeta(b.id, "graph", { ...gb, links: gb.links.filter(x => x !== a.id) });
  return ctx.setMeta(a.id, "graph", { ...ga, links: [...ga.links, b.id] });
}

// The live view. Lives between renders so the layout, zoom and any drag in
// progress survive changes to the data.
class GraphView {
  constructor(el, ctx) {
    this.ctx = ctx; this.nodes = new Map(); this.links = [];
    this.zoom = { k: 1, x: 0, y: 0 }; this.linkFrom = null; this.linking = false;
    el.innerHTML = `<div class="graph">
      <div class="graph-bar">
        <button class="ghost" data-g="link" aria-pressed="false">Link items</button>
        <button class="ghost" data-g="fit">Fit</button>
        <button class="ghost" data-g="in" aria-label="Zoom in">+</button>
        <button class="ghost" data-g="out" aria-label="Zoom out">−</button>
        <span class="hint" data-g="hint">Drag to move, scroll to zoom, click to open.</span>
      </div>
      <svg role="img" aria-label="Graph of linked items"><g class="vp"><g class="edges"></g><g class="nodes"></g></g></svg>
    </div>`;
    this.svg = el.querySelector("svg"); this.vp = el.querySelector(".vp");
    this.gEdges = el.querySelector(".edges"); this.gNodes = el.querySelector(".nodes");
    this.hint = el.querySelector('[data-g="hint"]'); this.linkBtn = el.querySelector('[data-g="link"]');
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
    this.hint.textContent = on ? "Click one item, then another, to link or unlink them." : "Drag to move, scroll to zoom, click to open.";
    this.paint();
  }

  // Brings nodes and links in line with the items, keeping positions.
  sync(ctx, first = false) {
    this.ctx = ctx;
    const items = ctx.items, w = this.svg.clientWidth || 800, h = this.svg.clientHeight || 520;
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
    this.links = edges(items);
    this.draw();
    this.heat(first ? 1 : 0.4);
    if (first) requestAnimationFrame(() => this.fit());
  }

  draw() {
    this.gEdges.replaceChildren(...this.links.map(([a, b]) => {
      const l = document.createElementNS(SVG, "line"); l.dataset.a = a; l.dataset.b = b; return l;
    }));
    this.gNodes.replaceChildren(...[...this.nodes.values()].map(n => {
      const g = document.createElementNS(SVG, "g");
      g.dataset.id = n.id;
      g.innerHTML = `<circle r="9"></circle><text x="14" y="4">${esc(n.item.title.length > 40 ? n.item.title.slice(0, 39) + "…" : n.item.title)}</text>`;
      return g;
    }));
    this.paint();
  }

  paint() {
    const { k, x, y } = this.zoom;
    this.vp.setAttribute("transform", `translate(${x} ${y}) scale(${k})`);
    for (const l of this.gEdges.children) {
      const a = this.nodes.get(l.dataset.a), b = this.nodes.get(l.dataset.b);
      l.setAttribute("x1", a.x); l.setAttribute("y1", a.y); l.setAttribute("x2", b.x); l.setAttribute("y2", b.y);
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
    for (const [ia, ib] of this.links) {
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
        const g = d.n.item.meta.graph || { links: [] };
        this.ctx.setMeta(d.n.id, "graph", { links: g.links || [], x: Math.round(d.n.x), y: Math.round(d.n.y) });
      } else if (this.linking) {
        if (!this.linkFrom) { this.linkFrom = d.n.id; this.paint(); }
        else if (this.linkFrom === d.n.id) { this.linkFrom = null; this.paint(); }
        else { toggleLink(this.nodes.get(this.linkFrom).item, d.n.item, this.ctx); this.linkFrom = null; }
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
    const coord = c => {
      if (c == null || c === "") return null;
      const n = Number(c);
      if (!Number.isFinite(n) || Math.abs(n) > 1e6) fail("graph.x and graph.y must be numbers");
      return Math.round(n);
    };
    return { links: ids, x: coord(v.x), y: coord(v.y) };
  },

  fresh: () => ({ links: [], x: null, y: null }),

  chips(item, ctx) {
    const n = item.meta.graph.links.length + ctx.all.filter(o => o.meta.graph?.links.includes(item.id)).length;
    return n ? [`<span class="chip">${n} link${n === 1 ? "" : "s"}</span>`] : [];
  },

  // Links stored on this item, as tick boxes. Links other items made to this
  // one are listed below; unlink those from the other item or in the graph.
  editor(item, ctx) {
    const g = item.meta.graph, others = ctx.all.filter(o => o.collection === item.collection && o.id !== item.id);
    const from = ctx.all.filter(o => o.meta.graph?.links.includes(item.id));
    return `<input type="hidden" name="x" value="${g.x ?? ""}"><input type="hidden" name="y" value="${g.y ?? ""}">
      ${others.length ? `<div class="picks">${others.map(o => `<label class="inline"><input type="checkbox" name="links" value="${esc(o.id)}" ${g.links.includes(o.id) ? "checked" : ""}> ${esc(o.title)}</label>`).join("")}</div>`
        : `<p class="hint">Add more items to this collection to link them.</p>`}
      ${from.length ? `<p class="hint">Also linked from ${from.map(o => `“${esc(o.title)}”`).join(", ")}.</p>` : ""}`;
  },
  read: f => ({ links: f.links || [], x: f.x === "" ? null : f.x, y: f.y === "" ? null : f.y }),

  view: {
    label: "Graph",
    mount(el, ctx) { live = new GraphView(el, ctx); },
    update(ctx) { live?.sync(ctx); },
    unmount() { live?.destroy(); live = null; },
  },
};
