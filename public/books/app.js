// The public book suggestions page: the books and their votes come from
// /books/api (src/books.js). Anyone can vote, one vote per browser.
"use strict";

const COVERS = ["#5b2f2a", "#33493d", "#2f3b57", "#7a5a2b", "#4b3757"];
const $ = s => document.querySelector(s);
const nameBox = $("#name"), statusLine = $("#status"), list = $("#books");
let data = null, busy = false;

try { nameBox.value = localStorage.getItem("books-name") || ""; } catch {}

function say(text, bad = false) {
  statusLine.textContent = text;
  statusLine.classList.toggle("bad", bad);
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

function render() {
  const { books, total, mine } = data;
  const top = Math.max(1, ...books.map(b => b.votes));
  list.replaceChildren(...books.map((b, i) => {
    const chosen = b.id === mine;
    const bar = el("i");
    const card = el("article", { class: "book" + (chosen ? " mine" : ""), id: b.id },
      el("div", { class: "cover", style: `background:${COVERS[i % COVERS.length]}`, "aria-hidden": "true" },
        el("b", {}, b.title), el("span", {}, b.author)),
      el("div", { class: "meta" },
        el("h2", {}, b.title),
        b.series ? el("div", { class: "series" }, b.series) : null,
        el("div", { class: "by" }, `${b.author} · ${b.year}`),
        el("p", { class: "blurb" }, b.blurb),
        el("ul", { class: "links", "aria-label": `Where to get ${b.title}` },
          ...b.links.map(l => el("li", {}, el("a", { href: l.url, target: "_blank", rel: "noopener" }, l.label)))),
        el("div", { class: "vote" },
          el("button", { type: "button", "aria-pressed": String(chosen), onclick: () => vote(b.id) }, chosen ? "✓ Your vote" : "Vote for this"),
          el("div", { class: "tally" }, el("div", { class: "bar", "aria-hidden": "true" }, bar), `${b.votes} vote${b.votes === 1 ? "" : "s"}`),
          chosen ? el("button", { type: "button", class: "undo", onclick: unvote }, "Take back") : null)));
    requestAnimationFrame(() => { bar.style.width = `${Math.round(100 * b.votes / top)}%`; });
    return card;
  }));
  if (!busy) say(mine ? `Thanks! You voted for ${books.find(b => b.id === mine)?.title}. ${total} vote${total === 1 ? "" : "s"} so far.`
    : total ? `${total} vote${total === 1 ? "" : "s"} so far.` : "No votes yet. Be the first.");
}

async function call(method, path, body) {
  const res = await fetch(path, {
    method, credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Something went wrong (${res.status}).`);
  return out;
}

async function act(fn) {
  if (busy) return;
  busy = true;
  list.querySelectorAll(".vote button").forEach(b => { b.disabled = true; });
  try { data = await fn(); busy = false; render(); }
  catch (e) { busy = false; if (data) render(); say(e.message, true); }
}

let rename = null;
function vote(book) {
  clearTimeout(rename);
  return act(() => {
    const name = nameBox.value.trim();
    try { localStorage.setItem("books-name", name); } catch {}
    return call("POST", "/books/api/vote", { book, name });
  });
}
const unvote = () => act(() => call("DELETE", "/books/api/vote"));

// Changing the name after voting updates the vote's name too. It waits a
// moment, in case the change came from clicking another book's vote button.
nameBox.addEventListener("change", () => {
  clearTimeout(rename);
  rename = setTimeout(() => { if (data?.mine) vote(data.mine); }, 400);
});

call("GET", "/books/api").then(d => {
  data = d;
  if (!nameBox.value && d.name) nameBox.value = d.name;
  render();
}).catch(e => {
  list.replaceChildren(el("p", { class: "status bad" }, `Couldn't load the books: ${e.message}`));
});
