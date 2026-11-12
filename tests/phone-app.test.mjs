// The phone app (public/m/): its rules for Drift and Chat, which run without
// a DOM, and that it is installable as its own app on the phone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { today, addDays } from "../public/todo/lib.js";
import * as D from "../public/m/drift-logic.js";
import * as PL from "../public/m/pantry-logic.js";
import * as C from "../public/m/chat-logic.js";

const item = (id, meta = {}, extra = {}) => ({ id, title: id, collection: "c_1", tags: [], notes: "", created: "2026-01-01T00:00:00", meta, ...extra });

test("Today lists overdue open items, then today's by time", () => {
  const items = [
    item("i_late", { checklist: { done: false }, event: { start: addDays(-2), end: null } }),
    item("i_lateDone", { checklist: { done: true }, event: { start: addDays(-2), end: null } }),
    item("i_eve", { event: { start: today() + "T18:00", end: null } }),
    item("i_am", { event: { start: today() + "T09:00", end: null } }),
    item("i_allday", { event: { start: today(), end: null } }),
    item("i_tomorrow", { event: { start: addDays(1), end: null } }),
  ];
  const { late, on } = D.todayGroups(items);
  assert.deepEqual(late.map(i => i.id), ["i_late"]);
  assert.deepEqual(on.map(i => i.id), ["i_allday", "i_am", "i_eve"]);
});

test("the week strip starts on Monday and the agenda splits untimed from timed", () => {
  const week = D.weekOf("2026-10-21");   // a Wednesday
  assert.deepEqual([week[0], week[6]], ["2026-10-19", "2026-10-25"]);
  const items = [
    item("i_carry", { event: { start: "2026-10-20T22:00", end: "2026-10-21T02:00" } }),
    item("i_noon", { event: { start: "2026-10-21T12:00", end: null } }),
    item("i_soon", { event: { start: "2026-10-25", end: null } }),
  ];
  const a = D.dayAgenda(items, "2026-10-21");
  assert.deepEqual(a.untimed.map(i => i.id), ["i_carry"]);
  assert.deepEqual(a.timed.map(i => i.id), ["i_noon"]);
  assert.deepEqual(a.later.map(i => i.id), ["i_soon"]);
});

test("new items start with what each plugin that's on gives them", () => {
  const col = { id: "c_1", plugins: ["checklist", "list"] };
  const m = D.freshMeta(col, { priority: 2 });
  assert.deepEqual(m.checklist, { done: false, priority: 2 });
  assert.equal(m.list.parent, null);
  assert.equal(m.event, undefined);
  // On Today and the Calendar, every item gets a date, even without Events on.
  assert.deepEqual(D.freshMeta(col, {}, { dated: true, day: "2026-11-02" }).event, { start: "2026-11-02", end: null });
  assert.deepEqual(D.freshMeta({ plugins: ["event"] }, { date: "2026-11-02", time: "15:00" }).event, { start: "2026-11-02T15:00", end: null });
});

test("quick-add's +collection finds a collection you can write to", () => {
  const cols = [{ id: "c_1", name: "Inbox", role: "owner" }, { id: "c_2", name: "Shared", role: "view" }];
  assert.equal(D.targetFor(cols, null, {}).col.id, "c_1");
  assert.equal(D.targetFor(cols, null, { collection: "inbox" }).col.id, "c_1");
  assert.match(D.targetFor(cols, null, { collection: "shared" }).error, /no collection/);
  assert.match(D.targetFor(cols, cols[1], {}).error, /view this collection/);
});

test("the item sheet sends only what changed, and checks dates and times", () => {
  const it = item("i_1", { checklist: { done: false, priority: 0 }, event: { start: "2026-11-02", end: null } }, { tags: ["a"] });
  const base = { title: "i_1", notes: "", tags: "a", collection: "c_1", onList: true, done: false, priority: "0", day: "2026-11-02", time: "" };
  const kinds = { hasCheck: true, hasEvent: true };
  assert.deepEqual(D.itemChanges(it, base, kinds), {});
  assert.deepEqual(D.itemChanges(it, { ...base, done: true, priority: "3", tags: "#B, a" }, kinds),
    { tags: ["a", "b"], meta: { checklist: { done: true, priority: 3, done_at: null } } });
  assert.deepEqual(D.itemChanges(it, { ...base, time: "3pm" }, kinds).meta.event, { start: "2026-11-02T15:00", end: null });
  assert.deepEqual(D.itemChanges(it, { ...base, day: "", onList: false }, kinds).meta, { checklist: null, event: null });
  assert.match(D.itemChanges(it, { ...base, time: "25:00" }, kinds).error, /isn't a time/);
  assert.match(D.itemChanges(it, { ...base, title: " " }, kinds).error, /title/);
});

test("the List outline nests items and moves them like the web page", () => {
  const items = [
    item("i_a", { list: { order: 1, parent: null } }),
    item("i_b", { list: { order: 2, parent: null } }),
    item("i_c", { list: { order: 1, parent: "i_b" } }),
    item("i_loop1", { list: { order: 3, parent: "i_loop2" } }),
    item("i_loop2", { list: { order: 4, parent: "i_loop1" } }),
  ];
  assert.deepEqual(D.outline(items).map(([it, d]) => `${it.id}:${d}`), ["i_a:0", "i_b:0", "i_c:1", "i_loop1:0", "i_loop2:0"]);
  assert.deepEqual(D.listMove(items[1], items, "in"), { parent: "i_a", order: 1 });
  assert.deepEqual(D.listMove(items[2], items, "out"), { parent: null, order: 2.5 });
  assert.equal(D.listMove(items[0], items, "up"), null);
  assert.equal(D.listMove(items[0], items, "in"), null);
});

test("chat's room list puts rooms with something new first in each group", () => {
  const r = (id, kind, joined, unread = 0, last_at = 0, mentions = 0) => ({ id, kind, joined, unread, last_at, mentions });
  const s = C.roomSections([r("r_a", "open", true, 0, 9), r("r_b", "open", true, 2, 1), r("r_c", "dm", true, 1), r("r_d", "open", false), r("r_e", "private", true, 0, 5, 1)]);
  assert.deepEqual(s.map(x => x.id), ["rooms", "dms", "browse"]);
  assert.deepEqual(s[0].rooms.map(x => x.id), ["r_e", "r_b", "r_a"]);
  assert.equal(C.unreadTotal([r("r_b", "open", true, 2), r("r_d", "open", false, 5), r("r_c", "dm", true, 1)]), 3);
});

test("a room's messages group by person and day, and polls fold in edits and deletions", () => {
  const m = (id, author, created_at, extra = {}) => ({ id, author, created_at, body: "x", ...extra });
  const rows = C.messageRows([m(3, "sam", 1060 + 6 * 60), m(1, "sam", 1000), m(2, "sam", 1060), m(4, "kim", 1060 + 7 * 60), m(5, "kim", 90000, { deleted: true })], s => s < 50000 ? "Mon" : "Tue");
  assert.deepEqual(rows.map(x => x.day || `${x.m.id}${x.first ? "*" : ""}`), ["Mon", "1*", "2", "3*", "4*"]);
  const merged = C.mergeMessages([m(1, "sam", 1), m(2, "sam", 2)], [m(2, "sam", 2, { body: "edited" }), m(3, "kim", 3)]);
  assert.deepEqual(merged.map(x => x.body), ["x", "edited", "x"]);
  assert.equal(C.typingLine(["Sam", "Kim"]), "Sam and Kim are typing…");
});

test("the phone app installs as its own app, and its page loads every file it names", () => {
  const manifest = JSON.parse(readFileSync(new URL("../public/m/app.webmanifest", import.meta.url)));
  assert.equal(manifest.scope, "/m/");
  assert.equal(manifest.start_url, "/m/");
  for (const icon of manifest.icons) assert.ok(existsSync(new URL("../public" + icon.src, import.meta.url)), icon.src);
  const html = readFileSync(new URL("../public/m/index.html", import.meta.url), "utf8");
  for (const [, src] of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) assert.ok(existsSync(new URL("../public" + src, import.meta.url)), src);
  // Every module the app imports is there (relative imports, as the browser resolves them).
  for (const f of ["app.js", "ui.js", "drift.js", "chat.js", "drift-logic.js", "chat-logic.js", "pantry.js", "pantry-logic.js", "barcode.js"]) {
    const url = new URL(`../public/m/${f}`, import.meta.url);
    for (const [, spec] of readFileSync(url, "utf8").matchAll(/(?:from|import\()\s*"(\.[^"]+)"/g)) assert.ok(existsSync(new URL(spec, url)), `${f} → ${spec}`);
  }
});

test("the phone's Map lists the day's places, and the item sheet sets a place", () => {
  const d = today();
  const a = { place: "Ferry Building", lat: 37.7955, lng: -122.3937 };
  const items = [item("i_tea", { event: { start: d + "T15:00", end: null }, location: { ...a, lng: -122.4 } }),
    item("i_lunch", { event: { start: d + "T12:00", end: null }, location: a }), item("i_none", { event: { start: d + "T09:00", end: null } })];
  const { stops, elsewhere } = D.dayStops(items, d);
  assert.deepEqual(stops.map(s => s.item.id), ["i_lunch", "i_tea"]);
  assert.equal(elsewhere.length, 1);
  assert.equal(D.VIEW_LABELS.location, "Map");

  const it = item("i_1", { location: a });
  const base = { title: "i_1", notes: "", tags: "", collection: "c_1", place: "Ferry Building" };
  const kinds = { hasCheck: false, hasEvent: false, hasPlace: true };
  assert.deepEqual(D.itemChanges(it, base, kinds), {}, "the same place changes nothing");
  assert.deepEqual(D.itemChanges(it, { ...base, place: " Coit  Tower " }, kinds).meta.location, { place: "Coit Tower", lat: null, lng: null });
  assert.deepEqual(D.itemChanges(it, { ...base, place: "37.8, -122.4" }, kinds).meta.location, { place: "", lat: 37.8, lng: -122.4 });
  assert.deepEqual(D.itemChanges(it, { ...base, place: "" }, kinds).meta.location, null);
  assert.deepEqual(D.freshMeta({ plugins: ["event", "location"] }, { place: "Coit Tower" }, { dated: true, day: "2026-11-02" }),
    { event: { start: "2026-11-02", end: null }, location: { place: "Coit Tower", lat: null, lng: null } });
});

// ── Pantry's scanner (public/m/pantry.js) ──────────────────────────────────

test("the phone's Pantry scanner sends lines as the scanner app does", () => {
  const p = { printed: "GV WW FLR 10LB", name: "Whole wheat flour", skip: false,
    match: { id: "i_0000000001", name: "Whole wheat flour", kind: "measured", how: "remembered", text: "2 lb" },
    amount: "10 lb", expires: "2027-02-09", expires_by: "estimated" };
  const l = PL.fromProposal(p, { store: "Walmart" });
  assert.equal(l.target, "i_0000000001");
  assert.equal(l.how, "remembered");
  const sent = PL.toSend(l);
  assert.equal(sent.item, "i_0000000001");
  assert.equal(sent.expires_by, "estimated");
  assert.equal(sent.kind, undefined);
  const bag = PL.fromProposal({ printed: "BAG FEE", name: "Bag", skip: true, match: null, new: { kind: "counted", place: "Cupboard" }, amount: "1" });
  assert.equal(bag.on, false);
  assert.ok(PL.isNew(bag));

  // A new one, a staple: low at an amount, or at a mark on the gauge (Almost out unless picked).
  assert.equal(PL.toSend(PL.blank({ name: "Tomato soup", kind: "counted", staple: true, low: "2" })).low, "2");
  assert.equal(PL.toSend(PL.blank({ name: "Vanilla", kind: "gauged", staple: true })).low, 1);
  assert.equal(PL.toSend(PL.blank({ name: "Vanilla", kind: "gauged", staple: true, lowLevel: 3, level: 2 })).level, 2);
  assert.equal(PL.toSend(PL.blank({ name: "Oat milk", kind: "counted" })).low, undefined);
  // A date that was never set isn't "estimated".
  assert.equal(PL.toSend(PL.blank({ name: "Rice", expiresBy: "estimated" })).expires_by, "");
});

test("the phone's Pantry scanner counts the same barcode again, and reads a UPC-A as Android does", () => {
  assert.equal(PL.bump("10 lb", "10 lb"), "20 lb");
  assert.equal(PL.bump("2", "1"), "3");
  assert.equal(PL.bump("1 gallon", "0.5 gallon"), "1.5 gallon");
  assert.equal(PL.bump("10 lb", "2 cups"), "10 lb");
  assert.equal(PL.sameBarcode("0012345678905"), "012345678905");
  assert.equal(PL.sameBarcode("5000159484695"), "5000159484695");
  assert.equal(PL.scan([], "hello"), null);
  const first = PL.scan([], "0012345678905");
  assert.equal(first.look, "012345678905");
  const known = PL.fromBarcode("012345678905", { product: { name: "Black beans", size: "15 oz", brand: "Goya" },
    line: { name: "Black beans", amount: "1 can", match: null, new: { kind: "counted", unit: "can" } } });
  assert.equal(known.brand, "Goya");
  assert.equal(known.size, "15 oz");
  const again = PL.scan([known], "012345678905");
  assert.equal(again.again.amount, "2 can");
  const unknown = PL.fromBarcode("4000000000006", { product: null, line: null });
  assert.equal(unknown.amount, "1");
  assert.equal(PL.unnamed([unknown]).barcode, "4000000000006");
});

test("the phone's Pantry scanner keeps what the site wouldn't take, with its reason", () => {
  const a = PL.blank({ name: "Flour", store: "Walmart" }), b = PL.blank({ name: "Bag", store: "Walmart" }), c = PL.blank({ name: "Milk", barcode: "123456" }), d = PL.blank({ name: "x", on: false });
  const bs = PL.batches([a, b, c, d]);
  assert.deepEqual(bs.map(x => [x.store, x.lines.length]), [["Walmart", 2], ["", 1]]);
  const left = PL.afterAdd([a, b, c, d], bs[0].lines, { added: [{ name: "Flour" }], failed: [{ key: b.key, error: "say how much" }], ticked: [{ title: "flour" }] });
  assert.deepEqual(left.map(l => l.name), ["Bag", "Milk", "x"]);
  assert.equal(left[0].error, "say how much");
  assert.equal(PL.addedLine([{ added: [{ name: "Flour" }], ticked: [{ title: "flour" }] }], left), "Added 1: Flour. Ticked off your shopping list: flour. 1 still needs a fix.");
  assert.ok(PL.dateMatters(PL.blank({ expires: "2026-11-18", expiresBy: "estimated" }), "2026-11-11"));
  assert.ok(!PL.dateMatters(PL.blank({ expires: "2028-11-10", expiresBy: "estimated" }), "2026-11-11"));
  assert.equal(PL.nice("2027-02-09", "2026-11-11"), "Feb 9, 2027");
});

test("the phone's barcode reader reads groceries' barcodes without the browser's help (iPhones)", async () => {
  const Z = await import("../public/m/vendor/zxing.mjs");
  const { decodePixels } = await import("../public/m/barcode.js");
  // EAN-13, drawn as a camera would see it: black bars on white, a quiet zone either side.
  const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
  const G = L.map(c => [...c].reverse().map(x => x === "0" ? "1" : "0").join("")), R = L.map(c => [...c].map(x => x === "0" ? "1" : "0").join(""));
  const PAR = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];
  const draw = code => {
    const d = [...code].map(Number);
    let bits = "101";
    for (let i = 0; i < 6; i++) bits += (PAR[d[0]][i] === "L" ? L : G)[d[i + 1]];
    bits += "01010";
    for (let i = 7; i < 13; i++) bits += R[d[i]];
    bits += "101";
    const mod = 3, quiet = 30, height = 60, width = bits.length * mod + 2 * quiet, data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 0; y < height; y++) for (let x = 0; x < bits.length * mod; x++)
      if (bits[Math.floor(x / mod)] === "1") { const j = (y * width + quiet + x) * 4; data[j] = data[j + 1] = data[j + 2] = 0; }
    return { data, width, height };
  };
  const hints = new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.UPC_A]]]);
  const one = new Z.MultiFormatOneDReader(hints);
  assert.equal(decodePixels(Z, one, hints, draw("5000159484695")), "5000159484695");
  assert.equal(decodePixels(Z, one, hints, draw("0012345678905")), "012345678905");   // a UPC-A: 12 digits, as Android reads it
  assert.equal(decodePixels(Z, one, hints, { data: new Uint8ClampedArray(400 * 4).fill(255), width: 100, height: 4 }), null);
});
