// Locations: give an item a place, as a what3words address, and see the day's
// events on a map.
// meta.location = { words, lat, lng, place }
//   words     the three words, bare and lowercase ("filled.count.soap"); "" for none yet
//   lat, lng  where they are, filled in by the site from what3words when you
//             save (src/w3w.js); null until then
//   place     the nearest town what3words names, for showing; "" when unknown
//
// The Map view shows the items that are events on the chosen day and have a
// place, numbered in the order they happen and joined in that order. Picking
// one in the list flies the map to it.

import { esc, today, addDays, dayOf, timeOf, niceDay, niceTime, parseWords } from "../lib.js";

const BLANK = { words: "", lat: null, lng: null, place: "" };
const pin = '<path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="9.8" r="2.3" stroke="currentColor" stroke-width="1.8"/>';
const placed = m => m && m.words && m.lat != null && m.lng != null;
export const w3wLink = words => "https://what3words.com/" + encodeURIComponent(words).replace(/%2E/gi, ".");

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
// `unplaced` has the day's events whose words aren't on the map yet, and
// `elsewhere` counts the day's events with no place at all.
export function dayStops(items, d) {
  const evs = items.filter(it => it.meta.event && onDay(it.meta.event, d)).sort(byStart);
  const stops = [], unplaced = [];
  let elsewhere = 0, prev = null;
  for (const it of evs) {
    const m = it.meta.location;
    if (!m?.words) { elsewhere++; continue; }
    if (!placed(m)) { unplaced.push(it); continue; }
    stops.push({ item: it, n: stops.length + 1, from: prev ? distance(prev, m) : null });
    prev = m;
  }
  return { stops, unplaced, elsewhere };
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
    el.addEventListener("change", this.onChange = e => {
      if (e.target.dataset.geo === "pick" && e.target.value) this.setDay(e.target.value);
    });
    this.draw();
    loadLeaflet().then(L => { if (this.el) { this.L = L; this.build(); } })
      .catch(err => { if (this.el) this.mapEl.innerHTML = `<p class="hint">Couldn’t show the map: ${esc(err.message)}.</p>`; });
  }

  get day() { return this.ctx.viewState.day || today(); }
  setDay(d) { this.ctx.viewState.day = d; this.ctx.viewState.sel = null; this.draw(); }

  build() {
    const L = this.L;
    this.mapEl.innerHTML = "";
    this.map = L.map(this.mapEl, { zoomControl: true, worldCopyJump: true }).setView([20, 0], 2);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.map);
    this.map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
    this.shown = null;
    this.draw();
  }

  update(ctx) { this.ctx = ctx; this.draw(); }

  draw() {
    const { ctx } = this, day = this.day, plan = dayStops(ctx.items, day), far = miles();
    const vs = ctx.viewState;
    if (vs.sel && !plan.stops.some(s => s.item.id === vs.sel)) vs.sel = null;
    this.el.querySelector("[data-geo=pick]").value = day;
    this.el.querySelector("[data-geo=label]").textContent = niceDay(day) + (plan.stops.length ? ` · ${plan.stops.length} place${plan.stops.length === 1 ? "" : "s"}` : "");

    const noEvents = ctx.collection && !ctx.collection.plugins.includes("event");
    let side = plan.stops.length ? `<ol class="geo-list">${plan.stops.map(({ item: it, n, from }) => {
      const m = it.meta.location;
      return `<li class="${it.id === vs.sel ? "sel" : ""}${it.meta.checklist?.done ? " done" : ""}" data-id="${esc(it.id)}">
        <button class="go" data-geo="go" aria-label="Show ${esc(it.title)} on the map"><span class="num">${n}</span>
          <span class="txt"><b>${esc(it.title)}</b><small>${esc(whenOf(it.meta.event))}${from != null ? ` · ${esc(niceDistance(from, far))} from ${n - 1}` : ""}</small>
          <small class="w3w">///${esc(m.words)}${m.place ? ` · ${esc(m.place)}` : ""}</small></span></button>
        <button class="link" data-geo="open">Edit</button></li>`;
    }).join("")}</ol>` : `<p class="hint">${noEvents ? "Turn on Events in this collection’s settings too, so items have a day to be on the map."
      : `Nothing with a place on ${esc(niceDay(day))}. Give an event a what3words address in its dialog, or add one with ///three.word.address.`}</p>`;
    if (plan.unplaced.length) side += `<p class="hint">Not on the map yet: ${plan.unplaced.map(it => `<button class="link" data-geo="open" data-id="${esc(it.id)}">${esc(it.title)}</button> (///${esc(it.meta.location.words)})`).join(", ")}. The site places what3words addresses when it has a what3words key.</p>`;
    if (plan.elsewhere) side += `<p class="hint">${plan.elsewhere} more on this day with no place.</p>`;
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
      mk.bindPopup(`<b>${esc(it.title)}</b><br>${esc(whenOf(it.meta.event))}<br><a href="${esc(w3wLink(m.words))}" target="_blank" rel="noopener">///${esc(m.words)}</a>${m.place ? `<br><small>${esc(m.place)}</small>` : ""}
        <br><button class="link" data-geo="open" data-id="${esc(it.id)}">Edit</button>`);
      mk.on("click", () => this.select(it.id, false));
      // Leaflet keeps clicks inside a popup to itself, so its Edit button gets its own handler.
      mk.on("popupopen", e => { const b = e.popup.getElement()?.querySelector("[data-geo=open]"); if (b) b.onclick = () => this.ctx.open(it.id); });
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
    }
  }

  destroy() {
    this.el.removeEventListener("click", this.onClick);
    this.el.removeEventListener("change", this.onChange);
    this.map?.remove(); this.map = null; this.el = null;
  }
}
let live = null;

export default {
  id: "location",
  name: "Locations",
  description: "Give items a place as a what3words address, and see each day’s events on a map.",
  icon: pin,

  clean(v, fail) {
    if (!v || typeof v !== "object" || Array.isArray(v)) fail("location must be an object");
    const raw = String(v.words ?? "").trim();
    const words = raw ? parseWords(raw) : "";
    if (words === null) fail("location.words must be a what3words address, three words with dots like filled.count.soap");
    let lat = v.lat ?? null, lng = v.lng ?? null;
    if ((lat === null) !== (lng === null)) fail("location.lat and location.lng go together");
    if (lat !== null) {
      lat = Number(lat); lng = Number(lng);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) fail("location.lat must be between -90 and 90");
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) fail("location.lng must be between -180 and 180");
    }
    const place = String(v.place ?? "").trim();
    if (place.length > 120) fail("location.place is longer than 120 characters");
    return words ? { words, lat, lng, place } : { ...BLANK };
  },

  fresh(quick) {
    return quick.location ? { ...BLANK, words: quick.location } : undefined;
  },

  chips(item) {
    const m = item.meta.location;
    if (!m.words) return [];
    return [`<span class="chip place" title="${placed(m) ? "On the map" : "Not on the map yet"}">${`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">${pin}</svg>`}///${esc(m.words)}${m.place ? ` · ${esc(m.place)}` : ""}</span>`];
  },

  editor(item) {
    const m = item.meta.location;
    const about = placed(m)
      ? `${m.place ? esc(m.place) + " · " : ""}${m.lat.toFixed(5)}, ${m.lng.toFixed(5)} · <a href="${esc(w3wLink(m.words))}" target="_blank" rel="noopener">See it on what3words</a>`
      : m.words ? "Not placed on the map yet. The site does that when it has a what3words key."
      : `Every 3 m square in the world has three words. Find a place’s at <a href="https://what3words.com/" target="_blank" rel="noopener">what3words.com</a>.`;
    return `<label>what3words address<input type="text" name="words" value="${m.words ? "///" + esc(m.words) : ""}" placeholder="///filled.count.soap" autocomplete="off" spellcheck="false"></label>
      <p class="hint">${about}</p>`;
  },
  read(f, item) {
    const raw = String(f.words ?? "").trim();
    if (!raw) return { ...BLANK };
    const words = parseWords(raw);
    if (!words) throw new Error("A what3words address is three words with dots, like ///filled.count.soap");
    const old = item.meta.location;
    return old?.words === words ? old : { ...BLANK, words };
  },

  view: {
    label: "Map",
    mount(el, ctx) { live = new MapView(el, ctx); },
    update(ctx) { live?.update(ctx); },
    unmount() { live?.destroy(); live = null; },
  },
};
