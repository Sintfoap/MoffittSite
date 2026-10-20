// Tests for Drift's Locations plugin: what3words addresses on items, placed on
// the map by the site (src/w3w.js), and the day's stops the Map view shows.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv } from "./helpers.mjs";
import { parseWords, parseQuick } from "../public/todo/lib.js";
import { dayStops, distance, niceDistance } from "../public/todo/plugins/location.js";

const PLACES = {
  "filled.count.soap": { lat: 51.520847, lng: -0.195521, nearestPlace: "Bayswater, London" },
  "index.home.raft": { lat: 51.521251, lng: -0.203586, nearestPlace: "Bayswater, London" },
};
let asked, realFetch, down;
beforeEach(() => {
  asked = []; down = false; realFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api.what3words.com") return new Response("not found", { status: 404 });
    asked.push(url);
    if (down) throw new TypeError("fetch failed");
    if (url.searchParams.get("key") !== "w3w-key") return Response.json({ error: { code: "InvalidKey", message: "nope" } }, { status: 401 });
    const p = PLACES[url.searchParams.get("words")];
    if (!p) return Response.json({ error: { code: "BadWords", message: "not an address" } }, { status: 400 });
    return Response.json({ coordinates: { lat: p.lat, lng: p.lng }, nearestPlace: p.nearestPlace, words: url.searchParams.get("words") });
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

test("what3words addresses are read however they're pasted", () => {
  assert.equal(parseWords("///Filled.Count.Soap"), "filled.count.soap");
  assert.equal(parseWords("filled count soap"), "filled.count.soap");
  assert.equal(parseWords("https://what3words.com/filled.count.soap"), "filled.count.soap");
  assert.equal(parseWords("w3w.co/index.home.raft?x=1"), "index.home.raft");
  for (const bad of ["", "///", "two.words", "four.words.in.here", "with.num3.bers", "a..b"]) assert.equal(parseWords(bad), null, bad);
  assert.deepEqual(parseQuick("Lunch ///filled.count.soap @1pm"), ["Lunch", { location: "filled.count.soap", time: "13:00" }]);
  assert.deepEqual(parseQuick("Read ///not-words"), ["Read ///not-words", {}], "anything else stays in the title");
});

test("the site places words on the map when they're saved, and only asks once", async () => {
  const b = await signedIn(makeEnv({ W3W_API_KEY: "w3w-key" }));
  const col = await inbox(b);
  const made = await api(b, "POST", "items", { title: "Lunch", collection: col.id, meta: { location: { words: "///Filled.Count.Soap" } } });
  assert.equal(made.status, 201);
  assert.deepEqual(made.json.meta.location, { words: "filled.count.soap", lat: 51.520847, lng: -0.195521, place: "Bayswater, London" });
  assert.equal(asked.length, 1);

  // Sending the same words again (with someone's own idea of where they are) keeps the site's place, without asking.
  const same = await api(b, "PATCH", `items/${made.json.id}`, { meta: { location: { words: "filled.count.soap", lat: 1, lng: 2 } } });
  assert.deepEqual(same.json.meta.location, made.json.meta.location);
  assert.equal(asked.length, 1);

  const moved = await api(b, "PATCH", `items/${made.json.id}`, { meta: { location: { words: "index.home.raft" } } });
  assert.equal(moved.json.meta.location.lng, -0.203586);
  assert.equal(asked.length, 2);

  const bad = await api(b, "PATCH", `items/${made.json.id}`, { meta: { location: { words: "not.a.place" } } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /doesn’t know \/\/\/not\.a\.place/);
  assert.equal((await api(b, "PATCH", `items/${made.json.id}`, { meta: { location: { words: "two.words" } } })).status, 400);

  // No words yet is allowed (the item dialog's "Add"); nothing is asked.
  const blank = await api(b, "PATCH", `items/${made.json.id}`, { meta: { location: {} } });
  assert.deepEqual(blank.json.meta.location, { words: "", lat: null, lng: null, place: "" });
  assert.equal(asked.length, 3);
});

test("when what3words can't be reached the words are kept, and placed on a later save", async () => {
  const b = await signedIn(makeEnv({ W3W_API_KEY: "w3w-key" }));
  const col = await inbox(b);
  down = true;
  const made = await api(b, "POST", "items", { title: "Lunch", collection: col.id, meta: { location: { words: "filled.count.soap" } } });
  assert.equal(made.status, 201);
  assert.deepEqual(made.json.meta.location, { words: "filled.count.soap", lat: null, lng: null, place: "" });
  down = false;
  const again = await api(b, "PATCH", `items/${made.json.id}`, { meta: { location: made.json.meta.location } });
  assert.equal(again.json.meta.location.lat, 51.520847);
});

test("without a key, items keep their words and whatever place was sent", async () => {
  const b = await signedIn(makeEnv());
  const col = await inbox(b);
  const made = await api(b, "POST", "items", { title: "Lunch", collection: col.id, meta: { location: { words: "filled.count.soap" } } });
  assert.deepEqual(made.json.meta.location, { words: "filled.count.soap", lat: null, lng: null, place: "" });
  const given = await api(b, "POST", "items", { title: "Tea", collection: col.id, meta: { location: { words: "index.home.raft", lat: 51.5, lng: -0.2 } } });
  assert.deepEqual(given.json.meta.location, { words: "index.home.raft", lat: 51.5, lng: -0.2, place: "" });
  assert.equal(asked.length, 0);
  for (const location of [{ words: "a.b.c", lat: 91, lng: 0 }, { words: "a.b.c", lat: 1 }, { words: "a.b.c", place: "x".repeat(121) }, "a.b.c"])
    assert.equal((await api(b, "POST", "items", { title: "x", collection: col.id, meta: { location } })).status, 400, JSON.stringify(location));
});

test("the map shows the day's events with a place, in order, with the distance from the stop before", () => {
  const at = (id, start, location, end = null) => ({ id, title: id, meta: { event: { start, end }, ...(location ? { location } : {}) } });
  const a = { words: "filled.count.soap", lat: 51.520847, lng: -0.195521, place: "" };
  const b = { words: "index.home.raft", lat: 51.521251, lng: -0.203586, place: "" };
  const items = [
    at("tea", "2026-10-20T15:00", b),
    at("lunch", "2026-10-20T12:00", a),
    at("allday", "2026-10-20", a),
    at("unplaced", "2026-10-20T09:00", { words: "x.y.z", lat: null, lng: null, place: "" }),
    at("nowhere", "2026-10-20T10:00", null),
    at("blank", "2026-10-20T11:00", { words: "", lat: null, lng: null, place: "" }),
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
  assert.deepEqual(unplaced.map(it => it.id), ["unplaced"]);
  assert.equal(elsewhere, 2);
  assert.equal(niceDistance(560), "560 m");
  assert.equal(niceDistance(1234), "1.2 km");
  assert.equal(niceDistance(25000), "25 km");
  assert.equal(niceDistance(1609.344, true), "1.0 mi");
});
