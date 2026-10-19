// The full reaction picker: "+" at the end of a message's quick row of
// reactions opens every emoji the site takes (emoji.js), in Unicode's groups,
// with a search box over them and your recent picks first. Clicking one
// reacts with it (or takes it back, if you already had); shift-click keeps the
// picker open to add more. ↓ from the search box goes into the grid, arrows
// move, enter picks, esc closes. The terminal's /react has the same list.

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const RECENT_KEY = "sintfoap-emoji-recent", RECENT_MAX = 24;
const COLS = 8;

let data = null;           // Promise<{GROUPS, ALIASES}>, loaded the first time it's needed
let groups = [], named = new Map();   // [[group, [[emoji, name]]]]; emoji → "name aliases" for search
let pick = null;           // what to do with a pick
let mine = new Set();      // the reactions you already have on the message

const el = () => document.getElementById("emoji-pick");
export const isEmojiPickerOpen = () => !!el() && !el().hidden;

function recent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").filter(e => named.has(e)); } catch { return []; }
}
function remember(e) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...recent().filter(x => x !== e)].slice(0, RECENT_MAX))); } catch {}
}

async function load() {
  data ??= import("/chat/emoji.js").then(m => {
    groups = m.GROUPS;
    for (const [, list] of groups) for (const [e, name] of list) named.set(e, `${name} ${m.ALIASES[e] || ""}`.toLowerCase());
  }, err => { data = null; throw err; });
  return data;
}

// Opens the picker by `at` (the rect of what was clicked): onPick(emoji) reacts.
export async function openEmojiPicker(at, { onPick, have = [] }) {
  await load();
  pick = onPick; mine = new Set(have);
  let box = el();
  if (!box) {
    box = document.createElement("div");
    box.id = "emoji-pick"; box.className = "emoji-pick"; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "All emoji");
    document.body.append(box);
    box.addEventListener("click", onClick);
    box.addEventListener("keydown", onKey);
    box.addEventListener("input", e => { if (e.target.id === "emoji-q") draw(e.target.value); });
    box.addEventListener("mouseover", e => { const b = e.target.closest("[data-emoji]"); if (b) hint(b); });
    box.addEventListener("focusin", e => { const b = e.target.closest("[data-emoji]"); if (b) hint(b); });
  }
  box.innerHTML = `
    <div class="emoji-head"><input id="emoji-q" type="search" maxlength="60" placeholder="Search emoji" aria-label="Search emoji" autocomplete="off" spellcheck="false"></div>
    <nav class="emoji-tabs" aria-label="Emoji groups"></nav>
    <div class="emoji-body" id="emoji-body" tabindex="-1"></div>
    <div class="emoji-foot" id="emoji-name">&nbsp;</div>`;
  box.hidden = false;
  place(box, at);
  draw("");
  box.querySelector("#emoji-q").focus();
}

export function closeEmojiPicker() {
  const box = el();
  if (!box || box.hidden) return;
  box.hidden = true; box.innerHTML = "";
  pick = null;
}

// Below what was clicked if it fits, else above; on a phone, along the bottom (CSS).
function place(box, at) {
  box.style.left = box.style.top = "";
  if (!at || matchMedia("(max-width: 820px)").matches) return;
  const w = box.offsetWidth, h = box.offsetHeight, pad = 8;
  const left = Math.max(pad, Math.min(at.right - w, innerWidth - w - pad));
  const top = at.bottom + h + pad <= innerHeight ? at.bottom + 4 : Math.max(pad, at.top - h - 4);
  box.style.left = `${left}px`; box.style.top = `${top}px`;
}

const button = ([e, name]) =>
  `<button type="button" data-emoji="${esc(e)}" title="${esc(name)}" aria-label="${esc(name)}" aria-pressed="${mine.has(e)}">${esc(e)}</button>`;
const section = (title, list, i) =>
  `<section data-group="${i}"><h3>${esc(title)}</h3><div class="emoji-grid">${list.map(button).join("")}</div></section>`;

function draw(q) {
  const body = document.getElementById("emoji-body"), tabs = el().querySelector(".emoji-tabs");
  const words = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length) {
    const found = groups.flatMap(([, list]) => list).filter(([e]) => words.every(w => named.get(e).includes(w)));
    tabs.hidden = true;
    body.innerHTML = found.length ? section(`${found.length} found`, found, "found") : `<p class="emoji-empty">No emoji match “${esc(q.trim())}”.</p>`;
  } else {
    const r = recent().map(e => [e, named.get(e).trim()]);
    const all = [...(r.length ? [["Recent", r]] : []), ...groups];
    tabs.hidden = false;
    tabs.innerHTML = all.map(([title, list], i) => `<button type="button" data-tab="${i}" title="${esc(title)}" aria-label="${esc(title)}">${esc(title === "Recent" ? "🕘" : list[0][0])}</button>`).join("");
    body.innerHTML = all.map(([title, list], i) => section(title, list, i)).join("");
  }
  body.scrollTop = 0;
  document.getElementById("emoji-name").innerHTML = "&nbsp;";
}

function hint(b) { document.getElementById("emoji-name").textContent = `${b.dataset.emoji}  ${b.title}`; }

function choose(e, keepOpen) {
  remember(e);
  const done = pick;
  if (mine.has(e)) mine.delete(e); else mine.add(e);
  if (keepOpen) el().querySelectorAll(`[data-emoji="${CSS.escape(e)}"]`).forEach(b => b.setAttribute("aria-pressed", mine.has(e)));
  else closeEmojiPicker();
  done?.(e);
}

function onClick(ev) {
  const b = ev.target.closest("[data-emoji], [data-tab]");
  if (!b) return;
  if (b.dataset.tab) {
    const s = el().querySelector(`section[data-group="${b.dataset.tab}"]`);
    document.getElementById("emoji-body").scrollTop = s.offsetTop - s.parentNode.offsetTop;
  } else choose(b.dataset.emoji, ev.shiftKey);
}

function onKey(e) {
  const box = el(), buttons = [...box.querySelectorAll("#emoji-body [data-emoji]")];
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeEmojiPicker(); return; }
  if (e.target.id === "emoji-q") {
    if (e.key === "ArrowDown" && buttons.length) { e.preventDefault(); buttons[0].focus(); }
    else if (e.key === "Enter" && buttons.length) { e.preventDefault(); choose(buttons[0].dataset.emoji, e.shiftKey); }
    return;
  }
  const i = buttons.indexOf(e.target);
  if (i < 0) return;
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLS, ArrowDown: COLS }[e.key];
  if (step) {
    e.preventDefault();
    if (i + step < 0) box.querySelector("#emoji-q").focus();
    else buttons[Math.min(i + step, buttons.length - 1)].focus();
  } else if (e.key === "Enter") { e.preventDefault(); choose(e.target.dataset.emoji, e.shiftKey); }
}
