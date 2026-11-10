// Recipe labels: the site's one list of labels, one card per key with its
// values. Add many values at once ("Fall, Winter"), more under a key that's
// already there, rename or remove one value, or a whole key. The Worker side
// is src/labels.js.

const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter(k => k != null && k !== false));
  return n;
};

let data = null;   // GET /labels/api/labels: {labels, keys, limits}

async function api(method, path, body) {
  const res = await fetch("/labels/api/" + path, {
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
  try { await fn(); } catch (e) { say("error", cap(e.message || String(e))); }
}
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const used = x => [x.recipes && plural(x.recipes, "recipe"), x.posts && plural(x.posts, "board post")].filter(Boolean).join(", ");
const low = s => String(s || "").toLowerCase();

// "Season: Fall, Winter" in the key box, or a key and its values in their own boxes.
export function parseAdd(key, values) {
  const at = key.indexOf(":");
  if (at >= 0) return { key: key.slice(0, at).trim(), values: [key.slice(at + 1), values].filter(s => s.trim()).join(", ") };
  return { key: key.trim(), values };
}

async function add(key, values) {
  const out = await api("POST", "labels", { key, values });
  const n = out.added.length;
  const skipped = out.skipped.length ? ` Skipped ${out.skipped.map(s => s.value || s.key).join(", ")} (already on the list).` : "";
  say("done", n ? `Added ${out.added.map(l => l.value || l.key).join(", ")} under ${out.added[0].key}.${skipped}` : `Nothing new to add.${skipped}`);
  await load();
}

function render() {
  $("#key-list").replaceChildren(...data.keys.map(k => el("option", { value: k.key })));
  const box = $("#keys");
  if (!data.keys.length) { box.replaceChildren(el("p", { className: "empty", textContent: "No labels yet. Add the first key above, like Season with Fall, Winter, Spring, Summer." })); return; }
  box.replaceChildren(...data.keys.map(k => {
    const values = data.labels.filter(l => low(l.key) === low(k.key));
    const renameKey = el("button", { type: "button", className: "btn quiet", textContent: "Rename" });
    renameKey.addEventListener("click", () => {
      const to = prompt(`Rename ${k.key} to (every value under it moves with it):`, k.key);
      if (to && to.trim() && to.trim() !== k.key) run(async () => { await api("PATCH", `keys/${encodeURIComponent(k.key)}`, { key: to }); say("done", `Renamed ${k.key} to ${to.trim()}.`); await load(); });
    });
    const removeKey = el("button", { type: "button", className: "btn danger", textContent: "Remove" });
    removeKey.addEventListener("click", () => {
      const u = used(k);
      if (!confirm(`Remove ${k.key} and its ${plural(k.values, "value")}?${u ? ` They come off ${u}.` : ""} It's no longer a category on the Recipe board.`)) return;
      run(async () => { await api("DELETE", `keys/${encodeURIComponent(k.key)}`); say("done", `Removed ${k.key}.`); await load(); });
    });
    const list = el("ul", { className: "values" }, ...values.map(l => {
      const ren = el("button", { type: "button", textContent: "✎", title: `Rename ${l.value || l.key}`, ariaLabel: `Rename ${l.key}: ${l.value}` });
      ren.addEventListener("click", () => {
        const to = prompt(`Rename ${l.key}: ${l.value || "(no value)"} to:`, l.value);
        if (to !== null && to.trim() !== l.value) run(async () => { await api("PATCH", `labels/${l.id}`, { value: to }); await load(); });
      });
      const x = el("button", { type: "button", className: "x", textContent: "×", title: `Remove ${l.value || l.key}`, ariaLabel: `Remove ${l.key}: ${l.value}` });
      x.addEventListener("click", () => {
        const u = used(l);
        if (!confirm(`Remove ${l.value ? `${l.key}: ${l.value}` : l.key}?${u ? ` It comes off ${u}.` : ""}`)) return;
        run(async () => { await api("DELETE", `labels/${l.id}`); await load(); });
      });
      return el("li", {}, el("span", {}, l.value || el("i", { className: "empty", textContent: "no value" }), el("small", { textContent: l.recipes || "", title: used(l) || "not used yet" })), ren, x);
    }));
    const more = el("form", { className: "more-values" },
      el("input", { type: "text", name: "values", maxLength: 2000, placeholder: `More under ${k.key}, separated by commas`, ariaLabel: `More values under ${k.key}`, required: true }),
      el("button", { className: "btn quiet", textContent: "Add" }));
    more.addEventListener("submit", e => { e.preventDefault(); run(() => add(k.key, more.values.value)); });
    return el("section", { className: "card key" },
      el("div", { className: "head" }, el("h2", { textContent: k.key }),
        el("span", { className: "count", textContent: [plural(k.values, "value"), used(k)].filter(Boolean).join(" · ") }),
        el("span", { className: "tools" }, renameKey, removeKey)),
      list, more);
  }));
}

async function load() {
  data = await api("GET", "labels");
  render();
}

$("#add").addEventListener("submit", e => {
  e.preventDefault();
  const f = e.target, { key, values } = parseAdd(f.key.value, f.values.value);
  const btn = $("#add-btn");
  btn.disabled = true;
  run(async () => { await add(key, values); f.reset(); f.key.focus(); }).finally(() => { btn.disabled = false; });
});

document.addEventListener("keydown", e => {
  const t = e.target;
  if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || t.matches?.("input, textarea, select")) return;
  if (e.key === "n") { e.preventDefault(); $("#add").key.focus(); }
});

run(load);
