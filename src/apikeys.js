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

// `nonce` comes from the form that asked for the key. If the browser sends that
// form again (a refresh), no second key is made.
export async function createKey(env, userId, rawName, rawNonce) {
  const name = String(rawName ?? "").trim();
  if (!name) throw new AuthError("Give the key a name, so you can tell it from others.");
  if (name.length > NAME_MAX) throw new AuthError(`Key names are at most ${NAME_MAX} characters.`);
  const nonce = String(rawNonce ?? "").slice(0, 64) || null;
  const d = await db(env);
  const again = new AuthError("That key was already made, and a key can only be shown once. If you lost it, revoke it and make another.", { status: 409 });
  if (nonce && await d.prepare("SELECT 1 AS x FROM api_keys WHERE user_id = ? AND nonce = ?").bind(userId, nonce).first()) throw again;
  const key = "sf_" + randomToken(32), idHash = await sha256(key);
  // The limit is checked inside the insert, so two requests at once can't both squeeze past it.
  let res;
  try {
    res = await d.prepare(`INSERT INTO api_keys (id_hash, user_id, name, prefix, created_at, nonce)
      SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM api_keys WHERE user_id = ?) < ?`)
      .bind(idHash, userId, name, key.slice(0, 8), now(), nonce, userId, MAX_KEYS).run();
  } catch (e) {
    if (/unique/i.test(String(e?.message))) throw again;
    throw e;
  }
  if (!res.meta.changes) throw new AuthError(`You can have at most ${MAX_KEYS} keys. Revoke one first.`);
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

// { user_id, id_hash, last_used } for a key someone sent, or null.
export async function findKey(env, token) {
  if (!FORMAT.test(String(token ?? ""))) return null;
  const idHash = await sha256(token);
  const row = await (await db(env)).prepare("SELECT user_id, id_hash, last_used FROM api_keys WHERE id_hash = ?").bind(idHash).first();
  return row || null;
}

// Records that the key was just used, at most every TOUCH_EVERY seconds.
export async function touchKey(env, key) {
  const t = now();
  if (key.last_used && t - key.last_used < TOUCH_EVERY) return;
  await (await db(env)).prepare("UPDATE api_keys SET last_used = ? WHERE id_hash = ?").bind(t, key.id_hash).run();
}
