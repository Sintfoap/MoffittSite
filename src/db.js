// The site's D1 database (binding TODO_DB). Tables are created on first use,
// so a fresh database needs no manual setup.

const SCHEMA = [
  // Drift: each user's collections and items (src/drift.js). data is JSON.
  `CREATE TABLE IF NOT EXISTS drift_collections (
     owner   TEXT NOT NULL,          -- user id
     id      TEXT NOT NULL,          -- "c_" + random hex
     data    TEXT NOT NULL,
     updated TEXT NOT NULL,
     rev     INTEGER NOT NULL DEFAULT 0,   -- counts edits, for the sync check
     PRIMARY KEY (owner, id)
   )`,
  `CREATE TABLE IF NOT EXISTS drift_items (
     owner   TEXT NOT NULL,          -- user id
     id      TEXT NOT NULL,          -- "i_" + random hex ("t_" for tasks brought over from todo_tasks)
     data    TEXT NOT NULL,
     updated TEXT NOT NULL,
     rev     INTEGER NOT NULL DEFAULT 0,   -- counts edits, for the sync check
     PRIMARY KEY (owner, id)
   )`,
  // Drift collections shared with other accounts. Items stay stored under the
  // collection's owner; role "edit" can add and change items, "view" only reads.
  `CREATE TABLE IF NOT EXISTS drift_shares (
     owner      TEXT NOT NULL,       -- the collection's owner (user id)
     collection TEXT NOT NULL,       -- collection id
     user_id    TEXT NOT NULL,       -- who it's shared with
     role       TEXT NOT NULL,       -- "edit" or "view"
     created_at INTEGER NOT NULL,
     rev        INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (owner, collection, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS drift_shares_user ON drift_shares (user_id)`,
  // The old todo list. Rows move into drift_items the next time their owner
  // opens Drift; rows whose owner isn't an account wait here for an admin.
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
     created_at        INTEGER NOT NULL,
     email             TEXT,                       -- optional, lowercase; for password resets
     email_verified    INTEGER NOT NULL DEFAULT 0  -- 1 once the link sent to it was opened
   )`,
  `CREATE TABLE IF NOT EXISTS user_areas (
     user_id TEXT NOT NULL,
     area    TEXT NOT NULL,                        -- an app's area (APPS in src/auth.js), e.g. "todo", "chat", "admin"
     PRIMARY KEY (user_id, area)
   )`,
  // Areas split off from an older one, recorded once their accounts were copied over.
  `CREATE TABLE IF NOT EXISTS area_splits (
     area     TEXT PRIMARY KEY,
     split_at INTEGER NOT NULL
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
  `CREATE TABLE IF NOT EXISTS email_tokens (
     token_hash TEXT PRIMARY KEY,                  -- SHA-256 of the token in the emailed link
     user_id    TEXT NOT NULL,
     purpose    TEXT NOT NULL,                     -- "verify" or "reset"
     email      TEXT NOT NULL,                     -- the address it was sent to
     expires_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS auth_limits (
     key          TEXT PRIMARY KEY,                -- "user:<name>", "ip:<addr>", "signup:<addr>"
     failures     INTEGER NOT NULL,
     window_start INTEGER NOT NULL,
     locked_until INTEGER NOT NULL DEFAULT 0
   )`,
  // Terminal sign-ins waiting for someone to approve them in a browser (src/cli.js).
  `CREATE TABLE IF NOT EXISTS cli_logins (
     code_hash  TEXT PRIMARY KEY,                  -- SHA-256 of the code the terminal polls with
     user_code  TEXT NOT NULL,                     -- the short code shown in the terminal, e.g. "KQ7M-4TXP"
     status     TEXT NOT NULL,                     -- "pending", "approved" or "denied"
     user_id    TEXT,                              -- who approved it
     name       TEXT NOT NULL,                     -- the computer's name, as the terminal sent it
     ip         TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  // API keys people give to AI agents for the MCP server (src/apikeys.js, src/mcp.js).
  `CREATE TABLE IF NOT EXISTS api_keys (
     id_hash    TEXT PRIMARY KEY,                  -- SHA-256 of the key
     user_id    TEXT NOT NULL,
     name       TEXT NOT NULL,                     -- what the person called it
     prefix     TEXT NOT NULL,                     -- the key's first characters, to recognise it
     created_at INTEGER NOT NULL,
     last_used  INTEGER,
     nonce      TEXT                               -- from the form that made it, so a resubmitted form makes no second key
   )`,
  `CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys (user_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS api_keys_nonce ON api_keys (user_id, nonce) WHERE nonce IS NOT NULL`,
  // The plugin store (src/store.js): shared Drift plugins and their reviewed versions.
  `CREATE TABLE IF NOT EXISTS store_plugins (
     id         TEXT PRIMARY KEY,                  -- lowercase letters; also its key in Drift's item.meta
     owner      TEXT NOT NULL,                     -- user id of the author
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS store_versions (
     plugin_id   TEXT NOT NULL,
     version     INTEGER NOT NULL,                 -- 1, 2, 3, …
     status      TEXT NOT NULL,                    -- "draft", "pending", "approved" or "rejected"
     name        TEXT NOT NULL,
     description TEXT NOT NULL,
     code        TEXT NOT NULL,
     note        TEXT,                             -- the author's note to the reviewer
     review_note TEXT,                             -- the reviewer's reason
     reviewed_by TEXT,                             -- user id
     created_at  INTEGER NOT NULL,                 -- saved, or submitted once pending
     reviewed_at INTEGER,
     PRIMARY KEY (plugin_id, version)
   )`,
  // Store plugins each account has added to Drift.
  `CREATE TABLE IF NOT EXISTS drift_installs (
     owner        TEXT NOT NULL,                   -- user id
     plugin_id    TEXT NOT NULL,
     installed_at INTEGER NOT NULL,
     PRIMARY KEY (owner, plugin_id)
   )`,
  // Chat (src/chat.js). Every change in a room (a new, edited or deleted
  // message, or a reaction) takes the room's next seq, so a client asking
  // "since N" sees all of them.
  `CREATE TABLE IF NOT EXISTS chat_rooms (
     id         TEXT PRIMARY KEY,                  -- "r_" + random hex
     name       TEXT NOT NULL,
     topic      TEXT NOT NULL DEFAULT '',
     owner      TEXT NOT NULL,                     -- user id of whoever made it
     seq        INTEGER NOT NULL DEFAULT 0,        -- last change number in this room
     created_at INTEGER NOT NULL,
     last_at    INTEGER NOT NULL,                  -- newest message (or creation), for sorting
     kind       TEXT NOT NULL DEFAULT 'open',      -- open (anyone), private (members only), dm (two people) or bridge (below)
     -- A bridge room is a room on another platform, seen through one of its
     -- owner's connections; only that owner is in it.
     connection TEXT,                              -- chat_connections.id
     ext_id     TEXT,                              -- the room's id there
     encrypted  INTEGER NOT NULL DEFAULT 0,        -- end-to-end encrypted there, so read-only here
     ext_typing TEXT,                              -- JSON [names]: who's typing there, as of ext_typing_at
     ext_typing_at INTEGER,
     ext_read   TEXT,                              -- the message there we last said we'd read up to
     ext_back   TEXT,                              -- where older history there starts ('' once it's all here)
     ext_invite TEXT                               -- JSON {by}: you're invited there and haven't joined yet
   )`,
  `CREATE TABLE IF NOT EXISTS chat_members (
     room      TEXT NOT NULL,
     user_id   TEXT NOT NULL,
     joined_at INTEGER NOT NULL,
     read_seq  INTEGER NOT NULL DEFAULT 0,         -- how far they've read, for unread counts
     PRIMARY KEY (room, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS chat_members_user ON chat_members (user_id)`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
     id         INTEGER PRIMARY KEY AUTOINCREMENT, -- also the order messages are shown in
     room       TEXT NOT NULL,
     user_id    TEXT NOT NULL,
     body       TEXT NOT NULL,                     -- '' once deleted
     deleted    INTEGER NOT NULL DEFAULT 0,
     seq        INTEGER NOT NULL,                  -- the room's seq when this row last changed
     created_at INTEGER NOT NULL,
     posted_seq INTEGER,                           -- the room's seq when it was posted, for unread counts
     edited_at  INTEGER,
     -- Messages in bridge rooms. user_id is the owner for their own messages
     -- and '' for everyone else's, who are named by ext_sender and ext_name.
     ext_id     TEXT,                              -- the message's id there
     ext_sender TEXT,
     ext_name   TEXT,
     encrypted  INTEGER NOT NULL DEFAULT 0,        -- arrived encrypted, so body is only a note saying so
     ext_raw    TEXT,                              -- an encrypted message as it came (its latest edit), for the browser with the keys
     reply_to   INTEGER,                           -- the message this one answers, if it's a reply
     ext_media  TEXT                               -- a picture it carries, as JSON {mxc, mimetype, width, height, name}
   )`,
  `CREATE INDEX IF NOT EXISTS chat_messages_room ON chat_messages (room, id)`,
  `CREATE INDEX IF NOT EXISTS chat_messages_seq ON chat_messages (room, seq)`,
  `CREATE INDEX IF NOT EXISTS chat_messages_user ON chat_messages (user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS chat_reactions (
     message    INTEGER NOT NULL,
     user_id    TEXT NOT NULL,
     emoji      TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     -- Reactions in bridge rooms: the reaction's id there, and who it's from.
     -- user_id is the owner's for their own, and "~" + their id there for others'.
     ext_id     TEXT,
     ext_name   TEXT,
     PRIMARY KEY (message, user_id, emoji)
   )`,
  `CREATE INDEX IF NOT EXISTS chat_reactions_user ON chat_reactions (user_id)`,
  // Who a message @mentions, so a room can say "you were mentioned".
  `CREATE TABLE IF NOT EXISTS chat_mentions (
     message INTEGER NOT NULL,
     user_id TEXT NOT NULL,
     PRIMARY KEY (message, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS chat_mentions_user ON chat_mentions (user_id, message)`,
  // When someone last had a room open, and last typed in it: "who's here" and "typing…".
  `CREATE TABLE IF NOT EXISTS chat_presence (
     room      TEXT NOT NULL,
     user_id   TEXT NOT NULL,
     seen_at   INTEGER NOT NULL DEFAULT 0,
     typing_at INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (room, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS chat_presence_user ON chat_presence (user_id, seen_at)`,
  // How far people on another platform have read a bridge room ("Seen by").
  `CREATE TABLE IF NOT EXISTS chat_ext_reads (
     room     TEXT NOT NULL,
     ext_user TEXT NOT NULL,                       -- their id there
     ext_name TEXT NOT NULL,
     ext_id   TEXT NOT NULL,                       -- the event there they've read up to
     at       INTEGER NOT NULL,
     PRIMARY KEY (room, ext_user)
   )`,
  // Each account's starred GIFs for the chat GIF picker (src/gifs.js).
  `CREATE TABLE IF NOT EXISTS chat_gif_favorites (
     user_id  TEXT NOT NULL,
     url      TEXT NOT NULL,                       -- the GIF that's sent
     preview  TEXT NOT NULL,                       -- a smaller one for the picker
     width    INTEGER,
     height   INTEGER,
     title    TEXT NOT NULL DEFAULT '',
     added_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, url)
   )`,
  // Push notifications (src/notify.js). A device is one browser's push
  // subscription; it belongs to whoever turned notifications on in it last.
  `CREATE TABLE IF NOT EXISTS push_devices (
     id         TEXT PRIMARY KEY,                  -- first 32 hex of SHA-256 of the endpoint
     user_id    TEXT NOT NULL,
     endpoint   TEXT NOT NULL,                     -- the push service's address for this browser
     p256dh     TEXT NOT NULL,                     -- the browser's keys (base64url)
     auth       TEXT NOT NULL,
     label      TEXT NOT NULL DEFAULT '',          -- e.g. "Chrome on Android"
     created_at INTEGER NOT NULL,
     last_ok    INTEGER,                           -- last push the service accepted
     failures   INTEGER NOT NULL DEFAULT 0         -- refusals in a row; dropped after a few
   )`,
  `CREATE INDEX IF NOT EXISTS push_devices_user ON push_devices (user_id)`,
  // What each person wants pushed. No row means the defaults in src/notify.js.
  `CREATE TABLE IF NOT EXISTS push_prefs (
     user_id       TEXT PRIMARY KEY,
     chat_dms      INTEGER NOT NULL,
     chat_mentions INTEGER NOT NULL,
     chat_rooms    INTEGER NOT NULL,               -- every message in rooms they've joined
     drift_events  INTEGER NOT NULL,
     drift_lead    INTEGER NOT NULL,               -- minutes before a timed event
     chat_bridges  INTEGER NOT NULL DEFAULT 1,     -- messages from connected platforms (Matrix)
     tz            TEXT NOT NULL,                  -- their time zone, for Drift's local times
     updated_at    INTEGER NOT NULL
   )`,
  // Drift reminders already sent, so the cron never sends one twice.
  `CREATE TABLE IF NOT EXISTS push_sent (
     user_id TEXT NOT NULL,
     key     TEXT NOT NULL,                        -- the item, its start and the lead time
     sent_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, key)
   )`,
  // Accounts on other chat platforms that someone connected (src/bridges.js).
  `CREATE TABLE IF NOT EXISTS chat_connections (
     id         TEXT PRIMARY KEY,                  -- "k_" + random hex
     user_id    TEXT NOT NULL,
     provider   TEXT NOT NULL,                     -- "matrix", …
     label      TEXT NOT NULL,                     -- who it is there, e.g. "@ryan:matrix.org"
     secret     TEXT NOT NULL,                     -- the credentials, sealed with CHAT_BRIDGE_KEY (crypto.js seal)
     cursor     TEXT,                              -- where the last sync got to (Matrix: next_batch)
     status     TEXT NOT NULL DEFAULT 'ok',        -- "ok" or "error"
     error      TEXT,
     created_at INTEGER NOT NULL,
     synced_at  INTEGER NOT NULL DEFAULT 0,        -- last sync that worked
     tried_at   INTEGER NOT NULL DEFAULT 0,        -- last sync started, so they don't pile up
     -- End-to-end encryption, whose keys only a browser holds (public/chat/e2ee.js).
     can_encrypt   INTEGER NOT NULL DEFAULT 0,     -- the connection has a session of its own to hold keys
     crypto_owner  TEXT,                           -- sha256 of the key the browser holding them proves itself with
     crypto_counts TEXT,                           -- JSON: the latest one-time key counts, for that browser
     pusher_at     INTEGER NOT NULL DEFAULT 0,     -- when its pusher was registered on the platform (src/notify.js), 0 = none
     -- So the keys follow their owner to any of their browsers (public/chat/carry.js).
     crypto_vault    TEXT,                         -- the browser key that opens the keys, sealed with CHAT_BRIDGE_KEY
     crypto_saved_at INTEGER NOT NULL DEFAULT 0,   -- when the browser holding them last sent a copy (chat_crypto_copies)
     crypto_seen_at  INTEGER NOT NULL DEFAULT 0    -- when that browser last asked for anything, so another doesn't take them mid-use
   )`,
  `CREATE INDEX IF NOT EXISTS chat_connections_user ON chat_connections (user_id)`,
  // What each sync brought for the browser holding a connection's keys
  // (to-device messages, changed device lists), until it has taken them.
  `CREATE TABLE IF NOT EXISTS chat_crypto_inbox (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     connection TEXT NOT NULL,
     data       TEXT NOT NULL,                     -- JSON {to_device, changed, left}
     created_at INTEGER NOT NULL,
     taken      INTEGER NOT NULL DEFAULT 0         -- handed to that browser; kept till a copy of the keys has it
   )`,
  `CREATE INDEX IF NOT EXISTS chat_crypto_inbox_conn ON chat_crypto_inbox (connection, id)`,
  // The latest copy of a connection's keys, as the browser holding them sent
  // it, for whichever of its owner's browsers takes them next. Sealed with
  // CHAT_BRIDGE_KEY, in parts that each fit in a row.
  `CREATE TABLE IF NOT EXISTS chat_crypto_copies (
     connection TEXT NOT NULL,
     part       INTEGER NOT NULL,
     data       TEXT NOT NULL,
     PRIMARY KEY (connection, part)
   )`,
  // Recipe box (src/recipes.js): each account's saved recipes. data is JSON.
  `CREATE TABLE IF NOT EXISTS recipes (
     owner   TEXT NOT NULL,          -- user id
     id      TEXT NOT NULL,          -- "r_" + random hex
     data    TEXT NOT NULL,
     updated TEXT NOT NULL,
     PRIMARY KEY (owner, id)
   )`,
  // Votes on the public book suggestions page (src/books.js). One per browser,
  // by the random id in its __Host-bv cookie; it can be changed or taken back.
  `CREATE TABLE IF NOT EXISTS book_votes (
     voter      TEXT PRIMARY KEY,                  -- 32 hex from the cookie
     book       TEXT NOT NULL,                     -- an id from BOOKS in src/books.js
     name       TEXT NOT NULL DEFAULT '',          -- what they typed as their name, if anything
     user_id    TEXT,                              -- their account, if they were signed in
     ip         TEXT NOT NULL,
     user_agent TEXT NOT NULL DEFAULT '',
     place      TEXT NOT NULL DEFAULT '',          -- Cloudflare's guess: city, region, country
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS book_votes_ip ON book_votes (ip, created_at)`,
  // Sweep (src/sweep.js): the chat rooms each account lets it read, and how far it has read them.
  `CREATE TABLE IF NOT EXISTS sweep_rooms (
     user_id  TEXT NOT NULL,
     room     TEXT NOT NULL,                       -- chat_rooms.id
     days     INTEGER NOT NULL,                    -- how far back the first sweep looks
     swept_to INTEGER NOT NULL DEFAULT 0,          -- the last chat_messages.id read
     swept_at INTEGER,
     added_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, room)
   )`,
  // What Sweep suggested, and what you said: waiting, accepted (item is the Drift item) or rejected.
  `CREATE TABLE IF NOT EXISTS sweep_suggestions (
     id         TEXT PRIMARY KEY,                  -- "s_" + random hex
     user_id    TEXT NOT NULL,
     room       TEXT NOT NULL,
     message    INTEGER NOT NULL,                  -- the chat_messages.id it came from
     status     TEXT NOT NULL,
     data       TEXT NOT NULL,                     -- JSON {kind, title, start, end, collection, quote, why, confidence, ...}
     reason     TEXT NOT NULL DEFAULT '',          -- why it was rejected, if they said
     item       TEXT,
     created_at INTEGER NOT NULL,
     decided_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS sweep_suggestions_user ON sweep_suggestions (user_id, status, created_at)`,
  // When each account last swept, so sweeps can't be fired off back to back.
  `CREATE TABLE IF NOT EXISTS sweep_runs (
     user_id  TEXT PRIMARY KEY,
     swept_at INTEGER NOT NULL
   )`,
  // Each account's own Anthropic API key, sealed under CHAT_BRIDGE_KEY, so
  // every sweep is billed to the person who asked for it. hint is its last 4.
  `CREATE TABLE IF NOT EXISTS sweep_keys (
     user_id  TEXT PRIMARY KEY,
     secret   TEXT NOT NULL,
     hint     TEXT NOT NULL,
     added_at INTEGER NOT NULL
   )`,
  // Trip planner (src/trips.js): trips, who's going on each, and what's in them.
  `CREATE TABLE IF NOT EXISTS trips (
     id      TEXT PRIMARY KEY,                     -- "t_" + random hex
     owner   TEXT NOT NULL,                        -- user id of whoever made it
     data    TEXT NOT NULL,                        -- JSON {title, start, end, notes, created}
     updated TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS trip_members (
     trip     TEXT NOT NULL,
     user_id  TEXT NOT NULL,                       -- planning it with the owner, with the same say
     added_at INTEGER NOT NULL,
     PRIMARY KEY (trip, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS trip_members_user ON trip_members (user_id)`,
  // A trip's itinerary stops, pinned places and packing list, a row each so
  // two people editing at once don't overwrite each other.
  `CREATE TABLE IF NOT EXISTS trip_entries (
     trip    TEXT NOT NULL,
     id      TEXT NOT NULL,                        -- "e_" + random hex
     kind    TEXT NOT NULL,                        -- plan | place | pack
     data    TEXT NOT NULL,                        -- JSON, by kind (src/trips.js)
     created TEXT NOT NULL,
     PRIMARY KEY (trip, id)
   )`,
];

// Indexes on columns that ADDED_COLUMNS may have only just added.
const AFTER_COLUMNS = [
  `CREATE INDEX IF NOT EXISTS chat_rooms_bridge ON chat_rooms (connection, ext_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_ext ON chat_messages (room, ext_id) WHERE ext_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS chat_reactions_ext ON chat_reactions (ext_id) WHERE ext_id IS NOT NULL`,
];

// Columns added after a table first shipped. CREATE TABLE IF NOT EXISTS
// leaves an existing table alone, so older databases get them here.
const ADDED_COLUMNS = {
  users: ["email TEXT", "email_verified INTEGER NOT NULL DEFAULT 0"],
  chat_messages: ["posted_seq INTEGER", "edited_at INTEGER", "ext_id TEXT", "ext_sender TEXT", "ext_name TEXT", "encrypted INTEGER NOT NULL DEFAULT 0", "ext_raw TEXT", "reply_to INTEGER", "ext_media TEXT"],
  chat_reactions: ["ext_id TEXT", "ext_name TEXT"],
  chat_connections: ["can_encrypt INTEGER NOT NULL DEFAULT 0", "crypto_owner TEXT", "crypto_counts TEXT", "pusher_at INTEGER NOT NULL DEFAULT 0",
    "crypto_vault TEXT", "crypto_saved_at INTEGER NOT NULL DEFAULT 0", "crypto_seen_at INTEGER NOT NULL DEFAULT 0"],
  chat_crypto_inbox: ["taken INTEGER NOT NULL DEFAULT 0"],
  push_prefs: ["chat_bridges INTEGER NOT NULL DEFAULT 1"],
  chat_rooms: ["kind TEXT NOT NULL DEFAULT 'open'", "connection TEXT", "ext_id TEXT", "encrypted INTEGER NOT NULL DEFAULT 0", "ext_typing TEXT", "ext_typing_at INTEGER", "ext_read TEXT", "ext_back TEXT", "ext_invite TEXT"],
};

async function addMissingColumns(d) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const { results } = await d.prepare(`PRAGMA table_info(${table})`).all();
    const have = new Set(results.map(c => c.name));
    for (const col of columns) {
      if (have.has(col.split(" ")[0])) continue;
      // Another Worker instance may add it at the same moment; that's fine.
      try { await d.prepare(`ALTER TABLE ${table} ADD COLUMN ${col}`).run(); }
      catch (e) { if (!/duplicate column/i.test(String(e?.message))) throw e; }
    }
  }
}

// The plugin store and chat used to come with Drift's "todo" area. Now each is
// its own app with its own toggle on the admin page, so once (per database)
// everyone who had "todo" is given them, and nobody loses access. Admins can
// then turn them off; this never runs again for that area, so it won't undo that.
// Apps added from now on start off for everyone and need nothing here.
const SPLIT_FROM_TODO = ["plugins", "chat"];

async function splitAreas(d) {
  await d.batch(SPLIT_FROM_TODO.flatMap(area => [
    d.prepare(`INSERT OR IGNORE INTO user_areas (user_id, area)
      SELECT user_id, ? FROM user_areas WHERE area = 'todo' AND NOT EXISTS (SELECT 1 FROM area_splits WHERE area = ?)`).bind(area, area),
    d.prepare("INSERT OR IGNORE INTO area_splits (area, split_at) VALUES (?, ?)").bind(area, now()),
  ]));
}

const ready = new WeakMap();   // per database binding, once per Worker instance

export function db(env) {
  const d = env.TODO_DB;
  if (!d) throw new Error("D1 binding TODO_DB is not configured");
  if (!ready.has(d)) {
    ready.set(d, d.batch(SCHEMA.map(s => d.prepare(s))).then(() => addMissingColumns(d))
      .then(() => d.batch(AFTER_COLUMNS.map(s => d.prepare(s)))).then(() => splitAreas(d)).catch(e => { ready.delete(d); throw e; }));
  }
  return ready.get(d).then(() => d);
}

export const now = () => Math.floor(Date.now() / 1000);
