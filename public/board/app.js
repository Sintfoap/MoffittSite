// Recipe board: the categories down the side (star one, or one of its values, to follow it), and
// the posts of whichever view or category is open beside them, newest first.
// The categories are the label keys from Recipe labels; a post is under each
// key its labels use, and an open key lists its values to narrow it down.
// Your feed is the categories, and single values, you follow. Any post can be saved into your
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

let board = null;      // GET /board/api/board: {categories, label_list, recipe_box, recipes, unread, featured, can_label}
let at = { view: "feed", category: "", label: "" };
let posts = [], more = false;
let openId = null, focus = -1;
let editing = null;    // the post in the editor, or {} for a new one
// post id → {language, english, fields, on}: its English, from "Translate to English",
// shown in place of the original while `on`. Anyone can translate; only whoever can edit it saves it.
const english = new Map();
const RECIPE_TEXT = ["yield", "time", "ingredients", "steps", "notes"];
// The post as it's shown: in English while that's on.
function shown(p) {
  const tr = english.get(p.id);
  return tr?.on ? inEnglish(p, tr.fields) : p;
}
function inEnglish(p, f) {
  const recipe = { ...p.recipe };
  for (const k of RECIPE_TEXT) if (k in f) recipe[k] = f[k];
  return { ...p, title: f.title ?? p.title, note: f.note ?? p.note, recipe };
}

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
const low = s => String(s || "").toLowerCase();
const catOf = id => id ? board.categories.find(c => low(c.id) === low(id)) : null;
const valueOf = (c, id) => c?.values.find(v => v.id === id);
// "Course: Dinner · Cuisine: Irish", for a post's line.
function labelChips(p) {
  const ls = p.recipe?.labels || [];
  if (!ls.length) return null;
  return el("span", { className: "chips" }, ...ls.map(l => el("span", { className: "tag" }, el("b", { textContent: l.key + (l.value ? ": " : "") }), l.value)));
}

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
  cats.replaceChildren(...board.categories.flatMap(c => {
    const here = low(at.category) === low(c.id);
    const b = el("button", { type: "button", className: "go" }, el("span", { textContent: c.name }), el("small", { textContent: c.posts || "" }));
    b.setAttribute("aria-current", String(here && !at.label));
    b.addEventListener("click", () => go({ category: c.id }));
    const star = el("button", { type: "button", className: "star", textContent: c.following ? "★" : "☆", title: c.following ? `Stop following ${c.name}` : `Follow ${c.name}` });
    star.setAttribute("aria-pressed", String(c.following));
    star.setAttribute("aria-label", `Follow ${c.name}`);
    star.addEventListener("click", () => toggleFollow(c));
    // The open key's values, to narrow it to one (and any value you follow, so you can see it).
    const values = c.values.filter(v => here || v.following).map(v => {
      const vb = el("button", { type: "button", className: "go" }, el("span", { textContent: v.value }), el("small", { textContent: v.posts || "" }));
      vb.setAttribute("aria-current", String(at.label === v.id));
      vb.addEventListener("click", () => go({ category: c.id, label: v.id }));
      const name = `${c.name}: ${v.value}`;
      const vs = el("button", { type: "button", className: "star", textContent: v.following ? "★" : "☆", title: v.following ? `Stop following ${name}` : `Follow just ${name}` });
      vs.setAttribute("aria-pressed", String(v.following));
      vs.setAttribute("aria-label", `Follow ${name}`);
      vs.addEventListener("click", () => toggleFollowValue(v));
      return el("li", { className: "value" }, vb, vs);
    });
    return [el("li", {}, b, star), ...values];
  }));
  if (!board.categories.length) cats.append(el("li", {}, el("span", { className: "go empty", textContent: "No labels yet" })));
  const hint = $("#cats-hint");
  hint.replaceChildren("These are the label keys from Recipe labels. A recipe is in every one its labels use.");
  if (board.can_label) hint.append(" ", el("a", { href: "/labels/", textContent: "Edit the labels" }));
}

function toggleFollow(c) {
  return run(async () => {
    const next = await api("PUT", `categories/${encodeURIComponent(c.id)}/follow`, { follow: !c.following });
    Object.assign(c, next);
    renderSide();
    renderTop();
    if (!at.category && at.view === "feed") await load();
  });
}

function toggleFollowValue(v) {
  return run(async () => {
    const next = await api("PUT", `labels/${encodeURIComponent(v.id)}/follow`, { follow: !v.following });
    Object.assign(v, next);
    renderSide();
    renderTop();
    if (!at.category && at.view === "feed") await load();
  });
}

// What you follow: whole categories and single values.
const followed = () => board.categories.flatMap(c => [...(c.following ? [c.name] : []), ...c.values.filter(v => v.following).map(v => `${c.name}: ${v.value}`)]);

// ── the posts ──────────────────────────────────────────────────────────────

function renderTop() {
  const c = catOf(at.category), val = valueOf(c, at.label);
  const v = VIEWS.find(x => x.id === at.view);
  $("#heading").textContent = val ? `${c.name}: ${val.value}` : c ? c.name : v.name;
  const follow = $("#follow");
  follow.hidden = !c;
  const f = val || c, fname = val ? `${c.name}: ${val.value}` : c?.name;
  if (c) follow.textContent = f.following ? `★ Following ${fname}` : `☆ Follow ${fname}`;
  $("#remove-cat").hidden = !c?.can_delete || !!val;
  const n = val ? val.posts : c?.posts;
  let sub = c ? `${n} recipe${n === 1 ? "" : "s"} · ${f.followers} following ${fname}` : v.blurb;
  if (!c && at.view === "feed") {
    const n = followed();
    sub = n.length ? `New recipes in what you follow: ${n.join(", ")}.` : "Star a category, or one of its values, on the left to follow it, and its new recipes show up here.";
  }
  $("#sub").textContent = sub;
}

function recipeBody(post) {
  const p = shown(post), r = p.recipe, tr = english.get(post.id);
  const full = el("div", { className: "full" });
  full.addEventListener("click", e => e.stopPropagation());
  if (tr) full.append(translatedBar(post, tr));
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
    save.addEventListener("click", () => saveIt(post));
    acts.append(save);
  }
  if (!tr) {
    const tl = el("button", { type: "button", className: "btn quiet translate", textContent: "Translate to English" });
    tl.addEventListener("click", () => translate(post, tl));
    acts.append(tl);
  }
  if (p.can_edit) {
    const edit = el("button", { type: "button", className: "btn quiet", textContent: "Edit" });
    edit.addEventListener("click", () => openEditor(post));
    const del = el("button", { type: "button", className: "btn danger", textContent: "Delete" });
    del.addEventListener("click", () => {
      if (!confirm(`Take ${p.title} off the board? Copies people saved stay in their Recipe box.`)) return;
      run(async () => {
        await api("DELETE", "posts/" + p.id);
        posts = posts.filter(x => x.id !== p.id);
        board = await loadBoard();
        renderSide(); renderTop(); renderPosts();
      });
    });
    acts.append(edit, del);
  }
  if (!board.recipe_box) acts.append(el("p", { className: "empty", textContent: "Ask the site's admin for Recipe box to save recipes from here." }));
  full.append(acts);
  return full;
}

// ── translating ────────────────────────────────────────────────────────────

async function translate(p, b) {
  if (b) { b.disabled = true; b.textContent = "Translating…"; }
  const err = await run(async () => {
    const out = await api("POST", `posts/${p.id}/translate`);
    if (out.english) { say("done", `${p.title} is already in English.`); return; }
    english.set(p.id, { ...out, on: true });
  });
  if (err && b) { b.disabled = false; b.textContent = "Translate to English"; }
  if (!err) renderPosts();
}

// Above a translated post: what it was in, switching back, and (for whoever can edit it) saving the English over it.
function translatedBar(p, tr) {
  const flip = el("button", { type: "button", className: "link", textContent: tr.on ? "Show the original" : "Show the English" });
  flip.addEventListener("click", () => { tr.on = !tr.on; renderPosts(); });
  let save = null;
  if (p.can_edit) {
    save = el("button", { type: "button", className: "link", textContent: "Save the English" });
    save.title = "Replace the post's words with the English, for everyone. The original isn't kept.";
    save.addEventListener("click", () => {
      if (!confirm(`Save the English over the ${tr.language} in ${p.title}, for everyone? The original isn't kept.`)) return;
      run(async () => {
        const e = inEnglish(p, tr.fields), recipe = { ...e.recipe, labels: e.recipe.labels.map(l => l.id) };
        delete recipe.title;
        const saved = await api("PATCH", "posts/" + p.id, { title: e.title, note: e.note, recipe });
        english.delete(p.id);
        posts = posts.map(x => x.id === saved.id ? saved : x);
        if (board.featured?.id === saved.id) board.featured = saved;
        say("done", `Saved ${saved.title} in English.`);
        renderPosts();
      });
    });
  }
  const hide = el("button", { type: "button", className: "link", textContent: "Close" });
  hide.addEventListener("click", () => { english.delete(p.id); renderPosts(); });
  return el("div", { className: "translated", role: "status" },
    el("span", { textContent: tr.on ? `Translated from ${tr.language}` : `In ${tr.language}; the English is ready` }), flip, save, hide);
}

// The recipe of the day, at the top of your feed and Everything.
function renderFeatured(box) {
  const post = board.featured;
  const p = post && shown(post);
  if (!p || at.category || !["feed", "all"].includes(at.view)) return;
  const card = el("article", { className: "card post featured", tabIndex: 0 });
  card.append(el("div", {},
    el("div", { className: "kicker", textContent: "Recipe of the day" }),
    el("h2", { textContent: p.title }),
    el("div", { className: "meta" }, labelChips(p), `${p.recipe.labels.length ? " · " : ""}shared by ${p.by}`),
    p.note ? el("p", { className: "note", textContent: p.note }) : null));
  if (p.recipe.image) {
    const img = el("img", { className: "thumb", src: p.recipe.image, alt: "", referrerPolicy: "no-referrer", loading: "lazy" });
    img.addEventListener("error", () => img.remove());
    card.append(img);
  } else card.append(el("span"));
  if (featuredOpen) card.append(recipeBody(post));
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
    const followsNone = !at.category && at.view === "feed" && !followed().length;
    box.append(el("p", { className: "empty", textContent: followsNone ? "You don't follow any categories yet." :
      at.view === "saved" && !at.category ? "Nothing saved yet." : "No recipes here yet. Share one!" }));
    return;
  }
  posts.forEach((post, i) => {
    const p = shown(post);
    const card = el("article", { className: "card post" + (i === focus ? " focus" : ""), tabIndex: 0 });
    card.dataset.id = p.id;
    const main = el("div", {},
      el("h2", { textContent: p.title }),
      el("div", { className: "meta" }, labelChips(p), `${p.recipe.labels.length ? " · " : ""}${p.by} · ${ago(p.created)}`,
        p.saves ? ` · saved ${p.saves}×` : "", p.new ? el("span", { className: "new", textContent: "new" }) : null),
      p.note ? el("p", { className: "note", textContent: p.note }) : null);
    card.append(main);
    if (p.recipe.image) {
      const img = el("img", { className: "thumb", src: p.recipe.image, alt: "", referrerPolicy: "no-referrer", loading: "lazy" });
      img.addEventListener("error", () => img.remove());
      card.append(img);
    } else card.append(el("span"));
    if (openId === p.id) card.append(recipeBody(post));
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
  const q = new URLSearchParams(at.label ? { label: at.label } : at.category ? { category: at.category } : { view: at.view });
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
  at = { view: where.view || "feed", category: where.category || "", label: where.label || "" };
  const hash = at.label ? `#l=${at.label}` : at.category ? `#c=${encodeURIComponent(at.category)}` : at.view === "feed" ? "" : `#${at.view}`;
  try { history.replaceState(null, "", location.pathname + hash); } catch {}
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

// The site's labels as checkboxes, by key, with `on` ticked.
function renderPicker(on) {
  const box = $("#label-picker"), list = board.label_list || [];
  const ticked = new Set(on);
  box.replaceChildren();
  if (!list.length) { box.append(el("p", { className: "empty", textContent: "No labels yet, so this goes in Everything only. Whoever keeps Recipe labels adds them." })); return; }
  const keys = new Map();
  for (const l of list) keys.set(low(l.key), [...(keys.get(low(l.key)) || []), l]);
  for (const ls of keys.values()) {
    box.append(el("div", { className: "pick" }, el("b", { textContent: ls[0].key }),
      ...ls.map(l => el("label", { className: "chip" }, el("input", { type: "checkbox", value: l.id, checked: ticked.has(l.id) }), l.value || "yes"))));
  }
}
const pickedLabels = () => [...document.querySelectorAll("#label-picker input:checked")].map(i => i.value);
const boxLabels = id => board.recipes.find(r => r.id === id)?.labels || [];

function openEditor(p, { recipe } = {}) {
  editing = p || {};
  const f = $("#edit-form");
  $("#edit-title").textContent = p ? "Edit post" : "Share a recipe";
  $("#post-btn").textContent = p ? "Save" : "Post";
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
  // A new post starts with the open category's value ticked; one from your box, with its own labels.
  renderPicker(p ? p.recipe.labels.map(l => l.id) : f.from.value === "box" ? boxLabels(f.recipe_id.value) : at.label ? [at.label] : []);
  showFrom();
  $("#editor").showModal();
}
for (const r of document.querySelectorAll('input[name="from"]')) r.addEventListener("change", showFrom);
$("#edit-form").recipe_id.addEventListener("change", e => renderPicker(boxLabels(e.target.value)));

$("#editor").addEventListener("close", () => {
  if ($("#editor").returnValue !== "save" || !editing) return;
  const f = $("#edit-form"), from = f.from.value;
  const body = { note: f.note.value, labels: pickedLabels() };
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
      if (was.id) english.delete(was.id);
      board = await loadBoard();
      if (!was.id) say("done", saved.categories.length ? `Posted ${saved.title} in ${saved.categories.join(", ")}.` : `Posted ${saved.title}. Give it labels to put it in categories.`);
      if (was.id) {
        posts = posts.map(x => x.id === saved.id ? saved : x);
        renderSide(); renderTop(); renderPosts();
      } else {
        await go(saved.categories.length ? { category: saved.categories[0] } : { view: "mine" });
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
$("#follow").addEventListener("click", () => {
  const c = catOf(at.category), val = valueOf(c, at.label);
  if (val) toggleFollowValue(val); else if (c) toggleFollow(c);
});
// Removing a category removes its key, and all its values, from Recipe labels.
$("#remove-cat").addEventListener("click", () => {
  const c = catOf(at.category);
  if (!c || !confirm(`Remove the ${c.name} category? That takes ${c.name} and its ${c.values.length || ""} value${c.values.length === 1 ? "" : "s"} off Recipe labels, and off every recipe and post that has them. The recipes and posts stay.`)) return;
  run(async () => {
    await api("DELETE", `categories/${encodeURIComponent(c.id)}`);
    board = await loadBoard();
    say("done", `Removed the ${c.name} category.`);
    await go({ view: "all" });
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
    // English: translate the focused post, or flip between it and the original.
    E: () => { if (!p) return; const tr = english.get(p.id); if (tr) { tr.on = !tr.on; renderPosts(); } else { openId = p.id; translate(p); } },
  };
  if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
});

run(async () => {
  board = await loadBoard();
  const h = location.hash.slice(1), share = new URLSearchParams(location.search).get("share");
  const key = h.startsWith("c=") ? catOf(decodeURIComponent(h.slice(2))) : null;
  const lab = h.startsWith("l=") ? board.categories.find(c => valueOf(c, h.slice(2))) : null;
  const where = lab ? { category: lab.id, label: h.slice(2) } : key ? { category: key.id } : VIEWS.some(v => v.id === h) ? { view: h } : { view: "feed" };
  await go(where);
  // From Recipe box's "Share on the board".
  if (share && board.recipes.some(r => r.id === share)) {
    try { history.replaceState(null, "", location.pathname + location.hash); } catch {}
    openEditor(null, { recipe: share });
  }
});
