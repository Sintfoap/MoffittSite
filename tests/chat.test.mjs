// Tests for chat: rooms, joining, messages and who can delete what.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, run, sqlOne } from "./helpers.mjs";

async function signedIn(env, name) {
  const b = new Browser(env);
  assert.equal((await b.signup(name)).status, 303);
  return b;
}
async function admin(env, name = "ryan") {
  const b = await signedIn(env, name);
  const { id } = sqlOne(env, "SELECT id FROM users WHERE username = ?", name);
  run(env, "INSERT INTO user_areas (user_id, area) VALUES (?, 'admin')", id);
  run(env, "UPDATE users SET totp_secret = 'AAAAAAAAAAAAAAAA' WHERE id = ?", id);
  return b;
}
const api = (b, method, path, json) => b.req(method, "/chat/api" + path, json === undefined ? {} : { json });
const say = (b, room, body) => api(b, "POST", `/rooms/${room}/messages`, { body });

test("the chat page needs a signed-in account and is on the dashboard", async () => {
  const env = makeEnv();
  const anon = new Browser(env);
  assert.match((await anon.get("/chat/")).location, /^\/login\?next=%2Fchat%2F/);
  assert.equal((await anon.get("/chat/api/state")).status, 401);
  assert.equal((await anon.get("/chat")).status, 308);

  const b = await signedIn(env, "josh");
  const page = await b.get("/chat/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("Cache-Control"), /no-store/);
  assert.match(page.headers.get("Content-Security-Policy"), /script-src 'self'(;|$)/);
  assert.match((await b.get("/dashboard")).text, /href="\/chat\/"/);

  // Without the area there's no card and no access.
  const { id } = sqlOne(env, "SELECT id FROM users WHERE username = 'josh'");
  run(env, "DELETE FROM user_areas WHERE user_id = ?", id);
  assert.doesNotMatch((await b.get("/dashboard")).text, /href="\/chat\/"/);
  assert.equal((await api(b, "GET", "/state")).status, 403);
});

test("people make rooms, join them and talk", async () => {
  const env = makeEnv();
  const josh = await signedIn(env, "josh"), sam = await signedIn(env, "sam");

  const made = await api(josh, "POST", "/rooms", { name: "  General ", topic: "Anything goes" });
  assert.equal(made.status, 201);
  const room = made.json.id;
  assert.equal(made.json.name, "General");
  assert.equal(made.json.joined, true);
  assert.equal((await api(sam, "POST", "/rooms", { name: "general" })).status, 400, "names are unique, ignoring case");
  assert.equal((await api(sam, "POST", "/rooms", { name: "" })).status, 400);

  // Sam sees it but hasn't joined, so can read and not post.
  let [listed] = (await api(sam, "GET", "/state")).json.rooms;
  assert.deepEqual([listed.name, listed.joined, listed.members, listed.manage], ["General", false, 1, false]);
  assert.equal((await say(josh, room, "hello")).status, 201);
  assert.equal((await say(sam, room, "hi")).status, 403);
  assert.deepEqual((await api(sam, "GET", `/rooms/${room}/messages`)).json.messages.map(m => m.body), ["hello"]);

  assert.equal((await api(sam, "POST", `/rooms/${room}/join`)).status, 200);
  const sent = await say(sam, room, "hi josh\nhow are you?");
  assert.equal(sent.status, 201);
  assert.deepEqual([sent.json.body, sent.json.author, sent.json.mine], ["hi josh\nhow are you?", "sam", true]);

  // Josh has one unread, which reading clears.
  [listed] = (await api(josh, "GET", "/state")).json.rooms;
  assert.equal(listed.unread, 1);
  const page = (await api(josh, "GET", `/rooms/${room}/messages`)).json;
  assert.deepEqual(page.messages.map(m => [m.author_name, m.body, m.mine]), [["josh", "hello", true], ["sam", "hi josh\nhow are you?", false]]);
  assert.equal(page.more, false);
  assert.equal((await api(josh, "GET", "/state")).json.rooms[0].unread, 0);

  // Polling: only what changed since a seq.
  await say(josh, room, "good thanks");
  const since = (await api(sam, "GET", `/rooms/${room}/messages?since=${page.seq}`)).json;
  assert.deepEqual(since.messages.map(m => m.body), ["good thanks"]);
  assert.equal(since.seq, page.seq + 1);

  const members = (await api(sam, "GET", `/rooms/${room}/members`)).json;
  assert.deepEqual(members.map(m => [m.username, m.owner]), [["josh", true], ["sam", false]]);

  assert.equal((await api(sam, "POST", `/rooms/${room}/leave`)).status, 200);
  assert.equal((await say(sam, room, "bye")).status, 403);
  assert.equal((await api(sam, "GET", "/state")).json.rooms[0].joined, false);
});

test("deleting messages shows up in polling, and only the right people can", async () => {
  const env = makeEnv();
  const boss = await admin(env);
  const josh = await signedIn(env, "josh"), sam = await signedIn(env, "sam"), kim = await signedIn(env, "kim");
  const room = (await api(josh, "POST", "/rooms", { name: "Lobby" })).json.id;
  await api(sam, "POST", `/rooms/${room}/join`);
  await api(kim, "POST", `/rooms/${room}/join`);
  const a = (await say(sam, room, "from sam")).json, b = (await say(kim, room, "from kim")).json;
  const { seq } = (await api(sam, "GET", `/rooms/${room}/messages`)).json;

  // Kim can't delete Sam's message; Sam can; the room's owner can delete Kim's.
  assert.equal((await api(kim, "DELETE", `/rooms/${room}/messages/${a.id}`)).status, 403);
  assert.equal((await api(sam, "DELETE", `/rooms/${room}/messages/${a.id}`)).status, 200);
  assert.equal((await api(sam, "DELETE", `/rooms/${room}/messages/${a.id}`)).status, 404, "already gone");
  const changed = (await api(kim, "GET", `/rooms/${room}/messages?since=${seq}`)).json.messages;
  assert.deepEqual(changed.map(m => [m.id, m.deleted, m.body]), [[a.id, true, ""]]);
  assert.equal((await api(josh, "DELETE", `/rooms/${room}/messages/${b.id}`)).status, 200);
  assert.deepEqual((await api(kim, "GET", `/rooms/${room}/messages`)).json.messages, []);

  // Only the owner or an admin changes or deletes the room.
  assert.equal((await api(sam, "PATCH", `/rooms/${room}`, { name: "Mine now" })).status, 403);
  assert.equal((await api(josh, "PATCH", `/rooms/${room}`, { topic: "Say hi" })).json.topic, "Say hi");
  assert.equal((await api(sam, "DELETE", `/rooms/${room}`)).status, 403);
  assert.equal((await api(boss, "DELETE", `/rooms/${room}`)).status, 200);
  assert.deepEqual((await api(josh, "GET", "/state")).json.rooms, []);
  assert.equal((await api(josh, "GET", `/rooms/${room}/messages`)).status, 404);
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM chat_messages").n, 0);
});

test("history comes back a page at a time", async () => {
  const env = makeEnv();
  const josh = await signedIn(env, "josh");
  const room = (await api(josh, "POST", "/rooms", { name: "Log" })).json.id;
  const { id: uid } = sqlOne(env, "SELECT id FROM users WHERE username = 'josh'");
  // Written straight to the database to get past the rate limit.
  for (let i = 1; i <= 60; i++) {
    run(env, "UPDATE chat_rooms SET seq = seq + 1 WHERE id = ?", room);
    run(env, "INSERT INTO chat_messages (room, user_id, body, seq, created_at) SELECT id, ?, ?, seq, ? FROM chat_rooms WHERE id = ?", uid, `m${i}`, 1000 + i, room);
  }
  const first = (await api(josh, "GET", `/rooms/${room}/messages`)).json;
  assert.equal(first.messages.length, 50);
  assert.equal(first.messages[0].body, "m11");
  assert.equal(first.messages.at(-1).body, "m60");
  assert.equal(first.more, true);
  const older = (await api(josh, "GET", `/rooms/${room}/messages?before=${first.messages[0].id}`)).json;
  assert.deepEqual(older.messages.map(m => m.body), Array.from({ length: 10 }, (_, i) => `m${i + 1}`));
  assert.equal(older.more, false);
});

test("messages are checked and rate limited", async () => {
  const env = makeEnv();
  const josh = await signedIn(env, "josh");
  const room = (await api(josh, "POST", "/rooms", { name: "Busy" })).json.id;
  assert.equal((await say(josh, room, "   ")).status, 400);
  assert.equal((await say(josh, room, "x".repeat(2001))).status, 400);
  assert.equal((await api(josh, "POST", `/rooms/${room}/messages`, { body: "hi", extra: 1 })).status, 400);
  assert.equal((await say(josh, room, "a\u0000b")).json.body, "a b");
  for (let i = 1; i < 10; i++) assert.equal((await say(josh, room, `m${i}`)).status, 201);
  assert.equal((await say(josh, room, "one too many")).status, 429);

  // Other sites can't post for you.
  const forged = await josh.req("POST", `/chat/api/rooms/${room}/messages`, { json: { body: "hi" }, origin: "https://evil.test" });
  assert.equal(forged.status, 403);
  assert.equal((await api(josh, "GET", "/rooms/r_nothere/messages")).status, 404);
  assert.equal((await api(josh, "GET", "/rooms/r_0000000000000000/messages")).status, 404);
});

test("deleting an account removes its messages but keeps its rooms", async () => {
  const env = makeEnv();
  const boss = await admin(env);
  const josh = await signedIn(env, "josh");
  const room = (await api(josh, "POST", "/rooms", { name: "Keep" })).json.id;
  await say(josh, room, "bye");
  const { id } = sqlOne(env, "SELECT id FROM users WHERE username = 'josh'");
  const r = await boss.post("/admin/delete", { user_id: id, confirm: "josh" });
  assert.equal(r.status, 200);
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM users WHERE id = ?", id).n, 0);
  const rooms = (await api(boss, "GET", "/state")).json.rooms;
  assert.deepEqual(rooms.map(r => [r.name, r.members, r.manage]), [["Keep", 0, true]]);
  assert.deepEqual((await api(boss, "GET", `/rooms/${room}/messages`)).json.messages, []);
});

test("people edit their own messages, and polling sees the edit", async () => {
  const env = makeEnv();
  const josh = await signedIn(env, "josh"), sam = await signedIn(env, "sam");
  const room = (await api(josh, "POST", "/rooms", { name: "Edits" })).json.id;
  await api(sam, "POST", `/rooms/${room}/join`);
  const m = (await say(josh, room, "helo")).json;
  assert.deepEqual([m.can_edit, m.edited_at], [true, null]);
  const { seq } = (await api(sam, "GET", `/rooms/${room}/messages`)).json;
  assert.equal((await say(sam, room, "hi")).status, 201);

  assert.equal((await api(sam, "PATCH", `/rooms/${room}/messages/${m.id}`, { body: "mine now" })).status, 403);
  assert.equal((await api(josh, "PATCH", `/rooms/${room}/messages/${m.id}`, { body: "  " })).status, 400);
  const edited = await api(josh, "PATCH", `/rooms/${room}/messages/${m.id}`, { body: "hello" });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.body, "hello");
  assert.ok(edited.json.edited_at);

  const changed = (await api(sam, "GET", `/rooms/${room}/messages?since=${seq}`)).json.messages;
  assert.deepEqual(changed.map(x => [x.id, x.body, !!x.edited_at, x.can_edit]), [[m.id, "hello", true, false], [m.id + 1, "hi", false, true]].sort((a, b) => a[0] - b[0]));
  // An edit isn't a new message, so it doesn't count as unread.
  assert.equal((await api(sam, "GET", "/state")).json.rooms[0].unread, 0);

  await api(josh, "DELETE", `/rooms/${room}/messages/${m.id}`);
  assert.equal((await api(josh, "PATCH", `/rooms/${room}/messages/${m.id}`, { body: "back" })).status, 404);
});

test("@mentions are flagged for the person mentioned and counted until read", async () => {
  const env = makeEnv();
  const josh = await signedIn(env, "josh"), sam = await signedIn(env, "sam");
  const room = (await api(josh, "POST", "/rooms", { name: "Pings" })).json.id;
  await api(sam, "POST", `/rooms/${room}/join`);

  await say(josh, room, "hey @Sam, and @josh and @nobody");
  await say(josh, room, "mail sam@sam.test is not a mention");
  await say(josh, room, "@sam again");
  const state = (await api(sam, "GET", "/state")).json;
  assert.deepEqual([state.rooms[0].unread, state.rooms[0].mentions], [3, 2]);
  assert.ok(state.reactions.includes("👍"));
  assert.equal((await api(josh, "GET", "/state")).json.rooms[0].mentions, 0, "mentioning yourself doesn't count");

  const msgs = (await api(sam, "GET", `/rooms/${room}/messages`)).json.messages;
  assert.deepEqual(msgs.map(x => x.mentions_me), [true, false, true]);
  assert.deepEqual((await api(josh, "GET", `/rooms/${room}/messages`)).json.messages.map(x => x.mentions_me), [false, false, false]);
  assert.equal((await api(sam, "GET", "/state")).json.rooms[0].mentions, 0, "reading clears it");

  // Editing the mention away (or in) changes who's mentioned.
  const m = (await say(josh, room, "no one")).json;
  await api(josh, "PATCH", `/rooms/${room}/messages/${m.id}`, { body: "now @sam" });
  assert.equal((await api(sam, "GET", "/state")).json.rooms[0].mentions, 1);
  await api(josh, "PATCH", `/rooms/${room}/messages/${m.id}`, { body: "never mind" });
  assert.equal((await api(sam, "GET", "/state")).json.rooms[0].mentions, 0);
});

test("members react to messages from a short list", async () => {
  const env = makeEnv();
  const josh = await signedIn(env, "josh"), sam = await signedIn(env, "sam"), kim = await signedIn(env, "kim");
  const room = (await api(josh, "POST", "/rooms", { name: "Reacts" })).json.id;
  await api(sam, "POST", `/rooms/${room}/join`);
  const m = (await say(josh, room, "pizza tonight?")).json;
  const react = (b, emoji, on = true) => api(b, "POST", `/rooms/${room}/messages/${m.id}/reactions`, { emoji, on });
  const { seq } = (await api(josh, "GET", `/rooms/${room}/messages`)).json;

  assert.equal((await react(kim, "👍")).status, 403, "join first");
  assert.equal((await react(sam, "🍕")).status, 400);
  assert.equal((await api(sam, "POST", `/rooms/${room}/messages/${m.id}/reactions`, { emoji: "👍" })).status, 400);
  assert.equal((await react(sam, "👍")).status, 200);
  await react(sam, "👍");   // twice is still once
  await react(sam, "🎉");
  const r = (await react(josh, "👍")).json.reactions;
  assert.deepEqual(r.map(x => [x.emoji, x.count, x.mine, x.names]), [["👍", 2, true, "sam, josh"], ["🎉", 1, false, "sam"]]);

  const polled = (await api(josh, "GET", `/rooms/${room}/messages?since=${seq}`)).json.messages;
  assert.deepEqual(polled.map(x => x.reactions.length), [2]);
  assert.equal((await api(josh, "GET", "/state")).json.rooms[0].unread, 0, "reactions aren't unread messages");

  assert.deepEqual((await react(sam, "🎉", false)).json.reactions.map(x => x.emoji), ["👍"]);
  assert.equal((await api(sam, "POST", `/rooms/${room}/messages/${m.id}/reactions`, undefined)).status, 400);
  assert.equal((await api(sam, "GET", `/rooms/${room}/members/1/reactions`)).status, 404);

  await api(josh, "DELETE", `/rooms/${room}/messages/${m.id}`);
  assert.equal((await react(sam, "👍")).status, 404);
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM chat_reactions").n, 0);
});
