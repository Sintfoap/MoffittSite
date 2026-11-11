// Feedback: anyone with the app sends the site's owner (the admins) a note: an
// idea, a bug, praise or a question, with as many photos as they like (up to
// PHOTOS_EACH) and links to the exact things it's about, picked from what they
// can see on the site: a recipe in their Recipe box, a Drift item, a pantry
// item, a board post, a trip, a Food club month, a chat room, a week of the
// Meal plan, or any web link.
//
// Feedback is private between whoever sent it and the admins. The admins read
// every note in the inbox (on the same page), mark it planned, done or closed,
// and reply; the sender sees the status and replies, and can answer back.
// Admins can always open the page, toggle or not, so the owner never misses one.
//
// A link keeps a snapshot of what it pointed at (its title, a line about it and
// a short excerpt) taken when it was added, because the admins usually can't
// open someone's own recipe or Drift item, and because the thing may be gone later.
//
// /feedback/api/feedback                       GET → {mine, inbox?, owner, kinds, statuses, sources}
// /feedback/api/linkable?app=<source>&q=<text> GET → {items: [{app, id, title, sub}]}: what you could link
// /feedback/api/items                          POST {kind, subject, message, links?} → the new note
// /feedback/api/items/<id>                     GET → the whole note; PATCH {kind?, subject?, message?, links?} (sender) or {status} (admins); DELETE
// /feedback/api/items/<id>/replies             POST {text} → the note, with your reply
// /feedback/api/items/<id>/photos              POST {type, data (base64), caption} → the note, with the photo (sender)
// /feedback/api/items/<id>/photos/<photo>      DELETE → the note, without it
// /feedback/api/photos/<photo>                 GET → the picture (sender and admins only)

import { db } from "./db.js";
import { sameOrigin } from "./account.js";
import { withRail } from "./pages.js";
import { BadRequest } from "./drift.js";
import { imageType, PHOTO_BYTES } from "./food.js";
import { feedbackPushes } from "./notify.js";

const fail = msg => { throw new BadRequest(msg); };

export const KINDS = ["idea", "bug", "praise", "question", "other"];
export const STATUSES = ["new", "planned", "done", "closed"];
export { PHOTO_BYTES };
export const PHOTOS_EACH = 12;
export const LINKS_EACH = 20;
const LIMITS = { subject: 200, message: 8000, reply: 4000, caption: 300, url: 2000, title: 200, sub: 200, detail: 400, body: 1800 * 1024 };
const ROUTE = /^\/feedback\/api\/items(?:\/(fb_[0-9a-f]{10})(?:\/(replies|photos)(?:\/(fp_[0-9a-f]{10}))?)?)?\/?$/;
const PHOTO = /^\/feedback\/api\/photos\/(fp_[0-9a-f]{10})$/;
const LINK_ID = /^[A-Za-z0-9_-]{1,40}$/;
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const NOTE = { kind: "idea", subject: "", message: "", links: [] };

function newId(prefix) {
  const b = crypto.getRandomValues(new Uint8Array(5));
  return prefix + "_" + [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

function str(f, v, max) {
  const s = String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (s.length > max) fail(`${f} is longer than ${max} characters`);
  return s;
}
const clip = (v, max) => { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return s.length > max ? s.slice(0, max - 1) + "…" : s; };
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const parse = s => { try { return JSON.parse(s || "{}") || {}; } catch { return {}; } };

// ── what can be linked ─────────────────────────────────────────────────────
// Each source is a query for the rows its app shows this account (each `?` is
// the account's id), as {id, title, data, extra}, and how to describe a row.
// Only apps the account has are offered, and a link is checked against the
// same query when it's added, so nobody can link (and so read) what they can't see.

const SOURCES = {
  recipes: { area: "recipes", name: "Recipe", app: "Recipe box",
    sql: "SELECT id, json_extract(data, '$.title') AS title, data, '' AS extra FROM recipes WHERE owner = ?",
    sub: d => hostOf(d.source) || [d.time, d.servings ? `serves ${d.servings}` : ""].filter(Boolean).join(" · "),
    detail: d => (Array.isArray(d.ingredients) ? d.ingredients.slice(0, 10).join("; ") : ""),
    href: id => `/recipes/#${id}` },
  drift: { area: "todo", name: "Drift item", app: "Drift",
    sql: `SELECT i.id, json_extract(i.data, '$.title') AS title, i.data, json_extract(c.data, '$.name') AS extra FROM drift_items i
      LEFT JOIN drift_collections c ON c.owner = i.owner AND c.id = json_extract(i.data, '$.collection')
      WHERE i.owner = ? AND COALESCE(json_extract(i.data, '$.deleted'), 0) = 0`,
    sub: (d, r) => r.extra ? `in ${r.extra}` : "", detail: d => d.notes, href: () => "/todo/" },
  pantry: { area: "pantry", name: "Pantry item", app: "Pantry",
    sql: "SELECT id, json_extract(data, '$.name') AS title, data, '' AS extra FROM pantry_items WHERE owner = ?",
    sub: d => [d.place, d.kind].filter(Boolean).join(" · "), detail: () => "", href: () => "/pantry/" },
  board: { area: "board", name: "Board post", app: "Recipe board",
    sql: `SELECT p.id, json_extract(p.data, '$.title') AS title, p.data, u.display_name AS extra FROM board_posts p
      LEFT JOIN users u ON u.id = p.author WHERE ? IS NOT NULL`,
    sub: (d, r) => r.extra ? `posted by ${r.extra}` : "", detail: d => d.note, href: () => "/board/" },
  trips: { area: "trips", name: "Trip", app: "Trip planner",
    sql: `SELECT t.id, json_extract(t.data, '$.title') AS title, t.data, '' AS extra FROM trips t
      WHERE t.owner = ? OR EXISTS (SELECT 1 FROM trip_members m WHERE m.trip = t.id AND m.user_id = ?)`,
    sub: d => [d.start, d.end].filter(Boolean).join(" to "), detail: d => d.notes, href: id => `/trips/#${id}` },
  food: { area: "food", name: "Food club month", app: "Food club",
    sql: "SELECT p.id, json_extract(p.data, '$.title') AS title, p.data, p.month AS extra FROM food_picks p WHERE ? IS NOT NULL",
    sub: (d, r) => r.extra, detail: d => d.blurb, href: id => `/food/#${id}` },
  chat: { area: "chat", name: "Chat room", app: "Chat",
    sql: `SELECT r.id, r.name AS title, '{}' AS data, r.topic AS extra FROM chat_rooms r
      WHERE r.kind IN ('open', 'private') AND (r.kind = 'open' OR EXISTS (SELECT 1 FROM chat_members m WHERE m.room = r.id AND m.user_id = ?))`,
    sub: (d, r) => r.extra || "", detail: () => "", href: id => `/chat/#${id}` },
  meals: { area: "meals", name: "Meal plan week", app: "Meal plan",
    sql: "SELECT week AS id, 'Week of ' || week AS title, data, '' AS extra FROM meal_plans WHERE owner = ?",
    sub: d => `${Object.values(d.nights || {}).filter(n => n && (n.recipe || n.out)).length} nights planned`, detail: () => "",
    href: id => `/meals/#${id}` },
};
const uses = s => s.sql.split("?").length - 1;

// The sources this account can link from: [{id, name, app}].
export const sourcesFor = user => Object.entries(SOURCES).filter(([, s]) => user.areas.has(s.area)).map(([id, s]) => ({ id, name: s.name, app: s.app }));

function sourceOf(user, app) {
  const s = SOURCES[app];
  if (!s) fail(`there's nothing called ${JSON.stringify(String(app))} to link`);
  if (!user.areas.has(s.area)) fail(`you need ${s.app} to link from it`);
  return s;
}

const describe = (app, s, r) => {
  const d = parse(r.data);
  return { app, id: r.id, title: clip(r.title || "Untitled", LIMITS.title), sub: clip(s.sub(d, r), LIMITS.sub) };
};

// Up to 30 things in one app whose title has `q` in it, for the link picker.
export async function linkable(env, user, app, q = "") {
  const s = sourceOf(user, app), d = await db(env);
  const like = "%" + String(q).trim().slice(0, 100).replace(/[\\%_]/g, c => "\\" + c) + "%";
  const { results } = await d.prepare(`SELECT * FROM (${s.sql}) WHERE COALESCE(title, '') LIKE ? ESCAPE '\\' ORDER BY title COLLATE NOCASE LIMIT 30`)
    .bind(...Array(uses(s)).fill(user.id), like).all();
  return { items: results.map(r => describe(app, s, r)) };
}

// A link as it's kept: {app, id, title, sub, detail, href} for something on the
// site, or {app: "url", url, title} for any web link.
async function snapshot(d, user, raw) {
  if (!isObj(raw)) fail("each link is an object: {app, id} or {url}");
  if (raw.app === "url" || (raw.url && !raw.app)) {
    const url = str("url", raw.url, LIMITS.url);
    let u;
    try { u = new URL(url); } catch { fail("that link isn't a web address"); }
    if (u.protocol !== "https:" && u.protocol !== "http:") fail("links start with https://");
    return { app: "url", url: u.href, title: clip(raw.title || u.hostname.replace(/^www\./, "") + (u.pathname !== "/" ? u.pathname : ""), LIMITS.title) };
  }
  const s = sourceOf(user, raw.app), id = String(raw.id ?? "");
  if (!LINK_ID.test(id)) fail("that link's id isn't right");
  const r = await d.prepare(`SELECT * FROM (${s.sql}) WHERE id = ?`).bind(...Array(uses(s)).fill(user.id), id).first();
  if (!r) fail(`that ${s.name.toLowerCase()} isn't one you can see`);
  return { ...describe(raw.app, s, r), detail: clip(s.detail(parse(r.data)), LIMITS.detail), href: s.href(r.id) };
}

// The links sent, each checked; ones already on the note are kept as they were.
async function cleanLinks(d, user, list, before = []) {
  if (!Array.isArray(list)) fail("links must be a list");
  if (list.length > LINKS_EACH) fail(`a note can link at most ${LINKS_EACH} things`);
  const key = l => l.app === "url" ? "url " + l.url : `${l.app} ${l.id}`;
  const had = new Map(before.map(l => [key(l), l]));
  const out = new Map();
  for (const raw of list) {
    const k = isObj(raw) ? (raw.app === "url" || (raw.url && !raw.app) ? null : `${raw.app} ${raw.id}`) : null;
    const l = k && had.has(k) ? had.get(k) : await snapshot(d, user, raw);
    out.set(key(l), l);
  }
  return [...out.values()];
}

function cleanNote(body) {
  if (!isObj(body)) fail("body must be a JSON object");
  const out = {};
  for (const [f, v] of Object.entries(body)) {
    switch (f) {
      case "kind": out.kind = String(v ?? ""); if (!KINDS.includes(out.kind)) fail(`kind is one of ${KINDS.join(", ")}`); break;
      case "subject": out.subject = str(f, v, LIMITS.subject); break;
      case "message": out.message = str(f, v, LIMITS.message); break;
      case "links": out.links = v ?? []; break;
      case "status": out.status = String(v ?? ""); if (!STATUSES.includes(out.status)) fail(`status is one of ${STATUSES.join(", ")}`); break;
      default: fail(`unknown field ${JSON.stringify(f)}`);
    }
  }
  return out;
}

// ── reading ────────────────────────────────────────────────────────────────

const isAdmin = user => user.areas.has("admin");
const nameOf = r => r.display_name || r.username || "A former member";

async function row(d, id) {
  return d.prepare(`SELECT f.*, u.username, u.display_name FROM feedback f LEFT JOIN users u ON u.id = f.author WHERE f.id = ?`).bind(id).first();
}
const canSee = (user, r) => r && (r.author === user.id || isAdmin(user));

// One line per note: what the lists show.
function summary(user, r) {
  const data = { ...NOTE, ...parse(r.data) };
  const owner = isAdmin(user);
  // Unread: for the sender, a reply from the admins since they last looked; for the admins, anything since they did.
  const seen = r.author === user.id ? r.author_seen : r.owner_seen;
  return { id: r.id, kind: data.kind, subject: data.subject || clip(data.message, 80) || "(no words)", status: r.status,
    by: nameOf(r), yours: r.author === user.id, created: r.created, last_at: r.last_at,
    photos: r.photos, links: data.links.length, replies: r.replies,
    unread: r.author === user.id ? !!(r.last_reply_by_owner && (!seen || seen < r.last_at)) : owner ? !seen || seen < r.last_at : false };
}

const LIST_SQL = `SELECT f.*, u.username, u.display_name,
    (SELECT COUNT(*) FROM feedback_photos p WHERE p.item = f.id) AS photos,
    (SELECT COUNT(*) FROM feedback_replies x WHERE x.item = f.id) AS replies,
    (SELECT x.user_id != f.author FROM feedback_replies x WHERE x.item = f.id ORDER BY x.created DESC LIMIT 1) AS last_reply_by_owner
  FROM feedback f LEFT JOIN users u ON u.id = f.author`;

export async function listMine(env, user) {
  const { results } = await (await db(env)).prepare(`${LIST_SQL} WHERE f.author = ? ORDER BY f.last_at DESC`).bind(user.id).all();
  return results.map(r => summary(user, r));
}

export async function listInbox(env, user) {
  if (!isAdmin(user)) return null;
  const { results } = await (await db(env)).prepare(`${LIST_SQL} ORDER BY f.last_at DESC`).all();
  return results.map(r => summary(user, r));
}

// How many notes wait for this account: new to the admins, or answered for a sender.
export async function waiting(env, user) {
  const list = isAdmin(user) ? await listInbox(env, user) : await listMine(env, user);
  return list.filter(n => n.unread).length;
}

export async function getNote(env, user, id, { look = false } = {}) {
  const d = await db(env);
  const r = await row(d, id);
  if (!canSee(user, r)) return null;
  // Opening it counts as reading it, for whichever side you're on.
  if (look) {
    const col = r.author === user.id ? "author_seen" : "owner_seen";
    await d.prepare(`UPDATE feedback SET ${col} = ? WHERE id = ?`).bind(new Date().toISOString(), id).run();
  }
  const data = { ...NOTE, ...parse(r.data) };
  const { results: photos } = await d.prepare("SELECT id, caption, created FROM feedback_photos WHERE item = ? ORDER BY created").bind(id).all();
  const { results: replies } = await d.prepare(`SELECT x.id, x.user_id, x.text, x.created, u.username, u.display_name FROM feedback_replies x
    LEFT JOIN users u ON u.id = x.user_id WHERE x.item = ? ORDER BY x.created`).bind(id).all();
  const mine = r.author === user.id;
  return {
    id, ...data, links: data.links.map(l => ({ ...l, what: l.app === "url" ? "Link" : SOURCES[l.app]?.name || l.app })), status: r.status, by: nameOf(r), username: r.username || "", yours: mine, owner: isAdmin(user),
    created: r.created, updated: r.updated, last_at: r.last_at, seen_by_owner: !!r.owner_seen,
    can_edit: mine, can_add_photos: mine, can_set_status: isAdmin(user), can_delete: mine || isAdmin(user),
    photos: photos.map(p => ({ ...p, can_remove: mine || isAdmin(user) })),
    replies: replies.map(x => ({ id: x.id, by: nameOf(x), yours: x.user_id === user.id, from_owner: x.user_id !== r.author, text: x.text, created: x.created })),
  };
}

// ── changing ───────────────────────────────────────────────────────────────

export async function createNote(env, user, body, later = p => p) {
  const d = await db(env);
  const { status, links = [], ...rest } = cleanNote(body);
  if (status) fail("a new note's status is always new");
  const data = { ...NOTE, ...rest, links: await cleanLinks(d, user, links) };
  if (!data.message && !data.subject) fail("say what it's about");
  const id = newId("fb"), t = new Date().toISOString();
  await d.prepare("INSERT INTO feedback (id, author, data, status, created, updated, last_at, author_seen) VALUES (?, ?, ?, 'new', ?, ?, ?, ?)")
    .bind(id, user.id, JSON.stringify(data), t, t, t, t).run();
  await later(feedbackPushes(env, { to: "owner", from: user, note: { id, subject: data.subject || clip(data.message, 80) }, text: data.message })
    .catch(e => console.error("feedback pushes failed:", e)));
  return getNote(env, user, id);
}

export async function updateNote(env, user, id, body) {
  const d = await db(env);
  const r = await row(d, id);
  if (!canSee(user, r)) return null;
  const { status, links, ...rest } = cleanNote(body);
  const mine = r.author === user.id;
  if (status !== undefined && !isAdmin(user)) fail("only the site's admins set a note's status");
  if ((links !== undefined || Object.keys(rest).length) && !mine) fail("only whoever sent it can change what it says");
  const before = { ...NOTE, ...parse(r.data) };
  const data = { ...before, ...rest, ...(links !== undefined ? { links: await cleanLinks(d, user, links, before.links) } : {}) };
  if (!data.message && !data.subject) fail("say what it's about");
  const t = new Date().toISOString();
  await d.prepare("UPDATE feedback SET data = ?, status = ?, updated = ? WHERE id = ?").bind(JSON.stringify(data), status || r.status, t, id).run();
  return getNote(env, user, id);
}

export async function deleteNote(env, user, id) {
  const d = await db(env);
  const r = await row(d, id);
  if (!canSee(user, r)) return null;
  await d.batch(["feedback_photos", "feedback_replies"].map(t => d.prepare(`DELETE FROM ${t} WHERE item = ?`).bind(id))
    .concat(d.prepare("DELETE FROM feedback WHERE id = ?").bind(id)));
  return { removed: true };
}

export async function reply(env, user, id, body, later = p => p) {
  if (!isObj(body)) fail("body must be a JSON object");
  for (const k of Object.keys(body)) if (k !== "text") fail(`unknown field ${JSON.stringify(k)}`);
  const d = await db(env);
  const r = await row(d, id);
  if (!canSee(user, r)) return null;
  const text = str("text", body.text, LIMITS.reply);
  if (!text) fail("say something");
  const t = new Date().toISOString(), mine = r.author === user.id;
  await d.batch([
    d.prepare("INSERT INTO feedback_replies (id, item, user_id, text, created) VALUES (?, ?, ?, ?, ?)").bind(newId("fr"), id, user.id, text, t),
    d.prepare(`UPDATE feedback SET last_at = ?, ${mine ? "author_seen" : "owner_seen"} = ? WHERE id = ?`).bind(t, t, id),
  ]);
  const subject = parse(r.data).subject || clip(parse(r.data).message, 80);
  await later(feedbackPushes(env, { to: mine ? "owner" : r.author, from: user, note: { id, subject }, text, reply: true })
    .catch(e => console.error("feedback pushes failed:", e)));
  return getNote(env, user, id);
}

function decode(data) {
  const s = String(data ?? "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!s || !/^[A-Za-z0-9+/]+=*$/.test(s)) fail("send the photo as base64");
  try { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); } catch { fail("send the photo as base64"); }
}

export async function addPhoto(env, user, id, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  const d = await db(env);
  const r = await row(d, id);
  if (!canSee(user, r)) return null;
  if (r.author !== user.id) fail("only whoever sent it can add photos to it");
  const bytes = decode(body.data);
  if (bytes.length > PHOTO_BYTES) fail(`that photo is too big (at most ${Math.round(PHOTO_BYTES / 1024)} KB); make it smaller first`);
  const type = imageType(bytes);
  if (!type) fail("that isn't a JPEG, PNG, WebP or GIF picture");
  const caption = str("caption", body.caption, LIMITS.caption);
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM feedback_photos WHERE item = ?").bind(id).first();
  if (n >= PHOTOS_EACH) fail(`a note can have at most ${PHOTOS_EACH} photos`);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const t = new Date().toISOString();
  await d.batch([
    d.prepare("INSERT INTO feedback_photos (id, item, type, data, caption, created) VALUES (?, ?, ?, ?, ?, ?)").bind(newId("fp"), id, type, btoa(bin), caption, t),
    d.prepare("UPDATE feedback SET updated = ? WHERE id = ?").bind(t, id),
  ]);
  return getNote(env, user, id);
}

export async function removePhoto(env, user, id, photo) {
  const d = await db(env);
  const r = await row(d, id);
  if (!canSee(user, r)) return null;
  const res = await d.prepare("DELETE FROM feedback_photos WHERE id = ? AND item = ?").bind(photo, id).run();
  return res.meta.changes ? getNote(env, user, id) : null;
}

async function photoFile(env, user, photo) {
  const d = await db(env);
  const p = await d.prepare("SELECT p.type, p.data, f.author FROM feedback_photos p JOIN feedback f ON f.id = p.item WHERE p.id = ?").bind(photo).first();
  if (!p || (p.author !== user.id && !isAdmin(user))) return new Response("not found", { status: 404 });
  return new Response(Uint8Array.from(atob(p.data), c => c.charCodeAt(0)), { headers: {
    "Content-Type": p.type, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'",
    "Content-Disposition": "inline", "Cache-Control": "private, max-age=31536000, immutable",
  } });
}

// ── the page and its API ───────────────────────────────────────────────────

const PAGE_CSP = [
  "default-src 'none'", "script-src 'self'", "connect-src 'self'", "manifest-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com", "img-src 'self' data: blob:",
  "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function readBody(request) {
  const text = await request.text();
  if (text.length > LIMITS.body) fail("that's too big to send");
  if (!text) return {};
  try { return JSON.parse(text); } catch { fail("invalid JSON"); }
}

export async function feedback(request, env, user, pathname, ctx) {
  if (!pathname.startsWith("/feedback/api/")) {
    const asset = await withRail(await env.ASSETS.fetch(request), user, "feedback");
    const res = new Response(asset.body, asset);
    if ((res.headers.get("Content-Type") || "").startsWith("text/html")) {
      res.headers.set("Content-Security-Policy", PAGE_CSP);
      res.headers.set("X-Content-Type-Options", "nosniff");
      res.headers.set("Referrer-Policy", "no-referrer");
    }
    return res;
  }
  const later = ctx ? p => ctx.waitUntil(p) : p => p;
  const method = request.method;
  try {
    if (method !== "GET" && !sameOrigin(request)) return json({ error: "cross-origin request refused" }, 403);
    const notAllowed = () => json({ error: "method not allowed" }, 405);
    if (pathname === "/feedback/api/feedback") {
      if (method !== "GET") return notAllowed();
      return json({ mine: await listMine(env, user), inbox: await listInbox(env, user), owner: isAdmin(user),
        kinds: KINDS, statuses: STATUSES, sources: sourcesFor(user), photos_each: PHOTOS_EACH, links_each: LINKS_EACH });
    }
    if (pathname === "/feedback/api/linkable") {
      if (method !== "GET") return notAllowed();
      const q = new URL(request.url).searchParams;
      return json(await linkable(env, user, q.get("app") || "", q.get("q") || ""));
    }
    const ph = pathname.match(PHOTO);
    if (ph) return method === "GET" ? photoFile(env, user, ph[1]) : notAllowed();
    const m = pathname.match(ROUTE);
    if (!m) return json({ error: "not found" }, 404);
    const [, id, sub, photo] = m;
    if (!id) return method === "POST" ? json(await createNote(env, user, await readBody(request), later), 201) : notAllowed();
    let out;
    if (!sub) {
      if (method === "GET") out = await getNote(env, user, id, { look: true });
      else if (method === "PATCH") out = await updateNote(env, user, id, await readBody(request));
      else if (method === "DELETE") out = await deleteNote(env, user, id);
    } else if (sub === "replies" && !photo) {
      if (method === "POST") out = await reply(env, user, id, await readBody(request), later);
    } else if (sub === "photos") {
      if (!photo && method === "POST") out = await addPhoto(env, user, id, await readBody(request));
      else if (photo && method === "DELETE") out = await removePhoto(env, user, id, photo);
    }
    if (out === undefined) return notAllowed();
    return out ? json(out) : json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    console.error("feedback error:", e);
    return json({ error: "server error" }, 500);
  }
}
