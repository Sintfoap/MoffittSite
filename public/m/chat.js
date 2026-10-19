// Chat on the phone: the room list, and one room at a time full screen with
// a composer at the bottom. Reads and writes /chat/api/ (src/chat.js), like
// the web page and the terminal, and asks for changes every few seconds.
// End-to-end encrypted rooms (from a Matrix connection) are read and written
// on the full chat page, which brings their keys to whichever browser opens it.

import { $, esc, api, icon, toast, failed, sheet, ago, every } from "./ui.js";
import { toHtml } from "../chat/format.js";
import { setupGifs, isGifMessage, gifMessageHtml } from "../chat/gifs.js";
import { updateChatBadge } from "./app.js";
import * as L from "./chat-logic.js";

const ROOM_EVERY = 2500, LIST_EVERY = 15000, TYPING_EVERY = 3000;
const NETWORK = { matrix: "Matrix" };
const data = { state: null, rooms: [] };
let main = null, stops = [], open = null;

/* ── data ───────────────────────────────────────── */
async function loadState() {
  data.state = await api("GET", "/chat/api/state");
  data.rooms = data.state.rooms;
  setupGifs(data.state.gifs, { api: (m, p, b) => api(m, "/chat/api" + p, b), send: () => {}, toast });
  updateChatBadge(L.unreadTotal(data.rooms));
  return data.state;
}
const room = id => data.rooms.find(r => r.id === id);
const me = () => data.state.user.username;

// Keeps the Chat tab's unread count fresh wherever you are in the app.
let watching = false;
export function watchUnread() {
  if (watching) return;
  watching = true;
  loadState().catch(() => {});
  every(LIST_EVERY, () => { if (!open) loadState().then(() => { if (!open && main?.isConnected && document.body.dataset.screen === "chat") drawList(); }).catch(() => {}); });
}

/* ── the room list ──────────────────────────────── */
function roomRow(r) {
  const online = new Set(data.state.online);
  const badge = r.invite ? `<span class="badge soft">invite</span>` : r.mentions ? `<span class="badge">@${r.mentions > 1 ? r.mentions : ""}</span>` : r.unread ? `<span class="badge">${r.unread > 99 ? "99+" : r.unread}</span>` : "";
  const what = r.kind === "bridge" ? `${NETWORK[r.provider] || r.provider}${r.via ? " · " + r.via : ""}` : r.kind === "dm" ? (online.has(r.with) ? "Online" : "Direct message") : r.topic || `${r.members} member${r.members === 1 ? "" : "s"}`;
  return `<li><a class="room${r.unread || r.mentions ? " hot" : ""}" href="#chat/${esc(r.id)}">
    <span class="mark${r.kind === "dm" && online.has(r.with) ? " on" : ""}" aria-hidden="true">${r.encrypted ? icon("lock", 14) : L.MARK[r.kind] || "#"}</span>
    <span class="body"><b>${esc(r.name)}</b><small>${esc(what)}</small></span>
    <span class="end"><small>${r.last_at ? esc(ago(r.last_at)) : ""}</small>${badge}</span></a></li>`;
}
function drawList() {
  const sections = L.roomSections(data.rooms);
  main.innerHTML = `<header class="bar"><div><h1>Chat</h1>${data.state.online.length ? `<p class="sub">${data.state.online.length} online</p>` : ""}</div>
    <span class="acts"><button class="icon-btn" data-new aria-label="New room or message">${icon("plus")}</button></span></header>
    <div class="content">${sections.length ? sections.map(s => `<section class="group"><h2 class="label">${esc(s.title)}<small>${s.rooms.length}</small></h2>
      <ul class="rooms">${s.rooms.map(roomRow).join("")}</ul></section>`).join("")
      : `<div class="empty"><h2>No rooms yet</h2><p>Start one with the + button.</p></div>`}</div>`;
  main.onclick = e => { if (e.target.closest("[data-new]")) newSheet(); };
}

async function newSheet() {
  let people = [];
  try { people = await api("GET", "/chat/api/people"); } catch (e) { return failed(e); }
  const d = sheet(`<div class="form">
    <h2>Message someone</h2>
    <ul class="people">${people.map(p => `<li><button class="li act" data-dm="${esc(p.username)}"><span class="mark${p.online ? " on" : ""}">@</span><span><b>${esc(p.name)}</b> <small class="mono">${esc(p.username)}</small></span></button></li>`).join("") || `<li class="hint">Nobody else can use chat yet.</li>`}</ul>
    <form id="newRoom" class="form" method="dialog">
      <h2>New room</h2>
      <label>Name<input name="rname" maxlength="60" required></label>
      <label>Topic<input name="topic" maxlength="200" placeholder="Optional"></label>
      <label class="toggle"><input type="checkbox" name="private"> Private: only people you add can see it</label>
      <div class="buttons"><button class="btn" value="make">Make the room</button></div>
    </form></div>`);
  d.addEventListener("click", async e => {
    const b = e.target.closest("[data-dm]");
    if (!b) return;
    try {
      const out = await api("POST", "/chat/api/dms", { username: b.dataset.dm });
      d.close();
      await loadState();
      location.hash = "#chat/" + out.id;
    } catch (err) { failed(err); }
  });
  d.querySelector("#newRoom").addEventListener("submit", async e => {
    if (e.submitter?.value !== "make") return;
    const f = e.target;
    try {
      const out = await api("POST", "/chat/api/rooms", { name: f.rname.value.trim(), topic: f.topic.value.trim(), private: f.private.checked });
      await loadState();
      location.hash = "#chat/" + out.id;
    } catch (err) { failed(err); }
  });
}

/* ── one room ───────────────────────────────────── */
const time = s => new Date(s * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
function dayLabel(s) {
  const d = new Date(s * 1000), now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
const linkify = s => toHtml(s, {
  newline: "\n",
  link: (u, t) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`,
  mention: name => `<span class="mention${name.toLowerCase() === me() ? " you" : ""}">@${name}</span>`,
});
const quoteOf = r => !r.id ? `<i>Deleted message</i>` : `<b>${esc(r.author_name)}</b> ${esc(String(r.body).replace(/\s+/g, " ").replace(/(\*\*|~~|`+|^> )/g, ""))}`;

function messageHtml({ m, first }) {
  const gif = isGifMessage(m.body), pic = !gif && m.media;
  const content = gif ? gifMessageHtml(m)
    : pic ? `<img class="pic" src="${esc(m.media.url)}" alt="${esc(m.media.name || "Picture")}" loading="lazy">`
    : m.encrypted && !m.raw ? `<i class="locked">${icon("lock", 13)} ${esc(m.body)}</i>`
    : m.raw ? `<i class="locked">${icon("lock", 13)} Encrypted: read it on the full chat page</i>`
    : linkify(m.body);
  const reacts = (m.reactions || []).map(r => `<button class="react" data-react="${esc(r.emoji)}" data-mid="${m.id}" aria-pressed="${r.mine}">${esc(r.emoji)} <b>${r.count}</b></button>`).join("");
  return `<div class="msg${m.mine ? " mine" : ""}${first ? " first" : ""}${m.mentions_me ? " ping" : ""}${m.pending ? " pending" : ""}" data-id="${m.id}">
    ${first && !m.mine ? `<span class="av" aria-hidden="true">${esc((m.author_name || m.author || "?")[0].toUpperCase())}</span><div class="who">${esc(m.author_name)}</div>` : ""}
    <div class="bubble">${m.reply ? `<div class="quote">${quoteOf(m.reply)}</div>` : ""}<div class="text">${content}</div>
      <span class="at">${m.edited_at ? "edited · " : ""}${time(m.created_at)}</span></div>
    ${reacts ? `<div class="reacts">${reacts}</div>` : ""}</div>`;
}

const writableHere = r => open.joined && !r.invite && !(r.encrypted);

function drawRoom() {
  const r = room(open.id);
  if (!r) { main.innerHTML = `<div class="empty"><h2>Room not found</h2><p>It may have been deleted, or you're not in it.</p><a class="btn" href="#chat">Back to rooms</a></div>`; return; }
  document.body.classList.add("focus");
  const sub = r.kind === "bridge" ? `${NETWORK[r.provider] || r.provider}${r.via ? " · " + r.via : ""}` : r.kind === "dm" ? "Direct message" : r.topic || `${r.members} members`;
  const bar = r.invite ? `<div class="joinbar">${esc(r.invite.by)} invited you to this ${esc(NETWORK[r.provider] || r.provider)} room.
      <span><button class="btn" data-join>Accept</button><button class="btn ghost" data-leave>Decline</button></span></div>`
    : r.encrypted ? `<div class="joinbar">${icon("lock", 16)} End-to-end encrypted. Read and send on the full chat page, and your keys will come to this browser.
      <a class="btn" href="/chat/#${esc(r.id)}">Open</a></div>`
    : !open.joined ? `<div class="joinbar">Join to post here and get it in your list. <button class="btn" data-join>Join</button></div>` : "";
  main.innerHTML = `<header class="bar room-bar"><a class="icon-btn" href="#chat" aria-label="Back to rooms">${icon("back")}</a>
      <div><h1>${esc(r.name)}</h1><p class="sub" id="sub">${esc(sub)}</p></div>
      <span class="acts">${open.joined && r.kind !== "dm" && !r.invite ? `<button class="link" data-leave>Leave</button>` : ""}</span></header>
    <div class="log" id="log" role="log" aria-live="polite"></div>
    ${bar}
    ${writableHere(r) ? `<form class="composer chat" id="say" autocomplete="off">
      <div class="replying" id="replying" hidden></div>
      <div class="row"><textarea id="text" rows="1" maxlength="2000" placeholder="Message ${esc(r.kind === "dm" ? r.name : "#" + r.name)}" enterkeyhint="send" aria-label="Message"></textarea>
      <button class="send" aria-label="Send">${icon("send")}</button></div>
    </form>` : ""}`;
  drawLog({ toBottom: true });
  wireRoom(r);
}

function drawLog({ toBottom = false, keep = null } = {}) {
  const log = $("#log");
  if (!log) return;
  const near = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  const oldHeight = log.scrollHeight;
  const rows = L.messageRows(open.messages, dayLabel);
  log.innerHTML = (open.more ? `<button class="link older" data-older>Show older messages</button>` : "") +
    (rows.length ? rows.map(x => x.day ? `<div class="day"><span>${esc(x.day)}</span></div>` : messageHtml(x)).join("") : `<p class="hint center">No messages yet. Say hello.</p>`) +
    `<p class="typing" id="typing">${esc(L.typingLine(open.typing))}</p>`;
  if (keep) log.scrollTop = log.scrollHeight - oldHeight + keep;
  else if (toBottom || near) log.scrollTop = log.scrollHeight;
}

async function fetchNew() {
  if (!open || open.busy) return;
  open.busy = true;
  try {
    const out = await api("GET", `/chat/api/rooms/${open.id}/messages?since=${open.seq}`);
    if (!open || out.seq == null) return;
    open.seq = out.seq; open.joined = out.joined; open.typing = out.typing || [];
    if (out.messages.length) { open.messages = L.mergeMessages(open.messages.filter(m => !m.pending), out.messages); drawLog(); }
    else { const t = $("#typing"); if (t) t.textContent = L.typingLine(open.typing); }
  } catch {}
  finally { if (open) open.busy = false; }
}

async function send(text) {
  const r = room(open.id);
  if (open.editing) {
    const id = open.editing;
    stopEditing();
    try { const m = await api("PATCH", `/chat/api/rooms/${r.id}/messages/${id}`, { body: text }); open.messages = L.mergeMessages(open.messages, [m]); drawLog(); }
    catch (e) { failed(e); }
    return;
  }
  const reply = open.replyTo;
  stopReplying();
  const temp = { id: Number.MAX_SAFE_INTEGER, pending: true, mine: true, author: me(), author_name: data.state.user.name, body: text, created_at: Date.now() / 1000, reactions: [] };
  open.messages = [...open.messages, temp];
  drawLog({ toBottom: true });
  try {
    await api("POST", `/chat/api/rooms/${r.id}/messages`, { body: text, ...(reply ? { reply_to: reply } : {}) });
    await fetchNew();
  } catch (e) {
    open.messages = open.messages.filter(m => m !== temp);
    drawLog();
    $("#text").value = text;
    failed(e);
  }
}

function stopReplying() { open.replyTo = null; const b = $("#replying"); if (b) b.hidden = true; }
function stopEditing() { open.editing = null; const b = $("#replying"); if (b) b.hidden = true; const t = $("#text"); if (t) { t.value = ""; grow(t); } }
function grow(t) { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 140) + "px"; }

function wireRoom(r) {
  const form = $("#say"), text = $("#text");
  let lastTyping = 0;
  if (form) {
    form.addEventListener("submit", e => {
      e.preventDefault();
      const v = text.value.trim();
      if (!v) return;
      text.value = ""; grow(text);
      send(v);
    });
    text.addEventListener("input", () => {
      grow(text);
      if (Date.now() - lastTyping > TYPING_EVERY && text.value.trim()) {
        lastTyping = Date.now();
        api("POST", `/chat/api/rooms/${r.id}/typing`).catch(() => {});
      }
    });
    // Enter sends on a hardware keyboard; on a phone the send button does.
    text.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) { e.preventDefault(); form.requestSubmit(); } });
    $("#replying").addEventListener("click", e => { if (e.target.closest("[data-cancel]")) { open.editing ? stopEditing() : stopReplying(); } });
  }
  main.onclick = async e => {
    const t = e.target;
    if (t.closest("[data-join]")) {
      try { await api("POST", `/chat/api/rooms/${r.id}/join`); await loadState(); await openRoom(r.id); } catch (err) { failed(err); }
      return;
    }
    if (t.closest("[data-leave]")) {
      if (!confirm(r.invite ? "Decline this invite?" : `Leave ${r.name}?`)) return;
      try { await api("POST", `/chat/api/rooms/${r.id}/leave`); await loadState(); location.hash = "#chat"; } catch (err) { failed(err); }
      return;
    }
    if (t.closest("[data-older]")) return older();
    const re = t.closest("[data-react]");
    if (re) return react(+re.dataset.mid, re.dataset.react);
    if (t.closest("a, img.pic")) return;
    const msg = t.closest(".msg");
    if (msg && !msg.classList.contains("pending")) actions(open.messages.find(m => m.id === +msg.dataset.id));
  };
}

async function older() {
  const first = open.messages.find(m => !m.deleted);
  if (!first) return;
  const log = $("#log"), keep = log.scrollTop;
  try {
    const out = await api("GET", `/chat/api/rooms/${open.id}/messages?before=${first.id}`);
    open.more = out.more;
    open.messages = L.mergeMessages(open.messages, out.messages);
    drawLog({ keep });
  } catch (e) { failed(e); }
}

async function react(mid, emoji) {
  const m = open.messages.find(x => x.id === mid);
  if (!m || !open.joined) return;
  if (room(open.id)?.encrypted) return toast("Reactions in encrypted rooms are on the full chat page.");
  const on = !m.reactions?.some(r => r.emoji === emoji && r.mine);
  try { open.messages = L.mergeMessages(open.messages, [await api("POST", `/chat/api/rooms/${open.id}/messages/${mid}/reactions`, { emoji, on })]); drawLog(); }
  catch (e) { failed(e); }
}

function actions(m) {
  if (!m || m.deleted) return;
  const r = room(open.id), canAct = open.joined && !r.encrypted && !r.invite;
  const canReply = canAct && (r.kind !== "bridge" || m.ext_id);
  const d = sheet(`<div class="form">
    <p class="fine">${esc(m.author_name)} · ${esc(dayLabel(m.created_at))} ${esc(time(m.created_at))}</p>
    ${canAct ? `<div class="quick-reacts">${data.state.reactions.map(x => `<button data-emoji="${esc(x)}" aria-pressed="${!!m.reactions?.some(y => y.emoji === x && y.mine)}">${esc(x)}</button>`).join("")}</div>` : ""}
    <div class="card list">
      ${canReply ? `<button class="li act" data-do="reply">Reply</button>` : ""}
      <button class="li act" data-do="copy">Copy text</button>
      ${m.can_edit && canAct ? `<button class="li act" data-do="edit">Edit</button>` : ""}
      ${m.can_delete ? `<button class="li act bad" data-do="delete">Delete</button>` : ""}
    </div></div>`);
  d.addEventListener("click", async e => {
    const em = e.target.closest("[data-emoji]");
    if (em) { d.close(); return react(m.id, em.dataset.emoji); }
    const act = e.target.closest("[data-do]")?.dataset.do;
    if (!act) return;
    d.close();
    const bar = $("#replying"), text = $("#text");
    if (act === "copy") { navigator.clipboard?.writeText(m.body).then(() => toast("Copied."), () => toast("Couldn't copy.")); }
    if (act === "reply" && bar) {
      open.editing = null; open.replyTo = m.id;
      bar.innerHTML = `<span>Replying to <b>${esc(m.author_name)}</b></span><button type="button" class="icon-btn" data-cancel aria-label="Cancel">${icon("x", 18)}</button>`;
      bar.hidden = false; text.focus();
    }
    if (act === "edit" && bar) {
      open.replyTo = null; open.editing = m.id;
      bar.innerHTML = `<span>Editing your message</span><button type="button" class="icon-btn" data-cancel aria-label="Cancel">${icon("x", 18)}</button>`;
      bar.hidden = false; text.value = m.body; grow(text); text.focus();
    }
    if (act === "delete") {
      if (!confirm("Delete this message?")) return;
      try { await api("DELETE", `/chat/api/rooms/${open.id}/messages/${m.id}`); open.messages = open.messages.filter(x => x.id !== m.id); drawLog(); await fetchNew(); }
      catch (err) { failed(err); }
    }
  });
}

async function openRoom(id) {
  open = { id, messages: [], seq: 0, more: false, joined: false, typing: [], replyTo: null, editing: null };
  main.innerHTML = `<div class="loading" aria-busy="true"></div>`;
  try {
    const out = await api("GET", `/chat/api/rooms/${id}/messages`);
    Object.assign(open, { messages: out.messages, seq: out.seq, more: out.more, joined: out.joined, typing: out.typing || [] });
  } catch (e) { failed(e); }
  // Reading it marks it read.
  const r = room(id);
  if (r) { r.unread = 0; r.mentions = 0; updateChatBadge(L.unreadTotal(data.rooms)); }
  drawRoom();
}

/* ── the screen's life ──────────────────────────── */
export async function show(el, [id]) {
  main = el;
  if (!data.state) main.innerHTML = `<div class="loading" aria-busy="true"></div>`;
  await loadState();
  if (id) {
    await openRoom(id);
    stops.push(every(ROOM_EVERY, fetchNew));
  } else {
    open = null;
    drawList();
  }
}
export function hide() {
  stops.forEach(s => s()); stops = [];
  open = null;
  document.body.classList.remove("focus");
  if (main) main.onclick = null;
}

// Home's card: rooms with something new.
export async function homeCard(el) {
  if (!data.state) await loadState();
  const hot = data.rooms.filter(r => r.invite || r.joined && (r.unread || r.mentions)).sort((a, b) => b.last_at - a.last_at);
  el.innerHTML = `<section class="card"><a class="card-head" href="#chat"><h2>Chat</h2>
    <span class="sub">${hot.length ? `${L.unreadTotal(hot)} new in ${hot.length} room${hot.length === 1 ? "" : "s"}` : "You're all caught up"}</span>${icon("right", 18)}</a>
    ${hot.length ? `<ul class="rooms">${hot.slice(0, 5).map(roomRow).join("")}</ul>` : ""}</section>`;
}
