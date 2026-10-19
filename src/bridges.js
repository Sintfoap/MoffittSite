// Chat connections: someone's accounts on other chat platforms, brought into
// Chat as rooms of their own.
//
// Each platform is a provider (src/matrix.js is the first) with the same
// small shape:
//   { id, name, help, fields: [{name, label, secret?, required?, placeholder?}],
//     connect(fields) → {label, creds}      check the credentials, once
//     sync(creds, cursor) → {cursor, rooms} what changed since the last sync
//     send(creds, room, text, {reply?}) → message id (reply: what it answers)
//     edit(creds, room, message id, text)
//     remove(creds, room, message id)        a message, or a reaction
//     react(creds, room, message id, emoji) → the reaction's id
//     join(creds, room), leave(creds, room)  accept an invite; leave (or decline one)
//     startDm(creds, their id, {encrypted}) → {id, name}   (optional) a direct message there
//     history(creds, room, from) → {events, from}   (optional) older events, oldest
//                                           first, as sync has them, and where to go on from (null: the start)
//     search(creds, room, text, next) → {messages, next}   (optional) the platform's own search
//                                           of a room, newest first, a page at a time (messages as history has them)
//     typing(creds, room, on)               (optional) "typing…" there
//     receipt(creds, room, message id)      (optional) read up to here
//     disconnect(creds)                     undo whatever connect made there
//     and, for end-to-end encryption (optional):
//     canEncrypt(creds), device(creds) → {user_id, device_id},
//     sendEncrypted(creds, room, content) → message id,
//     and for pictures (optional): sendImage(creds, room, {bytes, mimetype, name, width, height}) → message id,
//     upload(creds, bytes, mimetype, name) → media address, download(creds, address) → {bytes, mimetype}
//     cryptoRequest(creds, method, path, body) → the platform's answer
//     and, for push notifications (optional):
//     setPusher(creds, key, url), removePusher(creds, key),
//     message(creds, room, message id) → that message as sync has it, or null }
// Adding a platform means writing one of those and listing it in PROVIDERS;
// the API, the web page and the terminal build their forms from `fields`.
//
// The credentials are sealed (crypto.js) with the CHAT_BRIDGE_KEY secret and
// bound to their owner, so the database alone doesn't give them away.
// Connections are only ever visible to their owner, admins included.
//
// A connection's rooms are chat_rooms of kind "bridge" with one member, the
// owner, so unread counts, history, search and polling work as they do for
// any room. Syncing happens while chat is open: the room list and the open
// room ask for one, at most every few seconds per connection.
//
// End-to-end encryption happens in the browser, never here: one browser
// claims a connection's keys (proving itself after with a key only it has),
// takes what each sync brought for them from an inbox, and has its key
// requests passed on. Encrypted messages are kept as they came. So the keys
// follow their owner, that browser sends a copy of them, locked with its
// browser key, which is kept here sealed; another of the owner's browsers
// can take them from there (cryptoOp's save and take).
//
// For push notifications (src/notify.js), a connection whose owner has them
// on gets a pusher on the platform: the homeserver tells the site when a
// message arrives that the owner's own notification settings there say is
// worth a notification, and the site syncs and pushes it. Its key names the
// connection and is signed with CHAT_BRIDGE_KEY, so nothing else can pose as it.

import { db, now } from "./db.js";
import { randomBytes, hex, sha256, seal, unseal, b64url } from "./crypto.js";
import { matrix, ProviderError, ENCRYPTED_NOTE } from "./matrix.js";

export { ProviderError, ENCRYPTED_NOTE };
export const PROVIDERS = { matrix };
export const BRIDGE_AREA = "chat-bridges";

const MAX_CONNECTIONS = 5;
// Seconds between syncs of one connection.
const SYNC_EVERY = 2;
const CONNECTION_ID = /^k_[0-9a-f]{16}$/;
// Sync results kept for the browser with a connection's keys, at most.
const MAX_INBOX = 1000;

export const canBridge = user => user.areas.has(BRIDGE_AREA);
export const bridgeReady = env => typeof env.CHAT_BRIDGE_KEY === "string" && env.CHAT_BRIDGE_KEY.length >= 16;

const context = conn => `chat-connection:${conn.user_id}:${conn.id}`;

// What the page needs to offer connections at all.
export function bridgeInfo(env, user) {
  if (!canBridge(user)) return { allowed: false };
  return {
    allowed: true, ready: bridgeReady(env),
    providers: Object.values(PROVIDERS).map(p => ({ id: p.id, name: p.name, help: p.help, fields: p.fields })),
  };
}

function connectionOut(c) {
  return {
    id: c.id, provider: c.provider, network: PROVIDERS[c.provider]?.name ?? c.provider, label: c.label,
    status: c.status, error: c.error ?? null, created_at: c.created_at, synced_at: c.synced_at || null, rooms: c.rooms ?? 0,
    // Whether encrypted rooms can be used through it, whether a browser already holds its keys,
    // and whether they can follow you to your other browsers (a copy of them is kept).
    can_encrypt: !!c.can_encrypt, keys_held: !!c.crypto_owner, keys_kept: !!(c.crypto_owner && c.crypto_saved_at),
  };
}

export async function listConnections(env, user) {
  const d = await db(env);
  const { results } = await d.prepare(`SELECT c.*, (SELECT COUNT(*) FROM chat_rooms r WHERE r.connection = c.id) AS rooms
    FROM chat_connections c WHERE c.user_id = ? ORDER BY c.created_at`).bind(user.id).all();
  return results.map(connectionOut);
}

const getConnection = (d, user, id) => CONNECTION_ID.test(id)
  ? d.prepare("SELECT * FROM chat_connections WHERE id = ? AND user_id = ?").bind(id, user.id).first() : null;

// {provider, ...that provider's fields}. Checks them with the platform, keeps
// what it says to keep, then does the first sync.
export async function addConnection(env, user, body, fail) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("body must be a JSON object");
  const provider = PROVIDERS[body.provider];
  if (!provider) fail(`provider must be one of ${Object.keys(PROVIDERS).join(", ")}`);
  if (!bridgeReady(env)) return { unavailable: "connections need the site's CHAT_BRIDGE_KEY secret, which hasn't been set up yet" };
  const fields = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "provider") continue;
    const f = provider.fields.find(f => f.name === k);
    if (!f) fail(`unknown field ${JSON.stringify(k)}`);
    if (v != null && typeof v !== "string") fail(`${f.label} must be text`);
    if ((v ?? "").length > 2000) fail(`${f.label} is too long`);
    fields[k] = v ?? "";
  }
  for (const f of provider.fields) if (f.required && !String(fields[f.name] ?? "").trim()) fail(`${f.label} is required`);
  const d = await db(env);
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM chat_connections WHERE user_id = ?").bind(user.id).first();
  if (n >= MAX_CONNECTIONS) fail(`you can have at most ${MAX_CONNECTIONS} connections`);

  let made;
  try { made = await provider.connect(fields); }
  catch (e) { if (e instanceof ProviderError) fail(e.message); throw e; }
  const dupe = await d.prepare("SELECT id FROM chat_connections WHERE user_id = ? AND provider = ? AND label = ?").bind(user.id, provider.id, made.label).first();
  if (dupe) {
    await provider.disconnect(made.creds).catch(() => {});
    fail(`${made.label} is already connected`);
  }
  const conn = { id: "k_" + hex(randomBytes(8)), user_id: user.id, provider: provider.id, label: made.label };
  await d.prepare(`INSERT INTO chat_connections (id, user_id, provider, label, secret, created_at, can_encrypt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(conn.id, user.id, provider.id, made.label, await seal(env.CHAT_BRIDGE_KEY, context(conn), JSON.stringify(made.creds)), now(),
      provider.canEncrypt?.(made.creds) ? 1 : 0).run();
  await syncConnection(env, d, await getConnection(d, user, conn.id), { force: true });
  return (await listConnections(env, user)).find(c => c.id === conn.id);
}

// Removes the connection and everything it brought in. Whatever the
// connection made on the platform (a session) is ended too, if it can be.
export async function removeConnection(env, user, id, deleteRoom) {
  const d = await db(env);
  const conn = await getConnection(d, user, id);
  if (!conn) return null;
  const creds = await credsOf(env, conn);
  if (creds && conn.pusher_at) await dropPusher(env, d, conn).catch(() => {});
  if (creds) await PROVIDERS[conn.provider]?.disconnect(creds).catch(() => {});
  const { results } = await d.prepare("SELECT id FROM chat_rooms WHERE connection = ?").bind(conn.id).all();
  for (const r of results) await deleteRoom(env, user, r.id, { force: true });
  await d.batch([
    d.prepare("DELETE FROM chat_crypto_inbox WHERE connection = ?").bind(conn.id),
    d.prepare("DELETE FROM chat_crypto_copies WHERE connection = ?").bind(conn.id),
    d.prepare("DELETE FROM chat_connections WHERE id = ?").bind(conn.id),
  ]);
  return { deleted: true };
}

export async function credsOf(env, conn) {
  if (!bridgeReady(env)) return null;
  const text = await unseal(env.CHAT_BRIDGE_KEY, context(conn), conn.secret);
  return text ? JSON.parse(text) : null;
}

const setError = (d, conn, error) =>
  d.prepare("UPDATE chat_connections SET status = 'error', error = ? WHERE id = ?").bind(String(error).slice(0, 300), conn.id).run();

// The local id of a room on a connection: the same every time, and shaped
// like any other room id.
const localRoomId = async (conn, extId) => "r_" + (await sha256(`bridge:${conn.id}:${extId}`)).slice(0, 16);

// Brings in what changed on the platform since the last sync. Skipped if this
// connection synced a moment ago (unless forced), or is broken. Returns the
// new messages from other people it brought in (none on the first sync, which
// is history), for notifications: [{room: {id, name}, id, sender_name, body, encrypted}].
export async function syncConnection(env, d, conn, { force = false } = {}) {
  if (!conn || (conn.status === "error" && !force)) return [];
  const t = now();
  const claimed = await d.prepare("UPDATE chat_connections SET tried_at = ? WHERE id = ? AND tried_at <= ?")
    .bind(t, conn.id, force ? t : t - SYNC_EVERY).run();
  if (!claimed.meta.changes) return [];
  const provider = PROVIDERS[conn.provider];
  const creds = await credsOf(env, conn);
  if (!provider || !creds) { await setError(d, conn, "its sign-in can't be read here any more; connect it again"); return []; }
  // (Connections made before encryption came in.)
  if (!conn.can_encrypt && provider.canEncrypt?.(creds)) await d.prepare("UPDATE chat_connections SET can_encrypt = 1 WHERE id = ?").bind(conn.id).run();
  let out;
  try { out = await provider.sync(creds, conn.cursor); }
  catch (e) {
    if (!(e instanceof ProviderError)) { console.error("chat sync failed:", e); return []; }
    // A sign-in that stopped working stays broken until it's redone; anything else is tried again next time.
    if (e.auth) { await setError(d, conn, e.message); return []; }
    await d.prepare("UPDATE chat_connections SET error = ? WHERE id = ?").bind(e.message, conn.id).run();
    return [];
  }
  const news = [];
  for (const r of out.rooms) news.push(...await applyRoom(env, d, conn, r, !conn.cursor));
  // Only a browser holding the keys can use what came for them.
  if (out.crypto && conn.crypto_owner) {
    const { to_device, changed, left, otk_counts, fallback } = out.crypto;
    const stmts = [];
    if (to_device.length || changed.length || left.length) {
      stmts.push(d.prepare("INSERT INTO chat_crypto_inbox (connection, data, created_at) VALUES (?, ?, ?)")
        .bind(conn.id, JSON.stringify({ to_device, changed, left }), now()));
      stmts.push(d.prepare(`DELETE FROM chat_crypto_inbox WHERE connection = ? AND id <=
        (SELECT id FROM chat_crypto_inbox WHERE connection = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`).bind(conn.id, conn.id, MAX_INBOX));
    }
    if (otk_counts) stmts.push(d.prepare("UPDATE chat_connections SET crypto_counts = ? WHERE id = ?").bind(JSON.stringify({ otk_counts, fallback }), conn.id));
    if (stmts.length) await d.batch(stmts);
  }
  await d.prepare("UPDATE chat_connections SET cursor = ?, status = 'ok', error = NULL, synced_at = ? WHERE id = ?")
    .bind(out.cursor ?? conn.cursor, now(), conn.id).run();
  return news;
}

// Syncs every working connection someone has (for their room list).
export async function syncAll(env, user) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT * FROM chat_connections WHERE user_id = ? AND status = 'ok'").bind(user.id).all();
  await Promise.all(results.map(c => syncConnection(env, d, c)));
}

// Syncs the connection a bridge room belongs to (for the open room).
export async function syncRoom(env, user, room, { force = false } = {}) {
  const d = await db(env);
  await syncConnection(env, d, await d.prepare("SELECT * FROM chat_connections WHERE id = ? AND user_id = ?").bind(room.connection, user.id).first(), { force });
}

async function applyRoom(env, d, conn, r, initial) {
  const id = await localRoomId(conn, r.id);
  const existing = await d.prepare("SELECT id, name, topic FROM chat_rooms WHERE id = ?").bind(id).first();
  if (r.left) {
    if (existing) await dropRoom(d, id);
    return [];
  }
  const t = now();
  const stmts = [];
  // An invite: listed (at the top) until it's accepted or declined.
  const invite = r.invite ? JSON.stringify(r.invite) : null;
  if (!existing) {
    stmts.push(
      d.prepare(`INSERT INTO chat_rooms (id, name, topic, owner, created_at, last_at, kind, connection, ext_id, encrypted, ext_invite)
        VALUES (?, ?, ?, ?, ?, ?, 'bridge', ?, ?, ?, ?)`).bind(id, r.name || r.fallback_name || r.id, r.topic ?? "", conn.user_id, t, invite ? t : 0, conn.id, r.id, r.encrypted ? 1 : 0, invite),
      d.prepare("INSERT OR IGNORE INTO chat_members (room, user_id, joined_at) VALUES (?, ?, ?)").bind(id, conn.user_id, t),
    );
  } else if (r.name !== undefined || r.topic !== undefined || r.encrypted) {
    stmts.push(d.prepare("UPDATE chat_rooms SET name = ?, topic = ?, encrypted = MAX(encrypted, ?) WHERE id = ?")
      // A name taken away falls back to the stand-in; a stand-in alone never replaces a name.
      .bind(r.name || (r.name === "" && r.fallback_name) || existing.name, r.topic ?? existing.topic, r.encrypted ? 1 : 0, id));
  }
  if (existing) stmts.push(d.prepare("UPDATE chat_rooms SET ext_invite = ? WHERE id = ? AND ext_invite IS NOT ?").bind(invite, id, invite));
  for (const e of r.events) {
    const bump = d.prepare("UPDATE chat_rooms SET seq = seq + 1 WHERE id = ?").bind(id);
    if (e.type === "message") {
      stmts.push(
        d.prepare("UPDATE chat_rooms SET seq = seq + 1, last_at = MAX(last_at, ?) WHERE id = ?").bind(e.at, id),
        // (A reply to a message from before this site's history points nowhere.)
        d.prepare(`INSERT OR IGNORE INTO chat_messages (room, user_id, body, seq, posted_seq, created_at, ext_id, ext_sender, ext_name, encrypted, ext_raw, reply_to, ext_media)
          SELECT id, ?, ?, seq, seq, ?, ?, ?, ?, ?, ?, (SELECT id FROM chat_messages WHERE room = ? AND ext_id = ?), ? FROM chat_rooms WHERE id = ?`)
          .bind(e.mine ? conn.user_id : "", e.body, e.at, e.id, e.sender, e.sender_name, e.encrypted ? 1 : 0, e.raw ?? null, id, e.reply ?? null, e.media ? JSON.stringify(e.media) : null, id),
      );
    } else if (e.type === "edit" && e.raw) {
      // An encrypted edit replaces what the browser decrypts.
      stmts.push(bump, d.prepare(`UPDATE chat_messages SET ext_raw = ?, edited_at = ?, seq = (SELECT seq FROM chat_rooms WHERE id = ?)
        WHERE room = ? AND ext_id = ? AND ext_sender = ? AND deleted = 0 AND encrypted = 1`).bind(e.raw, e.at, id, id, e.target, e.sender));
    } else if (e.type === "edit") {
      // Only the person who wrote a message can edit it, as Matrix has it.
      stmts.push(bump, d.prepare(`UPDATE chat_messages SET body = ?, edited_at = ?, seq = (SELECT seq FROM chat_rooms WHERE id = ?)
        WHERE room = ? AND ext_id = ? AND ext_sender = ? AND deleted = 0 AND encrypted = 0`).bind(e.body, e.at, id, id, e.target, e.sender));
    } else if (e.type === "reaction") {
      const who = e.mine ? conn.user_id : "~" + e.sender;
      stmts.push(bump,
        d.prepare(`INSERT OR IGNORE INTO chat_reactions (message, user_id, emoji, created_at, ext_id, ext_name)
          SELECT id, ?, ?, ?, ?, ? FROM chat_messages WHERE room = ? AND ext_id = ? AND deleted = 0`).bind(who, e.key, e.at, e.id, e.sender_name, id, e.target),
        d.prepare("UPDATE chat_messages SET seq = (SELECT seq FROM chat_rooms WHERE id = ?) WHERE room = ? AND ext_id = ?").bind(id, id, e.target));
    } else if (e.type === "delete") {
      // What went is a message (and its reactions with it), or a reaction.
      const reactedTo = "(SELECT message FROM chat_reactions WHERE ext_id = ? AND message IN (SELECT id FROM chat_messages WHERE room = ?))";
      stmts.push(bump,
        d.prepare(`UPDATE chat_messages SET seq = (SELECT seq FROM chat_rooms WHERE id = ?) WHERE id IN ${reactedTo}`).bind(id, e.target, id),
        d.prepare("DELETE FROM chat_reactions WHERE ext_id = ? AND message IN (SELECT id FROM chat_messages WHERE room = ?)").bind(e.target, id),
        d.prepare("DELETE FROM chat_reactions WHERE message IN (SELECT id FROM chat_messages WHERE room = ? AND ext_id = ?)").bind(id, e.target),
        d.prepare(`UPDATE chat_messages SET deleted = 1, body = '', seq = (SELECT seq FROM chat_rooms WHERE id = ?)
          WHERE room = ? AND ext_id = ? AND deleted = 0`).bind(id, id, e.target));
    }
  }
  // Where older history starts, the first time a sync says.
  if (r.back !== undefined) stmts.push(d.prepare("UPDATE chat_rooms SET ext_back = ? WHERE id = ? AND ext_back IS NULL").bind(r.back, id));
  // Who's typing there, and how far people there have read.
  if (r.typing) stmts.push(d.prepare("UPDATE chat_rooms SET ext_typing = ?, ext_typing_at = ? WHERE id = ?").bind(JSON.stringify(r.typing), t, id));
  for (const rc of r.receipts ?? []) {
    stmts.push(d.prepare(`INSERT INTO chat_ext_reads (room, ext_user, ext_name, ext_id, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (room, ext_user) DO UPDATE SET ext_name = excluded.ext_name, ext_id = excluded.ext_id, at = excluded.at WHERE excluded.at >= at`)
      .bind(id, rc.user, rc.name, rc.event, rc.at));
  }
  // The first sync brings in recent history, which isn't news to anyone.
  if (initial || !existing) {
    stmts.push(d.prepare("UPDATE chat_members SET read_seq = (SELECT seq FROM chat_rooms WHERE id = ?) WHERE room = ? AND user_id = ?").bind(id, id, conn.user_id));
  }
  if (stmts.length) await d.batch(stmts);
  if (initial) return [];
  const name = (await d.prepare("SELECT name FROM chat_rooms WHERE id = ?").bind(id).first())?.name ?? "";
  return r.events.filter(e => e.type === "message" && !e.mine)
    .map(e => ({ room: { id, name }, id: e.id, sender_name: e.sender_name, body: e.body, encrypted: !!e.encrypted }));
}

// Accepting an invite (joining there), and leaving a room there or
// declining an invite: the room goes from here too.
export async function joinBridged(env, d, user, room) {
  const done = await onPlatform(env, d, user, room, (p, creds) => p.join(creds, room.ext_id));
  if (done.error) return { failed: done.error };
  await d.prepare("UPDATE chat_rooms SET ext_invite = NULL WHERE id = ?").bind(room.id).run();
  await syncRoom(env, user, room, { force: true });
  return { joined: true };
}
export async function leaveBridged(env, d, user, room) {
  const done = await onPlatform(env, d, user, room, (p, creds) => p.leave(creds, room.ext_id));
  if (done.error) return { failed: done.error };
  await dropRoom(d, room.id);
  return { joined: false, gone: true };
}

// A direct message with someone on a connection's platform: {user} (their
// id there) → the room, made there if it's new, and synced in.
export async function startDm(env, user, connId, body, fail) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("body must be a JSON object");
  for (const k of Object.keys(body)) if (!["user", "encrypted"].includes(k)) fail(`unknown field ${JSON.stringify(k)}`);
  if (typeof body.user !== "string" || !body.user.trim()) fail("user is required");
  if (body.encrypted !== undefined && typeof body.encrypted !== "boolean") fail("encrypted must be true or false");
  const d = await db(env);
  const conn = await getConnection(d, user, connId);
  if (!conn) return null;
  const c = await forRoom(env, d, user, { connection: conn.id });
  if (c.error) return { failed: c.error };
  if (!c.provider.startDm) return { forbidden: `${c.provider.name} can't start conversations from here` };
  // Encrypted, as Element makes them, when this connection can hold keys.
  const encrypted = body.encrypted ?? !!c.provider.canEncrypt?.(c.creds);
  if (encrypted && !c.provider.canEncrypt?.(c.creds)) return { forbidden: "an encrypted conversation needs a connection signed in with a username and password" };
  let ext;
  try { ext = await c.provider.startDm(c.creds, body.user, { encrypted }); }
  catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    if (e.auth) await setError(d, conn, e.message);
    return { failed: e.message };
  }
  await syncConnection(env, d, await getConnection(d, user, connId), { force: true });
  const id = await localRoomId(conn, ext.id);
  if (!await d.prepare("SELECT 1 AS x FROM chat_rooms WHERE id = ?").bind(id).first()) return { failed: "the conversation was made there, but hasn't come through yet; sync in a moment" };
  // Until they've joined, it may have nothing to be named for but its id: name it for them.
  await d.prepare("UPDATE chat_rooms SET name = ? WHERE id = ? AND name = ext_id").bind(ext.name, id).run();
  return { id };
}

// Brings in a page of a bridge room's older history, from before anything
// here, when you scroll back past it. Those messages take ids below every
// other (counting down from 0), so they sort before what's already here.
// They're history, so they're neither unread nor news to a poll.
export async function backfill(env, d, user, room) {
  const got = await onPlatform(env, d, user, room, (p, creds) => p.history?.(creds, room.ext_id, room.ext_back || undefined));
  if (got.error || !got.ok) return 0;
  const { events, from } = got.ok, id = room.id;
  const nextId = "(SELECT MIN(COALESCE(MIN(id), 0), 0) - 1 FROM chat_messages)";
  const stmts = [];
  // Newest first, so the oldest ends up lowest.
  const msgs = events.filter(e => e.type === "message").reverse();
  for (const e of msgs) {
    stmts.push(d.prepare(`INSERT OR IGNORE INTO chat_messages (id, room, user_id, body, seq, posted_seq, created_at, ext_id, ext_sender, ext_name, encrypted, ext_raw, edited_at, ext_media)
      SELECT ${nextId}, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?`)
      .bind(id, e.mine ? user.id : "", e.body, e.at, e.id, e.sender, e.sender_name, e.encrypted ? 1 : 0, e.raw ?? null, e.edited_at ?? null, e.media ? JSON.stringify(e.media) : null));
  }
  // Then what refers to them: replies, and reactions.
  for (const e of msgs.filter(e => e.reply)) {
    stmts.push(d.prepare(`UPDATE chat_messages SET reply_to = (SELECT id FROM chat_messages WHERE room = ? AND ext_id = ?)
      WHERE room = ? AND ext_id = ? AND reply_to IS NULL`).bind(id, e.reply, id, e.id));
  }
  for (const e of events.filter(e => e.type === "reaction")) {
    stmts.push(d.prepare(`INSERT OR IGNORE INTO chat_reactions (message, user_id, emoji, created_at, ext_id, ext_name)
      SELECT id, ?, ?, ?, ?, ? FROM chat_messages WHERE room = ? AND ext_id = ? AND deleted = 0`)
      .bind(e.mine ? user.id : "~" + e.sender, e.key, e.at, e.id, e.sender_name, id, e.target));
  }
  stmts.push(d.prepare("UPDATE chat_rooms SET ext_back = ? WHERE id = ?").bind(from ?? "", id));
  await d.batch(stmts);
  return msgs.length;
}

async function dropRoom(d, id) {
  await d.batch([
    d.prepare("DELETE FROM chat_presence WHERE room = ?").bind(id),
    d.prepare("DELETE FROM chat_ext_reads WHERE room = ?").bind(id),
    d.prepare("DELETE FROM chat_reactions WHERE message IN (SELECT id FROM chat_messages WHERE room = ?)").bind(id),
    d.prepare("DELETE FROM chat_messages WHERE room = ?").bind(id),
    d.prepare("DELETE FROM chat_members WHERE room = ?").bind(id),
    d.prepare("DELETE FROM chat_rooms WHERE id = ?").bind(id),
  ]);
}

// ── writing to the platform (chat.js calls these for bridge rooms) ─────────

async function forRoom(env, d, user, room) {
  const conn = await d.prepare("SELECT * FROM chat_connections WHERE id = ? AND user_id = ?").bind(room.connection, user.id).first();
  if (!conn) return { error: "this room's connection is gone" };
  if (conn.status === "error") return { error: `${conn.label} needs connecting again: ${conn.error}` };
  const creds = await credsOf(env, conn);
  if (!creds) return { error: "this room's connection can't be used; connect it again" };
  return { conn, creds, provider: PROVIDERS[conn.provider] };
}

// Runs one write on the platform: {ok: result} or {error: message}.
export async function onPlatform(env, d, user, room, fn) {
  const c = await forRoom(env, d, user, room);
  if (c.error) return c;
  try { return { ok: await fn(c.provider, c.creds, c.conn) }; }
  catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    if (e.auth) await setError(d, c.conn, e.message);
    return { error: e.message };
  }
}

// ── end-to-end encryption (chat.js passes the crypto routes here) ──────────

// The browser holding a connection's keys proves itself with a key of its
// own making (its seat), which only its hash is kept of.
const KEY = /^[0-9a-f]{64}$/;
// A copy of the keys (public/chat/carry.js) is at most this long, and is
// kept in parts of this size, so each part fits in a D1 row once sealed.
export const MAX_COPY = 8 * 1024 * 1024;
const COPY_PART = 1000 * 1000;
// The browser holding the keys counts as using them for this long after it
// last asked for anything; till then, another only takes them if told to.
const IN_USE = 60;
// How often its asking is written down, at most.
const SEEN_EVERY = 10;

const vaultContext = conn => `chat-connection-vault:${conn.user_id}:${conn.id}`;
const copyContext = (conn, part) => `chat-connection-copy:${conn.user_id}:${conn.id}:${part}`;

async function readCopy(env, d, conn) {
  const { results } = await d.prepare("SELECT part, data FROM chat_crypto_copies WHERE connection = ? ORDER BY part").bind(conn.id).all();
  if (!results.length) return null;
  const parts = await Promise.all(results.map(r => unseal(env.CHAT_BRIDGE_KEY, copyContext(conn, r.part), r.data)));
  return parts.every(p => p != null) ? parts.join("") : null;
}

// {op, key, ...}: what a browser asks about a connection's keys.
//   claim    {vault?}  makes the browser asking the one that holds the keys,
//            if none does yet; vault is its browser key, kept sealed so the
//            keys can follow you to your other browsers → {device, kept, saved}
//   inbox    {ack?}    what syncs brought for the keys → {items, counts}
//   request  {method, path, body?}  a key request, passed on → {response}
//   save     {copy, ack}  the keys as they are now (carry.js), having taken
//            the inbox up to ack → {saved}
//   take     {force?}  moves the keys to the browser asking, from the copy:
//            → {device, vault, copy}, or {busy} while another is using them
export async function cryptoOp(env, user, id, op, body, fail) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("body must be a JSON object");
  if (typeof body.key !== "string" || !KEY.test(body.key)) fail("key must be 64 hex characters");
  const d = await db(env);
  const conn = await getConnection(d, user, id);
  if (!conn) return null;
  const c = await forRoom(env, d, user, { connection: conn.id });
  if (c.error) return { failed: c.error };
  if (!c.provider.canEncrypt?.(c.creds)) {
    return { forbidden: "encryption needs a connection signed in with a username and password, so it has a session of its own; remove this one and connect it that way" };
  }
  const hash = await sha256("crypto-owner:" + body.key), t = now();
  if (op === "claim" && !conn.crypto_owner) {
    const won = await d.prepare("UPDATE chat_connections SET crypto_owner = ? WHERE id = ? AND crypto_owner IS NULL").bind(hash, conn.id).run();
    if (won.meta.changes) await d.batch([
      d.prepare("DELETE FROM chat_crypto_inbox WHERE connection = ?").bind(conn.id),
      d.prepare("DELETE FROM chat_crypto_copies WHERE connection = ?").bind(conn.id),
      d.prepare("UPDATE chat_connections SET crypto_vault = NULL, crypto_saved_at = 0 WHERE id = ?").bind(conn.id),
    ]);
    Object.assign(conn, await d.prepare("SELECT crypto_owner, crypto_vault, crypto_saved_at, crypto_seen_at FROM chat_connections WHERE id = ?").bind(conn.id).first());
  }
  if (op === "take" && conn.crypto_owner !== hash) return takeKeys(env, d, conn, c, hash, body, fail);
  if (conn.crypto_owner !== hash) {
    return conn.crypto_owner
      ? { forbidden: conn.crypto_saved_at ? "your encryption keys have moved to another of your browsers"
          : "another browser holds this connection's encryption keys; open chat there once and they'll follow you here", code: "elsewhere" }
      : { forbidden: "turn encryption on for this connection first" };
  }
  if (conn.crypto_seen_at < t - SEEN_EVERY) await d.prepare("UPDATE chat_connections SET crypto_seen_at = ? WHERE id = ?").bind(t, conn.id).run();
  if (op === "claim" || op === "take") {
    // The browser key, from a browser that had the keys before they could follow you.
    if (!conn.crypto_vault && body.vault !== undefined) {
      if (typeof body.vault !== "string" || !KEY.test(body.vault)) fail("vault must be 64 hex characters");
      conn.crypto_vault = await seal(env.CHAT_BRIDGE_KEY, vaultContext(conn), body.vault);
      await d.prepare("UPDATE chat_connections SET crypto_vault = ? WHERE id = ?").bind(conn.crypto_vault, conn.id).run();
    }
    return { device: c.provider.device(c.creds), kept: !!conn.crypto_vault, saved: !!conn.crypto_saved_at };
  }
  if (op === "inbox") {
    // What an earlier call handed over is marked taken (it goes once a copy
    // of the keys has it), then the rest is handed over.
    const ack = body.ack ?? 0;
    if (!Number.isSafeInteger(ack) || ack < 0) fail("ack must be a message number");
    if (ack) await d.prepare("UPDATE chat_crypto_inbox SET taken = 1 WHERE connection = ? AND id <= ? AND taken = 0").bind(conn.id, ack).run();
    const { results } = await d.prepare("SELECT id, data FROM chat_crypto_inbox WHERE connection = ? AND taken = 0 ORDER BY id LIMIT 50").bind(conn.id).all();
    const counts = JSON.parse((await d.prepare("SELECT crypto_counts FROM chat_connections WHERE id = ?").bind(conn.id).first()).crypto_counts || "null");
    return { items: results.map(r => ({ id: r.id, ...JSON.parse(r.data) })), counts };
  }
  if (op === "save") {
    if (typeof body.copy !== "string" || !body.copy || body.copy.length > MAX_COPY) fail("copy must be the keys, as text");
    const ack = body.ack ?? 0;
    if (!Number.isSafeInteger(ack) || ack < 0) fail("ack must be a message number");
    if (!conn.crypto_vault) return { forbidden: "send the browser key first (claim, with vault)" };
    const stmts = [d.prepare("DELETE FROM chat_crypto_copies WHERE connection = ?").bind(conn.id)];
    for (let i = 0, part = 0; i < body.copy.length; i += COPY_PART, part++) {
      stmts.push(d.prepare("INSERT INTO chat_crypto_copies (connection, part, data) VALUES (?, ?, ?)")
        .bind(conn.id, part, await seal(env.CHAT_BRIDGE_KEY, copyContext(conn, part), body.copy.slice(i, i + COPY_PART))));
    }
    // What the copy has taken in needn't be kept for the next browser.
    stmts.push(d.prepare("DELETE FROM chat_crypto_inbox WHERE connection = ? AND id <= ?").bind(conn.id, ack),
      d.prepare("UPDATE chat_connections SET crypto_saved_at = ? WHERE id = ?").bind(t, conn.id));
    await d.batch(stmts);
    return { saved: true };
  }
  if (op === "request") {
    if (!["GET", "POST", "PUT"].includes(body.method)) fail("method must be GET, POST or PUT");
    if (typeof body.path !== "string" || body.path.length > 500) fail("path must be text");
    try { return { response: await c.provider.cryptoRequest(c.creds, body.method, body.path, body.body) }; }
    catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      if (e.auth) await setError(d, conn, e.message);
      return e.refused ? { forbidden: e.message } : { failed: e.message };
    }
  }
  return null;
}

// Another of your browsers takes the keys: it's handed the latest copy and
// the browser key that opens it, and everything syncs brought since that
// copy was made. The browser that had them is told they've gone the next
// time it asks.
async function takeKeys(env, d, conn, c, hash, body, fail) {
  if (body.force !== undefined && typeof body.force !== "boolean") fail("force must be true or false");
  if (!conn.crypto_owner) return { forbidden: "turn encryption on for this connection first" };
  const vault = conn.crypto_vault && await unseal(env.CHAT_BRIDGE_KEY, vaultContext(conn), conn.crypto_vault);
  const copy = conn.crypto_saved_at && vault && await readCopy(env, d, conn);
  if (!copy) return { forbidden: "another browser holds this connection's encryption keys; open chat there once and they'll follow you here", code: "elsewhere" };
  if (!body.force && conn.crypto_seen_at >= now() - IN_USE) return { busy: true, seen_at: conn.crypto_seen_at };
  const moved = await d.prepare("UPDATE chat_connections SET crypto_owner = ?, crypto_seen_at = ? WHERE id = ? AND crypto_owner = ?")
    .bind(hash, now(), conn.id, conn.crypto_owner).run();
  if (!moved.meta.changes) return { busy: true, seen_at: now() };
  // What the browser before took from the inbox after its last copy, it takes again.
  await d.prepare("UPDATE chat_crypto_inbox SET taken = 0 WHERE connection = ?").bind(conn.id).run();
  return { device: c.provider.device(c.creds), vault, copy };
}

// ── pushers (src/notify.js decides when a connection should have one) ──────

const MAC_INFO = "sintfoap pusher v1\0";
async function mac(env, connId) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(MAC_INFO + env.CHAT_BRIDGE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(connId))));
}

// The key a connection's pusher is registered with: its id and a signature.
export const pushKey = async (env, conn) => `${conn.id}.${await mac(env, conn.id)}`;

// The connection a pusher key names, if the signature is right.
export async function connectionForPushKey(env, d, key) {
  if (!bridgeReady(env)) return null;
  const [id, sig] = String(key ?? "").split(".");
  if (!CONNECTION_ID.test(id) || !sig || sig !== await mac(env, id)) return null;
  return d.prepare("SELECT * FROM chat_connections WHERE id = ?").bind(id).first();
}

// A message the platform pushed, read from it directly when a sync hasn't
// brought it in yet: as notify.js's bridgePushes takes it, {mine: true} for
// your own, or null (not a message, a room not here yet, or no answer).
export async function fetchMessage(env, d, conn, extRoom, extId) {
  const provider = PROVIDERS[conn.provider], creds = await credsOf(env, conn);
  if (!provider?.message || !creds || typeof extRoom !== "string" || typeof extId !== "string") return null;
  const r = await d.prepare("SELECT id, name FROM chat_rooms WHERE id = ? AND connection = ?").bind(await localRoomId(conn, extRoom), conn.id).first();
  if (!r) return null;
  let e;
  try { e = await provider.message(creds, extRoom, extId); }
  catch (err) { if (err instanceof ProviderError) return null; throw err; }
  if (!e) return null;
  if (e.mine) return { mine: true };
  return { room: { id: r.id, name: r.name }, id: e.id, sender_name: e.sender_name, body: e.body, encrypted: !!e.encrypted };
}

// Registers the connection's pusher on the platform, pointing at `url`.
// Returns null, or why it couldn't (and pushes then rely on the cron's syncs).
export async function setPusher(env, d, conn, url) {
  const provider = PROVIDERS[conn.provider], creds = await credsOf(env, conn);
  if (!provider?.setPusher || !creds) return "this platform can't tell the site about new messages";
  try { await provider.setPusher(creds, await pushKey(env, conn), url); }
  catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    if (e.auth) await setError(d, conn, e.message);
    return e.message;
  }
  await d.prepare("UPDATE chat_connections SET pusher_at = ? WHERE id = ?").bind(now(), conn.id).run();
  return null;
}

export async function dropPusher(env, d, conn) {
  const provider = PROVIDERS[conn.provider], creds = await credsOf(env, conn);
  await d.prepare("UPDATE chat_connections SET pusher_at = 0 WHERE id = ?").bind(conn.id).run();
  if (provider?.removePusher && creds) await provider.removePusher(creds, await pushKey(env, conn));
}
