// Tests for Pantry: each person's food in real amounts, as measured things,
// counted things (whole units) and gauged ones (Full to Empty), any of them a staple.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps, sqlOne, run } from "./helpers.mjs";
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
  assert.deepEqual(guess("Whole wheat flour"), { kind: "measured", place: "Cupboard", perCup: 120 });
  assert.deepEqual(guess("Tomato soup"), { kind: "counted", place: "Cupboard", unit: "can" });
  assert.deepEqual(guess("Eggs"), { kind: "counted", place: "Fridge", unit: "egg" });
  assert.equal(guess("Ground cumin").kind, "gauged");
  assert.equal(guess("Vanilla extract").place, "Spice rack");
  assert.equal(guess("Jar of honey").kind, "counted", "a container makes it counted");
});

test("a measured thing keeps an exact amount, in the unit it was typed in; a staple needs a low point", async () => {
  const env = makeEnv(), kim = await member(env, "kim", "pantry");
  const noLow = await api(kim, "POST", "items", { name: "Whole wheat flour", staple: true, amount: "10 lb" });
  assert.equal(noLow.status, 400);
  assert.match(noLow.json.error, /running low/);
  assert.match((await api(kim, "POST", "items", { name: "Flour", kind: "measured", amount: "some", low: "2 lb" })).json.error, /number and a unit/);
  const flour = await add(kim, { name: "Whole wheat flour", staple: true, amount: "10 lb", low: "2 lb", expires: "2027-05-10" });
  assert.equal(flour.kind, "measured");
  assert.equal(flour.staple, true);
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
  assert.equal((await api(kim, "POST", `items/${cumin.id}/use`, { level: 1 })).json.is_low, false, "only a staple runs low");
  // A gauged staple runs low at the mark you pick.
  const staple = (await api(kim, "PATCH", `items/${cumin.id}`, { staple: true, low: "½ left" })).json;
  assert.equal(staple.staple, true);
  assert.equal(staple.low_text, "½ left");
  assert.equal(staple.is_low, true);
  assert.match((await api(kim, "PATCH", `items/${cumin.id}`, { low: "a bit" })).json.error, /level/);
  assert.match((await api(kim, "POST", `items/${cumin.id}/use`, { amount: "1 tsp" })).json.error, /how full/);
  assert.match((await api(kim, "POST", `items/${cumin.id}/lots`, { amount: "1" })).json.error, /how full/);
  assert.equal((await api(kim, "PATCH", `items/${cumin.id}`, { level: 5 })).json.text, "Full");
  assert.equal((await api(kim, "POST", `items/${cumin.id}/use`, { tossed: true })).json.is_out, true);
});

test("an item can change kind, starting again from what you have now", async () => {
  const env = makeEnv(), kim = await member(env, "kim", "pantry");
  const rice = await add(kim, { name: "Rice", amount: "5 lb", low: "1 lb", expires: "2028-01-01" });
  assert.match((await api(kim, "PATCH", `items/${rice.id}`, { kind: "counted" })).json.error, /how many/);
  // A staple's low point is in its kind's terms, so a new kind needs a new one.
  assert.match((await api(kim, "PATCH", `items/${rice.id}`, { kind: "counted", amount: 2, unit: "bags" })).json.error, /running low/);
  const bags = (await api(kim, "PATCH", `items/${rice.id}`, { kind: "counted", amount: 2, unit: "bags", size: "2 lb", low: 1 })).json;
  assert.equal(bags.low_text, "1 bag");
  assert.equal(bags.text, "2 bags");
  assert.equal(bags.size, "2 lb");
  assert.equal(bags.expires, "2028-01-01", "the soonest expiry carries over");
  const back = (await api(kim, "PATCH", `items/${rice.id}`, { kind: "staple", amount: "4 lb", low: "1 lb" })).json;
  assert.equal(back.text, "4 lb");
  assert.equal(back.per_cup, 198);
  const gauged = (await api(kim, "PATCH", `items/${rice.id}`, { kind: "gauged", low: "Almost out" })).json;
  assert.equal(gauged.text, "Full");
});

test("staple is a tag on any kind: it adds a low point, in that kind's terms", async () => {
  const env = makeEnv(), kim = await member(env, "kim", "pantry");
  // Not a staple: no low point, and never low, only out.
  const sugar = await add(kim, { name: "Sugar", amount: "2 lb" });
  assert.equal(sugar.staple, false);
  assert.equal(sugar.low, null);
  assert.equal(sugar.low_text, "");
  // Counted: low at a number of them.
  const soup = await add(kim, { name: "Tomato soup", staple: true, amount: 3, low: 2 });
  assert.equal(soup.low_text, "2 cans");
  assert.equal(soup.is_low, false);
  assert.equal((await api(kim, "POST", `items/${soup.id}/use`, { amount: 1 })).json.is_low, true);
  assert.match((await api(kim, "PATCH", `items/${soup.id}`, { low: "2 lb" })).json.error, /number of cans/);
  assert.equal((await api(kim, "PATCH", `items/${soup.id}`, { staple: true, low: "2 cans" })).json.low_text, "2 cans", "its own text is taken back");
  // Gauged: low at a mark, by name or by number.
  const vanilla = await add(kim, { name: "Vanilla extract", staple: true, low: "¾ left" });
  assert.equal(vanilla.low, 4);
  assert.equal(vanilla.is_low, false);
  assert.equal((await api(kim, "POST", `items/${vanilla.id}/use`, { level: 4 })).json.is_low, true);
  // Turned on later, it asks for the low point; turned off, it's gone.
  assert.match((await api(kim, "PATCH", `items/${sugar.id}`, { staple: true })).json.error, /running low/);
  const on = (await api(kim, "PATCH", `items/${sugar.id}`, { staple: true, low: "2 lb" })).json;
  assert.equal(on.is_low, true, "at the low point counts as low");
  const off = (await api(kim, "PATCH", `items/${sugar.id}`, { staple: false })).json;
  assert.equal(off.staple, false);
  assert.equal(off.low_text, "");
  assert.equal(off.is_low, false);
  // An item saved when staple was a kind reads as a measured staple, and "staple" is still taken as a kind.
  const old = JSON.parse(sqlOne(env, "SELECT data FROM pantry_items WHERE id = ?", on.id).data);
  run(env, "UPDATE pantry_items SET data = ? WHERE id = ?", JSON.stringify({ ...old, kind: "staple", staple: undefined, low: 453.592 }), on.id);
  const was = (await api(kim, "GET", "items")).json.items.find(i => i.id === on.id);
  assert.equal(was.kind, "measured");
  assert.equal(was.staple, true);
  assert.equal(was.low_text, "1 lb");
  const flour = await add(kim, { name: "Flour", kind: "staple", amount: "5 lb", low: "1 lb" });
  assert.deepEqual([flour.kind, flour.staple], ["measured", true]);
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

test("a pantry can be shared as a household's: use takes things out, stock also adds, only the owner changes it", async () => {
  const env = makeEnv(), kim = await member(env, "kim", "pantry"), sam = await member(env, "sam", "pantry"), joe = await member(env, "joe", "pantry");
  await member(env, "nopantry");
  const flour = await add(kim, { name: "Flour", amount: "10 lb", low: "2 lb" });
  const soup = await add(kim, { name: "Tomato soup", amount: 3 });
  // Shared by username, with someone who has Pantry.
  assert.match((await api(kim, "PUT", "shares", { username: "nopantry" })).json.error, /no one with Pantry/);
  assert.match((await api(kim, "PUT", "shares", { username: "kim" })).json.error, /that's you/);
  assert.match((await api(kim, "PUT", "shares", { username: "sam", role: "boss" })).json.error, /role is use/);
  const shared = (await api(kim, "PUT", "shares", { username: "sam" })).json;
  assert.deepEqual(shared.shares.map(s => [s.username, s.role]), [["sam", "use"]]);
  await api(kim, "PUT", "shares", { username: "@Joe", role: "stock" });
  assert.deepEqual((await api(sam, "GET", "shares")).json.shared.map(s => [s.username, s.role]), [["kim", "use"]]);
  // sam sees kim's pantry with ?of=, and his own without.
  const theirs = (await api(sam, "GET", "items?of=kim")).json;
  assert.deepEqual(theirs.items.map(i => i.name), ["Flour", "Tomato soup"]);
  assert.deepEqual(theirs.pantry, { owner: "kim", name: "kim", role: "use" });
  assert.deepEqual((await api(sam, "GET", "items")).json.items, []);
  assert.equal((await api(joe, "GET", "items?of=sam")).status, 404, "not shared with joe");
  // "use" takes things out of it, for everyone.
  assert.equal((await api(sam, "POST", `items/${soup.id}/use?of=kim`, { amount: 1 })).json.text, "2 cans");
  assert.equal((await api(kim, "GET", "items")).json.items.find(i => i.id === soup.id).text, "2 cans");
  // ...but can't add, change or share it.
  assert.equal((await api(sam, "POST", `items/${soup.id}/lots?of=kim`, { amount: 1 })).status, 403);
  assert.equal((await api(sam, "POST", "add?of=kim", { lines: [{ item: soup.id, amount: "1" }] })).status, 403);
  assert.match((await api(sam, "PATCH", `items/${soup.id}?of=kim`, { name: "Soup" })).json.error, /only the pantry's owner/);
  assert.equal((await api(sam, "DELETE", `items/${soup.id}?of=kim`)).status, 403);
  assert.equal((await api(sam, "POST", "items?of=kim", { name: "Rice", amount: "1 lb" })).status, 403);
  assert.equal((await api(sam, "GET", "scanners?of=kim")).status, 403);
  // "stock" can also add what's bought.
  assert.equal((await api(joe, "POST", `items/${soup.id}/lots?of=kim`, { amount: 2 })).json.text, "4 cans");
  const added = (await api(joe, "POST", "add?of=kim", { lines: [{ key: "a", item: flour.id, amount: "5 lb" }, { key: "b", name: "Rice", amount: "2 lb" }] })).json;
  assert.deepEqual(added.failed, [], JSON.stringify(added));
  assert.deepEqual((await api(kim, "GET", "items")).json.items.map(i => [i.name, i.text]), [["Flour", "15 lb"], ["Rice", "2 lb"], ["Tomato soup", "4 cans"]]);
  assert.match((await api(joe, "PATCH", `items/${flour.id}?of=kim`, { low: "1 lb" })).json.error, /owner/);
  // Sharing both ways, stopping one leaves the other.
  await api(sam, "PUT", "shares", { username: "kim" });
  assert.deepEqual((await api(kim, "DELETE", "shares/sam")).json.shared.map(p => p.username), ["sam"]);
  await api(kim, "PUT", "shares", { username: "sam" });
  // Leaving, or being taken off, ends it.
  assert.deepEqual((await api(sam, "DELETE", "shared/kim")).json.shared, []);
  assert.equal((await api(sam, "GET", "items?of=kim")).status, 404);
  assert.deepEqual((await api(kim, "DELETE", "shares/joe")).json.shares, []);
  assert.equal((await api(joe, "POST", `items/${soup.id}/use?of=kim`, { amount: 1 })).status, 404);
  assert.equal((await api(kim, "DELETE", "shares/joe")).status, 404);
});
