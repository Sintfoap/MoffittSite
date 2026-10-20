// Trip planner: a trip planned together, with a day-by-day itinerary, places
// pinned to it (searched for, or brought in from your Drift map), and a
// packing list each person can send to a Drift checklist.
//
// Whoever makes a trip owns it and picks who else is going; everyone on it
// can change everything in it. Only the owner can delete it or change who's
// on it, and anyone else can leave.
//
// /trips/api/trips                         GET → {trips, drift, search}; POST {title, start, end, notes} → a new trip
// /trips/api/trips/<id>                    GET → the whole trip; PATCH → change the fields sent; DELETE → delete it (or leave it)
// /trips/api/trips/<id>/members            POST {username} → the trip, with them on it
// /trips/api/trips/<id>/members/<user>     DELETE → the trip, without them
// /trips/api/trips/<id>/<plans|places|packing>        POST → the trip, with a new stop, place or thing to pack
// /trips/api/trips/<id>/<plans|places|packing>/<e>    PATCH → the trip, changed; DELETE → the trip, without it
// /trips/api/trips/<id>/pack               POST {ids?, list?} → {list, added, trip}: packing onto a Drift checklist
// /trips/api/places?q=…                    GET → {results: [{place, lat, lng}]} (null when search is off)
// /trips/api/drift-places                  GET → {items}: your Drift items that are on the map

import { db } from "./db.js";
import { sameOrigin } from "./account.js";
import { withRail } from "./pages.js";
import { readJson, BadRequest, writableCollections, addToList, placedItems } from "./drift.js";
import { hasPlaces, searchPlaces } from "./places.js";

const fail = msg => { throw new BadRequest(msg); };

const LIMITS = { trips: 100, entries: 600, members: 20, days: 60, title: 200, notes: 5000, stop: 300, place: 200, note: 1000, pack: 200 };
const DAY = /^\d{4}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ROUTE = /^\/trips\/api\/trips(?:\/(t_[0-9a-f]{10})(?:\/(members|plans|places|packing|pack)(?:\/([A-Za-z0-9_-]{1,40}))?)?)?\/?$/;
const KIND = { plans: "plan", places: "place", packing: "pack" };
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const nowStamp = () => new Date().toISOString().slice(0, 19);

function newId(prefix) {
  const b = crypto.getRandomValues(new Uint8Array(5));
  return prefix + "_" + [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

// ── cleaning ───────────────────────────────────────────────────────────────

function str(f, v, max) {
  const s = String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (s.length > max) fail(`${f} is longer than ${max} characters`);
  return s;
}

function day(f, v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (!DAY.test(s) || new Date(s + "T00:00:00Z").toISOString().slice(0, 10) !== s) fail(`${f} must be a date like 2026-07-04`);
  return s;
}

// Days from start to end, both included.
export function daysOf(start, end) {
  if (!start) return [];
  const out = [], last = end || start;
  for (let t = Date.parse(start + "T00:00:00Z"); out.length <= LIMITS.days; t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (d > last) break;
    out.push(d);
  }
  return out;
}

function cleanTrip(changes, before = {}) {
  if (!isObj(changes)) fail("body must be a JSON object");
  const out = {};
  for (const [f, v] of Object.entries(changes)) {
    switch (f) {
      case "title": out.title = str(f, v, LIMITS.title); if (!out.title) fail("a trip needs a name"); break;
      case "start": out.start = day(f, v); break;
      case "end": out.end = day(f, v); break;
      case "notes": out.notes = str(f, v, LIMITS.notes); break;
      default: fail(`unknown field ${JSON.stringify(f)}`);
    }
  }
  const start = out.start ?? before.start ?? "", end = out.end ?? before.end ?? "";
  if (end && !start) fail("a trip with an end date needs a start date too");
  if (start && end && end < start) fail("the trip ends before it starts");
  if (start && daysOf(start, end).length > LIMITS.days) fail(`a trip can be at most ${LIMITS.days} days`);
  return out;
}

function coord(f, v, max) {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > max) fail(`${f} must be a number from -${max} to ${max}`);
  return Math.round(n * 1e6) / 1e6;
}

// An entry's fields, by kind. `members` are the ids a packing item can be for.
function cleanEntry(kind, changes, members) {
  if (!isObj(changes)) fail("body must be a JSON object");
  const out = {};
  for (const [f, v] of Object.entries(changes)) {
    if (kind === "plan" && f === "day") out.day = day(f, v);
    else if (kind === "plan" && f === "time") {
      out.time = String(v ?? "").trim();
      if (out.time && !TIME.test(out.time)) fail("time must be like 09:30");
    } else if (kind === "plan" && f === "title") out.title = str(f, v, LIMITS.stop);
    else if (kind === "plan" && f === "place") out.place = str(f, v, 40);
    else if (kind === "plan" && f === "notes") out.notes = str(f, v, LIMITS.note);
    else if (kind === "place" && f === "place") out.place = str(f, v, LIMITS.place);
    else if (kind === "place" && f === "lat") out.lat = coord(f, v, 90);
    else if (kind === "place" && f === "lng") out.lng = coord(f, v, 180);
    else if (kind === "place" && f === "note") out.note = str(f, v, LIMITS.note);
    else if (kind === "place" && f === "drift") out.drift = str(f, v, 40);
    else if (kind === "pack" && f === "text") out.text = str(f, v, LIMITS.pack);
    else if (kind === "pack" && f === "who") {
      out.who = String(v ?? "");
      if (out.who && !members.includes(out.who)) fail("that person isn't on this trip");
    } else fail(`unknown field ${JSON.stringify(f)}`);
  }
  if ("lat" in out !== "lng" in out) fail("send lat and lng together");
  if ((out.lat == null) !== (out.lng == null)) fail("a place needs both lat and lng, or neither");
  return out;
}

const BLANK = {
  plan: { day: "", time: "", title: "", place: "", notes: "" },
  place: { place: "", lat: null, lng: null, note: "", drift: "" },
  pack: { text: "", who: "", sent: [] },
};
const NEEDS = { plan: ["title", "a stop needs a name"], place: ["place", "a place needs a name"], pack: ["text", "say what to pack"] };

// ── access ─────────────────────────────────────────────────────────────────

const TRIP = { title: "", start: "", end: "", notes: "", created: "" };

// The trip, if you're on it: {row, data, owner (bool)}.
async function access(d, user, id) {
  const row = await d.prepare(`SELECT t.* FROM trips t WHERE t.id = ? AND (t.owner = ? OR EXISTS
    (SELECT 1 FROM trip_members m WHERE m.trip = t.id AND m.user_id = ?))`).bind(id, user.id, user.id).first();
  return row ? { row, data: { ...TRIP, ...JSON.parse(row.data) }, owner: row.owner === user.id } : null;
}

async function people(d, trip) {
  const { results } = await d.prepare(`SELECT u.id, u.username, u.display_name, (u.id = t.owner) AS owner FROM trips t
    JOIN users u ON u.id = t.owner OR u.id IN (SELECT user_id FROM trip_members WHERE trip = t.id)
    WHERE t.id = ? ORDER BY owner DESC, u.username`).bind(trip).all();
  return results.map(r => ({ id: r.id, username: r.username, name: r.display_name || r.username, owner: !!r.owner }));
}

const touch = (d, id) => d.prepare("UPDATE trips SET updated = ? WHERE id = ?").bind(new Date().toISOString(), id).run();

// ── reading ────────────────────────────────────────────────────────────────

const byPlan = (a, b) => (a.day || "9999").localeCompare(b.day || "9999") || (a.time || "99").localeCompare(b.time || "99") || a.created.localeCompare(b.created);

// The whole trip, as everyone on it sees it.
export async function getTrip(env, user, id) {
  const d = await db(env);
  const acc = await access(d, user, id);
  if (!acc) return null;
  const { results } = await d.prepare("SELECT id, kind, data, created FROM trip_entries WHERE trip = ?").bind(id).all();
  const of = kind => results.filter(r => r.kind === kind).map(r => ({ ...BLANK[kind], ...JSON.parse(r.data), id: r.id, created: r.created }));
  const pack = of("pack").sort((a, b) => a.created.localeCompare(b.created))
    .map(({ sent, ...p }) => ({ ...p, in_drift: sent.includes(user.id) }));
  return {
    id, ...acc.data, updated: acc.row.updated, owned: acc.owner, you: user.id,
    days: daysOf(acc.data.start, acc.data.end), members: await people(d, id),
    plans: of("plan").sort(byPlan), places: of("place").sort((a, b) => a.created.localeCompare(b.created)), packing: pack,
  };
}

// Your trips, soonest first (ones without dates last): summaries for the list.
export async function listTrips(env, user) {
  const d = await db(env);
  const { results } = await d.prepare(`SELECT t.id, t.owner, t.data, t.updated, u.username, u.display_name,
      (SELECT COUNT(*) FROM trip_members m WHERE m.trip = t.id) AS going
    FROM trips t JOIN users u ON u.id = t.owner
    WHERE t.owner = ? OR t.id IN (SELECT trip FROM trip_members WHERE user_id = ?)`).bind(user.id, user.id).all();
  return results.map(r => {
    const t = { ...TRIP, ...JSON.parse(r.data) };
    return { id: r.id, title: t.title, start: t.start, end: t.end, owned: r.owner === user.id,
      owner_name: r.display_name || r.username, people: r.going + 1, updated: r.updated };
  }).sort((a, b) => (a.start || "9999").localeCompare(b.start || "9999") || a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
}

// ── changing ───────────────────────────────────────────────────────────────

export async function createTrip(env, user, fields) {
  const d = await db(env);
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM trips WHERE owner = ?").bind(user.id).first();
  if (n >= LIMITS.trips) fail(`trip limit reached (${LIMITS.trips})`);
  const data = cleanTrip(fields);
  if (!data.title) fail("a trip needs a name");
  const id = newId("t");
  await d.prepare("INSERT INTO trips (id, owner, data, updated) VALUES (?, ?, ?, ?)")
    .bind(id, user.id, JSON.stringify({ ...TRIP, ...data, created: nowStamp() }), new Date().toISOString()).run();
  return getTrip(env, user, id);
}

export async function updateTrip(env, user, id, changes) {
  const d = await db(env);
  const acc = await access(d, user, id);
  if (!acc) return null;
  const patch = cleanTrip(changes, acc.data);
  await d.prepare("UPDATE trips SET data = json_patch(data, ?), updated = ? WHERE id = ?")
    .bind(JSON.stringify(patch), new Date().toISOString(), id).run();
  return getTrip(env, user, id);
}

// The owner deletes the trip; anyone else leaves it.
export async function deleteTrip(env, user, id) {
  const d = await db(env);
  const acc = await access(d, user, id);
  if (!acc) return null;
  if (!acc.owner) {
    await d.prepare("DELETE FROM trip_members WHERE trip = ? AND user_id = ?").bind(id, user.id).run();
    return { left: true };
  }
  await d.batch(["trip_entries", "trip_members"].map(t => d.prepare(`DELETE FROM ${t} WHERE trip = ?`).bind(id))
    .concat(d.prepare("DELETE FROM trips WHERE id = ?").bind(id)));
  return { removed: true };
}

export async function addMember(env, user, id, body) {
  const d = await db(env);
  const acc = await access(d, user, id);
  if (!acc) return null;
  if (!acc.owner) fail("only the person who made the trip can change who's on it");
  const username = String(body?.username ?? "").trim().replace(/^@/, "").toLowerCase();
  const who = username && await d.prepare(`SELECT u.id FROM users u JOIN user_areas a ON a.user_id = u.id AND a.area = 'trips'
    WHERE u.username = ? AND u.disabled = 0`).bind(username).first();
  if (!who) fail("there's no one with Trip planner by that username");
  if (who.id === user.id) fail("that's you");
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM trip_members WHERE trip = ?").bind(id).first();
  if (n >= LIMITS.members) fail(`a trip can have at most ${LIMITS.members} people besides you`);
  await d.prepare("INSERT OR IGNORE INTO trip_members (trip, user_id, added_at) VALUES (?, ?, ?)").bind(id, who.id, Date.now()).run();
  await touch(d, id);
  return getTrip(env, user, id);
}

export async function removeMember(env, user, id, who) {
  const d = await db(env);
  const acc = await access(d, user, id);
  if (!acc) return null;
  if (!acc.owner && who !== user.id) fail("only the person who made the trip can change who's on it");
  if (who === acc.row.owner) fail("the person who made the trip can't be taken off it");
  const res = await d.prepare("DELETE FROM trip_members WHERE trip = ? AND user_id = ?").bind(id, who).run();
  if (!res.meta.changes) return null;
  // What they were bringing goes back to everyone.
  await d.prepare(`UPDATE trip_entries SET data = json_set(data, '$.who', '') WHERE trip = ? AND kind = 'pack' AND json_extract(data, '$.who') = ?`)
    .bind(id, who).run();
  await touch(d, id);
  return who === user.id ? { left: true } : getTrip(env, user, id);
}

export async function addEntry(env, user, id, kind, fields) {
  const d = await db(env);
  const acc = await access(d, user, id);
  if (!acc) return null;
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM trip_entries WHERE trip = ?").bind(id).first();
  if (n >= LIMITS.entries) fail(`a trip can hold at most ${LIMITS.entries} stops, places and things to pack`);
  const data = { ...BLANK[kind], ...cleanEntry(kind, fields, (await people(d, id)).map(p => p.id)), by: user.id };
  const [field, why] = NEEDS[kind];
  if (!data[field]) fail(why);
  await d.prepare("INSERT INTO trip_entries (trip, id, kind, data, created) VALUES (?, ?, ?, ?, ?)")
    .bind(id, newId("e"), kind, JSON.stringify(data), new Date().toISOString()).run();
  await touch(d, id);
  return getTrip(env, user, id);
}

export async function updateEntry(env, user, id, kind, entry, changes) {
  const d = await db(env);
  const acc = await access(d, user, id);
  if (!acc) return null;
  const patch = cleanEntry(kind, changes, (await people(d, id)).map(p => p.id));
  const [field, why] = NEEDS[kind];
  if (field in patch && !patch[field]) fail(why);
  const res = await d.prepare("UPDATE trip_entries SET data = json_patch(data, ?) WHERE trip = ? AND id = ? AND kind = ?")
    .bind(JSON.stringify(patch), id, entry, kind).run();
  if (!res.meta.changes) return null;
  await touch(d, id);
  return getTrip(env, user, id);
}

export async function removeEntry(env, user, id, kind, entry) {
  const d = await db(env);
  const acc = await access(d, user, id);
  if (!acc) return null;
  const res = await d.prepare("DELETE FROM trip_entries WHERE trip = ? AND id = ? AND kind = ?").bind(id, entry, kind).run();
  if (!res.meta.changes) return null;
  // Stops at a place that's gone just lose the place.
  if (kind === "place") {
    await d.prepare(`UPDATE trip_entries SET data = json_set(data, '$.place', '') WHERE trip = ? AND kind = 'plan' AND json_extract(data, '$.place') = ?`)
      .bind(id, entry).run();
  }
  await touch(d, id);
  return getTrip(env, user, id);
}

export const packingName = title => `Packing: ${title}`.slice(0, 100);

// The packing list onto your own Drift checklist ("Packing: <trip>", made the
// first time), or any list you can add to. `ids` picks which; without it,
// what's for you or for anyone that you haven't sent yet.
export async function pack(env, user, id, body) {
  if (!user.areas.has("todo")) fail("you need Drift to make a packing checklist");
  if (!isObj(body)) fail("body must be a JSON object");
  const d = await db(env);
  const trip = await getTrip(env, user, id);
  if (!trip) return null;
  const pick = Array.isArray(body.ids) ? new Set(body.ids.map(String)) : null;
  const items = trip.packing.filter(p => pick ? pick.has(p.id) : !p.in_drift && (!p.who || p.who === user.id));
  if (!items.length) fail(pick ? "pick at least one thing to pack" : "everything for you is in Drift already");
  const out = await addToList(env, user, body.list ? String(body.list) : null, items.map(p => p.text), `For ${trip.title}`, packingName(trip.title));
  await d.batch(items.map(p => d.prepare(`UPDATE trip_entries SET data = json_set(data, '$.sent',
      json_insert(COALESCE(json_extract(data, '$.sent'), json('[]')), '$[#]', ?)) WHERE trip = ? AND id = ?`).bind(user.id, id, p.id)));
  return { ...out, trip: await getTrip(env, user, id) };
}

// ── the page and its API ───────────────────────────────────────────────────

// Map tiles come from OpenStreetMap, and the map itself from Drift's copy of Leaflet.
const PAGE_CSP = [
  "default-src 'none'", "script-src 'self'", "connect-src 'self'", "manifest-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com", "img-src 'self' data: https://tile.openstreetmap.org",
  "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function trips(request, env, user, pathname) {
  if (!pathname.startsWith("/trips/api/")) {
    const asset = await withRail(await env.ASSETS.fetch(request), user, "trips");
    const res = new Response(asset.body, asset);
    if ((res.headers.get("Content-Type") || "").startsWith("text/html")) {
      res.headers.set("Content-Security-Policy", PAGE_CSP);
      res.headers.set("X-Content-Type-Options", "nosniff");
      res.headers.set("Referrer-Policy", "no-referrer");
    }
    return res;
  }
  const method = request.method;
  try {
    if (method !== "GET" && !sameOrigin(request)) return json({ error: "cross-origin request refused" }, 403);
    if (pathname === "/trips/api/places") {
      if (method !== "GET") return json({ error: "method not allowed" }, 405);
      return json({ results: await searchPlaces(env, new URL(request.url).searchParams.get("q")) });
    }
    if (pathname === "/trips/api/drift-places") {
      if (method !== "GET") return json({ error: "method not allowed" }, 405);
      return json({ items: user.areas.has("todo") ? await placedItems(env, user) : [] });
    }
    const m = pathname.match(ROUTE);
    if (!m) return json({ error: "not found" }, 404);
    const [, id, sub, entry] = m;
    const notAllowed = () => json({ error: "method not allowed" }, 405);
    if (!id) {
      if (method === "GET") {
        const drift = user.areas.has("todo");
        return json({ trips: await listTrips(env, user), drift, search: hasPlaces(env), lists: drift ? await writableCollections(env, user) : [] });
      }
      if (method !== "POST") return notAllowed();
      return json(await createTrip(env, user, await readJson(request)), 201);
    }
    let out;
    if (!sub) {
      if (method === "GET") out = await getTrip(env, user, id);
      else if (method === "PATCH") out = await updateTrip(env, user, id, await readJson(request));
      else if (method === "DELETE") out = await deleteTrip(env, user, id);
    } else if (sub === "members") {
      if (!entry && method === "POST") out = await addMember(env, user, id, await readJson(request));
      else if (entry && method === "DELETE") out = await removeMember(env, user, id, entry);
    } else if (sub === "pack") {
      if (!entry && method === "POST") out = await pack(env, user, id, await readJson(request));
    } else {
      const kind = KIND[sub];
      if (!entry && method === "POST") out = await addEntry(env, user, id, kind, await readJson(request));
      else if (entry && method === "PATCH") out = await updateEntry(env, user, id, kind, entry, await readJson(request));
      else if (entry && method === "DELETE") out = await removeEntry(env, user, id, kind, entry);
    }
    if (out === undefined) return notAllowed();
    return out ? json(out) : json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    console.error("trips error:", e);
    return json({ error: "server error" }, 500);
  }
}
