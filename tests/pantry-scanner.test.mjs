// Tests for Pantry's scanner app's side of the site: pairing a phone by a code
// from the Pantry page, its key (only good for Pantry's API), barcodes looked
// up in your own products then Open Food Facts (a stand-in here), and what's
// added ticked off the Drift shopping list.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps, run, sqlOne } from "./helpers.mjs";
import { sizeOf } from "../src/pantry_scanner.js";
import { listLineIs } from "../src/pantry_receipt.js";
import { addToList } from "../src/drift.js";
import { getUser } from "../src/auth.js";

const OFF = {
  "0078742370538": { product_name: "Great Value Whole Wheat Flour", brands: "Great Value,Walmart", quantity: "10 lb (4.53 kg)" },
  "0051000012616": { product_name: "Tomato Soup", brands: "Campbell's", quantity: "10.75 oz" },
};
let offAsked = 0;
const real = globalThis.fetch;
beforeEach(() => {
  offAsked = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input.url || input);
    if (url.host === "world.openfoodfacts.org") {
      offAsked++;
      const code = url.pathname.match(/product\/(\d+)/)[1];
      return Response.json(OFF[code] ? { status: 1, product: OFF[code] } : { status: 0 });
    }
    if (url.host === "api.github.com") return Response.json([
      { tag_name: "scanner-v2", name: "Pantry scanner 2", draft: false, prerelease: false, published_at: "2026-11-11T00:00:00Z",
        assets: [{ name: "pantry-scanner.apk", browser_download_url: "https://github.com/x/releases/download/scanner-v2/pantry-scanner.apk" }] },
      { tag_name: "app-v5", draft: false, prerelease: false, assets: [{ name: "sintfoap.apk", browser_download_url: "https://e/app" }] },
    ]);
    return real(input, init);
  };
});
afterEach(() => { globalThis.fetch = real; });

const api = (b, method, path, json, headers) => b.req(method, "/pantry/api/" + path, { ...(json === undefined ? {} : { json }), ...(headers ? { headers, origin: null } : {}) });

async function setup() {
  const env = makeEnv(), ryan = new Browser(env), phone = new Browser(env);
  await ryan.signup("ryan");
  grantApps(env, "ryan", "pantry");
  return { env, ryan, phone };
}
async function pair(ryan, phone, name = "Pixel 8") {
  const started = await api(ryan, "POST", "scanners");
  assert.equal(started.status, 200, started.text);
  const paired = await phone.req("POST", "/pantry/scanner/pair", { json: { code: started.json.code, name }, origin: null });
  assert.equal(paired.status, 200, paired.text);
  return { started: started.json, key: paired.json.key, headers: { Authorization: `Bearer ${paired.json.key}` }, paired: paired.json };
}

test("a phone pairs with a code from the Pantry page, once", async () => {
  const { ryan, phone } = await setup();
  const { started, key, paired } = await pair(ryan, phone);
  assert.match(started.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.match(started.link, /^sintfoap-scanner:\/\/pair\?site=https%3A%2F%2Fsintfoap\.test&code=[A-Z2-9]{8}$/);
  assert.match(started.qr, /^<svg/);
  assert.match(key, /^ps_/);
  assert.equal(paired.site, "https://sintfoap.test");
  assert.equal(paired.username, "ryan");
  // The same code again, a made-up one, or one that's run out: no.
  const again = await phone.req("POST", "/pantry/scanner/pair", { json: { code: started.code, name: "Other" }, origin: null });
  assert.equal(again.status, 400);
  assert.match(again.json.error, /already used|run out/);
  assert.equal((await phone.req("POST", "/pantry/scanner/pair", { json: { code: "nope" }, origin: null })).status, 400);
  const late = (await api(ryan, "POST", "scanners")).json.code;
  run(ryan.env, "UPDATE pantry_pair_codes SET expires = 0");
  assert.match((await phone.req("POST", "/pantry/scanner/pair", { json: { code: late }, origin: null })).json.error, /run out/);
  // It's listed, and only the key's hash is kept.
  const listed = (await api(ryan, "GET", "scanners")).json.scanners;
  assert.deepEqual(listed.map(s => [s.name, s.prefix]), [["Pixel 8", key.slice(0, 8)]]);
  assert.equal(sqlOne(ryan.env, "SELECT COUNT(*) AS n FROM pantry_scanners WHERE id_hash = ?", key).n, 0);
});

test("a scanner's key opens only Pantry's API, as its owner, until it's unpaired", async () => {
  const { env, ryan, phone } = await setup();
  const { headers } = await pair(ryan, phone);
  await api(ryan, "POST", "items", { name: "Eggs", amount: "6" });
  const seen = await api(phone, "GET", "items", undefined, headers);
  assert.equal(seen.status, 200, seen.text);
  assert.deepEqual(seen.json.items.map(i => i.name), ["Eggs"]);
  // It can add (no Origin needed: it isn't a browser).
  assert.equal((await api(phone, "POST", "items", { name: "Rice", amount: "2 lb", low: "1 lb" }, headers)).status, 201);
  // Not the Anthropic key, not pairing more phones, not other apps, not the page.
  assert.equal((await api(phone, "PUT", "key", { key: "sk-ant-x" }, headers)).status, 403);
  assert.equal((await api(phone, "POST", "scanners", {}, headers)).status, 403);
  assert.equal((await phone.req("GET", "/pantry/", { headers })).status, 403);
  assert.equal((await phone.req("GET", "/recipes/api/recipes", { headers })).status, 401);
  // A browser can't use the scanner's way in to skip the same-origin check without the key.
  assert.equal((await phone.req("POST", "/pantry/api/items", { json: { name: "X" }, headers: { Authorization: "Bearer ps_" + "x".repeat(43) }, origin: null })).status, 401);
  // Losing Pantry stops it; getting it back starts it again.
  const { id } = sqlOne(env, "SELECT id FROM users WHERE username = 'ryan'");
  run(env, "DELETE FROM user_areas WHERE user_id = ? AND area = 'pantry'", id);
  assert.equal((await api(phone, "GET", "items", undefined, headers)).status, 401);
  grantApps(env, "ryan", "pantry");
  assert.equal((await api(phone, "GET", "items", undefined, headers)).status, 200);
  // Unpairing ends it for good.
  const sid = (await api(ryan, "GET", "scanners")).json.scanners[0].id;
  assert.deepEqual((await api(ryan, "DELETE", "scanners/" + sid)).json.scanners, []);
  const gone = await api(phone, "GET", "items", undefined, headers);
  assert.equal(gone.status, 401);
  assert.match(gone.json.error, /pair it again/);
});

test("pairing needs Pantry, and the page's own session", async () => {
  const env = makeEnv(), sam = new Browser(env), phone = new Browser(env);
  await sam.signup("sam");
  assert.equal((await api(sam, "POST", "scanners")).status, 403);
  assert.equal((await phone.req("POST", "/pantry/api/scanners", { json: {} })).status, 401);
});

test("a barcode is looked up, added, and remembered as that item", async () => {
  const { ryan, phone } = await setup();
  const { headers } = await pair(ryan, phone);
  const flour = (await api(ryan, "POST", "items", { name: "Whole wheat flour", amount: "2 lb", low: "2 lb" })).json;
  // Open Food Facts knows it, and its name finds your flour.
  const look = (await api(phone, "GET", "barcode/0078742370538?day=2026-11-11", undefined, headers)).json;
  assert.deepEqual(look.product, { name: "Whole wheat flour", size: "10 lb", brand: "Great Value", from: "openfoodfacts" });
  assert.equal(look.line.match.id, flour.id);
  assert.equal(look.line.amount, "10 lb");
  assert.equal(look.line.expires_by, "estimated");
  // Soup is new; an unknown code has nothing.
  const soup = (await api(phone, "GET", "barcode/0051000012616", undefined, headers)).json;
  assert.equal(soup.line.match, null);
  assert.equal(soup.line.new.kind, "counted");
  const unknown = (await api(phone, "GET", "barcode/0000000000017", undefined, headers)).json;
  assert.deepEqual([unknown.product, unknown.line], [null, null]);
  assert.equal((await api(phone, "GET", "barcode/12ab", undefined, headers)).status, 404);

  // Added, with a scanned date for the flour; the unknown one named by hand.
  const added = (await api(phone, "POST", "add", { lines: [
    { key: "a", barcode: "0078742370538", item: flour.id, name: look.product.name, size: "10 lb", amount: "10 lb", expires: "2027-03-01", expires_by: "scanned" },
    { key: "b", barcode: "0000000000017", name: "Oat milk", kind: "counted", place: "Fridge", amount: "1", size: "64 fl oz" },
  ] }, headers)).json;
  assert.deepEqual(added.failed, []);
  assert.deepEqual(added.added.map(a => [a.key, a.name]), [["a", "Whole wheat flour"], ["b", "Oat milk"]]);
  assert.equal(added.added[0].text, "12 lb");
  const items = (await api(ryan, "GET", "items")).json.items;
  assert.equal(items.find(i => i.id === flour.id).lots.find(l => l.expires === "2027-03-01").by, "scanned");

  // Next time they're yours: no Open Food Facts, and the hand-named one is known.
  offAsked = 0;
  const mine = (await api(phone, "GET", "barcode/0000000000017", undefined, headers)).json;
  assert.equal(mine.product.from, "yours");
  assert.equal(mine.product.name, "Oat milk");
  assert.equal(mine.line.match.how, "barcode");
  assert.equal((await api(phone, "GET", "barcode/0078742370538", undefined, headers)).json.line.match.id, flour.id);
  assert.equal(offAsked, 0);
});

test("food coming in ticks it off the shopping list", async () => {
  const { env, ryan } = await setup();
  const user = await getUser(env, { username: "ryan" });
  await addToList(env, user, null, ["2 lb whole wheat flour", "1 cup brown sugar", "Eggs", "Milk"], "For Bread");
  const out = (await api(ryan, "POST", "add", { lines: [
    { name: "Whole wheat flour", kind: "staple", amount: "10 lb", low: "2 lb" },
    { name: "Sugar", kind: "staple", amount: "4 lb", low: "1 lb" },
    { name: "Eggs", kind: "counted", amount: "12" },
  ] })).json;
  assert.deepEqual(out.ticked.map(t => [t.title, t.list]).sort(), [["2 lb whole wheat flour", "Shopping list"], ["Eggs", "Shopping list"]]);
  // Without Drift, nothing to tick.
  run(env, "DELETE FROM user_areas WHERE user_id = ? AND area = 'todo'", user.id);
  assert.deepEqual((await api(ryan, "POST", "add", { lines: [{ name: "Milk", kind: "staple", amount: "1 gal", low: "1 qt" }] })).json.ticked, []);
});

test("shopping list lines and package sizes are read plainly", () => {
  assert.equal(listLineIs({ name: "Whole wheat flour" }, "3 cups whole wheat flour, sifted"), true);
  assert.equal(listLineIs({ name: "Tomato soup" }, "2 cans of tomato soup"), true);
  assert.equal(listLineIs({ name: "Eggs" }, "12 large eggs (for Pancakes)"), true);
  assert.equal(listLineIs({ name: "Flour", words: "ap flour" }, "2 cups AP flour"), true);
  assert.equal(listLineIs({ name: "Sugar" }, "1 cup brown sugar"), false);
  assert.equal(listLineIs({ name: "Eggs" }, "Eggplant"), false);
  assert.equal(sizeOf("10 lb (4.53 kg)"), "10 lb");
  assert.equal(sizeOf("12 x 355 ml"), "355 ml");
  assert.equal(sizeOf("64 fl oz"), "64 fl oz");
  assert.equal(sizeOf("75 cl"), "750 ml");
  assert.equal(sizeOf("a bag"), "");
});

test("the newest scanner app is offered for download", async () => {
  const env = makeEnv(), b = new Browser(env);
  const r = await b.req("GET", "/pantry/scanner/latest.json");
  assert.equal(r.status, 200);
  assert.equal(r.json.version, 2);
  assert.match(r.json.url, /pantry-scanner\.apk$/);
});

test("a gauged thing comes in as full as you say", async () => {
  const { ryan } = await setup();
  const cumin = (await api(ryan, "POST", "items", { name: "Ground cumin", level: 1 })).json;
  const out = (await api(ryan, "POST", "add", { lines: [
    { item: cumin.id, level: 3 },
    { name: "Vanilla extract", kind: "gauged", level: 2 },
  ] })).json;
  assert.deepEqual(out.failed, []);
  assert.deepEqual(out.added.map(a => a.text), ["½ left", "¼ left"]);
  assert.equal((await api(ryan, "POST", "add", { lines: [{ item: cumin.id }] })).json.added[0].text, "Full");
  // A new one left at Full (the app sends no level, or null): full, not an error.
  const fresh = (await api(ryan, "POST", "add", { lines: [
    { key: "a", name: "Olive oil", kind: "gauged" },
    { key: "b", name: "Maple syrup", kind: "gauged", level: null },
  ] })).json;
  assert.deepEqual(fresh.failed, []);
  assert.deepEqual(fresh.added.map(a => a.text), ["Full", "Full"]);
});
