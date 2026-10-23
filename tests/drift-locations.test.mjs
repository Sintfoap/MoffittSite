// Tests for Drift's Locations plugin: places found through OpenRouteService
// (src/places.js), coordinates named, and the day's stops the Map view shows.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv } from "./helpers.mjs";
import { parseCoords, parseQuick } from "../public/todo/lib.js";
import { dayStops, distance, niceDistance, centre, rangeDays, normRange, rangeStops, undatedStops, dayColor, MAX_RANGE } from "../public/todo/plugins/location.js";

const FERRY = { label: "Ferry Building, San Francisco, CA, USA", lat: 37.7955, lng: -122.3937 };
const TOWER = { label: "Coit Tower, San Francisco, CA, USA", lat: 37.8024, lng: -122.4058 };
const feature = p => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lng, p.lat] }, properties: { label: p.label } });
let asked, realFetch, down;
beforeEach(() => {
  asked = []; down = false; realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api.openrouteservice.org") return new Response("not found", { status: 404 });
    asked.push(url);
    if (down) throw new TypeError("fetch failed");
    if (new Headers(init?.headers).get("Authorization") !== "ors-key") return Response.json({ error: "Access to this API has been disallowed" }, { status: 403 });
    if (url.pathname === "/geocode/search") {
      const q = url.searchParams.get("text").toLowerCase();
      return Response.json({ features: [FERRY, TOWER].filter(p => p.label.toLowerCase().includes(q) || q === "sf").map(feature) });
    }
    if (url.pathname === "/geocode/reverse") return Response.json({ features: [feature({ ...FERRY, lat: +url.searchParams.get("point.lat"), lng: +url.searchParams.get("point.lon") })] });
    return new Response("not found", { status: 404 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function signedIn(env) {
  const b = new Browser(env);
  assert.equal((await b.signup("ryan")).status, 303);
  return b;
}
const api = (b, method, path, json) => b.req(method, "/todo/api/" + path, json === undefined ? {} : { json });
const inbox = async b => (await api(b, "GET", "state")).json.collections[0];

test("coordinates and places are read however they're typed", () => {
  assert.deepEqual(parseCoords("37.7955, -122.3937"), { lat: 37.7955, lng: -122.3937 });
  assert.deepEqual(parseCoords("https://www.openstreetmap.org/?mlat=51.5&mlon=-0.12#map=17/51.5/-0.12"), { lat: 51.5, lng: -0.12 });
  assert.deepEqual(parseCoords("https://www.google.com/maps/@37.80,-122.27,15z"), { lat: 37.8, lng: -122.27 });
  assert.deepEqual(parseCoords("geo:1.5,2.5"), { lat: 1.5, lng: 2.5 });
  for (const no of ["91, 0", "Ferry Building", "", "1,2,3"]) assert.equal(parseCoords(no), null, no);
  assert.deepEqual(parseQuick("Lunch #food ~ Ferry Building, SF @1pm"), ["Lunch", { tags: ["food"], time: "13:00", place: "Ferry Building, SF" }]);
  assert.deepEqual(parseQuick("Read ~"), ["Read", {}]);
});

test("the site searches for places, near the ones you have, and names a spot", async () => {
  const b = await signedIn(makeEnv({ ORS_API_KEY: "ors-key" }));
  const r = await api(b, "GET", "places?q=ferry&near=37.8,-122.4");
  assert.deepEqual(r.json, { results: [{ place: FERRY.label, lat: FERRY.lat, lng: FERRY.lng }] });
  assert.equal(asked[0].searchParams.get("focus.point.lat"), "37.8");
  assert.deepEqual((await api(b, "GET", "places?lat=37.7955&lng=-122.3937")).json, { place: FERRY.label });
  assert.equal((await api(b, "GET", "places?lat=95&lng=0")).status, 400);
  assert.equal((await api(b, "POST", "places?q=x", {})).status, 404);
  down = true;
  assert.equal((await api(b, "GET", "places?q=ferry")).status, 502);

  const off = await signedIn(makeEnv());
  assert.deepEqual((await api(off, "GET", "places?q=ferry")).json, { off: true, results: [], place: "" });
  assert.equal((await new Browser(makeEnv()).req("GET", "/todo/api/places?q=x")).status, 401, "signed out");
});

test("a typed place is found when it's saved, once; a pin gets its name", async () => {
  const b = await signedIn(makeEnv({ ORS_API_KEY: "ors-key" }));
  const col = await inbox(b);
  const made = await api(b, "POST", "items", { title: "Lunch", collection: col.id, meta: { location: { place: "  ferry  building " } } });
  assert.equal(made.status, 201);
  assert.deepEqual(made.json.meta.location, { place: FERRY.label, lat: FERRY.lat, lng: FERRY.lng });
  assert.equal(asked.length, 1);
  // Sent again as found: kept, nothing asked.
  const same = await api(b, "PATCH", `items/${made.json.id}`, { meta: { location: { place: FERRY.label } } });
  assert.deepEqual(same.json.meta.location, made.json.meta.location);
  assert.equal(asked.length, 1);

  const pinned = await api(b, "PATCH", `items/${made.json.id}`, { meta: { location: { place: "", lat: 37.8, lng: -122.41 } } });
  assert.deepEqual(pinned.json.meta.location, { place: FERRY.label, lat: 37.8, lng: -122.41 });
  assert.equal(asked.at(-1).pathname, "/geocode/reverse");
  // Picked from the search: saved as is.
  const n = asked.length;
  const picked = await api(b, "PATCH", `items/${made.json.id}`, { meta: { location: { place: TOWER.label, lat: TOWER.lat, lng: TOWER.lng } } });
  assert.equal(picked.json.meta.location.lat, TOWER.lat);
  assert.equal(asked.length, n);

  const lost = await api(b, "PATCH", `items/${made.json.id}`, { meta: { location: { place: "Atlantis" } } });
  assert.equal(lost.status, 400);
  assert.match(lost.json.error, /couldn’t find “Atlantis”/);

  const blank = await api(b, "PATCH", `items/${made.json.id}`, { meta: { location: {} } });
  assert.deepEqual(blank.json.meta.location, { place: "", lat: null, lng: null });
});

test("without a key, or when the service is down, places are kept as typed", async () => {
  for (const env of [makeEnv(), makeEnv({ ORS_API_KEY: "ors-key" })]) {
    down = Boolean(env.ORS_API_KEY);
    const b = await signedIn(env);
    const col = await inbox(b);
    const made = await api(b, "POST", "items", { title: "Lunch", collection: col.id, meta: { location: { place: "Ferry Building" } } });
    assert.deepEqual(made.json.meta.location, { place: "Ferry Building", lat: null, lng: null });
    const pinned = await api(b, "POST", "items", { title: "Tea", collection: col.id, meta: { location: { lat: 37.8, lng: -122.4 } } });
    assert.deepEqual(pinned.json.meta.location, { place: "", lat: 37.8, lng: -122.4 });
  }
  down = false;
  const b = await signedIn(makeEnv());
  const col = await inbox(b);
  for (const location of [{ lat: 91, lng: 0 }, { lat: 1 }, { place: "x".repeat(201) }, "Ferry Building"])
    assert.equal((await api(b, "POST", "items", { title: "x", collection: col.id, meta: { location } })).status, 400, JSON.stringify(location));
});

test("the map shows the day's events with a place, in order, with the distance from the stop before", () => {
  const at = (id, start, location, end = null) => ({ id, title: id, meta: { event: { start, end }, ...(location ? { location } : {}) } });
  const a = { place: "A", lat: 51.520847, lng: -0.195521 };
  const b = { place: "", lat: 51.521251, lng: -0.203586 };
  const items = [
    at("tea", "2026-10-20T15:00", b),
    at("lunch", "2026-10-20T12:00", a),
    at("allday", "2026-10-20", a),
    at("lost", "2026-10-20T09:00", { place: "Atlantis", lat: null, lng: null }),
    at("nowhere", "2026-10-20T10:00", null),
    at("blank", "2026-10-20T11:00", { place: "", lat: null, lng: null }),
    at("trip", "2026-10-19", b, "2026-10-21"),
    at("tomorrow", "2026-10-21T12:00", a),
    { id: "undated", title: "undated", meta: { location: a } },
  ];
  const { stops, unplaced, elsewhere } = dayStops(items, "2026-10-20");
  assert.deepEqual(stops.map(s => [s.n, s.item.id]), [[1, "trip"], [2, "allday"], [3, "lunch"], [4, "tea"]]);
  assert.equal(stops[0].from, null);
  assert.equal(Math.round(stops[1].from), 560);
  assert.equal(stops[2].from, 0);
  assert.equal(stops[3].from, distance(a, b));
  assert.deepEqual(unplaced.map(it => it.id), ["lost"]);
  assert.deepEqual(elsewhere.map(it => it.id), ["nowhere", "blank"]);
  const mid = centre([at("x", "2026-10-20", a), at("y", "2026-10-20", { ...a, lat: 51.521847 }), at("z", "2026-10-20", null)]);
  assert.ok(Math.abs(mid.lat - 51.521347) < 1e-9 && mid.lng === -0.195521);
  assert.equal(centre([]), null);
  assert.equal(niceDistance(560), "560 m");
  assert.equal(niceDistance(1234), "1.2 km");
  assert.equal(niceDistance(25000), "25 km");
  assert.equal(niceDistance(1609.344, true), "1.0 mi");
});

test("a range of days: listed inclusively, capped, and corrected when the ends are backwards", () => {
  assert.deepEqual(rangeDays("2026-10-30", "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  assert.deepEqual(rangeDays("2026-10-20", "2026-10-20"), ["2026-10-20"]);
  assert.equal(rangeDays("2026-01-01", "2026-12-31").length, MAX_RANGE);
  assert.deepEqual(rangeDays("2026-10-21", "2026-10-20"), []);
  assert.deepEqual(rangeDays("", "2026-10-20"), []);
  assert.deepEqual(rangeDays("tomorrow", "2026-10-20"), []);

  // Moving the first day past the last drags the last along; and the other way round.
  assert.deepEqual(normRange("2026-10-25", "2026-10-22", "first"), { first: "2026-10-25", last: "2026-10-25" });
  assert.deepEqual(normRange("2026-10-20", "2026-10-18", "last"), { first: "2026-10-18", last: "2026-10-18" });
  assert.deepEqual(normRange("2026-10-20", "2026-10-22", "last"), { first: "2026-10-20", last: "2026-10-22" });
  // Too long: the end you didn't touch moves.
  assert.deepEqual(normRange("2026-10-01", "2026-12-01", "last"), { first: "2026-11-18", last: "2026-12-01" });
  assert.deepEqual(normRange("2026-10-01", "2026-12-01", "first"), { first: "2026-10-01", last: "2026-10-14" });
});

test("the map's range groups each day's stops, numbered again from 1, and colours days apart", () => {
  const at = (id, start, location, end = null) => ({ id, title: id, meta: { event: { start, end }, ...(location ? { location } : {}) } });
  const a = { place: "A", lat: 51.52, lng: -0.19 }, b = { place: "B", lat: 51.53, lng: -0.2 };
  const items = [
    at("mon1", "2026-10-19T09:00", a), at("mon2", "2026-10-19T11:00", b),
    at("tue1", "2026-10-20T10:00", b),
    at("trip", "2026-10-20", a, "2026-10-21"),
    at("lost", "2026-10-21T09:00", { place: "Atlantis", lat: null, lng: null }),
    at("nowhere", "2026-10-21T10:00", null),
    at("late", "2026-10-30T10:00", a),
    { id: "undated", title: "undated", meta: { location: a } },
    { id: "plain", title: "plain", meta: {} },
  ];
  const r = rangeStops(items, rangeDays("2026-10-19", "2026-10-21"));
  assert.deepEqual(r.map(d => d.day), ["2026-10-19", "2026-10-20", "2026-10-21"]);
  assert.deepEqual(r[0].stops.map(s => [s.n, s.item.id]), [[1, "mon1"], [2, "mon2"]]);
  assert.deepEqual(r[1].stops.map(s => [s.n, s.item.id]), [[1, "trip"], [2, "tue1"]], "all-day first, then by time");
  assert.deepEqual(r[2].stops.map(s => [s.n, s.item.id]), [[1, "trip"]], "an event over several days is on each of them");
  assert.deepEqual(r[2].unplaced.map(it => it.id), ["lost"]);
  assert.deepEqual(r[2].elsewhere.map(it => it.id), ["nowhere"]);
  assert.deepEqual(rangeStops(items, []), []);

  const colours = Array.from({ length: MAX_RANGE }, (_, i) => dayColor(i));
  assert.equal(new Set(colours).size, MAX_RANGE);
  assert.ok(colours.every(c => /^hsl\(\d+(\.\d+)? \d+% \d+%\)$/.test(c)), colours[0]);
  assert.equal(dayColor(3), dayColor(3));
});

test("undatedStops: items with a place but no event, numbered from 1", () => {
  const a = { place: "A", lat: 1, lng: 2 };
  const items = [
    { id: "d", title: "dated", meta: { event: { start: "2026-10-19T09:00" }, location: a } },
    { id: "u1", title: "u1", meta: { location: a } },
    { id: "lost", title: "lost", meta: { location: { place: "Atlantis", lat: null, lng: null } } },
    { id: "u2", title: "u2", meta: { location: { place: "B", lat: 3, lng: 4 } } },
    { id: "plain", title: "plain", meta: {} },
  ];
  const r = undatedStops(items);
  assert.deepEqual(r.stops.map(s => [s.n, s.item.id]), [[1, "u1"], [2, "u2"]]);
  assert.deepEqual(r.unplaced.map(it => it.id), ["lost"]);
  assert.deepEqual(r.elsewhere, [], "no place at all is not listed");
  assert.deepEqual(undatedStops([]), { stops: [], unplaced: [], elsewhere: [] });
});
