// Tests for push notifications from chat connections: a Matrix pusher that
// tells the site about new messages, and the cron's syncs when there's none.
// The homeserver is tests/fake-matrix.mjs; push services are a fake fetch.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { Browser, makeEnv, run, sqlOne, grantApps, ORIGIN } from "./helpers.mjs";
import { FakeMatrix } from "./fake-matrix.mjs";
import { bridgeUpkeep } from "../src/notify.js";
import { b64url } from "../src/crypto.js";

let hs, pushes;
afterEach(() => hs?.uninstall());

async function vapidKeys() {
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  return { VAPID_PUBLIC_KEY: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey))),
           VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey("jwk", k.privateKey)).d };
}

// A homeserver with ryan in "Family" and a DM with Sam, and push services
// that note what they're sent (counted, not decrypted: tests/notifications
// checks the encryption).
async function setup() {
  hs = new FakeMatrix().install();
  hs.room("!fam:matrix.test", { name: "Family", members: { "@ryan:matrix.test": "Ryan", "@sam:matrix.test": "Sam", "@kim:matrix.test": "Kim" } });
  hs.room("!dm:matrix.test", { name: "Sam", members: { "@ryan:matrix.test": "Ryan", "@sam:matrix.test": "Sam" } });
  hs.say("!fam:matrix.test", "@sam:matrix.test", "old news");
  pushes = [];
  const matrix = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input.url || input);
    if (url.host !== "fcm.googleapis.com") return matrix(input, init);
    pushes.push(url.pathname);
    return new Response(null, { status: 201 });
  };
  const env = makeEnv({ CHAT_BRIDGE_KEY: "test-bridge-key-0123456789abcdef", SITE_URL: "https://sintfoap.test", ...await vapidKeys() });
  const ryan = new Browser(env);
  assert.equal((await ryan.signup("ryan")).status, 303);
  grantApps(env, "ryan", "chat", "chat-bridges", "notifications");
  const conn = (await ryan.req("POST", "/chat/api/connections", { json: { provider: "matrix", homeserver: "matrix.test", token: "syt_good" } })).json;
  // A phone with notifications on.
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const r = await ryan.req("POST", "/notifications/api/devices", { json: { endpoint: "https://fcm.googleapis.com/fcm/send/ryan",
    keys: { p256dh: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey))), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) } } });
  assert.equal(r.status, 201);
  return { env, ryan, conn };
}

// The homeserver telling the site about an event, as Synapse does.
async function notify(env, pushkey, event_id) {
  const res = await worker.fetch(new Request(ORIGIN + "/_matrix/push/v1/notify", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notification: { event_id, room_id: "!fam:matrix.test", counts: { unread: 1 }, devices: [{ app_id: "xyz.sintfoap.chat", pushkey }] } }) }), env);
  return res.json();
}

test("the cron registers a pusher on Matrix that points at the site, and takes it off again", async () => {
  const { env, ryan } = await setup();
  assert.equal(hs.pushers.size, 0, "not until the cron runs");
  await bridgeUpkeep(env);
  assert.equal(hs.pushers.size, 1);
  const [[key, p]] = hs.pushers;
  assert.deepEqual(p, { url: "https://sintfoap.test/_matrix/push/v1/notify", app_id: "xyz.sintfoap.chat", format: "event_id_only" });
  assert.match(key, /^k_[0-9a-f]{16}\.[\w-]+$/);
  assert.ok(sqlOne(env, "SELECT pusher_at FROM chat_connections").pusher_at > 0);

  // Turned off in settings: the next run takes the pusher away.
  await ryan.req("PATCH", "/notifications/api/prefs", { json: { chat_bridges: false } });
  await bridgeUpkeep(env);
  assert.equal(hs.pushers.size, 0);
  assert.equal(sqlOne(env, "SELECT pusher_at FROM chat_connections").pusher_at, 0);

  // Removing the connection takes its pusher too.
  await ryan.req("PATCH", "/notifications/api/prefs", { json: { chat_bridges: true } });
  await bridgeUpkeep(env);
  assert.equal(hs.pushers.size, 1);
  const id = sqlOne(env, "SELECT id FROM chat_connections").id;
  await ryan.req("DELETE", `/chat/api/connections/${id}`);
  assert.equal(hs.pushers.size, 0);
});

test("a pusher notification syncs and pushes that message, once", async () => {
  const { env } = await setup();
  await bridgeUpkeep(env);
  const [key] = hs.pushers.keys();
  const ev = hs.say("!fam:matrix.test", "@sam:matrix.test", "dinner's ready");
  assert.deepEqual(await notify(env, key, ev), { rejected: [] });
  assert.equal(pushes.length, 1);
  assert.equal(sqlOne(env, "SELECT body FROM chat_messages WHERE ext_id = ?", ev).body, "dinner's ready", "it was synced in");
  // The same event again (a retry) isn't pushed twice.
  await notify(env, key, ev);
  assert.equal(pushes.length, 1);
  // Your own messages, and a count-only notification, push nothing.
  const mine = hs.say("!fam:matrix.test", "@ryan:matrix.test", "coming");
  await notify(env, key, mine);
  await notify(env, key, undefined);
  assert.equal(pushes.length, 1);
});

test("a forged or stale pusher key is rejected, so the homeserver drops it", async () => {
  const { env } = await setup();
  await bridgeUpkeep(env);
  const [key] = hs.pushers.keys();
  const ev = hs.say("!fam:matrix.test", "@sam:matrix.test", "hi");
  const forged = key.split(".")[0] + ".AAAA";
  assert.deepEqual(await notify(env, forged, ev), { rejected: [forged] });
  assert.deepEqual(await notify(env, "nonsense", ev), { rejected: ["nonsense"] });
  assert.equal(pushes.length, 0);
  // A connection whose pusher the site took off.
  run(env, "UPDATE chat_connections SET pusher_at = 0");
  assert.deepEqual(await notify(env, key, ev), { rejected: [key] });
  const bad = await worker.fetch(new Request(ORIGIN + "/_matrix/push/v1/notify", { method: "POST", body: "{}" }), env);
  assert.equal(bad.status, 400);
});

test("no push while the room is open, or without the settings and access for it", async () => {
  const { env, ryan } = await setup();
  await bridgeUpkeep(env);
  const [key] = hs.pushers.keys();
  const roomId = sqlOne(env, "SELECT id FROM chat_rooms WHERE name = 'Family'").id;
  await ryan.req("GET", `/chat/api/rooms/${roomId}/messages`);
  await notify(env, key, hs.say("!fam:matrix.test", "@sam:matrix.test", "you're here"));
  assert.equal(pushes.length, 0);
  run(env, "UPDATE chat_presence SET seen_at = 0");
  await ryan.req("PATCH", "/notifications/api/prefs", { json: { chat_bridges: false } });
  await notify(env, key, hs.say("!fam:matrix.test", "@sam:matrix.test", "off"));
  assert.equal(pushes.length, 0);
  await ryan.req("PATCH", "/notifications/api/prefs", { json: { chat_bridges: true } });
  const { id } = sqlOne(env, "SELECT id FROM users WHERE username = 'ryan'");
  run(env, "DELETE FROM user_areas WHERE user_id = ? AND area = 'notifications'", id);
  await notify(env, key, hs.say("!fam:matrix.test", "@sam:matrix.test", "no access"));
  assert.equal(pushes.length, 0);
});

test("with no pusher, the cron's sync pushes what it brings in, one notification per room", async () => {
  const { env } = await setup();
  hs.refusePushers = true;
  await bridgeUpkeep(env);
  assert.equal(sqlOne(env, "SELECT pusher_at FROM chat_connections").pusher_at, 0);
  assert.equal(pushes.length, 0, "the first upkeep's sync has nothing new");
  hs.say("!fam:matrix.test", "@sam:matrix.test", "one");
  hs.say("!fam:matrix.test", "@kim:matrix.test", "two");
  hs.encrypted("!dm:matrix.test", "@sam:matrix.test");
  run(env, "UPDATE chat_connections SET tried_at = 0");
  await bridgeUpkeep(env);
  assert.equal(pushes.length, 2, "Family and the DM");
  run(env, "UPDATE chat_connections SET tried_at = 0");
  await bridgeUpkeep(env);
  assert.equal(pushes.length, 2, "nothing new");
});

test("the settings say whether connections can notify", async () => {
  const { ryan } = await setup();
  const s = (await ryan.req("GET", "/notifications/api/state")).json;
  assert.equal(s.apps.bridges, true);
  assert.equal(s.prefs.chat_bridges, true);
});
