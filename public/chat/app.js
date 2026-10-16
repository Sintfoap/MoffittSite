// The chat page: a list of rooms on the left, the open room on the right.
// It asks the server for changes every few seconds while the tab is visible:
// the open room often, the room list (for unread counts) less often.
// Messages can be edited by their author, reacted to, and can @mention people.

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ROOM_EVERY = 2500, LIST_EVERY = 15000;
// Messages from one person this close together share a heading.
const GROUP_SECONDS = 5 * 60;

let me = {};
let rooms = [];
let reactions = [];       // the emoji the site accepts
let open = null;          // { id, seq, more, joined, messages: Map(id → message), members: [] }
let busy = false;         // a poll is in flight
let editingId = null, editDraft = "";   // the message being edited in place
let pickerFor = null;     // the message whose reaction picker is open

async function api(method, path, body) {
  const res = await fetch("/chat/api" + path, {
    method, headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname); throw new Error("not signed in"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `request failed (${res.status})`), { status: res.status });
  return data;
}

let toastTimer;
function toast(text) {
  const t = $("#toast");
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// ── room list ────────────────────────────────────────────────────────────

async function loadRooms() {
  const s = await api("GET", "/state");
  me = s.user; rooms = s.rooms; reactions = s.reactions || [];
  renderRooms();
  const shown = open && rooms.find(r => r.id === open.id), count = $("#show-members");
  if (shown && count) count.textContent = `${shown.members} member${shown.members === 1 ? "" : "s"}`;
  // The open room was deleted by its owner.
  if (open && !rooms.some(r => r.id === open.id)) { toast("That room was deleted."); closeRoom(); }
}

function renderRooms() {
  const row = r => `<button data-room="${esc(r.id)}" aria-current="${open?.id === r.id}" title="${esc(r.topic || r.name)}">
    <span class="name">${esc(r.name)}</span>${r.mentions && open?.id !== r.id ? `<span class="n at" title="You were mentioned">@${r.mentions > 1 ? r.mentions : ""}</span>` : ""}${r.unread && open?.id !== r.id ? `<span class="n">${r.unread > 99 ? "99+" : r.unread}</span>` : ""}
    ${r.joined ? "" : `<span class="count">${r.members}</span>`}</button>`;
  const joined = rooms.filter(r => r.joined), others = rooms.filter(r => !r.joined);
  $("#joined").innerHTML = joined.map(row).join("") || `<p class="none">You haven't joined any rooms yet.</p>`;
  $("#others").innerHTML = others.map(row).join("") || `<p class="none">${rooms.length ? "You're in every room." : "No rooms yet. Make the first one."}</p>`;
  const total = joined.reduce((n, r) => n + (open?.id === r.id ? 0 : r.unread), 0);
  const pings = joined.reduce((n, r) => n + (open?.id === r.id ? 0 : r.mentions), 0);
  document.title = (pings ? "@ " : "") + (total ? `(${total}) Chat` : "Chat");
}

document.querySelector(".side").addEventListener("click", e => {
  const b = e.target.closest("[data-room]");
  if (b) location.hash = b.dataset.room;
});

// ── the open room ────────────────────────────────────────────────────────

function closeRoom() {
  open = null; editingId = pickerFor = null; hideSuggest();
  document.body.classList.remove("in-room");
  $("#room").innerHTML = `<div class="welcome"><b>Pick a room</b>Choose one from the list, or make a new one. Anyone signed in here can find and join your rooms.</div>`;
  if (location.hash) history.replaceState(null, "", location.pathname);
  renderRooms();
}

async function openRoom(id) {
  const room = rooms.find(r => r.id === id);
  if (!room) { closeRoom(); return; }
  const data = await api("GET", `/rooms/${id}/messages`);
  open = { id, seq: data.seq, more: data.more, joined: data.joined, messages: new Map(data.messages.map(m => [m.id, m])), members: [] };
  editingId = pickerFor = null; hideSuggest();
  room.unread = 0; room.mentions = 0;
  // For completing @names as you type.
  api("GET", `/rooms/${id}/members`).then(list => { if (open?.id === id) open.members = list; }).catch(() => {});
  document.body.classList.add("in-room");
  renderRoomShell(room);
  renderLog({ toBottom: true });
  renderRooms();
  if (open.joined && matchMedia("(min-width: 761px)").matches) $("#text")?.focus();
}

function renderRoomShell(room) {
  $("#room").innerHTML = `
    <header class="room-head">
      <button class="link back" id="back" aria-label="Back to rooms">←</button>
      <div class="title"><h2>${esc(room.name)}</h2>${room.topic ? `<p>${esc(room.topic)}</p>` : ""}</div>
      <button class="link" id="show-members">${room.members} member${room.members === 1 ? "" : "s"}</button>
      ${room.manage ? `<button class="link" id="edit-room">Edit</button>` : ""}
      ${open.joined ? `<button class="link" id="leave">Leave</button>` : ""}
    </header>
    <div class="log" id="log"></div>
    ${open.joined
      ? `<form class="composer" id="composer">
          <span class="prompt" aria-hidden="true">&gt;</span>
          <textarea id="text" rows="1" maxlength="2000" placeholder="Message # ${esc(room.name)}" aria-label="Message" autocomplete="off"></textarea>
          <button class="btn" type="submit">Send</button>
          <ul class="suggest" id="suggest" role="listbox" aria-label="People to mention" hidden></ul>
        </form>`
      : `<div class="joinbar">You're looking at this room. Join it to post. <button class="btn" id="join">Join room</button></div>`}`;
}

const time = t => new Date(t * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const day = t => {
  const d = new Date(t * 1000), today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};
// Plain text with web links made clickable and @names picked out. Everything
// is escaped first. (The same @name rule as the site's, in src/chat.js.)
const linkify = s => esc(s)
  .replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)"'\]]/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
  .replace(/(^|[^\w@.\/])@([a-z0-9][a-z0-9_-]{2,31})(?![\w-])/gi, (all, pre, name) =>
    `${pre}<span class="mention${name.toLowerCase() === me.username ? " you" : ""}">@${name}</span>`);

function messageHtml(m) {
  if (m.id === editingId) {
    return `<form class="edit" data-edit="${m.id}">
      <textarea rows="1" maxlength="2000" aria-label="Edit message">${esc(editDraft)}</textarea>
      <div class="edit-actions"><span>↵ save · esc cancel</span><button type="button" class="link" data-cancel>Cancel</button><button class="btn">Save</button></div>
    </form>`;
  }
  const chips = (m.reactions || []).map(r =>
    `<button class="chip" data-react="${esc(r.emoji)}" data-mid="${m.id}" aria-pressed="${r.mine}" title="${esc(r.names)}">${esc(r.emoji)} <b>${r.count}</b></button>`).join("");
  const canReact = open.joined && !m.pending;
  const picker = pickerFor === m.id
    ? `<div class="picker" role="menu">${reactions.map(e => `<button class="link" data-react="${esc(e)}" data-mid="${m.id}" role="menuitem">${esc(e)}</button>`).join("")}</div>` : "";
  return `<div class="text" title="${esc(time(m.created_at))}">${linkify(m.body)}${m.edited_at ? `<span class="edited" title="Edited ${esc(time(m.edited_at))}"> (edited)</span>` : ""}</div>
    ${chips || picker ? `<div class="reacts">${chips}${picker}</div>` : ""}
    <div class="acts">${canReact ? `<button class="link" data-pick="${m.id}" aria-label="React">React</button>` : ""}${m.can_edit && !m.pending ? `<button class="link" data-editmsg="${m.id}">Edit</button>` : ""}${m.can_delete ? `<button class="link del" data-del="${m.id}" aria-label="Delete message">Delete</button>` : ""}</div>`;
}

function renderLog({ toBottom = false, keepFrom = null } = {}) {
  const log = $("#log");
  if (!log) return;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const list = [...open.messages.values()].filter(m => !m.deleted).sort((a, b) => a.id - b.id);
  let html = open.more ? `<button class="link older" id="older">Show older messages</button>` : "";
  let prev = null, lastDay = null;
  for (const m of list) {
    const d = day(m.created_at);
    if (d !== lastDay) { html += `<div class="day">${esc(d)}</div>`; lastDay = d; prev = null; }
    const first = !prev || prev.author !== m.author || m.created_at - prev.created_at > GROUP_SECONDS;
    html += `<div class="msg${first ? " first" : ""}${m.mine ? " mine" : ""}${m.pending ? " pending" : ""}${m.mentions_me ? " ping" : ""}" data-id="${m.id}">
      ${first ? `<div class="who">${esc(m.author_name)}<span class="at">${time(m.created_at)}</span></div>` : ""}
      ${messageHtml(m)}
    </div>`;
    prev = m;
  }
  if (!list.length) html += `<div class="empty"><b>No messages yet</b>${open.joined ? "Say hello." : "Join to start the conversation."}</div>`;
  const before = log.scrollHeight;
  // Keep the cursor in a message being edited when the log redraws under it.
  const editing = log.querySelector(".edit textarea"), focused = editing && document.activeElement === editing;
  const caret = focused ? [editing.selectionStart, editing.selectionEnd] : null;
  log.innerHTML = html;
  const box = log.querySelector(".edit textarea");
  if (box) { grow(box); if (caret) { box.focus(); box.setSelectionRange(...caret); } }
  if (keepFrom != null) log.scrollTop = log.scrollHeight - before + keepFrom;
  else if (toBottom || nearBottom) log.scrollTop = log.scrollHeight;
}

// New and deleted messages since the last look.
async function pollRoom() {
  if (!open || busy || document.hidden) return;
  busy = true;
  const id = open.id;
  try {
    const data = await api("GET", `/rooms/${id}/messages?since=${open.seq}`);
    if (open?.id !== id || !data.messages.length) return;
    for (const m of data.messages) open.messages.set(m.id, m);
    if (editingId && open.messages.get(editingId)?.deleted) editingId = null;
    open.seq = Math.max(open.seq, data.seq);
    renderLog();
  } catch (e) {
    if (e.status === 404) { toast("That room was deleted."); await loadRooms().catch(() => {}); closeRoom(); }
  } finally { busy = false; }
}

$("#room").addEventListener("click", async e => {
  const t = e.target;
  try {
    if (t.id === "back") closeRoom();
    else if (t.id === "join") { await api("POST", `/rooms/${open.id}/join`); await loadRooms(); await openRoom(open.id); }
    else if (t.id === "leave") {
      if (!confirm("Leave this room? You can join again any time.")) return;
      await api("POST", `/rooms/${open.id}/leave`); await loadRooms(); await openRoom(open.id);
    }
    else if (t.id === "edit-room") editRoom(rooms.find(r => r.id === open.id));
    else if (t.id === "show-members") showMembers();
    else if (t.id === "older") {
      const oldest = Math.min(...open.messages.keys());
      const data = await api("GET", `/rooms/${open.id}/messages?before=${oldest}`);
      for (const m of data.messages) open.messages.set(m.id, m);
      open.more = data.more;
      renderLog({ keepFrom: $("#log").scrollTop });
    }
    else if (t.closest("[data-react]")) {
      const b = t.closest("[data-react]"), mid = Number(b.dataset.mid), emoji = b.dataset.react;
      const has = open.messages.get(mid)?.reactions?.some(r => r.emoji === emoji && r.mine);
      pickerFor = null;
      const m = await api("POST", `/rooms/${open.id}/messages/${mid}/reactions`, { emoji, on: !has });
      open.messages.set(m.id, m);
      renderLog();
    }
    else if (t.dataset.pick) { pickerFor = pickerFor === Number(t.dataset.pick) ? null : Number(t.dataset.pick); renderLog(); }
    else if (t.dataset.editmsg) startEdit(Number(t.dataset.editmsg));
    else if (t.closest("[data-cancel]")) stopEdit();
    else if (t.dataset.del) {
      if (!confirm("Delete this message for everyone?")) return;
      await api("DELETE", `/rooms/${open.id}/messages/${t.dataset.del}`);
      open.messages.get(Number(t.dataset.del)).deleted = true;
      renderLog();
    }
  } catch (err) { toast(err.message); }
});

// ── editing your own messages ────────────────────────────────────────────

function startEdit(id) {
  const m = open?.messages.get(id);
  if (!m?.can_edit) return;
  editingId = id; editDraft = m.body; pickerFor = null;
  renderLog();
  const box = $("#log .edit textarea");
  if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); box.scrollIntoView({ block: "nearest" }); }
}
function stopEdit() {
  editingId = null;
  renderLog();
  $("#text")?.focus();
}
async function saveEdit(form) {
  const id = Number(form.dataset.edit), body = form.querySelector("textarea").value.trim();
  if (!body) return toast("A message can't be empty. Delete it instead.");
  try {
    const m = await api("PATCH", `/rooms/${open.id}/messages/${id}`, { body });
    open.messages.set(m.id, m);
    stopEdit();
  } catch (err) { toast(err.message); }
}

let tempId = -1;
$("#room").addEventListener("submit", async e => {
  if (e.target.matches(".edit")) { e.preventDefault(); return saveEdit(e.target); }
  if (e.target.id !== "composer") return;
  e.preventDefault();
  const box = $("#text"), body = box.value.trim();
  if (!body || !open) return;
  const id = open.id;
  // Shown straight away, then swapped for the real one.
  const temp = { id: Number.MAX_SAFE_INTEGER + tempId--, body, created_at: Math.floor(Date.now() / 1000), author: me.username, author_name: me.name, mine: true, pending: true };
  open.messages.set(temp.id, temp);
  box.value = ""; grow(box);
  renderLog({ toBottom: true });
  try {
    const m = await api("POST", `/rooms/${id}/messages`, { body });
    if (open?.id !== id) return;
    open.messages.delete(temp.id);
    open.messages.set(m.id, m);
    renderLog({ toBottom: true });
  } catch (err) {
    if (open?.id === id) { open.messages.delete(temp.id); renderLog(); if (!box.value) { box.value = body; grow(box); } }
    toast(err.message);
  }
});

// Enter sends; Shift+Enter starts a new line; ↑ in an empty box edits your
// last message. While an @name is being typed, ↑/↓ pick and Tab or Enter fills it in.
$("#room").addEventListener("keydown", e => {
  const box = e.target;
  if (box.id === "text" && !$("#suggest").hidden) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveSuggest(e.key === "ArrowDown" ? 1 : -1); return; }
    if ((e.key === "Tab" || e.key === "Enter") && !e.shiftKey && !e.isComposing) { e.preventDefault(); pickSuggest(); return; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hideSuggest(); return; }
  }
  if (box.id === "text" && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#composer").requestSubmit();
  } else if (box.id === "text" && e.key === "ArrowUp" && !box.value) {
    const last = [...open.messages.values()].filter(m => m.can_edit && !m.pending).sort((a, b) => b.id - a.id)[0];
    if (last) { e.preventDefault(); startEdit(last.id); }
  } else if (box.closest?.(".edit")) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); box.form.requestSubmit(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stopEdit(); }
  } else if (e.key === "Escape" && pickerFor != null) { e.stopPropagation(); pickerFor = null; renderLog(); }
});
const grow = box => { box.style.height = "auto"; box.style.height = Math.min(box.scrollHeight + 2, 160) + "px"; };
$("#room").addEventListener("input", e => {
  if (e.target.id === "text") { grow(e.target); suggest(e.target); }
  else if (e.target.closest(".edit")) { editDraft = e.target.value; grow(e.target); }
});

// ── completing @names ────────────────────────────────────────────────────

let matches = [], chosen = 0;
function suggest(box) {
  const m = box.value.slice(0, box.selectionStart).match(/(?:^|[^\w@.\/])@([a-z0-9_-]{0,31})$/i);
  if (!m || !open?.members.length) return hideSuggest();
  const q = m[1].toLowerCase();
  matches = open.members.filter(p => p.username !== me.username && (p.username.startsWith(q) || p.name.toLowerCase().startsWith(q))).slice(0, 6);
  if (!matches.length) return hideSuggest();
  chosen = 0;
  drawSuggest();
}
function drawSuggest() {
  const list = $("#suggest");
  list.innerHTML = matches.map((p, i) => `<li role="option" aria-selected="${i === chosen}" data-i="${i}">${esc(p.name)}<span>@${esc(p.username)}</span></li>`).join("");
  list.hidden = false;
}
function moveSuggest(by) { chosen = (chosen + by + matches.length) % matches.length; drawSuggest(); }
function hideSuggest() { const list = $("#suggest"); if (list) list.hidden = true; matches = []; }
function pickSuggest(i = chosen) {
  const box = $("#text"), p = matches[i];
  if (!box || !p) return hideSuggest();
  const head = box.value.slice(0, box.selectionStart).replace(/@[a-z0-9_-]*$/i, `@${p.username} `);
  box.value = head + box.value.slice(box.selectionStart);
  box.setSelectionRange(head.length, head.length);
  hideSuggest(); grow(box); box.focus();
}
$("#room").addEventListener("mousedown", e => {
  const li = e.target.closest("#suggest li");
  if (li) { e.preventDefault(); pickSuggest(Number(li.dataset.i)); }
});
document.addEventListener("click", e => {
  if (pickerFor != null && !e.target.closest(".picker, [data-pick]")) { pickerFor = null; renderLog(); }
});

// ── making and editing rooms ─────────────────────────────────────────────

let editing = null;   // the room being edited, or null for a new one
function editRoom(room = null) {
  editing = room;
  const f = $("#room-form");
  f.name.value = room?.name ?? ""; f.topic.value = room?.topic ?? "";
  $("#room-dialog-title").textContent = room ? "Edit room" : "New room";
  $("#room-save").textContent = room ? "Save" : "Create";
  $("#room-delete").hidden = !room;
  $("#room-error").hidden = true;
  $("#room-dialog").showModal();
  f.name.focus();
}
$("#new").addEventListener("click", () => editRoom());

// The key bar's keys: n new room, / the message line, esc back to the room list.
document.addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector("dialog[open]")) return;
  const typing = e.target.matches?.("input, textarea");
  if (e.defaultPrevented) return;
  if (e.key === "Escape" && typing) { e.target.blur(); document.querySelector(".rooms button[aria-current='true'], .rooms button")?.focus(); return; }
  if (typing) return;
  if (e.key === "n") { e.preventDefault(); editRoom(); }
  else if (e.key === "/" && $("#text")) { e.preventDefault(); $("#text").focus(); }
});
$("#room-cancel").addEventListener("click", () => $("#room-dialog").close());
$("#room-form").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target, fields = { name: f.name.value, topic: f.topic.value };
  try {
    const out = editing ? await api("PATCH", `/rooms/${editing.id}`, fields) : await api("POST", "/rooms", fields);
    $("#room-dialog").close();
    await loadRooms();
    if (location.hash === "#" + out.id) await openRoom(out.id); else location.hash = out.id;
  } catch (err) { $("#room-error").textContent = err.message; $("#room-error").hidden = false; }
});
$("#room-delete").addEventListener("click", async () => {
  if (!editing || !confirm(`Delete # ${editing.name} and all its messages? This can't be undone.`)) return;
  try {
    await api("DELETE", `/rooms/${editing.id}`);
    $("#room-dialog").close();
    await loadRooms();
    closeRoom();
  } catch (err) { $("#room-error").textContent = err.message; $("#room-error").hidden = false; }
});

async function showMembers() {
  const list = await api("GET", `/rooms/${open.id}/members`);
  $("#members").innerHTML = list.map(m => `<li>${esc(m.name)}<span>@${esc(m.username)}${m.owner ? " · made this room" : ""}</span></li>`).join("")
    || `<li>Nobody has joined yet.</li>`;
  $("#members-dialog").showModal();
}

// ── start ────────────────────────────────────────────────────────────────

async function route() {
  const id = location.hash.slice(1);
  if (!id) { if (open) closeRoom(); return; }
  if (open?.id === id) return;
  try { await openRoom(id); } catch (e) { toast(e.message); closeRoom(); }
}
window.addEventListener("hashchange", route);

setInterval(pollRoom, ROOM_EVERY);
setInterval(() => { if (!document.hidden) loadRooms().catch(() => {}); }, LIST_EVERY);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { pollRoom(); loadRooms().catch(() => {}); } });

loadRooms().then(route).catch(e => toast(e.message));
