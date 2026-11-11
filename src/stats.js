// Admin stats (/admin/stats, and /admin/api/stats for the terminal): how many
// accounts there are against MAX_USERS, who's active, how much each person
// keeps in each app, and how much room they take up in D1 and R2.
//
// Storage is counted in bytes of the rows' stored text (LENGTH of the value as
// a blob), which is what fills the D1 database; the database's own size comes
// from D1 itself (meta.size_after). Pictures are counted where they are: a
// row whose `data` is still base64 is in D1; an emptied `data` means the
// picture is in R2 (src/photos.js names it "<table>/<id>"), and with the
// PHOTOS binding its size is read from the bucket's listing.

import { APPS } from "./auth.js";
import { now } from "./db.js";

const DAY = 86400;
// D1's database size limit: 500 MB on the Workers free plan, 10 GB on paid.
// Set D1_LIMIT_MB (a Text variable) to the plan's limit; free is assumed.
const D1_LIMIT_MB = 500;
// How many R2 listing pages (1000 objects each) to read before giving up.
const R2_PAGES = 50;

// What each person keeps, app by app. `rows` counts, `bytes` sums stored size;
// each query gives (u, n, bytes) per user id.
const B = col => `COALESCE(SUM(LENGTH(CAST(${col} AS BLOB))), 0)`;
export const COUNTS = [
  { id: "drift_items", app: "drift", label: "Drift items",
    sql: `SELECT owner AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM drift_items GROUP BY owner` },
  { id: "drift_collections", app: "drift", label: "Drift collections",
    sql: `SELECT owner AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM drift_collections GROUP BY owner` },
  { id: "todo_tasks", app: "drift", label: "Old todo tasks",
    sql: `SELECT owner AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM todo_tasks GROUP BY owner` },
  { id: "chat_messages", app: "chat", label: "Chat messages",
    sql: `SELECT user_id AS u, COUNT(*) AS n, ${B("body")} + ${B("ext_raw")} AS bytes FROM chat_messages WHERE user_id != '' GROUP BY user_id` },
  // Other people's messages in rooms brought in from Matrix, kept for the connection's owner.
  { id: "chat_bridged", app: "chat-bridges", label: "Bridged messages",
    sql: `SELECT r.owner AS u, COUNT(*) AS n, ${B("m.body")} + ${B("m.ext_raw")} AS bytes
      FROM chat_messages m JOIN chat_rooms r ON r.id = m.room WHERE m.user_id = '' AND r.kind = 'bridge' GROUP BY r.owner` },
  { id: "recipes", app: "recipes", label: "Recipes",
    sql: `SELECT owner AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM recipes GROUP BY owner` },
  { id: "meal_plans", app: "meals", label: "Meal plan weeks",
    sql: `SELECT owner AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM meal_plans GROUP BY owner` },
  { id: "pantry_items", app: "pantry", label: "Pantry items",
    sql: `SELECT owner AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM pantry_items GROUP BY owner` },
  { id: "pantry_products", app: "pantry", label: "Scanned barcodes",
    sql: `SELECT owner AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM pantry_products GROUP BY owner` },
  { id: "sweep_suggestions", app: "sweep", label: "Sweep suggestions",
    sql: `SELECT user_id AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM sweep_suggestions GROUP BY user_id` },
  { id: "trips", app: "trips", label: "Trips",
    sql: `SELECT t.owner AS u, COUNT(*) AS n,
      COALESCE(SUM(LENGTH(CAST(t.data AS BLOB)) + COALESCE((SELECT ${B("e.data")} FROM trip_entries e WHERE e.trip = t.id), 0)), 0) AS bytes
      FROM trips t GROUP BY t.owner` },
  { id: "board_posts", app: "board", label: "Board posts",
    sql: `SELECT author AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM board_posts GROUP BY author` },
  { id: "board_reviews", app: "board", label: "Board reviews",
    sql: `SELECT user_id AS u, COUNT(*) AS n, ${B("note")} + ${B("changes")} AS bytes FROM board_reviews GROUP BY user_id` },
  { id: "feedback", app: "feedback", label: "Feedback notes",
    sql: `SELECT author AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM feedback GROUP BY author` },
];

// The picture tables, and whose each picture is. Matches PHOTO_TABLES in src/photos.js.
export const PHOTOS = [
  { table: "recipe_photos", app: "recipes", label: "Recipe pictures", from: "recipe_photos p", owner: "p.owner" },
  { table: "food_photos", app: "food", label: "Food club photos", from: "food_photos p", owner: "p.user_id" },
  { table: "feedback_photos", app: "feedback", label: "Feedback photos", from: "feedback_photos p JOIN feedback f ON f.id = p.item", owner: "f.author" },
];

// The per-person columns on the stats page and in the terminal, and which counts add up to each.
export const COLUMNS = [
  { name: "Drift", ids: ["drift_items"] }, { name: "Recipes", ids: ["recipes"] }, { name: "Pantry", ids: ["pantry_items"] },
  { name: "Messages", ids: ["chat_messages", "chat_bridged"] }, { name: "Photos", ids: ["recipe_photos", "food_photos", "feedback_photos"] },
];

const appName = id => APPS.find(a => a.id === id)?.name || id;
const rowsOf = async (d, sql, ...args) => (await d.prepare(sql).bind(...args).all()).results;

// The size of the database, in bytes, as D1 reports it after a query (null
// where it doesn't, as in tests).
async function databaseBytes(d) {
  try {
    const r = await d.prepare("SELECT 1").all();
    return Number.isFinite(r?.meta?.size_after) ? r.meta.size_after : null;
  } catch { return null; }
}

// Sizes of the pictures in R2, by "<table>/<id>". null without the bucket,
// or if it couldn't be read; `partial` when there were more than we listed.
async function r2Sizes(env) {
  if (!env.PHOTOS?.list) return null;
  const sizes = new Map();
  try {
    for (const { table } of PHOTOS) {
      let cursor, pages = 0;
      do {
        const page = await env.PHOTOS.list({ prefix: `${table}/`, cursor, limit: 1000 });
        for (const o of page.objects) sizes.set(o.key, o.size);
        cursor = page.truncated ? page.cursor : undefined;
        if (++pages >= R2_PAGES && cursor) { sizes.partial = true; break; }
      } while (cursor);
    }
  } catch (e) {
    console.error("listing R2 photos failed:", e);
    return null;
  }
  return sizes;
}

// Everything on the stats page, as JSON.
export async function userStats(env, d) {
  const t = now();
  const [users, areas, seen, keys, said, dbBytes, r2] = await Promise.all([
    rowsOf(d, "SELECT id, username, display_name, created_at, disabled FROM users ORDER BY created_at"),
    rowsOf(d, "SELECT user_id AS u, area FROM user_areas"),
    rowsOf(d, "SELECT user_id AS u, MAX(last_seen) AS at, SUM(stage = 'full' AND expires_at > ?) AS devices FROM sessions GROUP BY user_id", t),
    rowsOf(d, "SELECT user_id AS u, MAX(last_used) AS at FROM api_keys GROUP BY user_id"),
    rowsOf(d, "SELECT user_id AS u, MAX(created_at) AS at FROM chat_messages WHERE user_id != '' GROUP BY user_id"),
    databaseBytes(d),
    r2Sizes(env),
  ]);
  const counted = await Promise.all(COUNTS.map(c => rowsOf(d, c.sql)));
  // Each picture's row: whose, and how much of it is still in D1.
  const pics = await Promise.all(PHOTOS.map(p => rowsOf(d, `SELECT p.id, ${p.owner} AS u, LENGTH(CAST(p.data AS BLOB)) AS d1 FROM ${p.from}`)));

  const byId = new Map(users.map(u => [u.id, {
    id: u.id, username: u.username, display_name: u.display_name, created_at: u.created_at, disabled: !!u.disabled,
    last_active: null, devices: 0, apps: [], counts: {}, photos: { count: 0, d1_bytes: 0, r2_bytes: 0, r2_count: 0 },
    data_bytes: 0, total_bytes: 0,
  }]));
  const totals = { counts: {}, data_bytes: 0, photos: { count: 0, d1_bytes: 0, d1_count: 0, r2_bytes: 0, r2_count: 0 }, by_photo: {} };
  const has = new Map();
  for (const a of areas) (has.get(a.u) || has.set(a.u, new Set()).get(a.u)).add(a.area);
  for (const u of byId.values()) u.apps = APPS.filter(a => has.get(u.id)?.has(a.area)).map(a => a.id);
  const later = (u, at) => { if (u && at && (!u.last_active || at > u.last_active)) u.last_active = at; };
  for (const r of seen) { const u = byId.get(r.u); later(u, r.at); if (u) u.devices = Number(r.devices) || 0; }
  for (const r of keys) later(byId.get(r.u), r.at);
  for (const r of said) later(byId.get(r.u), r.at);

  COUNTS.forEach((c, i) => {
    let n = 0, bytes = 0;
    for (const r of counted[i]) {
      n += r.n; bytes += r.bytes;
      const u = byId.get(r.u);
      if (!u) continue;
      u.counts[c.id] = r.n;
      u.data_bytes += r.bytes;
    }
    totals.counts[c.id] = n;
    totals.data_bytes += bytes;
  });
  PHOTOS.forEach((p, i) => {
    const sum = totals.by_photo[p.table] = { count: 0, d1_bytes: 0, r2_bytes: 0 };
    for (const r of pics[i]) {
      const inR2 = !r.d1, r2b = inR2 && r2 ? r2.get(`${p.table}/${r.id}`) || 0 : 0;
      sum.count++; sum.d1_bytes += r.d1; sum.r2_bytes += r2b;
      totals.photos.count++;
      if (inR2) { totals.photos.r2_count++; totals.photos.r2_bytes += r2b; }
      else { totals.photos.d1_count++; totals.photos.d1_bytes += r.d1; }
      const u = byId.get(r.u);
      if (!u) continue;
      u.counts[p.table] = (u.counts[p.table] || 0) + 1;
      u.photos.count++;
      if (inR2) { u.photos.r2_count++; u.photos.r2_bytes += r2b; } else u.photos.d1_bytes += r.d1;
    }
    totals.counts[p.table] = sum.count;
  });
  for (const u of byId.values()) u.total_bytes = u.data_bytes + u.photos.d1_bytes + u.photos.r2_bytes;

  const max = Number(env.MAX_USERS) || 100;
  const list = [...byId.values()];
  const active = days => list.filter(u => u.last_active && t - u.last_active <= days * DAY).length;
  const joined = days => list.filter(u => t - u.created_at <= days * DAY).length;
  const limitMb = Number(env.D1_LIMIT_MB) || D1_LIMIT_MB;
  return {
    now: t,
    accounts: {
      total: list.length, max, left: Math.max(0, max - list.length), signups: String(env.SIGNUPS || "").toLowerCase() === "open" ? "open" : "closed",
      disabled: list.filter(u => u.disabled).length,
      joined_7d: joined(7), joined_30d: joined(30), active_1d: active(1), active_7d: active(7), active_30d: active(30),
    },
    storage: {
      // D1: the whole database as D1 counts it (indexes and all), and our share of it.
      d1: { bytes: dbBytes, limit_bytes: limitMb * 1024 * 1024, data_bytes: totals.data_bytes, photo_bytes: totals.photos.d1_bytes, photo_count: totals.photos.d1_count },
      // R2: pictures moved out of D1. bytes is null without the PHOTOS binding.
      r2: { bound: !!r2, bytes: r2 ? totals.photos.r2_bytes : null, photo_count: totals.photos.r2_count, partial: !!r2?.partial },
    },
    kinds: [...COUNTS.map(c => ({ id: c.id, app: c.app, app_name: appName(c.app), label: c.label })),
      ...PHOTOS.map(p => ({ id: p.table, app: p.app, app_name: appName(p.app), label: p.label, photos: true }))],
    columns: COLUMNS,
    totals: { counts: totals.counts, photos: totals.by_photo },
    // Biggest first: who's filling the database.
    users: list.sort((a, b) => b.total_bytes - a.total_bytes || a.created_at - b.created_at),
  };
}
