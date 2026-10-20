// Trip planner: your trips down the side, the open one beside them in three
// tabs: the days (an itinerary, stop by stop), the places pinned to it (on a
// map), and the packing list, ready to send to a Drift checklist. Everyone on
// a trip sees the same one; it's fetched again when you come back to the tab.
// The Worker side is src/trips.js.

const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter(k => k != null));
  return n;
};

let data = null;          // GET /trips/api/trips: {trips, drift, search, lists}
let trip = null;          // the open trip, in full
let tab = "days";         // days | places | packing
let editing = null;       // the trip in the editor, or {} for a new one
let driftPlaces = null;   // your Drift items on the map, once asked for
let found = [];           // place search results
const skip = new Set();   // packing ids unticked for sending
const picked = new Set(); // packing ids ticked that wouldn't be by default
let adding = null;        // the day whose "add a stop" form is open

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

async function api(method, path, body) {
  const res = await fetch("/trips/api/" + path, {
    method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname); throw new Error("not signed in"); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `the site answered ${res.status}`);
  return out;
}

function say(kind, text) {
  for (const k of ["error", "done"]) { $("#" + k).hidden = k !== kind || !text; if (k === kind) $("#" + k).textContent = text || ""; }
}
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

async function run(fn) {
  say("error", "");
  try { await fn(); } catch (e) { say("error", cap(e.message || String(e))); return e; }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const at = d => new Date(d + "T00:00:00Z");
const niceDay = d => { const t = at(d); return `${DAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`; };
function span(t) {
  if (!t.start) return "No dates yet";
  if (!t.end || t.end === t.start) return niceDay(t.start) + " " + t.start.slice(0, 4);
  const n = Math.round((at(t.end) - at(t.start)) / 86400000) + 1;
  return `${niceDay(t.start)} – ${niceDay(t.end)} ${t.end.slice(0, 4)} · ${n} days`;
}
const nameOf = id => trip.members.find(m => m.id === id)?.name || "";
const osm = p => `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=16/${p.lat}/${p.lng}`;
const placeLabel = i => String(i + 1);

// Packing that goes to Drift when you press send: what's for you or anyone and
// isn't there yet, give or take what you've ticked and unticked.
const sendable = p => picked.has(p.id) || (!skip.has(p.id) && !p.in_drift && (!p.who || p.who === trip.you));

// ── the list ───────────────────────────────────────────────────────────────

function renderList() {
  const ul = $("#trips");
  ul.replaceChildren();
  if (!data.trips.length) ul.append(el("li", { className: "empty", textContent: "No trips yet." }));
  for (const t of data.trips) {
    const sub = [t.start ? span(t).replace(/ · .*/, "") : "No dates yet", t.owned ? (t.people > 1 ? `${t.people} going` : "") : `with ${t.owner_name}`].filter(Boolean).join(" · ");
    const b = el("button", { type: "button" }, t.title, el("small", { textContent: sub }));
    b.setAttribute("aria-current", String(t.id === trip?.id));
    b.addEventListener("click", () => openTrip(t.id));
    ul.append(el("li", {}, b));
  }
}

async function openTrip(id) {
  history.replaceState(null, "", id ? "#" + id : location.pathname);
  if (!id) { trip = null; renderList(); renderDetail(); return; }
  await run(async () => {
    const next = await api("GET", "trips/" + id);
    if (next.id !== trip?.id) { skip.clear(); picked.clear(); found = []; adding = null; }
    trip = next;
    renderList();
    renderDetail();
  });
}

// After any change: the trip as the site has it now, and its summary in the list.
function took(t) {
  trip = t;
  const s = data.trips.find(x => x.id === t.id);
  if (s) Object.assign(s, { title: t.title, start: t.start, end: t.end, people: t.members.length });
  renderList();
  renderDetail();
}

// ── the open trip ──────────────────────────────────────────────────────────

function renderDetail() {
  const box = $("#detail");
  box.replaceChildren();
  if (!trip) {
    box.append(el("p", { className: "empty", textContent: data.trips.length ? "Pick a trip." : "Start one with New trip: where you're going and when." }));
    return;
  }
  const card = el("article", { className: "card trip" });
  card.append(el("h2", { textContent: trip.title }), el("div", { className: "facts", textContent: span(trip) }));

  const people = el("div", { className: "people" });
  for (const m of trip.members) {
    const chip = el("span", { className: "chip" + (m.owner ? " owner" : ""), title: "@" + m.username }, m.id === trip.you ? `${m.name} (you)` : m.name);
    if (trip.owned && !m.owner) {
      const x = el("button", { type: "button", textContent: "×", title: `Take ${m.name} off the trip` });
      x.addEventListener("click", () => run(async () => took(await api("DELETE", `trips/${trip.id}/members/${m.id}`))));
      chip.append(x);
    }
    people.append(chip);
  }
  card.append(people);
  if (trip.owned) {
    const f = el("form", { className: "inline" });
    const who = el("input", { type: "text", placeholder: "Add someone by username", maxLength: 40, id: "who" });
    who.setAttribute("aria-label", "Username");
    f.append(who, el("button", { className: "btn quiet", textContent: "Add" }));
    f.addEventListener("submit", e => {
      e.preventDefault();
      if (!who.value.trim()) return;
      run(async () => { took(await api("POST", `trips/${trip.id}/members`, { username: who.value })); say("done", "They're on the trip."); });
    });
    card.append(f);
  }
  if (trip.notes) card.append(el("p", { className: "notes", textContent: trip.notes }));

  const tabs = el("div", { className: "tabs", role: "tablist" });
  for (const [id, label] of [["days", `Days (${trip.plans.length})`], ["places", `Places (${trip.places.length})`], ["packing", `Packing (${trip.packing.length})`]]) {
    const b = el("button", { type: "button", role: "tab", textContent: label });
    b.setAttribute("aria-selected", String(tab === id));
    b.addEventListener("click", () => { tab = id; store.set("trips:tab", id); renderDetail(); });
    tabs.append(b);
  }
  card.append(tabs);
  const pane = el("div", { role: "tabpanel" });
  card.append(pane);
  ({ days: renderDays, places: renderPlaces, packing: renderPacking })[tab](pane);

  const edit = el("button", { className: "btn quiet", type: "button", textContent: "Edit trip" });
  edit.addEventListener("click", () => openEditor(trip));
  const del = el("button", { className: "btn danger", type: "button", textContent: trip.owned ? "Delete trip" : "Leave trip" });
  del.addEventListener("click", () => {
    if (!confirm(trip.owned ? `Delete ${trip.title} for everyone on it?` : `Leave ${trip.title}?`)) return;
    run(async () => {
      await api("DELETE", "trips/" + trip.id);
      data.trips = data.trips.filter(x => x.id !== trip.id);
      await openTrip(data.trips[0]?.id || null);
    });
  });
  card.append(el("div", { className: "actions" }, edit, del));
  box.append(card);
  if (tab === "places") drawMap();
}

// ── days ───────────────────────────────────────────────────────────────────

function renderDays(pane) {
  const days = [...trip.days];
  const others = [...new Set(trip.plans.map(p => p.day).filter(d => d && !days.includes(d)))].sort();
  if (!trip.start) pane.append(el("p", { className: "empty", textContent: "Give the trip dates (Edit trip) to plan it day by day. Until then, stops go under Any day." }));
  for (const d of [...days, ...others, ""]) {
    const stops = trip.plans.filter(p => p.day === d);
    if (d && others.includes(d) && !stops.length) continue;
    const sec = el("section", { className: "day" + (adding === d ? " adding" : "") });
    const n = days.indexOf(d);
    sec.append(el("h3", { textContent: d ? `${n >= 0 ? `Day ${n + 1} · ` : ""}${niceDay(d)}${n < 0 ? " (outside the trip)" : ""}` : "Any day" }));
    const ul = el("ul", { className: "stops" });
    for (const p of stops) {
      const place = trip.places.findIndex(x => x.id === p.place);
      const what = el("span", { className: "what", textContent: p.title });
      if (place >= 0) what.append(el("small", { textContent: `📍 ${placeLabel(place)}. ${trip.places[place].place}` }));
      if (p.notes) what.append(el("small", { textContent: p.notes }));
      const x = el("button", { className: "x", type: "button", textContent: "×", title: "Remove this stop" });
      x.addEventListener("click", () => run(async () => took(await api("DELETE", `trips/${trip.id}/plans/${p.id}`))));
      ul.append(el("li", {}, el("span", { className: "when", textContent: p.time || "·" }), what, x));
    }
    if (!stops.length) ul.append(el("li", { className: "empty", textContent: "Nothing planned yet." }));
    sec.append(ul);

    const open = el("button", { className: "linkish", type: "button", textContent: "+ Add a stop" });
    open.addEventListener("click", () => { adding = d; renderDetail(); $(".day.adding input[type=text]")?.focus(); });
    const f = el("form", { className: "add-stop" });
    const time = el("input", { type: "time" });
    time.setAttribute("aria-label", "Time");
    const title = el("input", { type: "text", placeholder: "What's the plan", maxLength: 300, required: true });
    title.setAttribute("aria-label", "Stop");
    const where = el("select");
    where.setAttribute("aria-label", "Place");
    where.append(new Option("No place", ""), ...trip.places.map((p, i) => new Option(`${placeLabel(i)}. ${p.place}`, p.id)));
    f.append(time, title, where, el("button", { className: "btn", textContent: "Add" }));
    f.addEventListener("submit", e => {
      e.preventDefault();
      run(async () => {
        took(await api("POST", `trips/${trip.id}/plans`, { day: d, time: time.value, title: title.value, place: where.value }));
        $(".day.adding input[type=text]")?.focus();
      });
    });
    sec.append(adding === d ? f : open);
    pane.append(sec);
  }
}

// ── places ─────────────────────────────────────────────────────────────────

function renderPlaces(pane) {
  pane.append(el("div", { id: "map" }));
  const f = el("form", { className: "inline" });
  const q = el("input", { type: "search", id: "place-q", maxLength: 200,
    placeholder: data.search ? "Search for a place or an address" : "A place to pin (its name)" });
  q.setAttribute("aria-label", "Place");
  f.append(q, el("button", { className: "btn", textContent: data.search ? "Search" : "Pin" }));
  f.addEventListener("submit", e => {
    e.preventDefault();
    const text = q.value.trim();
    if (!text) return;
    run(async () => {
      if (!data.search) { took(await api("POST", `trips/${trip.id}/places`, { place: text })); return; }
      found = (await api("GET", "places?q=" + encodeURIComponent(text))).results || [];
      if (!found.length) say("error", "Nothing found by that name.");
      renderDetail();
      $("#place-q").value = text;
    });
  });
  pane.append(f);
  if (found.length) {
    const ul = el("ul", { className: "found" });
    for (const r of found) {
      const b = el("button", { type: "button" }, r.place, " ", el("small", { textContent: `${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}` }));
      b.addEventListener("click", () => run(async () => { found = []; took(await api("POST", `trips/${trip.id}/places`, r)); }));
      ul.append(el("li", {}, b));
    }
    pane.append(ul);
  }
  if (data.drift) {
    const row = el("div", { className: "inline" });
    const sel = el("select", { id: "from-drift" });
    sel.setAttribute("aria-label", "From your Drift map");
    sel.append(new Option(driftPlaces ? (driftPlaces.length ? "Pin one from your Drift map…" : "Nothing on your Drift map yet") : "From your Drift map…", ""));
    for (const it of driftPlaces || []) sel.append(new Option(`${it.title}${it.place ? " · " + it.place : ""} (${it.collection})`, it.id));
    sel.addEventListener("focus", () => { if (!driftPlaces) loadDriftPlaces(); }, { once: true });
    sel.addEventListener("change", () => {
      const it = driftPlaces?.find(x => x.id === sel.value);
      if (!it) return;
      run(async () => took(await api("POST", `trips/${trip.id}/places`, { place: it.place || it.title, lat: it.lat, lng: it.lng, note: it.place ? it.title : "", drift: it.id })));
    });
    row.append(sel);
    pane.append(row);
  }
  const ul = el("ul", { className: "places" });
  trip.places.forEach((p, i) => {
    const what = el("span", { className: "what" }, el("strong", { textContent: `${placeLabel(i)}. ` }), p.place);
    if (p.note) what.append(el("small", { textContent: p.note }));
    const where = p.lat != null ? el("a", { href: osm(p), target: "_blank", rel: "noopener noreferrer", textContent: "map" }) : el("small", { textContent: "not on the map" });
    const x = el("button", { className: "x", type: "button", textContent: "×", title: "Unpin" });
    x.addEventListener("click", () => run(async () => took(await api("DELETE", `trips/${trip.id}/places/${p.id}`))));
    ul.append(el("li", {}, what, where, x));
  });
  if (!trip.places.length) ul.append(el("li", { className: "empty", textContent: "No places pinned yet." }));
  pane.append(ul);
}

async function loadDriftPlaces() {
  await run(async () => {
    driftPlaces = (await api("GET", "drift-places")).items;
    if (tab === "places") { renderDetail(); $("#from-drift")?.focus(); }
  });
}

// Leaflet comes from Drift (public/todo/vendor/leaflet/), so the map is there
// for anyone with Drift; without it, the places are a list.
let leaflet = null, map = null;
function loadLeaflet() {
  return leaflet ||= new Promise((resolve, reject) => {
    if (window.L) return resolve(window.L);
    const css = el("link", { rel: "stylesheet", href: "/todo/vendor/leaflet/leaflet.css" });
    const js = el("script", { src: "/todo/vendor/leaflet/leaflet.js" });
    js.onload = () => resolve(window.L);
    js.onerror = () => { leaflet = null; reject(new Error("the map didn't load")); };
    document.head.append(css, js);
  });
}

async function drawMap() {
  const box = $("#map");
  const spots = trip.places.map((p, i) => ({ ...p, n: i })).filter(p => p.lat != null);
  if (!data.drift || !spots.length) { box.hidden = true; return; }
  let L;
  try { L = await loadLeaflet(); } catch { box.hidden = true; return; }
  if (!box.isConnected) return;
  map?.remove();
  map = L.map(box, { zoomControl: true, worldCopyJump: true });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  spots.forEach(p => L.marker([p.lat, p.lng], {
    title: p.place, icon: L.divIcon({ className: "", html: `<span class="pin">${placeLabel(p.n)}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
  }).addTo(map));
  if (spots.length === 1) map.setView([spots[0].lat, spots[0].lng], 14);
  else map.fitBounds(L.latLngBounds(spots.map(p => [p.lat, p.lng])), { padding: [30, 30], maxZoom: 15 });
}

// ── packing ────────────────────────────────────────────────────────────────

function renderPacking(pane) {
  const f = el("form", { className: "inline" });
  const text = el("input", { type: "text", id: "pack-text", placeholder: "Something to pack", maxLength: 200 });
  text.setAttribute("aria-label", "Something to pack");
  f.append(text, el("button", { className: "btn", textContent: "Add" }));
  f.addEventListener("submit", e => {
    e.preventDefault();
    if (!text.value.trim()) return;
    run(async () => { took(await api("POST", `trips/${trip.id}/packing`, { text: text.value })); $("#pack-text").focus(); });
  });
  pane.append(f);

  const ul = el("ul", { className: "packing" });
  for (const p of trip.packing) {
    const box = el("input", { type: "checkbox", checked: sendable(p) });
    box.setAttribute("aria-label", `Send ${p.text} to Drift`);
    box.addEventListener("change", () => {
      skip.delete(p.id); picked.delete(p.id);
      const wanted = !p.in_drift && (!p.who || p.who === trip.you);
      if (box.checked !== wanted) (box.checked ? picked : skip).add(p.id);
      renderDetail();
    });
    const who = el("select");
    who.setAttribute("aria-label", "Who's bringing it");
    who.append(new Option("Anyone", ""), ...trip.members.map(m => new Option(m.id === trip.you ? "Me" : m.name, m.id)));
    who.value = p.who;
    who.addEventListener("change", () => run(async () => took(await api("PATCH", `trips/${trip.id}/packing/${p.id}`, { who: who.value }))));
    const x = el("button", { className: "x", type: "button", textContent: "×", title: "Remove" });
    x.addEventListener("click", () => run(async () => took(await api("DELETE", `trips/${trip.id}/packing/${p.id}`))));
    ul.append(el("li", {}, box, el("span", { className: "what", textContent: p.text }),
      p.in_drift ? el("span", { className: "sent", textContent: "✓ in your Drift" }) : null, who, x));
  }
  if (!trip.packing.length) ul.append(el("li", { className: "empty", textContent: "Nothing on the list yet." }));
  pane.append(ul);

  if (!trip.packing.length) return;
  const send = el("div", { className: "send" });
  if (!data.drift) {
    send.append(el("p", { className: "empty", textContent: "Ask the site's admin for Drift to send this to a checklist." }));
  } else {
    const n = trip.packing.filter(sendable).length;
    const name = `Packing: ${trip.title}`.slice(0, 100);
    const mine = data.lists.find(l => !l.owner_name && l.name.toLowerCase() === name.toLowerCase());
    const sel = el("select", { id: "list" });
    sel.setAttribute("aria-label", "Drift list");
    sel.append(new Option(mine ? name : `${name} (new)`, ""));
    for (const l of data.lists) if (l !== mine) sel.append(new Option(l.owner_name ? `${l.name} (${l.owner_name}'s)` : l.name, l.id));
    const go = el("button", { className: "btn", type: "button", id: "send", textContent: `Send ${n} to`, disabled: !n });
    go.addEventListener("click", () => sendPacking(sel.value));
    send.append(go, sel);
  }
  pane.append(send);
}

async function sendPacking(list) {
  const ids = trip.packing.filter(sendable).map(p => p.id);
  await run(async () => {
    const out = await api("POST", `trips/${trip.id}/pack`, { ids, ...(list ? { list } : {}) });
    skip.clear(); picked.clear();
    if (!data.lists.some(l => l.id === out.list.id)) data.lists.unshift({ id: out.list.id, name: out.list.name, owner_name: null });
    took(out.trip);
    say("done", `Added ${out.added} to ${out.list.name} in Drift.`);
  });
}

// ── making and editing trips ───────────────────────────────────────────────

function openEditor(t) {
  editing = t || {};
  const f = $("#edit-form");
  $("#edit-title").textContent = t ? "Edit trip" : "New trip";
  f.title.value = t?.title || "";
  f.start.value = t?.start || "";
  f.end.value = t?.end || "";
  f.notes.value = t?.notes || "";
  $("#editor").showModal();
  f.title.focus();
}

$("#editor").addEventListener("close", () => {
  if ($("#editor").returnValue !== "save" || !editing) return;
  const f = $("#edit-form");
  const body = { title: f.title.value, start: f.start.value, end: f.end.value || f.start.value, notes: f.notes.value };
  const was = editing;
  editing = null;
  run(async () => {
    const t = was.id ? await api("PATCH", "trips/" + was.id, body) : await api("POST", "trips", body);
    data = await api("GET", "trips");
    history.replaceState(null, "", "#" + t.id);
    if (!was.id) tab = "days";
    took(t);
  });
});

$("#new").addEventListener("click", () => openEditor(null));

document.addEventListener("keydown", e => {
  const t = e.target;
  if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || t.matches?.("input, textarea, select") || $("#editor").open) return;
  const ids = data?.trips.map(x => x.id) || [], here = ids.indexOf(trip?.id);
  const show = id => () => { if (trip) { tab = id; store.set("trips:tab", id); renderDetail(); } };
  const keys = {
    n: () => openEditor(null),
    j: () => ids.length && openTrip(ids[Math.min(ids.length - 1, here + 1)]),
    k: () => ids.length && openTrip(ids[Math.max(0, here - 1)]),
    1: show("days"), 2: show("places"), 3: show("packing"),
    e: () => trip && openEditor(trip),
    a: () => {
      if (!trip) return;
      if (tab === "days") { adding = trip.days[0] ?? ""; renderDetail(); $(".day.adding input[type=text]")?.focus(); }
      else $(tab === "places" ? "#place-q" : "#pack-text")?.focus();
    },
    s: () => { if (trip) { if (tab !== "packing") show("packing")(); $("#send") && !$("#send").disabled && $("#send").click(); } },
  };
  if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
});

// Someone else on the trip may have changed it while you were away.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && trip && !$("#editor").open) openTrip(trip.id);
});

run(async () => {
  tab = ["days", "places", "packing"].includes(store.get("trips:tab")) ? store.get("trips:tab") : "days";
  data = await api("GET", "trips");
  const want = location.hash.slice(1);
  await openTrip(data.trips.some(t => t.id === want) ? want : data.trips[0]?.id || null);
});
