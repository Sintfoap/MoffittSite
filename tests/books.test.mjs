// Tests for the public book suggestions page's votes (src/books.js) and the
// admin view of who voted for what.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/worker.js";
import { Browser, makeEnv, ORIGIN, sqlOne, run, sql } from "./helpers.mjs";
import { BOOKS, deviceLabel } from "../src/books.js";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

// A visitor with no account: keeps the vote cookie the site gives it.
class Visitor {
  constructor(env, { ip = "198.51.100.7", ua = CHROME } = {}) { this.env = env; this.ip = ip; this.ua = ua; this.voter = null; }
  async req(method, path, { json, origin = method === "GET" ? null : ORIGIN, cf } = {}) {
    const h = new Headers({ "CF-Connecting-IP": this.ip, "User-Agent": this.ua });
    if (this.voter) h.set("Cookie", `__Host-bv=${this.voter}`);
    if (origin) h.set("Origin", origin);
    if (json !== undefined) h.set("Content-Type", "application/json");
    const request = new Request(ORIGIN + path, { method, headers: h, body: json === undefined ? undefined : JSON.stringify(json) });
    if (cf) Object.defineProperty(request, "cf", { value: cf });
    const res = await worker.fetch(request, this.env);
    const m = (res.headers.get("Set-Cookie") || "").match(/__Host-bv=([0-9a-f]{32})/);
    if (m) this.voter = m[1];
    return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
  }
  vote(book, name, o) { return this.req("POST", "/books/api/vote", { json: { book, name }, ...o }); }
}

async function admin(env) {
  const b = new Browser(env);
  await b.signup("ryan");
  const { id } = sqlOne(env, "SELECT id FROM users WHERE username = 'ryan'");
  run(env, "INSERT INTO user_areas (user_id, area) VALUES (?, 'admin')", id);
  run(env, "UPDATE users SET totp_secret = 'AAAAAAAAAAAAAAAA' WHERE id = ?", id);
  return b;
}

test("anyone can see the books without signing in", async () => {
  const env = makeEnv(), v = new Visitor(env);
  const r = await v.req("GET", "/books/api");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.books.map(b => b.title), ["Gods & Legionnaires", "The Book Thief", "The Phantom of the Opera", "The Socrates Express"]);
  for (const b of r.json.books) {
    assert.ok(b.blurb.length > 80, `${b.title} has a description`);
    assert.ok(b.links.length >= 3 && b.links.every(l => l.url.startsWith("https://")), `${b.title} has places to get it`);
    assert.equal(b.votes, 0);
  }
  assert.equal(r.json.mine, null);
  assert.equal(v.voter, null, "looking doesn't set a cookie");
});

test("a vote is one per browser, can be changed and taken back, and the tallies follow", async () => {
  const env = makeEnv(), kim = new Visitor(env), lee = new Visitor(env, { ip: "198.51.100.8" });
  let r = await kim.vote("the-book-thief", "Kim");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("Set-Cookie"), /^__Host-bv=[0-9a-f]{32}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
  assert.equal(r.json.mine, "the-book-thief");
  assert.equal(r.json.name, "Kim");
  await lee.vote("the-book-thief");
  r = await kim.vote("the-socrates-express", "Kim");
  assert.equal(r.headers.get("Set-Cookie"), null, "the same browser keeps its id");
  const count = id => r.json.books.find(b => b.id === id).votes;
  assert.equal(count("the-book-thief"), 1);
  assert.equal(count("the-socrates-express"), 1);
  assert.equal(r.json.total, 2);
  assert.equal(sql(env, "SELECT * FROM book_votes").length, 2);

  r = await kim.req("DELETE", "/books/api/vote");
  assert.equal(r.json.mine, null);
  assert.equal(r.json.total, 1);
  assert.equal((await kim.req("GET", "/books/api")).json.mine, null);
});

test("votes for books that aren't on the list, from other websites, or in bulk are refused", async () => {
  const env = makeEnv(), v = new Visitor(env);
  assert.equal((await v.vote("twilight")).status, 400);
  assert.equal((await v.vote("the-book-thief", "", { origin: "https://evil.example" })).status, 403);
  assert.equal((await v.req("PUT", "/books/api/vote", { json: {} })).status, 405);
  assert.equal((await v.req("GET", "/books/api/nope")).status, 404);
  // A made-up cookie value is ignored, not trusted.
  v.voter = "not-hex";
  assert.equal((await v.vote("the-book-thief")).status, 200);
  assert.match(v.voter, /^[0-9a-f]{32}$/);

  // Ten new voters from one address in a day, then no more; changing a vote still works.
  for (let i = 1; i < 10; i++) assert.equal((await new Visitor(env).vote("the-book-thief")).status, 200);
  assert.equal((await new Visitor(env).vote("the-book-thief")).status, 429);
  assert.equal((await v.vote("the-phantom-of-the-opera")).status, 200);
});

test("admins see who voted for what: name, account, address, device, place; and can remove a vote", async () => {
  const env = makeEnv(), ryan = await admin(env);
  const kim = new Visitor(env, { ip: "198.51.100.20" });
  await kim.vote("gods-and-legionnaires", "Kim <b>", { cf: { city: "Austin", region: "Texas", country: "US" } });
  const term = new Visitor(env, { ip: "198.51.100.21", ua: "sintfoap-cli/0.9.0 (kims-laptop)" });
  await term.vote("the-book-thief");
  // Signed in: the vote also records the account.
  const sid = ryan.cookie;
  await ryan.req("POST", "/books/api/vote", { json: { book: "the-book-thief" }, headers: { "User-Agent": CHROME } });
  ryan.cookie = sid;   // the helper reads any Set-Cookie as its session; this one was the vote's

  const list = (await ryan.get("/admin/api/books")).json;
  assert.equal(list.votes.length, 3);
  assert.equal(list.books.find(b => b.id === "the-book-thief").votes, 2);
  const k = list.votes.find(v => v.name === "Kim <b>");
  assert.equal(k.title, "Gods & Legionnaires");
  assert.equal(k.ip, "198.51.100.20");
  assert.equal(k.device, "Chrome on Windows");
  assert.equal(k.place, "Austin, Texas, US");
  assert.equal(list.votes.find(v => v.ip === "198.51.100.21").device, "sintfoap terminal on kims-laptop");
  assert.equal(list.votes.find(v => v.username === "ryan").book, "the-book-thief");

  const page = (await ryan.get("/admin")).text;
  assert.match(page, /<h2>Book votes<\/h2>/);
  assert.match(page, /Kim &lt;b&gt;/);
  assert.match(page, /Austin, Texas, US/);

  // Only admins.
  const josh = new Browser(env);
  await josh.signup("josh");
  assert.equal((await josh.get("/admin/api/books")).status, 403);
  assert.equal((await new Browser(env).get("/admin/api/books")).status, 401);

  const out = await ryan.req("POST", "/admin/api/books", { json: { voter: k.voter } });
  assert.equal(out.json.votes.length, 2);
  const r = await ryan.post("/admin/books/remove", { voter: term.voter });
  assert.match(r.text, /That book vote is removed\./);
  assert.equal(sql(env, "SELECT * FROM book_votes").length, 1);
});

test("the page is public and its votes run in the Worker", () => {
  const cfg = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(cfg, /"\/books\/api", "\/books\/api\/\*"/);
  assert.doesNotMatch(cfg, /"\/books", |"\/books\/\*"/, "the page itself is a static file anyone can open");
  const html = readFileSync(new URL("../public/books/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /site-rail|keys\.js/, "it stands apart from the signed-in site");
  assert.equal(new Set(BOOKS.map(b => b.id)).size, BOOKS.length);
  assert.equal(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"), "Safari on iPhone");
});
