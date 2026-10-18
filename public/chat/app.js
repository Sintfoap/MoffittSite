// The chat page: a list of rooms on the left, the open room on the right.
// It asks the server for changes every few seconds while the tab is visible:
// the open room often, the room list (for unread counts) less often.
// Messages can be edited by their author, reacted to, and can @mention people.
// Rooms are open, private (members add each other) or direct messages; each
// poll also says who else has the room open and who's typing. Bridge rooms
// come from your connections to other platforms (Matrix, …), listed under
// each connection; what you send there goes to that platform. Encrypted
// rooms are decrypted and encrypted here, in this browser (e2ee.js).

import { Vault, Shelf, textOf, textContent, editContent, reactionContent } from "/chat/e2ee.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ROOM_EVERY = 2500, LIST_EVERY = 15000;
// Messages from one person this close together share a heading.
const GROUP_SECONDS = 5 * 60;

let me = {};
let rooms = [];
let reactions = [];       // the emoji the site accepts
let online = new Set();   // usernames with chat open somewhere just now
let open = null;          // { id, seq, more, joined, messages: Map(id → message), members: [] }
let busy = false;         // a poll is in flight
let editingId = null, editDraft = "";   // the message being edited in place
let pickerFor = null;     // the message whose reaction picker is open
let bridges = { allowed: false };   // whether you can connect other platforms, and which

// ── end-to-end encryption ────────────────────────────────────────────────
// A connection's keys live in the browser that turned encryption on for it:
// a key of its own making in localStorage (what proves it to the site, and
// locks the store), and the crypto library's store in IndexedDB.

const vaults = new Map();   // connection id → Promise<Vault>
const ready = new Map();    // connection id → Vault, once it's open
const keyName = conn => `sintfoap-e2ee:${conn}`;
const storedKey = conn => { try { return localStorage.getItem(keyName(conn)); } catch { return null; } };
let crypto$ = null;         // the library, loaded the first time it's needed (it's large)

function vaultFor(conn, { create = false } = {}) {
  if (vaults.has(conn)) return vaults.get(conn);
  let key = storedKey(conn);
  if (!key && !create) return null;
  if (!key) {
    key = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
    try { localStorage.setItem(keyName(conn), key); } catch { throw new Error("this browser won't keep the keys (is it in private mode?)"); }
  }
  const made = (async () => {
    crypto$ ??= import("/chat/vendor/matrix-crypto/index.mjs").then(async lib => { await lib.initAsync(); return lib; });
    const lib = await crypto$;
    return Vault.open(lib, { key, store: `sintfoap-e2ee-${conn}`, passphrase: key,
      post: (op, body) => api("POST", `/connections/${conn}/crypto/${op}`, body) });
  })();
  vaults.set(conn, made);
  made.then(v => ready.set(conn, v), () => vaults.delete(conn));
  return made;
}

// What this browser can do in an encrypted room: "ready", "off" (nobody holds
// the keys yet), "elsewhere" (another browser does), or "token" (it can't).
const keysHere = r => !r.can_encrypt ? "token" : storedKey(r.connection) ? "ready" : r.keys_held ? "elsewhere" : "off";

// What this browser read before, kept sealed (e2ee.js, Shelf), so a chat
// opens with its messages readable instead of decrypting them all again.
const shelves = new Map();  // connection id → Promise<Shelf | null>
function shelfFor(conn) {
  if (shelves.has(conn)) return shelves.get(conn);
  const key = storedKey(conn);
  if (!key) return Promise.resolve(null);
  const made = Shelf.open(key, { name: `sintfoap-e2ee-read-${conn}` }).catch(() => null);
  shelves.set(conn, made);
  return made;
}
const eventId = raw => { try { return JSON.parse(raw).event_id || null; } catch { return null; } };
// The open room, when it's encrypted and its keys are in this browser.
const keyedRoom = () => { const r = open && rooms.find(r => r.id === open.id); return r?.encrypted && keysHere(r) === "ready" ? r : null; };
const read = (m, content) => Object.assign(m, { body: textOf(content, m.author_name), decrypted: true, decrypting: false, failed: false, shownRaw: m.raw });

const lockedNote = vault => vault.backup
  ? "🔒 Can't decrypt this one: its key isn't in your key backup, or hasn't arrived yet."
  : "🔒 Can't decrypt this one yet. Verify with your Security Key to unlock older messages.";

// Messages from the server, before they're shown: in an encrypted room the
// server only has "Encrypted message", so each one takes the text it had
// when it was last shown, or what this browser read before. Any still
// unread say so quietly until decryptOpen gets to them.
async function readable(list, roomId = open?.id) {
  const room = rooms.find(r => r.id === roomId);
  if (!room?.encrypted || keysHere(room) !== "ready") return list;
  const rest = [];
  for (const m of list) {
    if (!m.raw) continue;
    const had = open?.id === roomId && open.messages.get(m.id);
    if (had?.shownRaw === m.raw && (had.decrypted || had.failed)) Object.assign(m, { body: had.body, decrypted: had.decrypted, failed: had.failed, shownRaw: m.raw });
    else rest.push({ m, had });
  }
  const kept = await (await shelfFor(room.connection))?.get(rest.map(({ m }) => eventId(m.raw)).filter(Boolean)) ?? new Map();
  for (const { m, had } of rest) {
    const c = kept.get(eventId(m.raw));
    if (c) read(m, c);
    // (One already found to be unreadable says so straight away.)
    else if (ready.get(room.connection)?.cache.get(m.raw) === null) Object.assign(m, { body: lockedNote(ready.get(room.connection)), failed: true, shownRaw: m.raw });
    // (An edit keeps showing the text it replaces until the new one's read.)
    else Object.assign(m, had?.decrypted ? { body: had.body } : { body: "Decrypting…", decrypting: true });
  }
  return list;
}

// Messages still to be read → as many read as can be in a moment (taking
// any keys that came with them first), so they appear readable rather than
// filling in. What's left, decryptOpen gets to.
async function readSoon(list, roomId) {
  const room = rooms.find(r => r.id === roomId), waiting = list.filter(m => m.decrypting);
  if (!waiting.length || !room) return;
  const work = (async () => {
    const vault = await vaultFor(room.connection), shelf = await shelfFor(room.connection);
    await vault.pump();
    await Promise.all(waiting.map(async m => {
      const c = await vault.decrypt(m.raw);
      if (c) { read(m, c); shelf?.put(eventId(m.raw), c); }
    }));
  })().catch(() => {});
  await Promise.race([work, new Promise(r => setTimeout(r, 1000))]);
}

// Decrypts the open room's messages that haven't been yet (or changed: an
// edit brings new ones): first with the keys already here, then again after
// taking any that arrived.
async function decryptOpen() {
  const room = keyedRoom();
  if (!room) return;
  const id = open.id, vault = await vaultFor(room.connection), shelf = await shelfFor(room.connection);
  const pass = async last => {
    const list = open?.id === id ? [...open.messages.values()].filter(m => m.raw && !(m.shownRaw === m.raw && m.decrypted)) : [];
    if (!list.length) return;
    const got = await Promise.all(list.map(m => vault.decrypt(m.raw)));
    if (open?.id !== id) return;
    let changed = false;
    const note = last && lockedNote(vault);
    list.forEach((m, i) => {
      if (got[i]) { read(m, got[i]); shelf?.put(eventId(m.raw), got[i]); changed = true; }
      else if (last && (m.body !== note || !m.failed)) { Object.assign(m, { body: note, failed: true, decrypting: false, shownRaw: m.raw }); changed = true; }
    });
    if (changed) renderLog();
  };
  await pass(false);
  await vault.pump();
  if (open?.id !== id) return;
  showVerify(await vault.status());
  await pass(true);
}

// Starts loading the crypto library and keys as soon as the page knows
// there's an encrypted room they're for, rather than when one is opened.
function warmKeys() {
  for (const r of rooms) if (r.encrypted && keysHere(r) === "ready") { vaultFor(r.connection)?.catch(() => {}); shelfFor(r.connection); }
}

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
  me = s.user; rooms = s.rooms; reactions = s.reactions || []; online = new Set(s.online || []);
  bridges = s.bridges || { allowed: false };
  $("#connections-open").hidden = $("#key-k").hidden = !bridges.allowed;
  renderRooms();
  warmKeys();
  const shown = open && rooms.find(r => r.id === open.id), count = $("#show-members");
  if (shown && count) count.textContent = `${shown.members} member${shown.members === 1 ? "" : "s"}`;
  // The open room was deleted by its owner.
  if (open && !rooms.some(r => r.id === open.id)) { toast("That room was deleted."); closeRoom(); }
}

const roomTitle = r => r.kind === "dm" ? `@ ${r.name}` : r.kind === "bridge" ? `~ ${r.name}` : `${r.kind === "private" ? "🔒" : "#"} ${r.name}`;
const NETWORK = { matrix: "Matrix" };

function renderRooms() {
  const row = r => `<button data-room="${esc(r.id)}" aria-current="${open?.id === r.id}" title="${esc(r.topic || r.name)}" class="${r.kind}">
    ${r.kind === "dm" ? `<span class="dot${online.has(r.with) ? " on" : ""}" title="${online.has(r.with) ? "Online" : "Away"}"></span>` : ""}<span class="name">${esc(r.name)}</span>${r.encrypted ? `<span class="e2e" title="End-to-end encrypted${keysHere(r) === "ready" ? ", with the keys in this browser" : ": turn encryption on in the room to read it"}">E2E</span>` : ""}${r.mentions && open?.id !== r.id ? `<span class="n at" title="You were mentioned">@${r.mentions > 1 ? r.mentions : ""}</span>` : ""}${r.unread && open?.id !== r.id ? `<span class="n">${r.unread > 99 ? "99+" : r.unread}</span>` : ""}
    ${r.joined ? "" : `<span class="count">${r.members}</span>`}</button>`;
  const joined = rooms.filter(r => r.joined), others = rooms.filter(r => !r.joined);
  const dms = joined.filter(r => r.kind === "dm");
  $("#joined").innerHTML = joined.filter(r => r.kind !== "dm" && r.kind !== "bridge").map(row).join("") || `<p class="none">You haven't joined any rooms yet.</p>`;
  $("#dms").innerHTML = dms.map(row).join("") || `<p class="none">No direct messages yet.</p>`;
  // A section for each connection, named for the platform and who you are there.
  const vias = new Map();
  for (const r of joined.filter(r => r.kind === "bridge")) (vias.get(r.connection) ?? vias.set(r.connection, []).get(r.connection)).push(r);
  // (Who you are there only when one platform has two connections.)
  const networks = [...vias.values()].map(list => list[0].provider);
  $("#bridged").innerHTML = [...vias.values()].map(([r, ...rest]) =>
    `<section><h2 title="${esc(r.via)}">${esc(NETWORK[r.provider] || r.provider)}${networks.filter(n => n === r.provider).length > 1 ? ` · ${esc(String(r.via).replace(/^@/, "").split(":")[0])}` : ""}</h2>
      <div class="rooms">${[r, ...rest].map(row).join("")}</div></section>`).join("");
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
  open = null; editingId = pickerFor = null; hideSuggest(); searching = null;
  document.body.classList.remove("in-room");
  $("#room").innerHTML = `<div class="welcome"><b>Pick a room</b>Choose one from the list, or make a new one. Anyone signed in here can find and join your rooms.</div>`;
  if (location.hash) history.replaceState(null, "", location.pathname);
  renderRooms();
}

async function openRoom(id) {
  const room = rooms.find(r => r.id === id);
  if (!room) { closeRoom(); return; }
  const data = await api("GET", `/rooms/${id}/messages`);
  await readable(data.messages, id);
  open = { id, seq: data.seq, more: data.more, joined: data.joined, messages: new Map(data.messages.map(m => [m.id, m])), members: [],
           here: data.here || [], typing: data.typing || [], bridge: room.kind === "bridge" };
  editingId = pickerFor = null; hideSuggest(); searching = null;
  room.unread = 0; room.mentions = 0;
  // For completing @names as you type.
  api("GET", `/rooms/${id}/members`).then(list => { if (open?.id === id) open.members = list; }).catch(() => {});
  document.body.classList.add("in-room");
  renderRoomShell(room);
  await readSoon(data.messages, id);
  if (open?.id !== id) return;
  renderLog({ toBottom: true });
  renderPresence();
  renderRooms();
  decryptOpen().catch(err => toast(err.message));
  if (open.joined && matchMedia("(min-width: 761px)").matches) $("#text")?.focus();
}

function renderRoomShell(room) {
  $("#room").innerHTML = `
    <header class="room-head">
      <button class="link back" id="back" aria-label="Back to rooms">←</button>
      <div class="title"><h2 class="${room.kind}">${esc(room.name)}</h2>${room.kind === "bridge" ? `<p>On ${esc(NETWORK[room.provider] || room.provider)} as ${esc(room.via)}${room.encrypted ? (keysHere(room) === "ready" ? " · encrypted, keys in this browser" : " · end-to-end encrypted") : ""}</p>` : room.kind === "dm" ? `<p>Direct message with @${esc(room.with || "")}${online.has(room.with) ? " · online" : ""}</p>` : room.topic ? `<p>${esc(room.topic)}</p>` : room.kind === "private" ? "<p>Private: only members can see this room.</p>" : ""}</div>
      <button class="link" id="search-open" aria-label="Search this room">Search</button>
      ${room.kind === "dm" || room.kind === "bridge" ? "" : `<button class="link" id="show-members">${room.members} member${room.members === 1 ? "" : "s"}</button>`}
      ${room.kind === "private" && open.joined ? `<button class="link" id="add-people">Add people</button>` : ""}
      ${room.manage ? `<button class="link" id="edit-room">Edit</button>` : ""}
      ${open.joined && room.kind !== "dm" && room.kind !== "bridge" ? `<button class="link" id="leave">Leave</button>` : ""}
    </header>
    <form class="searchbar" id="searchbar" hidden>
      <input id="search-q" type="search" maxlength="100" placeholder="Search ${esc(roomTitle(room))}" aria-label="Search this room" autocomplete="off">
      <button class="btn quiet" type="submit">Find</button>
      <button class="link" type="button" id="search-close">Close</button>
    </form>
    <div class="log" id="log"></div>
    <div class="presence" id="presence" aria-live="polite"></div>
    ${room.encrypted && keysHere(room) === "ready" ? `<div class="joinbar verifybar" id="verifybar" hidden>
        <span id="verify-why"></span><button class="btn quiet" type="button" id="verify-open">Verify with Security Key</button>
        <form id="verify-form" class="verify-form" hidden>
          <input id="verify-key" type="password" autocomplete="off" spellcheck="false" placeholder="Security Key or Security Phrase" aria-label="Security Key or Security Phrase">
          <button class="btn" type="submit">Verify</button><button class="link" type="button" id="verify-cancel">Cancel</button>
          <p class="verify-note">It's used here in your browser to open your account's secret storage, and never sent to the site.</p>
        </form></div>` : ""}
    ${room.encrypted && keysHere(room) !== "ready" ? encryptionBar(room)
      : open.joined
      ? `<form class="composer" id="composer">
          <span class="prompt" aria-hidden="true">&gt;</span>
          <textarea id="text" rows="1" maxlength="2000" placeholder="Message ${esc(roomTitle(room))}" aria-label="Message" autocomplete="off"></textarea>
          <button class="btn" type="submit">Send</button>
          <ul class="suggest" id="suggest" role="listbox" aria-label="People to mention" hidden></ul>
        </form>`
      : `<div class="joinbar">You're looking at this room. Join it to post. <button class="btn" id="join">Join room</button></div>`}`;
}

// The bar offering to verify this session with the account's Security Key,
// which also unlocks older messages from the key backup.
function showVerify({ verified, backup }) {
  const bar = $("#verifybar");
  if (!bar) return;
  bar.hidden = verified && backup;
  $("#verify-why").textContent = verified
    ? "This session is verified, but your account has no key backup to unlock older messages from."
    : "This session isn't verified yet, so Matrix apps flag it and older messages stay locked.";
  $("#verify-open").hidden = verified || !$("#verify-form").hidden;
}

function encryptionBar(room) {
  const why = {
    token: "This room is end-to-end encrypted. To read and send here, remove this connection and connect again with your Matrix username and password: that gives the site a session of its own, whose keys stay in your browser. (A pasted access token's session keeps its keys in its own app.)",
    elsewhere: "This room is end-to-end encrypted, and its keys are in another browser where you turned encryption on. Use that one, or remove the connection and connect again to move them here.",
    off: "This room is end-to-end encrypted. Turn encryption on to read and send here: the keys are made and kept in this browser, never on the site.",
  }[keysHere(room)];
  return `<div class="joinbar">${esc(why)}${keysHere(room) === "off" ? ` <button class="btn" id="e2ee-on">Turn on encryption here</button>` : ""}</div>`;
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
  // (In a bridge room, reactions go to the platform: an encrypted room's only from the browser with its keys.)
  const room = open.bridge && rooms.find(r => r.id === open.id);
  const canReact = open.joined && !m.pending && (!room || !room.encrypted || keysHere(room) === "ready");
  const picker = pickerFor === m.id
    ? `<div class="picker" role="menu">${reactions.map(e => `<button class="link" data-react="${esc(e)}" data-mid="${m.id}" role="menuitem">${esc(e)}</button>`).join("")}</div>` : "";
  return `<div class="text" title="${esc(time(m.created_at))}">${linkify(m.body)}${m.edited_at ? `<span class="edited" title="Edited ${esc(time(m.edited_at))}"> (edited)</span>` : ""}</div>
    ${chips || picker ? `<div class="reacts">${chips}${picker}</div>` : ""}
    <div class="acts">${canReact ? `<button class="link" data-pick="${m.id}" aria-label="React">React</button>` : ""}${m.can_edit && !m.pending ? `<button class="link" data-editmsg="${m.id}">Edit</button>` : ""}${m.can_delete ? `<button class="link del" data-del="${m.id}" aria-label="Delete message">Delete</button>` : ""}</div>`;
}

// A message still being decrypted is shown quietly; one that can't be, as locked.
const lockClass = m => m.raw && keyedRoom() ? (m.failed ? " locked" : m.decrypting ? " decrypting" : "") : m.encrypted && !m.decrypted ? " locked" : "";

function renderLog({ toBottom = false, keepFrom = null } = {}) {
  const log = $("#log");
  if (!log || searching) return;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const list = [...open.messages.values()].filter(m => !m.deleted).sort((a, b) => a.id - b.id);
  let html = open.more ? `<button class="link older" id="older">Show older messages</button>` : "";
  let prev = null, lastDay = null;
  for (const m of list) {
    const d = day(m.created_at);
    if (d !== lastDay) { html += `<div class="day">${esc(d)}</div>`; lastDay = d; prev = null; }
    const first = !prev || prev.author !== m.author || m.created_at - prev.created_at > GROUP_SECONDS;
    html += `<div class="msg${first ? " first" : ""}${m.mine ? " mine" : ""}${m.pending ? " pending" : ""}${m.mentions_me ? " ping" : ""}${lockClass(m)}" data-id="${m.id}">
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
    if (open?.id !== id) return;
    // The sync it ran may have renamed the room, or brought it in encrypted.
    if (open.bridge && data.messages.length) loadRooms().catch(() => {});
    const people = JSON.stringify([data.here, data.typing]);
    if (people !== JSON.stringify([open.here, open.typing])) { open.here = data.here || []; open.typing = data.typing || []; renderPresence(); }
    if (data.messages.length) {
      await readable(data.messages, id);
      await readSoon(data.messages, id);
      if (open?.id !== id) return;
      for (const m of data.messages) open.messages.set(m.id, m);
      if (editingId && open.messages.get(editingId)?.deleted) editingId = null;
      open.seq = Math.max(open.seq, data.seq);
      renderLog();
    }
    // Keys can arrive without a message, for ones that couldn't be read yet.
    await decryptOpen();
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
    else if (t.id === "e2ee-on") {
      t.disabled = true; t.textContent = "Making keys…";
      const room = rooms.find(r => r.id === open.id);
      try { await vaultFor(room.connection, { create: true }); }
      catch (err) { try { localStorage.removeItem(keyName(room.connection)); } catch { /* nothing kept */ } throw err; }
      toast("Encryption is on in this browser. Messages sent from now on can be read here.");
      await loadRooms(); open = null; await openRoom(room.id);
    }
    else if (t.id === "verify-open") { $("#verify-form").hidden = false; t.hidden = true; $("#verify-key").focus(); }
    else if (t.id === "verify-cancel") { $("#verify-form").hidden = true; $("#verify-open").hidden = false; $("#verify-key").value = ""; }
    else if (t.id === "edit-room") editRoom(rooms.find(r => r.id === open.id));
    else if (t.id === "show-members") showMembers();
    else if (t.id === "add-people") pickPerson("add");
    else if (t.id === "search-open") openSearch();
    else if (t.id === "search-close") closeSearch();
    else if (t.closest("[data-jump]")) await jumpTo(Number(t.closest("[data-jump]").dataset.jump));
    else if (t.id === "older") {
      const oldest = Math.min(...open.messages.keys());
      const data = await api("GET", `/rooms/${open.id}/messages?before=${oldest}`);
      for (const m of await readable(data.messages)) open.messages.set(m.id, m);
      open.more = data.more;
      renderLog({ keepFrom: $("#log").scrollTop });
      decryptOpen().catch(() => {});
    }
    else if (t.closest("[data-react]")) {
      const b = t.closest("[data-react]"), mid = Number(b.dataset.mid), emoji = b.dataset.react;
      const has = open.messages.get(mid)?.reactions?.some(r => r.emoji === emoji && r.mine);
      pickerFor = null;
      const room = rooms.find(r => r.id === open.id), target = open.messages.get(mid);
      const body = { emoji, on: !has };
      if (!has && room?.encrypted) {
        if (keysHere(room) !== "ready") throw new Error("Turn encryption on in this room to react here.");
        body.encrypted = await (await vaultFor(room.connection)).encrypt(room.ext_room, reactionContent(target.ext_id, emoji), "m.reaction");
      }
      const m = await readable([await api("POST", `/rooms/${open.id}/messages/${mid}/reactions`, body)]).then(([m]) => m);
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
      typingSent = 0;
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
    const old = open.messages.get(id), room = rooms.find(r => r.id === open.id), content = editContent(old?.ext_id, body);
    const m = await api("PATCH", `/rooms/${open.id}/messages/${id}`, old?.raw && room?.encrypted
      ? { encrypted: await (await vaultFor(room.connection)).encrypt(room.ext_room, content) } : { body });
    // (You know what you wrote: it needn't be decrypted to show it.)
    if (m.raw) { read(m, content); (await shelfFor(room.connection))?.put(eventId(m.raw), content); }
    open.messages.set(m.id, m);
    stopEdit();
  } catch (err) { toast(err.message); }
}

async function verifySession(form) {
  const input = $("#verify-key"), secret = input.value.trim(), button = form.querySelector("[type=submit]");
  const room = rooms.find(r => r.id === open?.id);
  if (!secret || !room) return;
  button.disabled = true; button.textContent = "Verifying…";
  try {
    const out = await (await vaultFor(room.connection)).unlock(secret);
    input.value = ""; form.hidden = true;
    for (const m of open.messages.values()) if (m.failed) m.shownRaw = null;   // try the locked ones again
    toast(out.backup ? "Verified. Older messages are coming in from your key backup." : "Verified. Your account has no key backup, so older messages stay locked.");
    await decryptOpen();
  } catch (err) { toast(err.message); }
  finally { button.disabled = false; button.textContent = "Verify"; }
}

let tempId = -1;
$("#room").addEventListener("submit", async e => {
  if (e.target.matches(".edit")) { e.preventDefault(); return saveEdit(e.target); }
  if (e.target.id === "searchbar") { e.preventDefault(); return runSearch(); }
  if (e.target.id === "verify-form") { e.preventDefault(); return verifySession(e.target); }
  if (e.target.id !== "composer") return;
  e.preventDefault();
  const box = $("#text"), body = box.value.trim();
  if (!body || !open) return;
  const id = open.id;
  // Shown straight away, then swapped for the real one.
  typingSent = 0;
  const temp = { id: Number.MAX_SAFE_INTEGER + tempId--, body, created_at: Math.floor(Date.now() / 1000), author: me.username, author_name: me.name, mine: true, pending: true };
  open.messages.set(temp.id, temp);
  box.value = ""; grow(box);
  renderLog({ toBottom: true });
  try {
    const room = rooms.find(r => r.id === id);
    const m = await api("POST", `/rooms/${id}/messages`, room?.encrypted
      ? { encrypted: await (await vaultFor(room.connection)).encrypt(room.ext_room, textContent(body)) } : { body });
    if (open?.id !== id) return;
    open.messages.delete(temp.id);
    if (m.raw) { read(m, textContent(body)); (await shelfFor(room.connection))?.put(eventId(m.raw), textContent(body)); }
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
let typingSent = 0;
$("#room").addEventListener("input", e => {
  if (e.target.id === "text") {
    grow(e.target); suggest(e.target);
    // Let the others know, at most every few seconds.
    if (e.target.value && Date.now() - typingSent > 3000 && open?.joined) {
      typingSent = Date.now();
      api("POST", `/rooms/${open.id}/typing`).catch(() => {});
    }
  }
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

// ── who's here ───────────────────────────────────────────────────────────

const names = list => list.length <= 2 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
function renderPresence() {
  const el = $("#presence");
  if (!el || !open) return;
  const typing = open.typing, here = open.here.filter(n => !typing.includes(n));
  el.innerHTML = typing.length
    ? `<span class="typing"><i></i><i></i><i></i></span>${esc(names(typing))} ${typing.length === 1 ? "is" : "are"} typing…`
    : here.length ? `<span class="dot on"></span>Here now: ${esc(names(here))}` : "";
}

// ── searching the open room ──────────────────────────────────────────────

let searching = null;   // {q, results, more} while results are showing
function openSearch() {
  const bar = $("#searchbar");
  bar.hidden = false;
  $("#search-q").focus();
  $("#search-q").select();
}
function closeSearch() {
  searching = null;
  const bar = $("#searchbar");
  if (bar) bar.hidden = true;
  renderLog({ toBottom: true });
}
async function runSearch() {
  const q = $("#search-q").value.trim();
  if (q.length < 2) return toast("Search for at least 2 characters.");
  try {
    const data = await api("GET", `/rooms/${open.id}/search?q=${encodeURIComponent(q)}`);
    searching = { q, ...data };
    renderResults();
  } catch (err) { toast(err.message); }
}
function renderResults() {
  const log = $("#log"), { q, messages: found, more } = searching;
  const mark = text => linkify(text).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[&<>"']/g, c => esc(c)), "gi"), x => `<mark>${x}</mark>`);
  log.innerHTML = `<div class="results-head">${found.length ? `${found.length}${more ? "+" : ""} message${found.length === 1 ? "" : "s"} with “${esc(q)}”, newest first` : `Nothing here says “${esc(q)}”.`}</div>` +
    found.map(m => `<button class="result" data-jump="${m.id}"><span class="who">${esc(m.author_name)}<span class="at">${esc(day(m.created_at))} ${time(m.created_at)}</span></span><span class="text">${mark(m.body)}</span></button>`).join("");
  log.scrollTop = 0;
}
// Shows a message from the results in the room, loading older pages until it's there.
async function jumpTo(id) {
  for (let i = 0; i < 40 && !open.messages.has(id) && open.more; i++) {
    const data = await api("GET", `/rooms/${open.id}/messages?before=${Math.min(...open.messages.keys())}`);
    for (const m of await readable(data.messages)) open.messages.set(m.id, m);
    open.more = data.more;
  }
  searching = null;
  $("#searchbar").hidden = true;
  renderLog();
  const el = $(`#log .msg[data-id="${id}"]`);
  if (!el) return toast("That message is too far back to show.");
  el.scrollIntoView({ block: "center" });
  el.classList.add("found");
  setTimeout(() => el.classList.remove("found"), 2500);
}

// ── people: direct messages and adding to private rooms ──────────────────

let pickMode = "dm", everyone = [];
async function pickPerson(mode) {
  pickMode = mode;
  $("#people-title").textContent = mode === "dm" ? "Message someone" : "Add people to this room";
  $("#people-q").value = "";
  $("#people-dialog").showModal();
  $("#people-q").focus();
  try {
    everyone = await api("GET", "/people");
    if (mode === "add") {
      const inRoom = new Set((await api("GET", `/rooms/${open.id}/members`)).map(m => m.username));
      everyone = everyone.filter(p => !inRoom.has(p.username));
    }
  } catch (err) { everyone = []; toast(err.message); }
  drawPeople();
}
function drawPeople() {
  const q = $("#people-q").value.trim().toLowerCase().replace(/^@/, "");
  const list = everyone.filter(p => !q || p.username.includes(q) || p.name.toLowerCase().includes(q));
  $("#people").innerHTML = list.map(p => `<li><button type="button" class="person" data-user="${esc(p.username)}">
      <span class="dot${p.online ? " on" : ""}"></span>${esc(p.name)}<span>@${esc(p.username)}</span></button></li>`).join("")
    || `<li class="none">${everyone.length ? "Nobody matches." : pickMode === "add" ? "Everyone's already in this room." : "There's no one else here yet."}</li>`;
}
$("#people-q").addEventListener("input", drawPeople);
$("#people-q").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); $("#people .person")?.click(); }
});
$("#people").addEventListener("click", async e => {
  const b = e.target.closest("[data-user]");
  if (!b) return;
  try {
    if (pickMode === "dm") {
      const room = await api("POST", "/dms", { username: b.dataset.user });
      $("#people-dialog").close();
      await loadRooms();
      location.hash = room.id;
    } else {
      await api("POST", `/rooms/${open.id}/members`, { username: b.dataset.user });
      everyone = everyone.filter(p => p.username !== b.dataset.user);
      drawPeople();
      toast(`Added @${b.dataset.user}.`);
      await loadRooms();
      renderRoomShell(rooms.find(r => r.id === open.id)); renderLog(); renderPresence();
    }
  } catch (err) { toast(err.message); }
});
$("#dm").addEventListener("click", () => pickPerson("dm"));

// ── making and editing rooms ─────────────────────────────────────────────

let editing = null;   // the room being edited, or null for a new one
function editRoom(room = null) {
  editing = room;
  const f = $("#room-form");
  f.name.value = room?.name ?? ""; f.topic.value = room?.topic ?? "";
  f.private.checked = room?.kind === "private"; f.private.disabled = !!room;
  $("#private-row").hidden = !!room;
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
  if (e.key === "Escape" && e.target.id === "search-q") { e.preventDefault(); closeSearch(); $("#text")?.focus(); return; }
  if (e.key === "Escape" && typing) { e.target.blur(); document.querySelector(".rooms button[aria-current='true'], .rooms button")?.focus(); return; }
  if (typing) return;
  if (e.key === "n") { e.preventDefault(); editRoom(); }
  else if (e.key === "m") { e.preventDefault(); pickPerson("dm"); }
  else if (e.key === "k" && bridges.allowed) { e.preventDefault(); showConnections(); }
  else if (e.key === "f" && open) { e.preventDefault(); openSearch(); }
  else if (e.key === "/" && $("#text")) { e.preventDefault(); $("#text").focus(); }
});
$("#room-cancel").addEventListener("click", () => $("#room-dialog").close());
$("#room-form").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target, fields = { name: f.name.value, topic: f.topic.value };
  if (!editing) fields.private = f.private.checked;
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
  const list = await api("GET", `/rooms/${open.id}/members`), room = rooms.find(r => r.id === open.id);
  const canRemove = room?.kind === "private" && room.manage;
  $("#members").innerHTML = list.map(m => `<li><span class="dot${m.online ? " on" : ""}"></span>${esc(m.name)}<span>@${esc(m.username)}${m.owner ? " · made this room" : ""}</span>
      ${canRemove && !m.owner ? `<button type="button" class="link remove" data-remove="${esc(m.username)}">Take out</button>` : ""}</li>`).join("")
    || `<li>Nobody has joined yet.</li>`;
  $("#members-dialog").showModal();
}
$("#members").addEventListener("click", async e => {
  const who = e.target.dataset?.remove;
  if (!who || !confirm(`Take @${who} out of this room? They'll stop seeing it.`)) return;
  try {
    await api("DELETE", `/rooms/${open.id}/members/${encodeURIComponent(who)}`);
    await loadRooms();
    $("#members-dialog").close();
    await showMembers();
  } catch (err) { toast(err.message); }
});

// ── connections to other platforms ───────────────────────────────────────

const ago = t => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : day(t);
};
async function showConnections() {
  const dlg = $("#connections-dialog");
  if (!dlg.open) dlg.showModal();
  $("#connections-off").hidden = bridges.ready !== false;
  $("#connections-off").textContent = "Connections need a secret the site's admin hasn't set up yet (CHAT_BRIDGE_KEY). See the README.";
  $("#connect-form").hidden = !bridges.ready;
  $("#connections-only-close").hidden = !!bridges.ready;
  if (bridges.ready) drawProvider();
  let list = [];
  try { list = await api("GET", "/connections"); } catch (err) { toast(err.message); }
  $("#connections").innerHTML = list.map(c => `<li>
      <span class="dot${c.status === "ok" ? " on" : ""}"></span>
      <span class="what"><b>${esc(c.network)}</b> ${esc(c.label)}
        <span>${c.status === "ok" ? `${c.rooms} room${c.rooms === 1 ? "" : "s"}${c.synced_at ? ` · synced ${esc(ago(c.synced_at))}` : ""} · ${esc(encryptionNote(c))}` : ""}${c.error ? `<span class="bad">${esc(c.error)}</span>` : ""}</span></span>
      <button type="button" class="link" data-resync="${esc(c.id)}">Sync now</button>
      <button type="button" class="link remove" data-disconnect="${esc(c.id)}" data-label="${esc(c.label)}">Remove</button></li>`).join("")
    || `<li class="none">Nothing connected yet.</li>`;
}
// Where a connection's encryption keys are, in a few words.
const encryptionNote = c => !c.can_encrypt ? "encrypted rooms need a password sign-in"
  : storedKey(c.id) ? "encryption keys in this browser" : c.keys_held ? "encryption keys in another browser" : "encryption not turned on yet";
function drawProvider() {
  const sel = $("#connect-provider"), providers = bridges.providers || [];
  if (sel.options.length !== providers.length) sel.innerHTML = providers.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  sel.hidden = $("#connect-provider-label").hidden = providers.length < 2;
  const p = providers.find(p => p.id === sel.value) || providers[0];
  if (!p) return;
  $("#connect-help").textContent = p.help;
  $("#connect-fields").innerHTML = p.fields.map(f => `<label for="cf-${esc(f.name)}">${esc(f.label)}${f.required ? "" : " <span>(optional)</span>"}</label>
    <input id="cf-${esc(f.name)}" name="${esc(f.name)}" type="${f.secret ? "password" : "text"}" placeholder="${esc(f.placeholder || "")}" autocomplete="off" spellcheck="false"${f.required ? " required" : ""}>`).join("");
  $("#connect-error").hidden = true;
}
$("#connect-provider").addEventListener("change", drawProvider);
$("#connections-open").addEventListener("click", showConnections);
for (const b of ["#connections-close", "#connections-close-2"]) $(b).addEventListener("click", () => $("#connections-dialog").close());
$("#connect-form").addEventListener("submit", async e => {
  e.preventDefault();
  const fields = { provider: $("#connect-provider").value };
  for (const input of $("#connect-fields").querySelectorAll("input")) if (input.value) fields[input.name] = input.value;
  const save = $("#connect-save");
  save.disabled = true; save.textContent = "Connecting…";
  try {
    const c = await api("POST", "/connections", fields);
    toast(`Connected ${c.label}: ${c.rooms} room${c.rooms === 1 ? "" : "s"}.`);
    drawProvider();
    await loadRooms();
    await showConnections();
  } catch (err) { $("#connect-error").textContent = err.message; $("#connect-error").hidden = false; }
  finally { save.disabled = false; save.textContent = "Connect"; }
});
$("#connections").addEventListener("click", async e => {
  const b = e.target.closest("[data-resync], [data-disconnect]");
  if (!b) return;
  try {
    if (b.dataset.resync) { b.disabled = true; await api("POST", `/connections/${b.dataset.resync}/sync`); }
    else {
      if (!confirm(`Remove ${b.dataset.label}? Its rooms leave Chat; your rooms and messages there stay as they are.`)) return;
      await api("DELETE", `/connections/${b.dataset.disconnect}`);
    }
    await loadRooms();
    await showConnections();
  } catch (err) { toast(err.message); }
});

// ── start ────────────────────────────────────────────────────────────────

async function route() {
  const id = location.hash.slice(1);
  // The dashboard and admin page link here for connections.
  if (id === "connections") { history.replaceState(null, "", location.pathname); if (bridges.allowed) showConnections(); return; }
  if (!id) { if (open) closeRoom(); return; }
  if (open?.id === id) return;
  try { await openRoom(id); } catch (e) { toast(e.message); closeRoom(); }
}
window.addEventListener("hashchange", route);

setInterval(pollRoom, ROOM_EVERY);
setInterval(() => { if (!document.hidden) loadRooms().catch(() => {}); }, LIST_EVERY);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { pollRoom(); loadRooms().catch(() => {}); } });

loadRooms().then(route).catch(e => toast(e.message));
