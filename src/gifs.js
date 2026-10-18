// GIFs for chat, after Discord's picker: search, trending, categories and
// favorites, from one of two services. The site asks them, so the API key
// stays here on the server; without a key the picker is off.
//
//   GIPHY (the GIPHY_API_KEY secret): its own API, /v1/gifs/search, /trending
//     and /categories. Used whenever that key is set.
//   KLIPY (the GIF_API_KEY secret): the provider Discord moved to when Google
//     closed Tenor's API, through KLIPY's Tenor-compatible API (v2: /search,
//     /featured, /categories). GIF_API_BASE points it somewhere else that
//     speaks the same API.
//
// A GIF is sent as an ordinary message whose whole text is the GIF's link,
// so it reaches other platforms (Matrix, …) and the terminal as a link. The
// chat page shows a message like that as the picture, but only for links on
// GIF_HOSTS, which is also all the page's CSP lets it load pictures from.
//
// Favorites are kept per account, so the web page and the terminal share them.

import { db, now } from "./db.js";

// Hosts (and their subdomains) that GIFs are shown from.
const HOSTS = "klipy.com tenor.com giphy.com";
const PAGE = 30, MAX_Q = 100, MAX_FAVORITES = 200, MAX_URL = 500, MAX_TITLE = 140;
const TIMEOUT = 8000;

export const gifHosts = env => String(env.GIF_HOSTS || HOSTS).split(/[\s,]+/).filter(Boolean).map(h => h.toLowerCase());

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

// A GIF's own bytes, for passing on to another platform as a picture
// (src/chat.js sends GIFs to Matrix this way): {bytes, mimetype, name, width, height}.
const MAX_GIF = 8 * 1024 * 1024;
export async function fetchGif(env, url) {
  if (!isGif(env, url)) return null;
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), redirect: "manual" }); } catch { return null; }
  const mimetype = String(res.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!res.ok || !["image/gif", "image/webp"].includes(mimetype) || Number(res.headers.get("Content-Length")) > MAX_GIF) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_GIF) return null;
  // A GIF says its size in its first ten bytes ("GIF89a", then width and height, little-endian).
  const gif = mimetype === "image/gif" && bytes.byteLength >= 10 && String.fromCharCode(...bytes.slice(0, 3)) === "GIF";
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || (gif ? "image.gif" : "image.webp");
  return { bytes, mimetype, name, width: gif ? bytes[6] | bytes[7] << 8 : null, height: gif ? bytes[8] | bytes[9] << 8 : null };
}

async function ask(url, params) {
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, String(v));
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), cf: { cacheTtl: 300, cacheEverything: true } }); }
  catch { return { failed: "the GIF service couldn't be reached; try again" }; }
  if (!res.ok) {
    console.error("GIF service:", res.status, url.pathname);
    return { failed: `the GIF service answered ${res.status}` };
  }
  try { return await res.json(); } catch { return { failed: "the GIF service sent something unreadable" }; }
}

const dim = v => Number(v) > 0 ? Math.round(Number(v)) : null;
const title = v => String(v || "").slice(0, MAX_TITLE);

// Each service as the rest of this file uses it. A result is
// {id, title, url (the GIF to send), preview (a smaller one for the picker),
// width, height} (its shape, so the grid can be laid out before it loads).
const PROVIDERS = {
  giphy: {
    name: "GIPHY",
    call: (env, path, params) => ask(new URL("https://api.giphy.com/v1/gifs" + path), { api_key: env.GIPHY_API_KEY, ...params }),
    // GIPHY's links carry tracking parameters; the GIF is the same without them.
    clean: url => { try { const u = new URL(url); u.search = ""; return u.href; } catch { return url; } },
    async search(env, q, pos) {
      const offset = /^\d{1,4}$/.test(pos) ? Number(pos) : 0;
      const data = await this.call(env, q ? "/search" : "/trending", { q, offset, limit: PAGE, rating: "pg-13", bundle: "messaging_non_clips" });
      if (data.failed) return data;
      const results = (data.data || []).map(r => {
        const im = r?.images || {};
        const full = [im.original, im.downsized, im.fixed_width].map(x => x && { ...x, url: this.clean(x.url) }).find(x => isGif(env, x?.url));
        const small = [im.fixed_width, im.fixed_width_downsampled, im.fixed_width_small, im.downsized].map(x => x && { ...x, url: this.clean(x.url) }).find(x => isGif(env, x?.url));
        if (!full) return null;
        return { id: String(r.id ?? ""), title: title(r.title), url: full.url, preview: (small || full).url,
          width: dim(full.width) ?? dim(small?.width), height: dim(full.height) ?? dim(small?.height) };
      }).filter(Boolean);
      const p = data.pagination || {}, nextAt = Number(p.offset || offset) + Number(p.count || 0);
      // GIPHY stops at an offset of 4999.
      return { results, next: results.length && nextAt < Math.min(Number(p.total_count) || 0, 4999) ? String(nextAt) : null };
    },
    async categories(env) {
      const data = await this.call(env, "/categories", {});
      if (data.failed) return data;
      return (data.data || []).map(c => {
        const preview = [c?.gif?.images?.fixed_width, c?.gif?.images?.downsized, c?.gif?.images?.original].map(x => x && this.clean(x.url)).find(u => isGif(env, u));
        return { name: String(c?.name || ""), query: String(c?.name || ""), preview: preview || null };
      });
    },
  },
  klipy: {
    name: "KLIPY",
    call: (env, path, params) => ask(new URL((env.GIF_API_BASE || "https://api.klipy.com/v2").replace(/\/+$/, "") + path),
      { key: env.GIF_API_KEY, client_key: "sintfoap", media_filter: "gif,tinygif,mediumgif,nanogif", contentfilter: "medium", ...params }),
    async search(env, q, pos) {
      const data = await this.call(env, q ? "/search" : "/featured", { q, pos, limit: PAGE });
      if (data.failed) return data;
      const results = (data.results || []).map(r => {
        const f = r?.media_formats || {};
        const full = [f.gif, f.mediumgif].find(x => isGif(env, x?.url));
        const small = [f.tinygif, f.nanogif, f.mediumgif, f.gif].find(x => isGif(env, x?.url));
        if (!full) return null;
        const [width, height] = (full.dims?.length === 2 ? full.dims : small?.dims) || [];
        return { id: String(r.id ?? ""), title: title(r.content_description || r.title), url: full.url, preview: (small || full).url, width: dim(width), height: dim(height) };
      }).filter(Boolean);
      return { results, next: data.next ? String(data.next) : null };
    },
    async categories(env) {
      const data = await this.call(env, "/categories", { type: "featured" });
      if (data.failed) return data;
      return (data.tags || []).map(t => ({
        name: String(t.name || t.searchterm || "").replace(/^#/, ""),
        query: String(t.searchterm || t.name || "").replace(/^#/, ""),
        preview: isGif(env, t.image) ? t.image : null,
      }));
    },
  },
};

const providerFor = env => env.GIPHY_API_KEY ? PROVIDERS.giphy : env.GIF_API_KEY ? PROVIDERS.klipy : null;
export const gifsReady = env => !!providerFor(env);

export function gifInfo(env) {
  return { ready: gifsReady(env), hosts: gifHosts(env), provider: providerFor(env)?.name ?? null };
}

const off = { unavailable: "GIFs aren't set up on this site yet: an admin needs to add the GIPHY_API_KEY (or GIF_API_KEY, for KLIPY) secret" };

// Search when there's a query, otherwise what's trending.
export async function gifSearch(env, user, { q, pos }) {
  const p = providerFor(env);
  if (!p) return off;
  return p.search(env, String(q ?? "").trim().slice(0, MAX_Q), String(pos ?? "").slice(0, 100));
}

// Discord's category tiles: a name, the search it runs, and a picture.
export async function gifCategories(env) {
  const p = providerFor(env);
  if (!p) return off;
  const list = await p.categories(env);
  if (list.failed) return list;
  return { categories: list.map(c => ({ ...c, name: c.name.slice(0, 60), query: c.query.slice(0, MAX_Q) })).filter(c => c.name && c.query).slice(0, 40) };
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
