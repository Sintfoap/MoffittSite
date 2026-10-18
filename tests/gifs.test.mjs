// Tests for chat's GIF picker: search, trending, categories and favorites,
// against a stand-in for KLIPY's Tenor-compatible API.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps } from "./helpers.mjs";

const gif = (id, w = 200, h = 100) => ({
  id, content_description: `gif ${id}`,
  media_formats: {
    gif: { url: `https://static.klipy.com/ii/${id}.gif`, dims: [w, h] },
    tinygif: { url: `https://static.klipy.com/ii/${id}-tiny.gif`, dims: [w / 2, h / 2] },
  },
});

let asked, realFetch, status;
beforeEach(() => {
  asked = []; status = 200; realFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    asked.push(url);
    if (status !== 200) return new Response("no", { status });
    if (url.hostname !== "api.klipy.com") return new Response("not found", { status: 404 });
    const p = url.pathname;
    if (p === "/v2/search") return Response.json({ results: [gif("cat1"), gif("cat2", 100, 300),
      // Anything not on the GIF hosts is dropped.
      { id: "bad", media_formats: { gif: { url: "https://evil.example/x.gif", dims: [1, 1] } } }], next: "30" });
    if (p === "/v2/featured") return Response.json({ results: [gif("hot")], next: "" });
    if (p === "/v2/categories") return Response.json({ tags: [
      { searchterm: "happy", name: "#happy", image: "https://static.klipy.com/ii/happy.gif" },
      { searchterm: "sad", name: "#sad", image: "https://evil.example/sad.gif" },
    ] });
    return new Response("not found", { status: 404 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function signedIn(env, name) {
  const b = new Browser(env);
  assert.equal((await b.signup(name)).status, 303);
  grantApps(env, name, "chat");
  return b;
}
const api = (b, method, path, json) => b.req(method, "/chat/api" + path, json === undefined ? {} : { json });

test("without the key the picker is off, and says why", async () => {
  const env = makeEnv();
  const b = await signedIn(env, "josh");
  const s = (await api(b, "GET", "/state")).json;
  assert.equal(s.gifs.ready, false);
  const r = await api(b, "GET", "/gifs?q=cat");
  assert.equal(r.status, 503);
  assert.match(r.json.error, /GIF_API_KEY/);
  assert.equal(asked.length, 0);
});

test("search, trending and categories come from KLIPY, keeping the key on the server", async () => {
  const env = makeEnv({ GIF_API_KEY: "sekret" });
  const b = await signedIn(env, "josh");
  const s = (await api(b, "GET", "/state")).json;
  assert.deepEqual([s.gifs.ready, s.gifs.provider], [true, "KLIPY"]);
  assert.ok(s.gifs.hosts.includes("klipy.com"));

  const found = await api(b, "GET", "/gifs?q=%20cat%20&pos=10");
  assert.equal(found.status, 200);
  assert.deepEqual(found.json.results.map(g => g.id), ["cat1", "cat2"]);
  assert.deepEqual(found.json.results[0], { id: "cat1", title: "gif cat1", url: "https://static.klipy.com/ii/cat1.gif", preview: "https://static.klipy.com/ii/cat1-tiny.gif", width: 200, height: 100 });
  assert.equal(found.json.next, "30");
  assert.equal(asked[0].searchParams.get("q"), "cat");
  assert.equal(asked[0].searchParams.get("pos"), "10");
  assert.equal(asked[0].searchParams.get("key"), "sekret");
  assert.doesNotMatch(found.text, /sekret/);

  const hot = await api(b, "GET", "/gifs");
  assert.equal(asked.at(-1).pathname, "/v2/featured");
  assert.deepEqual([hot.json.results.map(g => g.id), hot.json.next], [["hot"], null]);

  const cats = await api(b, "GET", "/gifs/categories");
  assert.deepEqual(cats.json.categories, [
    { name: "happy", query: "happy", preview: "https://static.klipy.com/ii/happy.gif" },
    { name: "sad", query: "sad", preview: null },
  ]);

  status = 500;
  assert.equal((await api(b, "GET", "/gifs?q=cat")).status, 502);
  assert.equal((await api(b, "POST", "/gifs")).status, 405);
  assert.equal((await api(b, "GET", "/gifs/nope")).status, 404);
});

test("the chat page may show pictures from the GIF hosts", async () => {
  const env = makeEnv({ GIF_API_KEY: "k" });
  const b = await signedIn(env, "josh");
  const csp = (await b.get("/chat/")).headers.get("Content-Security-Policy");
  assert.match(csp, /img-src 'self' data: https:\/\/klipy\.com https:\/\/\*\.klipy\.com/);
  assert.doesNotMatch(csp, /connect-src[^;]*klipy/);
});

test("favorites are kept per account", async () => {
  const env = makeEnv({ GIF_API_KEY: "k" });
  const josh = await signedIn(env, "josh"), sam = await signedIn(env, "sam");
  const one = { url: "https://static.klipy.com/ii/a.gif", preview: "https://static.klipy.com/ii/a-tiny.gif", width: 200, height: 100, title: "a" };

  assert.deepEqual((await api(josh, "GET", "/gifs/favorites")).json.favorites, []);
  let r = await api(josh, "POST", "/gifs/favorites", { gif: one, on: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.favorites, [one]);
  // Starring it again doesn't make a second one; a second GIF goes first.
  await api(josh, "POST", "/gifs/favorites", { gif: one, on: true });
  r = await api(josh, "POST", "/gifs/favorites", { gif: { url: "https://media.tenor.com/b.gif" }, on: true });
  assert.deepEqual(r.json.favorites.map(f => [f.url, f.preview]), [["https://media.tenor.com/b.gif", "https://media.tenor.com/b.gif"], [one.url, one.preview]]);
  assert.deepEqual((await api(sam, "GET", "/gifs/favorites")).json.favorites, []);

  r = await api(josh, "POST", "/gifs/favorites", { gif: one, on: false });
  assert.deepEqual(r.json.favorites.map(f => f.url), ["https://media.tenor.com/b.gif"]);

  for (const bad of [
    { gif: { url: "https://evil.example/x.gif" }, on: true },
    { gif: { url: "http://static.klipy.com/x.gif" }, on: true },
    { gif: { url: "https://static.klipy.com/page.html" }, on: true },
    { gif: one },
    { gif: one, on: true, extra: 1 },
  ]) assert.equal((await api(josh, "POST", "/gifs/favorites", bad)).status, 400, JSON.stringify(bad));
});

test("a GIF is sent as a message with its link", async () => {
  const env = makeEnv({ GIF_API_KEY: "k" });
  const josh = await signedIn(env, "josh");
  const room = (await api(josh, "POST", "/rooms", { name: "General" })).json.id;
  const sent = await api(josh, "POST", `/rooms/${room}/messages`, { body: "https://static.klipy.com/ii/a.gif" });
  assert.equal(sent.status, 201);
  assert.equal(sent.json.body, "https://static.klipy.com/ii/a.gif");
});
