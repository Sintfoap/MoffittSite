// Tests for Meal plan: busy nights from the Drift calendar, filling a week
// from the Recipe box, and sending the week's shopping to a Drift list.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps, sqlOne, run } from "./helpers.mjs";
import { minutesOf, mondayOf, nightsOut, fillWeek, shoppingFor } from "../src/meals.js";

const WEEK = ["2030-01-07", "2030-01-08", "2030-01-09", "2030-01-10", "2030-01-11", "2030-01-12", "2030-01-13"];
const ev = (title, start, end = null, done = false) => ({ title, meta: { event: { start, end }, ...(done ? { checklist: { done: true } } : {}) } });

test("how long a recipe takes, from what Recipe box keeps", () => {
  assert.equal(minutesOf("1 hr 5 min"), 65);
  assert.equal(minutesOf("45 mins"), 45);
  assert.equal(minutesOf("1½ hours"), 90);
  assert.equal(minutesOf("PT20M"), 20);
  assert.equal(minutesOf("20m"), 20);
  assert.equal(minutesOf(""), null);
  assert.equal(minutesOf("overnight"), null);
});

test("weeks start on Monday", () => {
  assert.equal(mondayOf("2030-01-07"), "2030-01-07");
  assert.equal(mondayOf("2030-01-13"), "2030-01-07");
  assert.equal(mondayOf("2030-01-01"), "2029-12-31");
  assert.throws(() => mondayOf("2030-02-30"));
});

test("a night is busy with something on in the evening, or a packed day", () => {
  const out = nightsOut([
    ev("Soccer", "2030-01-07T18:00", "2030-01-07T19:30"),
    ev("Dentist", "2030-01-08T09:00"),
    ev("Lunch", "2030-01-08T12:00"),
    ev("Ends at four", "2030-01-08T15:00", "2030-01-08T16:00"),
    ev("Runs late", "2030-01-09T14:00", "2030-01-09T17:00"),
    ev("A", "2030-01-10T08:00"), ev("B", "2030-01-10T10:00"), ev("C", "2030-01-10T12:00"),
    ev("Trip", "2030-01-11", "2030-01-12"),
    ev("Done already", "2030-01-13T18:00", null, true),
  ], WEEK);
  assert.deepEqual([out["2030-01-07"].busy, out["2030-01-07"].why], [true, "Soccer at 6 pm"]);
  assert.equal(out["2030-01-08"].busy, true, "three timed things");
  assert.equal(out["2030-01-09"].busy, true, "it runs into the evening");
  assert.equal(out["2030-01-10"].busy, true);
  assert.equal(out["2030-01-11"].busy, false, "an all-day event isn't an evening");
  assert.deepEqual(out["2030-01-12"].events.map(e => e.title), ["Trip"], "it covers every day it spans");
  assert.deepEqual(out["2030-01-13"].events, [], "done items don't count");
});

const R = (id, time, servings = 4, ingredients = []) => ({ id, title: id, time, servings, ingredients });

test("filling a week: quick recipes on busy nights, no repeats, locked and out nights left alone", () => {
  const recipes = [R("quick1", "20 min"), R("quick2", "25 min"), R("slow1", "1 hr"), R("slow2", "2 hr"), R("slow3", ""), R("slow4", "45 min"), R("slow5", "50 min")];
  const nights = Object.fromEntries(WEEK.map(d => [d, { recipe: null, servings: null, out: false, locked: false }]));
  nights["2030-01-12"] = { recipe: "slow1", servings: 2, out: false, locked: true };
  nights["2030-01-13"].out = true;
  const busy = { "2030-01-07": { busy: true }, "2030-01-09": { busy: true } };
  for (let i = 0; i < 20; i++) {
    const got = fillWeek(nights, WEEK, busy, recipes);
    assert.match(got["2030-01-07"].recipe, /^quick/);
    assert.match(got["2030-01-09"].recipe, /^quick/);
    assert.deepEqual(got["2030-01-12"], nights["2030-01-12"]);
    assert.equal(got["2030-01-13"].recipe, null);
    const picked = WEEK.map(d => got[d].recipe).filter(Boolean);
    assert.equal(new Set(picked).size, picked.length, "no recipe twice");
    assert.equal(got["2030-01-08"].servings, 4, "a recipe's own servings");
  }
  // With no quick recipe, a busy night gets the quickest there is.
  const got = fillWeek(nights, WEEK, busy, [R("slow1", "1 hr"), R("slow2", "2 hr"), R("x", "")]);
  assert.equal(got["2030-01-07"].recipe, "slow1");
  // Last week's dinners only once nothing else is left.
  const again = fillWeek(nights, WEEK, {}, [R("a", ""), R("b", "")], new Set(["a"]));
  assert.equal(again["2030-01-07"].recipe, "b");
});

test("the week's shopping is scaled to each night, with lines shared between recipes listed once", () => {
  const byId = new Map([
    ["p", R("p", "", 4, ["2 cups flour", "salt to taste"])],
    ["s", R("s", "", 2, ["1 onion", "Salt to taste"])],
  ]);
  const nights = Object.fromEntries(WEEK.map(d => [d, { recipe: null, servings: null, out: false, locked: false }]));
  nights["2030-01-07"] = { recipe: "p", servings: 8, out: false, locked: false };
  nights["2030-01-08"] = { recipe: "s", servings: 2, out: false, locked: false };
  nights["2030-01-09"] = { recipe: "s", servings: 2, out: true, locked: false };
  assert.deepEqual(shoppingFor(nights, WEEK, byId), [
    { line: "4 cups flour", for: ["p (Mon)"] },
    { line: "salt to taste", for: ["p (Mon)", "s (Tue)"] },
    { line: "1 onion", for: ["s (Tue)"] },
  ]);
});

// ── the API ────────────────────────────────────────────────────────────────

const api = (b, method, path, json) => b.req(method, "/meals/api/" + path, { json });

async function cook(env, name = "ryan") {
  const b = new Browser(env);
  await b.signup(name);
  grantApps(env, name, "recipes", "meals");
  return b;
}

test("Meal plan is off until an admin turns it on", async () => {
  const env = makeEnv(), josh = new Browser(env);
  await josh.signup("josh");
  assert.equal((await josh.get("/meals/")).status, 403);
  assert.equal((await josh.get("/meals/api/week")).status, 403);
  grantApps(env, "josh", "meals");
  assert.equal((await josh.get("/meals/")).status, 200);
  assert.equal((await josh.get("/meals")).status, 308);
  const week = (await josh.get("/meals/api/week?start=2030-01-09")).json;
  assert.equal(week.start, "2030-01-07");
  assert.deepEqual(week.days.map(d => d.name), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  assert.equal(week.recipe_box, false);
  assert.match((await api(josh, "POST", "week/2030-01-07/fill", {})).json.error, /Recipe box/);
});

test("planning a week around the calendar, changing a night, and shopping for it", async () => {
  const env = makeEnv(), ryan = await cook(env);
  const add = async (title, time, ingredients, servings = 4) =>
    (await ryan.req("POST", "/recipes/api/recipes", { json: { title, time, ingredients, servings } })).json;
  const tacos = await add("Tacos", "20 min", ["1 lb beef", "8 tortillas"]);
  const stew = await add("Stew", "2 hr", ["2 lb beef chuck", "3 carrots"]);
  await add("Lasagna", "1 hr 30 min", ["1 box noodles"]);
  const inbox = (await ryan.get("/todo/api/state")).json.collections[0].id;
  const made = await ryan.req("POST", "/todo/api/items", { json: { title: "Soccer practice", collection: inbox, meta: { event: { start: "2030-01-08T17:30", end: "2030-01-08T19:00" } } } });
  assert.equal(made.status, 201, made.text);

  const week = (await api(ryan, "GET", "week?start=2030-01-08")).json;
  const tue = week.days[1];
  assert.equal(tue.busy, true);
  assert.equal(tue.why, "Soccer practice at 5:30 pm");
  assert.deepEqual(week.recipes.map(r => [r.title, r.quick]), [["Lasagna", false], ["Stew", false], ["Tacos", true]]);

  const filled = (await api(ryan, "POST", "week/2030-01-07/fill", {})).json;
  assert.equal(filled.days[1].recipe, tacos.id, "the busy night gets the quick one");
  assert.equal(filled.days.filter(d => d.recipe).length, 7, "three recipes, seven nights: repeats once they run out");

  // Picking a night yourself locks it; shuffling leaves it alone.
  let w = (await api(ryan, "PUT", "week/2030-01-07/2030-01-07", { recipe: stew.id, servings: 8 })).json;
  assert.deepEqual([w.days[0].recipe, w.days[0].servings, w.days[0].locked], [stew.id, 8, true]);
  for (const d of w.days.slice(2)) w = (await api(ryan, "PUT", `week/2030-01-07/${d.day}`, { out: true })).json;
  w = (await api(ryan, "POST", "week/2030-01-07/fill", { redo: true })).json;
  assert.equal(w.days[0].recipe, stew.id);
  assert.equal(w.days[1].recipe, tacos.id);
  // A busy night with a slow recipe is flagged.
  w = (await api(ryan, "PUT", "week/2030-01-07/2030-01-08", { recipe: stew.id })).json;
  assert.equal(w.days[1].slow, true);
  w = (await api(ryan, "PUT", "week/2030-01-07/2030-01-08", { recipe: tacos.id, servings: 2 })).json;
  assert.deepEqual(w.shopping.map(s => s.line), ["4 lb beef chuck", "6 carrots", "½ lb beef", "4 tortillas"]);

  // Bad requests.
  assert.equal((await api(ryan, "PUT", "week/2030-01-08/2030-01-08", { out: true })).status, 400, "not a Monday");
  assert.equal((await api(ryan, "PUT", "week/2030-01-07/2030-01-20", { out: true })).status, 400, "not in the week");
  assert.equal((await api(ryan, "PUT", "week/2030-01-07/2030-01-08", { recipe: "r_0000000000" })).status, 400);
  assert.equal((await api(ryan, "PUT", "week/2030-01-07/2030-01-08", { color: "red" })).status, 400);
  assert.equal((await ryan.req("PUT", "/meals/api/week/2030-01-07/2030-01-08", { json: { out: true }, origin: "https://evil.test" })).status, 403);

  // Shopping: skip the carrots; the rest go to a new Shopping list, noting which dinners they're for.
  const sent = await api(ryan, "POST", "week/2030-01-07/shop", { lines: [0, 2, 3] });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.added, 3);
  assert.equal(sent.json.list.name, "Shopping list");
  const items = (await ryan.get("/todo/api/state")).json.items.filter(i => i.collection === sent.json.list.id);
  assert.deepEqual(items.map(i => i.title).sort(), ["4 lb beef chuck", "4 tortillas", "½ lb beef"]);
  assert.equal(items.find(i => i.title === "4 tortillas").notes, "For Tacos (Tue)");
  assert.equal((await api(ryan, "GET", "week?start=2030-01-07")).json.shopped.added, 3);

  // Weeks are kept apart, and other people can't see yours.
  assert.equal((await api(ryan, "GET", "week?start=2030-01-14")).json.days.every(d => !d.recipe), true);
  const sam = await cook(env, "sam");
  assert.equal((await api(sam, "GET", "week?start=2030-01-07")).json.days.every(d => !d.recipe), true);
});

test("without Drift there's no calendar and nothing to shop into", async () => {
  const env = makeEnv(), b = new Browser(env);
  await b.signup("kim");
  grantApps(env, "kim", "recipes", "meals");
  await b.req("POST", "/recipes/api/recipes", { json: { title: "Soup", ingredients: ["1 onion"] } });
  run(env, "DELETE FROM user_areas WHERE user_id = ? AND area = 'todo'", sqlOne(env, "SELECT id FROM users WHERE username = 'kim'").id);
  const w = (await api(b, "POST", "week/2030-01-07/fill", {})).json;
  assert.equal(w.drift, false);
  assert.equal(w.days.filter(d => d.recipe).length, 7);
  assert.match((await api(b, "POST", "week/2030-01-07/shop", {})).json.error, /Drift/);
});
