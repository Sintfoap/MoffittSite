// One line of what's new in each app, for the dashboard's app cards on the web
// (src/pages.js) and in the terminal (src/cli.js → cli/sintfoap/tui.py), so a
// card says something live instead of only what the app is for. Each line is
// worked out on its own: one that fails is left off, and the card shows its
// blurb as before.

import { db } from "./db.js";
import { listRooms } from "./chat.js";
import { unread as boardUnread } from "./board.js";
import { listPicks } from "./food.js";
import { listTrips } from "./trips.js";
import { tonight } from "./meals.js";

const plural = (n, word, many = word + "s") => `${n} ${n === 1 ? word : many}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = s => `${MONTHS[Number(s.slice(5, 7)) - 1]} ${Number(s.slice(8, 10))}`;
const count = async (env, sql, ...args) => (await (await db(env)).prepare(sql).bind(...args).first()).n;

// What each app's line says. `day` is the visitor's own date (YYYY-MM-DD);
// `agenda` is Drift's {late, due} when the caller already has it.
const LINES = {
  drift: async (env, user, { agenda }) => {
    if (!agenda) return null;
    const { late, due } = agenda;
    return late.length || due.length
      ? `${plural(due.length, "thing")} today${late.length ? `, ${late.length} overdue` : ""}`
      : "Nothing due today";
  },
  chat: async (env, user) => {
    const rooms = (await listRooms(env, user)).filter(r => r.joined);
    const unread = rooms.reduce((n, r) => n + (r.unread || 0), 0), where = rooms.filter(r => r.unread).length;
    return unread ? `${plural(unread, "unread message")} in ${plural(where, "room")}` : rooms.length ? "You're all caught up" : null;
  },
  recipes: async (env, user) => {
    const n = await count(env, "SELECT COUNT(*) AS n FROM recipes WHERE owner = ?", user.id);
    return n ? `${plural(n, "recipe")} saved` : "No recipes yet";
  },
  meals: async (env, user, { day }) => {
    const t = await tonight(env, user, day);
    return t?.out ? "Eating out tonight" : t ? `Tonight: ${t.title}` : "Nothing planned for tonight";
  },
  board: async (env, user) => {
    const n = await boardUnread(await db(env), user);
    return n ? `${plural(n, "new recipe")} in your feed` : null;
  },
  food: async (env, user, { day }) => {
    const pick = (await listPicks(env, user)).find(p => p.month === day.slice(0, 7));
    return pick ? `This month: ${pick.title}` : "Nobody's picked this month yet";
  },
  trips: async (env, user, { day }) => {
    const next = (await listTrips(env, user)).find(t => t.start && (t.end || t.start) >= day);
    if (!next) return null;
    return next.start <= day ? `${next.title}, on now` : `${next.title}, ${shortDate(next.start)}`;
  },
  sweep: async (env, user) => {
    const n = await count(env, "SELECT COUNT(*) AS n FROM sweep_suggestions WHERE user_id = ? AND status = 'waiting'", user.id);
    return n ? `${plural(n, "suggestion")} waiting for you` : null;
  },
  labels: async env => {
    const n = await count(env, "SELECT COUNT(*) AS n FROM recipe_labels");
    return n ? `${plural(n, "label")} in the list` : "No labels yet";
  },
};

// {app id: line} for the apps given (from APPS), leaving out any without one.
export async function glance(env, user, apps, { day, agenda = null } = {}) {
  const out = {};
  await Promise.all(apps.map(async a => {
    const line = LINES[a.id];
    if (!line) return;
    try { const text = await line(env, user, { day, agenda }); if (text) out[a.id] = text; }
    catch (e) { console.error(`dashboard line for ${a.id} failed:`, e); }
  }));
  return out;
}
