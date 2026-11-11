// Where Recipe box, Food club and Feedback keep their pictures.
//
// Pictures go in R2 (the PHOTOS bucket), one object per picture, named
// "<table>/<id>" after its row. The row in D1 keeps everything else (who, which
// recipe or pick, the type, the caption) and an empty `data`. That keeps the
// D1 database small: a picture is up to 1.2 MB, which is 1.6 MB as base64.
//
// Without the PHOTOS binding (tests, branch previews) a picture stays in its
// row as base64, as all of them did before. Rows from before the bucket still
// hold theirs; the 5-minute job (movePhotos, from scheduled() in worker.js)
// moves a few at a time into R2 and empties their `data`. A picture is served
// from whichever place has it, so nothing breaks while that runs.

import { db } from "./db.js";

export const PHOTO_TABLES = ["recipe_photos", "food_photos", "feedback_photos"];
// Pictures moved per table on each run of the 5-minute job.
export const MOVE_EACH = 3;

const keyOf = (table, id) => `${table}/${id}`;

function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(s) {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Keeps a new picture. Returns what goes in its row's `data`: "" when it is in
// R2, the base64 itself when there is no bucket.
export async function storePhoto(env, table, id, bytes, type) {
  if (!env.PHOTOS) return toBase64(bytes);
  await env.PHOTOS.put(keyOf(table, id), bytes, { httpMetadata: { contentType: type } });
  return "";
}

// Takes back a picture just stored, when saving its row failed.
export async function unstorePhoto(env, table, id) {
  if (env.PHOTOS) await env.PHOTOS.delete(keyOf(table, id)).catch(e => console.error("photo cleanup failed:", e));
}

// The picture for a row ({id, type, data}), from D1 or R2.
export async function photoResponse(env, table, row) {
  let body = null;
  if (row.data) body = fromBase64(row.data);
  else if (env.PHOTOS) body = (await env.PHOTOS.get(keyOf(table, row.id)))?.body ?? null;
  if (!body) return new Response("not found", { status: 404 });
  return new Response(body, { headers: {
    "Content-Type": row.type, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'",
    "Content-Disposition": "inline", "Cache-Control": "private, max-age=31536000, immutable",
  } });
}

// The ids of a table's rows that a query picks, to drop from R2 once the rows go.
export async function photoIds(d, sql, ...args) {
  const { results } = await d.prepare(sql).bind(...args).all();
  return results.map(r => r.id);
}

// Removes pictures from R2 whose rows are gone. Never fails the request: at
// worst a picture nobody can reach any more stays in the bucket.
export async function dropPhotos(env, table, ids) {
  if (!env.PHOTOS || !ids.length) return;
  try {
    for (let i = 0; i < ids.length; i += 1000) await env.PHOTOS.delete(ids.slice(i, i + 1000).map(id => keyOf(table, id)));
  } catch (e) { console.error("dropping photos failed:", e); }
}

// Every picture of one person's, by table, for deleting their account.
export async function photosOf(d, userId) {
  return {
    recipe_photos: await photoIds(d, "SELECT id FROM recipe_photos WHERE owner = ?", userId),
    food_photos: await photoIds(d, "SELECT id FROM food_photos WHERE user_id = ?", userId),
    feedback_photos: await photoIds(d, "SELECT p.id FROM feedback_photos p JOIN feedback f ON f.id = p.item WHERE f.author = ?", userId),
  };
}

// Moves pictures still kept in D1 into R2, a few per table. Returns how many moved.
export async function movePhotos(env, each = MOVE_EACH) {
  if (!env.PHOTOS || !env.TODO_DB) return 0;
  const d = await db(env);
  let moved = 0;
  for (const table of PHOTO_TABLES) {
    const { results } = await d.prepare(`SELECT id, type, data FROM ${table} WHERE data != '' LIMIT ?`).bind(each).all();
    for (const r of results) {
      await env.PHOTOS.put(keyOf(table, r.id), fromBase64(r.data), { httpMetadata: { contentType: r.type } });
      await d.prepare(`UPDATE ${table} SET data = '' WHERE id = ?`).bind(r.id).run();
      moved++;
    }
  }
  return moved;
}
