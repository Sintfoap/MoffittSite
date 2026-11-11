// Where a recipe in your Recipe box turns up in the other kitchen apps, so its
// page can say so: the nights it's planned in Meal plan (this week and next),
// Food club picks with the same name, and your Recipe board post of it or the
// post you saved it from. Only for the apps the account has.
//
// /recipes/api/recipes/<id>/uses   GET → {planned: [{day, name, week}], club: [{id, month, title}], board: {post, yours} | null}

import { db } from "./db.js";
import { mondayOf, addDays } from "./meals.js";

const NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export async function uses(env, user, id, today) {
  const d = await db(env);
  const row = await d.prepare("SELECT data FROM recipes WHERE owner = ? AND id = ?").bind(user.id, id).first();
  if (!row) return null;
  const title = String(JSON.parse(row.data).title || "").trim().toLowerCase();
  const out = { planned: [], club: [], board: null };

  if (user.areas.has("meals")) {
    const monday = mondayOf(today);
    for (const week of [monday, addDays(monday, 7)]) {
      const r = await d.prepare("SELECT data FROM meal_plans WHERE owner = ? AND week = ?").bind(user.id, week).first();
      const nights = r ? JSON.parse(r.data).nights || {} : {};
      for (const [i, n] of NAMES.entries()) {
        const day = addDays(week, i);
        if (nights[day]?.recipe === id && !nights[day].out && day >= today) out.planned.push({ day, name: NAMES[i], week });
      }
    }
  }
  if (user.areas.has("food") && title) {
    const { results } = await d.prepare("SELECT id, month, data FROM food_picks ORDER BY month DESC").all();
    for (const p of results) {
      const t = String(JSON.parse(p.data).title || "");
      if (t.trim().toLowerCase() === title) out.club.push({ id: p.id, month: p.month, title: t });
    }
  }
  if (user.areas.has("board")) {
    const mine = await d.prepare("SELECT id FROM board_posts WHERE author = ? AND json_extract(data, '$.from') = ?").bind(user.id, id).first();
    const saved = mine ? null : await d.prepare("SELECT post FROM board_saves WHERE user_id = ? AND recipe_id = ?").bind(user.id, id).first();
    if (mine) out.board = { post: mine.id, yours: true };
    else if (saved) out.board = { post: saved.post, yours: false };
  }
  return out;
}
