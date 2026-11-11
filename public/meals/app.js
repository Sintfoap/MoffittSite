// Meal plan: a week of dinners, a row per night with what's on in Drift that
// day, and the week's shopping underneath. The Worker side is src/meals.js;
// it decides which nights are busy and picks the recipes.

const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter(k => k != null));
  return n;
};

let data = null;          // GET /meals/api/week: {start, days, recipes, shopping, lists, drift, ...}
const skip = new Set();   // shopping lines (by text) not to send, while the page is open

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

async function api(method, path, body) {
  const res = await fetch("/meals/api/" + path, {
    method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname); throw new Error("not signed in"); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `the site answered ${res.status}`);
  return out;
}

function say(kind, text) {
  for (const k of ["error", "done"]) { $("#" + k).hidden = k !== kind || !text; if (k === kind) $("#" + k).textContent = text || ""; }
}
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

async function run(fn) {
  say("error", "");
  try { await fn(); } catch (e) { say("error", cap(e.message || String(e))); }
}

// Dates are plain YYYY-MM-DD days, so they're read and shown in UTC to stay put.
const asDate = d => new Date(d + "T00:00:00Z");
const fmt = (d, o) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...o }).format(asDate(d));
const localToday = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`; };
const clock = t => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "am" : "pm"}`; };
const recipeOf = id => data.recipes.find(r => r.id === id) || null;

async function load(start) {
  data = await api("GET", "week?start=" + encodeURIComponent(start || localToday()));
  history.replaceState(null, "", data.start === weekOf(localToday()) ? location.pathname : "#" + data.start);
  render();
}
// The Monday of the week holding a day, the same as the Worker works it out.
function weekOf(d) {
  const t = asDate(d);
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
}

// ── the week ───────────────────────────────────────────────────────────────
// One row per night: the day, what's for dinner (a link to it in Recipe box)
// and what's on. The picked night (tonight, to start with) opens its controls.

let sel = null;           // the picked night's day

function render() {
  const end = data.days[6].day;
  $("#weekname").textContent = `${fmt(data.start, { month: "short", day: "numeric" })} – ${fmt(end, { month: asDate(end).getUTCMonth() === asDate(data.start).getUTCMonth() ? undefined : "short", day: "numeric" })}`;
  $("h1").textContent = data.start === weekOf(localToday()) ? "This week's dinners" : `Dinners, week of ${fmt(data.start, { month: "long", day: "numeric" })}`;
  if (!data.days.some(d => d.day === sel)) sel = (data.days.find(d => d.day === localToday()) || data.days[0]).day;
  const box = $("#week");
  box.replaceChildren();
  if (!data.recipes.length) {
    box.append(el("p", { className: "empty", textContent: data.recipe_box
      ? "Your Recipe box is empty. Save a few recipes there and they'll be planned here." : "Meal plan picks from your Recipe box; ask the site's admin to turn it on for you." }));
  }
  if (!data.drift) say("done", "Without Drift, Meal plan can't see your calendar, so every night is planned the same. Ask the site's admin for Drift.");
  renderClub();
  for (const d of data.days) box.append(night(d));
  $("#fill").disabled = $("#redo").disabled = !data.recipes.length;
  renderShopping();
}

// The month's Food club pick, offered for the first open night left this week.
function renderClub() {
  const box = $("#club"), c = data.club;
  box.replaceChildren();
  box.hidden = !c || c.planned || c.made;
  if (box.hidden) return;
  box.append(el("span", {}, "Food club this month: ", el("a", { href: `/food/#${c.id}`, textContent: c.title }), ". "));
  if (!c.recipe) { box.append(el("span", { textContent: "Save it to your Recipe box from Food club to plan it." })); return; }
  const open = data.days.filter(d => !d.past && !d.out && !d.away && !d.locked);
  const night = open.find(d => !d.busy) || open[0];
  if (!night) return;
  const b = el("button", { type: "button", className: "link", textContent: `Plan it for ${night.name}` });
  b.addEventListener("click", () => setNight(night, { recipe: c.recipe }));
  box.append(b);
}

function night(d) {
  const r = recipeOf(d.recipe), open = d.day === sel;
  const row = el("li", { className: "night" + (d.day === localToday() ? " today" : "") + (d.out || d.away ? " out" : "") + (d.past ? " past" : "") + (open ? " open" : "") });
  row.addEventListener("click", e => { if (!e.target.closest("a, button, select") && sel !== d.day) { sel = d.day; render(); } });
  const when = el("div", { className: "when" }, el("b", { textContent: d.name }), el("span", { textContent: fmt(d.day, { day: "numeric" }) }));
  if (d.busy && !d.past) when.append(el("span", { className: "tag busy", textContent: "busy", title: d.why }));
  const dish = el("div", { className: "dish" });
  if (d.away) dish.append(el("span", { className: "none", textContent: `Away: ${d.away}` }));
  else if (d.out) dish.append(el("span", { className: "none", textContent: "Out tonight" }));
  else if (r) {
    dish.append(el("a", { href: `/recipes/#${r.id}`, textContent: r.title, title: "Open in Recipe box" }));
    const facts = [r.time, d.servings ? `serves ${d.servings}` : ""].filter(Boolean).join(" · ");
    if (facts) dish.append(el("small", { textContent: facts }));
    if (d.slow && !d.past) dish.append(el("span", { className: "tag slow", textContent: "takes a while", title: `${d.why}, and this takes ${r.time}` }));
  } else dish.append(el("span", { className: "none", textContent: d.busy ? "Nothing yet: a quick one fits" : "Nothing planned" }));
  const on = el("div", { className: "on" });
  if (d.events.length && !d.past) on.append(...d.events.slice(0, 3).flatMap((e, i) => [i ? " · " : "", el("span", { title: e.title }, e.time ? el("time", { textContent: clock(e.time) + " " }) : "", e.title)]),
    d.events.length > 3 ? ` +${d.events.length - 3}` : "");
  row.append(when, dish, on);
  if (open && !d.away) row.append(controls(d, r));
  return row;
}

// The picked night's controls: which recipe, how many it serves, Lock and Out.
function controls(d, r) {
  const box = el("div", { className: "controls" });
  if (!d.out) {
    const pick = el("select", {});
    pick.setAttribute("aria-label", `Dinner on ${d.name}`);
    pick.append(new Option("Nothing planned", ""));
    const opt = x => new Option(x.title + (x.time ? ` (${x.time})` : ""), x.id);
    const dinners = data.recipes.filter(x => x.dinner), rest = data.recipes.filter(x => !x.dinner);
    if (dinners.length && rest.length) {
      pick.append(el("optgroup", { label: "Dinners" }, ...dinners.map(opt)), el("optgroup", { label: "Everything else" }, ...rest.map(opt)));
    } else pick.append(...data.recipes.map(opt));
    pick.value = d.recipe || "";
    pick.addEventListener("change", () => setNight(d, { recipe: pick.value || null }));
    box.append(pick);
  }
  if (r && !d.out) {
    const less = el("button", { type: "button", textContent: "−", title: "Fewer servings (-)" }), more = el("button", { type: "button", textContent: "+", title: "More servings (+)" });
    less.setAttribute("aria-label", "Fewer servings");
    more.setAttribute("aria-label", "More servings");
    const n = d.servings;
    less.addEventListener("click", () => n && setNight(d, { servings: Math.max(1, Math.round(n) - 1) }));
    more.addEventListener("click", () => setNight(d, { servings: Math.round(n || r.servings || 1) + 1 }));
    less.disabled = !n || n <= 1;
    box.append(el("span", { className: "serves" }, less, el("output", { textContent: n ? `serves ${n}` : "as written" }), more));
  }
  const toggle = (label, on, change, title) => {
    const b = el("button", { type: "button", textContent: label, title });
    b.setAttribute("aria-pressed", String(on));
    b.addEventListener("click", () => setNight(d, change));
    return b;
  };
  if (!d.out) box.append(toggle("Lock", d.locked, { locked: !d.locked }, "Keep this night when the week is filled or shuffled (l)"));
  box.append(toggle("Out", d.out, { out: !d.out }, "Eating out: nothing to cook or buy (o)"));
  return box;
}

async function setNight(d, change) {
  await run(async () => {
    data = await api("PUT", `week/${data.start}/${d.day}`, change);
    render();
  });
}

async function fill(redo) {
  const btn = redo ? $("#redo") : $("#fill");
  btn.disabled = true;
  await run(async () => {
    data = await api("POST", `week/${data.start}/fill`, redo ? { redo: true } : {});
    say("done", "");
    render();
  });
  btn.disabled = !data?.recipes.length;
}

// ── shopping ───────────────────────────────────────────────────────────────

function listChoices() {
  const mine = data.lists.find(l => !l.owner_name && l.name.toLowerCase() === "shopping list");
  const opts = [new Option(mine ? "Shopping list" : "Shopping list (new)", "")];
  for (const l of data.lists) if (l !== mine) opts.push(new Option(l.owner_name ? `${l.name} (${l.owner_name}'s)` : l.name, l.id));
  return opts;
}

// Staples (salt, oil…) start unticked: most kitchens have them.
const kept = new Set();
const ticked = s => s.staple ? kept.has(s.line) : !skip.has(s.line);

function renderShopping() {
  const ul = $("#shopping"), send = $("#send-row");
  ul.replaceChildren();
  send.replaceChildren();
  const note = $("#shop-note");
  note.textContent = data.shopped ? `Sent ${data.shopped.added} to ${data.shopped.list} on ${fmt(data.shopped.at.slice(0, 10), { weekday: "long", month: "short", day: "numeric" })}.` : "";
  note.hidden = !data.shopped;
  if (!data.shopping.length) {
    ul.append(el("li", { className: "empty", textContent: data.days.some(d => d.past && d.recipe) && !data.days.some(d => !d.past && d.recipe)
      ? "Every night planned this week is past." : "Plan some dinners and what to buy shows up here." }));
    return;
  }
  let aisle = null;
  data.shopping.forEach(s => {
    const head = s.staple ? "Probably have" : s.aisle;
    if (head !== aisle) { aisle = head; ul.append(el("li", { className: "aisle", textContent: head })); }
    const box = el("input", { type: "checkbox", checked: ticked(s) });
    box.addEventListener("change", () => {
      if (s.staple) box.checked ? kept.add(s.line) : kept.delete(s.line);
      else box.checked ? skip.delete(s.line) : skip.add(s.line);
      renderShopping();
    });
    ul.append(el("li", {}, el("label", {}, box, el("span", {}, s.line, el("small", { textContent: s.for.join(", ") })))));
  });
  if (!data.drift) {
    send.append(el("p", { className: "empty", textContent: "Ask the site's admin for Drift to send these to a shopping list." }));
    return;
  }
  const n = data.shopping.filter(ticked).length;
  const sel = el("select", { id: "list" });
  sel.setAttribute("aria-label", "Drift list");
  sel.append(...listChoices());
  const remembered = store.get("meals:list") ?? store.get("recipes:list");
  if (remembered && [...sel.options].some(o => o.value === remembered)) sel.value = remembered;
  sel.addEventListener("change", () => store.set("meals:list", sel.value));
  const go = el("button", { className: "btn", type: "button", id: "send", textContent: `Send ${n} to`, disabled: !n });
  go.addEventListener("click", () => sendToList(sel.value));
  send.append(go, sel);
}

async function sendToList(list) {
  const lines = data.shopping.map((s, i) => ticked(s) ? i : -1).filter(i => i >= 0);
  await run(async () => {
    const out = await api("POST", `week/${data.start}/shop`, { lines, ...(list ? { list } : {}) });
    say("done", `Added ${out.added} to ${out.list.name} in Drift.`);
    data.shopped = out.shopped;
    if (!list && !data.lists.some(l => l.id === out.list.id)) data.lists.unshift({ id: out.list.id, name: out.list.name, owner_name: null });
    renderShopping();
  });
}

// ── controls ───────────────────────────────────────────────────────────────

const picked = () => data.days.find(d => d.day === sel);
function move(by) {
  const i = data.days.findIndex(d => d.day === sel);
  sel = data.days[Math.max(0, Math.min(6, i + by))].day;
  render();
}

$("#prev").addEventListener("click", () => run(() => load(data.prev)));
$("#next").addEventListener("click", () => run(() => load(data.next)));
$("#today").addEventListener("click", () => run(() => load()));
$("#fill").addEventListener("click", () => fill(false));
$("#redo").addEventListener("click", () => fill(true));

document.addEventListener("keydown", e => {
  const t = e.target;
  if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || t.matches?.("input, textarea, select") || !data) return;
  const keys = {
    "[": () => $("#prev").click(), "]": () => $("#next").click(), t: () => $("#today").click(),
    f: () => !$("#fill").disabled && fill(false), r: () => !$("#redo").disabled && fill(true),
    s: () => $("#send") && !$("#send").disabled && $("#send").click(),
    j: () => move(1), k: () => move(-1),
    l: () => { const d = picked(); if (d && !d.out && !d.away) setNight(d, { locked: !d.locked }); },
    o: () => { const d = picked(); if (d && !d.away) setNight(d, { out: !d.out }); },
    "+": () => { const d = picked(), r = d && recipeOf(d.recipe); if (r && !d.out) setNight(d, { servings: Math.round(d.servings || r.servings || 1) + 1 }); },
    "-": () => { const d = picked(); if (d?.servings > 1 && !d.out) setNight(d, { servings: Math.round(d.servings) - 1 }); },
  };
  if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
});

run(() => load(/^#\d{4}-\d{2}-\d{2}$/.test(location.hash) ? location.hash.slice(1) : null));
