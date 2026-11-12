// Pantry: your food by where it's kept, with how much is left and when it
// expires. Add food, use some, buy more, or correct a purchase. The Worker
// side is src/pantry.js; public/pantry/units.js reads amounts and guesses a
// new item's kind from its name, here as there.

import { readAmount, UNITS, LEVELS, guess, estimateExpiry } from "./units.js";

const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter(k => k != null && k !== false));
  return n;
};

let data = null;            // GET /pantry/api/items: {items, places, counts, levels, usual_places, photo, pantry: {owner, name, role}}
let shared = [];            // pantries shared with you: [{username, name, role}]
let of = "";                // whose pantry is showing: "" for yours, or the owner's username
try { of = localStorage.getItem("pantry-of") || ""; } catch {}
// What you may do in the pantry showing: everything in yours; "use" takes out; "stock" also adds
// what's bought; "full" also changes the food, like its owner. Only the owner shares it or pairs phones.
const role = () => data?.pantry?.role || "owner";
const mine = () => role() === "owner";
const edits = () => mine() || role() === "full";
const stocks = () => role() !== "use";
let filter = "all";
const open = new Set();     // items showing their purchases
const day = () => new Date().toLocaleDateString("sv");

async function api(method, path, body, raw) {
  // Everything but sharing, the key and phones is about the pantry showing.
  if (of && !/^(shares?|shared|key|scanners)\b/.test(path)) path += (path.includes("?") ? "&" : "?") + "of=" + encodeURIComponent(of);
  const res = await fetch("/pantry/api/" + path, {
    method, headers: body ? { "Content-Type": "application/json" } : {}, body: raw ?? (body ? JSON.stringify(body) : undefined),
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
  return el("span", { className: "when" + (i.soon ? " soon" : ""), textContent: `${i.soon ? "Use by" : "Expires"} ${nice(i.expires)}` },
    i.expires_by === "estimated" ? el("span", { className: "est-tag", textContent: " (est.)", title: "Estimated from how long such things usually keep" }) : null);
}

// What a typed amount reads as, for the line under the box.
function reads(text, kind, unit) {
  if (!text.trim()) return { ok: true, text: "" };
  const a = readAmount(text);
  if (!a) return { ok: false, text: kind === "measured" ? "Needs a number and a unit, like 10 lb or 2 cups" : "Needs a number, like 3" };
  if (kind === "measured") {
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
    i.staple && i.low_text ? el("small", { textContent: i.is_out ? "Out" : i.is_low ? `Low (at ${i.low_text})` : `Low at ${i.low_text}` }) : null,
    !i.staple && i.is_out ? el("small", { textContent: "Out" }) : null);
  const use = el("button", { type: "button", className: "btn", textContent: "Use", ariaLabel: `Use ${i.name}` });
  use.addEventListener("click", () => useDialog(i));
  const more = stocks() ? el("button", { type: "button", className: "btn quiet", textContent: i.kind === "gauged" ? "Refill" : "+ More", ariaLabel: `Bought more ${i.name}` }) : null;
  more?.addEventListener("click", () => i.kind === "gauged" ? run(async () => { await api("POST", `items/${i.id}/use`, { level: 5 }); say("done", `${i.name} is full again.`); await load(); }) : lotDialog(i));
  const edit = edits() ? el("button", { type: "button", className: "btn quiet", textContent: "Edit", ariaLabel: `Edit ${i.name}` }) : null;
  edit?.addEventListener("click", () => itemDialog(i));
  const li = el("li", { className: "item" },
    el("div", { className: "line" },
      el("span", { className: "name" }, name, el("span", { className: "kind", textContent: i.kind }), i.staple ? el("span", { className: "kind staple", textContent: "staple" }) : null, extra ? el("small", { textContent: extra }) : null),
      have, when(i), el("span", { className: "acts" }, use, more, edit)));
  if (open.has(i.id) && i.kind !== "gauged") li.append(lots(i));
  return li;
}

function lots(i) {
  if (!i.lots.length) return el("ul", { className: "lots" }, el("li", { textContent: "None left. + More adds what you buy next." }));
  return el("ul", { className: "lots" }, ...i.lots.map(l => {
    if (!edits()) return el("li", {}, el("b", { textContent: l.text }), el("span", { textContent: `bought ${nice(l.added)}` }),
      el("span", { textContent: l.expires ? `expires ${nice(l.expires)}` : "no expiry date" }));
    const fix = el("button", { type: "button", textContent: "✎", title: "Correct this purchase", ariaLabel: `Correct the ${l.text} bought ${l.added}` });
    fix.addEventListener("click", () => lotDialog(i, l));
    const x = el("button", { type: "button", className: "x", textContent: "×", title: "Take this purchase off", ariaLabel: `Take off the ${l.text} bought ${l.added}` });
    x.addEventListener("click", () => {
      if (confirm(`Take the ${l.text} of ${i.name} bought ${nice(l.added)} off your pantry?`)) run(async () => { await api("DELETE", `items/${i.id}/lots/${l.id}`); await load(); });
    });
    return el("li", {}, el("b", { textContent: l.text }), el("span", { textContent: `bought ${nice(l.added)}` }),
      el("span", { textContent: l.expires ? `expires ${nice(l.expires)}${l.by === "estimated" ? " (estimated)" : l.by === "scanned" ? " (scanned)" : ""}` : "no expiry date" }), fix, x);
  }));
}

function render() {
  for (const f of ["all", "soon", "low"]) $("#n-" + f).textContent = data.counts[f] ? ` ${data.counts[f]}` : "";
  for (const b of document.querySelectorAll("[data-filter]")) b.ariaPressed = String(b.dataset.filter === filter);
  $("#place-list").replaceChildren(...[...new Set([...data.usual_places, ...data.places])].map(p => el("option", { value: p })));
  const box = $("#places");
  if (!data.items.length) {
    // The ways to start, right where you're looking.
    const add = edits() ? el("button", { type: "button", className: "btn", textContent: "Add food" }) : null;
    add?.addEventListener("click", () => itemDialog());
    const rec = stocks() ? el("button", { type: "button", className: "btn quiet", textContent: "Scan a receipt" }) : null;
    rec?.addEventListener("click", pickReceipt);
    box.replaceChildren(el("section", { className: "card" },
      el("p", { className: "empty", textContent: edits() ? "Nothing in your pantry yet. Add food to start, like Whole wheat flour, 10 lb, or scan a grocery receipt." : "Nothing in this pantry yet." }),
      add || rec ? el("div", { className: "row" }, add, rec) : null));
    return;
  }
  const items = shown();
  if (!items.length) {
    box.replaceChildren(el("p", { className: "empty", textContent: filter === "soon" ? "Nothing to use soon." : filter === "low" ? "Nothing's running low." : "Nothing matches." }));
    return;
  }
  box.replaceChildren(...[shopBar(items)].filter(Boolean), ...data.places.map(p => {
    const here = items.filter(i => i.place === p);
    if (!here.length) return null;
    return el("section", { className: "card place" },
      el("h2", {}, p, el("small", { textContent: `${here.length}` })),
      el("ul", { className: "items" }, ...here.map(row)));
  }).filter(Boolean));
}

// Under Running low: put the staples that are low or out on your Drift shopping list (t).
function shopBar(items) {
  const low = items.filter(i => i.staple && (i.is_low || i.is_out));
  if (filter !== "low" || !low.length) return null;
  if (!data.drift) return el("p", { className: "shopbar empty", textContent: "Ask the site's admin for Drift to put these on a shopping list." });
  const go = el("button", { type: "button", className: "btn", id: "shop-btn", textContent: "Add to shopping list", title: "t" });
  go.addEventListener("click", shopLow);
  return el("div", { className: "shopbar" }, el("span", { textContent: `${low.length} staple${low.length === 1 ? " is" : "s are"} low or out.` }), go);
}
function shopLow() {
  if (!data?.drift || !data.counts.low) return;
  const b = $("#shop-btn");
  if (b) b.disabled = true;
  run(async () => { const out = await api("POST", "shop", {}); say("done", out.summary); })
    .finally(() => { if (b) b.disabled = false; });
}

async function load() {
  shared = (await api("GET", "shares")).shared;
  if (of && !shared.some(p => p.username === of)) pick("");
  data = await api("GET", `items?day=${day()}`);
  whose();
  render();
}

// ── a household's pantry ───────────────────────────────────────────────────

function pick(who) {
  of = who;
  try { who ? localStorage.setItem("pantry-of", who) : localStorage.removeItem("pantry-of"); } catch {}
}
// The switcher (when anyone shares theirs with you), and what you can do in the one showing.
function whose() {
  $("#whose").hidden = !shared.length;
  $("#which").replaceChildren(el("option", { value: "", textContent: "Yours" }),
    ...shared.map(p => el("option", { value: p.username, textContent: `${p.name}'s` })));
  $("#which").value = of;
  $("#whose-role").textContent = mine() ? "" : edits() ? "You can add and change anything in it." : stocks() ? "You can take things out and add what you buy." : "You can take things out as you use them.";
  $("#add-btn").hidden = !edits();
  $("#scanner-btn").hidden = $("#share-btn").hidden = !mine();
  $("#leave-btn").hidden = mine();
  $("#receipt-btn").hidden = !stocks();
}
$("#which").addEventListener("change", () => { pick($("#which").value); open.clear(); run(load); });
$("#leave-btn").addEventListener("click", () => {
  const p = shared.find(x => x.username === of);
  if (!p || !confirm(`Leave ${p.name}'s pantry? You'll need them to share it again to get back in.`)) return;
  run(async () => { await api("DELETE", "shared/" + encodeURIComponent(p.username)); pick(""); await load(); say("done", `You left ${p.name}'s pantry.`); });
});

function renderShares(list) {
  $("#shares").replaceChildren(...(list.length ? list.map(p => {
    const r = el("select", { ariaLabel: `What ${p.name} can do` }, el("option", { value: "full", textContent: "Full" }), el("option", { value: "stock", textContent: "Stock" }), el("option", { value: "use", textContent: "Use" }));
    r.value = p.role;
    r.addEventListener("change", () => run(async () => renderShares((await api("PUT", "shares", { username: p.username, role: r.value })).shares)));
    return el("li", {}, el("b", { textContent: p.name }), el("span", { className: "when", textContent: `@${p.username}` }), r,
      Object.assign(el("button", { className: "btn danger", type: "button", textContent: "Stop sharing" }),
        { onclick: () => run(async () => renderShares((await api("DELETE", "shares/" + encodeURIComponent(p.username))).shares)) }));
  }) : [el("li", { className: "hint", textContent: "No one yet." })]));
}
function shareDialog() {
  if (!mine()) return;
  run(async () => {
    $("#share-form").reset();
    renderShares((await api("GET", "shares")).shares);
    $("#share-dialog").showModal();
  });
}
$("#share-add").addEventListener("click", () => {
  const f = $("#share-form");
  run(async () => {
    renderShares((await api("PUT", "shares", { username: f.username.value.trim(), role: f.role.value })).shares);
    say("done", `Shared your pantry with ${f.username.value.trim()}.`);
    f.username.value = "";
  });
});

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
  // A staple's low point is in the kind's terms: an amount, a count, or a mark on the gauge.
  $("#low-box").hidden = !itemForm.staple.checked;
  for (const box of itemForm.querySelectorAll("[data-low]")) box.hidden = !box.dataset.low.split(" ").includes(k);
  itemForm.low.placeholder = k === "counted" ? "2" : "2 lb";
  showReads($("#low-reads"), k === "gauged" ? "" : itemForm.low.value, k, itemForm.unit.value);
}

function itemDialog(item = null) {
  editing = item;
  kindTouched = !!item;
  itemForm.reset();
  $("#item-title").textContent = item ? `Edit ${item.name}` : "Add food";
  itemForm.level.replaceChildren(...LEVELS.map((l, n) => el("option", { value: n, textContent: l })).reverse());
  itemForm.low_level.replaceChildren(...LEVELS.map((l, n) => el("option", { value: n, textContent: l })).reverse().slice(1));
  itemForm.low_level.value = "1";
  if (item) {
    itemForm.name.value = item.name;
    itemForm.kind.value = item.kind;
    itemForm.place.value = item.place;
    itemForm.words.value = item.words;
    itemForm.staple.checked = item.staple;
    itemForm.low.value = item.kind === "gauged" ? "" : item.low_text;
    if (item.kind === "gauged" && item.low != null) itemForm.low_level.value = item.low;
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
itemForm.staple.addEventListener("change", showKind);
itemForm.unit.addEventListener("input", showKind);

function itemBody() {
  const f = itemForm, k = kindNow(), g = guess(f.name.value), v = n => f[n].value.trim();
  const body = { name: v("name"), kind: k, place: v("place") || f.place.placeholder || g.place, words: v("words") };
  const changing = editing && editing.kind !== k;
  if (k !== "gauged" && (!editing || changing)) { body.amount = v("amount"); body.expires = f.expires.value; }
  body.staple = f.staple.checked;
  if (body.staple) body.low = k === "gauged" ? Number(f.low_level.value) : v("low");
  if (k === "measured") {
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

// ── a receipt ──────────────────────────────────────────────────────────────
// Its photos are read on the site (Claude with your key, or the site's own AI),
// then every line is shown to check: which pantry item it adds to (or a new
// one), how much, and its expiry date (estimated). Nothing is saved until Add.

const PHOTO_SIDE = 1568, PHOTO_BYTES = 3_500_000;   // what Anthropic reads; more is wasted
async function shrinkPhoto(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  if (!bmp) throw new Error(`${file.name} isn't a picture this browser can read`);
  const k = Math.min(1, PHOTO_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  for (const q of [0.88, 0.78, 0.65]) {
    const blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", q));
    if (blob && blob.size <= PHOTO_BYTES) return blob;
  }
  throw new Error(`${file.name} is too big even after shrinking it`);
}
const base64 = blob => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = bad; r.readAsDataURL(blob); });

let keyThen = null;
function askForKey(then) {
  if (!data.photo?.sealing) { say("error", "This site can't keep API keys yet, so receipts can't be read. Ask its admin to set CHAT_BRIDGE_KEY."); return; }
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

function pickReceipt() {
  if (!data) return;
  if (!data.photo?.ready && !data.photo?.ai) { askForKey(() => $("#receipt-file").click()); return; }
  $("#receipt-file").click();
}
$("#receipt-file").addEventListener("change", e => {
  const files = [...e.target.files].slice(0, 4);
  e.target.value = "";
  if (!files.length) return;
  const btn = $("#receipt-btn");
  btn.disabled = true;
  btn.textContent = "Reading…";
  say("done", `Reading the receipt${files.length > 1 ? ` (${files.length} pictures)` : ""}. This takes a few seconds.`);
  run(async () => {
    const images = [];
    for (const f of files) images.push({ data: await base64(await shrinkPhoto(f)) });
    const out = await api("POST", `receipt?day=${day()}`, null, JSON.stringify({ images }));
    say("done", "");
    openReceipt(out);
  }).finally(() => { btn.disabled = false; btn.textContent = "Scan a receipt"; });
});

let receipt = null;   // {store, by, why?, lines: [{...the proposal, on, target, error?}]}

function openReceipt(out) {
  receipt = { ...out, lines: out.lines.map(l => ({ ...l, on: !l.skip, target: l.match?.id || "new", ...(l.new || {}), name: l.name })) };
  $("#receipt-title").textContent = out.store ? `Check the ${out.store} receipt` : "Check the receipt";
  $("#receipt-by").textContent = [out.date && `bought ${nice(out.date)}`, out.by === "ai" ? "read by the site's AI" : "read by Claude", out.why && `(${out.why})`].filter(Boolean).join(" · ");
  renderReceipt();
  $("#receipt-dialog").showModal();
}

const itemById = id => data.items.find(i => i.id === id);
function kindOf(l) { return l.target === "new" ? l.kind : itemById(l.target)?.kind || "counted"; }

function receiptRow(l) {
  const li = el("li", { className: "rline" + (l.on ? "" : " off") });
  const tick = el("input", { type: "checkbox", checked: l.on, ariaLabel: `Add ${l.name}` });
  tick.addEventListener("change", () => { l.on = tick.checked; li.classList.toggle("off", !l.on); updateAdd(); });
  const target = el("select", { ariaLabel: `What ${l.printed || l.name} is` },
    el("option", { value: "new", textContent: `New: ${l.name}` }),
    ...data.items.map(i => el("option", { value: i.id, textContent: `${i.name} (have ${i.text})` })));
  target.value = l.target;
  target.addEventListener("change", () => {
    l.target = target.value;
    if (l.target !== "new") l.expires = itemById(l.target).kind === "gauged" ? "" : estimateExpiry(itemById(l.target).name, itemById(l.target).kind, itemById(l.target).place, day());
    li.replaceWith(receiptRow(l));
  });
  const how = l.target === "new" ? "New to your pantry" : l.match?.id === l.target ? (l.match.how === "remembered" ? `Remembered from your ${receipt.store || "last"} receipt` : "Matched by name") : "Picked by you";
  const what = el("div", { className: "what" }, target, el("span", { className: "how" + (l.target === "new" ? " new" : ""), textContent: how }));
  if (l.target === "new") {
    const name = el("input", { type: "text", value: l.name, maxLength: 80, ariaLabel: "Name" });
    name.addEventListener("input", () => { l.name = name.value; });
    const kind = el("select", { ariaLabel: "Kind" }, ...[["measured", "Measured"], ["counted", "Counted"], ["gauged", "Gauged"]].map(([v, t]) => el("option", { value: v, textContent: t })));
    kind.value = l.kind === "staple" ? "measured" : l.kind;
    kind.addEventListener("change", () => { l.kind = kind.value; l.low = ""; li.replaceWith(receiptRow(l)); });
    const place = el("input", { type: "text", value: l.place, maxLength: 30, ariaLabel: "Where it's kept", placeholder: "Cupboard" });
    place.setAttribute("list", "place-list");
    place.addEventListener("input", () => { l.place = place.value; });
    what.append(name, el("div", { className: "extra" }, kind, place));
    // A staple: kept stocked, with the point it's running low at (in the kind's terms).
    const staple = el("label", { className: "check" }, el("input", { type: "checkbox", checked: !!l.staple }), el("span", { textContent: "Staple" }));
    staple.firstChild.addEventListener("change", e => { l.staple = e.target.checked; li.replaceWith(receiptRow(l)); });
    what.append(staple);
    if (l.staple && l.kind === "gauged") {
      const low = el("select", { ariaLabel: "Running low at" }, ...LEVELS.map((name, n) => el("option", { value: n, textContent: `Low at ${name}` })).reverse().slice(1));
      low.value = String(l.low === "" || l.low == null ? 1 : l.low);
      l.low = Number(low.value);
      low.addEventListener("change", () => { l.low = Number(low.value); });
      what.append(low);
    } else if (l.staple) {
      const low = el("input", { type: "text", value: l.low || "", maxLength: 40, placeholder: l.kind === "counted" ? "Low at, like 2" : "Low at, like 2 lb", ariaLabel: "Running low at" });
      low.addEventListener("input", () => { l.low = low.value; });
      what.append(low);
    }
    if (l.kind === "counted") {
      const unit = el("input", { type: "text", value: l.unit || "", maxLength: 20, placeholder: "One is a… (can)", ariaLabel: "One is a" });
      unit.addEventListener("input", () => { l.unit = unit.value; });
      what.append(unit);
    }
  }
  const k = kindOf(l);
  const amount = k === "gauged" ? el("select", { className: "amt", ariaLabel: "How full" },
      ...LEVELS.map((name, n) => el("option", { value: n, textContent: name, selected: n === (l.level ?? 5) })).reverse())
    : el("input", { type: "text", value: l.amount, maxLength: 40, placeholder: k === "measured" ? "10 lb" : "how many", ariaLabel: "How much", className: "amt" });
  if (k !== "gauged") amount.addEventListener("input", () => { l.amount = amount.value; });
  else amount.addEventListener("change", () => { l.level = Number(amount.value); });
  const expires = el("div", { className: "exp" });
  if (k !== "gauged") {
    const date = el("input", { type: "date", value: l.expires || "", ariaLabel: "Expires" });
    const est = el("small", { className: "est", textContent: l.expires && l.expires_by === "estimated" ? "est." : "" });
    date.addEventListener("input", () => { l.expires = date.value; l.expires_by = "typed"; est.textContent = ""; });
    expires.append(date, est);
  }
  li.append(el("span", { className: "tick" }, tick), el("div", { className: "said" }, el("div", { className: "printed", textContent: l.printed }), el("b", { textContent: l.name })), what, amount, expires);
  if (l.error) li.append(el("div", { className: "err", textContent: cap(l.error) }));
  return li;
}

function renderReceipt() {
  $("#rlines").replaceChildren(...receipt.lines.map(receiptRow));
  updateAdd();
}
function updateAdd() {
  const n = receipt.lines.filter(l => l.on).length;
  $("#receipt-add").textContent = n ? `Add ${n} to pantry` : "Add to pantry";
  $("#receipt-add").disabled = !n;
}

$("#receipt-form").addEventListener("submit", e => {
  if (e.submitter?.value !== "add") return;
  e.preventDefault();
  const lines = receipt.lines.filter(l => l.on).map(l => {
    const lot = { printed: l.printed, amount: l.amount, expires: l.expires || "", expires_by: l.expires_by, ...(kindOf(l) === "gauged" ? { level: l.level ?? 5 } : {}) };
    if (l.target !== "new") return { ...lot, item: l.target };
    return { ...lot, name: l.name, kind: l.kind, place: l.place, unit: l.unit, size: l.size, staple: !!l.staple, ...(l.staple ? { low: l.low } : {}) };
  });
  const btn = $("#receipt-add");
  btn.disabled = true;
  run(async () => {
    const out = await api("POST", "receipt/add", { store: receipt.store, lines });
    const failed = new Map(out.failed.map(f => [f.printed, f.error]));
    receipt.lines = receipt.lines.filter(l => l.on && failed.has(l.printed)).map(l => ({ ...l, error: failed.get(l.printed) }));
    await load();
    if (receipt.lines.length) {
      say("done", `Added ${out.added.length}. ${receipt.lines.length} still need${receipt.lines.length === 1 ? "s" : ""} a fix.`);
      renderReceipt();
    } else {
      $("#receipt-dialog").close("done");
      say("done", `Added ${out.added.length} from the receipt: ${out.added.map(a => a.name).join(", ")}.` + ticked(out.ticked));
    }
  }).finally(() => updateAdd());
});

const ticked = t => t?.length ? ` Ticked off your shopping list: ${t.map(x => x.title).join(", ")}.` : "";

// ── pairing the phone scanner (src/pantry_scanner.js) ──────────────────────

let pairTimer = null;
const ago = s => {
  if (!s) return "never used";
  const mins = Math.round((Date.now() - Date.parse(s + "Z")) / 60000);
  return mins < 2 ? "used just now" : mins < 120 ? `used ${mins} min ago` : mins < 2880 ? `used ${Math.round(mins / 60)} h ago` : `used ${nice(s.slice(0, 10))}`;
};
function renderPhones(list) {
  $("#phones").replaceChildren(...(list.length ? list.map(p => el("li", {},
    el("b", { textContent: p.name }), el("span", { className: "when", textContent: `paired ${nice(p.created.slice(0, 10))}, ${ago(p.last_used)}` }),
    Object.assign(el("button", { className: "btn danger", type: "button", textContent: "Unpair" }),
      { onclick: () => run(async () => renderPhones((await api("DELETE", "scanners/" + p.id)).scanners)) })))
    : [el("li", { className: "hint", textContent: "None yet." })]));
}
async function newPairCode() {
  const out = await api("POST", "scanners", {});
  $("#pair-qr").innerHTML = out.qr;           // an SVG the site drew, from its own code
  $("#pair-code").textContent = out.code;
  const ends = Date.now() + out.expires_in * 1000;
  clearInterval(pairTimer);
  const tick = () => {
    const left = Math.max(0, Math.round((ends - Date.now()) / 1000));
    $("#pair-left").textContent = left ? `Works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} more.` : "This code has run out.";
    if (!left) clearInterval(pairTimer);
  };
  tick();
  pairTimer = setInterval(tick, 1000);
}
function scannerDialog() {
  run(async () => {
    const [phones, latest] = await Promise.all([api("GET", "scanners"), fetch("/pantry/scanner/latest.json").then(r => r.json()).catch(() => ({}))]);
    $("#scanner-get").replaceChildren(...(latest.version
      ? ["Get the app on your phone: ", el("a", { href: latest.url, textContent: `download version ${latest.version}` }), " (Android asks once to allow installing it)."]
      : ["Get the app on your phone (there's no release to download yet)."]));
    renderPhones(phones.scanners);
    await newPairCode();
    $("#scanner-dialog").showModal();
  });
}
$("#pair-new").addEventListener("click", () => run(newPairCode));
$("#scanner-dialog").addEventListener("close", () => { clearInterval(pairTimer); run(load); });

// ── the page ───────────────────────────────────────────────────────────────

for (const b of document.querySelectorAll("[data-filter]")) b.addEventListener("click", () => { filter = b.dataset.filter; render(); });
$("#find").addEventListener("input", () => render());
$("#add-btn").addEventListener("click", () => itemDialog());
$("#receipt-btn").addEventListener("click", pickReceipt);
$("#scanner-btn").addEventListener("click", scannerDialog);
$("#share-btn").addEventListener("click", shareDialog);

document.addEventListener("keydown", e => {
  const t = e.target;
  if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || t.matches?.("input, textarea, select") || document.querySelector("dialog[open]")) return;
  if (e.key === "n" && edits()) { e.preventDefault(); itemDialog(); }
  if (e.key === "/") { e.preventDefault(); $("#find").focus(); }
  if (e.key === "r" && stocks()) { e.preventDefault(); pickReceipt(); }
  if (e.key === "s" && mine()) { e.preventDefault(); scannerDialog(); }
  if (e.key === "h" && mine()) { e.preventDefault(); shareDialog(); }
  if (e.key === "t" && data?.counts.low) { e.preventDefault(); filter = "low"; render(); shopLow(); }
});

run(load);
