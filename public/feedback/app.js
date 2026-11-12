// Feedback: write a note to the site's owner (with photos and links to the
// exact things it's about), read the ones you've sent and their replies, and,
// for admins, the inbox of everyone's. The Worker side is src/feedback.js.

const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter(k => k != null));
  return n;
};

let data = null;          // GET /feedback/api/feedback: {mine, inbox, owner, kinds, statuses, sources, photos_each, links_each}
let tab = "new";          // new, mine or inbox
let status = "open";      // the list's filter: open (new and planned), or one status, or all
let open = null;          // the open note's id
let note = null;          // the open note, in full
let shown = [];           // the ids in the list, as filtered
let draft = { photos: [], links: [] };  // the note being written: photos as {file, url, caption}
let picking = null;       // where the picker's choices go: "draft", or the open note
let source = null;        // the picker's app

const MAX_SIDE = 1800, MAX_BYTES = 1100 * 1024;
const KIND = { idea: "Idea", bug: "Bug", praise: "Praise", question: "Question", other: "Other" };
const STATUS = { new: "New", planned: "Planned", done: "Done", closed: "Closed" };

async function api(method, path, body) {
  const res = await fetch("/feedback/api/" + path, {
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
  try { await fn(); } catch (e) { say("error", cap(e.message || String(e))); return e; }
}
const when = s => new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const plural = (n, w, many = w + "s") => `${n} ${n === 1 ? w : many}`;
const sourceName = l => l.what || (l.app === "url" ? "Link" : data.sources.find(s => s.id === l.app)?.name || l.app);

// ── tabs and the list ──────────────────────────────────────────────────────

function setTab(t, { keep = false } = {}) {
  if (t === "inbox" && !data.owner) t = "mine";
  tab = t;
  for (const b of document.querySelectorAll("[data-tab]")) b.setAttribute("aria-pressed", String(b.dataset.tab === t));
  $("#compose").hidden = t !== "new";
  $("#lists").hidden = t === "new";
  if (t === "new") { history.replaceState(null, "", location.pathname); return; }
  renderList();
  if (!keep) {
    // The first unread note, else the newest.
    const list = tab === "inbox" ? data.inbox : data.mine;
    const first = shown.find(id => list.find(n => n.id === id)?.unread) || shown[0] || null;
    openNote(first, { quiet: !first });
  }
}

function renderTabs() {
  const unread = list => list.filter(n => n.unread).length;
  const label = (b, text, n) => { b.replaceChildren(text); if (n) b.append(el("span", { className: "dot", textContent: n, title: `${n} unread` })); };
  label(document.querySelector("[data-tab=mine]"), `Sent (${data.mine.length})`, unread(data.mine));
  const inbox = document.querySelector("[data-tab=inbox]");
  inbox.hidden = !data.owner;
  if (data.owner) label(inbox, `Inbox (${data.inbox.length})`, unread(data.inbox));
  // The rail's Feedback count goes down as notes are read (the inbox holds your own notes too).
  window.sintfoapBadge?.("feedback", unread(data.owner ? data.inbox : data.mine));
  $("#headline").textContent = data.owner && tab === "inbox" ? "What people have sent you" : "Tell the site's owner what you think";
}

function renderFilters() {
  const box = $("#filters");
  box.replaceChildren();
  for (const [id, name] of [["open", "Open"], ...data.statuses.map(s => [s, STATUS[s] || s]), ["all", "All"]]) {
    const b = el("button", { type: "button", textContent: name });
    b.setAttribute("aria-pressed", String(id === status));
    b.addEventListener("click", () => { status = id; renderFilters(); renderList(); });
    box.append(b);
  }
}

function renderList() {
  const all = tab === "inbox" ? data.inbox : data.mine;
  const match = all.filter(n => status === "all" || (status === "open" ? n.status === "new" || n.status === "planned" : n.status === status));
  shown = match.map(n => n.id);
  const ul = $("#notes");
  ul.replaceChildren();
  if (!all.length) ul.append(el("li", { className: "empty", style: "padding:10px", textContent: tab === "inbox" ? "Nobody has sent anything yet." : "You haven't sent anything yet. Write a note." }));
  else if (!match.length) ul.append(el("li", { className: "empty", style: "padding:10px", textContent: "Nothing here with that status." }));
  for (const n of match) {
    const bits = [tab === "inbox" ? n.by : null, KIND[n.kind] || n.kind, when(n.last_at),
      n.photos ? plural(n.photos, "photo") : "", n.links ? plural(n.links, "link") : "", n.replies ? plural(n.replies, "reply", "replies") : ""].filter(Boolean);
    const b = el("button", { type: "button", className: n.unread ? "unread" : "" },
      el("b", {}, el("span", { className: `tag s-${n.status}`, textContent: STATUS[n.status] || n.status }),
        n.unread ? el("span", { className: "new", textContent: n.why === "note" ? "unread" : "new reply" }) : "", n.subject),
      el("small", { textContent: bits.join(" · ") }));
    b.setAttribute("aria-current", String(n.id === open));
    b.addEventListener("click", () => openNote(n.id));
    ul.append(el("li", {}, b));
  }
}

async function openNote(id, { quiet = false } = {}) {
  open = id;
  if (tab !== "new") history.replaceState(null, "", id ? "#" + id : "#" + tab);
  if (!id) { note = null; renderDetail(); return; }
  await run(async () => {
    note = await api("GET", "items/" + id);
    // Opening it marks it read.
    for (const list of [data.mine, data.inbox || []]) { const s = list.find(n => n.id === id); if (s) s.unread = false; }
    renderTabs();
    renderList();
    renderDetail();
  });
  if (quiet) return;
}

async function reload() {
  data = await api("GET", "feedback");
  renderTabs();
  if (tab !== "new") renderList();
}

// ── one note ───────────────────────────────────────────────────────────────

function linkItem(l, onRemove) {
  const body = el("div", {}, el("div", { className: "what", textContent: sourceName(l) }));
  if (l.app === "url") body.append(el("b", {}, el("a", { href: l.url, textContent: l.title || l.url, target: "_blank", rel: "noopener noreferrer" })), el("small", { textContent: l.url }));
  else {
    // Only the sender can open their own recipe or item; the admins read the snapshot.
    body.append(el("b", {}, l.href && (!note || note.yours || tab === "new") ? el("a", { href: l.href, textContent: l.title }) : l.title));
    if (l.sub) body.append(el("small", { textContent: l.sub }));
    if (l.detail) body.append(el("div", { className: "excerpt", textContent: l.detail }));
  }
  const li = el("li", {}, body);
  if (onRemove) {
    const x = el("button", { type: "button", className: "x", textContent: "remove", title: "Take this link off" });
    x.addEventListener("click", onRemove);
    li.append(x);
  } else li.append(el("span"));
  return li;
}

function renderDetail() {
  const box = $("#detail");
  box.replaceChildren();
  const n = note;
  if (!n) {
    box.append(el("p", { className: "empty", textContent: shown.length ? "Pick a note from the list." : tab === "inbox" ? "Notes people send will show up here." : "Notes you send will show up here, with the owner's replies." }));
    return;
  }
  const card = el("article", { className: "card note" });
  card.append(el("div", { className: "when", textContent: [KIND[n.kind] || n.kind, STATUS[n.status] || n.status, when(n.created)].join(" · ") }));
  card.append(el("h2", {}, n.subject || "(no subject)", n.new_to_you ? el("span", { className: "new", textContent: "new" }) : ""));
  card.append(el("div", { className: "by", textContent: n.yours ? (n.seen_by_owner ? "From you · the owner has read it" : "From you · not read yet") : `From ${n.by}${n.username ? ` (${n.username})` : ""}` }));
  if (n.message) card.append(el("p", { className: "body", textContent: n.message }));

  if (n.can_set_status) {
    card.append(el("h3", { textContent: "Status" }));
    const s = el("div", { className: "statuses", role: "group", ariaLabel: "Status" });
    for (const st of data.statuses) {
      const b = el("button", { type: "button", textContent: STATUS[st] || st });
      b.setAttribute("aria-pressed", String(n.status === st));
      b.addEventListener("click", () => run(async () => { note = await api("PATCH", "items/" + n.id, { status: st }); await reload(); renderDetail(); }));
      s.append(b);
    }
    card.append(s);
  }

  card.append(el("h3", { textContent: `Photos${n.photos.length ? ` (${n.photos.length})` : ""}` }));
  if (n.photos.length) {
    const grid = el("div", { className: "photos" });
    for (const ph of n.photos) {
      const src = `/feedback/api/photos/${ph.id}`;
      const view = el("button", { type: "button", className: "view" }, el("img", { src, alt: ph.caption || "A photo with this note", loading: "lazy" }));
      view.addEventListener("click", () => { $("#big").src = src; $("#big-caption").textContent = ph.caption || ""; $("#viewer").showModal(); });
      const capt = el("figcaption", {}, ph.caption || el("span", { className: "empty", textContent: when(ph.created) }));
      if (ph.can_remove) {
        const x = el("button", { type: "button", textContent: "remove", title: "Take this photo off" });
        x.addEventListener("click", () => confirm("Take this photo off?") && run(async () => { note = await api("DELETE", `items/${n.id}/photos/${ph.id}`); await reload(); renderDetail(); }));
        capt.prepend(x);
      }
      grid.append(el("figure", {}, view, capt));
    }
    card.append(grid);
  } else card.append(el("p", { className: "empty", textContent: "No photos." }));
  if (n.can_add_photos) {
    const add = el("button", { className: "btn quiet small", type: "button", id: "add-photos", textContent: "Add photos" });
    add.addEventListener("click", () => $("#more-files").click());
    card.append(add);
  }

  card.append(el("h3", { textContent: `Linked${n.links.length ? ` (${n.links.length})` : ""}` }));
  if (n.links.length) card.append(el("ul", { className: "links" }, ...n.links.map((l, i) => linkItem(l, n.can_edit ? () => run(async () => {
    note = await api("PATCH", "items/" + n.id, { links: n.links.filter((_, j) => j !== i) });
    await reload(); renderDetail();
  }) : null))));
  else card.append(el("p", { className: "empty", textContent: "Nothing linked." }));
  if (n.can_edit) {
    const add = el("button", { className: "btn quiet small", type: "button", id: "add-link", textContent: "Link something" });
    add.addEventListener("click", () => openPicker(n));
    card.append(add);
  }

  card.append(el("h3", { textContent: "Replies" }));
  if (n.replies.length) {
    card.append(el("ul", { className: "thread" }, ...n.replies.map(r => el("li", { className: [r.from_owner ? "owner" : "", r.unread ? "unread" : ""].join(" ").trim() },
      el("div", { className: "who" }, el("b", { textContent: r.yours ? "You" : r.by }), r.from_owner && !r.yours ? " · the owner" : "", ` · ${when(r.created)}`,
        r.unread ? el("span", { className: "new", textContent: "new" }) : ""),
      el("div", { className: "text", textContent: r.text })))));
  } else card.append(el("p", { className: "empty", textContent: n.yours ? "No reply yet. You'll see the owner's answer here." : "No replies yet." }));
  const form = el("form", { id: "reply-form" });
  const ta = el("textarea", { name: "text", rows: 3, maxLength: 4000, placeholder: n.yours ? "Add more, or answer the owner" : `Reply to ${n.by}`, ariaLabel: "Reply" });
  form.append(ta, el("div", { className: "row" }, el("button", { className: "btn", type: "submit", textContent: "Reply" })));
  form.addEventListener("submit", e => {
    e.preventDefault();
    if (!ta.value.trim()) return;
    run(async () => { note = await api("POST", `items/${n.id}/replies`, { text: ta.value }); await reload(); renderDetail(); say("done", "Reply sent."); });
  });
  card.append(form);

  if (n.can_delete) {
    const del = el("button", { className: "btn danger", type: "button", textContent: "Delete" });
    del.addEventListener("click", () => {
      if (!confirm(`Delete “${n.subject || "this note"}” with its photos and replies?`)) return;
      run(async () => { await api("DELETE", "items/" + n.id); await reload(); open = null; openNote(shown[0] || null); });
    });
    card.append(el("div", { className: "actions" }, del));
  }
  box.append(card);
}

// ── writing a note ─────────────────────────────────────────────────────────

function renderKinds() {
  const box = $("#kinds");
  box.replaceChildren(...data.kinds.map((k, i) => el("label", {}, el("input", { type: "radio", name: "kind", value: k, checked: i === 0 }), el("span", { textContent: KIND[k] || k }))));
}

function renderDraft() {
  const thumbs = $("#thumbs");
  thumbs.replaceChildren(...draft.photos.map((p, i) => {
    const x = el("button", { type: "button", className: "x", textContent: "×", title: "Take this photo off", ariaLabel: "Remove photo" });
    x.addEventListener("click", () => { URL.revokeObjectURL(p.url); draft.photos.splice(i, 1); renderDraft(); });
    const c = el("input", { type: "text", value: p.caption, placeholder: "Caption", maxLength: 300, ariaLabel: "Caption" });
    c.addEventListener("input", () => { p.caption = c.value; });
    return el("figure", {}, el("img", { src: p.url, alt: "" }), x, c);
  }));
  $("#photo-count").textContent = draft.photos.length ? `${draft.photos.length} of ${data.photos_each}` : "";
  $("#draft-links").replaceChildren(...draft.links.map((l, i) => linkItem(l, () => { draft.links.splice(i, 1); renderDraft(); })));
  $("#link-count").textContent = draft.links.length ? `${draft.links.length} linked` : "";
  if (data) keepDraft();
}

function addFiles(files) {
  const pics = [...files].filter(f => f.type.startsWith("image/"));
  if (!pics.length) return;
  const room = data.photos_each - draft.photos.length;
  if (pics.length > room) say("error", `A note can have ${data.photos_each} photos; only the first ${Math.max(0, room)} were added.`);
  for (const f of pics.slice(0, Math.max(0, room))) draft.photos.push({ file: f, url: URL.createObjectURL(f), caption: "" });
  renderDraft();
}

const drop = $("#drop");
drop.addEventListener("click", () => $("#files").click());
drop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#files").click(); } });
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); });
$("#files").addEventListener("change", e => { addFiles(e.target.files); e.target.value = ""; });
document.addEventListener("paste", e => {
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
  if (!files.length) return;
  e.preventDefault();
  if (tab === "new") addFiles(files);
  else if (note?.can_add_photos) uploadTo(note, files.map(file => ({ file, caption: "" })));
});

function addUrl() {
  const v = $("#url").value.trim();
  if (!v) return;
  let u;
  try { u = new URL(v); } catch { say("error", "That link isn't a web address."); return; }
  if (!/^https?:$/.test(u.protocol)) { say("error", "Links start with https://"); return; }
  const l = { app: "url", url: u.href, title: u.hostname.replace(/^www\./, "") + (u.pathname !== "/" ? u.pathname : "") };
  if (picking && picking !== "draft") {
    run(async () => { note = await api("PATCH", "items/" + note.id, { links: [...note.links, l] }); await reload(); renderDetail(); });
  } else if (!draft.links.some(x => x.url === l.url)) { draft.links.push(l); renderDraft(); }
  $("#url").value = "";
  say("error", "");
}
$("#url-add").addEventListener("click", addUrl);
$("#url").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addUrl(); } });

// A photo, made small enough to keep: at most MAX_SIDE across, as a JPEG.
async function shrink(file) {
  if (file.size <= MAX_BYTES && /^image\/(jpeg|png|webp|gif)$/.test(file.type)) return file;
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  if (!bmp) throw new Error(`${file.name || "that file"} isn't a picture this browser can read`);
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  for (const q of [0.85, 0.75, 0.6, 0.45]) {
    const blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", q));
    if (blob && blob.size <= MAX_BYTES) return blob;
  }
  throw new Error("that photo is too big even after shrinking it");
}
const base64 = async blob => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

// Sends photos to a note one at a time, saying how far it's got.
async function sendPhotos(id, photos, show = t => { $("#progress").textContent = t; }) {
  let out = null;
  for (const [i, p] of photos.entries()) {
    show(`Sending photo ${i + 1} of ${photos.length}…`);
    out = await api("POST", `items/${id}/photos`, { data: await base64(await shrink(p.file)), caption: p.caption });
  }
  show("");
  return out;
}

async function uploadTo(n, photos) {
  await run(async () => {
    const out = await sendPhotos(n.id, photos, t => say("done", t));
    if (out) { note = out; await reload(); renderDetail(); say("done", `${plural(photos.length, "photo")} added.`); }
  });
}
$("#more-files").addEventListener("change", e => {
  const files = [...e.target.files];
  e.target.value = "";
  if (note && files.length) uploadTo(note, files.map(file => ({ file, caption: "" })));
});

$("#note-form").addEventListener("submit", e => {
  e.preventDefault();
  const f = $("#note-form");
  const body = { kind: f.querySelector("input[name=kind]:checked")?.value || "idea", subject: f.subject.value, message: f.message.value,
    links: draft.links.map(l => l.app === "url" ? { app: "url", url: l.url, title: l.title } : { app: l.app, id: l.id }) };
  if (!body.subject.trim() && !body.message.trim()) { say("error", "Say what it's about first."); f.message.focus(); return; }
  $("#send").disabled = true;
  run(async () => {
    $("#progress").textContent = "Sending…";
    const made = await api("POST", "items", body);
    let photosFailed = null;
    try { await sendPhotos(made.id, draft.photos); } catch (err) { photosFailed = err; }
    for (const p of draft.photos) URL.revokeObjectURL(p.url);
    draft = { photos: [], links: [] };
    f.reset();
    forgetDraft();
    renderKinds();
    renderDraft();
    await reload();
    setTab("mine", { keep: true });
    await openNote(made.id);
    say(photosFailed ? "error" : "done", photosFailed ? `Sent, but a photo didn't go: ${photosFailed.message}. Add it from the note.` : "Sent. Thank you!");
  }).finally(() => { $("#send").disabled = false; $("#progress").textContent = ""; });
});

// ── keeping the note you're writing ───────────────────────────────────────
// Its words, kind and links stay in this browser until it's sent, so leaving the
// page (to find the thing it's about) doesn't lose it. Photos can't be kept, so
// leaving with some attached asks first.

const DRAFT_KEY = "feedback-draft";
function keepDraft() {
  const f = $("#note-form");
  const kept = { kind: f.querySelector("input[name=kind]:checked")?.value || "", subject: f.subject.value, message: f.message.value, links: draft.links };
  try {
    if (kept.subject.trim() || kept.message.trim() || kept.links.length) localStorage.setItem(DRAFT_KEY, JSON.stringify(kept));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {}
}
function forgetDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch {} }
function restoreDraft() {
  let kept = null;
  try { kept = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch {}
  if (!kept || typeof kept !== "object") return false;
  const f = $("#note-form");
  f.subject.value = String(kept.subject || "");
  f.message.value = String(kept.message || "");
  const k = f.querySelector(`input[name=kind][value="${CSS.escape(String(kept.kind || ""))}"]`);
  if (k) k.checked = true;
  if (Array.isArray(kept.links)) draft.links = kept.links.filter(l => l && typeof l === "object").slice(0, data.links_each);
  renderDraft();
  return !!(f.subject.value.trim() || f.message.value.trim() || draft.links.length);
}
$("#note-form").addEventListener("input", keepDraft);
$("#note-form").addEventListener("change", keepDraft);
addEventListener("beforeunload", e => { if (draft.photos.length) e.preventDefault(); });

// ── the link picker ────────────────────────────────────────────────────────

function openPicker(target) {
  picking = target ? "note" : "draft";
  if (!data.sources.length) { say("error", "None of your apps have anything to link yet; paste a link instead."); return; }
  source ||= data.sources[0].id;
  renderSources();
  $("#find").value = "";
  $("#picker").showModal();
  $("#find").focus();
  search();
}

function renderSources() {
  $("#sources").replaceChildren(...data.sources.map(s => {
    const b = el("button", { type: "button", textContent: s.app, title: s.name });
    b.setAttribute("aria-pressed", String(s.id === source));
    b.addEventListener("click", () => { source = s.id; renderSources(); search(); $("#find").focus(); });
    return b;
  }));
}

const linked = () => picking === "draft" ? draft.links : note?.links || [];
let searching = 0;
async function search() {
  const mine = ++searching, q = $("#find").value;
  const ul = $("#found");
  try {
    const { items } = await api("GET", `linkable?app=${encodeURIComponent(source)}&q=${encodeURIComponent(q)}`);
    if (mine !== searching) return;
    ul.replaceChildren();
    if (!items.length) ul.append(el("li", { className: "empty", style: "padding:10px", textContent: q ? "Nothing by that name." : "Nothing here yet." }));
    for (const it of items) {
      const has = linked().some(l => l.app === it.app && l.id === it.id);
      const b = el("button", { type: "button" }, el("span", {}, el("b", { textContent: it.title }), el("small", { textContent: it.sub || "" })),
        el("span", { className: has ? "added" : "hint", textContent: has ? "✓ linked" : "add" }));
      b.addEventListener("click", () => choose(it));
      ul.append(el("li", {}, b));
    }
  } catch (e) { if (mine === searching) ul.replaceChildren(el("li", { className: "empty", style: "padding:10px", textContent: cap(e.message) })); }
}
let typing = 0;
$("#find").addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(search, 180); });

async function choose(it) {
  if (linked().some(l => l.app === it.app && l.id === it.id)) return;
  if (linked().length >= data.links_each) { say("error", `A note can link at most ${data.links_each} things.`); return; }
  if (picking === "draft") {
    draft.links.push({ ...it, href: "" });
    renderDraft();
  } else {
    await run(async () => { note = await api("PATCH", "items/" + note.id, { links: [...note.links, { app: it.app, id: it.id }] }); await reload(); renderDetail(); });
  }
  search();
}
$("#link-btn").addEventListener("click", () => openPicker(null));
$("#picker-close").addEventListener("click", () => $("#picker").close());

// ── keys, and starting ─────────────────────────────────────────────────────

for (const b of document.querySelectorAll("[data-tab]")) b.addEventListener("click", () => setTab(b.dataset.tab));

document.addEventListener("keydown", e => {
  const t = e.target;
  if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || t.matches?.("input, textarea, select") || document.querySelector("dialog[open]")) return;
  const at = shown.indexOf(open);
  const tabs = ["new", "mine", ...(data?.owner ? ["inbox"] : [])];
  const keys = {
    n: () => { setTab("new"); $("#note-form").subject.focus(); },
    v: () => setTab(tabs[(tabs.indexOf(tab) + 1) % tabs.length]),
    j: () => tab !== "new" && shown.length && openNote(shown[Math.min(shown.length - 1, at + 1)]),
    k: () => tab !== "new" && shown.length && openNote(shown[Math.max(0, at - 1)]),
    l: () => tab === "new" ? openPicker(null) : note?.can_edit && openPicker(note),
    p: () => tab === "new" ? $("#files").click() : note?.can_add_photos && $("#more-files").click(),
    r: () => $("#reply-form textarea")?.focus(),
  };
  if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
});

run(async () => {
  data = await api("GET", "feedback");
  renderKinds();
  renderFilters();
  const restored = restoreDraft();
  renderDraft();
  renderTabs();
  if (restored) say("done", "Your unsent note is just as you left it.");
  const h = location.hash.slice(1);
  if (/^fb_/.test(h)) {
    const inInbox = data.owner && data.inbox.some(n => n.id === h) && !data.mine.some(n => n.id === h);
    status = "all";
    renderFilters();
    setTab(inInbox ? "inbox" : "mine", { keep: true });
    await openNote(h);
  } else if (h === "inbox" || h === "mine") setTab(h);
  // Admins land on the inbox when something's waiting there.
  else if (data.owner && data.inbox.some(n => n.unread)) setTab("inbox");
});
