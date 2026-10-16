// Chat: rooms anyone with a Drift account can see, join and talk in.
//
// Rooms are open: everyone can browse the list and read a room, and joining
// one lets you post and puts it in your list with an unread count. Whoever
// made a room can rename or delete it; admins can too. People delete their own
// messages; a room's owner and admins can delete anyone's.
//
// The page polls for new messages. Every change in a room (a new message or a
// deleted one) takes the room's next `seq`, so "what changed since seq N" is
// one indexed query and catches deletions as well as new messages.

import { withRail } from "./pages.js";
import { db, now } from "./db.js";
import { sameOrigin } from "./account.js";
import { randomBytes, hex } from "./crypto.js";

export class BadRequest extends Error {}
const fail = msg => { throw new BadRequest(msg); };

const LIMITS = { name: 60, topic: 200, body: 2000, request: 16 * 1024, page: 50, rooms: 20 };
// At most this many messages from one person in RATE_WINDOW seconds.
const RATE = 10, RATE_WINDOW = 10;
const ROOM_ID = /^r_[0-9a-f]{16}$/;

export async function readJson(request) {
  const text = await request.text();
  if (text.length > LIMITS.request) fail("request too large");
  if (!text) return {};
  try { return JSON.parse(text); } catch { fail("invalid JSON"); }
}

const isObj = v => v && typeof v === "object" && !Array.isArray(v);

function str(field, v, max, { required = false } = {}) {
  if (v != null && typeof v !== "string") fail(`${field} must be text`);
  // Collapse control characters other than newlines; trim the ends.
  const s = String(v ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim();
  if (required && !s) fail(`${field} is required`);
  if (s.length > max) fail(`${field} is longer than ${max} characters`);
  return s;
}

function roomFields(body, base = { name: "", topic: "" }) {
  if (!isObj(body)) fail("body must be a JSON object");
  for (const k of Object.keys(body)) if (!["name", "topic"].includes(k)) fail(`unknown field ${JSON.stringify(k)}`);
  return {
    // Room names are one line.
    name: "name" in body ? str("name", body.name, LIMITS.name, { required: true }).replace(/\s+/g, " ") : base.name,
    topic: "topic" in body ? str("topic", body.topic, LIMITS.topic).replace(/\s+/g, " ") : base.topic,
  };
}

// ── reading ────────────────────────────────────────────────────────────────

async function getRoom(d, id) {
  return ROOM_ID.test(id) ? d.prepare("SELECT * FROM chat_rooms WHERE id = ?").bind(id).first() : null;
}
const membership = (d, room, userId) =>
  d.prepare("SELECT read_seq FROM chat_members WHERE room = ? AND user_id = ?").bind(room, userId).first();

const canManage = (room, user) => room.owner === user.id || user.areas.has("admin");

// Every room, newest activity first, with what this person needs to list it.
export async function listRooms(env, user) {
  const d = await db(env);
  const { results } = await d.prepare(`
    SELECT r.id, r.name, r.topic, r.owner, r.seq, r.created_at, r.last_at,
           (SELECT display_name FROM users WHERE users.id = r.owner) AS owner_name,
           (SELECT COUNT(*) FROM chat_members m WHERE m.room = r.id) AS members,
           me.read_seq,
           (SELECT COUNT(*) FROM chat_messages x WHERE me.read_seq IS NOT NULL AND x.room = r.id
              AND x.seq > me.read_seq AND x.deleted = 0 AND x.user_id != ?) AS unread
    FROM chat_rooms r LEFT JOIN chat_members me ON me.room = r.id AND me.user_id = ?
    ORDER BY r.last_at DESC, r.id`).bind(user.id, user.id).all();
  return results.map(r => roomOut(r, user, r.read_seq != null));
}

function roomOut(r, user, joined) {
  return {
    id: r.id, name: r.name, topic: r.topic, owner_name: r.owner_name ?? null, members: r.members ?? 0,
    created_at: r.created_at, last_at: r.last_at, seq: r.seq,
    joined, unread: joined ? r.unread ?? 0 : 0, manage: canManage(r, user),
  };
}

const MESSAGE = `SELECT m.id, m.body, m.deleted, m.seq, m.created_at, m.user_id, u.username, u.display_name
  FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id`;

function messageOut(m, user, room) {
  const mine = m.user_id === user.id;
  return {
    id: m.id, seq: m.seq, created_at: m.created_at, deleted: !!m.deleted, body: m.deleted ? "" : m.body,
    author: m.username ?? null, author_name: m.display_name ?? "Deleted account",
    mine, can_delete: !m.deleted && (mine || canManage(room, user)),
  };
}

// One room's messages, oldest first:
//   {}             → the newest page
//   {before: id}   → the page before that message (scrolling back through history)
//   {since: seq}   → everything that changed after seq, deleted messages included
// Reading as a member also marks the room read.
export async function messages(env, user, roomId, { since, before } = {}) {
  const d = await db(env);
  const room = await getRoom(d, roomId);
  if (!room) return null;
  let rows, more = false;
  if (since != null) {
    ({ results: rows } = await d.prepare(`${MESSAGE} WHERE m.room = ? AND m.seq > ? ORDER BY m.id LIMIT 500`).bind(room.id, since).all());
  } else {
    const q = before != null
      ? d.prepare(`${MESSAGE} WHERE m.room = ? AND m.id < ? AND m.deleted = 0 ORDER BY m.id DESC LIMIT ?`).bind(room.id, before, LIMITS.page + 1)
      : d.prepare(`${MESSAGE} WHERE m.room = ? AND m.deleted = 0 ORDER BY m.id DESC LIMIT ?`).bind(room.id, LIMITS.page + 1);
    ({ results: rows } = await q.all());
    more = rows.length > LIMITS.page;
    rows = rows.slice(0, LIMITS.page).reverse();
  }
  const member = await membership(d, room.id, user.id);
  if (member && member.read_seq < room.seq) {
    await d.prepare("UPDATE chat_members SET read_seq = ? WHERE room = ? AND user_id = ? AND read_seq < ?")
      .bind(room.seq, room.id, user.id, room.seq).run();
  }
  return { seq: room.seq, more, joined: !!member, messages: rows.map(m => messageOut(m, user, room)) };
}

export async function members(env, roomId) {
  const d = await db(env);
  const room = await getRoom(d, roomId);
  if (!room) return null;
  const { results } = await d.prepare(`
    SELECT u.username, u.display_name, m.joined_at, m.user_id = ? AS owner FROM chat_members m JOIN users u ON u.id = m.user_id
    WHERE m.room = ? ORDER BY u.display_name COLLATE NOCASE`).bind(room.owner, room.id).all();
  return results.map(r => ({ username: r.username, name: r.display_name, joined_at: r.joined_at, owner: !!r.owner }));
}

// ── changing ───────────────────────────────────────────────────────────────

export async function createRoom(env, user, body) {
  const { name, topic } = roomFields(body);
  const d = await db(env);
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM chat_rooms WHERE owner = ?").bind(user.id).first();
  if (n >= LIMITS.rooms) fail(`you can make at most ${LIMITS.rooms} rooms`);
  if (await d.prepare("SELECT 1 AS x FROM chat_rooms WHERE name = ? COLLATE NOCASE").bind(name).first()) fail("there's already a room with that name");
  const id = "r_" + hex(randomBytes(8)), t = now();
  await d.batch([
    d.prepare("INSERT INTO chat_rooms (id, name, topic, owner, created_at, last_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, name, topic, user.id, t, t),
    d.prepare("INSERT INTO chat_members (room, user_id, joined_at) VALUES (?, ?, ?)").bind(id, user.id, t),
  ]);
  return roomOut({ id, name, topic, owner: user.id, owner_name: user.display_name, members: 1, seq: 0, created_at: t, last_at: t, unread: 0 }, user, true);
}

export async function updateRoom(env, user, roomId, body) {
  const d = await db(env);
  const room = await getRoom(d, roomId);
  if (!room) return null;
  if (!canManage(room, user)) return { forbidden: "only the room's owner can change it" };
  const { name, topic } = roomFields(body, room);
  if (name.toLowerCase() !== room.name.toLowerCase() &&
      await d.prepare("SELECT 1 AS x FROM chat_rooms WHERE name = ? COLLATE NOCASE AND id != ?").bind(name, room.id).first()) {
    fail("there's already a room with that name");
  }
  await d.prepare("UPDATE chat_rooms SET name = ?, topic = ? WHERE id = ?").bind(name, topic, room.id).run();
  return { id: room.id, name, topic };
}

export async function deleteRoom(env, user, roomId) {
  const d = await db(env);
  const room = await getRoom(d, roomId);
  if (!room) return null;
  if (!canManage(room, user)) return { forbidden: "only the room's owner can delete it" };
  await d.batch([
    d.prepare("DELETE FROM chat_messages WHERE room = ?").bind(room.id),
    d.prepare("DELETE FROM chat_members WHERE room = ?").bind(room.id),
    d.prepare("DELETE FROM chat_rooms WHERE id = ?").bind(room.id),
  ]);
  return { deleted: true };
}

export async function join(env, user, roomId) {
  const d = await db(env);
  const room = await getRoom(d, roomId);
  if (!room) return null;
  // Joining counts everything already there as read.
  await d.prepare("INSERT OR IGNORE INTO chat_members (room, user_id, joined_at, read_seq) VALUES (?, ?, ?, ?)")
    .bind(room.id, user.id, now(), room.seq).run();
  return { joined: true };
}

export async function leave(env, user, roomId) {
  const d = await db(env);
  const room = await getRoom(d, roomId);
  if (!room) return null;
  await d.prepare("DELETE FROM chat_members WHERE room = ? AND user_id = ?").bind(room.id, user.id).run();
  return { joined: false };
}

export async function post(env, user, roomId, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  for (const k of Object.keys(body)) if (k !== "body") fail(`unknown field ${JSON.stringify(k)}`);
  const text = str("message", body.body, LIMITS.body, { required: true });
  const d = await db(env);
  const room = await getRoom(d, roomId);
  if (!room) return null;
  if (!(await membership(d, room.id, user.id))) return { forbidden: "join the room to post in it" };
  const t = now();
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ? AND created_at > ?").bind(user.id, t - RATE_WINDOW).first();
  if (n >= RATE) return { slow: "you're sending messages too quickly; wait a few seconds" };
  // One transaction: take the room's next seq and give it to the new message.
  await d.batch([
    d.prepare("UPDATE chat_rooms SET seq = seq + 1, last_at = ? WHERE id = ?").bind(t, room.id),
    d.prepare("INSERT INTO chat_messages (room, user_id, body, seq, created_at) SELECT id, ?, ?, seq, ? FROM chat_rooms WHERE id = ?")
      .bind(user.id, text, t, room.id),
    d.prepare("UPDATE chat_members SET read_seq = (SELECT seq FROM chat_rooms WHERE id = ?) WHERE room = ? AND user_id = ?")
      .bind(room.id, room.id, user.id),
  ]);
  const m = await d.prepare(`${MESSAGE} WHERE m.room = ? AND m.user_id = ? ORDER BY m.id DESC LIMIT 1`).bind(room.id, user.id).first();
  return messageOut(m, user, room);
}

export async function deleteMessage(env, user, roomId, messageId) {
  const d = await db(env);
  const room = await getRoom(d, roomId);
  if (!room) return null;
  const m = await d.prepare("SELECT user_id, deleted FROM chat_messages WHERE id = ? AND room = ?").bind(messageId, room.id).first();
  if (!m || m.deleted) return null;
  if (m.user_id !== user.id && !canManage(room, user)) return { forbidden: "you can only delete your own messages" };
  await d.batch([
    d.prepare("UPDATE chat_rooms SET seq = seq + 1 WHERE id = ?").bind(room.id),
    d.prepare("UPDATE chat_messages SET deleted = 1, body = '', seq = (SELECT seq FROM chat_rooms WHERE id = ?) WHERE id = ?").bind(room.id, messageId),
  ]);
  return { deleted: true };
}

// ── routes ─────────────────────────────────────────────────────────────────
//
//   GET    /chat/api/state                          you, and every room
//   POST   /chat/api/rooms                          {name, topic} → a new room; you join it
//   PATCH  /chat/api/rooms/<id>                     {name, topic}   (owner or admin)
//   DELETE /chat/api/rooms/<id>                     the room and its messages   (owner or admin)
//   POST   /chat/api/rooms/<id>/join | leave
//   GET    /chat/api/rooms/<id>/members
//   GET    /chat/api/rooms/<id>/messages[?since=<seq> | ?before=<message id>]
//   POST   /chat/api/rooms/<id>/messages            {body}   (members)
//   DELETE /chat/api/rooms/<id>/messages/<message id>

const ROUTE = /^\/chat\/api\/(state|rooms)(?:\/([^/]+)(?:\/(join|leave|members|messages)(?:\/([^/]+))?)?)?\/?$/;

// Messages are shown as text, never as HTML, and the page loads nothing from
// elsewhere except fonts.
const PAGE_CSP = [
  "default-src 'none'", "script-src 'self'", "connect-src 'self'", "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data:", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

const int = v => /^\d{1,15}$/.test(v ?? "") ? Number(v) : undefined;

export async function chat(request, env, user, pathname) {
  if (!pathname.startsWith("/chat/api/")) {
    const asset = await withRail(await env.ASSETS.fetch(request), user, "chat");
    const res = new Response(asset.body, asset);
    if ((res.headers.get("Content-Type") || "").startsWith("text/html")) {
      res.headers.set("Content-Security-Policy", PAGE_CSP);
      res.headers.set("X-Content-Type-Options", "nosniff");
    }
    return res;
  }
  const method = request.method;
  try {
    if (method !== "GET" && !sameOrigin(request)) return json({ error: "cross-origin request refused" }, 403);
    const m = pathname.match(ROUTE);
    if (!m) return json({ error: "not found" }, 404);
    const [, kind, id, sub, extra] = m;
    const notFound = () => json({ error: "not found" }, 404);
    const notAllowed = () => json({ error: "method not allowed" }, 405);
    // Turns a result from the functions above into a response.
    const reply = (out, status = 200) =>
      !out ? notFound()
      : out.forbidden ? json({ error: out.forbidden }, 403)
      : out.slow ? json({ error: out.slow }, 429)
      : json(out, status);

    if (kind === "state") {
      if (id) return notFound();
      if (method !== "GET") return notAllowed();
      return json({
        user: { username: user.username, name: user.display_name, admin: user.areas.has("admin") },
        rooms: await listRooms(env, user),
      });
    }

    if (!id) return method === "POST" ? reply(await createRoom(env, user, await readJson(request)), 201) : notAllowed();
    if (!ROOM_ID.test(id)) return notFound();

    if (!sub) {
      if (method === "PATCH") return reply(await updateRoom(env, user, id, await readJson(request)));
      if (method === "DELETE") return reply(await deleteRoom(env, user, id));
      return notAllowed();
    }
    if (sub === "join" || sub === "leave") {
      if (extra) return notFound();
      if (method !== "POST") return notAllowed();
      return reply(await (sub === "join" ? join : leave)(env, user, id));
    }
    if (sub === "members") {
      if (extra) return notFound();
      return method === "GET" ? reply(await members(env, id)) : notAllowed();
    }
    // messages
    if (extra) {
      const mid = int(extra);
      if (mid === undefined) return notFound();
      return method === "DELETE" ? reply(await deleteMessage(env, user, id, mid)) : notAllowed();
    }
    if (method === "GET") {
      const q = new URL(request.url).searchParams;
      return reply(await messages(env, user, id, { since: int(q.get("since")), before: int(q.get("before")) }));
    }
    if (method === "POST") return reply(await post(env, user, id, await readJson(request)), 201);
    return notAllowed();
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    console.error("chat error:", e);
    return json({ error: "server error" }, 500);
  }
}
