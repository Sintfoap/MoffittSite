// Encryption keys that follow you: the browser holding a connection's keys
// sends the site a copy (public/chat/carry.js), still locked with its
// browser key, and another of your browsers takes them from there. Each
// browser gets its own IndexedDB here (tests/vendor/fake-indexeddb), and the
// crypto library keeps its store in it as it does in a real one.
import { test, afterEach } from "node:test";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import "./vendor/fake-indexeddb/auto/index.mjs";
import { Browser, makeEnv, grantApps, sqlOne } from "./helpers.mjs";
import { FakeMatrix } from "./fake-matrix.mjs";
import * as lib from "../public/chat/vendor/matrix-crypto/node.mjs";
import { Vault, textOf, textContent } from "../public/chat/e2ee.js";
import { pack, unpack, forget, encode, decode } from "../public/chat/carry.js";

const ROOM = "!secret:matrix.test", ROOM2 = "!later:matrix.test";
const PASSWORD = "correct horse battery";
let hs;
afterEach(() => hs?.uninstall());

const api = (b, method, path, json) => b.req(method, "/chat/api" + path, json === undefined ? {} : { json });
const hexKey = c => c.repeat(64);
const syncNow = (b, conn) => api(b, "POST", `/connections/${conn.id}/sync`);
const keysOp = (b, conn, op, body) => api(b, "POST", `/connections/${conn.id}/crypto/${op}`, body);

async function setup() {
  hs = new FakeMatrix().install();
  const members = { "@ryan:matrix.test": "Ryan", "@sam:matrix.test": "Sam" };
  hs.room(ROOM, { name: "Secrets", encrypted: true, members });
  hs.room(ROOM2, { name: "Later", encrypted: true, members });
  const env = makeEnv({ CHAT_BRIDGE_KEY: "test-bridge-key-0123456789abcdef" });
  const laptop = new Browser(env);
  assert.equal((await laptop.signup("ryan", PASSWORD)).status, 303);
  grantApps(env, "ryan", "chat", "chat-bridges");
  const conn = (await api(laptop, "POST", "/connections", { provider: "matrix", homeserver: "matrix.test", username: "ryan", password: "hunter22hunter22" })).json;
  const phone = new Browser(env);
  assert.equal((await phone.login("ryan", PASSWORD)).status, 303);
  return { env, laptop, phone, conn };
}

// A browser's side of a connection's keys, as the chat page has it: its own
// IndexedDB, browser key and seat.
function browserKeys(b, conn) {
  const idb = new IDBFactory(), store = `sintfoap-e2ee-${conn.id}`;
  const me = { idb, store, key: null, seat: null, vault: null };
  const post = async (op, body) => {
    const r = await keysOp(b, conn, op, body);
    if (r.status !== 200) throw Object.assign(new Error(r.json.error), { status: r.status, code: r.json.code });
    return r.json;
  };
  me.open = async ({ legacy = false } = {}) => {
    globalThis.indexedDB = idb;
    me.vault = await Vault.open(lib, { key: me.seat, store, passphrase: me.key, post,
      ...(legacy ? {} : { vault: me.key, pack: () => pack(idb, store) }) });
    return me.vault;
  };
  me.turnOn = opts => { me.key = hexKey("a"); me.seat = me.key; return me.open(opts); };
  // Takes the keys from wherever they are.
  me.take = async (force = false) => {
    const seat = randomBytes(32).toString("hex");
    const r = await keysOp(b, conn, "take", { key: seat, force });
    if (r.status !== 200 || r.json.busy) return r;
    await unpack(idb, store, r.json.copy);
    me.key = r.json.vault; me.seat = seat;
    await me.open();
    return r;
  };
  return me;
}

// Sam, on his own device, straight to the homeserver.
async function samOnMatrix() {
  const who = hs.person("@sam:matrix.test", "SAMDEV", "syt_sam");
  let since = null, n = 0;
  const call = async (method, path, body) => {
    const [p, q] = path.split("?");
    const res = await hs.handle(new Request(`https://hs.matrix.test/_matrix/client/v3/${p}${q ? "?" + q : ""}`, {
      method, headers: { Authorization: `Bearer ${who.token}`, "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    }));
    return res.json();
  };
  const vault = await Vault.open(lib, { key: hexKey("5"), post: async (op, body) => {
    if (op === "claim") return { device: { user_id: who.user, device_id: who.device } };
    if (op === "request") return { response: await call(body.method, body.path, body.body) };
    const s = hs.sync(since, who);
    since = s.next_batch;
    const item = { id: ++n, to_device: s.to_device?.events ?? [], changed: s.device_lists?.changed ?? [], left: [] };
    return { items: item.to_device.length || item.changed.length ? [item] : [], counts: { otk_counts: s.device_one_time_keys_count ?? {}, fallback: [] } };
  } });
  const say = async (room, text) => (await call("PUT", `rooms/${encodeURIComponent(room)}/send/m.room.encrypted/t${++n}`, await vault.encrypt(room, textContent(text)))).event_id;
  const read = async () => {
    await vault.pump();
    const s = hs.sync(null, who);
    const out = [];
    for (const e of s.rooms.join[ROOM]?.timeline.events ?? []) if (e.type === "m.room.encrypted") out.push(textOf(await vault.decrypt(JSON.stringify({ ...e, room_id: ROOM }))));
    return out;
  };
  return { say, read };
}

// What a browser shows for a room's messages, decrypted with its vault.
async function shown(b, vault, roomName) {
  const room = (await api(b, "GET", "/state")).json.rooms.find(r => r.name === roomName);
  const msgs = (await api(b, "GET", `/rooms/${room.id}/messages`)).json.messages;
  await vault.pump();
  return Promise.all(msgs.map(async m => { const c = await vault.decrypt(m.raw); return c ? textOf(c) : null; }));
}

test("the keys follow you: another of your browsers takes them, reads what came before and after, and sends", async () => {
  const { env, laptop, phone, conn } = await setup();
  const sam = await samOnMatrix();
  const lap = browserKeys(laptop, conn);
  await lap.turnOn();
  await sam.say(ROOM, "the door code is 4471");
  await syncNow(laptop, conn);
  assert.deepEqual(await shown(laptop, lap.vault, "Secrets"), ["the door code is 4471"]);
  await lap.vault.save();
  const listed = (await api(phone, "GET", "/connections")).json[0];
  assert.equal(listed.keys_held, true);
  assert.equal(listed.keys_kept, true, "a copy is kept for your other browsers");
  assert.equal((await api(phone, "GET", "/state")).json.rooms.find(r => r.name === "Secrets").keys_kept, true);

  // Sam starts a new room after the laptop's last copy: the room key for it
  // comes through the inbox, and the laptop takes it in without saving again.
  await sam.say(ROOM2, "meet at the station");
  await syncNow(laptop, conn);
  clearTimeout(lap.vault.saving); lap.vault.dirty = false;   // (as if the laptop closed before its next copy)
  await lap.vault.pump();
  assert.deepEqual(await shown(laptop, lap.vault, "Later"), ["meet at the station"]);

  // The phone: the laptop was using them a moment ago, so they only come when asked to.
  const ph = browserKeys(phone, conn);
  const busy = await ph.take(false);
  assert.equal(busy.status, 200);
  assert.equal(busy.json.busy, true);
  assert.equal((await ph.take(true)).status, 200);
  assert.deepEqual(await shown(phone, ph.vault, "Secrets"), ["the door code is 4471"], "what came before the copy");
  assert.deepEqual(await shown(phone, ph.vault, "Later"), ["meet at the station"], "what came through the inbox after it");

  // New messages both ways, from the phone now.
  await sam.say(ROOM, "running late");
  await syncNow(phone, conn);
  assert.deepEqual(await shown(phone, ph.vault, "Secrets"), ["the door code is 4471", "running late"]);
  const room = (await api(phone, "GET", "/state")).json.rooms.find(r => r.name === "Secrets");
  const sent = await api(phone, "POST", `/rooms/${room.id}/messages`, { encrypted: await ph.vault.encrypt(ROOM, textContent("no rush")) });
  assert.equal(sent.status, 201);
  assert.deepEqual(await sam.read(), ["the door code is 4471", "running late", "no rush"]);

  // The laptop is told they've gone.
  await assert.rejects(lap.vault.pump(), err => err.code === "elsewhere" && /moved to another of your browsers/.test(err.message));

  // The site only ever had the copy locked, and the browser key sealed.
  const row = sqlOne(env, "SELECT crypto_vault, crypto_owner FROM chat_connections");
  assert.ok(!row.crypto_vault.includes(hexKey("a")));
  const copies = sqlOne(env, "SELECT group_concat(data, '') AS all_data FROM chat_crypto_copies").all_data;
  assert.match(copies, /^v1\./, "sealed with CHAT_BRIDGE_KEY");
  assert.ok(!copies.includes("4471"));

  // And back to the laptop, the same way, once the phone has sent its copy.
  await ph.vault.save();
  await lap.vault.close();
  await forget(lap.idb, lap.store);
  const back = await lap.take(true);
  assert.equal(back.status, 200);
  assert.deepEqual(await shown(laptop, lap.vault, "Secrets"), ["the door code is 4471", "running late", "no rush"]);
});

test("keys from before they could follow you start following on the next visit", async () => {
  const { laptop, phone, conn } = await setup();
  const lap = browserKeys(laptop, conn);
  await lap.turnOn({ legacy: true });
  assert.equal((await api(laptop, "GET", "/connections")).json[0].keys_kept, false);
  // The phone can't take them yet, and says where they are.
  const ph = browserKeys(phone, conn);
  const early = await ph.take(true);
  assert.equal(early.status, 403);
  assert.equal(early.json.code, "elsewhere");
  assert.match(early.json.error, /open chat there once/);
  // The laptop's page, updated, opens them again: it sends its browser key and a copy.
  await lap.open();
  await lap.vault.save();
  assert.equal((await api(laptop, "GET", "/connections")).json[0].keys_kept, true);
  assert.equal((await ph.take(true)).status, 200);
});

test("only the browser holding the keys can send a copy, and removing the connection takes the copy too", async () => {
  const { env, laptop, phone, conn } = await setup();
  const lap = browserKeys(laptop, conn);
  await lap.turnOn();
  await lap.vault.save();
  const theirs = await keysOp(phone, conn, "save", { key: hexKey("d"), copy: "x", ack: 0 });
  assert.equal(theirs.status, 403);
  assert.equal(theirs.json.code, "elsewhere");
  const big = await keysOp(laptop, conn, "save", { key: hexKey("a"), copy: "x".repeat(9 * 1024 * 1024), ack: 0 });
  assert.equal(big.status, 400);
  // The browser key can't be swapped for another once it's kept.
  await keysOp(laptop, conn, "claim", { key: hexKey("a"), vault: hexKey("e") });
  const taken = await keysOp(phone, conn, "take", { key: hexKey("f"), force: true });
  assert.equal(taken.json.vault, hexKey("a"));
  assert.equal((await api(phone, "DELETE", `/connections/${conn.id}`)).status, 200);
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM chat_crypto_copies").n, 0);
});

test("a copy of the keys keeps what IndexedDB holds as it was", async () => {
  const value = { a: new Uint8Array([1, 2, 255]), b: [1, "two", null, undefined], c: { $: "not a tag" }, d: new Date(5), e: new Map([["k", 1]]),
    f: Infinity, g: new Uint16Array([7, 65535]).subarray(1), h: new Uint8Array([9]).buffer, i: true };
  const back = decode(JSON.parse(JSON.stringify(encode(value))));
  assert.deepEqual(back, value);
  // Whole databases, with their stores, keys and indexes.
  const a = new IDBFactory(), b = new IDBFactory(), name = "x::matrix-sdk-crypto";
  await new Promise((ok, fail) => {
    const req = a.open(name, 3);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore("inline", { keyPath: "id" });
      s.createIndex("by_room", "room", { unique: false });
      req.result.createObjectStore("outline");
    };
    req.onsuccess = () => {
      const tx = req.result.transaction(["inline", "outline"], "readwrite");
      tx.objectStore("inline").put({ id: "s1", room: "!r", data: new Uint8Array([4, 5]) });
      tx.objectStore("outline").put("v", ["compound", 2]);
      tx.oncomplete = () => { req.result.close(); ok(); };
      tx.onerror = () => fail(tx.error);
    };
  });
  assert.equal(await pack(b, "x"), null, "nothing to copy in a browser without keys");
  await unpack(b, "x", await pack(a, "x"));
  const db = await new Promise(ok => { const r = b.open(name); r.onsuccess = () => ok(r.result); });
  assert.equal(db.version, 3);
  const get = (store, key, index) => new Promise(ok => {
    const s = db.transaction(store).objectStore(store), r = index ? s.index(index).get(key) : s.get(key);
    r.onsuccess = () => ok(r.result);
  });
  assert.deepEqual(await get("inline", "!r", "by_room"), { id: "s1", room: "!r", data: new Uint8Array([4, 5]) });
  assert.equal(await get("outline", ["compound", 2]), "v");
  db.close();
  await assert.rejects(unpack(b, "y", await pack(a, "x")), /for something else/);
});
