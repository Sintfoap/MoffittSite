// Sweep: suggestions from your chat rooms, to accept into Drift or turn down,
// the rooms it may read, and what you've decided. The Worker side is src/sweep.js.

const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter(k => k != null));
  return n;
};
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const KINDS = { event: "Event", task: "Task", list: "List item" };

let data = null;          // GET /sweep/api/state
let at = 0;               // the highlighted suggestion, for the keys
let editing = null;       // the suggestion whose editor is open

async function api(method, path, body) {
  const res = await fetch("/sweep/api/" + path, {
    method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname); throw new Error("not signed in"); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `the site answered ${res.status}`);
  return out;
}

function showError(e) {
  const box = $("#error");
  box.textContent = e ? e.message || String(e) : "";
  box.hidden = !e;
}
const status = t => { $("#status").textContent = t; };

// "Fri, Oct 24, 7:00 PM", from YYYY-MM-DD or YYYY-MM-DDTHH:MM.
function niceWhen(s) {
  if (!s) return "";
  const [d, t] = s.split("T");
  const date = new Date(`${d}T${t || "12:00"}`);
  const day = date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return t ? `${day}, ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : day;
}
const ago = t => new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// The collection a suggestion would go to: the one it names, if you have it.
const guess = s => data.collections.find(c => !c.owner_name && c.name.toLowerCase() === s.collection.toLowerCase());

function collectionPicker(s) {
  const pick = el("select", { "aria-label": "Collection" });
  const named = guess(s);
  if (!named && s.collection && s.kind === "list") pick.add(new Option(`New list: ${s.collection}`, ""));
  for (const c of data.collections) pick.add(new Option(c.owner_name ? `${c.name} (${c.owner_name})` : c.name, c.id));
  pick.value = named ? named.id : pick.options[0]?.value ?? "";
  return pick;
}

function suggestion(s, i) {
  const pick = collectionPicker(s);
  const li = el("li", { className: "sug" + (i === at ? " at" : "") });
  li.dataset.id = s.id;
  li.append(
    el("div", { className: "head" },
      el("span", { className: `kind ${s.kind}`, textContent: KINDS[s.kind] }),
      el("span", { className: "title", textContent: s.title }),
      s.start ? el("span", { className: "when", textContent: niceWhen(s.start) + (s.end ? ` – ${niceWhen(s.end)}` : "") }) : null),
    s.quote ? el("div", { className: "quote", textContent: s.quote }) : null,
    el("div", { className: "from", textContent: [s.room_name, s.author, s.said_at && ago(s.said_at)].filter(Boolean).join(" · ") }),
    s.why ? el("div", { className: "why", textContent: s.why }) : null,
  );
  if (editing === s.id) {
    const title = el("input", { value: s.title, id: "edit-title", maxLength: 200 });
    const kind = el("select", { id: "edit-kind" });
    for (const [k, label] of Object.entries(KINDS)) kind.add(new Option(label, k));
    kind.value = s.kind;
    const start = el("input", { value: s.start || "", id: "edit-start", placeholder: "YYYY-MM-DD or YYYY-MM-DDTHH:MM" });
    li.append(el("div", { className: "edit" },
      el("label", { htmlFor: "edit-title", textContent: "Title" }), title,
      el("label", { htmlFor: "edit-kind", textContent: "Kind" }), kind,
      el("label", { htmlFor: "edit-start", textContent: "When" }), start,
      el("label", { textContent: "Into" }), pick));
    li.append(el("div", { className: "acts" },
      el("button", { className: "btn", textContent: "Accept", onclick: () => decide(s, true, {
        title: title.value, kind: kind.value, start: start.value.trim() || null, collection: pick.value || undefined }) }),
      el("button", { className: "btn quiet", textContent: "Cancel", onclick: () => { editing = null; render(); } })));
    setTimeout(() => title.focus());
  } else {
    const reason = el("input", { placeholder: "why not? (optional)", maxLength: 200, "aria-label": "Why you're turning it down" });
    li.append(el("div", { className: "acts" },
      data.drift ? el("button", { className: "btn", textContent: "Accept", onclick: () => decide(s, true, { collection: pick.value || undefined }) }) : null,
      data.drift ? pick : null,
      data.drift ? el("button", { className: "btn quiet small", textContent: "Edit", onclick: () => { editing = s.id; at = i; render(); } }) : null,
      el("button", { className: "btn danger", textContent: "Turn down", onclick: () => decide(s, false, { reason: reason.value }) }),
      reason));
  }
  return li;
}

function render() {
  const { ready, drift, rooms, suggestions, history, days } = data;
  $("#unready").hidden = ready;
  $("#nodrift").hidden = drift;
  $("#sweep").disabled = !ready || !rooms.some(r => r.on);
  at = Math.max(0, Math.min(at, suggestions.length - 1));

  $("#sugs-title").textContent = suggestions.length ? `Waiting for you (${suggestions.length})` : "Waiting for you";
  const list = $("#sugs");
  list.replaceChildren(...suggestions.map(suggestion));
  if (!suggestions.length) list.append(el("li", { className: "empty", textContent: rooms.some(r => r.on)
    ? "Nothing waiting. Sweep now to read what's new in your rooms." : "Nothing yet. Tick some rooms below, then sweep." }));

  const roomList = $("#rooms");
  roomList.replaceChildren(...rooms.map(r => {
    const box = el("input", { type: "checkbox", checked: r.on, disabled: r.encrypted && !r.on, onchange: () => setRoom(r, { on: box.checked }) });
    const label = el("label", { className: "check" }, box, el("span", {},
      r.name, r.via ? el("small", { textContent: `${r.via}${r.encrypted ? " · encrypted, so Sweep can't read it yet" : ""}` })
        : r.encrypted ? el("small", { textContent: "Encrypted, so Sweep can't read it yet" }) : null,
      r.on && r.swept_at ? el("small", { textContent: `Last swept ${ago(r.swept_at)}` }) : null));
    const back = el("select", { "aria-label": `How far back to read ${r.name}`, disabled: !r.on, onchange: () => setRoom(r, { on: true, days: Number(back.value) }) });
    for (const n of days) back.add(new Option(n === 1 ? "last day" : `last ${n} days`, n));
    back.value = r.days;
    return el("li", {}, label, back);
  }));
  if (!rooms.length) roomList.append(el("li", { className: "empty", textContent: "You aren't in any chat rooms yet." }));

  const hist = $("#history");
  hist.replaceChildren(...history.map(s => el("li", {},
    el("span", { className: s.status === "accepted" ? "yes" : "no", textContent: s.status === "accepted" ? "✓ " : "✕ " }),
    `${KINDS[s.kind]}: ${s.accepted?.title || s.title}`,
    el("small", { textContent: ` · ${s.room_name}${s.reason ? ` · “${s.reason}”` : ""} · ${ago(s.decided_at)}` }))));
  if (!history.length) hist.append(el("li", { className: "empty", textContent: "Nothing yet." }));
  $("#history-card").hidden = !history.length;
}

async function load() {
  try { data = await api("GET", "state"); render(); showError(null); }
  catch (e) { showError(e); }
}

async function setRoom(r, body) {
  try { data = await api("PUT", `rooms/${encodeURIComponent(r.id)}`, body); render(); showError(null); }
  catch (e) { showError(e); render(); }
}

async function decide(s, yes, body) {
  try {
    const out = await api("POST", `suggestions/${s.id}/${yes ? "accept" : "reject"}`, body);
    data = yes ? out.state : out;
    editing = null;
    status(yes ? `Added “${out.item.title}” to ${out.item.collection_name}.` : `Turned down “${s.title}”.`);
    render();
    showError(null);
  } catch (e) { showError(e); }
}

async function sweepNow() {
  const button = $("#sweep");
  button.disabled = true;
  status("Reading your rooms…");
  try {
    const out = await api("POST", "sweep", { tz: TZ });
    data = out.state;
    const read = out.swept.reduce((n, r) => n + r.messages, 0);
    status(read ? `Read ${read} message${read === 1 ? "" : "s"}, ${out.added ? `${out.added} new suggestion${out.added === 1 ? "" : "s"}` : "nothing new to suggest"}.`
      + (out.more ? " There's more to read: sweep again." : "") : "Nothing new in your rooms since the last sweep.");
    render();
    showError(null);
  } catch (e) { status(""); showError(e); render(); }
}

$("#sweep").addEventListener("click", sweepNow);

// s sweeps, j/k move, a accepts, e edits, x turns down. The key after g is
// keys.js's (g s is Settings), so it's left alone.
let afterG = 0;
document.addEventListener("keydown", e => {
  const t = e.target;
  if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || t.matches?.("input, textarea, select") || !data) return;
  if (afterG && Date.now() - afterG < 1500) { afterG = 0; return; }
  afterG = e.key === "g" ? Date.now() : 0;
  const list = data.suggestions, s = list[at];
  if (e.key === "s" && !$("#sweep").disabled) sweepNow();
  else if ((e.key === "j" || e.key === "k") && list.length) { at = (at + (e.key === "j" ? 1 : list.length - 1)) % list.length; render(); document.querySelector(".sug.at")?.scrollIntoView({ block: "nearest" }); }
  else if (e.key === "a" && s && data.drift) decide(s, true, { collection: document.querySelector(".sug.at select")?.value || undefined });
  else if (e.key === "e" && s && data.drift) { editing = s.id; render(); }
  else if (e.key === "x" && s) decide(s, false, {});
  else return;
  e.preventDefault();
});

load();
