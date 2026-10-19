// API keys: how an AI agent signs in to the MCP server (src/mcp.js) as the
// person who made the key. The key is shown once, when it's made; the database
// keeps only its SHA-256. Keys are made and revoked on /account (src/account.js).

import { db, now } from "./db.js";
import { randomToken, sha256 } from "./crypto.js";
import { AuthError } from "./auth.js";

const MAX_KEYS = 10;
const NAME_MAX = 60;
const TOUCH_EVERY = 5 * 60;          // how often last_used is written
const FORMAT = /^sf_[A-Za-z0-9_-]{20,90}$/;

export async function createKey(env, userId, rawName) {
  const name = String(rawName ?? "").trim();
  if (!name) throw new AuthError("Give the key a name, so you can tell it from others.");
  if (name.length > NAME_MAX) throw new AuthError(`Key names are at most ${NAME_MAX} characters.`);
  const d = await db(env);
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?").bind(userId).first();
  if (n >= MAX_KEYS) throw new AuthError(`You can have at most ${MAX_KEYS} keys. Revoke one first.`);
  const key = "sf_" + randomToken(32), idHash = await sha256(key);
  await d.prepare("INSERT INTO api_keys (id_hash, user_id, name, prefix, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(idHash, userId, name, key.slice(0, 8), now()).run();
  return { key, id_hash: idHash, prefix: key.slice(0, 8) };
}

export async function listKeys(env, userId) {
  const d = await db(env);
  const { results } = await d.prepare("SELECT id_hash, name, prefix, created_at, last_used FROM api_keys WHERE user_id = ? ORDER BY created_at, name")
    .bind(userId).all();
  return results;
}

export async function revokeKey(env, userId, idHash) {
  const res = await (await db(env)).prepare("DELETE FROM api_keys WHERE user_id = ? AND id_hash = ?").bind(userId, idHash).run();
  return res.meta.changes > 0;
}

// { user_id, id_hash } for a key someone sent, or null.
export async function findKey(env, token) {
  if (!FORMAT.test(String(token ?? ""))) return null;
  const idHash = await sha256(token);
  const row = await (await db(env)).prepare("SELECT user_id, id_hash FROM api_keys WHERE id_hash = ?").bind(idHash).first();
  return row || null;
}

export async function touchKey(env, idHash) {
  const t = now();
  await (await db(env)).prepare("UPDATE api_keys SET last_used = ? WHERE id_hash = ? AND (last_used IS NULL OR last_used < ?)")
    .bind(t, idHash, t - TOUCH_EVERY).run();
}
