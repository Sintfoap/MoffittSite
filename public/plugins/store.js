// The plugin store page: browse approved plugins, write your own, and (for
// admins) review what's been submitted. Plugin code is only ever shown as
// text here; nothing on this page runs it.

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ago = t => {
  if (!t) return "";
  const s = Date.now() / 1000 - t;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};
const STATUS = { draft: "Draft", pending: "Waiting for review", approved: "Approved", rejected: "Rejected" };
const badge = status => `<span class="badge ${status}">${STATUS[status]}</span>`;

// A starting point that follows Drift's plugin shape. Store plugins are one
// file with no imports.
const TEMPLATE = (id, name, description) => `// ${name}: a Drift plugin.
// It keeps its data on each item under item.meta.${id}.
export default {
  id: ${JSON.stringify(id)},
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(description)},
  icon: '<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.8"/>',

  // Checks and tidies this plugin's data. Call fail("why") to refuse it.
  clean(value, fail) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("${id} must be an object");
    return { stars: Math.max(0, Math.min(5, Math.trunc(Number(value.stars) || 0))) };
  },

  // Data for a new item added while the plugin is on (or undefined for none).
  fresh: () => ({ stars: 0 }),

  // Shown under an item's title.
  chips: item => item.meta.${id}.stars ? [\`<span class="chip">\${"★".repeat(item.meta.${id}.stars)}</span>\`] : [],

  // Inputs in the item dialog, and how to read them back.
  editor: item => \`<label>Stars<input type="number" name="stars" min="0" max="5" value="\${item.meta.${id}?.stars || 0}"></label>\`,
  read: fields => ({ stars: Number(fields.stars) || 0 }),
};
`;

let state = { user: {}, store: [], mine: [], waiting: 0 };
let queue = [];
let tab = "store";
let current = null;   // id of the plugin open in the editor
let dirty = false;

async function api(method, path, body) {
  const res = await fetch("/plugins/api" + path, {
    method, headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname); throw new Error("not signed in"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
const attempt = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

async function load() {
  state = await api("GET", "/state");
  if (state.user.reviewer) queue = await api("GET", "/review");
  render();
}

// ── tabs ───────────────────────────────────────────────────────────────────

function show(name) {
  if (tab === "workshop" && name !== "workshop" && dirty && !confirm("Leave without saving your changes?")) return;
  if (name !== "workshop") dirty = false;
  tab = name;
  for (const b of document.querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  for (const s of ["store", "workshop", "review"]) $(`#tab-${s}`).hidden = s !== name;
  try { history.replaceState(null, "", name === "store" ? location.pathname : `#${name}`); } catch {}
  render();
}
for (const b of document.querySelectorAll("[data-tab]")) b.addEventListener("click", () => show(b.dataset.tab));

function render() {
  $("#who").textContent = state.user.name ? `Signed in as ${state.user.name}` : "";
  const rev = document.querySelector('[data-tab="review"]');
  rev.hidden = !state.user.reviewer;
  $("#waiting").hidden = !queue.length;
  $("#waiting").textContent = queue.length;
  if (tab === "store") renderStore();
  if (tab === "workshop") renderWorkshop();
  if (tab === "review") renderQueue();
}

// ── store ──────────────────────────────────────────────────────────────────

function renderStore() {
  const q = $("#q").value.trim().toLowerCase();
  const list = state.store.filter(p => !q || `${p.name} ${p.description} ${p.author} ${p.id}`.toLowerCase().includes(q));
  $("#store").innerHTML = list.length ? list.map(p => `
    <button class="card" data-open="${esc(p.id)}">
      <b>${esc(p.name)}</b>
      <p>${esc(p.description) || "No description."}</p>
      <span class="meta"><span>by ${esc(p.author || "a removed account")}</span><span>v${p.version}</span><span>${ago(p.updated)}</span></span>
    </button>`).join("")
    : `<div class="empty" style="grid-column: 1 / -1"><b>${q ? "No plugins match" : "No plugins yet"}</b>${q ? "Try a different search." : "Write the first one under My plugins."}</div>`;
}
$("#q").addEventListener("input", renderStore);
$("#store").addEventListener("click", attempt(async e => {
  const b = e.target.closest("[data-open]");
  if (!b) return;
  const p = await api("GET", `/store/${b.dataset.open}`);
  $("#detail-body").innerHTML = `
    <h2>${esc(p.name)}</h2>
    <span class="meta"><span>by ${esc(p.author || "a removed account")}</span><span>v${p.version}</span><span>approved ${ago(p.updated)}</span><span>id <code>${esc(p.id)}</code></span></span>
    <p>${esc(p.description) || "No description."}</p>
    <div class="notice">Installing plugins into Drift from here is coming soon.</div>
    <div class="code"><div class="nums"></div><textarea readonly spellcheck="false" aria-label="Code" rows="18"></textarea></div>
    <div class="actions"><span class="spacer"></span><button class="btn" data-close autofocus>Close</button></div>`;
  const ta = $("#detail-body textarea");
  ta.value = p.code;
  numbers(ta);
  $("#detail").showModal();
}));
$("#detail").addEventListener("click", e => { if (e.target.closest("[data-close]") || e.target === $("#detail")) $("#detail").close(); });

// ── my plugins ─────────────────────────────────────────────────────────────

function renderWorkshop() {
  $("#mine").innerHTML = state.mine.length ? state.mine.map(p => `
    <button class="item" data-pick="${esc(p.id)}" aria-current="${p.id === current}">
      <span>${esc(p.working.name)}</span>
      <span class="meta">${badge(p.pending ? "pending" : p.working.status)}${p.published ? `<span>live v${p.published.version}</span>` : ""}</span>
    </button>`).join("") : `<p class="status">You haven't written any plugins yet.</p>`;
  if (!state.mine.some(p => p.id === current)) current = state.mine[0]?.id ?? null;
  renderEditor();
}

function renderEditor() {
  const p = state.mine.find(x => x.id === current);
  for (const b of document.querySelectorAll("[data-pick]")) b.setAttribute("aria-current", String(b.dataset.pick === current));
  if (!p) {
    $("#editor").innerHTML = `<div class="empty"><b>Make a plugin</b>Start one with New plugin. You'll get a small working example to change.</div>`;
    return;
  }
  const w = p.working, r = p.lastReview;
  const notes = [];
  if (p.pending) notes.push(`<div class="notice"><b>Version ${p.pending.version} is waiting for review.</b> ${w.status === "draft" ? "You've changed it since; submit again to send the newer version instead." : "Saving a change starts a new draft and leaves the submitted version as it is."}</div>`);
  if (r && r.status === "rejected" && r.version >= (p.published?.version || 0) && !p.pending) notes.push(`<div class="notice bad"><b>Version ${r.version} was rejected.</b> ${esc(r.note)}</div>`);
  if (r && r.status === "approved" && r.version === p.published?.version && w.status !== "draft") notes.push(`<div class="notice good"><b>Version ${r.version} is live in the store.</b>${r.note ? " " + esc(r.note) : ""}</div>`);
  $("#editor").innerHTML = `
    ${notes.join("")}
    <div class="fields">
      <label>Name<input id="f-name" maxlength="60"></label>
      <label>Description<input id="f-desc" maxlength="300"></label>
    </div>
    <div class="code"><div class="nums"></div><textarea id="f-code" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Code"></textarea></div>
    <div class="actions">
      <button class="btn primary" id="save">Save draft</button>
      <button class="btn" id="submit" ${w.status === "draft" ? "" : "disabled"}>Submit for review</button>
      ${p.pending ? `<button class="btn" id="withdraw">Withdraw</button>` : ""}
      <span class="status" id="saved">v${w.version} · ${STATUS[w.status]} · id <code>${esc(p.id)}</code></span>
      <span class="spacer"></span>
      <button class="btn danger" id="delete">Delete</button>
    </div>`;
  $("#f-name").value = w.name;
  $("#f-desc").value = w.description;
  $("#f-code").value = w.code;
  dirty = false;
  const ta = $("#f-code");
  numbers(ta);
  ta.addEventListener("input", () => { numbers(ta); touched(); });
  ta.addEventListener("scroll", () => { ta.previousElementSibling.scrollTop = ta.scrollTop; });
  ta.addEventListener("keydown", indent);
  $("#f-name").addEventListener("input", touched);
  $("#f-desc").addEventListener("input", touched);
  $("#save").addEventListener("click", attempt(save));
  $("#submit").addEventListener("click", attempt(submitIt));
  $("#withdraw")?.addEventListener("click", attempt(async () => { replace(await api("POST", `/mine/${current}/withdraw`)); toast("Taken out of review."); }));
  $("#delete").addEventListener("click", attempt(async () => {
    if (!confirm(`Delete ${w.name}? ${p.published ? "It comes out of the store too. " : ""}This can't be undone.`)) return;
    await api("DELETE", `/mine/${current}`);
    state.mine = state.mine.filter(x => x.id !== current);
    state.store = state.store.filter(x => x.id !== current);
    current = null; dirty = false;
    renderWorkshop(); toast("Deleted.");
  }));
}

function touched() {
  dirty = true;
  $("#saved").textContent = "Unsaved changes";
  $("#submit").disabled = true;
}

function replace(p) {
  const i = state.mine.findIndex(x => x.id === p.id);
  if (i >= 0) state.mine[i] = p; else state.mine.push(p);
  current = p.id;
  renderWorkshop();
}

async function save() {
  const p = await api("PATCH", `/mine/${current}`, { name: $("#f-name").value, description: $("#f-desc").value, code: $("#f-code").value });
  replace(p);
  toast("Saved.");
}

async function submitIt() {
  const note = prompt("Anything the reviewer should know? (optional)", "");
  if (note === null) return;
  replace(await api("POST", `/mine/${current}/submit`, { note }));
  toast("Sent for review.");
  if (state.user.reviewer) { queue = await api("GET", "/review"); render(); }
}

$("#mine").addEventListener("click", e => {
  const b = e.target.closest("[data-pick]");
  if (!b || b.dataset.pick === current) return;
  if (dirty && !confirm("Leave without saving your changes?")) return;
  current = b.dataset.pick;
  renderEditor();
});

// Save with Ctrl/Cmd+S while editing.
document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && tab === "workshop" && current) {
    e.preventDefault();
    attempt(save)();
  }
});
window.addEventListener("beforeunload", e => { if (dirty) e.preventDefault(); });

$("#new").addEventListener("click", () => {
  if (dirty && !confirm("Leave without saving your changes?")) return;
  $("#create-form").reset();
  $("#create-error").hidden = true;
  $("#create").showModal();
});
$("#create-form").addEventListener("submit", attempt(async e => {
  if (e.submitter?.value !== "ok") return;
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    const p = await api("POST", "/mine", { ...f, code: TEMPLATE(f.id, f.name, f.description) });
    $("#create").close();
    dirty = false;
    replace(p);
  } catch (err) {
    $("#create-error").textContent = err.message;
    $("#create-error").hidden = false;
  }
}));

// ── the code box ───────────────────────────────────────────────────────────

function numbers(ta) {
  const n = ta.value.split("\n").length;
  ta.previousElementSibling.textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n");
  if (ta.readOnly) ta.rows = Math.min(16, n + 1);
}

// Tab and Shift+Tab indent and outdent by two spaces; Enter keeps the indent.
function indent(e) {
  const ta = e.target, { selectionStart: a, selectionEnd: b, value: v } = ta;
  if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    const start = v.lastIndexOf("\n", a - 1) + 1;
    if (a === b && !e.shiftKey) { ta.setRangeText("  ", a, b, "end"); }
    else {
      const block = v.slice(start, b);
      const out = e.shiftKey ? block.replace(/^ {1,2}/gm, "") : block.replace(/^/gm, "  ");
      ta.setRangeText(out, start, b, "select");
    }
    ta.dispatchEvent(new Event("input"));
  } else if (e.key === "Enter" && !e.shiftKey && a === b) {
    e.preventDefault();
    const line = v.slice(v.lastIndexOf("\n", a - 1) + 1, a);
    const lead = line.match(/^\s*/)[0] + (/[{[(]\s*$/.test(line) ? "  " : "");
    ta.setRangeText("\n" + lead, a, b, "end");
    ta.dispatchEvent(new Event("input"));
  }
}

// ── review ─────────────────────────────────────────────────────────────────

function renderQueue() {
  $("#queue").innerHTML = queue.length ? queue.map((s, i) => `
    <article class="sub-card" data-i="${i}">
      <div class="meta"><span>${esc(s.author || "a removed account")}</span><span>submitted ${ago(s.submitted_at)}</span><span>id <code>${esc(s.id)}</code></span><span>v${s.version}</span>${s.live_code == null ? `<span class="badge pending">New plugin</span>` : `<span class="badge approved">Update</span>`}</div>
      <h3>${esc(s.name)}</h3>
      <p class="status">${esc(s.description) || "No description."}</p>
      ${s.note ? `<blockquote>${esc(s.note)}</blockquote>` : ""}
      <div class="diff">${diff(s.live_code ?? "", s.code)}</div>
      <label>Note to the author<textarea rows="2" maxlength="1000" placeholder="Needed when rejecting: say what to change."></textarea></label>
      <div class="actions"><button class="btn primary" data-decide="approve">Approve</button><button class="btn danger" data-decide="reject">Reject</button></div>
    </article>`).join("")
    : `<div class="empty"><b>Nothing to review</b>Submitted plugins show up here.</div>`;
}

$("#queue").addEventListener("click", attempt(async e => {
  const b = e.target.closest("[data-decide]");
  if (!b) return;
  const card = b.closest("[data-i]"), s = queue[+card.dataset.i];
  const note = card.querySelector("textarea").value;
  await api("POST", `/review/${s.id}/${s.version}`, { decision: b.dataset.decide, note });
  toast(b.dataset.decide === "approve" ? `${s.name} is live.` : `${s.name} was sent back.`);
  await load();
}));

// A line diff of the live code against the submitted code, with long
// unchanged stretches folded. Brand-new plugins show every line as added.
function diff(a, b) {
  const x = a ? a.split("\n") : [], y = b.split("\n");
  let rows;
  if (x.length * y.length > 4e6) rows = [...x.map(l => ["del", l]), ...y.map(l => ["add", l])];
  else {
    const L = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--)
      L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    rows = [];
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { rows.push(["same", x[i]]); i++; j++; }
      else if (j < y.length && (i === x.length || L[i][j + 1] >= L[i + 1][j])) rows.push(["add", y[j++]]);
      else rows.push(["del", x[i++]]);
    }
  }
  const out = [];
  for (let k = 0; k < rows.length; k++) {
    const near = rows.slice(Math.max(0, k - 3), k + 4).some(r => r[0] !== "same");
    if (rows[k][0] !== "same" || near) out.push(`<div class="${rows[k][0]}">${esc(rows[k][1])}</div>`);
    else if (out.at(-1) !== GAP) out.push(GAP);
  }
  return out.join("");
}
const GAP = `<div class="gap">⋯ unchanged lines</div>`;

// ── start ──────────────────────────────────────────────────────────────────

const start = location.hash.slice(1);
load().then(() => { if (["workshop", "review"].includes(start) && (start !== "review" || state.user.reviewer)) show(start); })
  .catch(e => toast(e.message));
