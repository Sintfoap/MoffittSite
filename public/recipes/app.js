// Recipe box: your recipes down the side, the open one beside them, scaled
// to the servings you pick, with its ingredients ready to send to a Drift
// list. The Worker side is src/recipes.js; scaling is ./scale.js.

import { scaleLine, factorFor, format } from "./scale.js";

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

// ── the list ───────────────────────────────────────────────────────────────

function renderList() {
  const q = $("#find").value.trim().toLowerCase();
  const match = data.recipes.filter(r => !q || r.title.toLowerCase().includes(q) || r.ingredients.some(i => i.toLowerCase().includes(q)));
  shown = match.map(r => r.id);
  const ul = $("#recipes");
  ul.replaceChildren();
  if (!data.recipes.length) ul.append(el("li", { className: "empty", textContent: "No recipes yet. Paste a link above." }));
  else if (!match.length) ul.append(el("li", { className: "empty", textContent: "Nothing matches." }));
  for (const r of match) {
    const b = el("button", { type: "button" }, r.title, el("small", { textContent: [r.time, hostOf(r.source)].filter(Boolean).join(" · ") || `${r.ingredients.length} ingredients` }));
    b.setAttribute("aria-current", String(r.id === open));
    b.addEventListener("click", () => pick(r.id));
    ul.append(el("li", {}, b));
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
  const r = current();
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
  card.append(el("h2", { textContent: r.title }));
  const facts = el("div", { className: "facts" });
  const bits = [r.time, r.yield && !/^\d+(\.\d+)?$/.test(r.yield) ? r.yield : ""].filter(Boolean);
  facts.append(bits.join(" · "));
  if (r.source) {
    if (bits.length) facts.append(" · ");
    facts.append(el("a", { href: r.source, textContent: hostOf(r.source) || "source", target: "_blank", rel: "noopener noreferrer" }));
  }
  card.append(facts);

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
    ul.append(el("li", {}, el("label", {}, box, el("span", { className: scaled !== line ? "changed" : "", textContent: scaled }))));
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
  edit.addEventListener("click", () => openEditor(r));
  const del = el("button", { className: "btn danger", type: "button", textContent: "Delete" });
  del.addEventListener("click", () => {
    if (!confirm(`Delete ${r.title}?`)) return;
    run(async () => {
      await api("DELETE", "recipes/" + r.id);
      data.recipes = data.recipes.filter(x => x.id !== r.id);
      pick(data.recipes[0]?.id || null);
    });
  });
  card.append(el("div", { className: "actions" }, edit, del));
  box.append(card);
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

function openEditor(r) {
  editing = r || {};
  const f = $("#edit-form");
  $("#edit-title").textContent = r ? "Edit recipe" : "New recipe";
  f.title.value = r?.title || "";
  f.servings.value = r?.servings ?? "";
  f.yield.value = r?.yield || "";
  f.time.value = r?.time || "";
  f.ingredients.value = (r?.ingredients || []).join("\n");
  f.steps.value = (r?.steps || []).join("\n");
  f.notes.value = r?.notes || "";
  f.source.value = r?.source || (r ? "" : $("#url").value.trim());
  $("#editor").showModal();
  f.title.focus();
}

$("#editor").addEventListener("close", () => {
  if ($("#editor").returnValue !== "save" || !editing) return;
  const f = $("#edit-form");
  const body = {
    title: f.title.value, servings: f.servings.value === "" ? null : Number(f.servings.value), yield: f.yield.value, time: f.time.value,
    ingredients: f.ingredients.value, steps: f.steps.value, notes: f.notes.value, source: f.source.value,
  };
  const was = editing;
  editing = null;
  run(async () => {
    const saved = was.id ? await api("PATCH", "recipes/" + was.id, body) : await api("POST", "recipes", body);
    data.recipes = [...data.recipes.filter(x => x.id !== saved.id), saved].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
    if (was.servings !== saved.servings) scale.delete(saved.id);
    if (!was.id) $("#url").value = "";
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
$("#find").addEventListener("input", renderList);

document.addEventListener("keydown", e => {
  const t = e.target;
  if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || t.matches?.("input, textarea, select") || $("#editor").open) {
    if (e.key === "Escape" && t === $("#find")) { t.value = ""; renderList(); t.blur(); }
    return;
  }
  const r = current();
  const at = shown.indexOf(open);
  const keys = {
    n: () => $("#url").focus(),
    "/": () => $("#find").focus(),
    j: () => shown.length && pick(shown[Math.min(shown.length - 1, at + 1)]),
    k: () => shown.length && pick(shown[Math.max(0, at - 1)]),
    "+": () => r && step(r, 1), "=": () => r && step(r, 1),
    "-": () => r && step(r, -1),
    e: () => r && openEditor(r),
    s: () => r && $("#send") && !$("#send").disabled && $("#send").click(),
  };
  if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
});

run(async () => {
  data = await api("GET", "recipes");
  const want = location.hash.slice(1);
  open = data.recipes.some(r => r.id === want) ? want : data.recipes[0]?.id || null;
  renderList();
  renderDetail();
});
