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
// one in the list flies the map there. Each day starts and ends at its base
// (the collection's bases: a home base, and ones for a day or a stretch of
// days, public/todo/route.js), and "Route" plans the order to go in along the
// streets, with the few best orders to cycle between (src/routing.js).

import { esc, icon, today, addDays, dayOf, timeOf, niceDay, niceTime, parseCoords } from "../lib.js";
import { baseFor, baseScope, isHome, niceDuration, straightNote, PROFILES } from "../route.js";

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
const VERB = { "driving-car": "drive", "foot-walking": "walk", "cycling-regular": "ride" };
const house = '<path d="M4 11.5 12 5l8 6.5V20h-5.5v-5h-5v5H4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>';
// What decides a day's route: its stops' times, places and links, and the bases.
const routeKey = (ctx, day, plan) => JSON.stringify([ctx.collection?.id, day, ctx.viewState.profile, ctx.viewState.option || 0, ctx.collection?.bases || [],
  plan.stops.map(({ item: it }) => [it.id, it.meta.event, it.meta.location.lat, it.meta.location.lng, it.meta.graph?.links, it.meta.graph?.rel])]);

// The live map. Lives between renders so the map keeps where you'd panned to.
class MapView {
  constructor(el, ctx) {
    this.ctx = ctx; this.el = el; this.map = null; this.markers = new Map(); this.line = null; this.shown = null;
    this.route = null; this.routeKey = null; this.baseForm = null;
    el.innerHTML = `<div class="geo">
      <div class="graph-bar">
        <button class="ghost" data-geo="day" data-step="-1" aria-label="Previous day">‹</button>
        <input type="date" data-geo="pick" aria-label="Day to show">
        <button class="ghost" data-geo="day" data-step="1" aria-label="Next day">›</button>
        <button class="ghost" data-geo="today">Today</button>
        <button class="ghost" data-geo="fit">Fit</button>
        <button class="ghost" data-geo="route" aria-pressed="false">Route</button>
        <select data-geo="profile" aria-label="How you get around" hidden>${Object.entries(PROFILES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
        <span class="hint" data-geo="label"></span>
      </div>
      <div class="geo-body"><div class="geo-map"><p class="hint">Loading the map…</p></div><div class="geo-side"></div></div>
    </div>`;
    this.mapEl = el.querySelector(".geo-map"); this.side = el.querySelector(".geo-side");
    el.addEventListener("click", this.onClick = e => this.click(e));
    el.addEventListener("keydown", this.onKey = e => { if (e.key === "Escape" && this.pinning) { e.stopPropagation(); this.stopPin(); } });
    el.addEventListener("change", this.onChange = e => {
      const g = e.target.dataset.geo;
      if (g === "pick" && e.target.value) this.setDay(e.target.value);
      if (g === "profile") { this.ctx.viewState.profile = e.target.value; this.ctx.viewState.option = 0; this.draw(); }
      if (e.target.name === "scope") this.side.querySelector(".base-dates").hidden = e.target.value !== "range";
    });
    el.addEventListener("submit", this.onSubmit = e => { e.preventDefault(); this.saveBase(e.target); });
    this.draw();
    loadLeaflet().then(L => { if (this.el) { this.L = L; this.build(); } })
      .catch(err => { if (this.el) this.mapEl.innerHTML = `<p class="hint">Couldn’t show the map: ${esc(err.message)}.</p>`; });
  }

  get day() { return this.ctx.viewState.day || today(); }
  get bases() { return this.ctx.collection?.bases || []; }
  startPin(id) {
    this.pinning = this.pinning === id ? null : id;
    this.mapEl.classList.toggle("pinning", !!this.pinning);
    this.draw();
  }
  stopPin() { this.pinning = null; this.mapEl.classList.remove("pinning"); this.draw(); }
  setDay(d) { Object.assign(this.ctx.viewState, { day: d, sel: null, option: 0 }); this.baseForm = null; this.draw(); }

  build() {
    const L = this.L;
    this.mapEl.innerHTML = "";
    this.map = L.map(this.mapEl, { zoomControl: true, worldCopyJump: true }).setView([20, 0], 2);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.map);
    this.map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
    // Pinning: the next click on the map is where the item (or the base) is. The site names the spot.
    this.map.on("click", e => {
      if (!this.pinning) return;
      const id = this.pinning, { lat, lng } = e.latlng.wrap(), at = { place: "", lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
      this.stopPin();
      if (id === "base") { this.baseForm = { ...this.baseForm, picked: at }; this.draw(); return; }
      this.ctx.viewState.sel = id;
      this.ctx.setMeta(id, "location", at);
    });
    this.shown = null;
    this.draw();
  }

  update(ctx) { this.ctx = ctx; this.draw(); }

  // The route for the day, from the site; draws again when it comes.
  fetchRoute(key) {
    if (this.routeKey === key) return;
    this.routeKey = key; this.route = null; this.routeError = null;
    const vs = this.ctx.viewState, q = new URLSearchParams({ collection: this.ctx.collection.id, day: this.day, profile: vs.profile || "driving-car", option: vs.option || 0 });
    fetch("/todo/api/route?" + q, { credentials: "same-origin", cache: "no-store" })
      .then(r => r.ok ? r.json() : r.json().then(b => { throw new Error(b.error || r.statusText); }))
      .then(r => { if (this.routeKey === key) { this.route = r; this.draw(); } })
      .catch(e => { if (this.routeKey === key) { this.routeError = e.message; this.draw(); } });
  }

  draw() {
    const { ctx } = this, day = this.day, plan = dayStops(ctx.items, day), far = miles();
    const vs = ctx.viewState, base = baseFor(this.bases, day);
    if (vs.sel && !plan.stops.some(s => s.item.id === vs.sel)) vs.sel = null;
    this.el.querySelector("[data-geo=pick]").value = day;
    this.el.querySelector("[data-geo=route]").setAttribute("aria-pressed", !!vs.route);
    const prof = this.el.querySelector("[data-geo=profile]");
    prof.hidden = !vs.route; prof.value = vs.profile || "driving-car";

    // In route mode the stops go in the route's order, once it's come.
    let stops = plan.stops, route = null;
    if (vs.route && ctx.collection && plan.stops.length) {
      this.fetchRoute(routeKey(ctx, day, plan));
      route = this.route;
      if (route?.options.length) {
        const by = new Map(plan.stops.map(s => [s.item.id, s.item])), opt = route.options[route.option];
        stops = opt.order.filter(id => by.has(id)).map((id, i) => ({ item: by.get(id), n: i + 1, leg: route.legs[i + (route.base?.lat != null ? 0 : -1)], late: opt.late.includes(id) }));
      }
    }
    const pinning = this.pinning && (this.pinning === "base" ? { title: "the base" } : ctx.items.find(it => it.id === this.pinning));
    this.el.querySelector("[data-geo=label]").textContent = pinning ? `Click the map where ${this.pinning === "base" ? "the base" : `“${pinning.title}”`} is (Esc to stop)`
      : niceDay(day) + (plan.stops.length ? ` · ${plan.stops.length} place${plan.stops.length === 1 ? "" : "s"}` : "");

    const verb = VERB[route?.profile] || "drive", legText = leg => leg ? `${niceDuration(leg.duration)} ${verb}${leg.distance ? `, ${niceDistance(leg.distance, far)}` : ""}` : "";
    let side = this.baseHtml(base, day);
    if (vs.route && plan.stops.length) side += this.routeBar(route);
    const noEvents = ctx.collection && !ctx.collection.plugins.includes("event");
    side += stops.length ? `<ol class="geo-list">${stops.map(({ item: it, n, from, leg, late }) => {
      const m = it.meta.location;
      const how = route ? (leg ? ` · ${esc(legText(leg))}` : "") : from != null ? ` · ${esc(niceDistance(from, far))} from ${n - 1}` : "";
      return `<li class="${it.id === vs.sel ? "sel" : ""}${it.meta.checklist?.done ? " done" : ""}" data-id="${esc(it.id)}">
        <button class="go" data-geo="go" aria-label="Show ${esc(it.title)} on the map"><span class="num">${n}</span>
          <span class="txt"><b>${esc(it.title)}</b><small>${esc(whenOf(it.meta.event))}${how}</small>
          ${late ? `<small class="late">You’d probably get there late</small>` : ""}
          <small class="where">${esc(placeLabel(m))}</small></span></button>
        <button class="link" data-geo="open">Edit</button></li>`;
    }).join("")}</ol>` : `<p class="hint">${noEvents ? "Turn on Events in this collection’s settings too, so items have a day to be on the map."
      : `Nothing with a place on ${esc(niceDay(day))}. Search for one in an event’s dialog, pin one below, or add one with ~ and its name.`}</p>`;
    if (route?.options.length && route.base?.lat != null) side += `<p class="geo-back">${icon(house, 14)} Back to ${esc(placeLabel(route.base))}${route.legs.length ? ` · ${esc(legText(route.legs.at(-1)))}` : ""}</p>`;
    // The day's other events, to pin on the map.
    const pinnable = (title, list, what) => list.length ? `<h4 class="geo-h">${title}</h4><ul class="geo-pins">${list.map(it => `<li data-id="${esc(it.id)}">
      <span><b>${esc(it.title)}</b><small>${esc(whenOf(it.meta.event))}${what(it)}</small></span>
      <button class="link" data-geo="pin" aria-pressed="${this.pinning === it.id}">${this.pinning === it.id ? "Click the map…" : "Pin"}</button></li>`).join("")}</ul>` : "";
    side += pinnable("Not found yet", plan.unplaced, it => ` · “${esc(it.meta.location.place)}”`);
    side += pinnable("No place", plan.elsewhere, () => "");
    side += this.allBasesHtml();
    // Keep what's being typed in the base form across redraws.
    const typing = this.side.querySelector(".base-form [name=place]");
    if (typing && this.baseForm) this.baseForm.text = typing.value;
    this.side.innerHTML = side;
    if (this.baseForm) this.mountBaseForm();
    if (this.map) this.drawMap(stops, route, base);
  }

  // Where the day starts and ends, and the form to change it.
  baseHtml(base, day) {
    const owner = this.ctx.collection && this.ctx.collection.role !== "view";
    if (this.baseForm) {
      const f = this.baseForm, cur = f.base, scope = f.scope || (cur ? (isHome(cur) ? "home" : cur.from === cur.to ? "day" : "range") : "day");
      const picked = f.picked ? placeLabel(f.picked) : null;
      return `<form class="base-form"><h4 class="geo-h">${cur ? "Change the base" : "Set a base"}</h4>
        <label>Place<input type="search" name="place" value="${esc(f.text ?? picked ?? (cur ? placeLabel(cur) : ""))}" placeholder="An address or a place’s name" autocomplete="off" spellcheck="false" required></label>
        <ul class="place-results"></ul>
        <p class="hint">${picked ? "Pinned on the map." : `Search, paste coordinates, or <button type="button" class="link" data-geo="pinbase">pin it on the map</button>.`}</p>
        <fieldset class="base-scope"><legend class="hint">It's the base for</legend>
          <label class="inline"><input type="radio" name="scope" value="day" ${scope === "day" ? "checked" : ""}> ${esc(niceDay(day))}</label>
          <label class="inline"><input type="radio" name="scope" value="range" ${scope === "range" ? "checked" : ""}> A stretch of days</label>
          <span class="base-dates" ${scope === "range" ? "" : "hidden"}><input type="date" name="from" value="${esc(cur?.from || day)}" aria-label="First day"> to <input type="date" name="to" value="${esc(cur?.to || addDays(1, day))}" aria-label="Last day"></span>
          <label class="inline"><input type="radio" name="scope" value="home" ${scope === "home" ? "checked" : ""}> Every day (home base)</label>
        </fieldset>
        <div class="base-btns"><button type="button" class="btn" data-geo="basecancel">Cancel</button><button class="btn primary">Save</button></div>
      </form>`;
    }
    if (!base) return `<div class="geo-base">${icon(house, 15)}<span><small>No base for this day</small>Routes start at the first stop.</span>${owner ? `<span class="btns"><button class="link" data-geo="baseedit">Set a base</button></span>` : ""}</div>`;
    const justToday = base.from === day && base.to === day;
    return `<div class="geo-base">${icon(house, 15)}<span><small>${esc(baseScope(base, niceDay))}</small>${esc(placeLabel(base))}${base.lat == null ? " <em>(not found on the map)</em>" : ""}</span>
      ${owner ? `<span class="btns">${justToday ? "" : `<button class="link" data-geo="baseedit" data-which="new">Set one for this day</button>`}<button class="link" data-geo="baseedit">Change</button></span>` : ""}</div>`;
  }

  allBasesHtml() {
    const bs = this.bases;
    if (!bs.length) return "";
    const owner = this.ctx.collection?.role !== "view";
    const sorted = bs.map((b, i) => [b, i]).sort(([a], [b]) => isHome(a) ? -1 : isHome(b) ? 1 : a.from.localeCompare(b.from));
    return `<details class="geo-bases"><summary class="geo-h">All bases (${bs.length})</summary><ul class="geo-pins">${sorted.map(([b, i]) => `<li>
      <span><b>${esc(placeLabel(b))}</b><small>${esc(baseScope(b, niceDay))}</small></span>
      ${owner ? `<button class="link" data-geo="baseedit" data-i="${i}">Change</button><button class="link" data-geo="baseremove" data-i="${i}">Remove</button>` : ""}</li>`).join("")}</ul></details>`;
  }

  // The order you'd go in: which of the options, how long it takes, and how to get around.
  routeBar(route) {
    if (this.routeError) return `<p class="hint">Couldn’t plan the route: ${esc(this.routeError)}.</p>`;
    if (!route) return `<p class="hint">Planning the route…</p>`;
    if (!route.options.length) return "";
    const opt = route.options[route.option], n = route.options.length, far = miles();
    return `<div class="geo-routebar">
      ${n > 1 ? `<button class="ghost" data-geo="option" data-step="-1" aria-label="Previous route">‹</button>` : ""}
      <span><b>${n > 1 ? `Route ${route.option + 1} of ${n}` : "Route"}</b>${esc(niceDuration(opt.duration))} of travel${opt.distance ? `, ${esc(niceDistance(opt.distance, far))}` : ""}
        <small>${route.options.length && straightNote(route) ? esc(straightNote(route)) + " " : ""}${route.loose ? "Some linked places can’t be next to each other at those times. " : ""}${n > 1 ? "Times and links fixed; the rest is shortest first." : ""}</small></span>
      ${n > 1 ? `<button class="ghost" data-geo="option" data-step="1" aria-label="Next route">›</button>` : ""}</div>`;
  }

  mountBaseForm() {
    const form = this.side.querySelector(".base-form");
    placeSearch(form.querySelector("[name=place]"), form.querySelector(".place-results"), centre(this.ctx.scopeItems || this.ctx.items), p => {
      this.baseForm.picked = p; this.baseForm.text = p.place;
    });
    form.querySelector("[name=place]").addEventListener("input", () => { this.baseForm.picked = null; });
  }

  saveBase(form) {
    const f = this.baseForm, fd = new FormData(form), text = String(fd.get("place") || "").trim(), scope = fd.get("scope");
    const at = f.picked && placeLabel(f.picked) === text ? f.picked : f.base && placeLabel(f.base) === text ? { place: f.base.place, lat: f.base.lat, lng: f.base.lng }
      : parseCoords(text) ? { place: "", ...parseCoords(text) } : { ...BLANK, place: text };
    const when = scope === "home" ? { from: null, to: null } : scope === "range" ? { from: fd.get("from"), to: fd.get("to") } : { from: this.day, to: this.day };
    if (when.from && (!when.to || when.to < when.from)) return this.ctx.toast?.("The last day can’t be before the first.");
    const bases = this.bases.filter((_, i) => i !== f.index);
    this.baseForm = null;
    this.ctx.setBases([...bases, { ...at, ...when }]);
  }

  drawMap(stops, route, base) {
    const { L, map } = this, vs = this.ctx.viewState;
    for (const mk of this.markers.values()) mk.remove();
    this.markers.clear();
    this.line?.remove(); this.line = null;
    this.home?.remove(); this.home = null;
    for (const { item: it, n } of stops) {
      const m = it.meta.location;
      const icon = L.divIcon({ className: `geo-pin${it.id === vs.sel ? " sel" : ""}`, html: `<span>${n}</span>`, iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12] });
      const mk = L.marker([m.lat, m.lng], { icon, title: it.title, riseOnHover: true }).addTo(map);
      mk.bindPopup(`<b>${esc(it.title)}</b><br>${esc(whenOf(it.meta.event))}<br>${esc(placeLabel(m))}
        <br><button class="link" data-geo="open" data-id="${esc(it.id)}">Edit</button> · <button class="link" data-geo="pin" data-id="${esc(it.id)}">Move pin</button>
        · <a href="${esc(osmLink(m))}" target="_blank" rel="noopener">OpenStreetMap</a>`);
      mk.on("click", () => this.select(it.id, false));
      // Leaflet keeps clicks inside a popup to itself, so its buttons get their own handlers.
      mk.on("popupopen", e => {
        const el = e.popup.getElement();
        el?.querySelector("[data-geo=open]")?.addEventListener("click", () => this.ctx.open(it.id));
        el?.querySelector("[data-geo=pin]")?.addEventListener("click", () => { this.map.closePopup(); this.startPin(it.id); });
      });
      this.markers.set(it.id, mk);
    }
    if (placed(base)) {
      const icon = L.divIcon({ className: "geo-home", html: `<span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">${house}</svg></span>`, iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12] });
      this.home = L.marker([base.lat, base.lng], { icon, title: "Base", zIndexOffset: -100 }).addTo(map).bindPopup(`<b>${esc(baseScope(base, niceDay))}</b><br>${esc(placeLabel(base))}`);
    }
    if (route?.path.length > 1) this.line = L.polyline(route.path, { className: "geo-route on", weight: 4, opacity: 0.8 }).addTo(map);
    else if (stops.length > 1) this.line = L.polyline(stops.map(s => [s.item.meta.location.lat, s.item.meta.location.lng]), { className: "geo-route", dashArray: "6 6", weight: 2 }).addTo(map);
    // A new day (or the first draw) frames everything; changes on the same day keep your view.
    const key = this.day + "|" + stops.map(s => s.item.id).join(",") + (route ? "|r" : "");
    if (this.shown !== key) { this.shown = key; if (vs.sel) this.flyTo(vs.sel, false); else this.fit(stops); }
  }

  fit(stops) {
    if (!this.map) return;
    const base = baseFor(this.bases, this.day);
    const pts = [...stops.map(s => [s.item.meta.location.lat, s.item.meta.location.lng]), ...(this.route?.path || [])];
    if (this.ctx.viewState.route && placed(base)) pts.push([base.lat, base.lng]);
    if (!pts.length) return;
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
    const id = b.dataset.id || b.closest("[data-id]")?.dataset.id, vs = this.ctx.viewState;
    switch (b.dataset.geo) {
      case "day": this.setDay(addDays(+b.dataset.step, this.day)); break;
      case "today": this.setDay(today()); break;
      case "fit": this.fit(this.markers.size ? [...this.markers.keys()].map(id => ({ item: this.ctx.items.find(it => it.id === id) })).filter(s => s.item) : []); break;
      case "go": this.select(id); break;
      case "open": if (id) this.ctx.open(id); break;
      case "pin": if (id) this.startPin(id); break;
      case "route": vs.route = !vs.route; vs.option = 0; this.shown = null; this.draw(); break;
      case "option": {
        const n = this.route?.options.length || 1;
        vs.option = (((vs.option || 0) + +b.dataset.step) % n + n) % n; this.draw(); break;
      }
      case "baseedit": {
        const i = b.dataset.i != null ? +b.dataset.i : b.dataset.which === "new" ? -1 : this.bases.indexOf(baseFor(this.bases, this.day));
        this.baseForm = { index: i, base: i >= 0 ? this.bases[i] : null }; this.draw();
        this.side.querySelector(".base-form [name=place]")?.focus();
        break;
      }
      case "basecancel": this.baseForm = null; this.stopPin(); break;
      case "pinbase": this.startPin("base"); break;
      case "baseremove": this.ctx.setBases(this.bases.filter((_, i) => i !== +b.dataset.i)); break;
    }
  }

  destroy() {
    this.el.removeEventListener("click", this.onClick);
    this.el.removeEventListener("change", this.onChange);
    this.el.removeEventListener("keydown", this.onKey);
    this.el.removeEventListener("submit", this.onSubmit);
    this.map?.remove(); this.map = null; this.el = null;
  }
}
let live = null;

// A place search box: places matching what's typed, from the site, near
// `near`. Picking one fills the box and calls onPick.
function placeSearch(input, list, near, onPick) {
  let timer, asked = 0, results = [];
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3 || parseCoords(q)) { list.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      const n = ++asked;
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
    onPick(p);
  });
}

// The item dialog's search, near the collection's other places. Picking one saves it.
function searchBox(fs, item, ctx) {
  const input = fs.querySelector("[name=place]"), list = fs.querySelector(".place-results");
  if (!input || !list) return;
  placeSearch(input, list, centre(ctx.all.filter(it => it.collection === item.collection && it.id !== item.id)), p => ctx.setMeta(item.id, "location", p));
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
