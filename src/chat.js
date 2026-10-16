// Chat: rooms anyone with a Drift account can see, join and talk in.
//
// Rooms are open: everyone can browse the list and read a room, and joining
// one lets you post and puts it in your list with an unread count. Whoever
// made a room can rename or delete it; admins can too. People edit and delete
// their own messages; a room's owner and admins can delete anyone's. Members
// react to messages from a short list of emoji, and "@username" in a message
// mentions that person, which their room list counts until they read it.
//
// The page polls for new messages. Every change in a room (a new, edited or
// deleted message, or a reaction) takes the room's next `seq`, so "what
// changed since seq N" is one indexed query and catches all of them.

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
export const REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "😢", "👀", "🙏"];
// "@name" where name is a username (see auth.js), not part of an email address.
const MENTION = /(^|[^\w@.])@([a-z0-9][a-z0-9_-]{2,31})(?![\w-])/gi;
const MAX_MENTIONS = 10;

export function mentioned(text) {
  const names = new Set();
  for (const m of text.matchAll(MENTION)) names.add(m[2].toLowerCase());
  return [...names].slice(0, MAX_MENTIONS);
}

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
              AND COALESCE(x.posted_seq, x.seq) > me.read_seq AND x.deleted = 0 AND x.user_id != ?) AS unread,
           (SELECT COUNT(*) FROM chat_mentions mm JOIN chat_messages x ON x.id = mm.message
              WHERE me.read_seq IS NOT NULL AND mm.user_id = ? AND x.room = r.id
              AND COALESCE(x.posted_seq, x.seq) > me.read_seq AND x.deleted = 0) AS mentions
    FROM chat_rooms r LEFT JOIN chat_members me ON me.room = r.id AND me.user_id = ?
    ORDER BY r.last_at DESC, r.id`).bind(user.id, user.id, user.id).all();
  return results.map(r => roomOut(r, user, r.read_seq != null));
}

function roomOut(r, user, joined) {
  return {
    id: r.id, name: r.name, topic: r.topic, owner_name: r.owner_name ?? null, members: r.members ?? 0,
    created_at: r.created_at, last_at: r.last_at, seq: r.seq,
    joined, unread: joined ? r.unread ?? 0 : 0, mentions: joined ? r.mentions ?? 0 : 0, manage: canManage(r, user),
  };
}

const MESSAGE = `SELECT m.id, m.body, m.deleted, m.seq, m.created_at, m.edited_at, m.user_id, u.username, u.display_name
  FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id`;

function messageOut(m, user, room, reactions = []) {
  const mine = m.user_id === user.id;
  return {
    id: m.id, seq: m.seq, created_at: m.created_at, edited_at: m.deleted ? null : m.edited_at ?? null,
    deleted: !!m.deleted, body: m.deleted ? "" : m.body,
    author: m.username ?? null, author_name: m.display_name ?? "Deleted account",
    mine, can_edit: !m.deleted && mine, can_delete: !m.deleted && (mine || canManage(room, user)),
    mentions_me: !m.deleted && !mine && mentioned(m.body).includes(user.username),
    reactions: m.deleted ? [] : reactions,
  };
}

// Reactions on messages lo..hi of a room: {message id: [{emoji, count, mine, names}]}.
async function reactionsFor(d, user, room, lo, hi) {
  const out = {};
  if (lo == null) return out;
  const { results } = await d.prepare(`
    SELECT message, emoji, COUNT(*) AS n, MAX(user_id = ?) AS mine, GROUP_CONCAT(name, ', ') AS names
    FROM (SELECT r.rowid AS k, r.message, r.emoji, r.user_id, COALESCE(u.display_name, 'Deleted account') AS name
          FROM chat_reactions r JOIN chat_messages m ON m.id = r.message LEFT JOIN users u ON u.id = r.user_id
          WHERE m.room = ? AND r.message BETWEEN ? AND ? ORDER BY r.rowid)
    GROUP BY message, emoji ORDER BY message, MIN(k)`).bind(user.id, room.id, lo, hi).all();
  for (const r of results) (out[r.message] ??= []).push({ emoji: r.emoji, count: r.n, mine: !!r.mine, names: r.names });
  return out;
}

async function withReactions(d, user, room, rows) {
  const ids = rows.map(m => m.id);
  const reactions = await reactionsFor(d, user, room, ids.length ? Math.min(...ids) : null, Math.max(...ids));
  return rows.map(m => messageOut(m, user, room, reactions[m.id]));
}

const oneMessage = async (d, user, room, id) =>
  (await withReactions(d, user, room, [await d.prepare(`${MESSAGE} WHERE m.id = ?`).bind(id).first()]))[0];

// Records who a message mentions, as part of the batch that writes it.
// Mentioning yourself doesn't count.
function mentionStatements(d, user, messageIdSql, binds, text) {
  const names = mentioned(text).filter(n => n !== user.username);
  if (!names.length) return [];
  return [d.prepare(`INSERT OR IGNORE INTO chat_mentions (message, user_id)
    SELECT (${messageIdSql}), id FROM users WHERE username IN (${names.map(() => "?").join(", ")})`).bind(...binds, ...names)];
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
  return { seq: room.seq, more, joined: !!member, messages: await withReactions(d, user, room, rows) };
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
    d.prepare("DELETE FROM chat_reactions WHERE message IN (SELECT id FROM chat_messages WHERE room = ?)").bind(room.id),
    d.prepare("DELETE FROM chat_mentions WHERE message IN (SELECT id FROM chat_messages WHERE room = ?)").bind(room.id),
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

function messageText(body) {
  if (!isObj(body)) fail("body must be a JSON object");
  for (const k of Object.keys(body)) if (k !== "body") fail(`unknown field ${JSON.stringify(k)}`);
  return str("message", body.body, LIMITS.body, { required: true });
}

export async function post(env, user, roomId, body) {
  const text = messageText(body);
  const d = await db(env);
  const room = await getRoom(d, roomId);
  if (!room) return null;
  if (!(await membership(d, room.id, user.id))) return { forbidden: "join the room to post in it" };
  const t = now();
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ? AND created_at > ?").bind(user.id, t - RATE_WINDOW).first();
  if (n >= RATE) return { slow: "you're sending messages too quickly; wait a few seconds" };
  // One transaction: take the room's next seq and give it to the new message.
  const newest = "SELECT id FROM chat_messages WHERE room = ? AND seq = (SELECT seq FROM chat_rooms WHERE id = ?)";
  await d.batch([
    d.prepare("UPDATE chat_rooms SET seq = seq + 1, last_at = ? WHERE id = ?").bind(t, room.id),
    d.prepare("INSERT INTO chat_messages (room, user_id, body, seq, posted_seq, created_at) SELECT id, ?, ?, seq, seq, ? FROM chat_rooms WHERE id = ?")
      .bind(user.id, text, t, room.id),
    ...mentionStatements(d, user, newest, [room.id, room.id], text),
    d.prepare("UPDATE chat_members SET read_seq = (SELECT seq FROM chat_rooms WHERE id = ?) WHERE room = ? AND user_id = ?")
      .bind(room.id, room.id, user.id),
  ]);
  const m = await d.prepare(`${MESSAGE} WHERE m.room = ? AND m.user_id = ? ORDER BY m.id DESC LIMIT 1`).bind(room.id, user.id).first();
  return messageOut(m, user, room);
}

// Only the author edits a message. Mentions follow the new text.
export async function editMessage(env, user, roomId, messageId, body) {
  const text = messageText(body);
  const d = await db(env);
  const room = await getRoom(d, roomId);
  if (!room) return null;
  const m = await d.prepare("SELECT user_id, deleted, body FROM chat_messages WHERE id = ? AND room = ?").bind(messageId, room.id).first();
  if (!m || m.deleted) return null;
  if (m.user_id !== user.id) return { forbidden: "you can only edit your own messages" };
  if (m.body !== text) {
    await d.batch([
      d.prepare("UPDATE chat_rooms SET seq = seq + 1 WHERE id = ?").bind(room.id),
      d.prepare("UPDATE chat_messages SET body = ?, edited_at = ?, seq = (SELECT seq FROM chat_rooms WHERE id = ?) WHERE id = ?")
        .bind(text, now(), room.id, messageId),
      d.prepare("DELETE FROM chat_mentions WHERE message = ?").bind(messageId),
      ...mentionStatements(d, user, "?", [messageId], text),
    ]);
  }
  return oneMessage(d, user, room, messageId);
}

// Members add or take back a reaction: {emoji, on: true|false}.
export async function react(env, user, roomId, messageId, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  for (const k of Object.keys(body)) if (!["emoji", "on"].includes(k)) fail(`unknown field ${JSON.stringify(k)}`);
  if (!REACTIONS.includes(body.emoji)) fail(`emoji must be one of ${REACTIONS.join(" ")}`);
  if (typeof body.on !== "boolean") fail("on must be true or false");
  const d = await db(env);
  const room = await getRoom(d, roomId);
  if (!room) return null;
  const m = await d.prepare("SELECT deleted FROM chat_messages WHERE id = ? AND room = ?").bind(messageId, room.id).first();
  if (!m || m.deleted) return null;
  if (!(await membership(d, room.id, user.id))) return { forbidden: "join the room to react in it" };
  const had = await d.prepare("SELECT 1 AS x FROM chat_reactions WHERE message = ? AND user_id = ? AND emoji = ?").bind(messageId, user.id, body.emoji).first();
  if (!!had !== body.on) {
    await d.batch([
      d.prepare("UPDATE chat_rooms SET seq = seq + 1 WHERE id = ?").bind(room.id),
      body.on
        ? d.prepare("INSERT OR IGNORE INTO chat_reactions (message, user_id, emoji, created_at) VALUES (?, ?, ?, ?)").bind(messageId, user.id, body.emoji, now())
        : d.prepare("DELETE FROM chat_reactions WHERE message = ? AND user_id = ? AND emoji = ?").bind(messageId, user.id, body.emoji),
      d.prepare("UPDATE chat_messages SET seq = (SELECT seq FROM chat_rooms WHERE id = ?) WHERE id = ?").bind(room.id, messageId),
    ]);
  }
  return oneMessage(d, user, room, messageId);
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
    d.prepare("DELETE FROM chat_reactions WHERE message = ?").bind(messageId),
    d.prepare("DELETE FROM chat_mentions WHERE message = ?").bind(messageId),
  ]);
  return { deleted: true };
}

// ── routes ─────────────────────────────────────────────────────────────────
//
//   GET    /chat/api/state                          you, every room, and the reactions on offer
//   POST   /chat/api/rooms                          {name, topic} → a new room; you join it
//   PATCH  /chat/api/rooms/<id>                     {name, topic}   (owner or admin)
//   DELETE /chat/api/rooms/<id>                     the room and its messages   (owner or admin)
//   POST   /chat/api/rooms/<id>/join | leave
//   GET    /chat/api/rooms/<id>/members
//   GET    /chat/api/rooms/<id>/messages[?since=<seq> | ?before=<message id>]
//   POST   /chat/api/rooms/<id>/messages            {body}   (members)
//   PATCH  /chat/api/rooms/<id>/messages/<message id>   {body}   (its author)
//   DELETE /chat/api/rooms/<id>/messages/<message id>
//   POST   /chat/api/rooms/<id>/messages/<message id>/reactions   {emoji, on}   (members)

const ROUTE = /^\/chat\/api\/(state|rooms)(?:\/([^/]+)(?:\/(join|leave|members|messages)(?:\/([^/]+)(?:\/(reactions))?)?)?)?\/?$/;

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
    const [, kind, id, sub, extra, action] = m;
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
        reactions: REACTIONS,
      });
    }

    if (!id) return method === "POST" ? reply(await createRoom(env, user, await readJson(request)), 201) : notAllowed();
    if (!ROOM_ID.test(id)) return notFound();

    if (!sub) {
      if (method === "PATCH") return reply(await updateRoom(env, user, id, await readJson(request)));
      if (method === "DELETE") return reply(await deleteRoom(env, user, id));
      return notAllowed();
    }
    if (action && sub !== "messages") return notFound();
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
      if (action) return method === "POST" ? reply(await react(env, user, id, mid, await readJson(request))) : notAllowed();
      if (method === "PATCH") return reply(await editMessage(env, user, id, mid, await readJson(request)));
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
