// Pantry in the phone app: the scanner, for unpacking groceries. Snap the
// receipt (read by the site, as on the Pantry page), scan barcodes with the
// phone's camera (barcode.js), check what each line adds, and add them all.
// Works on any phone's browser, iPhones included: no app to install. The same
// as the Android scanner app (scanner/), through the same API (src/pantry.js),
// signed in as you rather than paired.
//
//   #pantry          the basket: what's been scanned, to check and add
//   #pantry/scan     the camera, reading barcodes
//
// The basket is kept on this phone (localStorage) until it's added, so a
// reload or a lost connection doesn't lose it.

import { $, esc, api, icon, toast, failed } from "./ui.js";
import * as P from "./pantry-logic.js";

const PHOTO_SIDE = 1568, PHOTO_BYTES = 3_500_000, MAX_SHOTS = 4;
const st = { lines: [], items: [], of: "", shared: [], photo: null, shots: [], busy: "", said: "", lastScanned: "", loaded: false };
let stopCamera = null, lastCode = ["", 0];

const BASKET = "m:pantry-basket";
function keep() { try { localStorage.setItem(BASKET, JSON.stringify({ of: st.of, lines: st.lines })); } catch {} }
function restore() {
  try { const b = JSON.parse(localStorage.getItem(BASKET) || "null"); if (b?.lines) { st.lines = b.lines; st.of = b.of || ""; } } catch {}
}

// Everything but sharing works on the pantry being stocked (?of=, a household's).
const path = p => "/pantry/api/" + p + (st.of ? (p.includes("?") ? "&" : "?") + "of=" + encodeURIComponent(st.of) : "");
const day = () => P.localDay();

export async function show(main, [sub]) {
  if (!st.loaded) restore();
  if (sub === "scan") return showCamera(main);
  document.body.classList.remove("focus");
  main.innerHTML = `<div class="loading" aria-busy="true"></div>`;
  try { await load(); } catch (e) { failed(e); }
  draw(main);
}

export function hide() {
  stopCamera?.();
  stopCamera = null;
  document.body.classList.remove("focus");
}

async function load() {
  const [items, shares] = await Promise.all([api("GET", path(`items?day=${day()}`)), st.loaded ? null : api("GET", "/pantry/api/shares").catch(() => null)]);
  st.items = items.items || [];
  st.photo = items.photo || null;
  if (shares) st.shared = (shares.shared || []).filter(s => s.role === "full" || s.role === "stock");
  if (st.of && !st.shared.some(s => s.username === st.of)) st.of = "";
  st.loaded = true;
}

// ── the basket ───────────────────────────────────────────────────────────

function draw(main) {
  const n = st.lines.filter(l => l.on).length;
  const whose = st.of ? st.shared.find(s => s.username === st.of)?.name || st.of : "";
  main.innerHTML = `<header class="bar"><div><h1>Pantry</h1><p class="sub">${whose ? `Stocking ${esc(whose)}'s pantry` : "Unpack the groceries"}</p></div>
      <span class="acts"><a class="icon-btn" href="/pantry/" aria-label="Open Pantry on the full site">${icon("link")}</a></span></header>
    ${st.shared.length ? `<div class="pills" role="radiogroup" aria-label="Whose pantry">
      <button type="button" class="pill${st.of ? "" : " on"}" data-of="">Mine</button>${st.shared.map(s =>
      `<button type="button" class="pill${st.of === s.username ? " on" : ""}" data-of="${esc(s.username)}">${esc(s.name)}'s</button>`).join("")}</div>` : ""}
    <div class="scan-btns">
      <a class="btn" href="#pantry/scan">${icon("barcode")}Scan barcodes</a>
      <label class="btn ghost">${icon("camera")}${st.shots.length ? "Next part" : "Snap receipt"}<input type="file" accept="image/*" capture="environment" id="shot" hidden></label>
    </div>
    <div id="shots"></div>
    <p class="said" id="said" ${st.said ? "" : "hidden"}>${esc(st.said)}</p>
    ${st.lines.length ? `<ul class="basket" id="basket"></ul>
      <div class="basket-bar"><div class="row">
        <button class="btn" id="add" type="button" ${n && !st.busy ? "" : "disabled"}>${n ? `Add ${n} to pantry` : "Add to pantry"}</button>
        <button class="btn ghost" id="clear" type="button">Clear</button></div></div>`
    : `<p class="hint">Start with the receipt: it does most of the work. Then scan the barcode of anything it couldn't make out, or anything bought without one. Expiry dates are estimated; set the real one on anything where it matters.</p>
       <p class="hint">${st.items.length ? `Your pantry has ${st.items.length} thing${st.items.length === 1 ? "" : "s"} in it.` : "Your pantry is empty so far."} Everything you add here shows up on the Pantry page.</p>`}`;
  drawShots();
  const basket = $("#basket");
  if (basket) basket.replaceChildren(...st.lines.map(lineCard));
  main.querySelector(".pills")?.addEventListener("click", async e => {
    const b = e.target.closest("[data-of]");
    if (!b || b.dataset.of === st.of) return;
    st.of = b.dataset.of; st.said = "";
    // Lines matched to the other pantry's items don't mean anything in this one.
    st.lines = st.lines.map(l => ({ ...l, target: "", how: "" }));
    keep();
    try { await load(); } catch (err) { failed(err); }
    draw(main);
  });
  $("#shot").addEventListener("change", e => { const f = e.target.files?.[0]; if (f) takeShot(f, main); });
  $("#add")?.addEventListener("click", () => send(main));
  $("#clear")?.addEventListener("click", () => {
    const was = st.lines;
    st.lines = []; st.said = ""; keep(); draw(main);
    toast("Cleared.", () => { st.lines = was; keep(); draw(main); });
  });
}

function say(text) {
  st.said = text;
  const el = $("#said");
  if (el) { el.textContent = text; el.hidden = !text; }
}

function change(key, f, { redraw = false } = {}) {
  const i = st.lines.findIndex(l => l.key === key);
  if (i < 0) return;
  st.lines[i] = { ...st.lines[i], ...f(st.lines[i]), error: "" };
  keep();
  if (redraw) {
    $(`[data-key="${key}"]`)?.replaceWith(lineCard(st.lines[i]));
    const n = st.lines.filter(l => l.on).length, add = $("#add");
    if (add) { add.textContent = n ? `Add ${n} to pantry` : "Add to pantry"; add.disabled = !n || !!st.busy; }
  }
}

const opt = (v, label, on) => `<option value="${esc(v)}"${on ? " selected" : ""}>${esc(label)}</option>`;

function lineCard(l) {
  const li = document.createElement("li");
  li.className = "line" + (l.on ? "" : " off") + (l.error ? " has-error" : "");
  li.dataset.key = l.key;
  const item = st.items.find(i => i.id === l.target);
  const kind = item?.kind || l.kind;
  const top = `<div class="line-top">
      <button type="button" class="tick" aria-pressed="${l.on}" aria-label="${l.on ? "Leave it off" : "Add it"}">${icon("check")}</button>
      <div class="line-name">${l.printed ? `<small class="mono">${esc(l.printed)}</small>` : l.barcode ? `<small class="mono">barcode ${esc(l.barcode)}</small>` : ""}<b>${esc(P.title(l))}</b></div>
      <button type="button" class="icon-btn drop" aria-label="Take it out of the list">${icon("x")}</button></div>`;
  if (!l.on) {
    li.innerHTML = top + (l.skip ? `<p class="line-note">Not food, so it's left off. Tick it to add it anyway.</p>` : "");
  } else {
    li.innerHTML = top + `<div class="form line-form">
      <label>Adds to<select data-f="target">${opt("", `New: ${l.name || "something new"}`, !item)}${st.items.map(i => opt(i.id, `${i.name} (have ${i.text})`, i.id === l.target)).join("")}</select>
        <small class="line-note">${item ? (l.target === item.id && l.how ? P.HOW[l.how] || "picked" : "picked") : "new to your pantry"}</small></label>
      ${item ? "" : `<label>Name<input data-f="name" value="${esc(l.name)}" placeholder="Oat milk" autocapitalize="sentences" maxlength="80"></label>
        <fieldset><legend>Kind</legend><div class="quick">${P.KINDS.map(([k, label]) =>
          `<button type="button" class="pill${l.kind === k ? " on" : ""}" data-kind="${k}">${label}</button>`).join("")}</div></fieldset>
        <div class="pair"><label>Kept in<input data-f="place" value="${esc(l.place)}" placeholder="Cupboard" maxlength="30"></label>
          ${l.kind === "counted" ? `<label>One is a<input data-f="unit" value="${esc(l.unit)}" placeholder="can" autocapitalize="none" maxlength="20"></label>` : "<span></span>"}</div>
        <label class="toggle"><input type="checkbox" data-staple ${l.staple ? "checked" : ""}>Staple: keep it stocked</label>
        ${l.staple && l.kind === "gauged" ? `<fieldset><legend>Running low at</legend><div class="quick">${[4, 3, 2, 1, 0].map(n =>
          `<button type="button" class="pill${(l.lowLevel ?? 1) === n ? " on" : ""}" data-low="${n}">${P.LEVELS[n]}</button>`).join("")}</div></fieldset>`
        : l.staple ? `<label>Running low at<input data-f="low" value="${esc(l.low)}" placeholder="${l.kind === "counted" ? "2" : l.kind === "measured" ? "2 lb" : "2 lb, 2, or ¼ left"}" autocapitalize="none" maxlength="40"></label>` : ""}`}
      ${kind === "gauged" ? `<fieldset><legend>How full is it?</legend><div class="quick">${[5, 4, 3, 2, 1].map(n =>
          `<button type="button" class="pill${(l.level ?? 5) === n ? " on" : ""}" data-level="${n}">${P.LEVELS[n]}</button>`).join("")}</div></fieldset>`
      : `<div class="pair"><label>How much<input data-f="amount" value="${esc(l.amount)}" placeholder="${kind === "measured" ? "10 lb" : "2"}" autocapitalize="none" maxlength="40"></label>
          <label class="${P.dateMatters(l) ? "check-date" : ""}">${P.dateMatters(l) ? "Check the date" : l.expires && l.expiresBy === "estimated" ? "Expires (est.)" : "Expires"}<input type="date" data-date value="${esc(l.expires)}"></label></div>`}
      ${l.error ? `<p class="err">${esc(l.error[0].toUpperCase() + l.error.slice(1))}</p>` : ""}</div>`;
  }
  li.querySelector(".tick").onclick = () => change(l.key, x => ({ on: !x.on }), { redraw: true });
  li.querySelector(".drop").onclick = () => {
    const i = st.lines.findIndex(x => x.key === l.key), was = st.lines[i];
    st.lines.splice(i, 1); keep(); li.remove();
    if (!st.lines.length) draw($("#main"));
    toast(`Took out ${P.title(was)}.`, () => { st.lines.splice(i, 0, was); keep(); draw($("#main")); });
  };
  for (const input of li.querySelectorAll("[data-f]")) {
    const f = input.dataset.f;
    if (f === "target") input.onchange = () => change(l.key, () => ({ target: input.value }), { redraw: true });
    else input.oninput = () => change(l.key, () => f === "amount" ? { amount: input.value, each: input.value } : { [f]: input.value });
  }
  const date = li.querySelector("[data-date]");
  if (date) date.onchange = () => change(l.key, () => ({ expires: date.value, expiresBy: date.value ? "typed" : "" }), { redraw: true });
  li.querySelector("[data-staple]")?.addEventListener("change", e => change(l.key, () => ({ staple: e.target.checked }), { redraw: true }));
  for (const b of li.querySelectorAll("[data-kind]")) b.onclick = () => change(l.key, () => ({ kind: b.dataset.kind }), { redraw: true });
  for (const b of li.querySelectorAll("[data-low]")) b.onclick = () => change(l.key, () => ({ lowLevel: +b.dataset.low }), { redraw: true });
  for (const b of li.querySelectorAll("[data-level]")) b.onclick = () => change(l.key, () => ({ level: +b.dataset.level }), { redraw: true });
  return li;
}

async function send(main) {
  const bad = P.unnamed(st.lines);
  if (bad) { toast(`Give the new barcode a name first (${bad.barcode}).`); return; }
  st.busy = "Adding to your pantry…";
  const add = $("#add");
  if (add) { add.disabled = true; add.textContent = st.busy; }
  const outs = [];
  try {
    for (const b of P.batches(st.lines)) {
      const out = await api("POST", path("add"), { store: b.store, lines: b.lines.map(P.toSend) });
      outs.push(out);
      st.lines = P.afterAdd(st.lines, b.lines, out);
      keep();
    }
    st.said = P.addedLine(outs, st.lines);
    if (outs.some(o => o.added?.length)) await load().catch(() => {});
  } catch (e) {
    st.said = e.message === "Failed to fetch" ? "No connection. Everything's kept on this phone; tap Add again when there's signal." : "";
    failed(e);
  } finally {
    st.busy = "";
    draw(main);
    main.scrollTop = 0;
  }
}

// ── the receipt ──────────────────────────────────────────────────────────

function drawShots() {
  const el = $("#shots");
  if (!el) return;
  if (!st.shots.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="card shots"><div class="thumbs">${st.shots.map((s, i) => `<img src="${s.url}" alt="Part ${i + 1} of the receipt">`).join("")}</div>
    <p class="hint">${st.shots.length} picture${st.shots.length === 1 ? "" : "s"} of the receipt. A long one: take it in parts, top to bottom (up to ${MAX_SHOTS}).</p>
    <div class="buttons"><button class="btn ghost" type="button" id="dropShots">Start over</button><button class="btn" type="button" id="read" ${st.busy ? "disabled" : ""}>${st.busy || "Read it"}</button></div></div>`;
  $("#dropShots").onclick = () => { st.shots.forEach(s => URL.revokeObjectURL(s.url)); st.shots = []; draw($("#main")); };
  $("#read").onclick = () => readReceipt($("#main"));
}

async function takeShot(file, main) {
  if (st.photo && !st.photo.ready && !st.photo.ai) {
    toast("Receipts need your Anthropic key. Add it on the Pantry page on the full site.");
    return;
  }
  if (st.shots.length >= MAX_SHOTS) { toast(`That's ${MAX_SHOTS} pictures, the most one receipt takes.`); return; }
  try {
    const blob = await shrink(file);
    st.shots.push({ blob, url: URL.createObjectURL(blob) });
    draw(main);
  } catch (e) { failed(e); }
}

async function shrink(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  if (!bmp) throw new Error("That picture couldn't be read. Try again.");
  const k = Math.min(1, PHOTO_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  for (const q of [0.85, 0.75, 0.62]) {
    const blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", q));
    if (blob && blob.size <= PHOTO_BYTES) return blob;
  }
  throw new Error("That picture is too big even after shrinking it.");
}

const base64 = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(",")[1]);
  r.onerror = () => rej(new Error("That picture couldn't be read."));
  r.readAsDataURL(blob);
});

async function readReceipt(main) {
  st.busy = "Reading the receipt…";
  drawShots();
  try {
    const images = [];
    for (const s of st.shots) images.push({ data: await base64(s.blob) });
    const out = await api("POST", path(`receipt?day=${day()}`), { images });
    const shop = out.store || "";
    const read = (out.lines || []).map(p => P.fromProposal(p, { store: shop }));
    st.lines.push(...read);
    keep();
    st.shots.forEach(s => URL.revokeObjectURL(s.url));
    st.shots = [];
    st.said = `Read ${read.length} line${read.length === 1 ? "" : "s"} from the ${shop ? shop + " " : ""}receipt (by ${out.by === "ai" ? "the site's AI" : "Claude"}).`
      + (read.some(l => P.isNew(l) && !l.skip) ? " New ones are marked; scan a barcode or check the name." : "");
  } catch (e) { failed(e); }
  finally { st.busy = ""; draw(main); main.scrollTop = 0; }
}

// ── the camera ───────────────────────────────────────────────────────────

async function showCamera(main) {
  document.body.classList.add("focus");
  st.lastScanned = "";
  main.innerHTML = `<div class="camera">
      <div class="viewfinder"><video id="video" playsinline muted></video><i class="aim" aria-hidden="true"></i></div>
      <div class="cam-panel">
        <p class="said" id="scanned" aria-live="polite">Point it at a barcode. Each one goes in your list to check; scan the same thing again for one more.</p>
        <p class="fine" id="count"></p>
        <a class="btn" href="#pantry">Done</a>
      </div></div>`;
  counted();
  try {
    stopCamera = await startCamera();
  } catch (e) {
    $("#scanned").textContent = e.message;
    $("#scanned").classList.add("err");
  }
}

async function startCamera() {
  const { startReading } = await import("./barcode.js");
  if (!$("#video")) return null;   // gone already
  return startReading($("#video"), code => {
    const now = Date.now();
    // The same code stays in view: once, until it's been away (or 2.5 s pass, for one more of the same).
    if (code === lastCode[0] && now - lastCode[1] < 2500) { lastCode = [code, now]; return; }
    lastCode = [code, now];
    scanned(code);
  });
}

function counted() {
  const el = $("#count");
  if (el) el.textContent = `${st.lines.filter(l => l.barcode).length} scanned so far`;
}

async function scanned(raw) {
  const r = P.scan(st.lines, raw);
  if (!r) return;
  navigator.vibrate?.(40);
  const tell = t => { const el = $("#scanned"); if (el) { el.textContent = t; el.classList.remove("err"); } };
  if (r.again) {
    st.lines = r.lines; keep(); counted();
    tell(`One more ${P.title(r.again)}: ${r.again.amount}`);
    return;
  }
  tell(`Looking up ${r.look}…`);
  try {
    const out = await api("GET", path(`barcode/${r.look}?day=${day()}`));
    // Scanned again while it was being looked up: one more of that instead.
    const again = P.scan(st.lines, r.look);
    if (again?.again) { st.lines = again.lines; keep(); counted(); tell(`One more ${P.title(again.again)}: ${again.again.amount}`); return; }
    const l = P.fromBarcode(r.look, out);
    st.lines.push(l); keep(); counted();
    tell(out.product ? P.title(l) + (l.amount ? `: ${l.amount}` : "") : "New barcode: name it in the list");
  } catch (e) {
    tell(e.message === "Failed to fetch" ? "No connection to look it up. Try again with signal." : e.message);
  }
}
