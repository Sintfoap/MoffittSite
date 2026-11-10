// Food club: every month's pick down the side (coming up, this month, before),
// the open one beside it with its recipe, who made it and loved it, and
// everyone's photos. The Worker side is src/food.js.

const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter(k => k != null));
  return n;
};

let club = null;          // GET /food/api/club: {picks, you, kinds, recipe_box, recipes}
let open = null;          // the open pick's id
let pick = null;          // the open pick, in full
let shown = [];           // the ids in the list, as filtered
let filter = "all";
let editing = null;       // the pick in the editor, or {} for a new one

const MAX_SIDE = 1600, MAX_BYTES = 1100 * 1024;
const KIND = { meal: "Meal", side: "Side", dessert: "Dessert", baking: "Baking", snack: "Snack", drink: "Drink" };

async function api(method, path, body) {
  const res = await fetch("/food/api/" + path, {
    method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname); throw new Error("not signed in"); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(out.error || `the site answered ${res.status}`), { manual: out.manual });
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

// Months as this browser sees them.
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const monthName = (m, long = true) => new Date(+m.slice(0, 4), +m.slice(5) - 1, 1)
  .toLocaleDateString(undefined, long ? { month: "long", year: "numeric" } : { month: "short", year: "numeric" });
function nextFree() {
  const taken = new Set(club.picks.map(p => p.month));
  let [y, m] = thisMonth().split("-").map(Number);
  for (let i = 0; i < 36; i++) {
    const s = `${y}-${String(m).padStart(2, "0")}`;
    if (!taken.has(s)) return s;
    if (++m > 12) { m = 1; y++; }
  }
  return thisMonth();
}
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const names = list => list.length <= 2 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;

// ── the list of months ─────────────────────────────────────────────────────

function renderHeadline() {
  const now = club.picks.find(p => p.month === thisMonth());
  const month = new Date().toLocaleDateString(undefined, { month: "long" });
  $("#headline").textContent = now ? `${month}: ${now.title}` : `Nobody's picked ${month} yet`;
}

function renderList() {
  const now = thisMonth();
  const match = club.picks.filter(p => filter === "all" || (filter === "favorites" ? p.mine.favorite : p.mine.made));
  const groups = [
    ["Coming up", match.filter(p => p.month > now).reverse()],
    ["This month", match.filter(p => p.month === now)],
    ["Before", match.filter(p => p.month < now)],
  ];
  shown = groups.flatMap(([, list]) => list.map(p => p.id));
  const ul = $("#months");
  ul.replaceChildren();
  if (!club.picks.length) ul.append(el("li", { className: "empty", style: "padding:10px", textContent: "No picks yet. Be the first: pick a month." }));
  else if (!match.length) ul.append(el("li", { className: "empty", style: "padding:10px", textContent: filter === "favorites" ? "No favorites yet. Press ★ on a food you loved." : "Nothing you've made yet." }));
  for (const [name, list] of groups) {
    if (!list.length) continue;
    ul.append(el("li", { className: "group", textContent: name }));
    for (const p of list) {
      const thumb = p.cover ? el("img", { className: "thumb", src: `/food/api/photos/${p.cover}`, alt: "", loading: "lazy" }) : el("span", { className: "thumb", textContent: "◇" });
      const bits = [monthName(p.month, false), p.by, p.made ? `${p.made} made` : "", p.photos ? `${p.photos} photo${p.photos === 1 ? "" : "s"}` : ""].filter(Boolean);
      const b = el("button", { type: "button" }, thumb,
        el("span", {}, el("b", {}, p.mine.favorite ? el("span", { className: "star", textContent: "★ " }) : null, p.title), el("small", { textContent: bits.join(" · ") })));
      b.setAttribute("aria-current", String(p.id === open));
      b.addEventListener("click", () => openPick(p.id));
      ul.append(el("li", {}, b));
    }
  }
}

async function openPick(id) {
  open = id;
  history.replaceState(null, "", id ? "#" + id : location.pathname);
  renderList();
  if (!id) { pick = null; renderDetail(); return; }
  await run(async () => { pick = await api("GET", "picks/" + id); renderDetail(); });
}

// After a change: the pick as the site sends it back, and its line in the list.
async function refresh(p) {
  pick = p;
  club = await api("GET", "club");
  renderHeadline();
  renderList();
  renderDetail();
}

// ── the open pick ──────────────────────────────────────────────────────────

function renderDetail() {
  const box = $("#detail");
  box.replaceChildren();
  const p = pick;
  if (!p) {
    box.append(el("p", { className: "empty", textContent: club.picks.length ? "Pick a month from the list." : "Each month's food will show up here." }));
    return;
  }
  const card = el("article", { className: "card pick" });
  const now = thisMonth();
  card.append(el("div", { className: "when", textContent: [monthName(p.month), KIND[p.kind] || p.kind, p.month === now ? "this month" : p.month > now ? "coming up" : ""].filter(Boolean).join(" · ") }));
  card.append(el("h2", { textContent: p.title }));
  card.append(el("div", { className: "by", textContent: `Picked by ${p.yours ? "you" : p.by}` }));
  if (p.recipe?.image) {
    const img = el("img", { className: "hero", src: p.recipe.image, alt: "", referrerPolicy: "no-referrer", loading: "lazy" });
    img.addEventListener("error", () => img.remove());
    card.append(img);
  }
  if (p.blurb) card.append(el("p", { className: "blurb", textContent: p.blurb }));

  const made = el("button", { className: "btn " + (p.mine.made ? "on" : "quiet"), type: "button", id: "made", textContent: p.mine.made ? "✓ Made it" : "I made it" });
  made.setAttribute("aria-pressed", String(p.mine.made));
  made.addEventListener("click", () => run(async () => refresh(await api("PUT", `picks/${p.id}/mine`, { made: !p.mine.made }))));
  const fav = el("button", { className: "btn " + (p.mine.favorite ? "on" : "quiet"), type: "button", id: "fav", textContent: p.mine.favorite ? "★ Favorite" : "☆ Favorite" });
  fav.setAttribute("aria-pressed", String(p.mine.favorite));
  fav.addEventListener("click", () => run(async () => refresh(await api("PUT", `picks/${p.id}/mine`, { favorite: !p.mine.favorite }))));
  const photo = el("button", { className: "btn quiet", type: "button", id: "add-photo", textContent: "Add a photo" });
  photo.addEventListener("click", openUploader);
  card.append(el("div", { className: "mine" }, made, fav, photo));
  const who = el("div", { className: "who" });
  who.append(p.made_by.length ? el("span", {}, "Made by ", el("b", { textContent: names(p.made_by) })) : el("span", { className: "empty", textContent: "Nobody's made it yet." }));
  if (p.favorite_of.length) who.append(" · ", el("span", { className: "star", textContent: "★ " }), "a favorite of ", el("b", { textContent: names(p.favorite_of) }));
  card.append(who);

  card.append(el("h3", { textContent: `Photos${p.photos.length ? ` (${p.photos.length})` : ""}` }));
  if (!p.photos.length) card.append(el("p", { className: "empty", textContent: "No photos yet. Made it? Show us how it turned out." }));
  else {
    const grid = el("div", { className: "photos" });
    for (const ph of p.photos) {
      const src = `/food/api/photos/${ph.id}`;
      const view = el("button", { type: "button", className: "view" }, el("img", { src, alt: ph.caption || `${ph.by}'s ${p.title}`, loading: "lazy" }));
      view.addEventListener("click", () => { $("#big").src = src; $("#big-caption").textContent = [ph.by, ph.caption].filter(Boolean).join(": "); $("#viewer").showModal(); });
      const cap = el("figcaption", {}, el("b", { textContent: ph.yours ? "You" : ph.by }), ph.caption ? ` · ${ph.caption}` : "");
      if (ph.can_remove) {
        const x = el("button", { type: "button", textContent: "remove", title: "Take this photo off" });
        x.addEventListener("click", () => confirm("Take this photo off?") && run(async () => refresh(await api("DELETE", `picks/${p.id}/photos/${ph.id}`))));
        cap.prepend(x);
      }
      grid.append(el("figure", {}, view, cap));
    }
    card.append(grid);
  }

  const r = p.recipe;
  card.append(el("h3", { textContent: "Recipe" }));
  if (!r) card.append(el("p", { className: "empty", textContent: p.can_edit ? "No recipe yet. Edit the pick to add one." : `No recipe yet. Ask ${p.by} for it.` }));
  else {
    const facts = el("div", { className: "facts" });
    const bits = [r.time, r.servings ? `serves ${r.servings}` : "", r.yield && !/^\d+(\.\d+)?$/.test(r.yield) ? r.yield : ""].filter(Boolean);
    facts.append(bits.join(" · "));
    if (r.source) {
      if (bits.length) facts.append(" · ");
      facts.append(el("a", { href: r.source, textContent: hostOf(r.source) || "source", target: "_blank", rel: "noopener noreferrer" }));
    }
    card.append(facts);
    if (r.ingredients.length) card.append(el("ul", { className: "ingredients" }, ...r.ingredients.map(i => el("li", { textContent: i }))));
    if (r.steps.length) card.append(el("h3", { textContent: "Steps" }), el("ol", { className: "steps" }, ...r.steps.map(s => el("li", { textContent: s }))));
    if (r.notes) card.append(el("h3", { textContent: "Notes" }), el("p", { className: "notes", textContent: r.notes }));
  }

  const actions = el("div", { className: "actions" });
  if (r && club.recipe_box) {
    const save = el("button", { className: "btn quiet", type: "button", textContent: "Save to my Recipe box" });
    save.addEventListener("click", () => run(async () => {
      const out = await api("POST", `picks/${p.id}/save`);
      say("done", `Saved ${out.recipe.title} to your Recipe box.`);
    }));
    actions.append(save);
  }
  if (p.can_edit) {
    const edit = el("button", { className: "btn quiet", type: "button", textContent: "Edit" });
    edit.addEventListener("click", () => openEditor(p));
    const del = el("button", { className: "btn danger", type: "button", textContent: "Delete" });
    del.addEventListener("click", () => {
      if (!confirm(`Delete ${monthName(p.month)}'s pick, ${p.title}, with its photos?`)) return;
      run(async () => {
        await api("DELETE", "picks/" + p.id);
        club = await api("GET", "club");
        renderHeadline();
        openPick(club.picks[0]?.id || null);
      });
    });
    actions.append(edit, del);
  }
  if (actions.children.length) card.append(actions);
  box.append(card);
}

// ── picking and editing ────────────────────────────────────────────────────

function setMode(mode) {
  const f = $("#edit-form");
  f.querySelector(`input[name=mode][value=${mode}]`).checked = true;
  for (const d of f.querySelectorAll("[data-mode]")) d.hidden = d.dataset.mode !== mode;
}

function openEditor(p) {
  editing = p || {};
  const f = $("#edit-form"), r = p?.recipe;
  $("#edit-title").textContent = p ? `Edit ${monthName(p.month)}'s pick` : "Pick a month";
  f.kind.replaceChildren(...club.kinds.map(k => new Option(KIND[k] || k, k)));
  f.month.value = p?.month || nextFree();
  f.kind.value = p?.kind || "meal";
  f.title.value = p?.title || "";
  f.title.required = !!p;
  f.blurb.value = p?.blurb || "";
  f.url.value = "";
  f.recipe_id.replaceChildren(...club.recipes.map(x => new Option(x.title, x.id)));
  $("#mode-box").hidden = !club.recipe_box || !club.recipes.length;
  $("#mode-keep").hidden = !r;
  f.servings.value = r?.servings ?? "";
  f.yield.value = r?.yield || "";
  f.time.value = r?.time || "";
  f.ingredients.value = (r?.ingredients || []).join("\n");
  f.steps.value = (r?.steps || []).join("\n");
  f.notes.value = r?.notes || "";
  f.source.value = r?.source || "";
  setMode(r ? "keep" : "url");
  $("#editor").showModal();
  (p ? f.title : f.month).focus();
}
$("#modes").addEventListener("change", e => e.target.name === "mode" && setMode(e.target.value));

$("#edit-form").addEventListener("submit", e => {
  const f = $("#edit-form");
  if (e.submitter?.value !== "save") return;
  const mode = f.querySelector("input[name=mode]:checked").value;
  if (mode === "url" && !f.url.value.trim() && !f.title.value.trim()) { e.preventDefault(); f.title.setCustomValidity("Say what the food is, or give a recipe link."); f.reportValidity(); }
  else f.title.setCustomValidity("");
});
$("#edit-form").title.addEventListener("input", e => e.target.setCustomValidity(""));

$("#editor").addEventListener("close", () => {
  if ($("#editor").returnValue !== "save" || !editing) return;
  const f = $("#edit-form"), was = editing, mode = f.querySelector("input[name=mode]:checked").value;
  editing = null;
  const body = { month: f.month.value.trim(), kind: f.kind.value, blurb: f.blurb.value };
  if (f.title.value.trim() || was.id) body.title = f.title.value;
  if (mode === "url" && f.url.value.trim()) body.url = f.url.value.trim();
  if (mode === "box") body.recipe_id = f.recipe_id.value;
  if (mode === "none") body.recipe = null;
  if (mode === "type") body.recipe = { servings: f.servings.value === "" ? null : Number(f.servings.value), yield: f.yield.value, time: f.time.value,
    ingredients: f.ingredients.value, steps: f.steps.value, notes: f.notes.value, source: f.source.value };
  run(async () => {
    say("done", body.url ? "Reading the recipe…" : "");
    const saved = was.id ? await api("PATCH", "picks/" + was.id, body) : await api("POST", "picks", body);
    say("done", was.id ? "Saved." : `${monthName(saved.month)} is ${saved.title}.`);
    open = saved.id;
    history.replaceState(null, "", "#" + saved.id);
    await refresh(saved);
  }).then(err => {
    // No recipe on that page: open the editor again to type it in.
    if (!err?.manual) return;
    openEditor(was.id ? pick : null);
    const g = $("#edit-form");
    g.month.value = body.month;
    g.kind.value = body.kind;
    g.title.value = body.title || "";
    g.blurb.value = body.blurb;
    g.source.value = body.url;
    setMode("type");
  });
});
$("#new").addEventListener("click", () => openEditor(null));

// ── photos ─────────────────────────────────────────────────────────────────

function openUploader() {
  if (!pick) return;
  const f = $("#photo-form");
  f.reset();
  $("#preview").hidden = true;
  $("#upload").disabled = false;
  $("#uploader").showModal();
}

$("#photo-form").file.addEventListener("change", e => {
  const file = e.target.files[0];
  const img = $("#preview");
  if (img.src) URL.revokeObjectURL(img.src);
  img.hidden = !file;
  if (file) img.src = URL.createObjectURL(file);
});

// A phone's photo, made small enough to keep: at most MAX_SIDE across, as a JPEG.
async function shrink(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  if (!bmp) throw new Error("that file isn't a picture this browser can read");
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

$("#photo-form").addEventListener("submit", async e => {
  if (e.submitter?.value !== "save") return;
  e.preventDefault();
  const f = $("#photo-form"), file = f.file.files[0];
  if (!file || !pick) return;
  $("#upload").disabled = true;
  $("#upload").textContent = "Adding…";
  const err = await run(async () => {
    const data = await base64(await shrink(file));
    await refresh(await api("POST", `picks/${pick.id}/photos`, { data, caption: f.caption.value }));
    say("done", "Photo added.");
  });
  $("#upload").textContent = "Add photo";
  $("#upload").disabled = false;
  if (!err) $("#uploader").close();
});

// ── keys, and starting ─────────────────────────────────────────────────────

for (const b of document.querySelectorAll("[data-filter]")) {
  b.addEventListener("click", () => {
    filter = b.dataset.filter;
    for (const x of document.querySelectorAll("[data-filter]")) x.setAttribute("aria-pressed", String(x === b));
    renderList();
  });
}

document.addEventListener("keydown", e => {
  const t = e.target;
  if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || t.matches?.("input, textarea, select") || document.querySelector("dialog[open]")) return;
  const at = shown.indexOf(open);
  const keys = {
    n: () => openEditor(null),
    j: () => shown.length && openPick(shown[Math.min(shown.length - 1, at + 1)]),
    k: () => shown.length && openPick(shown[Math.max(0, at - 1)]),
    m: () => $("#made")?.click(),
    f: () => $("#fav")?.click(),
    p: () => $("#add-photo")?.click(),
    e: () => pick?.can_edit && openEditor(pick),
  };
  if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
});

run(async () => {
  club = await api("GET", "club");
  renderHeadline();
  const want = location.hash.slice(1);
  const now = club.picks.find(p => p.month === thisMonth());
  // Open what the link asks for, else this month's pick, else the next one coming up, else the latest.
  const first = club.picks.find(p => p.id === want) || now || [...club.picks].reverse().find(p => p.month > thisMonth()) || club.picks[0];
  await openPick(first?.id || null);
});
