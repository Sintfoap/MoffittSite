// Recipe box's share links: a recipe anyone can read without signing in, at
// /r/<token>, for sending to someone who isn't on the site.
//
// The owner makes the link (one per recipe; asking again gives the same one)
// and can turn it off, which makes the old address a "not found" for good; a
// new link after that is a new address. Deleting the recipe or the account
// turns it off too. The token is 24 random bytes, so links can't be guessed.
//
// The page shows the recipe as it is now (edits show up), read-only: its
// title, picture, times, ingredients, steps, notes, labels and where it came
// from. Nothing else of the owner's: no ids, dates, who they are, or anything
// they've marked on it for themselves. PUBLIC_FIELDS is the whole list, so a
// field added to recipes later stays private until it's added here.
//
// /recipes/api/recipes/<id>/share   GET → {share: "/r/<token>" | null}; POST → {share} (made if there isn't one); DELETE → {share: null}
// /r/<token>                        GET → the page
// /r/<token>/photo                  GET → its picture, when it's one kept here

import { db } from "./db.js";
import { esc } from "./pages.js";
import { RECIPE, labelList, withLabels } from "./recipes.js";
import { photoResponse } from "./photos.js";
import { format } from "../public/recipes/scale.js";

export const SHARE_PATHS = /^\/r\/[^/]*(?:\/photo)?\/?$/;
const PUBLIC = /^\/r\/([A-Za-z0-9_-]{32})(\/photo)?\/?$/;
const OWN_PHOTO = /^\/recipes\/api\/photos\/(p_[0-9a-f]{10})$/;
export const PUBLIC_FIELDS = ["title", "image", "source", "yield", "servings", "time", "ingredients", "steps", "notes", "labels"];

export const sharePath = token => `/r/${token}`;

function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_");
}

// recipe id → "/r/<token>", for the recipes the user has shared by link.
export async function sharesOf(d, owner) {
  const { results } = await d.prepare("SELECT recipe, token FROM recipe_shares WHERE owner = ?").bind(owner).all();
  return new Map(results.map(r => [r.recipe, sharePath(r.token)]));
}

const owns = (d, owner, id) => d.prepare("SELECT 1 AS ok FROM recipes WHERE owner = ? AND id = ?").bind(owner, id).first();

export async function getShare(env, user, id) {
  const d = await db(env);
  if (!await owns(d, user.id, id)) return null;
  return { share: (await sharesOf(d, user.id)).get(id) || null };
}

export async function makeShare(env, user, id) {
  const d = await db(env);
  if (!await owns(d, user.id, id)) return null;
  await d.prepare("INSERT OR IGNORE INTO recipe_shares (token, owner, recipe, created) VALUES (?, ?, ?, ?)")
    .bind(newToken(), user.id, id, new Date().toISOString()).run();
  return { share: (await sharesOf(d, user.id)).get(id) };
}

export async function stopShare(env, user, id) {
  const d = await db(env);
  if (!await owns(d, user.id, id)) return null;
  await d.prepare("DELETE FROM recipe_shares WHERE owner = ? AND recipe = ?").bind(user.id, id).run();
  return { share: null };
}

// The recipe behind a token, cut down to PUBLIC_FIELDS, or null.
export async function sharedRecipe(d, token) {
  const row = await d.prepare(`SELECT r.owner, r.id, r.data FROM recipe_shares s JOIN recipes r ON r.owner = s.owner AND r.id = s.recipe
    WHERE s.token = ?`).bind(token).first();
  if (!row) return null;
  const all = { ...RECIPE, ...JSON.parse(row.data) };
  const out = Object.fromEntries(PUBLIC_FIELDS.map(k => [k, all[k] ?? RECIPE[k]]));
  out.labels = withLabels(await labelList(d), out.labels).map(({ key, value }) => ({ key, value }));
  return { recipe: out, owner: row.owner, id: row.id };
}

// ── the public page ────────────────────────────────────────────────────────

// Pictures from recipe sites are linked straight from them; no-referrer keeps the link's address to itself.
const CSP = [
  "default-src 'none'", "style-src 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
  "img-src 'self' https:", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
].join("; ");
const HEADERS = {
  "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow",
};

const STYLE = `
:root { color-scheme: light;
  --bg:#f2f0e6; --panel:#fbfaf4; --line:#cfc9b0; --gold:#8a6510; --gold-soft:#e9e1c2; --ink:#1c1d16; --muted:#4d4c3f; --faint:#7a7764;
  --mono:'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace; }
@media (prefers-color-scheme: dark) { :root { color-scheme: dark;
  --bg:#0b0f0a; --panel:#121a12; --line:#4a4430; --gold:#d6ae5e; --gold-soft:#24251a; --ink:#f4efe6; --muted:#c6bcab; --faint:#8a8270; } }
* { box-sizing: border-box; }
html, body { margin: 0; }
body { min-height: 100vh; background: var(--bg); color: var(--ink); font: 400 15px/1.65 var(--mono); -webkit-font-smoothing: antialiased; }
a { color: var(--gold); }
main { max-width: 760px; margin: 0 auto; padding: 32px 16px 56px; }
.kicker { font: 700 12px var(--mono); letter-spacing: .5em; color: var(--gold); text-transform: uppercase; }
h1 { font: 700 clamp(22px, 5vw, 32px)/1.25 var(--mono); margin: 10px 0 8px; overflow-wrap: anywhere; }
h2 { font: 400 11px var(--mono); letter-spacing: 3px; text-transform: uppercase; color: var(--faint); margin: 26px 0 8px; }
.card { position: relative; background: var(--panel); border: 1px solid var(--line); padding: 22px clamp(16px, 4vw, 28px); }
.card::before { content: ""; position: absolute; inset: 4px; border: 1px solid var(--line); pointer-events: none; }
.card > * { position: relative; }
.hero { display: block; width: 100%; max-height: 420px; object-fit: cover; border: 1px solid var(--line); margin-bottom: 18px; }
.facts { color: var(--muted); font-size: 13.5px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.chip { border: 1px solid var(--line); background: var(--gold-soft); padding: 1px 8px; font-size: 12.5px; }
.chip b { color: var(--gold); margin-right: 6px; }
ul.ingredients { list-style: none; padding: 0; margin: 0; }
ul.ingredients li { padding: 4px 0; border-bottom: 1px dashed var(--line); }
ul.ingredients li:last-child { border-bottom: 0; }
ol.steps { padding-left: 1.6em; margin: 0; }
ol.steps li { margin-bottom: 10px; }
ol.steps li::marker { color: var(--gold); font-weight: 700; }
.notes { white-space: pre-wrap; color: var(--muted); margin: 0; }
footer { margin-top: 22px; color: var(--faint); font-size: 12.5px; }
.empty { color: var(--faint); }`;

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">`;
const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">
<link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" href="/favicon.svg" type="image/svg+xml">${FONTS}<style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;

const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

export function sharePage(r, token) {
  const own = OWN_PHOTO.test(r.image);
  const img = own ? `${sharePath(token)}/photo` : /^https:\/\//.test(r.image) ? r.image : "";
  const facts = [r.time, r.servings ? `Serves ${format(r.servings)}` : "", r.yield && !/^\d+(\.\d+)?$/.test(r.yield) ? r.yield : ""].filter(Boolean).map(esc);
  if (/^https?:\/\//.test(r.source)) facts.push(`<a href="${esc(r.source)}" rel="noopener noreferrer nofollow">${esc(hostOf(r.source) || "source")}</a>`);
  const body = `<div class="kicker">Recipe</div>
<article class="card">
  ${img ? `<img class="hero" src="${esc(img)}" alt="" referrerpolicy="no-referrer">` : ""}
  <h1>${esc(r.title)}</h1>
  ${facts.length ? `<div class="facts">${facts.join(" · ")}</div>` : ""}
  ${r.labels.length ? `<div class="chips">${r.labels.map(l => `<span class="chip"><b>${esc(l.key)}</b>${esc(l.value)}</span>`).join("")}</div>` : ""}
  <h2>Ingredients</h2>
  ${r.ingredients.length ? `<ul class="ingredients">${r.ingredients.map(l => `<li>${esc(l)}</li>`).join("")}</ul>` : `<p class="empty">No ingredients listed.</p>`}
  ${r.steps.length ? `<h2>Steps</h2><ol class="steps">${r.steps.map(s => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
  ${r.notes ? `<h2>Notes</h2><p class="notes">${esc(r.notes)}</p>` : ""}
</article>
<footer>Shared from a Recipe box on <a href="/">sintfoap.xyz</a>. No account needed to read it.</footer>`;
  return shell(`${r.title} · Recipe`, body);
}

const gone = () => new Response(shell("Recipe not found", `<div class="kicker">Recipe</div><h1>This link doesn't work</h1>
<p class="facts">Whoever shared it may have turned the link off, or deleted the recipe. Ask them for a new one.</p>
<footer><a href="/">sintfoap.xyz</a></footer>`), { status: 404, headers: HEADERS });

// Everything under /r/, for anyone: no session is looked at.
export async function sharedPage(request, env, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const m = pathname.match(PUBLIC);
  if (!m) return gone();
  const d = await db(env);
  const found = await sharedRecipe(d, m[1]);
  if (!found) return gone();
  if (m[2]) {
    // Only the recipe's own picture, never another photo by id.
    const p = OWN_PHOTO.exec(found.recipe.image);
    const row = p && await d.prepare("SELECT id, type, data FROM recipe_photos WHERE id = ? AND owner = ? AND recipe = ?").bind(p[1], found.owner, found.id).first();
    if (!row) return new Response("not found", { status: 404 });
    const res = await photoResponse(env, "recipe_photos", row);
    // A turned-off link's picture shouldn't linger in caches either.
    if (res.ok) res.headers.set("Cache-Control", "no-store");
    return res;
  }
  return new Response(request.method === "HEAD" ? null : sharePage(found.recipe, m[1]), { headers: HEADERS });
}
