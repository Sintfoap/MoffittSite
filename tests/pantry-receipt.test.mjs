// Tests for filling Pantry from a receipt: a photo read by Claude (or Workers
// AI without a key; stand-ins here) into lines to check, matched to what's in
// the pantry, with estimated expiry dates, and store abbreviations learned.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps } from "./helpers.mjs";
import { linesFrom, proposal, said } from "../src/pantry_receipt.js";
import { keepsFor, estimateExpiry } from "../public/pantry/units.js";

const RECEIPT = {
  found: true, store: "Walmart", date: "2026-11-10", notes: "",
  lines: [
    { printed: "GV WW FLR 10LB", name: "Whole wheat flour", count: 1, size: "10 lb", food: true, price: 6.48 },
    { printed: "CMPBL TOM SOUP", name: "Tomato soup", count: 2, size: "10.75 oz", food: true, price: 2.58 },
    { printed: "GV LG EGGS 12CT", name: "Eggs", count: 1, size: "12 ct", food: true, price: 3.12 },
    { printed: "MCCORM CUMIN", name: "Ground cumin", count: 1, size: "", food: true, price: 2.98 },
    { printed: "BAG FEE", name: "Bag", count: 1, size: "", food: false, price: 0.1 },
  ],
};
let reply = () => RECEIPT;
const real = globalThis.fetch;
beforeEach(() => {
  reply = () => RECEIPT;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input.url || input);
    if (url.host !== "api.anthropic.com") return real(input, init);
    if (url.pathname === "/v1/models") return new Response("{}");
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(reply(JSON.parse(init.body))) }] }));
  };
});
afterEach(() => { globalThis.fetch = real; });

const SEAL = { CHAT_BRIDGE_KEY: "test-bridge-key-0123456789" };
const KEY = "sk-ant-api03-" + "k".repeat(40);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]).toString("base64");
const api = (b, method, path, json) => b.req(method, "/pantry/api/" + path, json === undefined ? {} : { json });

async function setup(extra = SEAL) {
  const env = makeEnv(extra), ryan = new Browser(env);
  await ryan.signup("ryan");
  grantApps(env, "ryan", "pantry", "recipes");
  return { env, ryan };
}
async function withKey(ryan) {
  assert.equal((await ryan.req("PUT", "/recipes/api/key", { json: { key: KEY } })).status, 200);
}

test("how long things keep, for an estimated expiry date", () => {
  assert.equal(keepsFor("Whole milk", "staple", "Fridge"), 7);
  assert.equal(keepsFor("Tomato soup", "counted", "Cupboard"), 730);
  assert.equal(keepsFor("Ground beef", "counted", "Fridge"), 2);
  assert.equal(keepsFor("Chicken thighs", "counted", "Freezer"), 180, "the freezer keeps anything longer");
  assert.equal(keepsFor("Something odd", "counted", "Fridge"), 7);
  assert.equal(estimateExpiry("Eggs", "counted", "Fridge", "2026-11-11"), "2026-12-09");
});

test("the model's lines are tidied, and each one matched or offered as new", () => {
  const lines = linesFrom(RECEIPT);
  assert.equal(lines.length, 5);
  assert.equal(linesFrom({ found: false, lines: [] }), null);
  assert.equal(said("gv  ww flr 10lb  6.48"), "GV WW FLR 10LB");
  const items = [{ id: "i_0000000001", name: "Whole wheat flour", kind: "staple", place: "Cupboard", words: "", text: "2 lb" },
                 { id: "i_0000000002", name: "Ground cumin", kind: "gauged", place: "Spice rack", words: "", text: "Almost out" }];
  const flour = proposal(lines[0], items, new Map(), "2026-11-11");
  assert.deepEqual(flour.match, { id: "i_0000000001", name: "Whole wheat flour", kind: "staple", how: "name", text: "2 lb" });
  assert.equal(flour.amount, "10 lb");
  assert.equal(flour.expires, "2027-02-09");
  assert.equal(flour.expires_by, "estimated");
  const soup = proposal(lines[1], items, new Map(), "2026-11-11");
  assert.equal(soup.match, null);
  assert.deepEqual(soup.new, { kind: "counted", place: "Cupboard", unit: "can", size: "10.75 oz", low: "" });
  assert.equal(soup.amount, "2");
  // A store's abbreviation, once learned, means that item whatever the model calls it.
  const alias = proposal({ ...lines[2], name: "Large eggs" }, [{ id: "i_0000000003", name: "Eggs", kind: "counted", place: "Fridge", words: "", text: "3 eggs" }],
    new Map([["GV LG EGGS 12CT", "i_0000000003"]]), "2026-11-11");
  assert.equal(alias.match.how, "remembered");
  const cumin = proposal(lines[3], items, new Map(), "2026-11-11");
  assert.equal(cumin.match.kind, "gauged");
  assert.equal(cumin.expires, "");
  assert.equal(proposal(lines[4], items, new Map(), "2026-11-11").skip, true);
  const sugar = [{ id: "i_0000000004", name: "Sugar", kind: "staple", place: "Cupboard", words: "", text: "1 lb" },
                 { id: "i_0000000005", name: "Milk", kind: "staple", place: "Fridge", words: "", text: "1 qt" }];
  assert.equal(proposal({ ...lines[0], name: "Brown sugar" }, sugar, new Map(), "2026-11-11").match, null);
  assert.equal(proposal({ ...lines[0], name: "Whole milk" }, sugar, new Map(), "2026-11-11").match.name, "Milk");
});

test("without a key or Workers AI, reading a receipt asks for one", async () => {
  const { ryan } = await setup();
  const res = await api(ryan, "POST", "receipt", { images: [{ data: JPEG }] });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /API key/);
  assert.match((await api(ryan, "POST", "receipt", {})).json.error, /picture of the receipt/);
  assert.equal((await api(ryan, "GET", "receipt")).status, 405);
});

test("a receipt is read, checked, added, and its abbreviations remembered", async () => {
  const { ryan } = await setup();
  await withKey(ryan);
  const flour = (await api(ryan, "POST", "items", { name: "Whole wheat flour", amount: "2 lb", low: "2 lb" })).json;
  const cumin = (await api(ryan, "POST", "items", { name: "Ground cumin", level: 1 })).json;
  const read = await api(ryan, "POST", "receipt?day=2026-11-11", { images: [{ data: JPEG }] });
  assert.equal(read.status, 200, read.text);
  assert.equal(read.json.store, "Walmart");
  assert.equal(read.json.date, "2026-11-10");
  assert.equal(read.json.by, "claude");
  assert.deepEqual(read.json.lines.map(l => [l.printed, l.match?.how || (l.skip ? "skip" : "new")]),
    [["GV WW FLR 10LB", "name"], ["CMPBL TOM SOUP", "new"], ["GV LG EGGS 12CT", "new"], ["MCCORM CUMIN", "name"], ["BAG FEE", "skip"]]);
  // Nothing is saved by reading.
  assert.equal((await api(ryan, "GET", "items")).json.items.length, 2);

  // The checked lines go back: the flour and cumin to what's there, the rest new.
  const lines = read.json.lines.filter(l => !l.skip).map(l => l.match
    ? { printed: l.printed, item: l.match.id, amount: l.amount, expires: l.expires, expires_by: l.expires_by }
    : { printed: l.printed, name: l.name, ...l.new, amount: l.amount, expires: l.expires, expires_by: l.expires_by });
  const added = await api(ryan, "POST", "receipt/add", { store: read.json.store, lines });
  assert.equal(added.status, 200, added.text);
  assert.deepEqual(added.json.failed, []);
  assert.deepEqual(added.json.added.map(a => `${a.name}: ${a.text}`), ["Whole wheat flour: 12 lb", "Tomato soup: 2 cans", "Eggs: 12 eggs", "Ground cumin: Full"]);
  const items = (await api(ryan, "GET", "items")).json.items;
  const soup = items.find(i => i.name === "Tomato soup");
  assert.equal(soup.size, "10.75 oz");
  assert.equal(soup.expires_by, "estimated");
  assert.equal(soup.lots[0].by, "estimated");
  assert.equal(items.find(i => i.id === flour.id).lots.length, 2);
  assert.equal(items.find(i => i.id === cumin.id).level, 5);

  // Next time at Walmart, the same lines are remembered, even when the model names them differently.
  reply = () => ({ ...RECEIPT, lines: RECEIPT.lines.map(l => ({ ...l, name: l.name + " (store brand)" })) });
  const again = (await api(ryan, "POST", "receipt", { images: [{ data: JPEG }] })).json;
  assert.deepEqual(again.lines.filter(l => !l.skip).map(l => l.match?.how), ["remembered", "remembered", "remembered", "remembered"]);
  // At another store they aren't, though a plainer name still finds them.
  reply = () => ({ ...RECEIPT, store: "Kroger", lines: [{ ...RECEIPT.lines[2], name: "Large eggs" }, { ...RECEIPT.lines[2], printed: "DUCK EGGS", name: "Duck eggs" }] });
  const kroger = (await api(ryan, "POST", "receipt", { images: [{ data: JPEG }] })).json.lines;
  assert.equal(kroger[0].match.how, "name");
  assert.equal(kroger[1].match, null, "duck eggs aren't the eggs you have");
});

test("a line that can't be added says why, and the rest still go in", async () => {
  const { ryan } = await setup();
  const out = (await api(ryan, "POST", "receipt/add", { store: "Aldi", lines: [
    { printed: "SUGAR 4LB", name: "Sugar", kind: "staple", amount: "4 lb", low: "" },
    { printed: "OATS", name: "Oats", kind: "staple", amount: "42 oz", low: "1 lb" },
    { printed: "GONE", item: "i_ffffffffff", amount: "1" },
  ] })).json;
  assert.deepEqual(out.added.map(a => a.name), ["Oats"]);
  assert.deepEqual(out.failed.map(f => f.printed), ["SUGAR 4LB", "GONE"]);
  assert.match(out.failed[0].error, /running low/);
});

test("without a key, Workers AI reads the receipt", async () => {
  const AI = { async run() { return { response: RECEIPT }; } };
  const { ryan } = await setup({ ...SEAL, AI });
  const read = await api(ryan, "POST", "receipt", { images: [{ data: JPEG }] });
  assert.equal(read.status, 200, read.text);
  assert.equal(read.json.by, "ai");
  assert.equal(read.json.lines.length, 5);
});

test("the key for reading receipts can be set from Pantry, without Recipe box", async () => {
  const env = makeEnv(SEAL), sam = new Browser(env);
  await sam.signup("sam");
  grantApps(env, "sam", "pantry");
  assert.equal((await sam.req("PUT", "/recipes/api/key", { json: { key: KEY } })).status, 403);
  const put = await api(sam, "PUT", "key", { key: KEY });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.photo.ready, true);
  assert.equal((await api(sam, "GET", "items")).json.photo.ready, true);
  assert.equal((await api(sam, "POST", "receipt", { images: [{ data: JPEG }] })).json.by, "claude");
  assert.equal((await api(sam, "DELETE", "key")).json.photo.ready, false);
});
