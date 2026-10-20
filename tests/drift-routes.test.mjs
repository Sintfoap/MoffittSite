// Tests for Drift's bases and route planning (public/todo/route.js,
// src/routing.js): which base a day starts from, the orders a day's places can
// be visited in, and the route the site asks OpenRouteService for.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv } from "./helpers.mjs";
import { baseFor, cleanBases, planRoutes, niceDuration } from "../public/todo/route.js";
import location from "../public/todo/plugins/location.js";

const fail = msg => { throw new Error(msg); };
const HOME = { place: "Home", lat: 51.5, lng: -0.1, from: null, to: null };

test("a day's base is the one that covers it most closely, then home", () => {
  const trip = { place: "Hotel", lat: 48.85, lng: 2.35, from: "2026-10-01", to: "2026-10-07" };
  const night = { place: "Friend's", lat: 48.9, lng: 2.3, from: "2026-10-03", to: "2026-10-03" };
  const bases = [HOME, trip, night];
  assert.equal(baseFor(bases, "2026-09-30"), HOME);
  assert.equal(baseFor(bases, "2026-10-01"), trip);
  assert.equal(baseFor(bases, "2026-10-03"), night);
  assert.equal(baseFor(bases, "2026-10-07"), trip);
  assert.equal(baseFor([trip], "2026-10-08"), null);
  assert.equal(baseFor(undefined, "2026-10-08"), null);

  const clean = v => cleanBases(v, fail, location.clean);
  assert.deepEqual(clean([{ place: " Home ", lat: 1, lng: 2 }, { place: "Hotel", from: "2026-10-01" }, { place: "New home" }]),
    [{ place: "Hotel", lat: null, lng: null, from: "2026-10-01", to: "2026-10-01" }, { place: "New home", lat: null, lng: null, from: null, to: null }],
    "one day when there's no end; only the last home is kept");
  for (const bad of [{}, [{}], [{ place: "x", from: "2026-10-02", to: "2026-10-01" }], [{ place: "x", to: "2026-10-01" }], [{ place: "x", from: "tomorrow" }]])
    assert.throws(() => clean(bad), Error, JSON.stringify(bad));
});

// Travel between points laid out on a line: seconds = distance between positions × 60.
const line = pos => pos.map(a => pos.map(b => Math.abs(a - b) * 60));
const plane = pos => pos.map(([x, y]) => pos.map(([u, v]) => Math.hypot(x - u, y - v) * 60));

test("routes keep to the times, then the links, then the shortest travel", () => {
  // The base at 0,0; breakfast (9:00) at 1,0 and dinner (19:00) at 10,1 and
  // two untimed stops: the museum at 10,0, the park at 11,0.
  const stops = [{ id: "breakfast", start: "09:00", end: "" }, { id: "dinner", start: "19:00", end: "" },
    { id: "museum", start: "", end: "" }, { id: "park", start: "", end: "" }];
  const dur = plane([[0, 0], [1, 0], [10, 1], [10, 0], [11, 0]]);
  const { options, loose } = planRoutes(stops, [], dur, { base: true });
  assert.equal(loose, false);
  for (const o of options) assert.ok(o.order.indexOf("breakfast") < o.order.indexOf("dinner"), o.order.join());
  assert.deepEqual(options[0].order, ["breakfast", "museum", "park", "dinner"]);
  assert.equal(options[0].duration, Math.round((1 + 9 + 1 + Math.SQRT2 + Math.hypot(10, 1)) * 60));
  assert.ok(options.length > 1 && options.every((o, i) => !i || o.duration >= options[i - 1].duration));

  // A plain link keeps two stops together, either way round.
  const together = planRoutes(stops, [{ a: "museum", b: "breakfast", type: "" }], dur, { base: true, k: 10 });
  for (const o of together.options) assert.equal(Math.abs(o.order.indexOf("museum") - o.order.indexOf("breakfast")), 1, o.order.join());
  // A typed link puts them one after the other, in its direction.
  const led = planRoutes(stops, [{ a: "park", b: "museum", type: "leads to" }], dur, { base: true, k: 10 });
  assert.ok(led.options.length);
  for (const o of led.options) assert.equal(o.order.indexOf("museum") - o.order.indexOf("park"), 1, o.order.join());
  assert.deepEqual(led.options[0].order, ["breakfast", "dinner", "park", "museum"]);
  assert.equal(led.options.length, 3, "the pair goes before, between or after the timed stops");
  // A link against the times gives way to them.
  const against = planRoutes(stops, [{ a: "dinner", b: "breakfast", type: "leads to" }], dur, { base: true });
  assert.deepEqual(against.options[0].order.filter(id => !["museum", "park"].includes(id)), ["breakfast", "dinner"]);
  // Linked stops that the times keep apart are kept in order but not together.
  const apart = planRoutes([...stops, { id: "lunch", start: "13:00", end: "" }], [{ a: "breakfast", b: "dinner", type: "" }], plane([[0, 0], [1, 0], [10, 1], [10, 0], [11, 0], [3, 0]]), { base: true });
  assert.equal(apart.loose, true);
  assert.deepEqual(apart.options[0].order.filter(id => ["breakfast", "lunch", "dinner"].includes(id)), ["breakfast", "lunch", "dinner"]);
});

test("routes flag the timed stops you'd reach late, and prefer ones that don't", () => {
  // 9:00 and 9:10 are 30 minutes apart.
  const stops = [{ id: "a", start: "09:00", end: "" }, { id: "b", start: "09:10", end: "" }, { id: "c", start: "", end: "" }];
  const dur = [[0, 600, 600, 60], [600, 0, 1800, 600], [600, 1800, 0, 600], [60, 600, 600, 0]];
  const { options } = planRoutes(stops, [], dur, { base: true, dist: dur });
  assert.deepEqual(options[0].late, ["b"]);
  assert.ok(options[0].distance > 0);
  // Without a base, the route starts at the first stop.
  const nb = planRoutes([{ id: "x", start: "", end: "" }, { id: "y", start: "", end: "" }], [], line([0, 5]));
  assert.deepEqual(nb.options.map(o => [o.order.join(), o.duration]), [["x,y", 300], ["y,x", 300]]);
  assert.deepEqual(planRoutes([], [], []).options, []);
  assert.equal(niceDuration(30), "1 min");
  assert.equal(niceDuration(65 * 60), "1 h 5 min");
  assert.equal(niceDuration(120 * 60), "2 h");
});

// ── the site ────────────────────────────────────────────────────────────────

let asked, realFetch;
beforeEach(() => {
  asked = []; realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api.openrouteservice.org") return new Response("not found", { status: 404 });
    const body = init?.body ? JSON.parse(init.body) : null;
    asked.push({ path: url.pathname, body });
    if (url.pathname === "/geocode/search")
      return Response.json({ features: [{ geometry: { coordinates: [-0.12, 51.51] }, properties: { label: "Covent Garden, London" } }] });
    if (url.pathname.startsWith("/v2/matrix/")) {
      const pts = body.locations, d = pts.map(a => pts.map(b => Math.round(Math.hypot(a[0] - b[0], a[1] - b[1]) * 1e5)));
      return Response.json({ durations: d, distances: d.map(r => r.map(x => x * 10)) });
    }
    if (url.pathname.startsWith("/v2/directions/")) {
      const c = body.coordinates;
      return Response.json({ features: [{ geometry: { coordinates: c }, properties: { segments: c.slice(1).map((_, i) => ({ duration: 100 + i, distance: 1000 + i })) } }] });
    }
    return new Response("not found", { status: 404 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const api = (b, method, path, json) => b.req(method, "/todo/api/" + path, json === undefined ? {} : { json });
async function signedIn(env, name = "ryan") {
  const b = new Browser(env);
  assert.equal((await b.signup(name)).status, 303);
  return b;
}
async function day(b, colId) {
  const add = (title, start, lat, lng) => api(b, "POST", "items", { title, collection: colId, meta: { event: { start, end: null }, location: { place: title, lat, lng } } });
  const ids = {};
  for (const [t, s, lat, lng] of [["Breakfast", "2026-10-20T09:00", 51.5, -0.11], ["Museum", "2026-10-20", 51.53, -0.3], ["Park", "2026-10-20", 51.52, -0.2], ["Dinner", "2026-10-20T19:00", 51.5, -0.12]])
    ids[t] = (await add(t, s, lat, lng)).json.id;
  return ids;
}

test("the route goes from the day's base and back, along the streets", async () => {
  const b = await signedIn(makeEnv({ ORS_API_KEY: "ors-key" }));
  const col = (await api(b, "GET", "state")).json.collections[0];
  await api(b, "PATCH", `collections/${col.id}`, { plugins: [...col.plugins, "location", "graph"] });
  const ids = await day(b, col.id);

  const set = await api(b, "PATCH", `collections/${col.id}`, { bases: [{ place: "Covent Garden" }, { place: "", lat: 51.5, lng: -0.25, from: "2026-10-20" }] });
  assert.equal(set.status, 200);
  assert.deepEqual(set.json.bases[0], { place: "Covent Garden, London", lat: 51.51, lng: -0.12, from: null, to: null });
  const searches = asked.length;

  let r = await api(b, "GET", `route?collection=${col.id}&day=2026-10-20`);
  assert.equal(r.status, 200);
  assert.equal(r.json.base.from, "2026-10-20");
  assert.equal(r.json.estimated, false);
  assert.deepEqual(r.json.options[0].order.map(id => Object.keys(ids).find(k => ids[k] === id)), ["Museum", "Park", "Breakfast", "Dinner"]);
  assert.equal(r.json.legs.length, 5);
  assert.equal(r.json.path.length, 6);
  assert.deepEqual(r.json.path[0], [51.5, -0.25]);
  assert.equal(asked.slice(searches).filter(a => a.path.startsWith("/v2/directions/")).length, 1);

  // Another day uses the home base; another option, another order; walking asks for walking.
  r = await api(b, "GET", `route?collection=${col.id}&day=2026-10-20&option=1&profile=foot-walking`);
  assert.equal(r.json.option, 1);
  assert.equal(r.json.profile, "foot-walking");
  assert.notDeepEqual(r.json.options[1].order, r.json.options[0].order);
  assert.ok(asked.at(-1).path.startsWith("/v2/directions/foot-walking"));

  // The park leading to the museum turns them round.
  await api(b, "PATCH", `items/${ids.Park}`, { meta: { graph: { links: [ids.Museum], rel: { [ids.Museum]: "leads to" } } } });
  r = await api(b, "GET", `route?collection=${col.id}&day=2026-10-20`);
  assert.ok(r.json.options.length);
  for (const o of r.json.options) assert.equal(o.order.indexOf(ids.Museum) - o.order.indexOf(ids.Park), 1);

  assert.equal((await api(b, "GET", `route?collection=${col.id}&day=tomorrow`)).status, 400);
  assert.equal((await api(b, "GET", `route?collection=c_nope&day=2026-10-20`)).status, 404);
  const empty = await api(b, "GET", `route?collection=${col.id}&day=2026-10-21`);
  assert.deepEqual([empty.json.options, empty.json.base.place], [[], "Covent Garden, London"]);
});

test("without a key the route is estimated in straight lines; editors can set bases, viewers can't", async () => {
  const env = makeEnv();
  const b = await signedIn(env);
  const col = (await api(b, "GET", "state")).json.collections[0];
  await day(b, col.id);
  await api(b, "PATCH", `collections/${col.id}`, { bases: [{ ...HOME }] });
  const r = await api(b, "GET", `route?collection=${col.id}&day=2026-10-20`);
  assert.equal(r.json.estimated, true);
  assert.equal(r.json.path.length, 6);
  assert.ok(r.json.legs.every(l => l.duration > 0 && l.distance > 0));
  assert.equal(asked.length, 0);

  const ed = await signedIn(env, "sam"), vw = await signedIn(env, "viv");
  await api(b, "POST", `collections/${col.id}/shares`, { username: "sam", role: "edit" });
  await api(b, "POST", `collections/${col.id}/shares`, { username: "viv", role: "view" });
  const byEditor = await api(ed, "PATCH", `collections/${col.id}`, { bases: [{ ...HOME, place: "Sam's" }] });
  assert.equal(byEditor.status, 200);
  assert.equal(byEditor.json.bases[0].place, "Sam's");
  assert.equal((await api(ed, "PATCH", `collections/${col.id}`, { name: "Mine now" })).status, 404, "other settings stay the owner's");
  assert.equal((await api(vw, "PATCH", `collections/${col.id}`, { bases: [] })).status, 400);
  assert.equal((await api(vw, "GET", `route?collection=${col.id}&day=2026-10-20`)).status, 200, "viewers can see the route");
});
