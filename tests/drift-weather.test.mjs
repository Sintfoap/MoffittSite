// Tests for Drift's Weather plugin: the forecast the site gets from Open-Meteo
// (src/weather.js), outdoor items, and when a day counts as wet.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, ORIGIN } from "./helpers.mjs";
import worker from "../src/worker.js";
import weather, { sky, wet, temp, wetOn, forecastAt } from "../public/todo/plugins/weather.js";
import { today, addDays } from "../public/todo/lib.js";

const DAYS = [today(), addDays(1), addDays(2)];
const DAILY = { time: DAYS, weather_code: [0, 63, 3], temperature_2m_max: [21.4, 15, 18], temperature_2m_min: [9, 8.2, 7],
  precipitation_probability_max: [5, 80, 20], precipitation_sum: [0, 6.4, 0.3] };
let asked, realFetch, down;
beforeEach(() => {
  asked = []; down = false; realFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : String(input), ORIGIN);
    if (url.hostname !== "api.open-meteo.com") return new Response("not found", { status: 404 });
    asked.push(url);
    if (down) throw new TypeError("fetch failed");
    return Response.json({ daily: DAILY });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function signedIn(env) {
  const b = new Browser(env);
  assert.equal((await b.signup("ryan")).status, 303);
  return b;
}
const api = (b, method, path, json) => b.req(method, "/todo/api/" + path, json === undefined ? {} : { json });

test("the site gets 16 days of forecast for a spot, rounded to about a kilometre", async () => {
  const b = await signedIn(makeEnv());
  const r = await api(b, "GET", "weather?lat=37.79551&lng=-122.39371");
  assert.equal(r.status, 200);
  assert.equal(r.json.lat, 37.8); assert.equal(r.json.lng, -122.39); assert.equal(r.json.near, false);
  assert.deepEqual(r.json.days[1], { day: DAYS[1], code: 63, hi: 15, lo: 8.2, rain: 80, precip: 6.4 });
  assert.equal(asked[0].searchParams.get("latitude"), "37.8");
  assert.equal(asked[0].searchParams.get("forecast_days"), "16");
  assert.equal(asked[0].searchParams.get("timezone"), "auto");

  assert.equal((await api(b, "GET", "weather?lat=95&lng=0")).status, 400);
  assert.equal((await api(b, "GET", "weather?lat=10")).status, 400, "lat without lng");
  assert.equal((await api(b, "POST", "weather", {})).status, 404);
  down = true;
  assert.equal((await api(b, "GET", "weather?lat=1&lng=2")).status, 502);
  assert.equal((await new Browser(makeEnv()).req("GET", "/todo/api/weather")).status, 401, "signed out");
});

test("with no spot it's near where the request came from, or nowhere", async () => {
  const env = makeEnv(), b = await signedIn(env);
  // No request.cf here (as in tests and previews): nothing to ask about.
  assert.deepEqual((await api(b, "GET", "weather")).json, { lat: null, lng: null, near: true, days: [] });
  assert.equal(asked.length, 0);
  // Cloudflare's guess at where the request came from.
  const req = new Request(ORIGIN + "/todo/api/weather", { headers: { Cookie: `__Host-sid=${b.cookie}`, "CF-Connecting-IP": b.ip } });
  Object.defineProperty(req, "cf", { value: { latitude: "51.5072", longitude: "-0.1276" } });
  const out = await (await worker.fetch(req, env)).json();
  assert.equal(out.near, true); assert.equal(out.lat, 51.51); assert.equal(out.days.length, 3);
});

test("outdoor items keep their flag; anything else is refused", async () => {
  const b = await signedIn(makeEnv());
  const col = (await api(b, "GET", "state")).json.collections[0];
  await api(b, "PATCH", `collections/${col.id}`, { plugins: [...col.plugins, "weather"] });
  const made = await api(b, "POST", "items", { title: "Picnic", collection: col.id, meta: { event: { start: DAYS[1] }, weather: {} } });
  assert.equal(made.status, 201);
  assert.deepEqual(made.json.meta.weather, { outdoor: true });
  const off = await api(b, "PATCH", `items/${made.json.id}`, { meta: { weather: { outdoor: false } } });
  assert.deepEqual(off.json.meta.weather, { outdoor: false });
  assert.equal((await api(b, "PATCH", `items/${made.json.id}`, { meta: { weather: { outdoor: "yes" } } })).status, 400);
  assert.equal((await api(b, "PATCH", `items/${made.json.id}`, { meta: { weather: [] } })).status, 400);
});

test("a day is wet with likely rain, plenty of it, or thunder", () => {
  assert.equal(wet({ code: 3, rain: 50, precip: 0 }), true);
  assert.equal(wet({ code: 3, rain: 20, precip: 2.5 }), true);
  assert.equal(wet({ code: 95, rain: 10, precip: 0 }), true);
  assert.equal(wet({ code: 61, rain: 30, precip: 0.4 }), false, "a passing drizzle of rain isn't a washout");
  assert.equal(wet(null), false);
  assert.deepEqual(sky(63), ["Rain", "🌧️"]);
  assert.deepEqual(sky(0)[0], "Clear");
  assert.equal(temp(21.4, false), "21°"); assert.equal(temp(21.4, true), "71°"); assert.equal(temp(null), "");
  assert.deepEqual(weather.fresh({ tags: ["family", "outside"] }), { outdoor: true });
  assert.equal(weather.fresh({ tags: ["family"] }), undefined);
  assert.deepEqual(weather.read({}), { outdoor: true }, "adding it to an item marks it outdoors");
  assert.deepEqual(weather.read({ outdoor: false }), { outdoor: false });
});

test("an outdoor item on a wet day gets a warning; indoors just the forecast", async () => {
  // The page asks the site; here the site's answer is handed straight back.
  globalThis.fetch = async () => Response.json({ lat: null, lng: null, near: true,
    days: DAYS.map((day, i) => ({ day, code: DAILY.weather_code[i], hi: DAILY.temperature_2m_max[i], lo: DAILY.temperature_2m_min[i], rain: DAILY.precipitation_probability_max[i], precip: DAILY.precipitation_sum[i] })) });
  let redrawn = 0;
  const picnic = { id: "i1", title: "Picnic", collection: "c1", meta: { event: { start: DAYS[1] }, weather: { outdoor: true } } };
  const movie = { id: "i2", title: "Movie", collection: "c1", meta: { event: { start: DAYS[1] }, weather: { outdoor: false } } };
  const sunny = { id: "i3", title: "Hike", collection: "c1", meta: { event: { start: DAYS[0] }, weather: { outdoor: true } } };
  const ctx = { collection: null, collections: [{ id: "c1", plugins: ["event", "weather"], bases: [] }], items: [picnic, movie, sunny], render: () => redrawn++, row: it => `<li>${it.title}</li>` };
  assert.equal(forecastAt(null, ctx.render), null, "nothing yet while it's asked");
  await new Promise(r => setTimeout(r, 10));
  assert.equal(redrawn, 1);
  assert.match(weather.chips(picnic, ctx)[0], /class="chip wx wet".*Rain, 80% chance/);
  assert.match(weather.chips(movie, ctx)[0], /class="chip wx"/);
  assert.match(weather.chips(sunny, ctx)[0], /☀️/);
  assert.equal(wetOn(picnic, DAYS[1], ctx), true);
  assert.equal(wetOn(picnic, DAYS[0], ctx), false, "not on a day it isn't on");
  assert.match(weather.day(DAYS[1], ctx), /class="wx warn"/);
  assert.match(weather.day(DAYS[1], ctx, true), /Looks wet for “Picnic”/);
  assert.doesNotMatch(weather.day(DAYS[0], ctx), /warn/);
  assert.match(weather.view.render(ctx), /An outdoor item on a wet day/);
  // Done items aren't warned about.
  const done = { ...picnic, meta: { ...picnic.meta, checklist: { done: true } } };
  assert.equal(wetOn(done, DAYS[1], ctx), false);
  assert.equal(redrawn, 1, "asked once, not on every draw");
});
