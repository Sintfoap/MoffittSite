// Pantry: your food by where it's kept, with how much is left and when it
// expires. Add food, use some, buy more, or correct a purchase. The Worker
// side is src/pantry.js; public/pantry/units.js reads amounts and guesses a
// new item's kind from its name, here as there.

import { readAmount, UNITS, LEVELS, guess } from "./units.js";

const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter(k => k != null && k !== false));
  return n;
};

let data = null;            // GET /pantry/api/items: {items, places, counts, levels, usual_places}
let filter = "all";
const open = new Set();     // items showing their purchases
const day = () => new Date().toLocaleDateString("sv");

async function api(method, path, body) {
  const res = await fetch("/pantry/api/" + path, {
    method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname); throw new Error("not signed in"); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `the site answered ${res.status}`);
  return out;
}

function say(kind, text) {
  for (const k of ["error", "done"]) {
    const box = $("#" + k);
    box.hidden = k !== kind || !text;
    if (k === kind) box.textContent = text || "";
  }
}
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
async function run(fn) {
  say("error", "");
  try { await fn(); return true; } catch (e) { say("error", cap(e.message || String(e))); return false; }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const nice = s => `${MONTHS[Number(s.slice(5, 7)) - 1]} ${Number(s.slice(8, 10))}${s.slice(0, 4) === day().slice(0, 4) ? "" : `, ${s.slice(0, 4)}`}`;
function when(i) {
  if (!i.expires) return el("span", { className: "when" });
  if (i.expired) return el("span", { className: "when expired", textContent: `Expired ${nice(i.expires)}` });
  return el("span", { className: "when" + (i.soon ? " soon" : ""), textContent: `${i.soon ? "Use by" : "Expires"} ${nice(i.expires)}` });
}

// What a typed amount reads as, for the line under the box.
function reads(text, kind, unit) {
  if (!text.trim()) return { ok: true, text: "" };
  const a = readAmount(text);
  if (!a) return { ok: false, text: kind === "staple" ? "Needs a number and a unit, like 10 lb or 2 cups" : "Needs a number, like 3" };
  if (kind === "staple") {
    if (!a.unit) return { ok: false, text: a.word ? `Not a unit this knows: ${a.word}. Try lb, oz, g, kg, cups, tbsp, tsp, ml or L` : "Needs a unit, like lb or cups" };
    const u = UNITS[a.unit];
    return { ok: true, text: `Reads as ${a.n} ${a.n === 1 ? u.one : u.many} (by ${u.measure})` };
  }
  if (a.unit) return { ok: false, text: `Just how many ${unit || "of them"}, like 3` };
  return { ok: true, text: "" };
}
function showReads(box, text, kind, unit) {
  const r = reads(text, kind, unit);
  box.textContent = r.text;
  box.classList.toggle("bad", !r.ok);
}

// ── the list ───────────────────────────────────────────────────────────────

function shown() {
  const q = $("#find").value.trim().toLowerCase();
  return data.items.filter(i => (filter === "all" || (filter === "soon" ? i.soon : i.is_low || i.is_out))
    && (!q || i.name.toLowerCase().includes(q) || i.words.toLowerCase().includes(q)));
}

function gauge(level) {
  return el("span", { className: "gauge", ariaHidden: "true" }, ...[1, 2, 3, 4, 5].map(n => el("i", { className: n <= level ? "on" : "" })));
}

function row(i) {
  const name = el("button", { type: "button", textContent: i.name, title: i.kind === "gauged" ? "" : "Show each purchase" });
  name.ariaExpanded = String(open.has(i.id));
  name.addEventListener("click", () => { open.has(i.id) ? open.delete(i.id) : open.add(i.id); render(); });
  const extra = [i.kind === "counted" && i.size ? `${i.size} each` : "", i.words ? `also ${i.words}` : ""].filter(Boolean).join(" · ");
  const low = i.is_out ? " out" : i.is_low ? " low" : "";
  const have = el("span", { className: "have" + low },
    i.kind === "gauged" ? gauge(i.level) : null, i.text,
    i.kind === "staple" && i.low_text ? el("small", { textContent: i.is_out ? "Out" : i.is_low ? `Low (at ${i.low_text})` : `Low at ${i.low_text}` }) : null,
    i.kind !== "staple" && i.is_out ? el("small", { textContent: "Out" }) : null);
  const use = el("button", { type: "button", className: "btn", textContent: "Use", ariaLabel: `Use ${i.name}` });
  use.addEventListener("click", () => useDialog(i));
  const more = el("button", { type: "button", className: "btn quiet", textContent: i.kind === "gauged" ? "Refill" : "+ More", ariaLabel: `Bought more ${i.name}` });
  more.addEventListener("click", () => i.kind === "gauged" ? run(async () => { await api("POST", `items/${i.id}/use`, { level: 5 }); say("done", `${i.name} is full again.`); await load(); }) : lotDialog(i));
  const edit = el("button", { type: "button", className: "btn quiet", textContent: "Edit", ariaLabel: `Edit ${i.name}` });
  edit.addEventListener("click", () => itemDialog(i));
  const li = el("li", { className: "item" },
    el("div", { className: "line" },
      el("span", { className: "name" }, name, el("span", { className: "kind", textContent: i.kind }), extra ? el("small", { textContent: extra }) : null),
      have, when(i), el("span", { className: "acts" }, use, more, edit)));
  if (open.has(i.id) && i.kind !== "gauged") li.append(lots(i));
  return li;
}

function lots(i) {
  if (!i.lots.length) return el("ul", { className: "lots" }, el("li", { textContent: "None left. + More adds what you buy next." }));
  return el("ul", { className: "lots" }, ...i.lots.map(l => {
    const fix = el("button", { type: "button", textContent: "✎", title: "Correct this purchase", ariaLabel: `Correct the ${l.text} bought ${l.added}` });
    fix.addEventListener("click", () => lotDialog(i, l));
    const x = el("button", { type: "button", className: "x", textContent: "×", title: "Take this purchase off", ariaLabel: `Take off the ${l.text} bought ${l.added}` });
    x.addEventListener("click", () => {
      if (confirm(`Take the ${l.text} of ${i.name} bought ${nice(l.added)} off your pantry?`)) run(async () => { await api("DELETE", `items/${i.id}/lots/${l.id}`); await load(); });
    });
    return el("li", {}, el("b", { textContent: l.text }), el("span", { textContent: `bought ${nice(l.added)}` }),
      el("span", { textContent: l.expires ? `expires ${nice(l.expires)}` : "no expiry date" }), fix, x);
  }));
}

function render() {
  for (const f of ["all", "soon", "low"]) $("#n-" + f).textContent = data.counts[f] ? ` ${data.counts[f]}` : "";
  for (const b of document.querySelectorAll("[data-filter]")) b.ariaPressed = String(b.dataset.filter === filter);
  $("#place-list").replaceChildren(...[...new Set([...data.usual_places, ...data.places])].map(p => el("option", { value: p })));
  const box = $("#places");
  if (!data.items.length) {
    box.replaceChildren(el("section", { className: "card" }, el("p", { className: "empty", textContent: "Nothing in your pantry yet. Add food to start, like Whole wheat flour, 10 lb." })));
    return;
  }
  const items = shown();
  if (!items.length) {
    box.replaceChildren(el("p", { className: "empty", textContent: filter === "soon" ? "Nothing to use soon." : filter === "low" ? "Nothing's running low." : "Nothing matches." }));
    return;
  }
  box.replaceChildren(...data.places.map(p => {
    const here = items.filter(i => i.place === p);
    if (!here.length) return null;
    return el("section", { className: "card place" },
      el("h2", {}, p, el("small", { textContent: `${here.length}` })),
      el("ul", { className: "items" }, ...here.map(row)));
  }).filter(Boolean));
}

async function load() {
  data = await api("GET", `items?day=${day()}`);
  render();
}

// ── adding and editing food ────────────────────────────────────────────────

const itemForm = $("#item-form");
let editing = null, kindTouched = false;

function kindNow() { return itemForm.kind.value || "counted"; }
function showKind() {
  const k = kindNow(), changing = editing && editing.kind !== k;
  for (const box of itemForm.querySelectorAll("[data-kind]")) box.hidden = !box.dataset.kind.split(" ").includes(k);
  // The amount is asked for when adding, or when a new kind has to start from what's there now.
  itemForm.querySelector("[data-amount]").hidden = !(k !== "gauged" && (!editing || changing));
  for (const box of itemForm.querySelectorAll("[data-edit]")) box.hidden = !editing || changing;
  $("#amount-label").textContent = editing ? "How much you have now" : k === "counted" ? "How many you have" : "How much you have";
  itemForm.amount.placeholder = k === "counted" ? "2" : "10 lb";
  showReads($("#amount-reads"), itemForm.amount.value, k, itemForm.unit.value);
  showReads($("#low-reads"), itemForm.low.value, "staple");
}

function itemDialog(item = null) {
  editing = item;
  kindTouched = !!item;
  itemForm.reset();
  $("#item-title").textContent = item ? `Edit ${item.name}` : "Add food";
  itemForm.level.replaceChildren(...LEVELS.map((l, n) => el("option", { value: n, textContent: l })).reverse());
  if (item) {
    itemForm.name.value = item.name;
    itemForm.kind.value = item.kind;
    itemForm.place.value = item.place;
    itemForm.words.value = item.words;
    itemForm.low.value = item.low_text;
    itemForm.per_cup.value = item.per_cup ?? "";
    itemForm.shows.replaceChildren(...item.units.map(u => el("option", { value: u, textContent: UNITS[u].many, selected: u === item.shows })));
    itemForm.unit.value = item.unit;
    itemForm.size.value = item.size;
    if (item.kind === "gauged") { itemForm.level.value = item.level; itemForm.expires_gauged.value = item.expires; }
  } else {
    itemForm.kind.value = "counted";
  }
  showKind();
  $("#item-dialog").showModal();
  itemForm.name.focus();
}

// Until a kind is picked by hand, the name decides it (and where it's kept, and what one of it is).
itemForm.name.addEventListener("input", () => {
  if (kindTouched || editing) return;
  const g = guess(itemForm.name.value);
  itemForm.kind.value = g.kind;
  itemForm.place.placeholder = g.place;
  itemForm.unit.placeholder = g.unit || "can";
  itemForm.per_cup.placeholder = g.perCup ?? "120";
  showKind();
});
for (const r of itemForm.querySelectorAll("[name=kind]")) r.addEventListener("change", () => { kindTouched = true; showKind(); });
itemForm.amount.addEventListener("input", showKind);
itemForm.low.addEventListener("input", showKind);
itemForm.unit.addEventListener("input", showKind);

function itemBody() {
  const f = itemForm, k = kindNow(), g = guess(f.name.value), v = n => f[n].value.trim();
  const body = { name: v("name"), kind: k, place: v("place") || f.place.placeholder || g.place, words: v("words") };
  const changing = editing && editing.kind !== k;
  if (k !== "gauged" && (!editing || changing)) { body.amount = v("amount"); body.expires = f.expires.value; }
  if (k === "staple") {
    body.low = v("low");
    if (v("per_cup") || editing) body.per_cup = v("per_cup") ? Number(v("per_cup")) : null;
    if (editing && !changing && f.shows.value) body.shows = f.shows.value;
  }
  if (k === "counted") { body.unit = v("unit") || (editing ? "" : g.unit || ""); body.size = v("size"); }
  if (k === "gauged") { body.level = Number(f.level.value); body.expires = f.expires_gauged.value; }
  return body;
}

$("#item-dialog").addEventListener("close", () => {
  if ($("#item-dialog").returnValue !== "save") return;
  const body = itemBody(), was = editing;
  run(async () => {
    const out = was ? await api("PATCH", `items/${was.id}`, body) : await api("POST", "items", body);
    say("done", was ? `Saved ${out.name}.` : `Added ${out.name}: ${out.text}.`);
    await load();
  }).then(ok => { if (!ok) { editing = was; $("#item-dialog").showModal(); } });
});

// ── using some ─────────────────────────────────────────────────────────────

const useForm = $("#use-form");
let using = null;

function useDialog(i) {
  using = i;
  useForm.reset();
  $("#use-title").textContent = `Use ${i.name}`;
  $("#use-have").textContent = i.kind === "gauged" ? `It's at ${i.text.toLowerCase()}. How full is it now?` : `You have ${i.text}.`;
  for (const box of useForm.querySelectorAll("[data-use]")) box.hidden = !box.dataset.use.split(" ").includes(i.kind);
  $("#use-label").textContent = i.kind === "counted" ? `How many ${i.unit}s you used (part of one counts as one)` : "How much you used";
  useForm.amount.placeholder = i.kind === "counted" ? "1" : `1 ${i.measure === "volume" ? "cup" : UNITS[i.shows]?.one || "cup"}`;
  if (i.kind === "counted") useForm.amount.value = "1";
  $("#use-reads").textContent = "";
  $("#levels").replaceChildren(...LEVELS.map((l, n) => {
    const b = el("button", { type: "button", textContent: l, ariaPressed: String(n === i.level) });
    b.addEventListener("click", () => { $("#use-dialog").close("cancel"); send({ level: n }, `${i.name} is at ${l.toLowerCase()}.`); });
    return b;
  }).reverse());
  $("#use-dialog").showModal();
  (i.kind === "gauged" ? $("#levels button[aria-pressed=true]") || $("#levels button") : useForm.amount).focus();
  if (i.kind === "counted") useForm.amount.select();
}
useForm.amount.addEventListener("input", () => showReads($("#use-reads"), useForm.amount.value, using.kind, using.unit));

function send(body, said) {
  const i = using;
  run(async () => {
    const out = await api("POST", `items/${i.id}/use`, body);
    say("done", said || `${i.name}: ${out.text} left.`);
    await load();
  });
}
$("#use-dialog").addEventListener("close", () => {
  const how = $("#use-dialog").returnValue, i = using;
  if (how === "use") {
    const n = useForm.amount.value.trim();
    send({ amount: i.kind === "counted" ? Number(n) || n : n });
  } else if (how === "all") send({ all: true }, `Used up the ${i.name}.`);
  else if (how === "toss") send({ all: true, tossed: true }, `Tossed the ${i.name}.`);
});

// ── buying more, and correcting a purchase ─────────────────────────────────

const lotForm = $("#lot-form");
let lotFor = null;

function lotDialog(i, lot = null) {
  lotFor = { item: i, lot };
  lotForm.reset();
  $("#lot-title").textContent = lot ? `Correct the ${i.name} bought ${nice(lot.added)}` : `Bought more ${i.name}`;
  $("#lot-label").textContent = i.kind === "counted" ? `How many ${i.unit}s` : "How much";
  lotForm.amount.placeholder = i.kind === "counted" ? "2" : `5 ${UNITS[i.shows]?.many || "lb"}`;
  if (lot) { lotForm.amount.value = i.kind === "counted" ? String(lot.amount) : lot.text; lotForm.expires.value = lot.expires; }
  $("#lot-reads").textContent = "";
  $("#lot-dialog").showModal();
  lotForm.amount.focus();
}
lotForm.amount.addEventListener("input", () => showReads($("#lot-reads"), lotForm.amount.value, lotFor.item.kind, lotFor.item.unit));
$("#lot-dialog").addEventListener("close", () => {
  if ($("#lot-dialog").returnValue !== "save") return;
  const { item, lot } = lotFor, body = { amount: lotForm.amount.value.trim(), expires: lotForm.expires.value };
  run(async () => {
    const out = lot ? await api("PATCH", `items/${item.id}/lots/${lot.id}`, body) : await api("POST", `items/${item.id}/lots`, body);
    say("done", `${item.name}: ${out.text} now.`);
    await load();
  });
});

// ── the page ───────────────────────────────────────────────────────────────

for (const b of document.querySelectorAll("[data-filter]")) b.addEventListener("click", () => { filter = b.dataset.filter; render(); });
$("#find").addEventListener("input", () => render());
$("#add-btn").addEventListener("click", () => itemDialog());

document.addEventListener("keydown", e => {
  const t = e.target;
  if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || t.matches?.("input, textarea, select") || document.querySelector("dialog[open]")) return;
  if (e.key === "n") { e.preventDefault(); itemDialog(); }
  if (e.key === "/") { e.preventDefault(); $("#find").focus(); }
});

run(load);
