// Tests for push notifications: the settings API, the encryption and VAPID
// token, Chat's pushes and Drift's reminders. Push services are stood in for
// by a fake fetch that decrypts what it's sent, as a browser would.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, run, sql, sqlOne, grantApps } from "./helpers.mjs";
import { encrypt, vapidAuth, pushEndpoint } from "../src/push.js";
import { driftReminders, localToUtc } from "../src/notify.js";
import { b64url, fromB64url } from "../src/crypto.js";

const enc = new TextEncoder();
const subtle = crypto.subtle;

// A VAPID key pair in the form the secrets take.
async function vapidKeys() {
  const k = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    VAPID_PUBLIC_KEY: b64url(new Uint8Array(await subtle.exportKey("raw", k.publicKey))),
    VAPID_PRIVATE_KEY: (await subtle.exportKey("jwk", k.privateKey)).d,
  };
}

// A browser's side of a push subscription: its keys, and decrypting what arrives.
async function pushBrowser(n) {
  const keys = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await subtle.exportKey("raw", keys.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const endpoint = `https://fcm.googleapis.com/fcm/send/device-${n}`;
  return {
    endpoint, keys,
    subscription: { endpoint, keys: { p256dh: b64url(pub), auth: b64url(auth) } },
    async decrypt(body) {
      const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), sealed = body.slice(21 + idlen);
      const asKey = await subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
      const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: asKey }, keys.privateKey, 256));
      const hkdf = async (s, ikm, info, len) => new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info },
        await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), len * 8));
      const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...pub, ...asPub]);
      const ikm = await hkdf(auth, shared, info, 32);
      const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
      const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
      const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce },
        await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), sealed));
      assert.equal(plain.at(-1), 2, "one record, marked last");
      return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
    },
  };
}

// The push services: every POST is recorded, and answered with `status`.
let sent, status, realFetch, devices;
beforeEach(() => {
  sent = []; status = 201; devices = new Map(); realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const dev = devices.get(String(url));
    sent.push({ url: String(url), headers: init.headers, to: dev?.name, message: dev ? await dev.decrypt(new Uint8Array(init.body)) : null });
    return new Response(null, { status: typeof status === "function" ? status(String(url)) : status });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function person(env, name, ...apps) {
  const b = new Browser(env);
  assert.equal((await b.signup(name, undefined, name[0].toUpperCase() + name.slice(1))).status, 303);
  grantApps(env, name, ...apps);
  return b;
}
const api = (b, method, path, json) => b.req(method, "/notifications/api" + path, json === undefined ? {} : { json });

// Turns notifications on for one of this person's "browsers".
async function subscribe(b, name, n = 1, extra = {}) {
  const dev = await pushBrowser(`${name}-${n}`);
  dev.name = name;
  devices.set(dev.endpoint, dev);
  const r = await api(b, "POST", "/devices", { ...dev.subscription, label: `Phone ${n}`, ...extra });
  assert.equal(r.status, 201, r.text);
  return { ...dev, id: r.json.device };
}

test("Notifications is an app with its own toggle, off until an admin turns it on", async () => {
  const env = makeEnv({ ...await vapidKeys() });
  const b = await person(env, "josh");
  assert.equal((await b.get("/notifications/")).status, 403);
  assert.equal((await api(b, "GET", "/state")).status, 403);
  assert.doesNotMatch((await b.get("/dashboard")).text, /href="\/notifications\/"/);
  grantApps(env, "josh", "notifications");
  const page = await b.get("/notifications/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("Content-Security-Policy"), /worker-src 'self'/);
  assert.match(page.headers.get("Content-Security-Policy"), /manifest-src 'self'/);
  // It's listed with settings in the rail, with its g key.
  assert.match((await b.get("/account")).text, /href="\/notifications\/" data-key="n"/);
  assert.equal((await new Browser(env).get("/notifications/api/state")).status, 401);
  assert.equal((await b.get("/notifications")).status, 308);
});

test("without the VAPID secrets push is off and nothing can be turned on", async () => {
  const env = makeEnv();
  const b = await person(env, "josh", "notifications", "chat");
  const s = (await api(b, "GET", "/state")).json;
  assert.equal(s.configured, false);
  assert.equal(s.public_key, null);
  const dev = await pushBrowser(1);
  const r = await api(b, "POST", "/devices", dev.subscription);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /aren't set up/);
});

test("settings: defaults, saving, devices, and what's refused", async () => {
  const keys = await vapidKeys();
  const env = makeEnv(keys);
  const b = await person(env, "josh", "notifications", "chat");
  const s = (await api(b, "GET", "/state")).json;
  assert.equal(s.configured, true);
  assert.equal(s.public_key, keys.VAPID_PUBLIC_KEY);
  assert.deepEqual(s.prefs, { chat_dms: true, chat_mentions: true, chat_rooms: false, chat_bridges: true, drift_events: true, drift_lead: 15, tz: "UTC" });
  assert.deepEqual(s.apps, { chat: true, drift: true, bridges: false });
  assert.deepEqual(s.devices, []);

  const p = await api(b, "PATCH", "/prefs", { chat_rooms: true, drift_lead: 60, tz: "America/Chicago" });
  assert.equal(p.status, 200);
  assert.deepEqual(p.json.prefs, { chat_dms: true, chat_mentions: true, chat_rooms: true, chat_bridges: true, drift_events: true, drift_lead: 60, tz: "America/Chicago" });
  for (const bad of [{ drift_lead: 7 }, { chat_dms: "yes" }, { tz: "Mars/Olympus" }, { nope: true }]) {
    assert.equal((await api(b, "PATCH", "/prefs", bad)).status, 400, JSON.stringify(bad));
  }

  const dev = await subscribe(b, "josh", 1, { tz: "Europe/London" });
  let st = (await api(b, "GET", "/state")).json;
  assert.equal(st.devices.length, 1);
  assert.equal(st.devices[0].label, "Phone 1");
  assert.equal(st.prefs.tz, "Europe/London", "the browser's time zone");
  // Subscribing the same browser again doesn't add a second one.
  await subscribe(b, "josh", 1);
  assert.equal((await api(b, "GET", "/state")).json.devices.length, 1);

  // Only real push services, and only well-formed keys.
  const other = await pushBrowser(9);
  for (const endpoint of ["https://evil.example/push", "http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.example/x", "not a url"]) {
    assert.equal((await api(b, "POST", "/devices", { ...other.subscription, endpoint })).status, 400, endpoint);
  }
  assert.equal((await api(b, "POST", "/devices", { ...other.subscription, keys: { p256dh: "AAAA", auth: other.subscription.keys.auth } })).status, 400);
  assert.ok(pushEndpoint("https://web.push.apple.com/QGx"));
  assert.ok(pushEndpoint("https://wns2-bl2p.notify.windows.com/w/?token=x"));
  assert.ok(pushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x"));

  // Someone else signing in on that browser and turning them on takes it over.
  const amy = await person(env, "amy", "notifications");
  assert.equal((await api(amy, "POST", "/devices", dev.subscription)).status, 201);
  assert.equal((await api(b, "GET", "/state")).json.devices.length, 0);
  assert.equal((await api(b, "DELETE", "/devices/" + dev.id)).status, 404, "not yours any more");
  assert.equal((await api(amy, "DELETE", "/devices/" + dev.id)).json.devices.length, 0);

  // Cross-site writes are refused.
  assert.equal((await b.req("PATCH", "/notifications/api/prefs", { json: { chat_dms: false }, origin: "https://evil.example" })).status, 403);
});

test("a test push is encrypted for the browser and signed with the site's key", async () => {
  const keys = await vapidKeys();
  const env = makeEnv(keys);
  const b = await person(env, "josh", "notifications");
  const dev = await subscribe(b, "josh");
  const r = await api(b, "POST", "/test");
  assert.equal(r.json.sent, 1);
  assert.equal(sent.length, 1);
  const [push] = sent;
  assert.equal(push.url, dev.endpoint);
  assert.deepEqual(push.message, { title: "Notifications are on", body: "This is what they'll look like.", url: "/notifications/", tag: "test" });
  assert.equal(push.headers["Content-Encoding"], "aes128gcm");
  assert.ok(Number(push.headers.TTL) > 0);

  // The VAPID token: for this push service, signed by our key.
  const [, jwt, k] = push.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, keys.VAPID_PUBLIC_KEY);
  const [h, c, sig] = jwt.split(".");
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(c)));
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);
  assert.equal(claims.sub, "https://sintfoap.xyz");
  const pub = await subtle.importKey("raw", fromB64url(keys.VAPID_PUBLIC_KEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, fromB64url(sig), enc.encode(`${h}.${c}`)));
  assert.equal(sqlOne(env, "SELECT failures FROM push_devices").failures, 0);
  assert.ok(sqlOne(env, "SELECT last_ok FROM push_devices").last_ok);

  // A push service saying the subscription is gone forgets the device.
  status = 410;
  assert.equal((await api(b, "POST", "/test")).json.sent, 0);
  assert.equal(sql(env, "SELECT * FROM push_devices").length, 0);
});

test("encrypt() output is a single aes128gcm record the browser can read", async () => {
  const dev = await pushBrowser(1);
  const body = await encrypt('{"hi":1}', dev.subscription.keys.p256dh, dev.subscription.keys.auth);
  assert.equal(new DataView(body.buffer).getUint32(16), 4096);
  assert.equal(body[20], 65);
  assert.deepEqual(await dev.decrypt(body), { hi: 1 });
  await assert.rejects(encrypt("x", "AAAA", dev.subscription.keys.auth));
  assert.match(await vapidAuth(await vapidKeys(), "https://web.push.apple.com/abc"), /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
});

// ── Chat ───────────────────────────────────────────────────────────────────

const chat = (b, method, path, json) => b.req(method, "/chat/api" + path, json === undefined ? {} : { json });

test("chat: direct messages and mentions push; open rooms and your own messages don't", async () => {
  const env = makeEnv(await vapidKeys());
  const amy = await person(env, "amy", "chat", "notifications");
  const bob = await person(env, "bob", "chat", "notifications");
  await subscribe(bob, "bob");
  await subscribe(amy, "amy");

  const dm = (await chat(amy, "POST", "/dms", { username: "bob" })).json.id;
  assert.equal((await chat(amy, "POST", `/rooms/${dm}/messages`, { body: "lunch?" })).status, 201);
  assert.deepEqual(sent.map(s => [s.to, s.message]), [["bob", { url: `/chat/#${dm}`, tag: `chat-${dm}`, title: "Amy", body: "lunch?" }]]);
  assert.equal(sent[0].headers.Urgency, "high");

  // Not while Bob has the room open.
  sent = [];
  await chat(bob, "GET", `/rooms/${dm}/messages`);
  await chat(amy, "POST", `/rooms/${dm}/messages`, { body: "still there?" });
  assert.equal(sent.length, 0);
  run(env, "UPDATE chat_presence SET seen_at = seen_at - 60");

  // An open room: members only hear about it if they asked for every message.
  const room = (await chat(amy, "POST", "/rooms", { name: "general" })).json.id;
  await chat(bob, "POST", `/rooms/${room}/join`);
  run(env, "UPDATE chat_presence SET seen_at = 0");
  sent = [];
  await chat(amy, "POST", `/rooms/${room}/messages`, { body: "hello all" });
  assert.equal(sent.length, 0);
  await chat(amy, "POST", `/rooms/${room}/messages`, { body: "hey @bob look" });
  assert.deepEqual(sent.map(s => [s.to, s.message.title, s.message.body]), [["bob", "Amy mentioned you in #general", "hey @bob look"]]);

  sent = [];
  await api(bob, "PATCH", "/prefs", { chat_rooms: true, chat_mentions: false });
  await chat(amy, "POST", `/rooms/${room}/messages`, { body: "and another" });
  assert.deepEqual(sent.map(s => [s.to, s.message.title, s.message.body]), [["bob", "#general", "Amy: and another"]]);

  // DMs off, Notifications turned off by an admin, or Chat turned off: nothing.
  sent = [];
  await api(bob, "PATCH", "/prefs", { chat_dms: false });
  await chat(amy, "POST", `/rooms/${dm}/messages`, { body: "one" });
  await api(bob, "PATCH", "/prefs", { chat_dms: true });
  const { id: bobId } = sqlOne(env, "SELECT id FROM users WHERE username = 'bob'");
  run(env, "DELETE FROM user_areas WHERE user_id = ? AND area = 'notifications'", bobId);
  await chat(amy, "POST", `/rooms/${dm}/messages`, { body: "two" });
  assert.equal(sent.length, 0);
});

test("chat: a mention in a private room only reaches its members", async () => {
  const env = makeEnv(await vapidKeys());
  const amy = await person(env, "amy", "chat", "notifications");
  const cat = await person(env, "cat", "chat", "notifications");
  await subscribe(cat, "cat");
  const room = (await chat(amy, "POST", "/rooms", { name: "secret", private: true })).json.id;
  await chat(amy, "POST", `/rooms/${room}/messages`, { body: "@cat you can't see this" });
  assert.equal(sent.length, 0);
  await chat(amy, "POST", `/rooms/${room}/members`, { username: "cat" });
  await chat(amy, "POST", `/rooms/${room}/messages`, { body: "@cat now you can" });
  assert.deepEqual(sent.map(s => s.message.title), ["Amy mentioned you in #secret"]);
});

// ── Drift ──────────────────────────────────────────────────────────────────

test("localToUtc reads wall-clock times in a time zone, across daylight saving", () => {
  assert.equal(new Date(localToUtc("2026-07-01T09:00", "America/New_York")).toISOString(), "2026-07-01T13:00:00.000Z");
  assert.equal(new Date(localToUtc("2026-12-01T09:00", "America/New_York")).toISOString(), "2026-12-01T14:00:00.000Z");
  assert.equal(new Date(localToUtc("2026-03-29T01:30", "Europe/London")).toISOString(), "2026-03-29T01:30:00.000Z");
  assert.equal(new Date(localToUtc("2026-06-15T23:45", "Asia/Kolkata")).toISOString(), "2026-06-15T18:15:00.000Z");
  assert.equal(new Date(localToUtc("2026-06-15T12:00", "UTC")).toISOString(), "2026-06-15T12:00:00.000Z");
});

test("drift: a reminder before each timed item, once, for the owner and people it's shared with", async () => {
  const env = makeEnv(await vapidKeys());
  const amy = await person(env, "amy", "notifications");
  const bob = await person(env, "bob", "notifications");
  await subscribe(amy, "amy", 1, { tz: "America/New_York" });
  await subscribe(bob, "bob", 1, { tz: "America/Los_Angeles" });

  const col = (await amy.get("/todo/api/state")).json.collections[0].id;
  await amy.req("PATCH", `/todo/api/collections/${col}`, { json: { name: "Home" } });
  await amy.req("POST", `/todo/api/collections/${col}/shares`, { json: { username: "bob", role: "view" } });
  const item = (await amy.req("POST", "/todo/api/items", { json: { collection: col, title: "Dentist", meta: { event: { start: "2026-11-02T15:00", end: null } } } })).json;
  await amy.req("POST", "/todo/api/items", { json: { collection: col, title: "Done already", meta: { event: { start: "2026-11-02T15:00", end: null }, checklist: { done: true, priority: 0 } } } });

  // 3pm in New York is 20:00 UTC that day; Amy hears 15 minutes before.
  const start = Date.parse("2026-11-02T20:00:00Z");
  assert.equal(await driftReminders(env, start - 20 * 60_000), 0, "too early");
  assert.equal(await driftReminders(env, start - 14 * 60_000), 1);
  assert.deepEqual(sent.map(s => [s.to, s.message]), [["amy", { title: "Dentist", body: "At 3 pm, in 15 minutes · Home", url: "/todo/", tag: `drift-${item.id}` }]]);
  assert.equal(await driftReminders(env, start - 9 * 60_000), 0, "only once");

  // Bob reads the same "3pm" in his own time zone (Los Angeles: 23:00 UTC).
  sent = [];
  await api(bob, "PATCH", "/prefs", { drift_lead: 0 });
  assert.equal(await driftReminders(env, Date.parse("2026-11-02T23:01:00Z")), 1);
  assert.deepEqual(sent.map(s => [s.to, s.message.body]), [["bob", "Starting now, 3 pm · Home"]]);

  // Moving the item reminds again at its new time.
  sent = [];
  await amy.req("PATCH", `/todo/api/items/${item.id}`, { json: { meta: { event: { start: "2026-11-02T16:30", end: null } } } });
  assert.equal(await driftReminders(env, Date.parse("2026-11-02T21:20:00Z")), 1);
  assert.equal(sent[0].message.body, "At 4:30 pm, in 15 minutes · Home");

  // Turned off: nothing.
  sent = [];
  await api(amy, "PATCH", "/prefs", { drift_events: false });
  await amy.req("PATCH", `/todo/api/items/${item.id}`, { json: { meta: { event: { start: "2026-11-02T18:00", end: null } } } });
  assert.equal(await driftReminders(env, Date.parse("2026-11-02T22:50:00Z")), 0);
});

test("drift: all-day items remind at 8am, and deleted ones don't", async () => {
  const env = makeEnv(await vapidKeys());
  const amy = await person(env, "amy", "notifications");
  await subscribe(amy, "amy", 1, { tz: "UTC" });
  const col = (await amy.get("/todo/api/state")).json.collections[0].id;
  const gone = (await amy.req("POST", "/todo/api/items", { json: { collection: col, title: "Cancelled", meta: { event: { start: "2026-11-03", end: null } } } })).json;
  await amy.req("DELETE", `/todo/api/items/${gone.id}`);
  await amy.req("POST", "/todo/api/items", { json: { collection: col, title: "Renew domain", meta: { event: { start: "2026-11-03", end: null } } } });
  assert.equal(await driftReminders(env, Date.parse("2026-11-03T07:55:00Z")), 0);
  assert.equal(await driftReminders(env, Date.parse("2026-11-03T08:02:00Z")), 1);
  assert.deepEqual(sent.map(s => [s.message.title, s.message.body.split(" · ")[0]]), [["Renew domain", "Today"]]);
  // A cron run that's very late doesn't send stale reminders.
  run(env, "DELETE FROM push_sent");
  sent = [];
  assert.equal(await driftReminders(env, Date.parse("2026-11-03T10:00:00Z")), 0);
});

test("deleting an account forgets its devices and settings", async () => {
  const env = makeEnv(await vapidKeys());
  const josh = await person(env, "josh", "notifications");
  await subscribe(josh, "josh");
  await api(josh, "PATCH", "/prefs", { chat_rooms: true });
  const { id } = sqlOne(env, "SELECT id FROM users WHERE username = 'josh'");
  const ryan = await person(env, "ryan");
  const { id: rid } = sqlOne(env, "SELECT id FROM users WHERE username = 'ryan'");
  run(env, "INSERT INTO user_areas (user_id, area) VALUES (?, 'admin')", rid);
  run(env, "UPDATE users SET totp_secret = 'AAAAAAAAAAAAAAAA' WHERE id = ?", rid);
  const r = await ryan.post("/admin/delete", { user_id: id, confirm: "josh" });
  assert.ok(r.status < 400, r.text.slice(0, 200));
  assert.equal(sql(env, "SELECT * FROM push_devices").length, 0);
  assert.equal(sql(env, "SELECT * FROM push_prefs").length, 0);
});
