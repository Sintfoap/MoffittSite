// Chat connections: someone's accounts on other chat platforms, brought into
// Chat as rooms of their own.
//
// Each platform is a provider (src/matrix.js is the first) with the same
// small shape:
//   { id, name, help, fields: [{name, label, secret?, required?, placeholder?}],
//     connect(fields) → {label, creds}      check the credentials, once
//     sync(creds, cursor) → {cursor, rooms} what changed since the last sync
//     send(creds, room, text) → message id
//     edit(creds, room, message id, text)
//     remove(creds, room, message id)
//     disconnect(creds) }                   undo whatever connect made there
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

import { db, now } from "./db.js";
import { randomBytes, hex, sha256, seal, unseal } from "./crypto.js";
import { matrix, ProviderError } from "./matrix.js";

export { ProviderError };
export const PROVIDERS = { matrix };
export const BRIDGE_AREA = "chat-bridges";

const MAX_CONNECTIONS = 5;
// Seconds between syncs of one connection.
const SYNC_EVERY = 2;
const CONNECTION_ID = /^k_[0-9a-f]{16}$/;

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
  await d.prepare(`INSERT INTO chat_connections (id, user_id, provider, label, secret, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(conn.id, user.id, provider.id, made.label, await seal(env.CHAT_BRIDGE_KEY, context(conn), JSON.stringify(made.creds)), now()).run();
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
  if (creds) await PROVIDERS[conn.provider]?.disconnect(creds).catch(() => {});
  const { results } = await d.prepare("SELECT id FROM chat_rooms WHERE connection = ?").bind(conn.id).all();
  for (const r of results) await deleteRoom(env, user, r.id, { force: true });
  await d.prepare("DELETE FROM chat_connections WHERE id = ?").bind(conn.id).run();
  return { deleted: true };
}

async function credsOf(env, conn) {
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
// connection synced a moment ago (unless forced), or is broken.
export async function syncConnection(env, d, conn, { force = false } = {}) {
  if (!conn || (conn.status === "error" && !force)) return;
  const t = now();
  const claimed = await d.prepare("UPDATE chat_connections SET tried_at = ? WHERE id = ? AND tried_at <= ?")
    .bind(t, conn.id, force ? t : t - SYNC_EVERY).run();
  if (!claimed.meta.changes) return;
  const provider = PROVIDERS[conn.provider];
  const creds = await credsOf(env, conn);
  if (!provider || !creds) return setError(d, conn, "its sign-in can't be read here any more; connect it again");
  let out;
  try { out = await provider.sync(creds, conn.cursor); }
  catch (e) {
    if (!(e instanceof ProviderError)) { console.error("chat sync failed:", e); return; }
    // A sign-in that stopped working stays broken until it's redone; anything else is tried again next time.
    if (e.auth) return setError(d, conn, e.message);
    await d.prepare("UPDATE chat_connections SET error = ? WHERE id = ?").bind(e.message, conn.id).run();
    return;
  }
  for (const r of out.rooms) await applyRoom(env, d, conn, r, !conn.cursor);
  await d.prepare("UPDATE chat_connections SET cursor = ?, status = 'ok', error = NULL, synced_at = ? WHERE id = ?")
    .bind(out.cursor ?? conn.cursor, now(), conn.id).run();
}

// Syncs every working connection someone has (for their room list).
export async function syncAll(env, user) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT * FROM chat_connections WHERE user_id = ? AND status = 'ok'").bind(user.id).all();
  await Promise.all(results.map(c => syncConnection(env, d, c)));
}

// Syncs the connection a bridge room belongs to (for the open room).
export async function syncRoom(env, user, room) {
  const d = await db(env);
  await syncConnection(env, d, await d.prepare("SELECT * FROM chat_connections WHERE id = ? AND user_id = ?").bind(room.connection, user.id).first());
}

async function applyRoom(env, d, conn, r, initial) {
  const id = await localRoomId(conn, r.id);
  const existing = await d.prepare("SELECT id, name, topic FROM chat_rooms WHERE id = ?").bind(id).first();
  if (r.left) {
    if (existing) await dropRoom(d, id);
    return;
  }
  const t = now();
  const stmts = [];
  if (!existing) {
    stmts.push(
      d.prepare(`INSERT INTO chat_rooms (id, name, topic, owner, created_at, last_at, kind, connection, ext_id, encrypted)
        VALUES (?, ?, ?, ?, ?, ?, 'bridge', ?, ?, ?)`).bind(id, r.name || r.fallback_name || r.id, r.topic ?? "", conn.user_id, t, 0, conn.id, r.id, r.encrypted ? 1 : 0),
      d.prepare("INSERT OR IGNORE INTO chat_members (room, user_id, joined_at) VALUES (?, ?, ?)").bind(id, conn.user_id, t),
    );
  } else if (r.name !== undefined || r.topic !== undefined || r.encrypted) {
    stmts.push(d.prepare("UPDATE chat_rooms SET name = ?, topic = ?, encrypted = MAX(encrypted, ?) WHERE id = ?")
      // A name taken away falls back to the stand-in; a stand-in alone never replaces a name.
      .bind(r.name || (r.name === "" && r.fallback_name) || existing.name, r.topic ?? existing.topic, r.encrypted ? 1 : 0, id));
  }
  for (const e of r.events) {
    const bump = d.prepare("UPDATE chat_rooms SET seq = seq + 1 WHERE id = ?").bind(id);
    if (e.type === "message") {
      stmts.push(
        d.prepare("UPDATE chat_rooms SET seq = seq + 1, last_at = MAX(last_at, ?) WHERE id = ?").bind(e.at, id),
        d.prepare(`INSERT OR IGNORE INTO chat_messages (room, user_id, body, seq, posted_seq, created_at, ext_id, ext_sender, ext_name, encrypted)
          SELECT id, ?, ?, seq, seq, ?, ?, ?, ?, ? FROM chat_rooms WHERE id = ?`)
          .bind(e.mine ? conn.user_id : "", e.body, e.at, e.id, e.sender, e.sender_name, e.encrypted ? 1 : 0, id),
      );
    } else if (e.type === "edit") {
      // Only the person who wrote a message can edit it, as Matrix has it.
      stmts.push(bump, d.prepare(`UPDATE chat_messages SET body = ?, edited_at = ?, seq = (SELECT seq FROM chat_rooms WHERE id = ?)
        WHERE room = ? AND ext_id = ? AND ext_sender = ? AND deleted = 0 AND encrypted = 0`).bind(e.body, e.at, id, id, e.target, e.sender));
    } else if (e.type === "delete") {
      stmts.push(bump, d.prepare(`UPDATE chat_messages SET deleted = 1, body = '', seq = (SELECT seq FROM chat_rooms WHERE id = ?)
        WHERE room = ? AND ext_id = ? AND deleted = 0`).bind(id, id, e.target));
    }
  }
  // The first sync brings in recent history, which isn't news to anyone.
  if (initial || !existing) {
    stmts.push(d.prepare("UPDATE chat_members SET read_seq = (SELECT seq FROM chat_rooms WHERE id = ?) WHERE room = ? AND user_id = ?").bind(id, id, conn.user_id));
  }
  if (stmts.length) await d.batch(stmts);
}

async function dropRoom(d, id) {
  await d.batch([
    d.prepare("DELETE FROM chat_presence WHERE room = ?").bind(id),
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
