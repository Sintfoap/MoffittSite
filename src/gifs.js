// GIFs for chat, after Discord's picker: search, trending, categories and
// favorites. They come from KLIPY, the provider Discord moved to when
// Google closed Tenor's API, through KLIPY's Tenor-compatible API (v2:
// /search, /featured, /categories). The API key stays here on the server
// (the GIF_API_KEY secret); without it the picker is off. GIF_API_BASE
// points it somewhere else that speaks the same API.
//
// A GIF is sent as an ordinary message whose whole text is the GIF's link,
// so it reaches other platforms (Matrix, …) and the terminal as a link. The
// chat page shows a message like that as the picture, but only for links on
// GIF_HOSTS, which is also all the page's CSP lets it load pictures from.
//
// Favorites are kept per account, so the web page and the terminal share them.

import { db, now } from "./db.js";

const BASE = "https://api.klipy.com/v2";
// Hosts (and their subdomains) that GIFs are shown from.
const HOSTS = "klipy.com tenor.com giphy.com";
const PAGE = 30, MAX_Q = 100, MAX_FAVORITES = 200, MAX_URL = 500, MAX_TITLE = 140;
const TIMEOUT = 8000;

export const gifHosts = env => String(env.GIF_HOSTS || HOSTS).split(/[\s,]+/).filter(Boolean).map(h => h.toLowerCase());
export const gifsReady = env => !!env.GIF_API_KEY;

// For the chat page's CSP: where its pictures may come from.
export const gifImageSources = env => gifHosts(env).flatMap(h => [`https://${h}`, `https://*.${h}`]);

// An https link to a picture on one of the GIF hosts.
export function isGif(env, url) {
  if (typeof url !== "string" || url.length > MAX_URL || /\s/.test(url)) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  return gifHosts(env).some(h => host === h || host.endsWith("." + h)) && /\.(gif|webp)$/i.test(u.pathname);
}

export function gifInfo(env) {
  return { ready: gifsReady(env), hosts: gifHosts(env), provider: "KLIPY" };
}

async function provider(env, path, params) {
  const url = new URL((env.GIF_API_BASE || BASE).replace(/\/+$/, "") + path);
  for (const [k, v] of Object.entries({ key: env.GIF_API_KEY, client_key: "sintfoap", media_filter: "gif,tinygif,mediumgif,nanogif", contentfilter: "medium", ...params })) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), cf: { cacheTtl: 300, cacheEverything: true } }); }
  catch { return { failed: "the GIF service couldn't be reached; try again" }; }
  if (!res.ok) {
    console.error("GIF service:", res.status, path);
    return { failed: `the GIF service answered ${res.status}` };
  }
  try { return await res.json(); } catch { return { failed: "the GIF service sent something unreadable" }; }
}

// One result as the site hands it on: the GIF to send, a smaller one to show
// in the picker, and its shape so the grid can be laid out before it loads.
function gifOut(env, r) {
  const f = r?.media_formats || {};
  const full = [f.gif, f.mediumgif].find(x => isGif(env, x?.url));
  const small = [f.tinygif, f.nanogif, f.mediumgif, f.gif].find(x => isGif(env, x?.url));
  if (!full) return null;
  const [width, height] = (full.dims?.length === 2 ? full.dims : small?.dims) || [];
  return {
    id: String(r.id ?? ""), title: String(r.content_description || r.title || "").slice(0, MAX_TITLE),
    url: full.url, preview: (small || full).url,
    width: Number(width) > 0 ? Math.round(width) : null, height: Number(height) > 0 ? Math.round(height) : null,
  };
}

function results(env, data) {
  if (data.failed) return data;
  return { results: (data.results || []).map(r => gifOut(env, r)).filter(Boolean), next: data.next ? String(data.next) : null };
}

const off = { unavailable: "GIFs aren't set up on this site yet: an admin needs to add the GIF_API_KEY secret" };

// Search when there's a query, otherwise what's trending.
export async function gifSearch(env, user, { q, pos }) {
  if (!gifsReady(env)) return off;
  q = String(q ?? "").trim().slice(0, MAX_Q);
  pos = String(pos ?? "").slice(0, 100);
  return results(env, await provider(env, q ? "/search" : "/featured", { q, pos, limit: PAGE }));
}

// Discord's category tiles: a name, the search it runs, and a picture.
export async function gifCategories(env) {
  if (!gifsReady(env)) return off;
  const data = await provider(env, "/categories", { type: "featured" });
  if (data.failed) return data;
  return {
    categories: (data.tags || []).map(t => ({
      name: String(t.name || t.searchterm || "").replace(/^#/, "").slice(0, 60),
      query: String(t.searchterm || t.name || "").replace(/^#/, "").slice(0, MAX_Q),
      preview: isGif(env, t.image) ? t.image : null,
    })).filter(c => c.name && c.query).slice(0, 40),
  };
}

// ── favorites ─────────────────────────────────────────────────────────────

export async function favorites(env, user) {
  const { results: rows } = await (await db(env)).prepare(
    "SELECT url, preview, width, height, title FROM chat_gif_favorites WHERE user_id = ? ORDER BY added_at DESC, rowid DESC").bind(user.id).all();
  return { favorites: rows.filter(r => isGif(env, r.url)).map(r => ({ ...r, preview: isGif(env, r.preview) ? r.preview : r.url })) };
}

// {gif: {url, preview?, width?, height?, title?}, on}: star it, or take the star off.
export async function favorite(env, user, body, fail) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("body must be a JSON object");
  for (const k of Object.keys(body)) if (!["gif", "on"].includes(k)) fail(`unknown field ${JSON.stringify(k)}`);
  if (typeof body.on !== "boolean") fail("on must be true or false");
  const g = body.gif;
  if (!g || typeof g !== "object" || !isGif(env, g.url)) fail("gif.url must be a GIF from the GIF service");
  const d = await db(env);
  if (!body.on) {
    await d.prepare("DELETE FROM chat_gif_favorites WHERE user_id = ? AND url = ?").bind(user.id, g.url).run();
    return favorites(env, user);
  }
  const dim = v => Number.isInteger(v) && v > 0 && v < 10000 ? v : null;
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM chat_gif_favorites WHERE user_id = ?").bind(user.id).first();
  const had = await d.prepare("SELECT 1 AS x FROM chat_gif_favorites WHERE user_id = ? AND url = ?").bind(user.id, g.url).first();
  if (!had && n >= MAX_FAVORITES) return { forbidden: `you can keep up to ${MAX_FAVORITES} favorite GIFs; take the star off some first` };
  await d.prepare(`INSERT INTO chat_gif_favorites (user_id, url, preview, width, height, title, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, url) DO UPDATE SET added_at = excluded.added_at`)
    .bind(user.id, g.url, isGif(env, g.preview) ? g.preview : g.url, dim(g.width), dim(g.height),
      typeof g.title === "string" ? g.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_TITLE) : "", now()).run();
  return favorites(env, user);
}
