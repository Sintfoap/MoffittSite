// Recipe board: the categories down the side (star one to follow it), and
// the posts of whichever view or category is open beside them, newest first.
// Your feed is the categories you follow. Any post can be saved into your
// Recipe box. The Worker side is src/board.js.

const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter(k => k != null && k !== false));
  return n;
};

const VIEWS = [
  { id: "feed", name: "Your feed", blurb: "New recipes in the categories you follow." },
  { id: "all", name: "Everything", blurb: "Every recipe on the board." },
  { id: "mine", name: "Shared by you", blurb: "The recipes you've posted." },
  { id: "saved", name: "Saved", blurb: "Recipes you've saved to your Recipe box." },
];

let board = null;      // GET /board/api/board: {categories, recipe_box, recipes, unread}
let at = { view: "feed", category: "" };
let posts = [], more = false;
let openId = null, focus = -1;
let editing = null;    // the post in the editor, or {} for a new one

async function api(method, path, body) {
  const res = await fetch("/board/api/" + path, {
    method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname); throw new Error("not signed in"); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(out.error || `the site answered ${res.status}`), { manual: out.manual });
  return out;
}

function say(kind, text, link) {
  for (const k of ["error", "done"]) {
    const box = $("#" + k);
    box.hidden = k !== kind || !text;
    if (k === kind) { box.replaceChildren(text || ""); if (link) box.append(" ", link); }
  }
}
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
async function run(fn) {
  say("error", "");
  try { await fn(); } catch (e) { say("error", cap(e.message || String(e))); return e; }
}

const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} day${s < 86400 * 2 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
// Your local date, so the recipe of the day changes at your midnight.
const today = () => new Date().toLocaleDateString("sv");
const loadBoard = () => api("GET", "board?day=" + today());
let featuredOpen = false;
const catOf = id => board.categories.find(c => c.id === id);

// ── the side ───────────────────────────────────────────────────────────────

function renderSide() {
  const views = $("#views");
  views.replaceChildren(...VIEWS.map(v => {
    const b = el("button", { type: "button", className: "go" }, el("span", { textContent: v.name }),
      v.id === "feed" && board.unread ? el("span", { className: "badge", textContent: board.unread, title: `${board.unread} new` }) : null);
    b.setAttribute("aria-current", String(!at.category && at.view === v.id));
    b.addEventListener("click", () => go({ view: v.id }));
    return el("li", {}, b);
  }));
  const cats = $("#cats");
  cats.replaceChildren(...board.categories.map(c => {
    const b = el("button", { type: "button", className: "go" }, el("span", { textContent: c.name }), el("small", { textContent: c.posts || "" }));
    b.setAttribute("aria-current", String(at.category === c.id));
    b.addEventListener("click", () => go({ category: c.id }));
    const star = el("button", { type: "button", className: "star", textContent: c.following ? "★" : "☆", title: c.following ? `Stop following ${c.name}` : `Follow ${c.name}` });
    star.setAttribute("aria-pressed", String(c.following));
    star.setAttribute("aria-label", `Follow ${c.name}`);
    star.addEventListener("click", () => toggleFollow(c));
    return el("li", {}, b, star);
  }));
}

function toggleFollow(c) {
  return run(async () => {
    const next = await api("PUT", `categories/${c.id}/follow`, { follow: !c.following });
    Object.assign(c, next);
    renderSide();
    renderTop();
    if (!at.category && at.view === "feed") await load();
  });
}

// ── the posts ──────────────────────────────────────────────────────────────

function renderTop() {
  const c = at.category && catOf(at.category);
  const v = VIEWS.find(x => x.id === at.view);
  $("#heading").textContent = c ? c.name : v.name;
  const follow = $("#follow");
  follow.hidden = !c;
  if (c) follow.textContent = c.following ? "★ Following" : "☆ Follow";
  let sub = c ? `${c.posts} recipe${c.posts === 1 ? "" : "s"} · ${c.followers} following` : v.blurb;
  if (!c && at.view === "feed") {
    const n = board.categories.filter(x => x.following).length;
    sub = n ? `New recipes in the ${n} categor${n === 1 ? "y" : "ies"} you follow.` : "Star a category on the left to follow it, and its new recipes show up here.";
  }
  $("#sub").textContent = sub;
}

function recipeBody(p) {
  const r = p.recipe;
  const full = el("div", { className: "full" });
  full.addEventListener("click", e => e.stopPropagation());
  if (r.image) {
    const img = el("img", { className: "hero", src: r.image, alt: "", referrerPolicy: "no-referrer", loading: "lazy" });
    img.addEventListener("error", () => img.remove());
    full.append(img);
  }
  const bits = [r.time, r.servings ? `serves ${r.servings}` : r.yield].filter(Boolean);
  const facts = el("div", { className: "facts" }, bits.join(" · "));
  if (r.source) facts.append(bits.length ? " · " : "", el("a", { href: r.source, textContent: hostOf(r.source) || "source", target: "_blank", rel: "noopener noreferrer" }));
  full.append(facts);
  if (r.ingredients.length) full.append(el("h3", { textContent: "Ingredients" }), el("ul", {}, ...r.ingredients.map(i => el("li", { textContent: i }))));
  if (r.steps.length) full.append(el("h3", { textContent: "Steps" }), el("ol", { className: "steps" }, ...r.steps.map(s => el("li", { textContent: s }))));
  if (r.notes) full.append(el("h3", { textContent: "Notes" }), el("p", { className: "notes", textContent: r.notes }));

  const acts = el("div", { className: "actions" });
  if (board.recipe_box) {
    const save = el("button", { type: "button", className: p.saved ? "btn quiet save" : "btn save", textContent: p.saved ? "Saved ✓ open it" : "Save to Recipe box" });
    save.addEventListener("click", () => saveIt(p));
    acts.append(save);
  }
  if (p.can_edit) {
    const edit = el("button", { type: "button", className: "btn quiet", textContent: "Edit" });
    edit.addEventListener("click", () => openEditor(p));
    const del = el("button", { type: "button", className: "btn danger", textContent: "Delete" });
    del.addEventListener("click", () => {
      if (!confirm(`Take ${p.title} off the board? Copies people saved stay in their Recipe box.`)) return;
      run(async () => {
        await api("DELETE", "posts/" + p.id);
        posts = posts.filter(x => x.id !== p.id);
        const c = catOf(p.category);
        if (c) c.posts--;
        renderSide(); renderTop(); renderPosts();
      });
    });
    acts.append(edit, del);
  }
  if (!board.recipe_box) acts.append(el("p", { className: "empty", textContent: "Ask the site's admin for Recipe box to save recipes from here." }));
  full.append(acts);
  return full;
}

// The recipe of the day, at the top of your feed and Everything.
function renderFeatured(box) {
  const p = board.featured;
  if (!p || at.category || !["feed", "all"].includes(at.view)) return;
  const card = el("article", { className: "card post featured", tabIndex: 0 });
  card.append(el("div", {},
    el("div", { className: "kicker", textContent: "Recipe of the day" }),
    el("h2", { textContent: p.title }),
    el("div", { className: "meta" }, el("span", { className: "tag", textContent: p.category_name }), ` · shared by ${p.by}`),
    p.note ? el("p", { className: "note", textContent: p.note }) : null));
  if (p.recipe.image) {
    const img = el("img", { className: "thumb", src: p.recipe.image, alt: "", referrerPolicy: "no-referrer", loading: "lazy" });
    img.addEventListener("error", () => img.remove());
    card.append(img);
  } else card.append(el("span"));
  if (featuredOpen) card.append(recipeBody(p));
  const flip = () => { featuredOpen = !featuredOpen; renderPosts(); };
  card.addEventListener("click", flip);
  card.addEventListener("keydown", e => { if (e.key === "Enter" && e.target === card) flip(); });
  box.append(card);
}

function renderPosts() {
  const box = $("#posts");
  box.replaceChildren();
  renderFeatured(box);
  if (!posts.length) {
    const followsNone = !at.category && at.view === "feed" && !board.categories.some(c => c.following);
    box.append(el("p", { className: "empty", textContent: followsNone ? "You don't follow any categories yet." :
      at.view === "saved" && !at.category ? "Nothing saved yet." : "No recipes here yet. Share one!" }));
    return;
  }
  posts.forEach((p, i) => {
    const card = el("article", { className: "card post" + (i === focus ? " focus" : ""), tabIndex: 0 });
    card.dataset.id = p.id;
    const main = el("div", {},
      el("h2", { textContent: p.title }),
      el("div", { className: "meta" }, el("span", { className: "tag", textContent: p.category_name }), ` · ${p.by} · ${ago(p.created)}`,
        p.saves ? ` · saved ${p.saves}×` : "", p.new ? el("span", { className: "new", textContent: "new" }) : null),
      p.note ? el("p", { className: "note", textContent: p.note }) : null);
    card.append(main);
    if (p.recipe.image) {
      const img = el("img", { className: "thumb", src: p.recipe.image, alt: "", referrerPolicy: "no-referrer", loading: "lazy" });
      img.addEventListener("error", () => img.remove());
      card.append(img);
    } else card.append(el("span"));
    if (openId === p.id) card.append(recipeBody(p));
    card.addEventListener("click", () => toggle(p.id, i));
    card.addEventListener("keydown", e => { if (e.key === "Enter" && e.target === card) toggle(p.id, i); });
    box.append(card);
  });
  if (more) {
    const b = el("button", { type: "button", className: "btn quiet", textContent: "Older" });
    b.addEventListener("click", () => load(true));
    box.append(el("div", { className: "more" }, b));
  }
}

function toggle(id, i) {
  openId = openId === id ? null : id;
  focus = i;
  renderPosts();
  document.querySelector(`.post[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: openId !== id });
}

async function load(older = false) {
  const q = new URLSearchParams(at.category ? { category: at.category } : { view: at.view });
  if (older && posts.length) q.set("before", posts.at(-1).created);
  const out = await api("GET", "posts?" + q);
  posts = older ? [...posts, ...out.posts] : out.posts;
  more = out.more;
  if (!older) { openId = null; focus = -1; }
  if (!at.category && at.view === "feed" && !older) board.unread = 0;
  renderSide();
  renderPosts();
}

function go(where) {
  at = { view: where.view || "feed", category: where.category || "" };
  try { history.replaceState(null, "", at.category ? `#c=${at.category}` : at.view === "feed" ? location.pathname : `#${at.view}`); } catch {}
  renderSide();
  renderTop();
  return run(() => load());
}

async function saveIt(p) {
  await run(async () => {
    const out = await api("POST", `posts/${p.id}/save`);
    for (const x of [p, board.featured, ...posts.filter(y => y.id === p.id)]) if (x && x.id === p.id && !x.saved) { x.saved = true; x.saves++; }
    const open = el("a", { href: `/recipes/#${out.recipe.id}`, textContent: "Open it" });
    say("done", out.already ? `${p.title} is already in your Recipe box.` : `Saved ${p.title} to your Recipe box.`, open);
    renderPosts();
  });
}

// ── sharing and editing ────────────────────────────────────────────────────

function showFrom() {
  const f = $("#edit-form"), from = f.from.value;
  for (const d of document.querySelectorAll("[data-from]")) d.hidden = d.dataset.from !== from;
  f.recipe_id.required = from === "box";
  f.url.required = from === "url";
  f.title.required = from === "typed";
}

function openEditor(p, { recipe } = {}) {
  editing = p || {};
  const f = $("#edit-form");
  $("#edit-title").textContent = p ? "Edit post" : "Share a recipe";
  $("#post-btn").textContent = p ? "Save" : "Post";
  f.category.replaceChildren(...board.categories.map(c => new Option(c.name, c.id)));
  f.category.value = p?.category || at.category || board.categories.find(c => c.following)?.id || board.categories[0]?.id || "";
  f.recipe_id.replaceChildren(...board.recipes.map(r => new Option(r.title, r.id)));
  if (recipe) f.recipe_id.value = recipe;
  const boxLabel = $("#from").querySelector('input[value="box"]').closest("label");
  boxLabel.hidden = !board.recipe_box || !board.recipes.length || !!p;
  $("#from").querySelector('input[value="url"]').closest("label").hidden = !!p;
  const r = p?.recipe;
  f.title.value = p?.title || "";
  f.servings.value = r?.servings ?? "";
  f.yield.value = r?.yield || "";
  f.time.value = r?.time || "";
  f.ingredients.value = (r?.ingredients || []).join("\n");
  f.steps.value = (r?.steps || []).join("\n");
  f.source.value = r?.source || "";
  f.url.value = "";
  f.note.value = p?.note || "";
  f.from.value = p ? "typed" : recipe || (!boxLabel.hidden && board.recipes.length) ? "box" : "url";
  showFrom();
  $("#editor").showModal();
}
for (const r of document.querySelectorAll('input[name="from"]')) r.addEventListener("change", showFrom);

$("#editor").addEventListener("close", () => {
  if ($("#editor").returnValue !== "save" || !editing) return;
  const f = $("#edit-form"), from = f.from.value;
  const body = { category: f.category.value, note: f.note.value };
  if (from === "box") body.recipe_id = f.recipe_id.value;
  else if (from === "url") body.url = f.url.value.trim();
  else {
    body.title = f.title.value;
    body.recipe = { ingredients: f.ingredients.value, steps: f.steps.value, servings: f.servings.value === "" ? null : Number(f.servings.value),
      yield: f.yield.value, time: f.time.value, source: f.source.value, ...(editing.recipe ? { notes: editing.recipe.notes, image: editing.recipe.image } : {}) };
  }
  const was = editing;
  editing = null;
  const btn = $("#share");
  btn.disabled = true;
  run(async () => {
    try {
      const saved = was.id ? await api("PATCH", "posts/" + was.id, body) : await api("POST", "posts", body);
      board = await loadBoard();
      if (!was.id) say("done", `Posted ${saved.title} in ${saved.category_name}.`);
      if (was.id) {
        posts = posts.map(x => x.id === saved.id ? saved : x);
        renderSide(); renderTop(); renderPosts();
      } else {
        await go({ category: saved.category });
        openId = saved.id; focus = 0;
        renderPosts();
      }
    } catch (e) {
      // No recipe on that page: type it in, with the link kept.
      if (e.manual) { openEditor(null); const f2 = $("#edit-form"); f2.from.value = "typed"; f2.source.value = body.url; f2.note.value = body.note; showFrom(); }
      throw e;
    }
  }).finally(() => { btn.disabled = false; });
});

$("#share").addEventListener("click", () => openEditor(null));
$("#follow").addEventListener("click", () => { const c = catOf(at.category); if (c) toggleFollow(c); });
$("#newcat").addEventListener("submit", e => {
  e.preventDefault();
  run(async () => {
    const c = await api("POST", "categories", { name: $("#catname").value });
    $("#catname").value = "";
    board.categories = [...board.categories, c].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    await go({ category: c.id });
  });
});

document.addEventListener("keydown", e => {
  const t = e.target;
  if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || t.matches?.("input, textarea, select") || $("#editor").open) return;
  const moveTo = i => {
    if (!posts.length) return;
    focus = Math.max(0, Math.min(posts.length - 1, i));
    renderPosts();
    const card = document.querySelectorAll(".post")[focus];
    card?.focus();
  };
  const p = posts[focus];
  const keys = {
    n: () => openEditor(null),
    j: () => moveTo(focus + 1),
    k: () => moveTo(focus - 1),
    s: () => p && board.recipe_box && saveIt(p),
    f: () => { const c = catOf(at.category); if (c) toggleFollow(c); },
  };
  if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
});

run(async () => {
  board = await loadBoard();
  const h = location.hash.slice(1), share = new URLSearchParams(location.search).get("share");
  const where = h.startsWith("c=") && catOf(h.slice(2)) ? { category: h.slice(2) } : VIEWS.some(v => v.id === h) ? { view: h } : { view: "feed" };
  await go(where);
  // From Recipe box's "Share on the board".
  if (share && board.recipes.some(r => r.id === share)) {
    try { history.replaceState(null, "", location.pathname + location.hash); } catch {}
    openEditor(null, { recipe: share });
  }
});
