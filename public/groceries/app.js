// Grocery autopilot: the order made from a Drift list and picked recipes, and
// sending it to Kroger or Instacart. The Worker side is src/groceries.js.

const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter(k => k != null));
  return n;
};
const money = n => n == null ? "" : `$${n.toFixed(2)}`;

let data = null;          // GET /groceries/api/state
let at = 0;               // the highlighted line, for the keys
const skip = new Set();   // lines left out of this order (by key)
const qty = {};           // how many of each line's product to put in the Kroger cart
let matches = {};         // POST kroger/match: {key: {match, choices, remembered}}
let searching = null;     // {key, q, choices}: picking another product for a line
let found = null;         // Kroger stores near a ZIP
let icLink = null;        // the last Instacart list made

async function api(method, path, body) {
  const res = await fetch("/groceries/api/" + path, {
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
const when = t => new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
// The product a line goes to Kroger as: one picked just now, else the one it had last time.
const productOf = l => matches[l.key] ? matches[l.key].match : l.match;
const sending = () => data.lines.filter(l => !skip.has(l.key));

async function run(fn) {
  try { await fn(); showError(null); } catch (e) { showError(e); }
  render();
}

// ── sources ────────────────────────────────────────────────────────────────

function renderSources() {
  const pick = $("#list");
  pick.replaceChildren(new Option("No list", ""), ...data.lists.map(c => new Option(c.owner_name ? `${c.name} (${c.owner_name})` : c.name, c.id)));
  pick.value = data.plan.list ?? "";
  $("#list-row").hidden = !data.drift;
  $("#nodrift").hidden = data.drift;
  $("#norecipes").hidden = data.recipes_on;
  const picked = new Map(data.plan.recipes.map(r => [r.id, r]));
  const list = $("#recipes");
  list.replaceChildren(...data.recipes.map(r => {
    const on = picked.has(r.id);
    const box = el("input", { type: "checkbox", checked: on, onchange: () => setRecipe(r, box.checked, null) });
    const serves = el("input", { type: "number", min: 1, max: 1000, step: 1, value: picked.get(r.id)?.servings ?? r.servings ?? "",
      placeholder: "serves", disabled: !on, "aria-label": `Servings of ${r.title}`, onchange: () => setRecipe(r, true, serves.value) });
    return el("li", {}, el("label", { className: "check" }, box, el("span", {}, r.title, r.yield ? el("small", { textContent: `Makes ${r.yield}` }) : null)), serves);
  }));
  if (data.recipes_on && !data.recipes.length) list.append(el("li", { className: "empty", textContent: "No recipes in your Recipe box yet." }));
}

function setRecipe(r, on, servings) {
  const recipes = data.plan.recipes.filter(x => x.id !== r.id);
  if (on) recipes.push({ id: r.id, servings: servings ? Number(servings) : null });
  run(async () => { data = await api("PUT", "plan", { recipes }); status(""); });
}

$("#list").addEventListener("change", e => run(async () => { data = await api("PUT", "plan", { list: e.target.value || null }); }));

// ── the order ──────────────────────────────────────────────────────────────

function productRow(l) {
  const p = productOf(l), m = matches[l.key];
  if (!data.kroger.store || (!p && !m)) return null;
  const row = el("div", { className: "product" }), add = (...kids) => row.append(...kids.filter(k => k != null));
  if (!p) add(el("span", { className: "none", textContent: "Nothing found at your Kroger store." }));
  else {
    if (p.image) add(el("img", { src: p.image, alt: "", loading: "lazy" }));
    add(el("span", {}, `${p.description}${p.size ? ` · ${p.size}` : ""}`),
      p.price ? el("span", { className: "price", textContent: money(p.price) }) : null,
      el("input", { type: "number", min: 1, max: 50, value: qty[l.key] ?? 1, "aria-label": `How many of ${p.description}`,
        onchange: e => { qty[l.key] = Math.max(1, Math.min(50, Math.round(Number(e.target.value) || 1))); } }),
      (m?.remembered || (!m && l.match)) ? el("small", { textContent: "your usual" }) : null);
  }
  add(el("button", { className: "btn quiet small", textContent: p ? "Change" : "Search", onclick: () => openSearch(l) }));
  return row;
}

function searchRow(l) {
  if (searching?.key !== l.key) return null;
  const q = el("input", { type: "search", value: searching.q, "aria-label": `Search Kroger for ${l.name}` });
  const go = () => run(async () => {
    searching.q = q.value;
    searching.choices = (await api("GET", `kroger/search?q=${encodeURIComponent(q.value)}`)).choices;
  });
  q.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); go(); } if (e.key === "Escape") { searching = null; render(); } });
  if (searching.focus) { searching.focus = false; setTimeout(() => q.focus()); }
  return el("div", { className: "search" },
    el("div", { className: "row" }, q, el("button", { className: "btn small", textContent: "Search", onclick: go }),
      el("button", { className: "btn quiet small", textContent: "Cancel", onclick: () => { searching = null; render(); } })),
    searching.choices ? el("ul", {}, ...(searching.choices.length ? searching.choices.map(c => el("li", {},
      c.image ? el("img", { src: c.image, alt: "", width: 28, height: 28 }) : null,
      el("span", {}, `${c.description}${c.size ? ` · ${c.size}` : ""} ${c.price ? money(c.price) : ""}`),
      el("button", { className: "btn small", textContent: "Use", onclick: () => choose(l, c) }))) : [el("li", { className: "empty", textContent: "Nothing found." })])) : null);
}

function openSearch(l) {
  searching = { key: l.key, q: l.name, focus: true, choices: matches[l.key]?.choices?.length ? matches[l.key].choices : null };
  render();
}

function choose(l, product) {
  run(async () => {
    await api("PUT", `matches/${encodeURIComponent(l.key)}`, product);
    matches[l.key] = { match: product, choices: matches[l.key]?.choices ?? [], remembered: true };
    searching = null;
    status(`${l.name} will be ${product.description} from now on.`);
  });
}

function line(l, i) {
  const off = skip.has(l.key);
  return el("li", { className: "line" + (i === at ? " at" : "") + (off ? " off" : "") },
    el("input", { type: "checkbox", checked: !off, "aria-label": `Send ${l.name}`, onchange: e => { e.target.checked ? skip.delete(l.key) : skip.add(l.key); at = i; render(); } }),
    el("div", { className: "what" }, l.amount ? el("span", { className: "amt", textContent: l.amount }) : null,
      el("span", { className: "name", textContent: l.name }), el("span", { className: "from", textContent: l.from.join(" · ") })),
    el("div", { className: "acts" },
      el("button", { className: "btn quiet small", textContent: "Always have", title: "Leave it out of every order", onclick: () => pantry(l.name, true) }),
      el("a", { href: l.walmart, target: "_blank", rel: "noopener noreferrer", textContent: "Walmart" })),
    off ? null : productRow(l),
    searchRow(l));
}

function renderLines() {
  const n = data.lines.length, sent = sending().length;
  $("#lines-title").textContent = n ? `The order (${sent === n ? n : `${sent} of ${n}`})` : "The order";
  at = Math.max(0, Math.min(at, n - 1));
  const list = $("#lines");
  list.replaceChildren(...data.lines.map(line));
  if (!n) list.append(el("li", { className: "empty", textContent: data.list || data.plan.recipes.length
    ? "Nothing to buy: everything's ticked off or in the cupboard." : "Pick a Drift list or some recipes above to make an order." }));
  $("#have-box").hidden = !data.have.length;
  $("#have").replaceChildren(...data.have.map(l => el("li", {}, l.name,
    el("button", { className: "btn quiet small", textContent: "Need it", onclick: () => pantry(l.name, false) }))));
}

function pantry(name, have) {
  run(async () => { data = await api("PUT", "pantry", { name, have }); status(have ? `${name} is left out from now on.` : `${name} is back on the order.`); });
}

// ── stores ─────────────────────────────────────────────────────────────────

function renderKroger() {
  const k = data.kroger, box = $("#kroger-body");
  if (!k.ready) { box.replaceChildren(el("p", { className: "empty", textContent: "Not set up on this site yet: the admin needs to add the KROGER_CLIENT_ID and KROGER_CLIENT_SECRET secrets (see the README)." })); return; }
  if (!k.connected) { box.replaceChildren(el("a", { className: "btn", href: "/groceries/kroger/connect", textContent: "Connect Kroger" })); return; }
  const zip = el("input", { type: "text", inputMode: "numeric", maxLength: 5, placeholder: "ZIP", "aria-label": "ZIP code", style: "width:90px" });
  const find = () => run(async () => { found = (await api("GET", `kroger/stores?zip=${encodeURIComponent(zip.value.trim())}`)).stores; });
  zip.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); find(); } });
  const how = el("select", { "aria-label": "Pickup or delivery", onchange: () => run(async () => { data = await api("PUT", "kroger/store", { modality: how.value }); }) },
    new Option("Pickup", "PICKUP"), new Option("Delivery", "DELIVERY"));
  how.value = k.modality;
  const ready = sending().filter(productOf).length;
  box.replaceChildren(...[
    k.store ? el("p", {}, "Your store: ", el("strong", { textContent: k.store.name }), el("br"), k.store.address) : el("p", { className: "empty", textContent: "Pick your store to match products there." }),
    el("div", { className: "row" }, zip, el("button", { className: "btn quiet small", textContent: k.store ? "Change store" : "Find stores", onclick: find }), k.store ? how : null),
    found ? el("ul", { className: "storelist" }, ...(found.length ? found.map(s => el("li", {},
      el("button", { className: "btn small", textContent: "Use", onclick: () => run(async () => { data = await api("PUT", "kroger/store", { id: s.id }); found = null; matches = {}; }) }),
      el("span", {}, el("strong", { textContent: s.name }), ` · ${s.address}`))) : [el("li", { className: "empty", textContent: "No Kroger stores near there." })])) : null,
    k.store ? el("br") : null,
    k.store ? el("button", { className: "btn quiet", id: "match", textContent: "Match products", onclick: matchAll }) : null,
    k.store ? el("button", { className: "btn", id: "send-kroger", textContent: ready ? `Send ${ready} to my cart` : "Send to my cart", disabled: !ready, onclick: sendKroger }) : null,
    el("button", { className: "btn danger small", textContent: "Disconnect", style: "margin-top:10px", onclick: () => {
      if (confirm("Disconnect your Kroger account? The products you've picked are kept.")) run(async () => { data = await api("DELETE", "kroger"); matches = {}; });
    } })].filter(Boolean));
}

function matchAll() {
  status("Finding each line at your Kroger store…");
  run(async () => {
    matches = (await api("POST", "kroger/match", {})).matches;
    const n = Object.values(matches).filter(m => m.match).length;
    status(`Matched ${n} of ${data.lines.length}. Change any that look wrong, then send.`);
  });
}

function sendKroger() {
  const lines = sending().filter(productOf).map(l => ({ key: l.key, product: productOf(l), quantity: qty[l.key] ?? 1 }));
  if (!lines.length) return;
  status("Sending to your Kroger cart…");
  run(async () => {
    const out = await api("POST", "kroger/cart", { lines, check_off: $("#check-off").checked });
    data = out.state;
    matches = {}; skip.clear();
    status(`Put ${out.added} thing${out.added === 1 ? "" : "s"} in your Kroger cart${out.checked ? `, and ticked ${out.checked} off in Drift` : ""}. Check out in Kroger's app.`);
  });
}

function renderInstacart() {
  const box = $("#instacart-body");
  if (!data.instacart.ready) { box.replaceChildren(el("p", { className: "empty", textContent: "Not set up on this site yet: the admin needs to add the INSTACART_API_KEY secret (see the README)." })); return; }
  box.replaceChildren(...[
    el("button", { className: "btn", id: "send-instacart", textContent: "Make an Instacart list", disabled: !sending().length, onclick: sendInstacart }),
    icLink ? el("a", { className: "btn quiet", href: icLink, target: "_blank", rel: "noopener noreferrer", textContent: "Open it" }) : null].filter(Boolean));
}

function sendInstacart() {
  status("Making your Instacart list…");
  run(async () => {
    const out = await api("POST", "instacart", { skip: [...skip], check_off: $("#check-off").checked });
    data = out.state;
    icLink = out.url;
    skip.clear();
    status(`Your Instacart list is ready${out.checked ? `, and ${out.checked} Drift item${out.checked === 1 ? " is" : "s are"} ticked off` : ""}.`);
    window.open(out.url, "_blank", "noopener");
  });
}

function renderOrders() {
  $("#orders-card").hidden = !data.orders.length;
  $("#orders").replaceChildren(...data.orders.map(o => el("li", {},
    el("strong", { textContent: o.store === "kroger" ? `Kroger${o.place ? `, ${o.place}` : ""}` : "Instacart" }),
    ` · ${o.lines.length} thing${o.lines.length === 1 ? "" : "s"}: ${o.lines.map(l => l.name).join(", ")}`,
    o.url ? el("span", {}, " · ", el("a", { href: o.url, target: "_blank", rel: "noopener noreferrer", textContent: "list" })) : null,
    el("small", { textContent: ` · ${when(o.created_at)}` }))));
}

function render() {
  if (!data) return;
  renderSources();
  renderLines();
  renderKroger();
  renderInstacart();
  renderOrders();
}

// Back from Kroger's sign-in.
{
  const said = new URLSearchParams(location.search).get("kroger");
  const SAID = { connected: ["good", "Kroger is connected. Pick your store next."], declined: ["warn", "Kroger wasn't connected: the sign-in was turned down."],
    expired: ["warn", "That Kroger sign-in took too long. Try connecting again."], failed: ["bad", "Kroger didn't finish connecting. Try again."],
    unready: ["warn", "Kroger isn't set up on this site yet."] };
  if (SAID[said]) {
    const box = $("#notice");
    box.className = `msg ${SAID[said][0]}`;
    box.textContent = SAID[said][1];
    box.hidden = false;
    history.replaceState(null, "", location.pathname);
  }
}

// j/k move, space leaves a line out, h says you always have it, m matches,
// c sends to Kroger, i makes an Instacart list. The key after g is keys.js's.
let afterG = 0;
document.addEventListener("keydown", e => {
  const t = e.target;
  if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || t.matches?.("input, textarea, select, button") || !data) return;
  if (afterG && Date.now() - afterG < 1500) { afterG = 0; return; }
  afterG = e.key === "g" ? Date.now() : 0;
  const lines = data.lines, l = lines[at];
  if ((e.key === "j" || e.key === "k") && lines.length) { at = (at + (e.key === "j" ? 1 : lines.length - 1)) % lines.length; render(); document.querySelector(".line.at")?.scrollIntoView({ block: "nearest" }); }
  else if (e.key === " " && l) { skip.has(l.key) ? skip.delete(l.key) : skip.add(l.key); render(); }
  else if (e.key === "h" && l) pantry(l.name, true);
  else if (e.key === "m" && $("#match")) matchAll();
  else if (e.key === "c" && $("#send-kroger") && !$("#send-kroger").disabled) sendKroger();
  else if (e.key === "i" && $("#send-instacart") && !$("#send-instacart").disabled) sendInstacart();
  else return;
  e.preventDefault();
});

run(async () => { data = await api("GET", "state"); });
