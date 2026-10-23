// Tests for Trip planner: trips planned together, their days, places and
// packing list, and the packing list sent to a Drift checklist.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps, sqlOne, sql, run } from "./helpers.mjs";
import { daysOf } from "../src/trips.js";

async function traveller(env, name) {
  const b = new Browser(env);
  await b.signup(name, undefined, name[0].toUpperCase() + name.slice(1));
  grantApps(env, name, "trips");
  return b;
}
const api = (b, method, path, json) => b.req(method, "/trips/api/" + path, { json });

test("Trip planner is off until an admin turns it on", async () => {
  const env = makeEnv(), josh = new Browser(env);
  await josh.signup("josh");
  assert.equal((await josh.get("/trips/")).status, 403);
  assert.equal((await josh.get("/trips/api/trips")).status, 403);
  grantApps(env, "josh", "trips");
  const page = await josh.get("/trips/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("Content-Security-Policy"), /img-src 'self' data: https:\/\/tile\.openstreetmap\.org/);
  assert.equal((await josh.get("/trips")).status, 308);
  assert.deepEqual((await josh.get("/trips/api/trips")).json, { trips: [], drift: true, search: false, lists: [] });
});

test("days run from the start to the end", () => {
  assert.deepEqual(daysOf("2026-02-27", "2026-03-02"), ["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
  assert.deepEqual(daysOf("2026-05-01", ""), ["2026-05-01"]);
  assert.deepEqual(daysOf("", ""), []);
});

test("making a trip, its dates, and who's on it", async () => {
  const env = makeEnv(), ryan = await traveller(env, "ryan"), sam = await traveller(env, "sam");
  const nope = new Browser(env);
  await nope.signup("nope");

  const t = await api(ryan, "POST", "trips", { title: "Lisbon", start: "2026-05-01", end: "2026-05-04", notes: "Flat in Alfama" });
  assert.equal(t.status, 201, t.text);
  assert.deepEqual(t.json.days, ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04"]);
  assert.equal(t.json.owned, true);
  assert.deepEqual(t.json.members.map(m => [m.username, m.owner]), [["ryan", true]]);
  const id = t.json.id;

  for (const bad of [{ title: "" }, { title: "x", start: "2026-05-04", end: "2026-05-01" }, { title: "x", start: "2026-02-30" },
    { title: "x", end: "2026-05-01" }, { title: "x", start: "2026-01-01", end: "2026-12-31" }, { title: "x", colour: "red" }]) {
    assert.equal((await api(ryan, "POST", "trips", bad)).status, 400, JSON.stringify(bad));
  }

  // sam can't see it until he's added; only people with Trip planner can be.
  assert.equal((await api(sam, "GET", `trips/${id}`)).status, 404);
  assert.deepEqual((await api(sam, "GET", "trips")).json.trips, []);
  assert.match((await api(ryan, "POST", `trips/${id}/members`, { username: "nope" })).json.error, /Trip planner/);
  assert.match((await api(ryan, "POST", `trips/${id}/members`, { username: "ryan" })).json.error, /you/);
  const added = await api(ryan, "POST", `trips/${id}/members`, { username: "@Sam" });
  assert.deepEqual(added.json.members.map(m => m.username), ["ryan", "sam"]);
  const list = (await api(sam, "GET", "trips")).json.trips;
  assert.deepEqual(list.map(x => [x.title, x.owned, x.owner_name, x.people]), [["Lisbon", false, "Ryan", 2]]);

  // sam can change the trip, but not who's on it, and can't delete it, only leave.
  const moved = await api(sam, "PATCH", `trips/${id}`, { end: "2026-05-03" });
  assert.equal(moved.json.days.length, 3);
  assert.equal((await api(sam, "PATCH", `trips/${id}`, { end: "2026-04-01" })).status, 400);
  assert.equal((await api(sam, "POST", `trips/${id}/members`, { username: "ryan" })).status, 400);
  const ryanId = sqlOne(env, "SELECT id FROM users WHERE username = 'ryan'").id;
  assert.equal((await api(sam, "DELETE", `trips/${id}/members/${ryanId}`)).status, 400);
  assert.deepEqual((await api(sam, "DELETE", `trips/${id}`)).json, { left: true });
  assert.equal((await api(sam, "GET", `trips/${id}`)).status, 404);
  assert.equal((await api(ryan, "GET", `trips/${id}`)).json.members.length, 1);

  // The owner deleting it takes everything in it.
  await api(ryan, "POST", `trips/${id}/packing`, { text: "Sunscreen" });
  assert.deepEqual((await api(ryan, "DELETE", `trips/${id}`)).json, { removed: true });
  assert.equal(sql(env, "SELECT * FROM trip_entries").length, 0);
});

test("the itinerary, pinned places, and Drift's map", async () => {
  const env = makeEnv(), ryan = await traveller(env, "ryan"), sam = await traveller(env, "sam");
  const id = (await api(ryan, "POST", "trips", { title: "Lisbon", start: "2026-05-01", end: "2026-05-02" })).json.id;
  await api(ryan, "POST", `trips/${id}/members`, { username: "sam" });

  // A place from ryan's Drift map.
  const col = (await ryan.get("/todo/api/state")).json.collections[0];
  await ryan.req("POST", "/todo/api/items", { json: { title: "See the tower", collection: col.id, meta: { location: { place: "Belém Tower", lat: 38.6916, lng: -9.216 } } } });
  await ryan.req("POST", "/todo/api/items", { json: { title: "Not on the map", collection: col.id } });
  const drift = (await api(ryan, "GET", "drift-places")).json.items;
  assert.deepEqual(drift.map(x => [x.title, x.place, x.lat, x.collection]), [["See the tower", "Belém Tower", 38.6916, col.name]]);
  assert.deepEqual((await api(sam, "GET", "drift-places")).json.items, [], "only your own");

  let t = (await api(ryan, "POST", `trips/${id}/places`, { place: drift[0].place, lat: drift[0].lat, lng: drift[0].lng, drift: drift[0].id })).json;
  t = (await api(sam, "POST", `trips/${id}/places`, { place: "Time Out Market" })).json;
  assert.deepEqual(t.places.map(p => [p.place, p.lat]), [["Belém Tower", 38.6916], ["Time Out Market", null]]);
  assert.equal((await api(sam, "POST", `trips/${id}/places`, { place: "x", lat: 100, lng: 0 })).status, 400);
  assert.equal((await api(sam, "POST", `trips/${id}/places`, { place: "x", lat: 10 })).status, 400);
  assert.equal((await api(sam, "POST", `trips/${id}/places`, { place: "" })).status, 400);
  const tower = t.places[0].id, market = t.places[1].id;

  // Stops, in order: by day, then time (untimed last), and "any day" at the end.
  await api(sam, "POST", `trips/${id}/plans`, { day: "2026-05-01", time: "14:00", title: "The tower", place: tower });
  await api(ryan, "POST", `trips/${id}/plans`, { day: "2026-05-01", time: "09:30", title: "Pastéis de nata" });
  await api(ryan, "POST", `trips/${id}/plans`, { day: "2026-05-02", title: "Lunch", place: market });
  t = (await api(ryan, "POST", `trips/${id}/plans`, { title: "Fado night" })).json;
  assert.deepEqual(t.plans.map(p => [p.day, p.time, p.title]), [
    ["2026-05-01", "09:30", "Pastéis de nata"], ["2026-05-01", "14:00", "The tower"], ["2026-05-02", "", "Lunch"], ["", "", "Fado night"]]);
  assert.equal((await api(ryan, "POST", `trips/${id}/plans`, { title: "x", time: "25:00" })).status, 400);
  assert.equal((await api(ryan, "POST", `trips/${id}/plans`, { title: "" })).status, 400);
  const fado = t.plans[3].id;
  t = (await api(sam, "PATCH", `trips/${id}/plans/${fado}`, { day: "2026-05-02", time: "21:00" })).json;
  assert.deepEqual(t.plans.slice(2).map(p => [p.time, p.title]), [["21:00", "Fado night"], ["", "Lunch"]], "timed before untimed");
  assert.equal((await api(sam, "PATCH", `trips/${id}/plans/e_0000000000`, { title: "x" })).status, 404);
  assert.equal((await api(sam, "PATCH", `trips/${id}/places/${fado}`, { place: "x" })).status, 404, "kinds don't mix");

  // Unpinning a place leaves its stops, without the place.
  t = (await api(ryan, "DELETE", `trips/${id}/places/${market}`)).json;
  assert.equal(t.places.length, 1);
  assert.equal(t.plans.find(p => p.title === "Lunch").place, "");
  t = (await api(ryan, "DELETE", `trips/${id}/plans/${fado}`)).json;
  assert.equal(t.plans.length, 3);

  // Without a key for OpenRouteService, there's no search.
  assert.deepEqual((await api(ryan, "GET", "places?q=Lisbon")).json, { results: null });
  // Someone who isn't on the trip can't touch it.
  const pat = await traveller(env, "pat");
  assert.equal((await api(pat, "POST", `trips/${id}/plans`, { title: "Crash it" })).status, 404);
  assert.equal((await api(pat, "DELETE", `trips/${id}`)).status, 404);
});

test("the packing list goes to each person's Drift checklist", async () => {
  const env = makeEnv(), ryan = await traveller(env, "ryan"), sam = await traveller(env, "sam");
  const id = (await api(ryan, "POST", "trips", { title: "Lisbon" })).json.id;
  let t = (await api(ryan, "POST", `trips/${id}/members`, { username: "sam" })).json;
  const [me, him] = [t.members[0].id, t.members[1].id];
  for (const text of ["Passport", "Sunscreen", "Adapter", "Camera"]) t = (await api(ryan, "POST", `trips/${id}/packing`, { text })).json;
  const [passport, sunscreen, adapter, camera] = t.packing.map(p => p.id);
  await api(ryan, "PATCH", `trips/${id}/packing/${camera}`, { who: him });
  t = (await api(sam, "PATCH", `trips/${id}/packing/${adapter}`, { who: me })).json;
  assert.deepEqual(t.packing.map(p => [p.text, p.who]), [["Passport", ""], ["Sunscreen", ""], ["Adapter", me], ["Camera", him]]);
  assert.equal((await api(ryan, "PATCH", `trips/${id}/packing/${camera}`, { who: "u_nobody" })).status, 400);

  // ryan sends his: everything for anyone, and what's for him, not sam's camera.
  const sent = await api(ryan, "POST", `trips/${id}/pack`, {});
  assert.equal(sent.status, 200, sent.text);
  assert.deepEqual([sent.json.list.name, sent.json.added], ["Packing: Lisbon", 3]);
  assert.deepEqual(sent.json.trip.packing.map(p => p.in_drift), [true, true, true, false]);
  const drift = (await ryan.get("/todo/api/state")).json;
  const list = drift.collections.find(c => c.name === "Packing: Lisbon");
  assert.equal(list.view, "checklist");
  const items = drift.items.filter(it => it.collection === list.id);
  assert.deepEqual(items.map(it => it.title).sort(), ["Adapter", "Passport", "Sunscreen"]);
  assert.equal(items[0].notes, "For Lisbon");
  assert.equal(items[0].meta.checklist.done, false);
  // Again: nothing new for him. Picking one sends it again, to the same list.
  assert.match((await api(ryan, "POST", `trips/${id}/pack`, {})).json.error, /already/);
  const again = await api(ryan, "POST", `trips/${id}/pack`, { ids: [camera] });
  assert.equal(again.json.list.id, list.id);
  assert.equal((await ryan.get("/todo/api/state")).json.collections.filter(c => c.name === "Packing: Lisbon").length, 1);

  // sam's own send: what's for anyone and his camera, onto his own Drift.
  const his = await api(sam, "POST", `trips/${id}/pack`, {});
  assert.equal(his.json.added, 3);
  assert.deepEqual(his.json.trip.packing.map(p => p.in_drift), [true, true, false, true]);
  assert.deepEqual((await sam.get("/todo/api/state")).json.items.map(it => it.title).sort(), ["Camera", "Passport", "Sunscreen"]);

  // Taking sam off the trip hands his camera back to anyone.
  t = (await api(ryan, "DELETE", `trips/${id}/members/${him}`)).json;
  assert.equal(t.packing.find(p => p.id === camera).who, "");

  // Without Drift there's nowhere to send it.
  run(env, "DELETE FROM user_areas WHERE user_id = ? AND area = 'todo'", me);
  assert.equal((await api(ryan, "GET", "trips")).json.drift, false);
  assert.match((await api(ryan, "POST", `trips/${id}/pack`, {})).json.error, /Drift/);
});

test("deleting an account takes its trips, and takes it off other people's", async () => {
  const env = makeEnv(), ryan = await traveller(env, "ryan"), sam = await traveller(env, "sam");
  const mine = (await api(ryan, "POST", "trips", { title: "Ryan's" })).json.id;
  const his = (await api(sam, "POST", "trips", { title: "Sam's" })).json.id;
  await api(ryan, "POST", `trips/${mine}/members`, { username: "sam" });
  await api(sam, "POST", `trips/${his}/members`, { username: "ryan" });
  await api(ryan, "POST", `trips/${mine}/packing`, { text: "Hat" });
  const boss = new Browser(env);
  await boss.signup("boss");
  run(env, "INSERT INTO user_areas (user_id, area) SELECT id, 'admin' FROM users WHERE username = 'boss'");
  run(env, "UPDATE users SET totp_secret = 'AAAAAAAAAAAAAAAA' WHERE username = 'boss'");
  const res = await boss.post("/admin/delete", { user_id: sqlOne(env, "SELECT id FROM users WHERE username = 'ryan'").id, confirm: "ryan" });
  assert.ok(res.status < 400, "admin delete worked: " + res.status);
  assert.deepEqual((await api(sam, "GET", "trips")).json.trips.map(t => t.title), ["Sam's"]);
  assert.deepEqual((await api(sam, "GET", `trips/${his}`)).json.members.map(m => m.username), ["sam"]);
  assert.equal(sql(env, "SELECT * FROM trip_entries").length, 0);
});
