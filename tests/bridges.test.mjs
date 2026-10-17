// Tests for chat connections (src/bridges.js) and the Matrix provider
// (src/matrix.js), against a stand-in homeserver (tests/fake-matrix.mjs).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, run, sql, sqlOne, grantApps } from "./helpers.mjs";
import { FakeMatrix } from "./fake-matrix.mjs";
import { serverUrl } from "../src/matrix.js";
import { seal, unseal } from "../src/crypto.js";

const KEY = "test-bridge-key-0123456789abcdef";
let hs;
afterEach(() => hs?.uninstall());

async function person(env, name, ...apps) {
  const b = new Browser(env);
  assert.equal((await b.signup(name)).status, 303);
  grantApps(env, name, "chat", ...apps);
  return b;
}
const api = (b, method, path, json) => b.req(method, "/chat/api" + path, json === undefined ? {} : { json });
const connect = (b, fields = { homeserver: "matrix.test", token: "syt_good" }) => api(b, "POST", "/connections", { provider: "matrix", ...fields });
const syncNow = (b, id) => api(b, "POST", `/connections/${id}/sync`);

function setup() {
  hs = new FakeMatrix().install();
  hs.room("!fam:matrix.test", { name: "Family", members: { "@ryan:matrix.test": "Ryan", "@sam:matrix.test": "Sam" } });
  hs.say("!fam:matrix.test", "@sam:matrix.test", "old news");
  return { env: makeEnv({ CHAT_BRIDGE_KEY: KEY }) };
}

test("connections are their own app, off until an admin turns them on", async () => {
  const { env } = setup();
  const ryan = await person(env, "ryan");
  const s = (await api(ryan, "GET", "/state")).json;
  assert.deepEqual(s.bridges, { allowed: false });
  assert.equal((await api(ryan, "GET", "/connections")).status, 403);
  assert.equal((await connect(ryan)).status, 403);
  // Not a place of its own: it isn't on the dashboard or in the menu.
  grantApps(env, "ryan", "chat-bridges");
  assert.doesNotMatch((await ryan.get("/dashboard")).text, /#connections/);
  const on = (await api(ryan, "GET", "/state")).json.bridges;
  assert.equal(on.allowed, true);
  assert.equal(on.ready, true);
  assert.deepEqual(on.providers.map(p => p.id), ["matrix"]);
  assert.ok(on.providers[0].fields.some(f => f.name === "token" && f.secret));
});

test("without the CHAT_BRIDGE_KEY secret nothing can be connected", async () => {
  hs = new FakeMatrix().install();
  const env = makeEnv();
  const ryan = await person(env, "ryan", "chat-bridges");
  assert.equal((await api(ryan, "GET", "/state")).json.bridges.ready, false);
  const r = await connect(ryan);
  assert.equal(r.status, 503);
  assert.match(r.json.error, /CHAT_BRIDGE_KEY/);
});

test("connecting Matrix brings its rooms in, with history already read", async () => {
  const { env } = setup();
  const ryan = await person(env, "ryan", "chat-bridges");
  assert.equal((await connect(ryan, { homeserver: "matrix.test", token: "syt_bad" })).status, 400);
  assert.equal((await connect(ryan, { homeserver: "http://matrix.test", token: "syt_good" })).status, 400, "https only");
  assert.equal((await connect(ryan, { homeserver: "matrix.test" })).status, 400, "a token or a password");

  const made = await connect(ryan);
  assert.equal(made.status, 201);
  assert.deepEqual([made.json.network, made.json.label, made.json.status, made.json.rooms], ["Matrix", "@ryan:matrix.test", "ok", 1]);
  assert.equal((await connect(ryan)).status, 400, "the same account twice");

  // The token is sealed, never stored as it is.
  const row = sqlOne(env, "SELECT * FROM chat_connections");
  assert.doesNotMatch(row.secret, /syt_good/);
  assert.match(await unseal(KEY, `chat-connection:${row.user_id}:${row.id}`, row.secret), /syt_good/);
  assert.equal(await unseal(KEY, "chat-connection:someone-else", row.secret), null);
  assert.equal(await unseal("another-key-entirely-123", `chat-connection:${row.user_id}:${row.id}`, row.secret), null);

  const [room] = (await api(ryan, "GET", "/state")).json.rooms;
  assert.deepEqual([room.kind, room.name, room.provider, room.via, room.unread, room.joined, room.manage],
    ["bridge", "Family", "matrix", "@ryan:matrix.test", 0, true, false]);
  const msgs = (await api(ryan, "GET", `/rooms/${room.id}/messages`)).json;
  assert.deepEqual(msgs.messages.map(m => [m.author, m.author_name, m.body, m.external, m.mine]),
    [["@sam:matrix.test", "Sam", "old news", true, false]]);
  assert.equal(made.json.id.startsWith("k_"), true);
});

test("new messages, edits and deletions on Matrix show up, and count as unread", async () => {
  const { env } = setup();
  const ryan = await person(env, "ryan", "chat-bridges");
  const conn = (await connect(ryan)).json;
  const room = (await api(ryan, "GET", "/state")).json.rooms[0];
  const first = (await api(ryan, "GET", `/rooms/${room.id}/messages`)).json;

  const said = hs.say("!fam:matrix.test", "@sam:matrix.test", "> <@ryan:matrix.test> old\n\nare you coming?");
  hs.say("!fam:matrix.test", "@sam:matrix.test", "waves", { msgtype: "m.emote" });
  hs.say("!fam:matrix.test", "@ryan:matrix.test", "typed in Element");
  // The room list syncs on its own (a moment after the last sync).
  run(env, "UPDATE chat_connections SET tried_at = 0");
  const listed = (await api(ryan, "GET", "/state")).json.rooms[0];
  assert.equal(listed.unread, 2, "your own messages from Element aren't unread");

  hs.edit("!fam:matrix.test", "@sam:matrix.test", said, "are you coming tonight?");
  hs.edit("!fam:matrix.test", "@mallory:matrix.test", said, "not allowed: only the author edits");
  run(env, "UPDATE chat_connections SET tried_at = 0");
  let since = (await api(ryan, "GET", `/rooms/${room.id}/messages?since=${first.seq}`)).json;
  const byBody = Object.fromEntries(since.messages.map(m => [m.body, m]));
  assert.ok(byBody["are you coming tonight?"].edited_at, "the reply quote is dropped and the edit applied");
  assert.ok(byBody["* Sam waves"]);
  assert.equal(byBody["typed in Element"].mine, true);
  assert.equal(byBody["typed in Element"].author, "ryan");
  assert.equal((await api(ryan, "GET", "/state")).json.rooms[0].name, "Family", "later syncs keep the room's name");

  hs.redact("!fam:matrix.test", "@sam:matrix.test", said);
  await syncNow(ryan, conn.id);
  since = (await api(ryan, "GET", `/rooms/${room.id}/messages?since=${since.seq}`)).json;
  assert.deepEqual(since.messages.map(m => m.deleted), [true]);
  // Syncing again changes nothing.
  await syncNow(ryan, conn.id);
  assert.equal((await api(ryan, "GET", `/rooms/${room.id}/messages?since=${since.seq}`)).json.messages.length, 0);
});

test("sending, editing and deleting go to Matrix", async () => {
  const { env } = setup();
  const ryan = await person(env, "ryan", "chat-bridges");
  const conn = (await connect(ryan)).json;
  const room = (await api(ryan, "GET", "/state")).json.rooms[0];

  const sent = await api(ryan, "POST", `/rooms/${room.id}/messages`, { body: "hello from the site" });
  assert.equal(sent.status, 201);
  assert.deepEqual([sent.json.mine, sent.json.can_edit, sent.json.can_delete], [true, true, true]);
  assert.deepEqual(hs.bodies("!fam:matrix.test").slice(-1), ["hello from the site"]);
  // Its echo from the homeserver doesn't make a second copy.
  await syncNow(ryan, conn.id);
  assert.equal(sql(env, "SELECT * FROM chat_messages WHERE body = 'hello from the site'").length, 1);

  const edited = await api(ryan, "PATCH", `/rooms/${room.id}/messages/${sent.json.id}`, { body: "hello, edited" });
  assert.equal(edited.json.body, "hello, edited");
  const edit = hs.events.at(-1).event.content;
  assert.deepEqual([edit["m.relates_to"].rel_type, edit["m.new_content"].body], ["m.replace", "hello, edited"]);

  const theirs = (await api(ryan, "GET", `/rooms/${room.id}/messages`)).json.messages.find(m => m.external);
  assert.equal(theirs.can_delete, false, "the room's owner here can't delete other people's messages there");
  assert.equal((await api(ryan, "DELETE", `/rooms/${room.id}/messages/${theirs.id}`)).status, 403);
  assert.equal((await api(ryan, "POST", `/rooms/${room.id}/messages/${theirs.id}/reactions`, { emoji: "👍", on: true })).status, 403);

  assert.equal((await api(ryan, "DELETE", `/rooms/${room.id}/messages/${sent.json.id}`)).status, 200);
  assert.equal(hs.events.at(-1).event.type, "m.room.redaction");

  // Rooms from a connection are managed on Matrix, not here.
  assert.equal((await api(ryan, "PATCH", `/rooms/${room.id}`, { name: "x" })).status, 403);
  assert.equal((await api(ryan, "POST", `/rooms/${room.id}/leave`)).status, 403);
  assert.equal((await api(ryan, "DELETE", `/rooms/${room.id}`)).status, 403);
});

test("encrypted rooms come in as they are; a pasted token can't hold keys, so they stay read-only", async () => {
  const { env } = setup();
  hs.room("!secret:matrix.test", { encrypted: true, members: { "@ryan:matrix.test": "Ryan", "@kim:matrix.test": "Kim" } });
  hs.encrypted("!secret:matrix.test", "@kim:matrix.test");
  const ryan = await person(env, "ryan", "chat-bridges");
  const conn = (await connect(ryan)).json;
  assert.equal(conn.can_encrypt, false);
  const room = (await api(ryan, "GET", "/state")).json.rooms.find(r => r.encrypted);
  assert.equal(room.name, "Kim", "a room without a name is named for who's in it");
  assert.equal(room.ext_room, "!secret:matrix.test");
  assert.equal(room.can_encrypt, false);
  const [m] = (await api(ryan, "GET", `/rooms/${room.id}/messages`)).json.messages;
  assert.equal(m.encrypted, true);
  assert.match(m.body, /Encrypted message/);
  assert.equal(JSON.parse(m.raw).content.algorithm, "m.megolm.v1.aes-sha2", "kept as it came, for a browser to decrypt");
  const r = await api(ryan, "POST", `/rooms/${room.id}/messages`, { body: "hi" });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /encrypted/);
  const claim = await api(ryan, "POST", `/connections/${conn.id}/crypto/claim`, { key: "a".repeat(64) });
  assert.equal(claim.status, 403);
  assert.match(claim.json.error, /username and password/);
});

test("only the owner sees a connection's rooms, and they go with it", async () => {
  const { env } = setup();
  const ryan = await person(env, "ryan", "chat-bridges"), sam = await person(env, "sam", "chat-bridges");
  const conn = (await connect(ryan, { homeserver: "matrix.test", username: "ryan", password: "hunter22hunter22" })).json;
  assert.equal(conn.label, "@ryan:matrix.test");
  const room = (await api(ryan, "GET", "/state")).json.rooms[0];
  assert.equal((await api(sam, "GET", "/state")).json.rooms.length, 0);
  assert.equal((await api(sam, "GET", `/rooms/${room.id}/messages`)).status, 404);
  assert.equal((await api(sam, "DELETE", `/connections/${conn.id}`)).status, 404);
  assert.equal((await api(sam, "GET", "/connections")).json.length, 0);

  // Turning connections off hides the rooms but keeps them.
  run(env, "DELETE FROM user_areas WHERE area = 'chat-bridges' AND user_id = (SELECT id FROM users WHERE username = 'ryan')");
  assert.equal((await api(ryan, "GET", "/state")).json.rooms.length, 0);
  assert.equal((await api(ryan, "GET", `/rooms/${room.id}/messages`)).status, 404);
  grantApps(env, "ryan", "chat-bridges");

  // Removing it signs out the session this site made (not a token you pasted in) and drops its rooms.
  assert.equal((await api(ryan, "DELETE", `/connections/${conn.id}`)).status, 200);
  assert.deepEqual(hs.loggedOut, ["Bearer syt_fromlogin"]);
  assert.equal((await api(ryan, "GET", "/state")).json.rooms.length, 0);
  assert.equal(sql(env, "SELECT * FROM chat_messages").length, 0);
});

test("a token that stops working marks the connection, and syncing again can fix it", async () => {
  const { env } = setup();
  const ryan = await person(env, "ryan", "chat-bridges");
  const conn = (await connect(ryan)).json;
  const room = (await api(ryan, "GET", "/state")).json.rooms[0];
  hs.token = "syt_new";
  const after = (await syncNow(ryan, conn.id)).json;
  assert.equal(after.status, "error");
  assert.match(after.error, /no longer valid/);
  const r = await api(ryan, "POST", `/rooms/${room.id}/messages`, { body: "hi" });
  assert.equal(r.status, 502);
  assert.match(r.json.error, /connecting again/);
  hs.token = "syt_good";
  assert.equal((await syncNow(ryan, conn.id)).json.status, "ok");
});

test("leaving a room on Matrix removes it here", async () => {
  const { env } = setup();
  const ryan = await person(env, "ryan", "chat-bridges");
  const conn = (await connect(ryan)).json;
  hs.rooms.get("!fam:matrix.test").left = true;
  await syncNow(ryan, conn.id);
  assert.equal((await api(ryan, "GET", "/state")).json.rooms.length, 0);
});

test("deleting an account deletes its connections and their rooms", async () => {
  const { env } = setup();
  const ryan = await person(env, "ryan", "chat-bridges");
  await connect(ryan);
  const admin = await person(env, "boss");
  const bossId = sqlOne(env, "SELECT id FROM users WHERE username = 'boss'").id;
  run(env, "INSERT INTO user_areas (user_id, area) VALUES (?, 'admin')", bossId);
  run(env, "UPDATE users SET totp_secret = 'AAAAAAAAAAAAAAAA' WHERE id = ?", bossId);
  const id = sqlOne(env, "SELECT id FROM users WHERE username = 'ryan'").id;
  await admin.post("/admin/delete", { user_id: id, confirm: "ryan" });
  assert.equal(sqlOne(env, "SELECT id FROM users WHERE username = 'ryan'"), undefined);
  assert.deepEqual([sql(env, "SELECT * FROM chat_connections").length, sql(env, "SELECT * FROM chat_rooms").length,
    sql(env, "SELECT * FROM chat_messages").length], [0, 0, 0]);
});

test("redirects are followed, and an unreachable homeserver says which address failed", async () => {
  const { env } = setup();
  const ryan = await person(env, "ryan", "chat-bridges");
  const down = await connect(ryan, { homeserver: "down.test", token: "syt_good" });
  assert.equal(down.status, 400);
  assert.match(down.json.error, /couldn't reach down\.test \(connection refused\)/);
  // The proxy's redirect keeps the token, since it stays on the same host.
  assert.equal((await connect(ryan, { homeserver: "https://hs.matrix.test/old", token: "syt_good" })).status, 201);
  const again = await connect(ryan, { homeserver: "moved.test", token: "syt_good" });
  assert.match(again.json.error, /already connected/, "a server name that redirects to its .well-known is followed");
});

test("homeserver addresses are public https hosts", () => {
  assert.equal(serverUrl("matrix.org"), "https://matrix.org");
  assert.equal(serverUrl("https://Matrix.Example.com/"), "https://matrix.example.com");
  for (const bad of ["http://matrix.org", "https://127.0.0.1", "https://localhost", "https://box.local", "https://[::1]", "https://a.b:22", "", "https://u:p@matrix.org"]) {
    assert.throws(() => serverUrl(bad), undefined, bad);
  }
});

test("sealed values open only with their key and context", async () => {
  const s = await seal(KEY, "ctx", "secret text");
  assert.equal(await unseal(KEY, "ctx", s), "secret text");
  assert.equal(await unseal(KEY, "other", s), null);
  assert.equal(await unseal(KEY, "ctx", s.slice(0, -2) + "AA"), null);
  assert.notEqual(await seal(KEY, "ctx", "secret text"), s, "a fresh nonce every time");
});
