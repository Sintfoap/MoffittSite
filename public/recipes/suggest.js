// Suggest labels: Recipe box looks through every recipe for labels from the
// Recipe labels list that its words point to (Season: Fall for "pumpkin"),
// and shows them, grouped by label, to untick any that don't fit before
// they're added. No AI: the matching is plain keywords, on the Worker
// (src/autolabel.js), the same for the terminal UI.
//
// Self-contained so its button can live anywhere: give any button
// data-suggest-labels (or call openSuggestions) and this makes its own dialog.

const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter(k => k != null && k !== false));
  return n;
};
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const labelText = l => l.value ? `${l.key}: ${l.value}` : l.key;
export const BATCH = 200;   // recipes per add-labels request (ADD_BATCH in src/recipes.js)

// [{id, title, labels: [...]}] per recipe → [{label, recipes: [{id, title, word, where}]}] per label, in the list's order.
export function byLabel(suggestions) {
  const groups = new Map();
  for (const s of suggestions) for (const l of s.labels) {
    if (!groups.has(l.id)) groups.set(l.id, { label: { id: l.id, key: l.key, value: l.value }, recipes: [] });
    groups.get(l.id).recipes.push({ id: s.id, title: s.title, word: l.word, where: l.where });
  }
  return [...groups.values()].sort((a, b) => labelText(a.label).localeCompare(labelText(b.label), undefined, { sensitivity: "base" }));
}

// The ticked boxes as {add: [{id, labels}]}, one entry per recipe.
export function picked(boxes) {
  const per = new Map();
  for (const b of boxes) if (b.checked) per.set(b.dataset.recipe, [...(per.get(b.dataset.recipe) || []), b.dataset.label]);
  return [...per].map(([id, labels]) => ({ id, labels }));
}

let dialog = null;
function make() {
  dialog = el("dialog", { id: "suggester", className: "suggester" });
  dialog.append(el("form", { method: "dialog" },
    el("h2", { textContent: "Suggested labels" }),
    el("p", { className: "sg-lede" }),
    el("div", { className: "sg-tools", hidden: true },
      el("button", { type: "button", className: "btn quiet", value: "all", textContent: "Tick all" }),
      el("button", { type: "button", className: "btn quiet", value: "none", textContent: "Untick all" })),
    el("div", { className: "sg-groups" }),
    el("div", { className: "row" },
      el("button", { className: "btn", value: "add", textContent: "Add labels" }),
      el("button", { className: "btn quiet", value: "cancel", formNoValidate: true, textContent: "Cancel" }))));
  document.body.append(dialog);
  const boxes = () => [...dialog.querySelectorAll(".sg-groups input[data-recipe]")];
  const count = () => {
    const n = boxes().filter(b => b.checked).length;
    const add = dialog.querySelector('button[value="add"]');
    add.textContent = n ? `Add ${plural(n, "label")}` : "Add labels";
    add.disabled = !n;
    for (const g of dialog.querySelectorAll(".sg-group")) {
      const mine = [...g.querySelectorAll("input[data-recipe]")], on = mine.filter(b => b.checked).length;
      const all = g.querySelector("input.sg-all");
      all.checked = on === mine.length;
      all.indeterminate = on > 0 && on < mine.length;
      g.querySelector(".sg-n").textContent = on === mine.length ? plural(mine.length, "recipe") : `${on} of ${mine.length}`;
    }
  };
  dialog.addEventListener("change", e => {
    if (e.target.matches("input.sg-all")) for (const b of e.target.closest(".sg-group").querySelectorAll("input[data-recipe]")) b.checked = e.target.checked;
    count();
  });
  dialog.querySelector(".sg-tools").addEventListener("click", e => {
    const v = e.target.closest("button")?.value;
    if (!v) return;
    for (const b of boxes()) b.checked = v === "all";
    count();
  });
  dialog.count = count;
  dialog.boxes = boxes;
}

// api(method, path, body) is Recipe box's; say(kind, text) its message line;
// done() is called once labels are added, to load the box again.
export async function openSuggestions({ api, say, done }) {
  if (!dialog) make();
  const lede = dialog.querySelector(".sg-lede"), groups = dialog.querySelector(".sg-groups");
  const add = dialog.querySelector('button[value="add"]');
  lede.textContent = "Looking through your recipes…";
  groups.replaceChildren();
  dialog.querySelector(".sg-tools").hidden = true;
  add.hidden = true;
  dialog.returnValue = "";
  dialog.showModal();
  let out;
  try { out = await api("GET", "recipes/suggest-labels"); }
  catch (e) { dialog.close(); throw e; }
  const list = byLabel(out.suggestions);
  if (!out.labels) {
    lede.textContent = "There are no labels to suggest yet. Whoever keeps Recipe labels adds them there, like Season: Fall.";
    return;
  }
  if (!list.length) {
    lede.textContent = `Checked ${plural(out.checked, "recipe")} against ${plural(out.labels, "label")}: nothing new to suggest. ` +
      "A label is matched by its name (Irish, for Cuisine: Irish) and by keywords set on it in Recipe labels (pumpkin, for Season: Fall).";
    return;
  }
  const total = list.reduce((n, g) => n + g.recipes.length, 0);
  lede.textContent = `Checked ${plural(out.checked, "recipe")} against ${plural(out.labels, "label")}: ${plural(total, "suggestion")} for ` +
    `${plural(out.suggestions.length, "recipe")}, from each label's name and the keywords set on it in Recipe labels. Untick any that don't fit.`;
  groups.replaceChildren(...list.map(g => el("details", { className: "sg-group", open: list.length <= 6 },
    el("summary", {},
      el("input", { type: "checkbox", className: "sg-all", checked: true, ariaLabel: `All of ${labelText(g.label)}`, onclick: e => e.stopPropagation() }),
      el("b", { textContent: g.label.key }), g.label.value ? ` ${g.label.value}` : "", el("span", { className: "sg-n" })),
    el("ul", {}, ...g.recipes.map(r => {
      const box = el("input", { type: "checkbox", checked: true });
      Object.assign(box.dataset, { recipe: r.id, label: g.label.id });
      return el("li", {}, el("label", {}, box, el("span", { textContent: r.title }), el("small", { textContent: `${r.word} in ${r.where}` })));
    })))));
  dialog.querySelector(".sg-tools").hidden = false;
  add.hidden = false;
  dialog.count();
  const choice = await new Promise(res => dialog.addEventListener("close", () => res(dialog.returnValue), { once: true }));
  if (choice !== "add") return;
  const want = picked(dialog.boxes());
  let recipes = 0, labels = 0, full = 0;
  for (let i = 0; i < want.length; i += BATCH) {
    if (want.length > BATCH) say("done", `Adding labels: ${i} of ${want.length} recipes…`);
    const r = await api("POST", "recipes/add-labels", { add: want.slice(i, i + BATCH) });
    recipes += r.recipes; labels += r.labels; full += r.full;
  }
  await done();
  say("done", `Added ${plural(labels, "label")} to ${plural(recipes, "recipe")}.` + (full ? ` ${plural(full, "recipe")} already had 20 labels, the most one can have, so got only some.` : ""));
}
