// Route planning for Drift's Map view: the order to visit a day's places in,
// from the day's base and back, by road (or on foot, or by bike) through
// OpenRouteService. The ordering rules live in public/todo/route.js; this
// asks ORS how long each trip takes and which streets it follows.
//
// Without an ORS key, or when ORS doesn't answer, travel is estimated from
// the straight-line distance (`estimated: true`), and the route is drawn in
// straight lines unless ORS sent the streets (`streets: true`).

import { hasPlaces, post } from "./places.js";
import { collectionWithItems } from "./drift.js";
import { dayStops, distance } from "../public/todo/plugins/location.js";
import { edges } from "../public/todo/plugins/graph.js";
import { baseFor, planRoutes, PROFILES } from "../public/todo/route.js";
import { timeOf, dayOf } from "../public/todo/lib.js";

const MAX_STOPS = 40;             // ORS takes up to 50 points on a route
// Rough speeds for estimates, in metres a second, with straight lines made a bit longer.
const SPEED = { "driving-car": 11, "foot-walking": 1.35, "cycling-regular": 4.2 }, WIGGLE = 1.3;
const ll = p => [p.lng, p.lat];

// Asks ORS once for a given body, and keeps the answer for a day.
async function cached(env, path, body) {
  const cache = globalThis.caches?.default;
  const key = cache && new Request("https://ors.cache" + path + "?" + await digest(JSON.stringify(body)));
  const hit = key && await cache.match(key).catch(() => null);
  if (hit) return hit.json();
  const out = await post(env, path, body);
  if (out && key) await cache.put(key, new Response(JSON.stringify(out), { headers: { "Cache-Control": "max-age=86400" } })).catch(() => {});
  return out;
}
async function digest(s) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function estimate(points, profile) {
  const dist = points.map(a => points.map(b => distance(a, b) * WIGGLE));
  return { dur: dist.map(r => r.map(m => m / SPEED[profile])), dist };
}

// The time an event has on day `d`, "" when it's all day or carried over from another day.
const timeOn = (s, d) => dayOf(s) === d ? timeOf(s) : "";

// The plan for collection `id` on `day`:
//   { day, profile, base, stops: [{id, title, start, place}], unplaced, elsewhere,
//     options: [{order, duration, distance, late}], option, legs: [{duration, distance}],
//     path: [[lat, lng]…], streets, estimated, loose, off }
// `option` picks which of the options to follow the streets of. null when
// you can't see the collection.
export async function planDay(env, user, id, day, profile = "driving-car", option = 0) {
  const got = await collectionWithItems(env, user, id);
  if (!got) return null;
  if (!PROFILES[profile]) profile = "driving-car";
  const plan = dayStops(got.items, day);
  const stops = plan.stops.slice(0, MAX_STOPS).map(s => s.item);
  const base = baseFor(got.collection.bases, day);
  const points = [...(base?.lat != null ? [base] : []), ...stops.map(it => it.meta.location)];
  const out = {
    day, profile, base: base || null, off: !hasPlaces(env), estimated: !hasPlaces(env), streets: false, loose: false, option: 0, options: [], legs: [], path: [],
    stops: stops.map(it => ({ id: it.id, title: it.title, start: timeOn(it.meta.event.start, day), end: timeOn(it.meta.event.end, day), place: it.meta.location.place })),
    unplaced: plan.unplaced.map(it => it.id), elsewhere: plan.elsewhere.map(it => it.id),
  };
  if (!stops.length) return out;
  const withBase = base?.lat != null;

  let m = hasPlaces(env) && points.length > 1 && await cached(env, `/v2/matrix/${profile}`, { locations: points.map(ll), metrics: ["duration", "distance"] });
  // A place ORS can't reach by this profile comes back as null: count it as far.
  const fill = (rows, far) => rows?.map((r, i) => r.map((x, j) => x ?? (i === j ? 0 : far)));
  let dur = fill(m?.durations, 1e7), dist = fill(m?.distances, 1e8);
  if (!dur) { ({ dur, dist } = estimate(points, profile)); out.estimated = true; }
  dist ||= estimate(points, profile).dist;

  const { options, loose } = planRoutes(out.stops, edges(stops), dur, { base: withBase, dist });
  out.options = options; out.loose = loose;
  out.option = ((+option || 0) % options.length + options.length) % options.length;
  const pick = options[out.option], at = new Map(stops.map((it, i) => [it.id, i + (withBase ? 1 : 0)]));
  const path = [...(withBase ? [0] : []), ...pick.order.map(i => at.get(i)), ...(withBase ? [0] : [])];
  if (path.length < 2) return out;

  // The streets, for the chosen order. Asked even when the times had to be
  // estimated. A stop at the same spot as the one before (often the base) is
  // left out of the request, since ORS doesn't count a leg of no length, and
  // each point may be snapped to the nearest road however far it is.
  const legsOf = idx => idx.slice(1).map((j, x) => ({ duration: Math.round(dur[idx[x]][j]), distance: Math.round(dist[idx[x]][j]) }));
  out.legs = legsOf(path);
  out.path = path.map(i => [points[i].lat, points[i].lng]);
  out.streets = false;
  const same = (a, b) => points[a].lat === points[b].lat && points[a].lng === points[b].lng;
  const asked = path.filter((i, x) => !x || !same(i, path[x - 1]));
  const r = hasPlaces(env) && asked.length > 1 && await cached(env, `/v2/directions/${profile}/geojson`,
    { coordinates: asked.map(i => ll(points[i])), radiuses: asked.map(() => -1), instructions: false });
  const f = r?.features?.[0];
  if (f?.geometry?.coordinates?.length > 1) {
    out.path = f.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    out.streets = true;
    // ORS's own times for each leg, when it sent one for every leg asked; a
    // leg of no length (dropped above) takes no time.
    const segs = f.properties?.segments || [];
    if (segs.length === asked.length - 1) {
      let k = 0;
      out.legs = path.slice(1).map((j, x) => same(j, path[x]) ? { duration: 0, distance: 0 }
        : (s => ({ duration: Math.round(s.duration), distance: Math.round(s.distance) }))(segs[k++]));
    }
  }
  return out;
}
