// Notifications: push messages for Chat and Drift that people opt into.
//
// Nothing is sent to anyone who hasn't turned notifications on in a browser
// (a "device", one push subscription each) from /notifications/. The app
// itself is one of APPS, so an admin turns it on per account like any other,
// and it starts off. Chat pushes also need Chat, and Drift reminders need Drift.
//
// What gets pushed (each a setting, see DEFAULTS):
//   Chat   a direct message, an @mention of you, or (off by default) any new
//          message in a room you've joined. Not while you have that room open.
//   Chat connections  a message in a room from another platform (Matrix)
//          that your notification settings there say is worth one. The
//          platform tells the site (a pusher, see src/bridges.js); with no
//          pusher, the cron's syncs push what they bring in. Encrypted
//          messages say only who sent them: their keys are in your browser.
//   Drift  a reminder before a timed item starts (drift_lead minutes), and at
//          8am on the day of an all-day one. Done and deleted items don't
//          remind. Times are read in your time zone, which the page sends.
//
// Chat pushes go out when the message is posted; Drift reminders, and the
// syncs and pusher upkeep for connections, come from a cron trigger every
// five minutes (scheduled() in src/worker.js).

import { db, now } from "./db.js";
import { sameOrigin } from "./account.js";
import { withRail } from "./pages.js";
import { sha256, fromB64url } from "./crypto.js";
import { configured, pushEndpoint, send } from "./push.js";
import { BRIDGE_AREA, bridgeReady, syncConnection, connectionForPushKey, setPusher, dropPusher } from "./bridges.js";

export class BadRequest extends Error {}
const fail = msg => { throw new BadRequest(msg); };

export const DEFAULTS = { chat_dms: true, chat_mentions: true, chat_rooms: false, chat_bridges: true, drift_events: true, drift_lead: 15, tz: "UTC" };
// Minutes before a timed Drift item that its reminder can come.
export const LEADS = [0, 5, 10, 15, 30, 60, 1440];
const FLAGS = ["chat_dms", "chat_mentions", "chat_rooms", "chat_bridges", "drift_events"];
const MAX_DEVICES = 10;
const DROP_AFTER = 5;           // refusals in a row before a device is forgotten
const BODY = 180;               // characters of a message shown in its notification
const ALL_DAY_AT = "08:00";     // when an all-day item reminds, local time
const LATE = 15 * 60_000;       // a reminder the cron missed still goes out this late
const KEEP_SENT = 3 * 86400;    // seconds push_sent remembers a reminder

const isObj = v => v && typeof v === "object" && !Array.isArray(v);

async function readJson(request) {
  const text = await request.text();
  if (text.length > 8 * 1024) fail("request too large");
  if (!text) return {};
  try { return JSON.parse(text); } catch { fail("invalid JSON"); }
}

export function cleanTz(v) {
  const tz = String(v ?? "");
  if (!tz || tz.length > 64) return null;
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; } catch { return null; }
}

// ── settings ───────────────────────────────────────────────────────────────

const prefsOut = row => row
  ? { ...Object.fromEntries(FLAGS.map(f => [f, !!row[f]])), drift_lead: row.drift_lead, tz: row.tz }
  : { ...DEFAULTS };

async function getPrefs(d, userId) {
  return prefsOut(await d.prepare("SELECT * FROM push_prefs WHERE user_id = ?").bind(userId).first());
}

function putPrefs(d, userId, p) {
  return d.prepare(`INSERT INTO push_prefs (user_id, ${FLAGS.join(", ")}, drift_lead, tz, updated_at)
    VALUES (?, ${FLAGS.map(() => "?").join(", ")}, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
    ${[...FLAGS, "drift_lead", "tz", "updated_at"].map(f => `${f} = excluded.${f}`).join(", ")}`)
    .bind(userId, ...FLAGS.map(f => p[f] ? 1 : 0), p.drift_lead, p.tz, now());
}

export async function savePrefs(env, user, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  const d = await db(env);
  const p = await getPrefs(d, user.id);
  for (const [k, v] of Object.entries(body)) {
    if (FLAGS.includes(k)) {
      if (typeof v !== "boolean") fail(`${k} must be true or false`);
      p[k] = v;
    } else if (k === "drift_lead") {
      if (!LEADS.includes(v)) fail(`drift_lead must be one of ${LEADS.join(", ")}`);
      p[k] = v;
    } else if (k === "tz") {
      p.tz = cleanTz(v) || fail("unknown time zone");
    } else fail(`unknown field ${JSON.stringify(k)}`);
  }
  await putPrefs(d, user.id, p).run();
  return state(env, user);
}

async function devicesOf(d, userId) {
  const { results } = await d.prepare("SELECT id, label, created_at, last_ok FROM push_devices WHERE user_id = ? ORDER BY created_at")
    .bind(userId).all();
  return results;
}

// Everything the page (and the terminal's page) shows.
export async function state(env, user) {
  const d = await db(env);
  return {
    configured: configured(env),
    public_key: configured(env) ? env.VAPID_PUBLIC_KEY : null,
    prefs: await getPrefs(d, user.id),
    devices: await devicesOf(d, user.id),
    apps: { chat: user.areas.has("chat"), drift: user.areas.has("todo"), bridges: user.areas.has("chat") && user.areas.has(BRIDGE_AREA) },
    leads: LEADS,
  };
}

const deviceId = async endpoint => (await sha256("push:" + endpoint)).slice(0, 32);

function keyOf(v, len, what) {
  let b;
  try { b = fromB64url(String(v ?? "")); } catch { fail(`${what} isn't valid`); }
  if (b.length !== len) fail(`${what} isn't valid`);
  return String(v).replace(/=+$/, "");
}

// The browser's subscription, as PushSubscription.toJSON() gives it, plus a
// label for the list and the browser's time zone. Turning notifications on in
// a browser someone else used takes it over: it's yours from now on.
export async function addDevice(env, user, body) {
  if (!configured(env)) fail("push notifications aren't set up on this site yet");
  if (!isObj(body) || !isObj(body.keys)) fail("send the browser's push subscription");
  const endpoint = pushEndpoint(body.endpoint) || fail("that push service isn't one this site sends to");
  const p256dh = keyOf(body.keys.p256dh, 65, "p256dh"), auth = keyOf(body.keys.auth, 16, "auth");
  const label = String(body.label ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60) || "A browser";
  const tz = body.tz === undefined ? null : cleanTz(body.tz) || fail("unknown time zone");
  const d = await db(env);
  const id = await deviceId(endpoint);
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM push_devices WHERE user_id = ? AND id != ?").bind(user.id, id).first();
  if (n >= MAX_DEVICES) fail(`you can have notifications on in at most ${MAX_DEVICES} browsers; remove one first`);
  const p = await getPrefs(d, user.id);
  if (tz) p.tz = tz;
  await d.batch([
    d.prepare(`INSERT INTO push_devices (id, user_id, endpoint, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
      label = excluded.label, failures = 0`).bind(id, user.id, endpoint, p256dh, auth, label, now()),
    putPrefs(d, user.id, p),
  ]);
  return { ...await state(env, user), device: id };
}

export async function removeDevice(env, user, id) {
  const d = await db(env);
  const res = await d.prepare("DELETE FROM push_devices WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  return res.meta.changes ? state(env, user) : null;
}

export async function test(env, user) {
  if (!configured(env)) fail("push notifications aren't set up on this site yet");
  const d = await db(env);
  const out = await deliver(env, d, [user.id], { title: "Notifications are on", body: "This is what they'll look like.", url: "/notifications/", tag: "test" });
  return { ...await state(env, user), ...out };
}

// ── sending ────────────────────────────────────────────────────────────────

// The people in `ids` who can be pushed to about `area` ("chat" or "todo"):
// enabled accounts with Notifications and that app, and at least one device.
// Each comes with their settings.
async function reachable(d, ids, area) {
  if (!ids.length) return [];
  const has = a => `EXISTS (SELECT 1 FROM user_areas a WHERE a.user_id = u.id AND a.area = '${a}')`;
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    const { results } = await d.prepare(`SELECT u.id, p.* FROM users u LEFT JOIN push_prefs p ON p.user_id = u.id
      WHERE u.id IN (${part.map(() => "?").join(", ")}) AND u.disabled = 0 AND ${has("notifications")} AND ${has(area)}
      AND EXISTS (SELECT 1 FROM push_devices x WHERE x.user_id = u.id)`).bind(...part).all();
    out.push(...results.map(r => ({ id: r.id, ...prefsOut(r.user_id ? r : null) })));
  }
  return out;
}

// Sends one message to every device of these people. Devices whose push
// service says they're gone are forgotten, and so are ones refused too often.
async function deliver(env, d, userIds, message, opts = {}) {
  if (!userIds.length) return { sent: 0, failed: 0 };
  const { results: devices } = await d.prepare(`SELECT * FROM push_devices WHERE user_id IN (${userIds.map(() => "?").join(", ")})`)
    .bind(...userIds).all();
  const results = await Promise.all(devices.map(dev => send(env, dev, message, opts).catch(e => { console.error("push failed:", e); return 0; })));
  const t = now(), stmts = [];
  let sent = 0;
  results.forEach((status, i) => {
    const id = devices[i].id;
    if (status >= 200 && status < 300) { sent++; stmts.push(d.prepare("UPDATE push_devices SET last_ok = ?, failures = 0 WHERE id = ?").bind(t, id)); }
    else if (status === 404 || status === 410 || devices[i].failures + 1 >= DROP_AFTER) stmts.push(d.prepare("DELETE FROM push_devices WHERE id = ?").bind(id));
    else stmts.push(d.prepare("UPDATE push_devices SET failures = failures + 1 WHERE id = ?").bind(id));
  });
  if (stmts.length) await d.batch(stmts);
  return { sent, failed: devices.length - sent };
}

const clip = s => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > BODY ? s.slice(0, BODY - 1) + "…" : s; };

// After a message is posted: members of the room (DMs, or every message if
// they asked), and anyone it mentions who can see the room. Nobody who's had
// the room open since `hereSince` (they're reading it) or who wrote it.
export async function chatPushes(env, { room, author, message, hereSince }) {
  if (!configured(env)) return;
  const d = await db(env);
  const ids = async (sql, ...binds) => (await d.prepare(sql).bind(...binds).all()).results.map(r => r.user_id);
  const members = new Set(await ids("SELECT user_id FROM chat_members WHERE room = ?", room.id));
  const mentioned = new Set(await ids("SELECT user_id FROM chat_mentions WHERE message = ?", message.id));
  const here = new Set(await ids("SELECT user_id FROM chat_presence WHERE room = ? AND seen_at > ?", room.id, hereSince));
  // Only members can see a private room or DM, so only they are told about it.
  if (room.kind !== "open") for (const id of mentioned) if (!members.has(id)) mentioned.delete(id);
  const candidates = [...new Set([...members, ...mentioned])].filter(id => id !== author.id && !here.has(id));

  const who = author.display_name || author.username, text = clip(message.body);
  const where = room.kind === "dm" ? who : `#${room.name}`;
  const base = { url: `/chat/#${room.id}`, tag: `chat-${room.id}` };
  const kinds = {
    mention: { ...base, title: `${who} mentioned you in ${room.kind === "dm" ? "a message" : where}`, body: text },
    dm: { ...base, title: who, body: text },
    room: { ...base, title: where, body: `${who}: ${text}` },
  };
  const groups = { mention: [], dm: [], room: [] };
  for (const p of await reachable(d, candidates, "chat")) {
    if (mentioned.has(p.id) && p.chat_mentions) groups.mention.push(p.id);
    else if (!members.has(p.id)) continue;
    else if (room.kind === "dm" ? p.chat_dms : p.chat_rooms) groups[room.kind === "dm" ? "dm" : "room"].push(p.id);
  }
  await Promise.all(Object.entries(groups).map(([k, list]) => deliver(env, d, list, kinds[k], { urgency: "high", ttl: 3600 })));
}

// ── messages from connected platforms ──────────────────────────────────────

// Pushes these new messages from a connection's rooms to its owner, if they
// want them and don't have the room open. Each message at most once.
async function bridgePushes(env, d, conn, news) {
  if (!news.length) return 0;
  const [p] = await reachable(d, [conn.user_id], BRIDGE_AREA);
  if (!p?.chat_bridges) return 0;
  const { results: open } = await d.prepare("SELECT room FROM chat_presence WHERE user_id = ? AND seen_at > ?").bind(conn.user_id, now() - 30).all();
  const here = new Set(open.map(r => r.room));
  const byRoom = new Map();
  for (const m of news) {
    if (here.has(m.room.id)) continue;
    const claim = await d.prepare("INSERT OR IGNORE INTO push_sent (user_id, key, sent_at) VALUES (?, ?, ?)")
      .bind(conn.user_id, `bridge:${m.room.id}:${m.id}`, now()).run();
    if (!claim.meta.changes) continue;
    if (!byRoom.has(m.room.id)) byRoom.set(m.room.id, []);
    byRoom.get(m.room.id).push(m);
  }
  let sent = 0;
  // One notification per room: the latest message, and how many came.
  for (const list of byRoom.values()) {
    const m = list.at(-1), room = m.room.name || m.sender_name;
    const text = m.encrypted ? "sent an encrypted message" : clip(m.body);
    const line = room === m.sender_name ? (m.encrypted ? `${m.sender_name} ${text}` : text) : `${m.sender_name}${m.encrypted ? " " : ": "}${text}`;
    const body = list.length > 1 ? `${list.length} new messages. ${line}` : line;
    sent += (await deliver(env, d, [conn.user_id], { title: room, body, url: `/chat/#${m.room.id}`, tag: `chat-${m.room.id}` }, { urgency: "high", ttl: 3600 })).sent;
  }
  return sent;
}

// The message with this platform id in one of the connection's rooms, as bridgePushes takes it.
async function bridgedMessage(d, conn, extId) {
  const m = await d.prepare(`SELECT m.ext_id, m.ext_name, m.body, m.encrypted, m.user_id, r.id AS room_id, r.name AS room_name
    FROM chat_messages m JOIN chat_rooms r ON r.id = m.room WHERE r.connection = ? AND m.ext_id = ? AND m.deleted = 0`).bind(conn.id, extId).first();
  if (!m) return null;
  if (m.user_id === conn.user_id) return { mine: true };
  return { room: { id: m.room_id, name: m.room_name }, id: m.ext_id, sender_name: m.ext_name || "Someone", body: m.body, encrypted: !!m.encrypted };
}

// POST /_matrix/push/v1/notify: a homeserver telling a pusher about an event.
// Answered at once (with any keys it should forget); the sync and the push
// happen after, through `later`.
export async function pushGateway(request, env, later = p => p) {
  const json = obj => new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } });
  if (request.method !== "POST") return new Response(JSON.stringify({ errcode: "M_UNRECOGNIZED" }), { status: 405 });
  let body;
  try { body = JSON.parse((await request.text()).slice(0, 64 * 1024)); } catch { body = null; }
  const n = body?.notification;
  if (!n || !Array.isArray(n.devices)) return new Response(JSON.stringify({ errcode: "M_BAD_JSON" }), { status: 400 });
  const d = await db(env);
  const rejected = [], conns = [];
  for (const dev of n.devices.slice(0, 10)) {
    const conn = await connectionForPushKey(env, d, dev?.pushkey);
    if (conn && conn.pusher_at) conns.push(conn); else rejected.push(dev?.pushkey);
  }
  // No event: just an unread count changing. Nothing to show.
  if (typeof n.event_id === "string" && conns.length) {
    await later(Promise.all(conns.map(async conn => {
      await syncConnection(env, d, conn, { force: true });
      let m = await bridgedMessage(d, conn, n.event_id);
      // Another sync may be bringing it in at this moment.
      if (!m) { await new Promise(r => setTimeout(r, 1500)); m = await bridgedMessage(d, conn, n.event_id); }
      if (m && !m.mine) await bridgePushes(env, d, conn, [m]);
    })).catch(e => console.error("push gateway failed:", e)));
  }
  return json({ rejected });
}

// Run by the cron: keeps a pusher on every connection whose owner wants
// these notifications (and takes it off the others), and syncs them. A
// connection whose platform wouldn't take a pusher has what its sync brought
// pushed instead.
export async function bridgeUpkeep(env) {
  if (!configured(env) || !bridgeReady(env)) return 0;
  const d = await db(env);
  const { results: conns } = await d.prepare("SELECT * FROM chat_connections WHERE status = 'ok'").all();
  if (!conns.length) return 0;
  const want = new Set((await reachable(d, [...new Set(conns.map(c => c.user_id))], BRIDGE_AREA)).filter(p => p.chat_bridges).map(p => p.id));
  const url = new URL("/_matrix/push/v1/notify", env.SITE_URL || "https://sintfoap.xyz").href;
  let sent = 0;
  for (const conn of conns) {
    try {
      if (!want.has(conn.user_id)) {
        if (conn.pusher_at) await dropPusher(env, d, conn);
        continue;
      }
      if (!conn.pusher_at) {
        const why = await setPusher(env, d, conn, url);
        if (!why) conn.pusher_at = now();
      }
      const news = await syncConnection(env, d, conn);
      if (!conn.pusher_at) sent += await bridgePushes(env, d, conn, news);
    } catch (e) { console.error("connection upkeep failed:", e); }
  }
  return sent;
}

// ── Drift reminders ────────────────────────────────────────────────────────

const formats = new Map();
// How far `tz` is ahead of UTC at instant `t`, in ms.
function offsetAt(tz, t) {
  if (!formats.has(tz)) formats.set(tz, new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  const p = Object.fromEntries(formats.get(tz).formatToParts(new Date(t)).map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

// "YYYY-MM-DDTHH:MM" read as a wall-clock time in `tz` → ms since the epoch.
export function localToUtc(stamp, tz) {
  const [y, mo, day, h, mi] = stamp.split(/[-T:]/).map(Number);
  const guess = Date.UTC(y, mo - 1, day, h, mi);
  const first = guess - offsetAt(tz, guess);
  return guess - offsetAt(tz, first);
}

const clock = hm => { const [h, m] = hm.split(":").map(Number); return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "am" : "pm"}`; };
const dayOf = t => new Date(t).toISOString().slice(0, 10);

// When this person should hear about this item, and what to say.
function reminder(item, p) {
  const { start } = item.meta.event;
  if (start.includes("T")) {
    const at = localToUtc(start, p.tz), time = clock(start.slice(11, 16));
    const when = p.drift_lead === 0 ? `Starting now, ${time}`
      : p.drift_lead >= 1440 ? `Tomorrow at ${time}`
      : `At ${time}, in ${p.drift_lead >= 60 ? `${p.drift_lead / 60} hour${p.drift_lead > 60 ? "s" : ""}` : `${p.drift_lead} minutes`}`;
    return { at: at - p.drift_lead * 60_000, key: `${start}:${p.drift_lead}`, when };
  }
  return { at: localToUtc(`${start.slice(0, 10)}T${ALL_DAY_AT}`, p.tz), key: start.slice(0, 10), when: "Today" };
}

// Run by the cron: every reminder that's due, once each. Returns how many went out.
export async function driftReminders(env, at = Date.now()) {
  if (!configured(env)) return 0;
  const d = await db(env);
  await d.prepare("DELETE FROM push_sent WHERE sent_at < ?").bind(now() - KEEP_SENT).run();
  const { results: wanting } = await d.prepare("SELECT DISTINCT user_id FROM push_devices").all();
  const people = new Map((await reachable(d, wanting.map(r => r.user_id), "todo")).filter(p => p.drift_events).map(p => [p.id, p]));
  if (!people.size) return 0;

  // Open dated items starting within two days either side of now (time zones
  // and day-ahead reminders both reach that far), in live collections.
  const { results: rows } = await d.prepare(`SELECT i.owner, i.id, i.data, json_extract(c.data, '$.name') AS collection_name
    FROM drift_items i JOIN drift_collections c ON c.owner = i.owner AND c.id = json_extract(i.data, '$.collection')
    WHERE substr(json_extract(i.data, '$.meta.event.start'), 1, 10) BETWEEN ? AND ?
      AND json_extract(i.data, '$.deleted') IS NOT 1 AND json_extract(c.data, '$.deleted') IS NOT 1
      AND json_extract(i.data, '$.meta.checklist.done') IS NOT 1`).bind(dayOf(at - 2 * 86400_000), dayOf(at + 2 * 86400_000)).all();
  if (!rows.length) return 0;
  const { results: shares } = await d.prepare("SELECT owner, collection, user_id FROM drift_shares").all();
  const sharedWith = new Map();
  for (const s of shares) {
    const k = `${s.owner}:${s.collection}`;
    if (!sharedWith.has(k)) sharedWith.set(k, []);
    sharedWith.get(k).push(s.user_id);
  }

  let count = 0;
  for (const row of rows) {
    const item = JSON.parse(row.data);
    if (typeof item.meta?.event?.start !== "string") continue;
    const who = [row.owner, ...sharedWith.get(`${row.owner}:${item.collection}`) || []];
    for (const id of who) {
      const p = people.get(id);
      if (!p) continue;
      const r = reminder(item, p);
      if (!(r.at <= at && r.at > at - LATE)) continue;
      // Claim it first, so two overlapping cron runs can't both send it.
      const claim = await d.prepare("INSERT OR IGNORE INTO push_sent (user_id, key, sent_at) VALUES (?, ?, ?)")
        .bind(id, `${row.owner}:${row.id}:${r.key}`, now()).run();
      if (!claim.meta.changes) continue;
      const body = row.collection_name ? `${r.when} · ${row.collection_name}` : r.when;
      const out = await deliver(env, d, [id], { title: clip(item.title) || "Drift", body, url: "/todo/", tag: `drift-${row.id}` }, { ttl: 3600 });
      count += out.sent;
    }
  }
  return count;
}

// ── the page and its API ───────────────────────────────────────────────────

// The page asks the browser for permission and a subscription, so it needs
// to register /sw.js and read the site's manifest; nothing else from elsewhere.
const PAGE_CSP = [
  "default-src 'none'", "script-src 'self'", "connect-src 'self'", "worker-src 'self'", "manifest-src 'self'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com", "img-src 'self' data:",
  "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");

const ROUTE = /^\/notifications\/api\/(state|prefs|devices|test)(?:\/([0-9a-f]{32}))?\/?$/;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

// GET    /notifications/api/state          → {configured, public_key, prefs, devices, apps, leads}
// PATCH  /notifications/api/prefs          {chat_dms, chat_mentions, chat_rooms, drift_events, drift_lead, tz} (any of them)
// POST   /notifications/api/devices        {endpoint, keys: {p256dh, auth}, label, tz}: turn them on in this browser
// DELETE /notifications/api/devices/<id>   turn them off for one browser
// POST   /notifications/api/test           push "Notifications are on" to all your browsers → also {sent, failed}
export async function notifications(request, env, user, pathname) {
  if (!pathname.startsWith("/notifications/api/")) {
    const asset = await withRail(await env.ASSETS.fetch(request), user, "notifications");
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
    const [, kind, id] = m;
    const notAllowed = () => json({ error: "method not allowed" }, 405);
    if (id && kind !== "devices") return json({ error: "not found" }, 404);
    if (kind === "state") return method === "GET" ? json(await state(env, user)) : notAllowed();
    if (kind === "prefs") return method === "PATCH" || method === "POST" ? json(await savePrefs(env, user, await readJson(request))) : notAllowed();
    if (kind === "test") return method === "POST" ? json(await test(env, user)) : notAllowed();
    if (id) {
      if (method !== "DELETE") return notAllowed();
      const out = await removeDevice(env, user, id);
      return out ? json(out) : json({ error: "not found" }, 404);
    }
    return method === "POST" ? json(await addDevice(env, user, await readJson(request)), 201) : notAllowed();
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    console.error("notifications error:", e);
    return json({ error: "server error" }, 500);
  }
}
