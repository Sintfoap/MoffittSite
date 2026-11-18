// Admin stats (/admin/stats, and /admin/api/stats for the terminal): how many
// accounts there are against MAX_USERS, who's active, how much each person
// keeps in each app, and how much room they take up in D1 and R2.
//
// Storage is counted in bytes of the rows' stored text (LENGTH of the value as
// a blob), which is what fills the D1 database; the database's own size comes
// from D1 itself (meta.size_after). Pictures are counted where they are: a
// row whose `data` is still base64 is in D1; an emptied `data` means the
// picture is in R2 (src/photos.js names it "<table>/<id>"), and with the
// PHOTOS binding its size is read from the bucket's listing. The whole bucket
// is listed, so R2's total (against R2_LIMIT_GB) also counts objects no row
// points at any more ("left over").
//
// Besides storage: what changed in the last 7 days kind by kind, how many
// people have each app turned on, sign-ups week by week, signed-in devices,
// API keys and notification devices, and D1's tables by row count.

import { APPS } from "./auth.js";
import { now } from "./db.js";

const DAY = 86400;
// D1's database size limit: 500 MB on the Workers free plan, 10 GB on paid.
// Set D1_LIMIT_MB (a Text variable) to the plan's limit; free is assumed.
const D1_LIMIT_MB = 500;
// R2's free storage: 10 GB a month. Set R2_LIMIT_GB (a Text variable) if you pay for more.
const R2_LIMIT_GB = 10;
// How many R2 listing pages (1000 objects each) to read before giving up.
const R2_PAGES = 50;
// How many weeks of sign-ups the chart shows.
const WEEKS = 12;

// What each person keeps, app by app. `rows` counts, `bytes` sums stored size;
// each query gives (u, n, bytes) per user id.
const B = col => `COALESCE(SUM(LENGTH(CAST(${col} AS BLOB))), 0)`;
export const COUNTS = [
  { id: "drift_items", recent: `SELECT COUNT(*) AS n FROM drift_items WHERE updated >= ?`, app: "drift", label: "Drift items",
    sql: `SELECT owner AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM drift_items GROUP BY owner` },
  { id: "drift_collections", recent: `SELECT COUNT(*) AS n FROM drift_collections WHERE updated >= ?`, app: "drift", label: "Drift collections",
    sql: `SELECT owner AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM drift_collections GROUP BY owner` },
  { id: "todo_tasks", recent: `SELECT COUNT(*) AS n FROM todo_tasks WHERE updated >= ?`, app: "drift", label: "Old todo tasks",
    sql: `SELECT owner AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM todo_tasks GROUP BY owner` },
  { id: "chat_messages", unix: true, recent: `SELECT COUNT(*) AS n FROM chat_messages WHERE user_id != '' AND created_at >= ?`, app: "chat", label: "Chat messages",
    sql: `SELECT user_id AS u, COUNT(*) AS n, ${B("body")} + ${B("ext_raw")} AS bytes FROM chat_messages WHERE user_id != '' GROUP BY user_id` },
  // Other people's messages in rooms brought in from Matrix, kept for the connection's owner.
  { id: "chat_bridged", unix: true, recent: `SELECT COUNT(*) AS n FROM chat_messages m JOIN chat_rooms r ON r.id = m.room WHERE m.user_id = '' AND r.kind = 'bridge' AND m.created_at >= ?`, app: "chat-bridges", label: "Bridged messages",
    sql: `SELECT r.owner AS u, COUNT(*) AS n, ${B("m.body")} + ${B("m.ext_raw")} AS bytes
      FROM chat_messages m JOIN chat_rooms r ON r.id = m.room WHERE m.user_id = '' AND r.kind = 'bridge' GROUP BY r.owner` },
  { id: "recipes", recent: `SELECT COUNT(*) AS n FROM recipes WHERE updated >= ?`, app: "recipes", label: "Recipes",
    sql: `SELECT owner AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM recipes GROUP BY owner` },
  { id: "meal_plans", recent: `SELECT COUNT(*) AS n FROM meal_plans WHERE updated >= ?`, app: "meals", label: "Meal plan weeks",
    sql: `SELECT owner AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM meal_plans GROUP BY owner` },
  { id: "pantry_items", recent: `SELECT COUNT(*) AS n FROM pantry_items WHERE updated >= ?`, app: "pantry", label: "Pantry items",
    sql: `SELECT owner AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM pantry_items GROUP BY owner` },
  { id: "pantry_products", recent: `SELECT COUNT(*) AS n FROM pantry_products WHERE updated >= ?`, app: "pantry", label: "Scanned barcodes",
    sql: `SELECT owner AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM pantry_products GROUP BY owner` },
  { id: "sweep_suggestions", unix: true, recent: `SELECT COUNT(*) AS n FROM sweep_suggestions WHERE created_at >= ?`, app: "sweep", label: "Sweep suggestions",
    sql: `SELECT user_id AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM sweep_suggestions GROUP BY user_id` },
  { id: "trips", recent: `SELECT COUNT(*) AS n FROM trips WHERE updated >= ?`, app: "trips", label: "Trips",
    sql: `SELECT t.owner AS u, COUNT(*) AS n,
      COALESCE(SUM(LENGTH(CAST(t.data AS BLOB)) + COALESCE((SELECT ${B("e.data")} FROM trip_entries e WHERE e.trip = t.id), 0)), 0) AS bytes
      FROM trips t GROUP BY t.owner` },
  { id: "board_posts", recent: `SELECT COUNT(*) AS n FROM board_posts WHERE updated >= ?`, app: "board", label: "Board posts",
    sql: `SELECT author AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM board_posts GROUP BY author` },
  { id: "board_reviews", recent: `SELECT COUNT(*) AS n FROM board_reviews WHERE updated >= ?`, app: "board", label: "Board reviews",
    sql: `SELECT user_id AS u, COUNT(*) AS n, ${B("note")} + ${B("changes")} AS bytes FROM board_reviews GROUP BY user_id` },
  { id: "feedback", recent: `SELECT COUNT(*) AS n FROM feedback WHERE last_at >= ?`, app: "feedback", label: "Feedback notes",
    sql: `SELECT author AS u, COUNT(*) AS n, ${B("data")} AS bytes FROM feedback GROUP BY author` },
];

// The picture tables, and whose each picture is. Matches PHOTO_TABLES in src/photos.js.
export const PHOTOS = [
  { table: "recipe_photos", app: "recipes", label: "Recipe pictures", from: "recipe_photos p", owner: "p.owner", created: "p.created" },
  { table: "food_photos", app: "food", label: "Food club photos", from: "food_photos p", owner: "p.user_id", created: "p.created" },
  { table: "feedback_photos", app: "feedback", label: "Feedback photos", from: "feedback_photos p JOIN feedback f ON f.id = p.item", owner: "f.author", created: "p.created" },
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

// Every object in the R2 bucket and its size, by key ("<table>/<id>" for
// pictures). null without the bucket, or if it couldn't be read; `partial`
// when there were more than we listed.
async function r2Sizes(env) {
  if (!env.PHOTOS?.list) return null;
  const sizes = new Map();
  try {
    let cursor, pages = 0;
    do {
      const page = await env.PHOTOS.list({ cursor, limit: 1000 });
      for (const o of page.objects) sizes.set(o.key, o.size);
      cursor = page.truncated ? page.cursor : undefined;
      if (++pages >= R2_PAGES && cursor) { sizes.partial = true; break; }
    } while (cursor);
  } catch (e) {
    console.error("listing R2 photos failed:", e);
    return null;
  }
  return sizes;
}

// Every table in D1 and how many rows it has, most first. [] if D1 won't list them.
async function tableRows(d) {
  try {
    const names = (await rowsOf(d, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'"))
      .map(r => r.name).filter(n => /^[a-z0-9_]+$/i.test(n));
    const counts = await Promise.all(names.map(async name => ({ name, rows: Number((await d.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).first())?.n) || 0 })));
    return counts.sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name));
  } catch (e) {
    console.error("counting D1 tables failed:", e);
    return [];
  }
}

const one = async (d, sql, ...args) => Number((await d.prepare(sql).bind(...args).first())?.n) || 0;

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
  const weekAgo = t - 7 * DAY, weekAgoIso = new Date(weekAgo * 1000).toISOString();
  const recent = await Promise.all([
    ...COUNTS.map(c => one(d, c.recent, c.unix ? weekAgo : weekAgoIso)),
    ...PHOTOS.map(p => one(d, `SELECT COUNT(*) AS n FROM ${p.from} WHERE ${p.created} >= ?`, weekAgoIso)),
  ]);
  const [tables, devices, apiKeys, keysUsed, push, rooms, fbNew] = await Promise.all([
    tableRows(d),
    one(d, "SELECT COUNT(*) AS n FROM sessions WHERE stage = 'full' AND expires_at > ?", t),
    one(d, "SELECT COUNT(*) AS n FROM api_keys"),
    one(d, "SELECT COUNT(*) AS n FROM api_keys WHERE last_used >= ?", t - 30 * DAY),
    one(d, "SELECT COUNT(*) AS n FROM push_devices"),
    one(d, "SELECT COUNT(*) AS n FROM chat_rooms WHERE kind != 'bridge'"),
    one(d, "SELECT COUNT(*) AS n FROM feedback WHERE status = 'new'"),
  ]);
  // Each picture's row: whose, and how much of it is still in D1.
  const pics = await Promise.all(PHOTOS.map(p => rowsOf(d, `SELECT p.id, ${p.owner} AS u, LENGTH(CAST(p.data AS BLOB)) AS d1 FROM ${p.from}`)));

  const byId = new Map(users.map(u => [u.id, {
    id: u.id, username: u.username, display_name: u.display_name, created_at: u.created_at, disabled: !!u.disabled,
    last_active: null, devices: 0, apps: [], counts: {}, photos: { count: 0, d1_bytes: 0, r2_bytes: 0, r2_count: 0 },
    data_bytes: 0, total_bytes: 0,
  }]));
  const totals = { counts: {}, data_bytes: 0, photos: { count: 0, d1_bytes: 0, d1_count: 0, r2_bytes: 0, r2_count: 0 }, by_photo: {} };
  const changed = {};
  [...COUNTS.map(c => c.id), ...PHOTOS.map(p => p.table)].forEach((id, i) => { changed[id] = recent[i]; });
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
  const limitGb = Number(env.R2_LIMIT_GB) || R2_LIMIT_GB;
  // What's in R2 but no picture row points at (left from a failed delete, say).
  const linked = new Set(PHOTOS.flatMap((p, i) => pics[i].filter(r => !r.d1).map(r => `${p.table}/${r.id}`)));
  const r2All = r2 ? [...r2] : [], loose = r2All.filter(([k]) => !linked.has(k));
  // Sign-ups by week, oldest first, ending with the week to today.
  const weeks = Array.from({ length: WEEKS }, (_, i) => {
    const end = t - (WEEKS - 1 - i) * 7 * DAY, start = end - 7 * DAY;
    return { start, joined: list.filter(u => u.created_at > start && u.created_at <= end).length };
  });
  // How many people have each app turned on, and how many of them were active in 30 days.
  const apps = APPS.filter(a => a.id !== "admin").map(a => {
    const on = list.filter(u => u.apps.includes(a.id));
    return { id: a.id, name: a.name, parent: a.parent || null, people: on.length,
      active_30d: on.filter(u => u.last_active && t - u.last_active <= 30 * DAY).length };
  });
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
      // bucket_bytes/objects: everything in the bucket, which is what counts against R2's limit.
      r2: { bound: !!r2, bytes: r2 ? totals.photos.r2_bytes : null, photo_count: totals.photos.r2_count, partial: !!r2?.partial,
        bucket_bytes: r2 ? r2All.reduce((s, [, n]) => s + n, 0) : null, objects: r2 ? r2All.length : null,
        loose_count: r2 ? loose.length : null, loose_bytes: r2 ? loose.reduce((s, [, n]) => s + n, 0) : null,
        limit_bytes: limitGb * 1024 * 1024 * 1024 },
      tables,
    },
    activity: { devices, api_keys: apiKeys, api_keys_used_30d: keysUsed, push_devices: push, chat_rooms: rooms, feedback_new: fbNew,
      changed_7d: Object.values(changed).reduce((s, n) => s + n, 0) },
    weeks,
    apps,
    kinds: [...COUNTS.map(c => ({ id: c.id, app: c.app, app_name: appName(c.app), label: c.label })),
      ...PHOTOS.map(p => ({ id: p.table, app: p.app, app_name: appName(p.app), label: p.label, photos: true }))],
    columns: COLUMNS,
    totals: { counts: totals.counts, photos: totals.by_photo, changed_7d: changed },
    // Biggest first: who's filling the database.
    users: list.sort((a, b) => b.total_bytes - a.total_bytes || a.created_at - b.created_at),
  };
}
