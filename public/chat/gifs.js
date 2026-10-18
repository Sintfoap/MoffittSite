// The GIF picker, after Discord's: a search box over a grid. Before you type,
// the grid is tiles: your favorites, what's trending, then categories; a
// tile opens its GIFs, and ← goes back. Results come in two columns, more as
// you scroll. Clicking a GIF sends it (shift-click keeps the picker open), and
// the star on each one keeps it in your favorites, which the terminal shares.
// Ctrl+G opens and closes it; ↓ from the search box goes into the grid,
// arrows move, enter sends, esc closes.
//
// A GIF is sent as a message whose whole text is its link (src/gifs.js), and
// the chat page shows such messages as the picture.

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SEARCH_WAIT = 300;   // ms after the last keypress before searching

let info = { ready: false, hosts: [] };
let api, send, toast;
let favs = [];             // your favorites, newest first
let favsLoaded = null;     // Promise while loading
let categories = null;     // [{name, query, preview}] once loaded
let trendingPreview = null;
let view = { kind: "home" };   // home | search {q} | trending | favorites | category {name, q}
let items = [], next = null, loading = false, token = 0, searchTimer;

export function setupGifs(state, deps) {
  info = state || { ready: false, hosts: [] };
  ({ api, send, toast } = deps);
  if (info.ready && !favsLoaded) loadFavorites();
}
export const gifsReady = () => !!info.ready;

// A message whose whole text is a GIF link from the GIF hosts.
export function isGifMessage(body) {
  if (!info.hosts?.length || typeof body !== "string" || /\s/.test(body.trim()) || !body) return false;
  let u;
  try { u = new URL(body.trim()); } catch { return false; }
  const host = u.hostname.toLowerCase();
  return u.protocol === "https:" && !u.port && !u.username && info.hosts.some(h => host === h || host.endsWith("." + h)) && /\.(gif|webp)$/i.test(u.pathname);
}
export const isFavorite = url => favs.some(f => f.url === url);

export function gifMessageHtml(m) {
  const url = m.body.trim();
  return `<a class="gif-msg" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(url)}" alt="GIF" loading="lazy" referrerpolicy="no-referrer"></a>`;
}

function loadFavorites() {
  favsLoaded = api("GET", "/gifs/favorites").then(r => { favs = r.favorites || []; }).catch(() => { favsLoaded = null; });
  return favsLoaded;
}

export async function toggleFavorite(gif) {
  const on = !isFavorite(gif.url);
  const r = await api("POST", "/gifs/favorites", { gif: { url: gif.url, preview: gif.preview || gif.url, width: gif.width ?? null, height: gif.height ?? null, title: gif.title || "" }, on });
  favs = r.favorites || [];
  if (isOpen()) { if (view.kind === "favorites") { items = favs; draw(); } else markStars(); }
  return on;
}

// ── the popover ──────────────────────────────────────────────────────────

const el = () => document.getElementById("gifs");
export const isOpen = () => !!el() && !el().hidden;

export function openGifs() {
  const box = el();
  if (!box || !info.ready) return;
  box.innerHTML = `
    <div class="gif-head">
      <button type="button" class="link gif-back" id="gif-back" aria-label="Back" hidden>←</button>
      <span class="gif-title" id="gif-title" hidden></span>
      <input id="gif-q" type="search" maxlength="100" placeholder="Search ${esc(info.provider || "GIFs")}" aria-label="Search GIFs" autocomplete="off" spellcheck="false">
    </div>
    <div class="gif-body" id="gif-body" tabindex="-1"></div>
    <div class="gif-foot">Powered by ${esc(info.provider || "the GIF service")}</div>`;
  box.hidden = false;
  document.getElementById("gif-open")?.setAttribute("aria-expanded", "true");
  document.getElementById("gif-body").addEventListener("scroll", onScroll);
  go({ kind: "home" });
  document.getElementById("gif-q").focus();
}

export function closeGifs({ focus = true } = {}) {
  const box = el();
  if (!box || box.hidden) return;
  box.hidden = true; box.innerHTML = "";
  clearTimeout(searchTimer); token++;
  document.getElementById("gif-open")?.setAttribute("aria-expanded", "false");
  if (focus) document.getElementById("text")?.focus();
}
export const toggleGifs = () => isOpen() ? closeGifs() : openGifs();

async function go(v) {
  view = v; items = []; next = null;
  const my = ++token;
  const sub = v.kind !== "home" && v.kind !== "search";
  document.getElementById("gif-back").hidden = !sub;
  const title = document.getElementById("gif-title"), q = document.getElementById("gif-q");
  title.hidden = !sub; q.hidden = sub;
  title.textContent = v.kind === "favorites" ? "Favorites" : v.kind === "trending" ? "Trending GIFs" : v.kind === "category" ? v.name : "";
  document.getElementById("gif-body").scrollTop = 0;
  if (v.kind === "home") return home(my);
  if (v.kind === "favorites") {
    await (favsLoaded || loadFavorites());
    if (my !== token) return;
    items = favs;
    return draw();
  }
  drawLoading();
  await more(my);
}

async function home(my) {
  drawHome();
  const want = [];
  if (!categories) want.push(api("GET", "/gifs/categories").then(r => { categories = r.categories || []; }).catch(err => { categories = []; toast(err.message); }));
  if (!trendingPreview) want.push(api("GET", "/gifs").then(r => { trendingPreview = r.results?.[0]?.preview || ""; }).catch(() => {}));
  if (!favsLoaded) want.push(loadFavorites());
  await Promise.all(want);
  if (my === token && view.kind === "home") drawHome();
}

async function more(my = token) {
  if (loading || (items.length && !next)) return;
  loading = true;
  try {
    const q = view.kind === "trending" ? "" : view.q;
    const r = await api("GET", `/gifs?q=${encodeURIComponent(q || "")}${next ? `&pos=${encodeURIComponent(next)}` : ""}`);
    if (my !== token) return;
    const seen = new Set(items.map(g => g.url));
    items = items.concat((r.results || []).filter(g => !seen.has(g.url)));
    next = r.next && r.results?.length ? r.next : null;
    draw();
  } catch (err) {
    if (my === token) { toast(err.message); draw(); }
  } finally { loading = false; }
}

function onScroll(e) {
  const b = e.target;
  if (view.kind !== "home" && view.kind !== "favorites" && next && b.scrollHeight - b.scrollTop - b.clientHeight < 300) more();
}

function drawLoading() {
  document.getElementById("gif-body").innerHTML = `<div class="gif-cols">${[0, 1].map(() => `<div class="gif-col">${"<i class='gif-ghost'></i>".repeat(4)}</div>`).join("")}</div>`;
}

function drawHome() {
  const body = document.getElementById("gif-body");
  if (!body) return;
  const tile = (attrs, name, img, extra = "") =>
    `<button type="button" class="gif-tile${extra}" ${attrs}>${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}<span>${name}</span></button>`;
  body.innerHTML = `<div class="gif-tiles">
    ${tile(`data-view="favorites"`, "★ Favorites", favs[0]?.preview, " fav")}
    ${tile(`data-view="trending"`, "↗ Trending GIFs", trendingPreview)}
    ${(categories || []).map(c => tile(`data-cat="${esc(c.query)}" data-name="${esc(c.name)}"`, esc(c.name), c.preview)).join("")}
    ${categories ? "" : "<i class='gif-ghost tile'></i>".repeat(6)}
  </div>`;
}

// Two columns, each GIF going to the shorter one, as Discord lays them out.
function draw() {
  const body = document.getElementById("gif-body");
  if (!body) return;
  if (!items.length) {
    body.innerHTML = `<div class="gif-empty">${view.kind === "favorites" ? "<b>No favorites yet</b>Star a GIF here, or on one in the chat, to keep it." : "<b>No GIFs found</b>Try another search."}</div>`;
    return;
  }
  const cols = [[], []], h = [0, 0];
  items.forEach((g, i) => {
    const c = h[0] <= h[1] ? 0 : 1;
    cols[c].push(i);
    h[c] += g.width && g.height ? g.height / g.width : 0.75;
  });
  body.innerHTML = `<div class="gif-cols">${cols.map((list, c) => `<div class="gif-col">${list.map(i => {
    const g = items[i], ratio = g.width && g.height ? `${g.width} / ${g.height}` : "4 / 3";
    return `<div class="gif-cell" style="aspect-ratio:${ratio}">
      <button type="button" class="gif-item" data-i="${i}" data-col="${c}" title="${esc(g.title || "GIF")}" aria-label="Send ${esc(g.title || "GIF")}"><img src="${esc(g.preview)}" alt="" loading="lazy" referrerpolicy="no-referrer"></button>
      <button type="button" class="gif-star" data-star="${i}" aria-pressed="${isFavorite(g.url)}" aria-label="Favorite" title="${isFavorite(g.url) ? "Remove from favorites" : "Add to favorites"}">★</button>
    </div>`;
  }).join("")}</div>`).join("")}</div>${next ? `<div class="gif-more">Loading more…</div>` : ""}`;
  // A short first page shouldn't leave the scroll with nothing to trigger it.
  if (next && body.scrollHeight <= body.clientHeight + 300) more();
}

function markStars() {
  for (const b of document.querySelectorAll("#gifs [data-star]")) {
    const on = isFavorite(items[Number(b.dataset.star)]?.url);
    b.setAttribute("aria-pressed", String(on));
    b.title = on ? "Remove from favorites" : "Add to favorites";
  }
}

// ── events (wired by the chat page on #room) ─────────────────────────────

export async function onGifClick(e) {
  const t = e.target;
  if (!t.closest("#gifs")) return false;
  if (t.closest("#gif-back")) { go({ kind: "home" }); document.getElementById("gif-q").value = ""; document.getElementById("gif-q").focus(); }
  else if (t.closest("[data-view]")) go({ kind: t.closest("[data-view]").dataset.view });
  else if (t.closest("[data-cat]")) { const b = t.closest("[data-cat]"); go({ kind: "category", name: b.dataset.name, q: b.dataset.cat }); }
  else if (t.closest("[data-star]")) {
    try { await toggleFavorite(items[Number(t.closest("[data-star]").dataset.star)]); } catch (err) { toast(err.message); }
  }
  else if (t.closest(".gif-item")) {
    const g = items[Number(t.closest(".gif-item").dataset.i)];
    if (!g) return true;
    if (!e.shiftKey) closeGifs();
    send(g.url);
  }
  return true;
}

export function onGifInput(e) {
  if (e.target.id !== "gif-q") return false;
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => go(q ? { kind: "search", q } : { kind: "home" }), q ? SEARCH_WAIT : 0);
  return true;
}

export function onGifKey(e) {
  if (!isOpen()) return false;
  if (e.key === "Escape") {
    e.preventDefault(); e.stopPropagation();
    if (view.kind !== "home" && view.kind !== "search") { go({ kind: "home" }); document.getElementById("gif-q").focus(); }
    else closeGifs();
    return true;
  }
  if (!e.target.closest?.("#gifs")) return false;
  const q = e.target.id === "gif-q";
  if (q && e.key === "Enter") {
    e.preventDefault();
    clearTimeout(searchTimer);
    const v = e.target.value.trim();
    if (v && !(view.kind === "search" && view.q === v)) go({ kind: "search", q: v });
    else focusFirst();
    return true;
  }
  if (q && e.key === "ArrowDown") { e.preventDefault(); focusFirst(); return true; }
  if (!e.key.startsWith("Arrow")) return false;
  const all = [...document.querySelectorAll("#gifs .gif-item, #gifs .gif-tile")];
  const at = all.indexOf(document.activeElement);
  if (at < 0) return false;
  e.preventDefault();
  const cur = all[at], r = cur.getBoundingClientRect();
  let pick;
  if (cur.classList.contains("gif-tile")) {
    pick = all[at + ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2 }[e.key])];
  } else {
    const col = cur.dataset.col, same = all.filter(b => b.dataset.col === col), i = same.indexOf(cur);
    if (e.key === "ArrowUp") pick = same[i - 1];
    else if (e.key === "ArrowDown") pick = same[i + 1];
    else {
      // The GIF in the other column nearest this one's middle.
      const other = all.filter(b => b.dataset.col !== col), mid = (r.top + r.bottom) / 2;
      const wantLeft = e.key === "ArrowLeft";
      if ((col === "0") !== wantLeft) pick = other.reduce((best, b) => {
        const br = b.getBoundingClientRect(), d = Math.abs((br.top + br.bottom) / 2 - mid);
        return !best || d < best.d ? { b, d } : best;
      }, null)?.b;
    }
  }
  if (pick) { pick.focus(); pick.scrollIntoView({ block: "nearest" }); }
  else if (e.key === "ArrowUp") document.getElementById("gif-q")?.focus();
  return true;
}

function focusFirst() {
  const first = document.querySelector("#gifs .gif-item, #gifs .gif-tile");
  first?.focus();
}
