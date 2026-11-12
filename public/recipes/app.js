// Recipe box: your recipes down the side, the open one beside them, scaled
// to the servings you pick, with its ingredients ready to send to a Drift
// list. The Worker side is src/recipes.js; scaling is ./scale.js.

import { scaleLine, factorFor, format } from "./scale.js";
import { splitPages, batches, photoOf, fileKey } from "./split.js";
import { unzip } from "./unzip.js";
import { readRecipe } from "./read.js";
import { arrange } from "./columns.js";
import { sized, blackAndWhite, fixFractions } from "./ocr.js";
import { findPicture } from "./picture.js";
import { openSuggestions } from "./suggest.js";
import { ingredientTerms, ingredientHits } from "./ingredients.js";
import { looksEnglish } from "./english.js";

const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter(k => k != null));
  return n;
};

let data = null;          // GET /recipes/api/recipes: {recipes, lists, drift}
let open = null;          // the open recipe's id
let shown = [];           // the ids in the list, as filtered
let editing = null;       // the recipe in the editor, or {} for a new one
const scale = new Map();  // recipe id → {servings} or {factor}, while the page is open
const skip = new Map();   // recipe id → ingredient indexes not to send
let filters = [];         // [{key, value}] labels a recipe must have: any value of the same key, every key
let hits = new Map();     // recipe id → its ingredient lines the ingredient search found, while there is one
let sortKey = "";         // "" title, "@rating" your stars, "@made" last made, else a label's key
let madeFilter = "";      // "" either, "made" made it before (something familiar), "new" not yet (something new)
let ratingFilter = "";    // "" any, "1"–"5" at least that many stars, "none" not rated
let findBy = "name";      // what the one search box looks for: "name" (titles, labels, ingredients) or "ingredient" (all of these, -nuts leaves out)
// recipe id → {language, english, fields, on}: its English, from "Translate to English",
// shown in place of the original while `on`, and only saved over it when asked.
const english = new Map();
// The shelf shows a page of recipes at a time; it turns to the open one's page.
const PAGE = 20;
let page = 0, follow = true;         // "" sorts by title; a label's key sorts by its value

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

async function api(method, path, body) {
  const res = await fetch("/recipes/api/" + path, {
    method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname); throw new Error("not signed in"); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(out.error || `the site answered ${res.status}`), { manual: out.manual });
  return out;
}

function say(kind, text) {
  for (const k of ["error", "done"]) { $("#" + k).hidden = k !== kind || !text; if (k === kind) $("#" + k).textContent = text || ""; }
}
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

async function run(fn) {
  say("error", "");
  try { await fn(); } catch (e) { say("error", cap(e.message || String(e))); return e; }
}

const current = () => data?.recipes.find(r => r.id === open) || null;
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

function amountFor(r) {
  const s = scale.get(r.id) || {};
  const factor = factorFor(r, s);
  return { factor, servings: r.servings ? Math.round(r.servings * factor * 100) / 100 : null };
}

function step(r, dir) {
  const { factor, servings } = amountFor(r);
  if (r.servings) {
    const next = Math.max(1, Math.round(servings) + dir);
    scale.set(r.id, { servings: next });
  } else {
    scale.set(r.id, { factor: Math.max(0.5, Math.round((factor + dir * 0.5) * 2) / 2) });
  }
  renderDetail();
}

// ── labels ─────────────────────────────────────────────────────────────────
// From the site's one list (kept in Recipe labels, /labels/): {id, key, value}.

const low = s => String(s || "").toLowerCase();
const labelsOf = r => r.labels || [];
const labelText = l => l.value ? `${l.key}: ${l.value}` : l.key;
const has = (r, f) => labelsOf(r).some(l => l.id === f.id);
const valueOf = (r, key) => labelsOf(r).find(l => low(l.key) === low(key))?.value;

// The labels your recipes use: [{key, values: [{...label, n}]}], in the list's order.
function allLabels() {
  const n = new Map();
  for (const r of data.recipes) for (const l of labelsOf(r)) n.set(l.id, (n.get(l.id) || 0) + 1);
  const keys = new Map();
  for (const l of data.label_list || []) {
    if (!n.has(l.id)) continue;
    if (!keys.has(low(l.key))) keys.set(low(l.key), { key: l.key, values: [] });
    keys.get(low(l.key)).values.push({ ...l, n: n.get(l.id) });
  }
  return [...keys.values()];
}

// ── made it, and your stars ────────────────────────────────────────────────
// Yours alone: the day you last made it ("" not yet) and 1–5 stars (0 none).

const stars = n => "★".repeat(n) + "☆".repeat(5 - n);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
function madeOn(day) {
  const d = new Date(day + "T12:00:00");
  if (Number.isNaN(+d)) return day;
  if (day === today()) return "today";
  const opts = { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) };
  return d.toLocaleDateString(undefined, opts);
}
function marked(r) {
  if (madeFilter === "made" && !r.made) return false;
  if (madeFilter === "new" && r.made) return false;
  if (ratingFilter === "none") return !r.rating;
  return !ratingFilter || (r.rating || 0) >= Number(ratingFilter);
}

// Rating one you haven't marked as made marks it made today: you can't rate what you haven't cooked.
async function mark(r, changes) {
  if (changes.rating && !r.made) changes = { ...changes, made: today() };
  await run(async () => {
    const fresh = await api("PATCH", "recipes/" + r.id, changes);
    data.recipes = data.recipes.map(x => x.id === r.id ? fresh : x);
    renderList();
    renderDetail();
  });
}
const toggleMade = r => mark(r, r.made ? { made: "", rating: 0 } : { made: today() });
const rate = (r, n) => mark(r, { rating: r.rating === n ? 0 : n });

function marksRow(r) {
  const row = el("div", { className: "marks" });
  if (r.made) {
    row.append(el("span", { className: "when", textContent: `✓ Made ${madeOn(r.made)}` }));
    const again = el("button", { type: "button", className: "btn quiet", textContent: "Made it again", title: "Mark it made today", hidden: r.made === today() });
    again.addEventListener("click", () => mark(r, { made: today() }));
    const undo = el("button", { type: "button", className: "btn quiet", textContent: "Not made", title: "Take the mark (and your stars) off (m)" });
    undo.addEventListener("click", () => toggleMade(r));
    row.append(again, undo);
  } else {
    const made = el("button", { type: "button", className: "btn", textContent: "I made this", title: "Mark it made today (m)" });
    made.addEventListener("click", () => toggleMade(r));
    row.append(made);
  }
  const box = el("span", { className: "rate", role: "group" });
  box.setAttribute("aria-label", "Your rating");
  const btns = [1, 2, 3, 4, 5].map(n => {
    const b = el("button", { type: "button", className: n <= (r.rating || 0) ? "on" : "", textContent: "★",
      title: r.rating === n ? "Take your stars off (0)" : `${n} star${n === 1 ? "" : "s"} (${n})` });
    b.setAttribute("aria-label", `${n} star${n === 1 ? "" : "s"}`);
    b.setAttribute("aria-pressed", String(r.rating === n));
    b.addEventListener("click", () => rate(r, n));
    b.addEventListener("mouseenter", () => btns.forEach((x, i) => x.classList.toggle("lit", i < n)));
    return b;
  });
  box.addEventListener("mouseleave", () => btns.forEach(x => x.classList.remove("lit")));
  box.append(...btns, el("small", { textContent: r.rating ? "your rating" : "rate it" }));
  row.append(box);
  return row;
}

// A new filter opens the first recipe it shows, when the open one isn't among them.
function refilter() {
  page = 0;
  renderFilters();
  renderList();
  if (!shown.includes(open) && shown.length) pick(shown[0]); else renderDetail();
}
$("#made-filter").addEventListener("change", e => { madeFilter = e.target.value; refilter(); });
$("#rating-filter").addEventListener("change", e => { ratingFilter = e.target.value; refilter(); });

function passes(r) {
  if (!marked(r)) return false;
  const keys = new Map();
  for (const f of filters) keys.set(low(f.key), [...(keys.get(low(f.key)) || []), f]);
  return [...keys.values()].every(fs => fs.some(f => has(r, f)));
}

function toggleFilter(f) {
  const at = filters.findIndex(x => x.id === f.id);
  filters = at < 0 ? [...filters, f] : filters.filter((_, i) => i !== at);
  page = 0;
  renderFilters();
  renderList();
  renderDetail();
}

function renderFilters() {
  const labels = allLabels();
  const sel = $("#label-filter");
  sel.replaceChildren(new Option(labels.length ? "Filter by label…" : "No labels yet", ""));
  sel.disabled = !labels.length;
  for (const k of labels) {
    const g = document.createElement("optgroup");
    g.label = k.key;
    for (const v of k.values) {
      const o = new Option(`${v.value || "(set)"}  ·  ${v.n}`, v.id);
      o.disabled = filters.some(f => f.id === v.id);
      g.append(o);
    }
    sel.append(g);
  }
  const sort = $("#sort");
  sort.replaceChildren(new Option("Sort: title", ""), ...labels.map(k => new Option(`Sort: ${k.key}`, low(k.key))),
    new Option("Sort: your rating", "@rating"), new Option("Sort: last made", "@made"));
  if (!sortKey.startsWith("@") && !labels.some(k => low(k.key) === sortKey)) sortKey = "";
  sort.value = sortKey;
  $("#made-filter").value = madeFilter;
  $("#rating-filter").value = ratingFilter;
  const chip = (key, value, off) => {
    const b = el("button", { type: "button", className: "chip on", title: "Stop filtering by this" }, el("b", { textContent: key }), value, " ×");
    b.addEventListener("click", off);
    return b;
  };
  const clearMarks = which => () => { if (which === "made") madeFilter = ""; else ratingFilter = ""; refilter(); };
  $("#active").replaceChildren(
    ...(madeFilter ? [chip(madeFilter === "made" ? "Made before" : "Not made yet", "", clearMarks("made"))] : []),
    ...(ratingFilter ? [chip("Stars", ratingFilter === "none" ? "none" : ratingFilter === "5" ? "5" : `${ratingFilter}+`, clearMarks("rating"))] : []),
    ...filters.map(f => chip(f.key, f.value ? f.value : "", () => toggleFilter(f))));
}

$("#label-filter").addEventListener("change", e => {
  const l = (data.label_list || []).find(x => x.id === e.target.value);
  if (l) toggleFilter(l);
  e.target.value = "";
});
$("#sort").addEventListener("change", e => {
  sortKey = e.target.value;
  store.set("recipes:sort", sortKey);
  renderList();
});

// ── the list ───────────────────────────────────────────────────────────────

function renderList() {
  const q = findBy === "name" ? $("#find").value.trim().toLowerCase() : "";
  const terms = findBy === "ingredient" ? ingredientTerms($("#find").value) : [];
  const by = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  hits = new Map();
  let match = data.recipes.filter(r => {
    if (!passes(r)) return false;
    if (q && !(r.title.toLowerCase().includes(q) || r.ingredients.some(i => i.toLowerCase().includes(q))
      || labelsOf(r).some(l => low(labelText(l)).includes(q)))) return false;
    if (!terms.length) return true;
    const at = ingredientHits(r, terms);
    if (at) hits.set(r.id, at);
    return !!at;
  });
  // By your stars (most first), or the last made (latest first); then the title.
  if (sortKey === "@rating") match = [...match].sort((a, b) => (b.rating || 0) - (a.rating || 0) || by(a.title, b.title));
  else if (sortKey === "@made") match = [...match].sort((a, b) => by(b.made || "", a.made || "") || by(a.title, b.title));
  // By a label: its value, then the title; recipes without it go last.
  else if (sortKey) match = [...match].sort((a, b) => {
    const x = valueOf(a, sortKey), y = valueOf(b, sortKey);
    if ((x === undefined) !== (y === undefined)) return x === undefined ? 1 : -1;
    return by(x || "", y || "") || by(a.title, b.title);
  });
  shown = match.map(r => r.id);
  const pages = Math.max(1, Math.ceil(match.length / PAGE));
  if (follow && shown.includes(open)) page = Math.floor(shown.indexOf(open) / PAGE);
  follow = true;
  page = Math.min(Math.max(0, page), pages - 1);
  const ul = $("#recipes");
  ul.replaceChildren();
  if (!data.recipes.length) ul.append(el("li", { className: "empty", textContent: "No recipes yet. Paste a link above." }));
  else if (!match.length) ul.append(el("li", { className: "empty", textContent: madeFilter === "new" && !filters.length && !$("#find").value.trim() && !ratingFilter
    ? "You've made every one. Time to add something new." : "Nothing matches." }));
  for (const r of match.slice(page * PAGE, page * PAGE + PAGE)) {
    const sorted = sortKey && !sortKey.startsWith("@") && valueOf(r, sortKey);
    const mine = r.rating ? el("span", { className: "stars", textContent: "★".repeat(r.rating) }) : r.made ? "✓ made" : null;
    const tags = labelsOf(r).map(labelText).join(" · ");
    const found = (hits.get(r.id) || []).map(i => r.ingredients[i]).join(" · ");
    const sub = [sorted, r.time, hostOf(r.source)].filter(Boolean).join(" · ") || `${r.ingredients.length} ingredients`;
    const b = el("button", { type: "button" }, r.title, el("small", {}, ...(mine ? [mine, " · "] : []), sub),
      found ? el("small", { className: "found", textContent: found }) : null,
      tags ? el("span", { className: "tagline", textContent: tags }) : null);
    b.setAttribute("aria-current", String(r.id === open));
    b.addEventListener("click", () => pick(r.id));
    ul.append(el("li", {}, b));
  }
  const pager = $("#pager");
  pager.hidden = pages < 2;
  if (pages > 1) {
    const turn = d => { page += d; follow = false; renderList(); $("#recipes button")?.focus(); };
    const prev = el("button", { type: "button", className: "btn quiet", textContent: "‹ Prev", disabled: page === 0, title: "[" });
    const next = el("button", { type: "button", className: "btn quiet", textContent: "Next ›", disabled: page >= pages - 1, title: "]" });
    prev.addEventListener("click", () => turn(-1));
    next.addEventListener("click", () => turn(1));
    pager.replaceChildren(prev, el("span", { textContent: `${page * PAGE + 1}–${Math.min(match.length, page * PAGE + PAGE)} of ${match.length}` }), next);
  }
}

function pick(id) {
  open = id;
  history.replaceState(null, "", id ? "#" + id : location.pathname);
  renderList();
  renderDetail();
}

// ── the open recipe ────────────────────────────────────────────────────────

function listChoices() {
  const mine = data.lists.find(l => !l.owner_name && l.name.toLowerCase() === "shopping list");
  const opts = [new Option(mine ? "Shopping list" : "Shopping list (new)", "")];
  for (const l of data.lists) if (l !== mine) opts.push(new Option(l.owner_name ? `${l.name} (${l.owner_name}'s)` : l.name, l.id));
  return opts;
}

function renderDetail() {
  const box = $("#detail");
  const base = current(), tr = base && english.get(base.id);
  // Showing the English: the same recipe with its words swapped, so scaling and sending work on it too.
  const r = tr?.on ? { ...base, ...tr.fields } : base;
  box.replaceChildren();
  if (!r) {
    box.append(el("p", { className: "empty", textContent: data.recipes.length ? "Pick a recipe." : "Your recipes will show up here." }));
    return;
  }
  const card = el("article", { className: "card recipe" });
  if (r.image) {
    const img = el("img", { className: "hero", src: r.image, alt: "", referrerPolicy: "no-referrer", loading: "lazy" });
    img.addEventListener("error", () => img.remove());
    card.append(img);
  }
  if (tr) card.append(translatedBar(base, tr));
  card.append(el("h2", { textContent: r.title }));
  const facts = el("div", { className: "facts" });
  const bits = [r.time, r.yield && !/^\d+(\.\d+)?$/.test(r.yield) ? r.yield : ""].filter(Boolean);
  facts.append(bits.join(" · "));
  if (r.source) {
    if (bits.length) facts.append(" · ");
    facts.append(el("a", { href: r.source, textContent: hostOf(r.source) || "source", target: "_blank", rel: "noopener noreferrer" }));
  }
  card.append(facts);
  card.append(marksRow(base));
  if (labelsOf(r).length) {
    card.append(el("div", { className: "chips" }, ...labelsOf(r).map(l => {
      const on = filters.some(f => f.id === l.id);
      const b = el("button", { type: "button", className: "chip" + (on ? " on" : ""), title: on ? "Stop filtering by this" : "Show only recipes with this label" },
        el("b", { textContent: l.key }), l.value ? l.value : "");
      b.addEventListener("click", () => toggleFilter(l));
      return b;
    })));
  }

  const { factor, servings } = amountFor(r);
  const less = el("button", { type: "button", textContent: "−", title: "Fewer (-)" }), more = el("button", { type: "button", textContent: "+", title: "More (+)" });
  less.setAttribute("aria-label", "Fewer");
  more.setAttribute("aria-label", "More");
  less.addEventListener("click", () => step(r, -1));
  more.addEventListener("click", () => step(r, 1));
  const out = el("output", { textContent: r.servings ? `${servings} serving${servings === 1 ? "" : "s"}` : `×${format(factor)}` });
  card.append(el("div", { className: "serves" }, less, out, more,
    factor !== 1 ? el("small", { className: "empty", textContent: r.servings ? `(the recipe makes ${r.servings})` : "of the recipe" }) : null));

  card.append(el("h3", { textContent: "Ingredients" }));
  const off = skip.get(r.id) || new Set();
  const ul = el("ul", { className: "ingredients" });
  r.ingredients.forEach((line, i) => {
    const scaled = scaleLine(line, factor);
    const box = el("input", { type: "checkbox", checked: !off.has(i) });
    box.addEventListener("change", () => {
      const s = skip.get(r.id) || new Set();
      box.checked ? s.delete(i) : s.add(i);
      skip.set(r.id, s);
      renderDetail();
    });
    const li = el("li", {}, el("label", {}, box, el("span", { className: scaled !== line ? "changed" : "", textContent: scaled })));
    if (hits.get(r.id)?.includes(i)) { li.className = "hit"; li.title = "What you searched for"; }
    ul.append(li);
  });
  if (!r.ingredients.length) ul.append(el("li", { className: "empty", textContent: "No ingredients. Edit the recipe to add them." }));
  card.append(ul);

  if (r.ingredients.length) {
    const send = el("div", { className: "send" });
    const n = r.ingredients.length - [...off].filter(i => i < r.ingredients.length).length;
    if (data.drift) {
      const sel = el("select", { id: "list" });
      sel.setAttribute("aria-label", "Drift list");
      sel.append(...listChoices());
      const remembered = store.get("recipes:list");
      if (remembered && [...sel.options].some(o => o.value === remembered)) sel.value = remembered;
      sel.addEventListener("change", () => store.set("recipes:list", sel.value));
      const go = el("button", { className: "btn", type: "button", id: "send", textContent: `Send ${n} to`, disabled: !n });
      go.addEventListener("click", () => sendToList(r, sel.value));
      send.append(go, sel);
    } else {
      send.append(el("p", { className: "empty", textContent: "Ask the site's admin for Drift to send these to a shopping list." }));
    }
    card.append(send);
  }

  if (r.steps.length) {
    card.append(el("h3", { textContent: "Steps" }));
    card.append(el("ol", { className: "steps" }, ...r.steps.map(s => el("li", { textContent: s }))));
  }
  if (r.notes) card.append(el("h3", { textContent: "Notes" }), el("p", { className: "notes", textContent: r.notes }));

  const edit = el("button", { className: "btn quiet", type: "button", textContent: "Edit" });
  edit.addEventListener("click", () => openEditor(base));
  // Offered only when it doesn't already read as English; E translates any recipe.
  const tl = tr || looksEnglish(base) ? null : el("button", { className: "btn quiet", type: "button", id: "translate", textContent: "Translate to English" });
  tl?.addEventListener("click", () => translate(base));
  // Sharing it on the Recipe board, for anyone with it.
  const share = data.board ? el("a", { className: "btn quiet", href: `/board/?share=${encodeURIComponent(r.id)}`, textContent: "Share on the board" }) : null;
  // A link anyone can open without signing in, for someone who isn't on the site (u).
  const link = el("button", { className: "btn quiet", type: "button", id: "share-link", textContent: base.share ? "Share link (on)" : "Share link" });
  link.title = base.share ? "Anyone with the link can read this recipe; copy it or turn it off (u)" : "Make a link anyone can read this recipe at, no account needed (u)";
  link.addEventListener("click", () => openShare(base));
  card.append(el("div", { className: "actions" }, edit, tl, share, link));
  box.append(card);
}

// ── share links ────────────────────────────────────────────────────────────

// The link is made the first time it's asked for; after that it's the same one
// until it's turned off (src/recipe_share.js). Only the recipe itself is on it.
let sharing = null;
const fullLink = path => new URL(path, location.origin).toString();
function openShare(r) {
  run(async () => {
    const out = r.share ? { share: r.share } : await api("POST", `recipes/${r.id}/share`);
    r.share = out.share;
    sharing = r;
    $("#share-text").textContent = `Anyone with this link can read ${r.title}, without an account: its picture, ingredients, steps and notes, as you keep them here. Nothing else of yours is on it. Turn it off any time and the link stops working.`;
    $("#share-url").value = fullLink(r.share);
    $("#share-copy").textContent = "Copy link";
    renderDetail();
    $("#sharer").showModal();
    $("#share-url").select();
  });
}
$("#share-copy").addEventListener("click", async () => {
  const box = $("#share-url");
  try { await navigator.clipboard.writeText(box.value); }
  catch { box.select(); document.execCommand?.("copy"); }
  $("#share-copy").textContent = "Copied";
});
$("#share-stop").addEventListener("click", () => {
  const r = sharing;
  if (!r) return;
  $("#sharer").close();
  run(async () => {
    await api("DELETE", `recipes/${r.id}/share`);
    r.share = null;
    renderDetail();
    say("done", `The link to ${r.title} is off; it won't open any more.`);
  });
});

// ── translating ────────────────────────────────────────────────────────────

async function translate(r) {
  const b = $("#translate");
  if (b) { b.disabled = true; b.textContent = "Translating…"; }
  const err = await run(async () => {
    const out = await api("POST", `recipes/${r.id}/translate`);
    if (out.english) { say("done", `${r.title} is already in English.`); return; }
    english.set(r.id, { ...out, on: true });
  });
  if (err && b) { b.disabled = false; b.textContent = "Translate to English"; }
  if (!err) renderDetail();
}

// Above a translated recipe: what it was in, and switching back, keeping it, or saving the English over it.
function translatedBar(r, tr) {
  const flip = el("button", { type: "button", className: "link", textContent: tr.on ? "Show the original" : "Show the English" });
  flip.addEventListener("click", () => { tr.on = !tr.on; renderDetail(); });
  const save = el("button", { type: "button", className: "link", textContent: "Save the English" });
  save.title = "Replace the recipe's words with the English. The original isn't kept.";
  save.addEventListener("click", () => {
    if (!confirm(`Save the English over the ${tr.language} in ${r.title}? The original isn't kept.`)) return;
    run(async () => {
      const saved = await api("PATCH", "recipes/" + r.id, tr.fields);
      data.recipes = data.recipes.map(x => x.id === r.id ? saved : x);
      english.delete(r.id);
      say("done", `Saved ${saved.title} in English.`);
      renderList();
      renderDetail();
    });
  });
  const hide = el("button", { type: "button", className: "link", textContent: "Close" });
  hide.addEventListener("click", () => { english.delete(r.id); renderDetail(); });
  return el("div", { className: "translated", role: "status" },
    el("span", { textContent: tr.on ? `Translated from ${tr.language}` : `In ${tr.language}; the English is ready` }), flip, save, hide);
}

async function sendToList(r, list) {
  const off = skip.get(r.id) || new Set();
  const lines = r.ingredients.map((_, i) => i).filter(i => !off.has(i));
  const s = scale.get(r.id) || {};
  await run(async () => {
    const out = await api("POST", `recipes/${r.id}/shop`, { ...s, lines, ...(list ? { list } : {}) });
    say("done", `Added ${out.added} to ${out.list.name} in Drift.`);
    if (!list && !data.lists.some(l => l.id === out.list.id)) data.lists.unshift({ id: out.list.id, name: out.list.name, owner_name: null });
    renderDetail();
  });
}

// ── adding and editing ─────────────────────────────────────────────────────

// `draft` is a recipe read from a photo, to check before it's saved: the
// editor opens as a new recipe with its fields filled and the pictures above.
// `how` says what read the draft: "claude", "ai" (Workers AI, the site's own), "ocr" (text recognition here) or "text" (pasted).
const HINTS = {
  claude: "Read by Claude from your photo. Check it against the picture, fix anything it misread, then save.",
  ai: "Read from your photo by the site's AI (Cloudflare's, no key needed). Check it against the picture, the amounts especially, then save.",
  ocr: "Read from your photo by text recognition on this device. Check it against the picture: fix any misread words, and move lines between the boxes if one landed in the wrong place.",
  text: "Read from the text you pasted. Check that each line landed in the right box, then save.",
};
// `picture`, for a draft from a photo: {blob, whole}, the dish's photo cut from
// it (or, whole, the photo itself), put in as the recipe's picture to keep on Save.
function openEditor(r, draft = null, shots = [], how = "claude", why = "", picture = null) {
  editing = r || {};
  $("#delete-recipe").hidden = !r?.id;
  const f = $("#edit-form");
  $("#edit-title").textContent = r ? "Edit recipe" : draft ? "Check the recipe" : "New recipe";
  $("#edit-hint").hidden = !draft;
  const check = draft?.check?.length ? ` Look twice at the amounts in ${draft.check.map(l => `“${l}”`).join(", ")}: fractions like ½ and ¾ are easy to misread.` : "";
  const fell = why ? `${why}, so ${how === "ai" ? "the site's AI" : "text recognition"} read it instead. ` : "";
  const pic = picture ? (picture.whole ? " Its picture is the whole photo" : " Its picture is the dish's photo from the page") + "; change it or take it off below." : "";
  $("#edit-hint-text").textContent = fell + (HINTS[how] || "") + check + pic;
  $("#with-claude").hidden = !draft || !["ocr", "ai"].includes(how) || !data.photo?.sealing;
  const pics = $("#edit-photos");
  pics.hidden = !shots.length;
  pics.replaceChildren(...shots.map(src => {
    const img = el("img", { src, alt: "Your photo", title: "Click to enlarge" });
    img.addEventListener("click", () => img.classList.toggle("big"));
    return img;
  }));
  r = r || draft;
  f.title.value = r?.title || "";
  f.servings.value = r?.servings ?? "";
  f.yield.value = r?.yield || "";
  f.time.value = r?.time || "";
  f.ingredients.value = (r?.ingredients || []).join("\n");
  f.steps.value = (r?.steps || []).join("\n");
  f.notes.value = r?.notes || "";
  renderPicker(r);
  showPicture(r?.image || "");
  if (picture) {
    const file = new File([picture.blob], "picture.jpg", { type: "image/jpeg" });
    showPicture(URL.createObjectURL(file), file);
  }
  f.source.value = r?.source || (r || draft ? "" : $("#url").value.trim());
  $("#editor").showModal();
  f.title.focus();
}

// The editor's picture: what the recipe has, or the one picked to replace it.
// Nothing changes until Save; then a picked one is shrunk and kept here.
let picChange = null;     // null (as it is), a File (this instead), or "remove"
function showPicture(src, change = null) {
  picChange = change;
  const img = $("#pic-preview");
  if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
  img.hidden = !src;
  if (src) img.src = src; else img.removeAttribute("src");
  $("#pic-none").hidden = !!src;
  $("#pic-remove").hidden = !src;
  $("#pic-choose").textContent = src ? "Change it" : "Choose a picture";
}
$("#pic-choose").addEventListener("click", () => $("#pic-file").click());
$("#pic-file").addEventListener("change", e => {
  const file = e.target.files[0];
  if (file) showPicture(URL.createObjectURL(file), file);
  e.target.value = "";
});
$("#pic-remove").addEventListener("click", () => showPicture("", "remove"));

// The editor's labels: the site's list, a row of ticks per name.
function renderPicker(r) {
  const box = $("#label-picker"), list = data.label_list || [];
  const on = new Set(labelsOf(r || {}).map(l => l.id));
  box.replaceChildren();
  if (!list.length) { box.append(el("p", { className: "empty", textContent: "No labels yet. Whoever keeps Recipe labels adds them there." })); return; }
  const keys = new Map();
  for (const l of list) keys.set(low(l.key), [...(keys.get(low(l.key)) || []), l]);
  for (const ls of keys.values()) {
    box.append(el("div", { className: "pick" }, el("b", { textContent: ls[0].key }),
      ...ls.map(l => el("label", { className: "chip" }, el("input", { type: "checkbox", value: l.id, checked: on.has(l.id) }), l.value || "yes"))));
  }
}

$("#editor").addEventListener("close", () => {
  if ($("#editor").returnValue !== "save" || !editing) return;
  const f = $("#edit-form");
  const body = {
    title: f.title.value, servings: f.servings.value === "" ? null : Number(f.servings.value), yield: f.yield.value, time: f.time.value,
    ingredients: f.ingredients.value, steps: f.steps.value, notes: f.notes.value, source: f.source.value,
    labels: [...document.querySelectorAll("#label-picker input:checked")].map(i => i.value),
  };
  const was = editing, change = picChange;
  editing = null;
  run(async () => {
    let saved = was.id ? await api("PATCH", "recipes/" + was.id, body) : await api("POST", "recipes", body);
    if (was.id) english.delete(was.id);
    if (change === "remove" && saved.image) saved = await api("DELETE", `recipes/${saved.id}/photo`);
    else if (change instanceof File) {
      const small = await shrink(change);
      if (!small) throw new Error("the recipe is saved, but that picture couldn't be read or made small enough");
      saved = await api("POST", `recipes/${saved.id}/photo`, { data: await base64(small) });
    }
    data.recipes = [...data.recipes.filter(x => x.id !== saved.id), saved].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
    if (was.servings !== saved.servings) scale.delete(saved.id);
    if (!was.id) $("#url").value = "";
    renderFilters();
    pick(saved.id);
  });
});

$("#add").addEventListener("submit", async e => {
  e.preventDefault();
  const url = $("#url").value.trim();
  const btn = $("#save");
  btn.disabled = true;
  btn.textContent = "Reading…";
  const err = await run(async () => {
    const r = await api("POST", "recipes", { url });
    data.recipes = [...data.recipes, r].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
    $("#url").value = "";
    say("done", `Saved ${r.title}.`);
    pick(r.id);
  });
  btn.disabled = false;
  btn.textContent = "Save";
  // No recipe on the page: offer to type it in, with the link filled in.
  if (err?.manual) openEditor(null);
});
$("#by-hand").addEventListener("click", () => openEditor(null));

// ── importing a file of recipes ────────────────────────────────────────────

// "3 already in your box, 1 had no recipe"
function skippedSummary(skipped) {
  const why = new Map();
  for (const s of skipped) why.set(s.why, (why.get(s.why) || 0) + 1);
  return [...why].map(([w, n]) => `${n} ${w}`).join(", ");
}

const IMAGE = /\.(jpe?g|png|webp|gif)$/i;
const MAX_SIDE = 1200, MAX_BYTES = 560 * 1024;   // under the site's 600 KB (PHOTO_BYTES in src/recipes.js)

// What was picked (an export's HTML, its images, its folder, or its .zip) as
// the HTML files and a map of picture name → a way to read it.
async function gather(files) {
  const html = [], images = new Map();
  for (const f of files) {
    const name = f.webkitRelativePath || f.name;
    if (/\.zip$/i.test(name)) {
      for (const z of await unzip(f)) {
        if (/\.html?$/i.test(z.name) && !/(^|\/)__MACOSX\//.test(z.name)) html.push({ name: z.name.split("/").pop(), text: async () => (await z.blob()).text() });
        else if (IMAGE.test(z.name)) images.set(fileKey(z.name), z.blob);
      }
    } else if (/\.html?$/i.test(name)) html.push({ name: f.name, text: () => f.text() });
    else if (IMAGE.test(name)) images.set(fileKey(name), () => Promise.resolve(f));
  }
  return { html, images };
}

// A picture made small enough to keep: at most MAX_SIDE across, as a JPEG. Small ones go as they are.
async function shrink(blob) {
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const known = head[0] === 0xff && head[1] === 0xd8 || head[0] === 0x89 && head[1] === 0x50 || head[0] === 0x47 && head[1] === 0x49 || head[0] === 0x52 && head[1] === 0x49;
  if (known && blob.size <= MAX_BYTES / 2) return blob;
  const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" }).catch(() => null);
  if (!bmp) return null;
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  for (const q of [0.85, 0.75, 0.6, 0.45]) {
    const out = await new Promise(res => canvas.toBlob(res, "image/jpeg", q));
    if (out && out.size <= MAX_BYTES) return out;
  }
  return null;
}
const base64 = async blob => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const putIn = list => {
  const ids = new Set(list.map(r => r.id));
  data.recipes = [...data.recipes.filter(r => !ids.has(r.id)), ...list].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
};

// Imports every recipe in what was picked, then gives each recipe that has no
// picture yet (new, or already in the box) the export's photo for it, when
// that photo was picked too. So importing the same export again, with its
// pictures, fills in the ones that are missing.
async function importFiles(files) {
  for (const b of ["#import", "#import-dir"]) $(b).disabled = true;
  const err = await run(async () => {
    const { html, images } = await gather(files);
    if (!html.length) throw new Error("pick a recipe file (.html), or the export's folder or .zip");
    const added = [], skipped = [], wants = [];   // wants: {id, photo} for recipes without a picture
    let total = 0, done = 0, pointed = 0;
    const named = html.length === 1 ? html[0].name : `${html.length} files`;
    for (const h of html) {
      const pages = splitPages(await h.text());
      total += pages.length;
      for (const group of batches(pages)) {
        say("done", `Importing ${named}: ${done} of ${total}…`);
        const out = await api("POST", "recipes/import", { pages: group });
        added.push(...out.added);
        skipped.push(...out.skipped);
        group.forEach((page, i) => {
          const photo = photoOf(page), r = out.pages?.[i];
          if (photo) pointed++;
          if (photo && r && !r.image && images.has(fileKey(photo))) wants.push({ id: r.id, photo });
        });
        done += group.length;
        putIn(out.added);
        renderList();
      }
    }
    if (!added.length && !wants.length && total === 1 && skipped[0]?.why === "had no recipe") throw new Error("couldn't find a recipe in that file");
    let pictures = 0, unreadable = 0;
    const queue = [...wants];
    const worker = async () => {
      for (let w; (w = queue.shift());) {
        const small = await shrink(await images.get(fileKey(w.photo))());
        if (!small) { unreadable++; continue; }
        putIn([await api("POST", `recipes/${w.id}/photo`, { data: await base64(small) })]);
        pictures++;
        say("done", `Adding pictures: ${pictures + unreadable} of ${wants.length}…`);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const pics = `${pictures} picture${pictures === 1 ? "" : "s"}`;
    // Only filling in pictures: say that, not that every recipe was skipped.
    const fillOnly = !added.length && pictures;
    let text = fillOnly ? `Added ${pics} from ${named} to recipes already in your box.`
      : `Imported ${added.length} recipe${added.length === 1 ? "" : "s"} from ${named}${pictures ? ` and added ${pics}` : ""}.`;
    const rest = fillOnly ? skipped.filter(s => s.why !== "already in your box") : skipped;
    if (rest.length) text += ` Skipped ${rest.length}: ${skippedSummary(rest)}.`;
    if (unreadable) text += ` ${unreadable} picture${unreadable === 1 ? "" : "s"} couldn't be read.`;
    if (pointed && !images.size) text += " To bring their pictures too, import the export's whole folder (or its .zip).";
    say("done", text);
    renderList();
    if (added.length) pick(added[0].id);
    else if (wants.length) pick(wants[0].id);
  });
  for (const b of ["#import", "#import-dir"]) $(b).disabled = false;
  $("#import-file").value = "";
  $("#import-folder").value = "";
  return err;
}
$("#import").addEventListener("click", () => $("#import-file").click());
$("#import-dir").addEventListener("click", () => $("#import-folder").click());
for (const input of ["#import-file", "#import-folder"]) $(input).addEventListener("change", e => e.target.files.length && importFiles([...e.target.files]));

// ── reading a recipe from a photo ──────────────────────────────────────────

// Anthropic shrinks anything longer than this across, so there's no use sending more.
const PHOTO_SIDE = 1568, PHOTO_BYTES = 3_500_000;

// A phone's photo as a JPEG at most PHOTO_SIDE across, the right way up.
async function shrinkPhoto(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  if (!bmp) throw new Error(`${file.name} isn't a picture this browser can read`);
  const k = Math.min(1, PHOTO_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";  // a PNG screenshot's see-through parts, white rather than black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  for (const q of [0.88, 0.78, 0.65]) {
    const blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", q));
    if (blob && blob.size <= PHOTO_BYTES) return blob;
  }
  throw new Error(`${file.name} is too big even after shrinking it`);
}

let keyThen = null;  // what to do once a key is saved
function askForKey(then) {
  if (!data.photo?.sealing) { say("error", "This site can't keep API keys yet, so photos can't be read. Ask its admin to set CHAT_BRIDGE_KEY."); return; }
  keyThen = then;
  $("#key-form").reset();
  $("#keyer").showModal();
}
$("#keyer").addEventListener("close", () => {
  const then = keyThen;
  keyThen = null;
  if ($("#keyer").returnValue !== "save") return;
  run(async () => {
    data.photo = (await api("PUT", "key", { key: $("#key-form").key.value.trim() })).photo;
    say("done", "Key saved.");
    then?.();
  });
});

// A photo is read by Claude when you've added an Anthropic key, otherwise by
// the site's own AI (Workers AI: no key), and only when neither can, on this
// device by text recognition (Tesseract, in vendor/tesseract: no AI). Either
// way it opens in the editor to check first.
function pickPhoto() {
  if (data) $("#photo-file").click();
}

const OCR = "/recipes/vendor/tesseract/";
let tesseract = null;  // the library, loaded the first time it's needed
function loadTesseract() {
  tesseract ||= new Promise((ok, bad) => {
    const s = el("script", { src: OCR + "tesseract.min.js" });
    s.onload = () => ok(window.Tesseract);
    s.onerror = () => { tesseract = null; bad(new Error("text recognition couldn't load; check your connection and try again")); };
    document.head.append(s);
  });
  return tesseract;
}

// A photo at a size text recognition reads well, the right way up (./ocr.js).
async function forReading(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  if (!bmp) throw new Error(`${file.name} isn't a picture this browser can read`);
  return sized(bmp);
}

// The text in the pictures, read here: page after page.
async function recognize(files) {
  const T = await loadTesseract();
  let page = 0;
  const worker = await T.createWorker("eng", 1, {
    workerPath: OCR + "worker.min.js", corePath: OCR, langPath: OCR.slice(0, -1), workerBlobURL: false,
    logger: m => {
      if (m.status === "recognizing text") say("done", `Reading ${files.length > 1 ? `photo ${page} of ${files.length}` : "the photo"}… ${Math.round(m.progress * 100)}%`);
      else if (/loading/.test(m.status)) say("done", "Getting text recognition ready… (the first time takes a moment)");
    },
  });
  try {
    // Find the page's own layout (columns, blocks), not one block of lines across it.
    await worker.setParameters({ tessedit_pageseg_mode: T.PSM.AUTO, preserve_interword_spaces: "0" });
    const texts = [];
    let title = "", picture = null;
    for (const f of files) {
      page++;
      // Read in clean black and white (ruled lines, coloured ink and shadows gone);
      // the dish's picture is looked for in the colour photo.
      const canvas = await forReading(f), ink = blackAndWhite(canvas);
      const { data: d } = await worker.recognize(ink, {}, { text: true, blocks: true });
      const lines = (d.blocks || []).flatMap(b => (b.paragraphs || []).flatMap(p => p.lines || []));
      fixFractions(ink, lines);
      const got = lines.length ? arrange(lines) : { text: d.text, title: "" };
      texts.push(got.text);
      if (page === 1) { title = got.title; picture = pictureIn(canvas, lines); }
    }
    return { text: texts.join("\n\n"), title, picture };
  } finally {
    worker.terminate();
  }
}

// Where the dish's photo is on the page: looked for in a copy about 200 across,
// with the text lines that were read kept out.
function pictureIn(canvas, lines) {
  const k = Math.min(1, 200 / canvas.width);
  const small = Object.assign(document.createElement("canvas"), { width: Math.round(canvas.width * k), height: Math.round(canvas.height * k) });
  const ctx = small.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, small.width, small.height);
  const text = lines.filter(l => l.text.trim()).map(({ bbox: b }) => ({ x0: b.x0 * k, y0: b.y0 * k, x1: b.x1 * k, y1: b.y1 * k }));
  return findPicture(ctx.getImageData(0, 0, small.width, small.height), text);
}

// The recipe's picture from its photo: the box (fractions across and down) cut
// out, or the whole photo; at most MAX_SIDE across, small enough to keep.
async function cutPicture(file, box) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  if (!bmp) return null;
  const b = box || { x0: 0, y0: 0, x1: 1, y1: 1 };
  const sx = b.x0 * bmp.width, sy = b.y0 * bmp.height, sw = (b.x1 - b.x0) * bmp.width, sh = (b.y1 - b.y0) * bmp.height;
  const k = Math.min(1, MAX_SIDE / Math.max(sw, sh));
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.max(1, Math.round(sw * k)), height: Math.max(1, Math.round(sh * k)) });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  for (const q of [0.85, 0.75, 0.6, 0.45]) {
    const out = await new Promise(res => canvas.toBlob(res, "image/jpeg", q));
    if (out && out.size <= MAX_BYTES) return out;
  }
  return null;
}

let lastPhotos = [];  // what the open draft was read from, to read again with Claude
// `claude`: read by the site (Claude with a key, or its AI without), not here.
async function fromPhotos(files, { claude = !!(data.photo?.ready || data.photo?.ai) } = {}) {
  const btn = $("#photo");
  btn.disabled = true;
  // The button is in the closed menu, so the page says it's reading.
  say("done", `Reading ${files.length === 1 ? "the photo" : `${files.length} photos`}…`);
  const err = await run(async () => {
    if (files.length > 4) throw new Error("pick at most 4 pictures of one recipe");
    lastPhotos = files;
    const shots = await Promise.all(files.map(async f => "data:image/jpeg;base64," + await base64(await shrinkPhoto(f))));
    let recipe, how = "ocr", why = "", box = null;
    if (claude) {
      const who = data.photo?.ready ? "with Claude" : "with the site's AI";
      say("done", `Reading ${files.length === 1 ? "the photo" : `${files.length} photos`} ${who}… this takes a few seconds.`);
      try {
        const out = await api("POST", "photo", { images: shots.map(s => ({ data: s.slice(s.indexOf(",") + 1) })) });
        ({ recipe } = out);
        how = out.by === "ai" ? "ai" : "claude";
        if (out.why) {
          if (/didn't accept your API key/i.test(out.why)) data.photo = { ...data.photo, ready: false };
          why = `Claude couldn't read it (${out.why.split(/\.\s/)[0].replace(/\.$/, "")})`;
        }
      } catch (e) {
        // A key that was revoked or ran out, the AI busy, no connection: read it here instead.
        if (/didn't accept your API key/i.test(e.message)) data.photo = { ...data.photo, ready: false };
        if (/couldn't find a recipe/i.test(e.message)) throw e;  // it read it and found none: text recognition won't do better
        why = `${data.photo?.ready ? "Claude" : "The site's AI"} couldn't read it (${e.message.split(/\.\s/)[0].replace(/\.$/, "")})`;
      }
    }
    if (how === "ocr") {
      const { text, title, picture } = await recognize(files);
      recipe = readRecipe(text, { title });
      box = picture;
      if (!recipe) throw new Error(`${why ? `${why}, and text recognition ` : ""}couldn't find a recipe in that photo. A sharper, straighter photo helps; or add it with Paste text`);
    }
    if (how !== "ocr") box = recipe.picture || null;
    delete recipe.picture;
    say("done", "");
    const blob = await cutPicture(files[0], box);
    openEditor(null, recipe, shots, how, why, blob && { blob, whole: !box });
  });
  btn.disabled = false;
  $("#photo-file").value = "";
}

// From the editor: the same photos again, with Claude (asking for a key first if there isn't one).
$("#with-claude").addEventListener("click", () => {
  const files = lastPhotos;
  $("#editor").close("cancel");
  const go = () => fromPhotos(files, { claude: true });
  data.photo?.ready ? go() : askForKey(go);
});

// ── pasting a recipe's text ────────────────────────────────────────────────

$("#paste").addEventListener("click", () => { $("#paste-form").reset(); $("#paster").showModal(); });
$("#paster").addEventListener("close", () => {
  if ($("#paster").returnValue !== "read") return;
  const recipe = readRecipe($("#paste-form").text.value);
  if (!recipe) { say("error", "Couldn't find a recipe in that text: no ingredients or steps."); return; }
  say("error", "");
  openEditor(null, recipe, [], "text");
});
$("#photo").addEventListener("click", pickPhoto);

// Suggest labels: any button marked data-suggest-labels, wherever it sits.
async function reload() {
  const fresh = await api("GET", "recipes");
  data = { ...data, ...fresh };
  renderFilters();
  renderList();
  renderDetail();
}
const suggest = () => run(() => openSuggestions({ api, say, done: reload }));
document.addEventListener("click", e => { if (e.target.closest("[data-suggest-labels]")) suggest(); });
$("#photo-file").addEventListener("change", e => e.target.files.length && fromPhotos([...e.target.files]));
$("#find").addEventListener("input", () => { page = 0; follow = false; renderList(); renderDetail(); });

// The one search box finds by name (titles, labels, any ingredient's words) or
// by ingredient (every one of these, commas between; -nuts leaves those out).
const FIND_HINT = { name: "Find a recipe", ingredient: "With ingredients: eggs, spinach, -nuts" };
function findMode(mode, focus = true) {
  findBy = mode;
  for (const b of document.querySelectorAll(".mode button")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  $("#find").placeholder = FIND_HINT[mode];
  $("#find").setAttribute("aria-label", mode === "name" ? "Find a recipe" : "Find recipes with these ingredients, separated by commas; a minus leaves one out");
  page = 0; follow = false; renderList(); renderDetail();
  if (focus) $("#find").focus();
}
for (const b of document.querySelectorAll(".mode button")) b.addEventListener("click", () => findMode(b.dataset.mode));

// "More ways to add": a menu that closes once something in it is picked, on
// Escape, or on a click anywhere else.
const addMenu = $("#add-menu");
addMenu.addEventListener("click", e => { if (e.target.closest(".menu-list button")) addMenu.open = false; });
addMenu.addEventListener("keydown", e => { if (e.key === "Escape" && addMenu.open) { addMenu.open = false; addMenu.querySelector("summary").focus(); } });
document.addEventListener("click", e => { if (addMenu.open && !addMenu.contains(e.target)) addMenu.open = false; });

// Deleting is in the editor, out of the way of the everyday buttons.
$("#delete-recipe").addEventListener("click", () => {
  const r = editing;
  if (!r?.id || !confirm(`Delete ${r.title}?`)) return;
  editing = null;
  $("#editor").close();
  run(async () => {
    await api("DELETE", "recipes/" + r.id);
    data.recipes = data.recipes.filter(x => x.id !== r.id);
    renderFilters();
    pick(data.recipes[0]?.id || null);
  });
});

document.addEventListener("keydown", e => {
  const t = e.target;
  if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || t.matches?.("input, textarea, select") || $("#editor").open || $("#keyer").open || $("#paster").open || $("#sharer").open || $("#suggester")?.open) {
    if (e.key === "Escape" && t === $("#find")) { t.value = ""; renderList(); renderDetail(); t.blur(); }
    return;
  }
  const r = current();
  const at = shown.indexOf(open);
  const keys = {
    // The same letters as the terminal's Recipe box: a from a link, n by hand.
    a: () => $("#url").focus(),
    n: () => openEditor(null),
    l: () => $("#label-filter").disabled || $("#label-filter").focus(),
    "/": () => findMode("name"),
    f: () => findMode("ingredient"),
    "[": () => $("#pager button:first-child")?.click(),
    "]": () => $("#pager button:last-child")?.click(),
    j: () => shown.length && pick(shown[Math.min(shown.length - 1, at + 1)]),
    k: () => shown.length && pick(shown[Math.max(0, at - 1)]),
    "+": () => r && step(r, 1), "=": () => r && step(r, 1),
    "-": () => r && step(r, -1),
    e: () => r && openEditor(r),
    i: () => $("#import-file").click(),
    p: () => pickPhoto(),
    t: () => $("#paste").click(),
    L: () => suggest(),
    u: () => r && openShare(r),
    s: () => r && $("#send") && !$("#send").disabled && $("#send").click(),
    // English: translate the open recipe, or flip between it and the original.
    m: () => r && toggleMade(r),
    ...Object.fromEntries([1, 2, 3, 4, 5].map(n => [String(n), () => r && rate(r, n)])),
    0: () => r && r.rating && mark(r, { rating: 0 }),
    M: () => $("#made-filter").focus(),
    R: () => $("#rating-filter").focus(),
    E: () => { if (!r) return; const tr = english.get(r.id); if (tr) { tr.on = !tr.on; renderDetail(); } else translate(r); },
  };
  if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
});

run(async () => {
  data = await api("GET", "recipes");
  const want = location.hash.slice(1);
  open = data.recipes.some(r => r.id === want) ? want : data.recipes[0]?.id || null;
  sortKey = store.get("recipes:sort") || "";
  renderFilters();
  renderList();
  renderDetail();
});
