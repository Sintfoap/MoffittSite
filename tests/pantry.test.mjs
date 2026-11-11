// Tests for Pantry: each person's food in real amounts, as staples (measured),
// counted things (whole units) and gauged ones (Full to Empty).
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps } from "./helpers.mjs";
import { readAmount, inUnit, guess, plural, singular } from "../public/pantry/units.js";

async function member(env, name, ...apps) {
  const b = new Browser(env);
  await b.signup(name);
  if (apps.length) grantApps(env, name, ...apps);
  return b;
}
const api = (b, method, path, json) => b.req(method, "/pantry/api/" + path, { json });
const add = async (b, item) => {
  const res = await api(b, "POST", "items", item);
  assert.equal(res.status, 201, res.text);
  return res.json;
};

test("Pantry is an app of its own, off until an admin turns it on", async () => {
  const env = makeEnv(), kim = await member(env, "kim");
  assert.equal((await kim.get("/pantry/")).status, 403);
  assert.equal((await api(kim, "GET", "items")).status, 403);
  grantApps(env, "kim", "pantry");
  assert.equal((await kim.get("/pantry/")).status, 200);
  assert.equal((await kim.get("/pantry")).status, 308);
  assert.deepEqual((await api(kim, "GET", "items")).json.items, []);
});

test("amounts are read with their units, and written back as a cook would", () => {
  assert.deepEqual(readAmount("10 lb"), { n: 10, unit: "lb" });
  assert.deepEqual(readAmount("2 1/2 cups"), { n: 2.5, unit: "cup" });
  assert.deepEqual(readAmount("1½ Tbsp."), { n: 1.5, unit: "tbsp" });
  assert.deepEqual(readAmount("500g"), { n: 500, unit: "g" });
  assert.deepEqual(readAmount("2 fl. oz"), { n: 2, unit: "floz" });
  assert.deepEqual(readAmount("3"), { n: 3, unit: null });
  assert.deepEqual(readAmount("3 cans"), { n: 3, unit: null, word: "cans" });
  assert.equal(readAmount("some"), null);
  assert.equal(inUnit(4535.9237, "lb"), "10 lb");
  assert.equal(inUnit(236.5882365 * 1.5, "cup"), "1½ cups");
  assert.equal(inUnit(1234.4, "g"), "1234 g");
  assert.equal(plural("box"), "boxes");
  assert.equal(plural("loaf"), "loaves");
  assert.equal(singular("cans"), "can");
});

test("a new item's kind, place and grams per cup are guessed from its name", () => {
  assert.deepEqual(guess("Whole wheat flour"), { kind: "staple", place: "Cupboard", perCup: 120 });
  assert.deepEqual(guess("Tomato soup"), { kind: "counted", place: "Cupboard", unit: "can" });
  assert.deepEqual(guess("Eggs"), { kind: "counted", place: "Fridge", unit: "egg" });
  assert.equal(guess("Ground cumin").kind, "gauged");
  assert.equal(guess("Vanilla extract").place, "Spice rack");
  assert.equal(guess("Jar of honey").kind, "counted", "a container makes it counted");
});

test("a staple keeps an exact amount, in the unit it was typed in, and needs a low point", async () => {
  const env = makeEnv(), kim = await member(env, "kim", "pantry");
  const noLow = await api(kim, "POST", "items", { name: "Whole wheat flour", amount: "10 lb" });
  assert.equal(noLow.status, 400);
  assert.match(noLow.json.error, /running low/);
  assert.match((await api(kim, "POST", "items", { name: "Flour", kind: "staple", amount: "some", low: "2 lb" })).json.error, /number and a unit/);
  const flour = await add(kim, { name: "Whole wheat flour", amount: "10 lb", low: "2 lb", expires: "2027-05-10" });
  assert.equal(flour.kind, "staple");
  assert.equal(flour.measure, "weight");
  assert.equal(flour.text, "10 lb");
  assert.equal(flour.low_text, "2 lb");
  assert.equal(flour.per_cup, 120, "guessed from the name");
  assert.equal(flour.place, "Cupboard");
  // Cups come off a bag weighed in pounds, by its grams per cup: 3 cups is 360 g.
  const after = (await api(kim, "POST", `items/${flour.id}/use`, { amount: "3 cups" })).json;
  assert.equal(Math.round(after.left), 4536 - 360);
  assert.equal(after.text, "9.21 lb");
  // More than there is is refused; all of it empties it.
  assert.match((await api(kim, "POST", `items/${flour.id}/use`, { amount: "20 lb" })).json.error, /only 9.21 lb/);
  const gone = (await api(kim, "POST", `items/${flour.id}/use`, { all: true })).json;
  assert.equal(gone.left, 0);
  assert.equal(gone.is_out, true);
  // The same name twice is refused, whatever its case.
  assert.match((await api(kim, "POST", "items", { name: "whole WHEAT flour", amount: "1 lb", low: "1 lb" })).json.error, /already in your pantry/);
});

test("a staple measured by volume, and one with no grams per cup, says what it needs", async () => {
  const env = makeEnv(), kim = await member(env, "kim", "pantry");
  const oil = await add(kim, { name: "Olive oil", amount: "1 L", low: "1 cup" });
  assert.equal(oil.measure, "volume");
  assert.equal(oil.text, "1 L");
  const thing = await add(kim, { name: "Mystery grain", kind: "staple", amount: "2 kg", low: "500 g" });
  assert.equal(thing.per_cup, null);
  assert.match((await api(kim, "POST", `items/${thing.id}/use`, { amount: "1 cup" })).json.error, /grams a cup/);
  const set = (await api(kim, "PATCH", `items/${thing.id}`, { per_cup: 200, shows: "g" })).json;
  assert.equal(set.text, "2000 g");
  assert.equal((await api(kim, "POST", `items/${thing.id}/use`, { amount: "1 cup" })).json.text, "1800 g");
});

test("low and soon are worked out for the viewer's own day", async () => {
  const env = makeEnv(), kim = await member(env, "kim", "pantry");
  const sugar = await add(kim, { name: "Sugar", amount: "4 lb", low: "2 lb" });
  await add(kim, { name: "Milk", kind: "staple", amount: "1 gallon", low: "1 quart", expires: "2026-11-14" });
  let list = (await api(kim, "GET", "items?day=2026-11-11")).json;
  assert.deepEqual(list.items.map(i => i.name), ["Milk", "Sugar"]);
  assert.deepEqual(list.places, ["Fridge", "Cupboard"]);
  assert.deepEqual(list.counts, { all: 2, soon: 1, low: 0 });
  assert.equal(list.items[0].soon, true);
  assert.equal(list.items[0].expired, false);
  await api(kim, "POST", `items/${sugar.id}/use`, { amount: "2 lb" });
  list = (await api(kim, "GET", "items?day=2026-11-20")).json;
  assert.equal(list.items.find(i => i.name === "Milk").expired, true);
  assert.equal(list.items.find(i => i.name === "Sugar").is_low, true, "at the low point counts as low");
  assert.deepEqual(list.counts, { all: 2, soon: 1, low: 1 });
});

test("counted things go by whole units: half a can still uses the can", async () => {
  const env = makeEnv(), kim = await member(env, "kim", "pantry");
  const soup = await add(kim, { name: "Tomato soup", amount: 2, size: "16 oz", expires: "2027-03-01" });
  assert.equal(soup.kind, "counted");
  assert.equal(soup.unit, "can");
  assert.equal(soup.text, "2 cans");
  // Another purchase, sooner to expire: it's used first.
  const more = await api(kim, "POST", `items/${soup.id}/lots`, { amount: "1", expires: "2027-01-01" });
  assert.equal(more.status, 201, more.text);
  assert.equal(more.json.text, "3 cans");
  assert.deepEqual(more.json.lots.map(l => l.expires), ["2027-01-01", "2027-03-01"]);
  assert.equal(more.json.expires, "2027-01-01");
  const half = (await api(kim, "POST", `items/${soup.id}/use`, { amount: 0.5 })).json;
  assert.equal(half.text, "2 cans");
  assert.deepEqual(half.lots.map(l => l.expires), ["2027-03-01"]);
  assert.match((await api(kim, "POST", `items/${soup.id}/use`, { amount: "1 cup" })).json.error, /number of cans/);
  // A counted item is never "low", only out.
  const one = (await api(kim, "POST", `items/${soup.id}/use`, { amount: 1 })).json;
  assert.equal(one.is_low, false);
  const eggs = await add(kim, { name: "Eggs", amount: "12" });
  assert.equal(eggs.unit, "egg");
  assert.equal(eggs.place, "Fridge");
  assert.equal((await api(kim, "POST", `items/${eggs.id}/use`, { amount: 1 })).json.text, "11 eggs");
});

test("gauged things slide from Full to Empty, and recipes never take from them", async () => {
  const env = makeEnv(), kim = await member(env, "kim", "pantry");
  const cumin = await add(kim, { name: "Ground cumin" });
  assert.equal(cumin.kind, "gauged");
  assert.equal(cumin.text, "Full");
  assert.equal(cumin.place, "Spice rack");
  assert.equal((await api(kim, "POST", `items/${cumin.id}/use`, { level: "½ left" })).json.text, "½ left");
  assert.equal((await api(kim, "POST", `items/${cumin.id}/use`, { level: 1 })).json.is_low, true);
  assert.match((await api(kim, "POST", `items/${cumin.id}/use`, { amount: "1 tsp" })).json.error, /how full/);
  assert.match((await api(kim, "POST", `items/${cumin.id}/lots`, { amount: "1" })).json.error, /how full/);
  assert.equal((await api(kim, "PATCH", `items/${cumin.id}`, { level: 5 })).json.text, "Full");
  assert.equal((await api(kim, "POST", `items/${cumin.id}/use`, { tossed: true })).json.is_out, true);
});

test("an item can change kind, starting again from what you have now", async () => {
  const env = makeEnv(), kim = await member(env, "kim", "pantry");
  const rice = await add(kim, { name: "Rice", amount: "5 lb", low: "1 lb", expires: "2028-01-01" });
  assert.match((await api(kim, "PATCH", `items/${rice.id}`, { kind: "counted" })).json.error, /how many/);
  const bags = (await api(kim, "PATCH", `items/${rice.id}`, { kind: "counted", amount: 2, unit: "bags", size: "2 lb" })).json;
  assert.equal(bags.text, "2 bags");
  assert.equal(bags.size, "2 lb");
  assert.equal(bags.expires, "2028-01-01", "the soonest expiry carries over");
  const back = (await api(kim, "PATCH", `items/${rice.id}`, { kind: "staple", amount: "4 lb", low: "1 lb" })).json;
  assert.equal(back.text, "4 lb");
  assert.equal(back.per_cup, 198);
  const gauged = (await api(kim, "PATCH", `items/${rice.id}`, { kind: "gauged" })).json;
  assert.equal(gauged.text, "Full");
});

test("purchases can be corrected or taken off, and items renamed, moved or removed", async () => {
  const env = makeEnv(), kim = await member(env, "kim", "pantry"), sam = await member(env, "sam", "pantry");
  const flour = await add(kim, { name: "Flour", amount: "5 lb", low: "1 lb" });
  const lot = flour.lots[0].id;
  assert.equal((await api(kim, "PATCH", `items/${flour.id}/lots/${lot}`, { amount: "4 lb", expires: "2027-02-02" })).json.text, "4 lb");
  assert.equal((await api(kim, "PATCH", `items/${flour.id}`, { name: "Bread flour", place: "freezer" })).json.place, "Freezer");
  // Someone else's pantry is their own.
  assert.equal((await api(sam, "GET", "items")).json.items.length, 0);
  assert.equal((await api(sam, "PATCH", `items/${flour.id}`, { name: "Mine" })).status, 404);
  assert.equal((await api(sam, "DELETE", `items/${flour.id}`)).status, 404);
  assert.equal((await api(kim, "DELETE", `items/${flour.id}/lots/${lot}`)).json.text, "0 lb");
  assert.deepEqual((await api(kim, "DELETE", `items/${flour.id}`)).json, { removed: true });
  assert.equal((await api(kim, "GET", "items")).json.items.length, 0);
});

test("the dashboard's card says what needs looking at", async () => {
  const env = makeEnv(), kim = await member(env, "kim", "pantry");
  const line = async () => (await kim.req("GET", "/dashboard")).text;
  assert.match(await line(), /Nothing in your pantry yet/);
  await add(kim, { name: "Cumin" });
  assert.match(await line(), /1 thing in your pantry/);
});
