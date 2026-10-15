// The site's D1 database (binding TODO_DB). Tables are created on first use,
// so a fresh database needs no manual setup.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS todo_tasks (
     owner   TEXT NOT NULL,          -- user id (older rows: the Access email)
     id      TEXT NOT NULL,
     data    TEXT NOT NULL,
     updated TEXT NOT NULL,
     PRIMARY KEY (owner, id)
   )`,
  `CREATE TABLE IF NOT EXISTS users (
     id                TEXT PRIMARY KEY,           -- "u_" + random hex; never changes
     username          TEXT NOT NULL UNIQUE,       -- lowercase
     display_name      TEXT NOT NULL,
     password_hash     TEXT NOT NULL,
     must_change_pw    INTEGER NOT NULL DEFAULT 0, -- set by an admin password reset
     totp_secret       TEXT,                       -- base32; NULL = two-factor off
     totp_pending      TEXT,                       -- secret being set up, not yet confirmed
     totp_last_step    INTEGER NOT NULL DEFAULT 0, -- last accepted code, to refuse replays
     disabled          INTEGER NOT NULL DEFAULT 0,
     created_at        INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS user_areas (
     user_id TEXT NOT NULL,
     area    TEXT NOT NULL,                        -- e.g. "todo", "admin"
     PRIMARY KEY (user_id, area)
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id_hash    TEXT PRIMARY KEY,                  -- SHA-256 of the cookie value
     user_id    TEXT NOT NULL,
     stage      TEXT NOT NULL,                     -- "full", or "mfa" while waiting for the code
     created_at INTEGER NOT NULL,
     last_seen  INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     user_agent TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)`,
  `CREATE TABLE IF NOT EXISTS recovery_codes (
     user_id   TEXT NOT NULL,
     code_hash TEXT NOT NULL,
     used_at   INTEGER,
     PRIMARY KEY (user_id, code_hash)
   )`,
  `CREATE TABLE IF NOT EXISTS auth_limits (
     key          TEXT PRIMARY KEY,                -- "user:<name>", "ip:<addr>", "signup:<addr>"
     failures     INTEGER NOT NULL,
     window_start INTEGER NOT NULL,
     locked_until INTEGER NOT NULL DEFAULT 0
   )`,
];

const ready = new WeakMap();   // per database binding, once per Worker instance

export function db(env) {
  const d = env.TODO_DB;
  if (!d) throw new Error("D1 binding TODO_DB is not configured");
  if (!ready.has(d)) ready.set(d, d.batch(SCHEMA.map(s => d.prepare(s))).catch(e => { ready.delete(d); throw e; }));
  return ready.get(d).then(() => d);
}

export const now = () => Math.floor(Date.now() / 1000);
