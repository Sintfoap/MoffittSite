// Chat: rooms anyone with a Drift account can see, join and talk in.
//
// Open rooms are for everyone: anyone can browse the list and read one, and
// joining lets you post and puts it in your list with an unread count. Private
// rooms and direct messages are only for their members: to anyone else they
// don't exist (404), admins included. Members add people to a private room;
// a direct message is always the same two people. Whoever made a room can
// rename or delete it; admins can too, for rooms they can see. People edit and delete
// their own messages; a room's owner and admins can delete anyone's. Members
// react to messages from a short list of emoji, and "@username" in a message
// mentions that person, which their room list counts until they read it.
//
// The page polls for new messages. Every change in a room (a new, edited or
// deleted message, or a reaction) takes the room's next `seq`, so "what
// changed since seq N" is one indexed query and catches all of them. Polling
// also records that you have the room open, which is how others see who's
// here and who's typing.
//
// Bridge rooms are rooms on other platforms (Matrix, …) that someone brought
// in through a connection (src/bridges.js). Only that person is in them and
// sees them. Posting, editing and deleting there go to the platform first,
// and syncs bring the platform's changes in as ordinary changes to the room.

import { withRail } from "./pages.js";
import { db, now } from "./db.js";
import { sameOrigin } from "./account.js";
import { randomBytes, hex, sha256 } from "./crypto.js";
import { canBridge, bridgeInfo, listConnections, addConnection, removeConnection, syncConnection, syncAll, syncRoom, onPlatform, cryptoOp, backfill,
  joinBridged, leaveBridged, startDm, ENCRYPTED_NOTE } from "./bridges.js";
import { chatPushes } from "./notify.js";
import { gifInfo, gifImageSources, gifSearch, gifCategories, favorites, favorite, isGif, fetchGif } from "./gifs.js";
import { MXC, IMAGE_TYPES, MAX_MEDIA } from "./matrix.js";

export class BadRequest extends Error {}
const fail = msg => { throw new BadRequest(msg); };

const LIMITS = { name: 60, topic: 200, body: 2000, request: 16 * 1024, crypto: 512 * 1024, encrypted: 64 * 1024, page: 50, rooms: 20, search: 100, results: 50 };
// Seconds: how long after a poll someone still counts as here (or online
// anywhere), and how long "typing…" lasts after a keypress was reported.
const HERE = 30, ONLINE = 60, TYPING = 6;
// How long someone elsewhere counts as typing after a sync last said so
// (the platform says when they stop; this is in case that's missed).
const EXT_TYPING = 30;
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

export async function readJson(request, limit = LIMITS.request) {
  const text = await request.text();
  if (text.length > limit) fail("request too large");
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

function roomFields(body, base = { name: "", topic: "" }, allowed = ["name", "topic"]) {
  if (!isObj(body)) fail("body must be a JSON object");
  for (const k of Object.keys(body)) if (!allowed.includes(k)) fail(`unknown field ${JSON.stringify(k)}`);
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

// A room and your membership, or {} if there's no such room as far as you
// can tell: private rooms, DMs and bridge rooms you aren't in, and bridge
// rooms once connections are turned off for you.
async function load(d, user, roomId) {
  const room = await getRoom(d, roomId);
  if (!room) return {};
  const member = await membership(d, room.id, user.id);
  if (room.kind !== "open" && !member) return {};
  if (room.kind === "bridge" && !canBridge(user)) return {};
  return { room, member };
}

// Everyone who can use chat, for starting DMs and adding people to rooms.
const PEOPLE = `SELECT u.id, u.username, u.display_name FROM users u
  WHERE u.disabled = 0 AND EXISTS (SELECT 1 FROM user_areas a WHERE a.user_id = u.id AND a.area = 'todo')`;
const person = (d, username) =>
  d.prepare(`${PEOPLE} AND u.username = ?`).bind(String(username ?? "").trim().toLowerCase().replace(/^@/, "")).first();

const canManage = (room, user) => room.kind !== "bridge" && (room.owner === user.id || user.areas.has("admin"));
const bridged = room => room.kind === "bridge";

// Every room, newest activity first, with what this person needs to list it.
export async function listRooms(env, user) {
  const d = await db(env);
  const { results } = await d.prepare(`
    SELECT r.id, r.name, r.topic, r.owner, r.seq, r.created_at, r.last_at, r.kind, r.connection, r.encrypted, r.ext_id, r.ext_invite,
           (SELECT u.display_name || char(31) || u.username FROM chat_members o JOIN users u ON u.id = o.user_id
              WHERE r.kind = 'dm' AND o.room = r.id AND o.user_id != ?) AS dm_with,
           (SELECT display_name FROM users WHERE users.id = r.owner) AS owner_name,
           c.provider, c.label AS via, c.can_encrypt, c.crypto_owner,
           (SELECT COUNT(*) FROM chat_members m WHERE m.room = r.id) AS members,
           me.read_seq,
           (SELECT COUNT(*) FROM chat_messages x WHERE me.read_seq IS NOT NULL AND x.room = r.id
              AND COALESCE(x.posted_seq, x.seq) > me.read_seq AND x.deleted = 0 AND x.user_id != ?) AS unread,
           (SELECT COUNT(*) FROM chat_mentions mm JOIN chat_messages x ON x.id = mm.message
              WHERE me.read_seq IS NOT NULL AND mm.user_id = ? AND x.room = r.id
              AND COALESCE(x.posted_seq, x.seq) > me.read_seq AND x.deleted = 0) AS mentions
    FROM chat_rooms r LEFT JOIN chat_members me ON me.room = r.id AND me.user_id = ?
      LEFT JOIN chat_connections c ON c.id = r.connection
    WHERE (r.kind = 'open' OR me.user_id IS NOT NULL) AND (r.kind != 'bridge' OR ?)
    ORDER BY r.last_at DESC, r.id`).bind(user.id, user.id, user.id, user.id, canBridge(user) ? 1 : 0).all();
  return results.map(r => roomOut(r, user, r.read_seq != null));
}

function roomOut(r, user, joined) {
  const kind = r.kind ?? "open";
  // A DM is named for the other person in it.
  const [withName, withUser] = kind === "dm" ? (r.dm_with ?? "Deleted account\u001f").split("\u001f") : [];
  return {
    id: r.id, kind, name: kind === "dm" ? withName : r.name, topic: r.topic, owner_name: r.owner_name ?? null, members: r.members ?? 0,
    created_at: r.created_at, last_at: r.last_at, seq: r.seq, ...(kind === "dm" ? { with: withUser || null } : {}),
    joined, unread: joined ? r.unread ?? 0 : 0, mentions: joined ? r.mentions ?? 0 : 0,
    manage: kind !== "dm" && canManage({ ...r, kind }, user),
    // Which connection a bridge room comes through, and whether it can be written to.
    ...(kind === "bridge" ? { provider: r.provider, connection: r.connection, via: r.via, encrypted: !!r.encrypted, can_encrypt: !!r.can_encrypt } : {}),
    // An invite there you haven't answered: {by}.
    ...(kind === "bridge" && r.ext_invite ? { invite: JSON.parse(r.ext_invite) } : {}),
    // For the browser with the connection's keys: the room there, and whether keys can be or are held.
    ...(kind === "bridge" && r.encrypted ? { ext_room: r.ext_id, keys_held: !!r.crypto_owner } : {}),
  };
}

async function oneRoom(env, user, id) {
  return (await listRooms(env, user)).find(r => r.id === id) ?? null;
}

// (With what a reply answers: its author, and the start of what it said.)
const MESSAGE = `SELECT m.id, m.body, m.deleted, m.seq, m.created_at, m.edited_at, m.user_id, u.username, u.display_name,
    m.ext_id, m.ext_sender, m.ext_name, m.encrypted, m.ext_raw, m.reply_to, m.ext_media,
    q.body AS q_body, q.deleted AS q_deleted, q.encrypted AS q_encrypted, q.ext_id AS q_ext_id, q.ext_raw AS q_raw,
    q.user_id AS q_user, q.ext_sender AS q_sender, COALESCE(qu.display_name, q.ext_name, q.ext_sender) AS q_name
  FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN chat_messages q ON q.id = m.reply_to AND q.room = m.room LEFT JOIN users qu ON qu.id = q.user_id`;
const QUOTE = 200;

// What a reply answers: {id, author_name, body, mine}, or {id: null} when
// that message is gone (deleted, or never here).
function replyOut(m, user) {
  if (!m.reply_to) return null;
  if (m.q_deleted !== 0 || m.q_body == null) return { id: null, author_name: null, body: "", mine: false };
  return { id: m.reply_to, author_name: m.q_name || "Deleted account", mine: m.q_user === user.id,
    body: m.q_body.length > QUOTE ? m.q_body.slice(0, QUOTE) + "…" : m.q_body,
    // An encrypted one, for the browser to decrypt (and ext_id, to find what it read).
    ...(m.q_encrypted ? { encrypted: true, ext_id: m.q_ext_id, ...(m.q_raw ? { raw: m.q_raw } : {}) } : {}) };
}

const mediaUrl = (room, mxc) => `/chat/api/rooms/${room.id}/media?mxc=${encodeURIComponent(mxc)}`;

function messageOut(m, user, room, reactions = []) {
  const mine = m.user_id === user.id;
  // Someone on the other platform: named as they are there.
  const outside = !m.user_id && m.ext_sender;
  const locked = !!m.encrypted;
  let media = null;
  try { media = m.ext_media && !m.deleted ? JSON.parse(m.ext_media) : null; } catch { /* shown as its text */ }
  return {
    id: m.id, seq: m.seq, created_at: m.created_at, edited_at: m.deleted ? null : m.edited_at ?? null,
    deleted: !!m.deleted, body: m.deleted ? "" : m.body,
    author: outside ? m.ext_sender : m.username ?? null, author_name: outside ? m.ext_name || m.ext_sender : m.display_name ?? "Deleted account",
    // An encrypted message can be edited only from the browser with the keys.
    mine, can_edit: !m.deleted && mine && (!locked || !!m.ext_raw) && !media, can_delete: !m.deleted && (mine || canManage(room, user)),
    mentions_me: !m.deleted && !mine && !bridged(room) && mentioned(m.body).includes(user.username),
    reactions: m.deleted ? [] : reactions,
    reply: m.deleted ? null : replyOut(m, user),
    // ext_id: its id there (what an edit or reaction made in the browser points to).
    ...(bridged(room) ? { external: !!outside, encrypted: locked, ext_id: m.ext_id ?? null } : {}),
    // As it came, for the browser to decrypt; body is only a note. (After an edit, it's the edit.)
    ...(locked && m.ext_raw && !m.deleted ? { raw: m.ext_raw } : {}),
    // A picture from the other platform, fetched through the site (mediaFile).
    ...(media ? { media: { url: mediaUrl(room, media.mxc), mimetype: media.mimetype, width: media.width ?? null, height: media.height ?? null, name: media.name ?? "" } } : {}),
  };
}

// Reactions on messages lo..hi of a room: {message id: [{emoji, count, mine, names}]}.
async function reactionsFor(d, user, room, lo, hi) {
  const out = {};
  if (lo == null) return out;
  const { results } = await d.prepare(`
    SELECT message, emoji, COUNT(*) AS n, MAX(user_id = ?) AS mine, GROUP_CONCAT(name, ', ') AS names
    FROM (SELECT r.rowid AS k, r.message, r.emoji, r.user_id, COALESCE(u.display_name, r.ext_name, 'Deleted account') AS name
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
  let { room, member } = await load(d, user, roomId);
  if (!room) return null;
  if (bridged(room)) {
    // Bring in what's new on the platform first; it may have renamed or left the room.
    await syncRoom(env, user, room);
    ({ room, member } = await load(d, user, roomId));
    if (!room) return null;
  }
  let rows, more = false;
  if (since != null) {
    ({ results: rows } = await d.prepare(`${MESSAGE} WHERE m.room = ? AND m.seq > ? ORDER BY m.id LIMIT 500`).bind(room.id, since).all());
  } else {
    const q = before != null
      ? d.prepare(`${MESSAGE} WHERE m.room = ? AND m.id < ? AND m.deleted = 0 ORDER BY m.id DESC LIMIT ?`).bind(room.id, before, LIMITS.page + 1)
      : d.prepare(`${MESSAGE} WHERE m.room = ? AND m.deleted = 0 ORDER BY m.id DESC LIMIT ?`).bind(room.id, LIMITS.page + 1);
    ({ results: rows } = await q.all());
    // Run out of what's here in a bridge room: bring older messages in from the platform.
    // (A few pages at most, since a page there can be all things already here.)
    for (let i = 0; i < 3 && bridged(room) && before != null && rows.length <= LIMITS.page && room.ext_back !== ""; i++) {
      await backfill(env, d, user, room);
      ({ results: rows } = await q.all());
      room = await getRoom(d, room.id);
    }
    more = rows.length > LIMITS.page || bridged(room) && room.ext_back !== "";
    rows = rows.slice(0, LIMITS.page).reverse();
  }
  if (member && member.read_seq < room.seq) {
    await d.prepare("UPDATE chat_members SET read_seq = ? WHERE room = ? AND user_id = ? AND read_seq < ?")
      .bind(room.seq, room.id, user.id, room.seq).run();
  }
  const t = now();
  // You're here. (Written at most every few seconds per person and room.)
  await d.prepare(`INSERT INTO chat_presence (room, user_id, seen_at) VALUES (?, ?, ?)
    ON CONFLICT (room, user_id) DO UPDATE SET seen_at = excluded.seen_at WHERE seen_at < excluded.seen_at - 5`)
    .bind(room.id, user.id, t).run();
  if (bridged(room)) return { ...await bridgeExtras(env, d, user, room, t), seq: room.seq, more, joined: !!member, messages: await withReactions(d, user, room, rows) };
  const { results: others } = await d.prepare(`
    SELECT u.display_name AS name, p.typing_at > ? AS typing FROM chat_presence p JOIN users u ON u.id = p.user_id
    WHERE p.room = ? AND p.user_id != ? AND (p.seen_at > ? OR p.typing_at > ?) ORDER BY u.display_name COLLATE NOCASE`)
    .bind(t - TYPING, room.id, user.id, t - HERE, t - TYPING).all();
  return {
    seq: room.seq, more, joined: !!member, messages: await withReactions(d, user, room, rows),
    here: others.map(o => o.name), typing: others.filter(o => o.typing).map(o => o.name),
  };
}

// In a bridge room, the people there: who's typing (as the last sync said,
// for a while), and how far each has read ("Seen by" under that message).
// Reading it here also tells the platform you've read up to its newest message.
async function bridgeExtras(env, d, user, room, t) {
  const typing = room.ext_typing && room.ext_typing_at > t - EXT_TYPING ? JSON.parse(room.ext_typing) : [];
  const { results: reads } = await d.prepare(`SELECT r.ext_name AS name, m.id AS message FROM chat_ext_reads r
    JOIN chat_messages m ON m.room = r.room AND m.ext_id = r.ext_id WHERE r.room = ? ORDER BY r.at`).bind(room.id).all();
  const newest = await d.prepare(`SELECT ext_id FROM chat_messages WHERE room = ? AND ext_id IS NOT NULL AND deleted = 0
    ORDER BY id DESC LIMIT 1`).bind(room.id).first();
  if (newest && newest.ext_id !== room.ext_read) {
    const done = await onPlatform(env, d, user, room, (p, creds) => p.receipt?.(creds, room.ext_id, newest.ext_id));
    if (!done.error) await d.prepare("UPDATE chat_rooms SET ext_read = ? WHERE id = ?").bind(newest.ext_id, room.id).run();
  }
  return { here: [], typing, reads };
}

// Usernames of everyone who's had chat open in the last minute.
async function onlineNow(d) {
  const { results } = await d.prepare(`SELECT DISTINCT u.username FROM chat_presence p JOIN users u ON u.id = p.user_id
    WHERE p.seen_at > ? ORDER BY u.username`).bind(now() - ONLINE).all();
  return results.map(r => r.username);
}

export async function members(env, user, roomId) {
  const d = await db(env);
  const { room } = await load(d, user, roomId);
  if (!room) return null;
  const { results } = await d.prepare(`
    SELECT u.username, u.display_name, m.joined_at, m.user_id = ? AS owner,
           (SELECT MAX(seen_at) FROM chat_presence p WHERE p.user_id = m.user_id) > ? AS online
    FROM chat_members m JOIN users u ON u.id = m.user_id
    WHERE m.room = ? ORDER BY u.display_name COLLATE NOCASE`).bind(room.owner, now() - ONLINE, room.id).all();
  return results.map(r => ({ username: r.username, name: r.display_name, joined_at: r.joined_at, owner: !!r.owner, online: !!r.online }));
}

export async function people(env, user) {
  const d = await db(env);
  const { results } = await d.prepare(`${PEOPLE} AND u.id != ? ORDER BY u.display_name COLLATE NOCASE`).bind(user.id).all();
  const online = new Set(await onlineNow(d));
  return results.map(p => ({ username: p.username, name: p.display_name, online: online.has(p.username) }));
}

// Messages in a room containing some text, newest first.
export async function search(env, user, roomId, q) {
  const text = String(q ?? "").trim();
  if (text.length < 2) fail("search for at least 2 characters");
  if (text.length > LIMITS.search) fail(`search for at most ${LIMITS.search} characters`);
  const d = await db(env);
  const { room } = await load(d, user, roomId);
  if (!room) return null;
  const like = "%" + text.replace(/[\\%_]/g, c => "\\" + c) + "%";
  const { results } = await d.prepare(`${MESSAGE} WHERE m.room = ? AND m.deleted = 0 AND m.body LIKE ? ESCAPE '\\'
    ORDER BY m.id DESC LIMIT ?`).bind(room.id, like, LIMITS.results + 1).all();
  return {
    more: results.length > LIMITS.results,
    messages: results.slice(0, LIMITS.results).map(m => messageOut(m, user, room)),
  };
}

// Tells the room's other members you're typing, for a few seconds.
export async function typing(env, user, roomId) {
  const d = await db(env);
  const { room, member } = await load(d, user, roomId);
  if (!room) return null;
  if (!member) return { forbidden: "join the room to post in it" };
  if (bridged(room)) {
    // Told to the platform, when it has typing.
    const done = await onPlatform(env, d, user, room, async (p, creds) => { if (!p.typing) return false; await p.typing(creds, room.ext_id, true); return true; });
    return { typing: !!done.ok };
  }
  const t = now();
  await d.prepare(`INSERT INTO chat_presence (room, user_id, seen_at, typing_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (room, user_id) DO UPDATE SET seen_at = excluded.seen_at, typing_at = excluded.typing_at`)
    .bind(room.id, user.id, t, t).run();
  return { typing: true };
}

// ── changing ───────────────────────────────────────────────────────────────

// Open room names are unique, so the list never shows two the same.
const openNameTaken = (d, name, except = "") =>
  d.prepare("SELECT 1 AS x FROM chat_rooms WHERE kind = 'open' AND name = ? COLLATE NOCASE AND id != ?").bind(name, except).first();

// {name, topic, private}. A private room starts with just you; add people to it.
export async function createRoom(env, user, body) {
  const { name, topic } = roomFields(body, undefined, ["name", "topic", "private"]);
  if (body.private != null && typeof body.private !== "boolean") fail("private must be true or false");
  const kind = body.private ? "private" : "open";
  const d = await db(env);
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM chat_rooms WHERE owner = ? AND kind != 'dm'").bind(user.id).first();
  if (n >= LIMITS.rooms) fail(`you can make at most ${LIMITS.rooms} rooms`);
  if (kind === "open" && await openNameTaken(d, name)) fail("there's already a room with that name");
  const id = "r_" + hex(randomBytes(8)), t = now();
  await d.batch([
    d.prepare("INSERT INTO chat_rooms (id, name, topic, owner, created_at, last_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, name, topic, user.id, t, t, kind),
    d.prepare("INSERT INTO chat_members (room, user_id, joined_at) VALUES (?, ?, ?)").bind(id, user.id, t),
  ]);
  return roomOut({ id, kind, name, topic, owner: user.id, owner_name: user.display_name, members: 1, seq: 0, created_at: t, last_at: t, unread: 0 }, user, true);
}

// The direct message between you and someone else, made the first time
// either of you asks for it. Its id comes from the two accounts, so asking
// twice (or both at once) finds the same room.
export async function directMessage(env, user, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  for (const k of Object.keys(body)) if (k !== "username") fail(`unknown field ${JSON.stringify(k)}`);
  const d = await db(env);
  const other = await person(d, body.username);
  if (!other) fail("there's no one here with that username");
  if (other.id === user.id) fail("you can't send a direct message to yourself");
  const id = "r_" + (await sha256("dm:" + [user.id, other.id].sort().join(":"))).slice(0, 16), t = now();
  await d.batch([
    d.prepare("INSERT OR IGNORE INTO chat_rooms (id, name, topic, owner, created_at, last_at, kind) VALUES (?, '', '', ?, ?, ?, 'dm')").bind(id, user.id, t, t),
    d.prepare("INSERT OR IGNORE INTO chat_members (room, user_id, joined_at) VALUES (?, ?, ?)").bind(id, user.id, t),
    d.prepare("INSERT OR IGNORE INTO chat_members (room, user_id, joined_at) VALUES (?, ?, ?)").bind(id, other.id, t),
  ]);
  return oneRoom(env, user, id);
}

// Any member adds someone to a private room. They see it, with its history,
// next time their room list loads.
export async function addMember(env, user, roomId, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  for (const k of Object.keys(body)) if (k !== "username") fail(`unknown field ${JSON.stringify(k)}`);
  const d = await db(env);
  const { room, member } = await load(d, user, roomId);
  if (!room) return null;
  if (room.kind === "open") fail("anyone can join an open room; there's no need to add them");
  if (room.kind === "dm") fail("a direct message is just the two of you; make a private room for more people");
  if (bridged(room)) fail("people are added to this room on its own platform");
  if (!member) return { forbidden: "join the room first" };
  const other = await person(d, body.username);
  if (!other) fail("there's no one here with that username");
  await d.prepare("INSERT OR IGNORE INTO chat_members (room, user_id, joined_at) VALUES (?, ?, ?)").bind(room.id, other.id, now()).run();
  return members(env, user, roomId);
}

// The room's owner (or an admin in it) takes someone out of a private room.
export async function removeMember(env, user, roomId, username) {
  const d = await db(env);
  const { room } = await load(d, user, roomId);
  if (!room) return null;
  const other = await d.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
  if (!other || !(await membership(d, room.id, other.id))) return null;
  if (room.kind !== "private") fail("people can only be taken out of private rooms");
  if (other.id === user.id) return leave(env, user, roomId);
  if (!canManage(room, user)) return { forbidden: "only the room's owner can take people out" };
  if (other.id === room.owner) fail("the room's owner can't be taken out");
  await d.batch([
    d.prepare("DELETE FROM chat_members WHERE room = ? AND user_id = ?").bind(room.id, other.id),
    d.prepare("DELETE FROM chat_presence WHERE room = ? AND user_id = ?").bind(room.id, other.id),
  ]);
  return members(env, user, roomId);
}

export async function updateRoom(env, user, roomId, body) {
  const d = await db(env);
  const { room } = await load(d, user, roomId);
  if (!room) return null;
  if (room.kind === "dm") return { forbidden: "direct messages don't have a name or topic" };
  if (bridged(room)) return { forbidden: "rename this room on its own platform" };
  if (!canManage(room, user)) return { forbidden: "only the room's owner can change it" };
  const { name, topic } = roomFields(body, room);
  if (room.kind === "open" && name.toLowerCase() !== room.name.toLowerCase() && await openNameTaken(d, name, room.id)) {
    fail("there's already a room with that name");
  }
  await d.prepare("UPDATE chat_rooms SET name = ?, topic = ? WHERE id = ?").bind(name, topic, room.id).run();
  return { id: room.id, name, topic };
}

export async function deleteRoom(env, user, roomId, { force = false } = {}) {
  const d = await db(env);
  const room = force ? await getRoom(d, roomId) : (await load(d, user, roomId)).room;
  if (!room) return null;
  if (!force && room.kind === "dm") return { forbidden: "direct messages can't be deleted" };
  if (!force && bridged(room)) return { forbidden: "rooms from a connection go when the connection is removed" };
  if (!force && !canManage(room, user)) return { forbidden: "only the room's owner can delete it" };
  await d.batch([
    d.prepare("DELETE FROM chat_presence WHERE room = ?").bind(room.id),
    d.prepare("DELETE FROM chat_ext_reads WHERE room = ?").bind(room.id),
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
  const { room } = await load(d, user, roomId);
  if (!room) return null;
  // In a bridge room it's accepting the invite there.
  if (bridged(room)) return room.ext_invite ? joinBridged(env, d, user, room) : { joined: true };
  // Joining counts everything already there as read.
  await d.prepare("INSERT OR IGNORE INTO chat_members (room, user_id, joined_at, read_seq) VALUES (?, ?, ?, ?)")
    .bind(room.id, user.id, now(), room.seq).run();
  return { joined: true };
}

export async function leave(env, user, roomId) {
  const d = await db(env);
  const { room } = await load(d, user, roomId);
  if (!room) return null;
  if (room.kind === "dm") return { forbidden: "you can't leave a direct message" };
  // Leaving there (or declining the invite), which takes it from here too.
  if (bridged(room)) return leaveBridged(env, d, user, room);
  await d.batch([
    d.prepare("DELETE FROM chat_members WHERE room = ? AND user_id = ?").bind(room.id, user.id),
    d.prepare("DELETE FROM chat_presence WHERE room = ? AND user_id = ?").bind(room.id, user.id),
  ]);
  // A private room nobody is in any more is gone for good.
  if (room.kind === "private" && !(await d.prepare("SELECT 1 AS x FROM chat_members WHERE room = ?").bind(room.id).first())) {
    await deleteRoom(env, user, room.id, { force: true });
  }
  return { joined: false };
}

function messageText(body, extra = []) {
  if (!isObj(body)) fail("body must be a JSON object");
  for (const k of Object.keys(body)) if (k !== "body" && !extra.includes(k)) fail(`unknown field ${JSON.stringify(k)}`);
  return str("message", body.body, LIMITS.body, { required: true });
}

// {reply_to: message id}: the message in the same room a new one answers.
async function replyTarget(d, room, body) {
  if (body?.reply_to == null) return null;
  if (!Number.isSafeInteger(body.reply_to)) fail("reply_to must be a message id");
  const m = await d.prepare("SELECT id, ext_id FROM chat_messages WHERE id = ? AND room = ? AND deleted = 0").bind(body.reply_to, room.id).first();
  if (!m) fail("the message you're replying to isn't in this room");
  if (bridged(room) && !m.ext_id) fail("that message can't be replied to from here");
  return m;
}

// {encrypted: content}: a message the browser already encrypted, for an
// encrypted room. The site never sees what it says.
function encryptedContent(body, extra = []) {
  if (!isObj(body) || !isObj(body.encrypted)) return null;
  for (const k of Object.keys(body)) if (k !== "encrypted" && !extra.includes(k)) fail(`unknown field ${JSON.stringify(k)}`);
  const c = body.encrypted;
  if (typeof c.algorithm !== "string" || typeof c.ciphertext !== "string") fail("encrypted must be encrypted content");
  if (JSON.stringify(c).length > LIMITS.encrypted) fail("message too large");
  return c;
}

// `later` takes the push notifications for the new message, so they can be
// sent after the answer (ctx.waitUntil); without it they're sent first.
export async function post(env, user, roomId, body, later = p => p) {
  const content = encryptedContent(body, ["reply_to"]);
  const text = content ? "" : messageText(body, ["reply_to"]);
  const d = await db(env);
  const { room, member } = await load(d, user, roomId);
  if (!room) return null;
  if (!member) return { forbidden: "join the room to post in it" };
  if (room.ext_invite) return { forbidden: "accept the invite to post here" };
  const t = now();
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ? AND created_at > ?").bind(user.id, t - RATE_WINDOW).first();
  if (n >= RATE) return { slow: "you're sending messages too quickly; wait a few seconds" };
  const reply = await replyTarget(d, room, body);
  if (bridged(room)) return content ? postEncrypted(env, d, user, room, content, reply) : postBridged(env, d, user, room, text, reply);
  if (content) fail("only end-to-end encrypted rooms take encrypted messages");
  // One transaction: take the room's next seq and give it to the new message.
  const newest = "SELECT id FROM chat_messages WHERE room = ? AND seq = (SELECT seq FROM chat_rooms WHERE id = ?)";
  await d.batch([
    d.prepare("UPDATE chat_rooms SET seq = seq + 1, last_at = ? WHERE id = ?").bind(t, room.id),
    d.prepare("INSERT INTO chat_messages (room, user_id, body, seq, posted_seq, created_at, reply_to) SELECT id, ?, ?, seq, seq, ?, ? FROM chat_rooms WHERE id = ?")
      .bind(user.id, text, t, reply?.id ?? null, room.id),
    ...mentionStatements(d, user, newest, [room.id, room.id], text),
    d.prepare("UPDATE chat_members SET read_seq = (SELECT seq FROM chat_rooms WHERE id = ?) WHERE room = ? AND user_id = ?")
      .bind(room.id, room.id, user.id),
    // Sending a message ends "typing…".
    d.prepare("UPDATE chat_presence SET typing_at = 0 WHERE room = ? AND user_id = ?").bind(room.id, user.id),
  ]);
  const m = await d.prepare(`${MESSAGE} WHERE m.room = ? AND m.user_id = ? ORDER BY m.id DESC LIMIT 1`).bind(room.id, user.id).first();
  await later(chatPushes(env, { room, author: user, message: m, hereSince: t - HERE }).catch(e => console.error("chat pushes failed:", e)));
  return messageOut(m, user, room);
}

// Sends to the platform, then keeps the message here under the id it got
// there, so the sync that brings it back finds it already in place.
async function postBridged(env, d, user, room, text, reply) {
  if (room.encrypted) return { forbidden: "this room is end-to-end encrypted: send to it from the chat page in the browser that holds its keys" };
  // A GIF goes as a picture where the platform takes them, as it would from
  // their own app; if it can't be fetched it goes as its link. (A reply goes
  // as text, so it can say what it answers.)
  const gif = !reply && isGif(env, text) ? await fetchGif(env, text) : null;
  const sent = await onPlatform(env, d, user, room, async (p, creds) => ({
    id: gif && p.sendImage ? await p.sendImage(creds, room.ext_id, gif) : await p.send(creds, room.ext_id, text, { reply: reply?.ext_id }), sender: creds.user_id,
  }));
  if (sent.error) return { failed: sent.error };
  const t = now();
  await d.batch([
    d.prepare("UPDATE chat_rooms SET seq = seq + 1, last_at = ? WHERE id = ?").bind(t, room.id),
    d.prepare(`INSERT OR IGNORE INTO chat_messages (room, user_id, body, seq, posted_seq, created_at, ext_id, ext_sender, ext_name, reply_to)
      SELECT id, ?, ?, seq, seq, ?, ?, ?, ?, ? FROM chat_rooms WHERE id = ?`).bind(user.id, text, t, sent.ok.id, sent.ok.sender, user.display_name, reply?.id ?? null, room.id),
    d.prepare("UPDATE chat_members SET read_seq = (SELECT seq FROM chat_rooms WHERE id = ?) WHERE room = ? AND user_id = ?").bind(room.id, room.id, user.id),
  ]);
  const m = await d.prepare(`${MESSAGE} WHERE m.room = ? AND m.ext_id = ?`).bind(room.id, sent.ok.id).first();
  return messageOut(m, user, room);
}

// The same, encrypted by the browser: kept as it went, for it to decrypt.
async function postEncrypted(env, d, user, room, content, reply) {
  if (!room.encrypted) fail("this room isn't end-to-end encrypted");
  // A reply says what it answers outside the encryption, as Matrix has it.
  const answers = isObj(content["m.relates_to"]) ? content["m.relates_to"]["m.in_reply_to"]?.event_id ?? null : null;
  if ((reply?.ext_id ?? null) !== answers) fail(reply ? "the reply must say it answers that message" : "say which message this replies to (reply_to)");
  const sent = await onPlatform(env, d, user, room, async (p, creds) => {
    if (!p.sendEncrypted) return null;
    return { id: await p.sendEncrypted(creds, room.ext_id, content), sender: creds.user_id };
  });
  if (sent.error) return { failed: sent.error };
  if (!sent.ok) return { forbidden: "this platform can't take encrypted messages from here" };
  const t = now();
  const raw = JSON.stringify({ type: "m.room.encrypted", content, sender: sent.ok.sender, event_id: sent.ok.id, origin_server_ts: t * 1000, room_id: room.ext_id });
  await d.batch([
    d.prepare("UPDATE chat_rooms SET seq = seq + 1, last_at = ? WHERE id = ?").bind(t, room.id),
    d.prepare(`INSERT OR IGNORE INTO chat_messages (room, user_id, body, seq, posted_seq, created_at, ext_id, ext_sender, ext_name, encrypted, ext_raw, reply_to)
      SELECT id, ?, ?, seq, seq, ?, ?, ?, ?, 1, ?, ? FROM chat_rooms WHERE id = ?`).bind(user.id, ENCRYPTED_NOTE, t, sent.ok.id, sent.ok.sender, user.display_name, raw, reply?.id ?? null, room.id),
    d.prepare("UPDATE chat_members SET read_seq = (SELECT seq FROM chat_rooms WHERE id = ?) WHERE room = ? AND user_id = ?").bind(room.id, room.id, user.id),
  ]);
  const m = await d.prepare(`${MESSAGE} WHERE m.room = ? AND m.ext_id = ?`).bind(room.id, sent.ok.id).first();
  return messageOut(m, user, room);
}

// ── pictures in bridge rooms ───────────────────────────────────────────────

// Bytes as a response the page can show in an <img>, and nothing more: never
// a page of its own, whatever the platform said it was.
const fileResponse = (bytes, mimetype) => new Response(bytes, { headers: {
  "Content-Type": IMAGE_TYPES.includes(mimetype) ? mimetype : "application/octet-stream",
  "Content-Disposition": IMAGE_TYPES.includes(mimetype) ? "inline" : "attachment",
  "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
} });

// A picture from a bridge room's platform (mxc://… on Matrix), fetched with
// the connection's sign-in, which is why it comes through here. Encrypted
// rooms' pictures come as the encrypted bytes, for the browser to decrypt.
export async function mediaFile(env, user, roomId, mxc) {
  if (!MXC.test(mxc ?? "")) return null;
  const d = await db(env);
  const { room } = await load(d, user, roomId);
  if (!room || !bridged(room)) return null;
  const got = await onPlatform(env, d, user, room, async (p, creds) => p.download ? p.download(creds, mxc) : null);
  if (got.error) return { failed: got.error };
  if (!got.ok) return null;
  return { file: fileResponse(got.ok.bytes, got.ok.mimetype) };
}

// The browser's encrypted picture for an encrypted bridge room, to the
// platform's media store → {mxc}. It then sends the message that points to it.
export async function mediaUpload(env, user, roomId, request) {
  const d = await db(env);
  const { room } = await load(d, user, roomId);
  if (!room || !bridged(room)) return null;
  if (!room.encrypted) return { forbidden: "pictures go to this room as messages" };
  if (Number(request.headers.get("Content-Length")) > MAX_MEDIA) fail("that file is too big to send");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > MAX_MEDIA) fail(bytes.byteLength ? "that file is too big to send" : "nothing to send");
  const up = await onPlatform(env, d, user, room, async (p, creds) => p.upload ? p.upload(creds, bytes, "application/octet-stream") : null);
  if (up.error) return { failed: up.error };
  return up.ok ? { mxc: up.ok } : { forbidden: "this platform doesn't take files from here" };
}

// Only the author edits a message. Mentions follow the new text.
export async function editMessage(env, user, roomId, messageId, body) {
  const content = encryptedContent(body);
  const text = content ? "" : messageText(body);
  const d = await db(env);
  const { room } = await load(d, user, roomId);
  if (!room) return null;
  const m = await d.prepare("SELECT user_id, deleted, body, ext_id, encrypted FROM chat_messages WHERE id = ? AND room = ?").bind(messageId, room.id).first();
  if (!m || m.deleted) return null;
  if (m.user_id !== user.id) return { forbidden: "you can only edit your own messages" };
  if (content) {
    // An encrypted edit says which message it replaces outside the encryption.
    const rel = content["m.relates_to"];
    if (!bridged(room) || !m.encrypted || !m.ext_id) fail("only encrypted messages take encrypted edits");
    if (rel?.rel_type !== "m.replace" || rel.event_id !== m.ext_id) fail("the edit must say it replaces this message");
    const done = await onPlatform(env, d, user, room, async (p, creds) => ({ id: await p.sendEncrypted(creds, room.ext_id, content), sender: creds.user_id }));
    if (done.error) return { failed: done.error };
    const t = now();
    const raw = JSON.stringify({ type: "m.room.encrypted", content, sender: done.ok.sender, event_id: done.ok.id, origin_server_ts: t * 1000, room_id: room.ext_id });
    await d.batch([
      d.prepare("UPDATE chat_rooms SET seq = seq + 1 WHERE id = ?").bind(room.id),
      d.prepare("UPDATE chat_messages SET ext_raw = ?, edited_at = ?, seq = (SELECT seq FROM chat_rooms WHERE id = ?) WHERE id = ?")
        .bind(raw, t, room.id, messageId),
    ]);
    return oneMessage(d, user, room, messageId);
  }
  if (bridged(room) && m.encrypted) return { forbidden: "this message is end-to-end encrypted: edit it from the chat page in the browser that holds its keys" };
  if (bridged(room) && m.body !== text) {
    if (!m.ext_id) return { forbidden: "this message can't be edited from here" };
    const done = await onPlatform(env, d, user, room, (p, creds) => p.edit(creds, room.ext_id, m.ext_id, text));
    if (done.error) return { failed: done.error };
    await d.batch([
      d.prepare("UPDATE chat_rooms SET seq = seq + 1 WHERE id = ?").bind(room.id),
      d.prepare("UPDATE chat_messages SET body = ?, edited_at = ?, seq = (SELECT seq FROM chat_rooms WHERE id = ?) WHERE id = ?")
        .bind(text, now(), room.id, messageId),
    ]);
  } else if (m.body !== text) {
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

// Members add or take back a reaction: {emoji, on: true|false}. In a bridge
// room it goes to the platform, and any emoji will do (people there aren't
// limited to these); in an encrypted one, adding also takes {encrypted}:
// the reaction the browser encrypted.
export async function react(env, user, roomId, messageId, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  for (const k of Object.keys(body)) if (!["emoji", "on", "encrypted"].includes(k)) fail(`unknown field ${JSON.stringify(k)}`);
  if (typeof body.on !== "boolean") fail("on must be true or false");
  const d = await db(env);
  const { room, member } = await load(d, user, roomId);
  if (!room) return null;
  const anyEmoji = bridged(room) && typeof body.emoji === "string" && body.emoji.length >= 1 && body.emoji.length <= 32 && !/[\u0000-\u001f\u007f]/.test(body.emoji);
  if (!REACTIONS.includes(body.emoji) && !anyEmoji) fail(`emoji must be one of ${REACTIONS.join(" ")}`);
  const m = await d.prepare("SELECT deleted, ext_id FROM chat_messages WHERE id = ? AND room = ?").bind(messageId, room.id).first();
  if (!m || m.deleted) return null;
  if (!member) return { forbidden: "join the room to react in it" };
  const had = await d.prepare("SELECT ext_id FROM chat_reactions WHERE message = ? AND user_id = ? AND emoji = ?").bind(messageId, user.id, body.emoji).first();
  if (!!had === body.on) return oneMessage(d, user, room, messageId);
  let extId = null;
  if (bridged(room)) {
    if (!m.ext_id) return { forbidden: "this message can't be reacted to from here" };
    let done;
    if (!body.on) {
      done = had.ext_id ? await onPlatform(env, d, user, room, (p, creds) => p.remove(creds, room.ext_id, had.ext_id)) : { ok: true };
    } else if (room.encrypted) {
      const c = body.encrypted, rel = isObj(c) ? c["m.relates_to"] : null;
      if (!isObj(c)) return { forbidden: "this room is end-to-end encrypted: react from the chat page in the browser that holds its keys" };
      if (typeof c.algorithm !== "string" || typeof c.ciphertext !== "string" || JSON.stringify(c).length > LIMITS.encrypted) fail("encrypted must be encrypted content");
      if (rel?.rel_type !== "m.annotation" || rel.event_id !== m.ext_id || rel.key !== body.emoji) fail("the reaction must say it's this emoji on this message");
      done = await onPlatform(env, d, user, room, (p, creds) => p.sendEncrypted(creds, room.ext_id, c));
    } else {
      done = await onPlatform(env, d, user, room, (p, creds) => p.react(creds, room.ext_id, m.ext_id, body.emoji));
    }
    if (done.error) return { failed: done.error };
    if (body.on) extId = done.ok;
  } else if (body.encrypted !== undefined) fail("only end-to-end encrypted rooms take encrypted reactions");
  await d.batch([
    d.prepare("UPDATE chat_rooms SET seq = seq + 1 WHERE id = ?").bind(room.id),
    body.on
      ? d.prepare("INSERT OR IGNORE INTO chat_reactions (message, user_id, emoji, created_at, ext_id) VALUES (?, ?, ?, ?, ?)").bind(messageId, user.id, body.emoji, now(), extId)
      : d.prepare("DELETE FROM chat_reactions WHERE message = ? AND user_id = ? AND emoji = ?").bind(messageId, user.id, body.emoji),
    d.prepare("UPDATE chat_messages SET seq = (SELECT seq FROM chat_rooms WHERE id = ?) WHERE id = ?").bind(room.id, messageId),
  ]);
  return oneMessage(d, user, room, messageId);
}

export async function deleteMessage(env, user, roomId, messageId) {
  const d = await db(env);
  const { room } = await load(d, user, roomId);
  if (!room) return null;
  const m = await d.prepare("SELECT user_id, deleted, ext_id FROM chat_messages WHERE id = ? AND room = ?").bind(messageId, room.id).first();
  if (!m || m.deleted) return null;
  if (m.user_id !== user.id && !canManage(room, user)) return { forbidden: "you can only delete your own messages" };
  if (bridged(room) && m.ext_id) {
    const done = await onPlatform(env, d, user, room, (p, creds) => p.remove(creds, room.ext_id, m.ext_id));
    if (done.error) return { failed: done.error };
  }
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
//   GET    /chat/api/state                          you, every room you can see, who's online, and the reactions on offer
//   GET    /chat/api/people                         everyone who can use chat
//   POST   /chat/api/dms                            {username} → your direct message room with them
//   POST   /chat/api/rooms                          {name, topic, private} → a new room; you join it
//   PATCH  /chat/api/rooms/<id>                     {name, topic}   (owner or admin)
//   DELETE /chat/api/rooms/<id>                     the room and its messages   (owner or admin)
//   POST   /chat/api/rooms/<id>/join | leave
//   GET    /chat/api/rooms/<id>/members
//   POST   /chat/api/rooms/<id>/members                 {username}   add someone to a private room (members)
//   DELETE /chat/api/rooms/<id>/members/<username>      take someone out of a private room (owner, or yourself)
//   GET    /chat/api/rooms/<id>/search?q=<text>
//   POST   /chat/api/rooms/<id>/typing
//   GET    /chat/api/rooms/<id>/messages[?since=<seq> | ?before=<message id>]   (+ who's here and typing)
//   POST   /chat/api/rooms/<id>/messages            {body}   (members)
//   PATCH  /chat/api/rooms/<id>/messages/<message id>   {body}   (its author)
//   DELETE /chat/api/rooms/<id>/messages/<message id>
//   POST   /chat/api/rooms/<id>/messages/<message id>/reactions   {emoji, on}   (members)
//   GET    /chat/api/rooms/<id>/media?mxc=<address>  a picture in a bridge room, from its platform
//   POST   /chat/api/rooms/<id>/media               (the bytes) an encrypted bridge room's encrypted picture → {mxc}
//   GET    /chat/api/connections                    your connections to other platforms   (with Chat connections on)
//   POST   /chat/api/connections                    {provider, ...its fields} → a new connection, synced once
//   DELETE /chat/api/connections/<id>               the connection and its rooms
//   POST   /chat/api/connections/<id>/sync          sync it now, and try again if it had stopped working
//   POST   /chat/api/connections/<id>/dm            {user, encrypted?} → {id}: a direct message with someone there
//   POST   /chat/api/connections/<id>/crypto/claim    {key}   this browser holds the encryption keys → {device}
//   POST   /chat/api/connections/<id>/crypto/inbox    {key, ack?}   what syncs brought for the keys → {items, counts}
//   POST   /chat/api/connections/<id>/crypto/request  {key, method, path, body?}   a key request, passed on → {response}
//   GET    /chat/api/gifs[?q=<text>&pos=<next>]     GIFs for the picker: a search, or what's trending → {results, next}
//   GET    /chat/api/gifs/categories                the picker's category tiles
//   GET    /chat/api/gifs/favorites                 your starred GIFs
//   GET    /chat/api/gifs/file?url=<GIF link>       a GIF's bytes, for the browser to encrypt for an encrypted room
//   POST   /chat/api/gifs/favorites                 {gif, on}   star a GIF, or take the star off

const ROUTE = /^\/chat\/api\/(state|people|dms|rooms|connections|gifs)(?:\/([^/]+)(?:\/(join|leave|members|messages|search|typing|sync|crypto|dm|media)(?:\/([^/]+)(?:\/(reactions))?)?)?)?\/?$/;

// Messages are shown as text, never as HTML, and the page loads nothing from
// elsewhere except fonts and GIFs from the GIF hosts (src/gifs.js).
// (WebAssembly is for the encryption library; blob: is for pictures it decrypts.)
const pageCsp = env => [
  "default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "connect-src 'self'", "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", ["img-src 'self' data: blob:", ...gifImageSources(env)].join(" "), "manifest-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

// (Messages from further back on another platform have ids below zero: bridges.js, backfill.)
const int = v => /^-?\d{1,15}$/.test(v ?? "") ? Number(v) : undefined;

export async function chat(request, env, user, pathname, ctx) {
  if (!pathname.startsWith("/chat/api/")) {
    const asset = await withRail(await env.ASSETS.fetch(request), user, "chat");
    const res = new Response(asset.body, asset);
    if ((res.headers.get("Content-Type") || "").startsWith("text/html")) {
      res.headers.set("Content-Security-Policy", pageCsp(env));
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
      // The other platform refused or couldn't be reached.
      : out.failed ? json({ error: out.failed }, 502)
      : out.unavailable ? json({ error: out.unavailable }, 503)
      : json(out, status);

    if (kind === "state") {
      if (id) return notFound();
      if (method !== "GET") return notAllowed();
      if (canBridge(user)) await syncAll(env, user);
      return json({
        user: { username: user.username, name: user.display_name, admin: user.areas.has("admin") },
        rooms: await listRooms(env, user),
        online: await onlineNow(await db(env)),
        reactions: REACTIONS,
        bridges: bridgeInfo(env, user),
        gifs: gifInfo(env),
      });
    }
    if (kind === "gifs") {
      if (sub) return notFound();
      if (id === "favorites") {
        if (method === "GET") return json(await favorites(env, user));
        return method === "POST" ? reply(await favorite(env, user, await readJson(request), fail)) : notAllowed();
      }
      if (method !== "GET") return notAllowed();
      if (id === "categories") return reply(await gifCategories(env));
      if (id === "file") {
        const gif = await fetchGif(env, new URL(request.url).searchParams.get("url"));
        return gif ? fileResponse(gif.bytes, gif.mimetype) : notFound();
      }
      if (id) return notFound();
      const q = new URL(request.url).searchParams;
      return reply(await gifSearch(env, user, { q: q.get("q"), pos: q.get("pos") }));
    }
    if (kind === "connections") {
      if (!canBridge(user)) return json({ error: "connections to other platforms aren't turned on for your account" }, 403);
      if (!id) {
        if (method === "GET") return json(await listConnections(env, user));
        return method === "POST" ? reply(await addConnection(env, user, await readJson(request), fail), 201) : notAllowed();
      }
      if (sub === "crypto" && extra && !action) {
        if (!["claim", "inbox", "request"].includes(extra)) return notFound();
        if (method !== "POST") return notAllowed();
        return reply(await cryptoOp(env, user, id, extra, await readJson(request, LIMITS.crypto), fail));
      }
      if (sub === "dm" && !extra && !action) {
        if (method !== "POST") return notAllowed();
        return reply(await startDm(env, user, id, await readJson(request), fail), 201);
      }
      if (action || extra || (sub && sub !== "sync")) return notFound();
      if (sub) {
        if (method !== "POST") return notAllowed();
        const d = await db(env);
        const conn = await d.prepare("SELECT * FROM chat_connections WHERE id = ? AND user_id = ?").bind(id, user.id).first();
        if (!conn) return notFound();
        await syncConnection(env, d, conn, { force: true });
        return json((await listConnections(env, user)).find(c => c.id === id));
      }
      return method === "DELETE" ? reply(await removeConnection(env, user, id, deleteRoom)) : notAllowed();
    }
    if (kind === "people") {
      if (id) return notFound();
      return method === "GET" ? json(await people(env, user)) : notAllowed();
    }
    if (kind === "dms") {
      if (id) return notFound();
      return method === "POST" ? reply(await directMessage(env, user, await readJson(request))) : notAllowed();
    }

    if (!id) return method === "POST" ? reply(await createRoom(env, user, await readJson(request)), 201) : notAllowed();
    if (!ROOM_ID.test(id)) return notFound();

    if (!sub) {
      if (method === "PATCH") return reply(await updateRoom(env, user, id, await readJson(request)));
      if (method === "DELETE") return reply(await deleteRoom(env, user, id));
      return notAllowed();
    }
    if ((action && sub !== "messages") || sub === "sync" || sub === "crypto" || sub === "dm") return notFound();
    if (sub === "join" || sub === "leave" || sub === "typing") {
      if (extra) return notFound();
      if (method !== "POST") return notAllowed();
      return reply(await ({ join, leave, typing })[sub](env, user, id));
    }
    if (sub === "media") {
      if (extra) return notFound();
      if (method === "POST") return reply(await mediaUpload(env, user, id, request), 201);
      if (method !== "GET") return notAllowed();
      const out = await mediaFile(env, user, id, new URL(request.url).searchParams.get("mxc"));
      return out?.file ?? reply(out);
    }
    if (sub === "search") {
      if (extra) return notFound();
      if (method !== "GET") return notAllowed();
      return reply(await search(env, user, id, new URL(request.url).searchParams.get("q")));
    }
    if (sub === "members") {
      if (extra) return method === "DELETE" ? reply(await removeMember(env, user, id, extra)) : notAllowed();
      if (method === "POST") return reply(await addMember(env, user, id, await readJson(request)));
      return method === "GET" ? reply(await members(env, user, id)) : notAllowed();
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
    const later = ctx ? p => ctx.waitUntil(p) : undefined;
    if (method === "POST") return reply(await post(env, user, id, await readJson(request), later), 201);
    return notAllowed();
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    console.error("chat error:", e);
    return json({ error: "server error" }, 500);
  }
}
