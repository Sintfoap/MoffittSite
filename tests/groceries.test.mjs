// Tests for Grocery autopilot: reading list and recipe lines, adding them up,
// and sending the order to Instacart and Kroger (stand-ins for both here).
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps, sql, sqlOne } from "./helpers.mjs";
import { parseLine, keyOf, combine } from "../src/groceries.js";

// Kroger and Instacart, as far as these tests go: every call is recorded.
let calls = [];
const real = globalThis.fetch;
const PRODUCTS = {
  flour: [{ productId: "0001111000001", upc: "0001111000001", description: "Kroger All Purpose Flour", brand: "Kroger",
    items: [{ size: "5 lb", price: { regular: 2.99, promo: 0 } }], images: [{ perspective: "front", sizes: [{ size: "thumbnail", url: "https://img.test/flour.jpg" }] }] },
    { productId: "0001111000002", upc: "0001111000002", description: "Gold Medal Flour", brand: "Gold Medal", items: [{ size: "5 lb" }] }],
  egg: [{ productId: "0001111000003", upc: "0001111000003", description: "Large Eggs, 12 ct", brand: "Kroger", items: [{ size: "12 ct", price: { regular: 3.49 } }] }],
  milk: [{ productId: "0001111000004", upc: "0001111000004", description: "2% Milk", brand: "Kroger", items: [{ size: "1 gal" }] }],
};
beforeEach(() => {
  calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input.url || input);
    if (url.host === "connect.instacart.com") {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return Response.json({ products_link_url: "https://customers.instacart.com/store/shopping_lists/123" });
    }
    if (url.host !== "api.kroger.com") return real(input, init);
    calls.push({ url, init, body: init.body });
    if (url.pathname === "/v1/connect/oauth2/token") {
      const form = new URLSearchParams(init.body);
      if (form.get("grant_type") === "client_credentials") return Response.json({ access_token: "site-token", expires_in: 1800 });
      if (form.get("code") === "bad") return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: "ryan-token", refresh_token: "ryan-refresh", expires_in: 1800 });
    }
    if (url.pathname === "/v1/locations") return Response.json({ data: [
      { locationId: "01400943", chain: "KROGER", name: "Kroger - Main St", address: { addressLine1: "1 Main St", city: "Cincinnati", state: "OH", zipCode: "45202" } }] });
    if (url.pathname === "/v1/locations/01400943") return Response.json({ data:
      { locationId: "01400943", chain: "KROGER", name: "Kroger - Main St", address: { addressLine1: "1 Main St", city: "Cincinnati", state: "OH", zipCode: "45202" } } });
    if (url.pathname === "/v1/products") {
      const term = url.searchParams.get("filter.term");
      return Response.json({ data: PRODUCTS[keyOf(term).split(" ").pop()] ?? [] });
    }
    if (url.pathname === "/v1/cart/add") return new Response(null, { status: init.headers.Authorization === "Bearer ryan-token" ? 204 : 401 });
    return new Response("{}", { status: 404 });
  };
});
afterEach(() => { globalThis.fetch = real; });

const STORES = { CHAT_BRIDGE_KEY: "test-bridge-key-0123456789", KROGER_CLIENT_ID: "kid", KROGER_CLIENT_SECRET: "ksecret", INSTACART_API_KEY: "ic-key" };
const g = (b, method, path, json) => b.req(method, "/groceries/api/" + path, json === undefined ? {} : { json });

// ryan with Drift, Recipe box and Grocery autopilot, a pancake recipe and a shopping list.
async function setup(extra = STORES) {
  const env = makeEnv(extra), ryan = new Browser(env);
  await ryan.signup("ryan", undefined, "Ryan");
  grantApps(env, "ryan", "recipes", "groceries");
  const recipe = (await ryan.req("POST", "/recipes/api/recipes", { json: { title: "Pancakes", yield: "4", ingredients:
    ["1 1/2 cups all-purpose flour, sifted", "2 large eggs", "1 cup milk", "salt to taste"] } })).json;
  const list = (await ryan.req("POST", "/todo/api/collections", { json: { name: "Shopping list", plugins: ["checklist", "list"] } })).json;
  for (const title of ["Eggs", "2 cups milk", "Coffee"]) {
    await ryan.req("POST", "/todo/api/items", { json: { title, collection: list.id, meta: { checklist: { done: false, priority: 0 } } } });
  }
  return { env, ryan, recipe, list };
}

test("lines are read for an amount, a unit and the thing to buy", () => {
  assert.deepEqual(parseLine("1 1/2 cups all-purpose flour, sifted"), { quantity: 1.5, unit: "cup", name: "all-purpose flour" });
  assert.deepEqual(parseLine("2 (15 oz) cans black beans, drained"), { quantity: 2, unit: "can", name: "black beans" });
  assert.deepEqual(parseLine("3 cloves garlic, minced"), { quantity: 3, unit: "clove", name: "garlic" });
  assert.deepEqual(parseLine("1 T butter"), { quantity: 1, unit: "tbsp", name: "butter" });
  assert.deepEqual(parseLine("2-3 large tomatoes"), { quantity: 3, unit: "", name: "tomatoes" });
  assert.deepEqual(parseLine("fresh basil for garnish"), { quantity: null, unit: "", name: "basil" });
  assert.deepEqual(parseLine("Coffee"), { quantity: null, unit: "", name: "Coffee" });
  assert.equal(keyOf("Tomatoes"), keyOf("tomato"));
  assert.equal(keyOf("Berries"), "berry");
  const [eggs, milk] = combine([{ text: "2 eggs", from: "A" }, { text: "Eggs", from: "List", item: "i_1" },
    { text: "1 cup milk", from: "A" }, { text: "2 cups milk", from: "B" }, { text: "1 tbsp milk", from: "B" }]);
  assert.equal(eggs.amount, "2");
  assert.deepEqual(eggs.from, ["A", "List"]);
  assert.deepEqual(eggs.items, ["i_1"]);
  assert.equal(milk.amount, "3 cup + 1 tbsp");
  assert.equal(milk.walmart, "https://www.walmart.com/search?q=milk");
});

test("Grocery autopilot is its own app, off until an admin turns it on", async () => {
  const env = makeEnv(), josh = new Browser(env);
  await josh.signup("josh");
  assert.equal((await josh.get("/groceries/")).status, 403);
  assert.equal((await josh.get("/groceries/api/state")).status, 403);
  grantApps(env, "josh", "groceries");
  const page = await josh.get("/groceries/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("Content-Security-Policy"), /script-src 'self'/);
  assert.equal((await josh.get("/groceries")).status, 308);
  assert.match((await josh.get("/dashboard")).text, /href="\/groceries\/"/);
  const st = (await g(josh, "GET", "state")).json;
  assert.equal(st.kroger.ready, false);
  assert.equal(st.instacart.ready, false);
  assert.deepEqual(st.lines, []);
});

test("the order is the shopping list plus picked recipes, scaled and added up, less the pantry", async () => {
  const { ryan, recipe, list } = await setup();
  let st = (await g(ryan, "GET", "state")).json;
  assert.equal(st.list.id, list.id, "your Shopping list is used when none is picked");
  assert.deepEqual(st.lines.map(l => l.name).sort(), ["Coffee", "Eggs", "milk"]);
  st = (await g(ryan, "PUT", "plan", { recipes: [{ id: recipe.id, servings: 8 }] })).json;
  const by = Object.fromEntries(st.lines.map(l => [l.key, l]));
  assert.equal(by.egg.amount, "4", "doubled from 2, and the list's Eggs joins it");
  assert.deepEqual(by.egg.from, ["Shopping list", "Pancakes"]);
  assert.equal(by.milk.amount, "4 cup");
  assert.equal(by["all purpose flour"].amount, "3 cup");
  assert.ok(!by.salt, "salt is in the pantry to start with");
  assert.ok(st.have.some(l => l.key === "salt"));
  st = (await g(ryan, "PUT", "pantry", { name: "Coffee", have: true })).json;
  assert.ok(!st.lines.some(l => l.key === "coffee"));
  st = (await g(ryan, "PUT", "pantry", { name: "coffee", have: false })).json;
  assert.ok(st.lines.some(l => l.key === "coffee"));
  assert.equal((await g(ryan, "PUT", "plan", { recipes: [{ id: "r_0000000000" }] })).status, 400);
  assert.equal((await g(ryan, "PUT", "plan", { list: "c_nope" })).status, 400);
});

test("Instacart gets the order as a shopping list, and the Drift items are ticked", async () => {
  const { env, ryan, recipe, list } = await setup();
  await g(ryan, "PUT", "plan", { recipes: [{ id: recipe.id }] });
  const out = await g(ryan, "POST", "instacart", { skip: ["coffee"] });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.url, "https://customers.instacart.com/store/shopping_lists/123");
  const sent = calls[0];
  assert.equal(sent.init.headers.Authorization, "Bearer ic-key");
  assert.equal(sent.body.link_type, "shopping_list");
  const flour = sent.body.line_items.find(i => i.name === "all-purpose flour");
  assert.deepEqual(flour.line_item_measurements, [{ quantity: 1.5, unit: "cup" }]);
  assert.ok(!sent.body.line_items.some(i => i.name === "Coffee"), "skipped lines aren't sent");
  assert.equal(out.json.checked, 2, "Eggs and milk were ticked; Coffee wasn't sent");
  const items = (await ryan.get("/todo/api/state")).json.items.filter(it => it.collection === list.id);
  assert.deepEqual(items.filter(it => it.meta.checklist.done).map(it => it.title).sort(), ["2 cups milk", "Eggs"]);
  const st = out.json.state;
  assert.equal(st.orders[0].store, "instacart");
  assert.deepEqual(st.lines.map(l => l.key), ["coffee"], "ticked items leave, and the recipe is unpicked");
  assert.deepEqual(st.plan.recipes, []);
  assert.equal(sql(env, "SELECT * FROM grocery_orders").length, 1);
  assert.equal((await g(ryan, "POST", "instacart", { skip: ["coffee"] })).status, 400);
});

test("without the stores' secrets, sending says what's missing", async () => {
  const { ryan } = await setup({});
  const ic = await g(ryan, "POST", "instacart", {});
  assert.equal(ic.status, 503);
  assert.match(ic.json.error, /INSTACART_API_KEY/);
  const k = await ryan.get("/groceries/kroger/connect");
  assert.equal(k.status, 302);
  assert.match(k.location, /\/groceries\/\?kroger=unready$/);
});

test("Kroger: connect, pick a store, match each line, send to the cart, and the picks are remembered", async () => {
  const { env, ryan, recipe } = await setup();
  await g(ryan, "PUT", "plan", { recipes: [{ id: recipe.id }] });
  assert.equal((await g(ryan, "POST", "kroger/match", {})).status, 400, "not connected yet");
  // Off to Kroger, and back with a code.
  const go = await ryan.get("/groceries/kroger/connect");
  assert.equal(go.status, 302);
  const to = new URL(go.location);
  assert.equal(to.origin + to.pathname, "https://api.kroger.com/v1/connect/oauth2/authorize");
  assert.equal(to.searchParams.get("client_id"), "kid");
  assert.equal(to.searchParams.get("redirect_uri"), "https://sintfoap.test/groceries/kroger/callback");
  assert.match(to.searchParams.get("scope"), /cart\.basic:write/);
  const s = to.searchParams.get("state");
  assert.match((await ryan.get(`/groceries/kroger/callback?state=wrong&code=c`)).location, /kroger=expired/);
  const back = await ryan.get(`/groceries/kroger/callback?state=${s}&code=good`);
  assert.match(back.location, /\/groceries\/\?kroger=connected$/);
  assert.match((await ryan.get(`/groceries/kroger/callback?state=${s}&code=good`)).location, /kroger=expired/, "a state works once");
  const row = sqlOne(env, "SELECT secret FROM grocery_kroger");
  assert.ok(!row.secret.includes("ryan-token"), "tokens are kept sealed");

  let st = (await g(ryan, "GET", "state")).json;
  assert.equal(st.kroger.connected, true);
  assert.equal((await g(ryan, "POST", "kroger/match", {})).status, 400, "no store yet");
  const found = (await ryan.get("/groceries/api/kroger/stores?zip=45202")).json.stores;
  assert.deepEqual(found[0], { id: "01400943", name: "Kroger - Main St", chain: "KROGER", address: "1 Main St, Cincinnati, OH 45202" });
  assert.equal((await ryan.get("/groceries/api/kroger/stores?zip=abc")).status, 400);
  st = (await g(ryan, "PUT", "kroger/store", { id: "01400943", modality: "DELIVERY" })).json;
  assert.equal(st.kroger.store.name, "Kroger - Main St");
  assert.equal(st.kroger.modality, "DELIVERY");

  const { matches } = (await g(ryan, "POST", "kroger/match", {})).json;
  assert.equal(matches["all purpose flour"].match.upc, "0001111000001");
  assert.equal(matches["all purpose flour"].match.price, 2.99);
  assert.equal(matches["all purpose flour"].match.image, "https://img.test/flour.jpg");
  assert.equal(matches["all purpose flour"].choices.length, 2);
  assert.equal(matches.coffee.match, null, "nothing found for coffee");
  // Gold Medal instead, two eggs cartons, and coffee left out.
  const lines = [
    { key: "all purpose flour", product: matches["all purpose flour"].choices[1] },
    { key: "egg", upc: matches.egg.match.upc, quantity: 2 },
    { key: "milk", upc: matches.milk.match.upc },
  ];
  const sent = await g(ryan, "POST", "kroger/cart", { lines, check_off: false });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.added, 3);
  assert.equal(sent.json.checked, 0);
  const cart = calls.find(c => c.url.pathname === "/v1/cart/add");
  assert.equal(cart.init.method, "PUT");
  assert.deepEqual(JSON.parse(cart.body).items, [
    { upc: "0001111000002", quantity: 1, modality: "DELIVERY" },
    { upc: "0001111000003", quantity: 2, modality: "DELIVERY" },
    { upc: "0001111000004", quantity: 1, modality: "DELIVERY" }]);
  // Next time, the products sent are already picked and nothing is searched for them.
  assert.deepEqual(sent.json.state.plan.recipes, [], "sent recipes are unpicked");
  await g(ryan, "PUT", "plan", { recipes: [{ id: recipe.id }] });
  calls = [];
  const again = (await g(ryan, "POST", "kroger/match", {})).json.matches;
  assert.equal(again["all purpose flour"].match.description, "Gold Medal Flour");
  assert.equal(again["all purpose flour"].remembered, true);
  assert.deepEqual(calls.filter(c => c.url.pathname === "/v1/products").map(c => c.url.searchParams.get("filter.term")), ["Coffee"]);
  st = (await g(ryan, "GET", "state")).json;
  assert.equal(st.lines.find(l => l.key === "egg").match.upc, "0001111000003");
  assert.equal(st.orders[0].store, "kroger");
  assert.equal(st.orders[0].lines[1].product.quantity, 2);
  // Forgetting a pick, and disconnecting.
  assert.equal((await g(ryan, "DELETE", "matches/egg")).status, 200);
  assert.equal((await g(ryan, "GET", "state")).json.lines.find(l => l.key === "egg").match, null);
  st = (await g(ryan, "DELETE", "kroger")).json;
  assert.equal(st.kroger.connected, false);
});

test("an expired Kroger sign-in is refreshed before sending", async () => {
  const { env, ryan } = await setup();
  const s = new URL((await ryan.get("/groceries/kroger/connect")).location).searchParams.get("state");
  await ryan.get(`/groceries/kroger/callback?state=${s}&code=good`);
  await g(ryan, "PUT", "kroger/store", { id: "01400943" });
  // Make the kept token old: seal one that ran out an hour ago.
  const { seal } = await import("../src/crypto.js");
  const id = sqlOne(env, "SELECT id FROM users WHERE username = 'ryan'").id;
  env.TODO_DB.raw.prepare("UPDATE grocery_kroger SET secret = ?").run(
    await seal(STORES.CHAT_BRIDGE_KEY, `kroger tokens\0${id}`, JSON.stringify({ access: "old", refresh: "ryan-refresh", expires: 1 })));
  calls = [];
  const out = await g(ryan, "POST", "kroger/cart", { lines: [{ key: "coffee", upc: "0001111000009" }] });
  assert.equal(out.status, 200, out.text);
  const refresh = calls.find(c => c.url.pathname === "/v1/connect/oauth2/token");
  assert.equal(new URLSearchParams(refresh.body).get("grant_type"), "refresh_token");
  assert.equal(out.json.checked, 1);
});
