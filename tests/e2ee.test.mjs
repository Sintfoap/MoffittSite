// End-to-end encryption in Matrix rooms, for real: the chat page's vault
// (public/chat/e2ee.js) with Matrix's crypto library, through the site, to a
// stand-in homeserver (tests/fake-matrix.mjs), and Sam on the other side with
// the same library talking to the homeserver directly, as Element would.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps, sqlOne } from "./helpers.mjs";
import { FakeMatrix } from "./fake-matrix.mjs";
import * as lib from "../public/chat/vendor/matrix-crypto/node.mjs";
import { Vault, textOf, textContent, editContent } from "../public/chat/e2ee.js";

const ROOM = "!secret:matrix.test";
let hs;
afterEach(() => hs?.uninstall());

const api = (b, method, path, json) => b.req(method, "/chat/api" + path, json === undefined ? {} : { json });
const hexKey = c => c.repeat(64);
// (Polling syncs at most every few seconds; the tests don't wait.)
const syncNow = (b, conn) => api(b, "POST", `/connections/${conn.id}/sync`);

async function setup() {
  hs = new FakeMatrix().install();
  hs.room(ROOM, { name: "Secrets", encrypted: true, members: { "@ryan:matrix.test": "Ryan", "@sam:matrix.test": "Sam" } });
  const env = makeEnv({ CHAT_BRIDGE_KEY: "test-bridge-key-0123456789abcdef" });
  const ryan = new Browser(env);
  assert.equal((await ryan.signup("ryan")).status, 303);
  grantApps(env, "ryan", "chat", "chat-bridges");
  const conn = (await api(ryan, "POST", "/connections", { provider: "matrix", homeserver: "matrix.test", username: "ryan", password: "hunter22hunter22" })).json;
  return { env, ryan, conn };
}

// The chat page's side: the vault, posting to the site's crypto routes.
const siteVault = (b, conn, key = hexKey("a")) => Vault.open(lib, {
  key,
  post: async (op, body) => {
    const r = await api(b, "POST", `/connections/${conn.id}/crypto/${op}`, body);
    if (r.status !== 200) throw Object.assign(new Error(r.json.error), { status: r.status });
    return r.json;
  },
});

// Sam, on his own device, syncing straight from the homeserver.
async function samOnMatrix() {
  const who = hs.person("@sam:matrix.test", "SAMDEV", "syt_sam");
  let since = null, n = 0;
  const timeline = [];
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
    // inbox: a sync of his own.
    const s = hs.sync(since, who);
    since = s.next_batch;
    for (const [room, r] of Object.entries(s.rooms.join)) for (const e of r.timeline.events) timeline.push({ ...e, room_id: room });
    const counts = { otk_counts: s.device_one_time_keys_count ?? {}, fallback: s.device_unused_fallback_key_types ?? [] };
    const item = { id: ++n, to_device: s.to_device?.events ?? [], changed: s.device_lists?.changed ?? [], left: [] };
    return { items: item.to_device.length || item.changed.length ? [item] : [], counts };
  } });
  const say = async (content) => {
    const enc = await vault.encrypt(ROOM, content);
    return (await call("PUT", `rooms/${encodeURIComponent(ROOM)}/send/m.room.encrypted/t${++n}`, enc)).event_id;
  };
  // What Sam's Element shows: each message's text, edits applied.
  const read = async () => {
    await vault.pump();
    const shown = new Map();
    for (const e of timeline.filter(e => e.type === "m.room.encrypted")) {
      const c = await vault.decrypt(JSON.stringify(e));
      const rel = e.content["m.relates_to"];
      if (rel?.rel_type === "m.replace") { if (shown.has(rel.event_id)) shown.set(rel.event_id, textOf(c)); }
      else shown.set(e.event_id, c ? textOf(c) : null);
    }
    return [...shown.values()];
  };
  return { vault, say, read };
}

test("an encrypted room can be read and written from the chat page, and the site never sees the words", async () => {
  const { env, ryan, conn } = await setup();
  assert.equal(conn.can_encrypt, true, "a password sign-in has a session of its own to hold keys");
  assert.equal(conn.keys_held, false);
  const ryanVault = await siteVault(ryan, conn);
  assert.ok(hs.keys.get("@ryan:matrix.test|SITE")?.device_keys, "the browser uploaded the site session's keys");
  assert.equal((await api(ryan, "GET", "/connections")).json[0].keys_held, true);

  const sam = await samOnMatrix();
  await sam.say(textContent("the door code is 4471"));

  // Ryan's page polls; the sync it runs brings Sam's message and the room key for it.
  await syncNow(ryan, conn);
  const room = (await api(ryan, "GET", "/state")).json.rooms.find(r => r.encrypted);
  assert.equal(room.keys_held, true);
  const msgs = (await api(ryan, "GET", `/rooms/${room.id}/messages`)).json.messages;
  await ryanVault.pump();
  assert.equal(msgs.length, 1);
  assert.equal(textOf(await ryanVault.decrypt(msgs[0].raw)), "the door code is 4471");
  assert.equal(msgs[0].author_name, "Sam");

  // Ryan answers: encrypted here, so the site only passes on ciphertext.
  const sent = await api(ryan, "POST", `/rooms/${room.id}/messages`, { encrypted: await ryanVault.encrypt(ROOM, textContent("got it, thanks")) });
  assert.equal(sent.status, 201);
  assert.equal(sent.json.mine, true);
  assert.equal(textOf(await ryanVault.decrypt(sent.json.raw)), "got it, thanks", "your own messages read back too");
  assert.deepEqual(await sam.read(), ["the door code is 4471", "got it, thanks"]);

  // Ryan edits it, encrypted too; Sam sees the new words.
  const edited = await api(ryan, "PATCH", `/rooms/${room.id}/messages/${sent.json.id}`,
    { encrypted: await ryanVault.encrypt(ROOM, editContent(sent.json.ext_id, "got it, see you at 6")) });
  assert.equal(edited.status, 200);
  assert.ok(edited.json.edited_at);
  assert.equal(textOf(await ryanVault.decrypt(edited.json.raw)), "got it, see you at 6");
  assert.deepEqual(await sam.read(), ["the door code is 4471", "got it, see you at 6"]);

  // Sam edits his; Ryan's page shows the edit.
  const samFirst = JSON.parse(msgs[0].raw).event_id;
  await sam.say(editContent(samFirst, "the door code is 4472"));
  await syncNow(ryan, conn);
  const after = (await api(ryan, "GET", `/rooms/${room.id}/messages`)).json.messages;
  await ryanVault.pump();
  const his = after.find(m => m.ext_id === samFirst);
  assert.ok(his.edited_at);
  assert.equal(textOf(await ryanVault.decrypt(his.raw)), "the door code is 4472");

  // Nowhere on the site or the homeserver is there a word of it in the clear.
  const everything = JSON.stringify(hs.events) + JSON.stringify(sqlOne(env, "SELECT group_concat(body || COALESCE(ext_raw, ''), '|') AS all_text FROM chat_messages"));
  for (const words of ["door code", "got it"]) assert.ok(!everything.includes(words), `"${words}" was seen in the clear`);
});

test("one browser holds a connection's keys; others are told where they are", async () => {
  const { ryan, conn } = await setup();
  await siteVault(ryan, conn);
  await assert.rejects(siteVault(ryan, conn, hexKey("b")), /another browser holds/);
  // The same browser comes back fine.
  await siteVault(ryan, conn);
  // The key requests passed on are only the ones encryption needs.
  const r = await api(ryan, "POST", `/connections/${conn.id}/crypto/request`, { key: hexKey("a"), method: "GET", path: "account/whoami" });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /isn't one the encryption needs/);
  const bad = await api(ryan, "POST", `/connections/${conn.id}/crypto/inbox`, { key: "nope" });
  assert.equal(bad.status, 400);
});

test("plain text can't be sent to an encrypted room, and encrypted content only goes to one", async () => {
  const { ryan } = await setup();
  const room = (await api(ryan, "GET", "/state")).json.rooms.find(r => r.encrypted);
  const plain = await api(ryan, "POST", `/rooms/${room.id}/messages`, { body: "hello" });
  assert.equal(plain.status, 403);
  assert.match(plain.json.error, /browser that holds its keys/);
  const mine = await api(ryan, "POST", "/rooms", { name: "Plain" });
  const r = await api(ryan, "POST", `/rooms/${mine.json.id}/messages`, { encrypted: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "x" } });
  assert.equal(r.status, 400);
});
