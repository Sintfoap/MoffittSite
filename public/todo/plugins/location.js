// Locations: give an item a place, and see the day's events on a map.
// meta.location = { place, lat, lng }
//   place     what it's called: an address or a place's name, as found ("" for none yet)
//   lat, lng  where it is; null until it's been found
//
// You search for a place (the site asks OpenRouteService, src/places.js), pin
// it on the map, or paste coordinates. A place typed but not picked from the
// search is looked up when it's saved, and coordinates on their own get the
// name of the spot.
//
// The Map view shows the items that are events on the chosen day and have a
// place, numbered in the order they happen and joined in that order. Picking
// one in the list flies the map there.

import { esc, today, addDays, dayOf, timeOf, niceDay, niceTime, parseCoords } from "../lib.js";

const BLANK = { place: "", lat: null, lng: null };
const pin = '<path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="9.8" r="2.3" stroke="currentColor" stroke-width="1.8"/>';
export const placed = m => !!m && m.lat != null && m.lng != null;
const coords = m => `${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}`;
// What to call it: its name, or its coordinates.
export const placeLabel = m => m.place || (placed(m) ? coords(m) : "");
export const osmLink = m => `https://www.openstreetmap.org/?mlat=${m.lat}&mlon=${m.lng}#map=17/${m.lat}/${m.lng}`;

// Does the event cover this day? Same rule as the calendar.
const onDay = (m, d) => dayOf(m.start) <= d && d <= dayOf(m.end || m.start);
const byStart = (a, b) => (a.meta.event.start.length - b.meta.event.start.length) || a.meta.event.start.localeCompare(b.meta.event.start);

// Metres between two {lat, lng}, as the crow flies.
export function distance(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}
// "350 m", "1.2 km", "12 km"; or "0.3 mi", "12 mi" for miles.
export function niceDistance(m, miles = false) {
  if (miles) { const mi = m / 1609.344; return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`; }
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${m < 10000 ? (m / 1000).toFixed(1) : Math.round(m / 1000)} km`;
}

// The day on the map: the events that day with a place, in the order they
// happen, each with its number and how far it is from the stop before;
// `unplaced` has the day's events whose place hasn't been found yet, and
// `elsewhere` the day's events with no place at all.
export function dayStops(items, d) {
  const evs = items.filter(it => it.meta.event && onDay(it.meta.event, d)).sort(byStart);
  const stops = [], unplaced = [], elsewhere = [];
  let prev = null;
  for (const it of evs) {
    const m = it.meta.location;
    if (placed(m)) { stops.push({ item: it, n: stops.length + 1, from: prev ? distance(prev, m) : null }); prev = m; }
    else (m?.place ? unplaced : elsewhere).push(it);
  }
  return { stops, unplaced, elsewhere };
}

// The middle of the places among `items`, to search near; null if none has one.
export function centre(items) {
  const pts = items.map(it => it.meta.location).filter(placed);
  return pts.length ? { lat: pts.reduce((a, m) => a + m.lat, 0) / pts.length, lng: pts.reduce((a, m) => a + m.lng, 0) / pts.length } : null;
}

// Leaflet (public/todo/vendor/leaflet/), loaded the first time a map is shown.
let leaflet = null;
function loadLeaflet() {
  return leaflet ||= new Promise((resolve, reject) => {
    if (window.L) return resolve(window.L);
    const base = new URL("../vendor/leaflet/", import.meta.url);
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = base + "leaflet.css";
    const js = document.createElement("script");
    js.src = base + "leaflet.js";
    js.onload = () => resolve(window.L);
    js.onerror = () => { leaflet = null; reject(new Error("the map didn't load")); };
    document.head.append(css, js);
  });
}

const whenOf = m => {
  const t = timeOf(m.start), et = timeOf(m.end);
  return t ? niceTime(t) + (et && dayOf(m.end) === dayOf(m.start) ? "–" + niceTime(et) : "") : "All day";
};
const miles = () => /^en-(US|LR|MM)$/i.test(globalThis.navigator?.language || "");

// The live map. Lives between renders so the map keeps where you'd panned to.
class MapView {
  constructor(el, ctx) {
    this.ctx = ctx; this.el = el; this.map = null; this.markers = new Map(); this.line = null; this.shown = null;
    el.innerHTML = `<div class="geo">
      <div class="graph-bar">
        <button class="ghost" data-geo="day" data-step="-1" aria-label="Previous day">‹</button>
        <input type="date" data-geo="pick" aria-label="Day to show">
        <button class="ghost" data-geo="day" data-step="1" aria-label="Next day">›</button>
        <button class="ghost" data-geo="today">Today</button>
        <button class="ghost" data-geo="fit">Fit</button>
        <span class="hint" data-geo="label"></span>
      </div>
      <div class="geo-body"><div class="geo-map"><p class="hint">Loading the map…</p></div><div class="geo-side"></div></div>
    </div>`;
    this.mapEl = el.querySelector(".geo-map"); this.side = el.querySelector(".geo-side");
    el.addEventListener("click", this.onClick = e => this.click(e));
    el.addEventListener("keydown", this.onKey = e => { if (e.key === "Escape" && this.pinning) { e.stopPropagation(); this.stopPin(); } });
    el.addEventListener("change", this.onChange = e => {
      if (e.target.dataset.geo === "pick" && e.target.value) this.setDay(e.target.value);
    });
    this.draw();
    loadLeaflet().then(L => { if (this.el) { this.L = L; this.build(); } })
      .catch(err => { if (this.el) this.mapEl.innerHTML = `<p class="hint">Couldn’t show the map: ${esc(err.message)}.</p>`; });
  }

  get day() { return this.ctx.viewState.day || today(); }
  startPin(id) {
    this.pinning = this.pinning === id ? null : id;
    this.mapEl.classList.toggle("pinning", !!this.pinning);
    this.draw();
  }
  stopPin() { this.pinning = null; this.mapEl.classList.remove("pinning"); this.draw(); }
  setDay(d) { this.ctx.viewState.day = d; this.ctx.viewState.sel = null; this.draw(); }

  build() {
    const L = this.L;
    this.mapEl.innerHTML = "";
    this.map = L.map(this.mapEl, { zoomControl: true, worldCopyJump: true }).setView([20, 0], 2);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.map);
    this.map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
    // Pinning: the next click on the map is where the item is. The site names the spot.
    this.map.on("click", e => {
      if (!this.pinning) return;
      const id = this.pinning, { lat, lng } = e.latlng.wrap();
      this.stopPin();
      this.ctx.viewState.sel = id;
      this.ctx.setMeta(id, "location", { place: "", lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
    });
    this.shown = null;
    this.draw();
  }

  update(ctx) { this.ctx = ctx; this.draw(); }

  draw() {
    const { ctx } = this, day = this.day, plan = dayStops(ctx.items, day), far = miles();
    const vs = ctx.viewState;
    if (vs.sel && !plan.stops.some(s => s.item.id === vs.sel)) vs.sel = null;
    this.el.querySelector("[data-geo=pick]").value = day;
    const pinning = this.pinning && ctx.items.find(it => it.id === this.pinning);
    this.el.querySelector("[data-geo=label]").textContent = pinning ? `Click the map where “${pinning.title}” is (Esc to stop)`
      : niceDay(day) + (plan.stops.length ? ` · ${plan.stops.length} place${plan.stops.length === 1 ? "" : "s"}` : "");

    const noEvents = ctx.collection && !ctx.collection.plugins.includes("event");
    let side = plan.stops.length ? `<ol class="geo-list">${plan.stops.map(({ item: it, n, from }) => {
      const m = it.meta.location;
      return `<li class="${it.id === vs.sel ? "sel" : ""}${it.meta.checklist?.done ? " done" : ""}" data-id="${esc(it.id)}">
        <button class="go" data-geo="go" aria-label="Show ${esc(it.title)} on the map"><span class="num">${n}</span>
          <span class="txt"><b>${esc(it.title)}</b><small>${esc(whenOf(it.meta.event))}${from != null ? ` · ${esc(niceDistance(from, far))} from ${n - 1}` : ""}</small>
          <small class="where">${esc(placeLabel(m))}</small></span></button>
        <button class="link" data-geo="open">Edit</button></li>`;
    }).join("")}</ol>` : `<p class="hint">${noEvents ? "Turn on Events in this collection’s settings too, so items have a day to be on the map."
      : `Nothing with a place on ${esc(niceDay(day))}. Search for one in an event’s dialog, pin one below, or add one with ~ and its name.`}</p>`;
    // The day's other events, to pin on the map.
    const pinnable = (title, list, what) => list.length ? `<h4 class="geo-h">${title}</h4><ul class="geo-pins">${list.map(it => `<li data-id="${esc(it.id)}">
      <span><b>${esc(it.title)}</b><small>${esc(whenOf(it.meta.event))}${what(it)}</small></span>
      <button class="link" data-geo="pin" aria-pressed="${this.pinning === it.id}">${this.pinning === it.id ? "Click the map…" : "Pin"}</button></li>`).join("")}</ul>` : "";
    side += pinnable("Not found yet", plan.unplaced, it => ` · “${esc(it.meta.location.place)}”`);
    side += pinnable("No place", plan.elsewhere, () => "");
    this.side.innerHTML = side;
    if (this.map) this.drawMap(plan.stops);
  }

  drawMap(stops) {
    const { L, map } = this, vs = this.ctx.viewState;
    for (const mk of this.markers.values()) mk.remove();
    this.markers.clear();
    this.line?.remove(); this.line = null;
    for (const { item: it, n } of stops) {
      const m = it.meta.location;
      const icon = L.divIcon({ className: `geo-pin${it.id === vs.sel ? " sel" : ""}`, html: `<span>${n}</span>`, iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12] });
      const mk = L.marker([m.lat, m.lng], { icon, title: it.title, riseOnHover: true }).addTo(map);
      mk.bindPopup(`<b>${esc(it.title)}</b><br>${esc(whenOf(it.meta.event))}<br>${esc(placeLabel(m))}
        <br><button class="link" data-geo="open" data-id="${esc(it.id)}">Edit</button> · <button class="link" data-geo="pin" data-id="${esc(it.id)}">Move pin</button>
        · <a href="${esc(osmLink(m))}" target="_blank" rel="noopener">OpenStreetMap</a>`);
      mk.on("click", () => this.select(it.id, false));
      // Leaflet keeps clicks inside a popup to itself, so its Edit button gets its own handler.
      mk.on("popupopen", e => {
        const el = e.popup.getElement();
        el?.querySelector("[data-geo=open]")?.addEventListener("click", () => this.ctx.open(it.id));
        el?.querySelector("[data-geo=pin]")?.addEventListener("click", () => { this.map.closePopup(); this.startPin(it.id); });
      });
      this.markers.set(it.id, mk);
    }
    if (stops.length > 1) this.line = L.polyline(stops.map(s => [s.item.meta.location.lat, s.item.meta.location.lng]), { className: "geo-route", dashArray: "6 6", weight: 2 }).addTo(map);
    // A new day (or the first draw) frames everything; changes on the same day keep your view.
    const key = this.day + "|" + stops.map(s => s.item.id).join(",");
    if (this.shown !== key) { this.shown = key; if (vs.sel) this.flyTo(vs.sel, false); else this.fit(stops); }
  }

  fit(stops) {
    if (!this.map) return;
    if (!stops.length) return;
    const pts = stops.map(s => [s.item.meta.location.lat, s.item.meta.location.lng]);
    if (pts.length === 1) this.map.setView(pts[0], 16);
    else this.map.fitBounds(pts, { padding: [36, 36], maxZoom: 16 });
  }

  flyTo(id, animate = true) {
    const mk = this.markers.get(id);
    if (!mk || !this.map) return;
    const z = Math.max(this.map.getZoom(), 16);
    if (animate) this.map.flyTo(mk.getLatLng(), z, { duration: 0.8 }); else this.map.setView(mk.getLatLng(), z);
    mk.openPopup();
  }

  // Picks an item: highlights it in the list and on the map, and (from the list) flies there.
  select(id, fly = true) {
    this.ctx.viewState.sel = id;
    for (const li of this.side.querySelectorAll("li[data-id]")) li.classList.toggle("sel", li.dataset.id === id);
    for (const [k, mk] of this.markers) mk.getElement()?.classList.toggle("sel", k === id);
    if (fly) this.flyTo(id);
    else this.side.querySelector(`li[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  click(e) {
    const b = e.target.closest("[data-geo]"); if (!b) return;
    const id = b.dataset.id || b.closest("[data-id]")?.dataset.id;
    switch (b.dataset.geo) {
      case "day": this.setDay(addDays(+b.dataset.step, this.day)); break;
      case "today": this.setDay(today()); break;
      case "fit": this.fit(dayStops(this.ctx.items, this.day).stops); break;
      case "go": this.select(id); break;
      case "open": if (id) this.ctx.open(id); break;
      case "pin": if (id) this.startPin(id); break;
    }
  }

  destroy() {
    this.el.removeEventListener("click", this.onClick);
    this.el.removeEventListener("change", this.onChange);
    this.el.removeEventListener("keydown", this.onKey);
    this.map?.remove(); this.map = null; this.el = null;
  }
}
let live = null;

// The item dialog's search: places matching what you type, from the site,
// near the collection's other places. Picking one saves it.
function searchBox(fs, item, ctx) {
  const input = fs.querySelector("[name=place]"), list = fs.querySelector(".place-results");
  if (!input || !list) return;
  let timer, asked = 0, results = [];
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3 || parseCoords(q)) { list.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      const n = ++asked, near = centre(ctx.all.filter(it => it.collection === item.collection && it.id !== item.id));
      const r = await fetch(`/todo/api/places?q=${encodeURIComponent(q)}${near ? `&near=${near.lat.toFixed(4)},${near.lng.toFixed(4)}` : ""}`,
        { credentials: "same-origin", cache: "no-store" }).then(r => r.json()).catch(() => null);
      if (n !== asked) return;
      results = r?.results || [];
      list.innerHTML = r?.off ? `<li class="hint">Search is off until the site has an OpenRouteService key. Paste coordinates, or pin it on the Map.</li>`
        : !r || r.error ? `<li class="hint">Couldn’t search just now.</li>`
        : results.length ? results.map((p, i) => `<li><button type="button" data-pick="${i}">${esc(p.place)}</button></li>`).join("")
        : `<li class="hint">Nothing found for “${esc(q)}”.</li>`;
    }, 300);
  });
  // Keep focus in the box while picking, so it doesn't first save the half-typed text.
  list.addEventListener("mousedown", e => e.preventDefault());
  list.addEventListener("click", e => {
    const b = e.target.closest("[data-pick]"); if (!b) return;
    e.stopPropagation();
    const p = results[+b.dataset.pick];
    input.value = p.place; list.innerHTML = "";
    ctx.setMeta(item.id, "location", p);
  });
}

export default {
  id: "location",
  name: "Locations",
  description: "Give items a place, found by search or pinned on a map, and see each day’s events on a map.",
  icon: pin,

  clean(v, fail) {
    if (!v || typeof v !== "object" || Array.isArray(v)) fail("location must be an object");
    const place = String(v.place ?? "").trim().replace(/\s+/g, " ");
    if (place.length > 200) fail("location.place is longer than 200 characters");
    let lat = v.lat ?? null, lng = v.lng ?? null;
    if ((lat === null) !== (lng === null)) fail("location.lat and location.lng go together");
    if (lat !== null) {
      lat = Number(lat); lng = Number(lng);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) fail("location.lat must be between -90 and 90");
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) fail("location.lng must be between -180 and 180");
    }
    return { place, lat, lng };
  },

  fresh(quick) {
    return quick.place ? { ...BLANK, place: quick.place } : undefined;
  },

  chips(item) {
    const m = item.meta.location, label = placeLabel(m);
    if (!label) return [];
    return [`<span class="chip place${placed(m) ? "" : " lost"}" title="${placed(m) ? "On the map" : "Not found on the map yet"}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">${pin}</svg>${esc(label)}</span>`];
  },

  editor(item) {
    const m = item.meta.location;
    const about = placed(m) ? `${coords(m)} · <a href="${esc(osmLink(m))}" target="_blank" rel="noopener">See it on OpenStreetMap</a>`
      : m.place ? "Not found on the map yet. Pick it from the search, or pin it on the Map."
      : "Search for an address or a place by name, or paste coordinates. You can also pin it on the Map.";
    return `<label>Place<input type="search" name="place" value="${esc(placeLabel(m))}" placeholder="An address or a place’s name" autocomplete="off" spellcheck="false"></label>
      <ul class="place-results"></ul>
      <p class="hint">${about}</p>`;
  },
  mountEditor: searchBox,
  read(f, item) {
    const raw = String(f.place ?? "").trim();
    if (!raw) return { ...BLANK };
    const old = item.meta.location;
    if (old && raw === placeLabel(old)) return old;
    const at = parseCoords(raw);
    return at ? { place: "", ...at } : { ...BLANK, place: raw };
  },

  view: {
    label: "Map",
    mount(el, ctx) { live = new MapView(el, ctx); },
    update(ctx) { live?.update(ctx); },
    unmount() { live?.destroy(); live = null; },
  },
};
