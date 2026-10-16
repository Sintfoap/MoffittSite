// The dashboard's "Today" card and account checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv } from "./helpers.mjs";

const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

test("the dashboard shows today's and overdue Drift items, not done or later ones", async () => {
  const env = makeEnv(), b = new Browser(env);
  await b.signup("ryan", "correct horse battery", "Ryan Moffitt");
  const col = (await b.get("/todo/api/state")).json.collections[0].id;
  const add = (title, start, done = false) => b.req("POST", "/todo/api/items", {
    json: { collection: col, title, meta: { event: { start, end: null }, checklist: { done, priority: 0 } } } });
  await add("Renew <domain>", day(-2));
  await add("Dentist", day(0) + "T15:00");
  await add("Already done", day(0), true);
  await add("Next week", day(7));

  const page = (await b.get("/dashboard")).text;
  assert.match(page, /Renew &lt;domain&gt;/, "titles are escaped");
  assert.match(page, /2 days late/);
  assert.match(page, /Dentist[\s\S]*3 pm/);
  assert.doesNotMatch(page, /Already done|Next week/);
  assert.match(page, /1 thing today in Drift, and 1 overdue/);
  assert.match(page, /Two-factor is off/);
  assert.match(page, /aria-current="page"[^>]*>[\s\S]{0,400}Home/, "the rail marks the dashboard");
  assert.match(page, /<script src="\/keys.js" defer><\/script>/, "the shortcut keys load");
  assert.match(page, /data-key="d"/, "g d jumps to Drift");
});

test("accounts without Drift get no Today card", async () => {
  const env = makeEnv(), b = new Browser(env);
  await b.signup("josh");
  env.TODO_DB.raw.prepare("DELETE FROM user_areas").run();
  const page = (await b.get("/dashboard")).text;
  assert.doesNotMatch(page, /Open Drift/);
  assert.doesNotMatch(page, /href="\/todo\/"/);
});

// One menu for the whole site: the dashboard's nav goes into every page.
test("Drift, the plugin store and chat get the dashboard's rail, Chat included", async () => {
  const marked = { fetch: async () => new Response("<!doctype html><body><!--site-rail--><main></main></body>", { headers: { "Content-Type": "text/html", ETag: '"x"' } }) };
  const env = makeEnv({ ASSETS: marked }), b = new Browser(env);
  await b.signup("ryan", "correct horse battery", "Ryan Moffitt");
  for (const [path, here] of [["/todo/", "Drift"], ["/plugins/", "Plugin store"], ["/chat/", "Chat"]]) {
    const r = await b.get(path);
    assert.equal(r.status, 200, path);
    assert.doesNotMatch(r.text, /<!--site-rail-->/, `${path} has its rail`);
    for (const href of ["/dashboard", "/todo/", "/plugins/", "/chat/", "/account"]) assert.match(r.text, new RegExp(`href="${href}"`), `${path} links ${href}`);
    assert.doesNotMatch(r.text, /href="\/admin"/, "no Admin for a normal account");
    assert.match(r.text, new RegExp(`aria-current="page"[^>]*>[\\s\\S]{0,600}<span>${here}</span>`), `${path} marks itself`);
    assert.match(r.text, /Ryan Moffitt/);
    assert.equal(r.headers.get("ETag"), null, "the page differs per person, so no shared validator");
  }
  // The dashboard shows the same menu.
  assert.match((await b.get("/dashboard")).text, /href="\/chat\/" data-key="c"/);
});
