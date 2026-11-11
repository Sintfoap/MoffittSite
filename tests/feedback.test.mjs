// Tests for Feedback: notes to the site's admins, with photos, links to things on the site, and replies.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps, sql, sqlOne, run, enable2fa } from "./helpers.mjs";
import { PHOTOS_EACH } from "../src/feedback.js";

async function person(env, name, ...apps) {
  const b = new Browser(env);
  await b.signup(name, undefined, name[0].toUpperCase() + name.slice(1));
  grantApps(env, name, ...apps);
  return b;
}
async function owner(env) {
  const b = await person(env, "ryan");
  run(env, "INSERT INTO user_areas (user_id, area) SELECT id, 'admin' FROM users WHERE username = 'ryan'");
  await enable2fa(b, env);
  return b;
}
const api = (b, method, path, json) => b.req(method, "/feedback/api/" + path, { json });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString("base64");

test("Feedback is off until an admin turns it on, and admins can always read it", async () => {
  const env = makeEnv(), josh = await person(env, "josh"), ryan = await owner(env);
  assert.equal((await josh.get("/feedback/")).status, 403);
  assert.equal((await josh.get("/feedback/api/feedback")).status, 403);
  assert.doesNotMatch((await josh.get("/dashboard")).text, /href="\/feedback\/"/);
  grantApps(env, "josh", "feedback");
  const page = await josh.get("/feedback/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("Content-Security-Policy"), /img-src 'self' data: blob:/);
  assert.equal((await josh.get("/feedback")).status, 308);
  const mine = (await api(josh, "GET", "feedback")).json;
  assert.deepEqual([mine.mine, mine.inbox, mine.owner], [[], null, false]);
  assert.deepEqual(mine.sources.map(s => s.id), ["drift"], "only the apps josh has can be linked from");

  // ryan never had the toggle, but he's an admin: the page, its inbox, and a place in his menu.
  assert.equal((await ryan.get("/feedback/")).status, 200);
  assert.equal((await api(ryan, "GET", "feedback")).json.owner, true);
  assert.match((await ryan.get("/dashboard")).text, /href="\/feedback\/"/);
  assert.match((await ryan.get("/admin")).text, /Feedback inbox<\/b><\/a> · nothing sent yet/);
});

test("a note goes to the admins only, who read it, set its status and reply", async () => {
  const env = makeEnv(), ryan = await owner(env), josh = await person(env, "josh", "feedback"), kim = await person(env, "kim", "feedback");
  for (const bad of [{}, { kind: "rant", message: "x" }, { message: "x", colour: "red" }, { message: "x", status: "done" }, { message: "x".repeat(8001) }]) {
    assert.equal((await api(josh, "POST", "items", bad)).status, 400, JSON.stringify(bad));
  }
  const made = await api(josh, "POST", "items", { kind: "bug", subject: "Pantry won't scroll", message: "On my phone the list stops halfway." });
  assert.equal(made.status, 201, made.text);
  const id = made.json.id;
  assert.equal(made.json.status, "new");
  assert.equal(made.json.can_set_status, false);

  // Nobody but josh and the admins can see it, or even tell it's there.
  assert.equal((await api(kim, "GET", `items/${id}`)).status, 404);
  assert.equal((await api(kim, "POST", `items/${id}/replies`, { text: "me too" })).status, 404);
  assert.deepEqual((await api(kim, "GET", "feedback")).json.mine, []);
  assert.equal((await api(josh, "PATCH", `items/${id}`, { status: "done" })).status, 400, "only admins set the status");

  let inbox = (await api(ryan, "GET", "feedback")).json.inbox;
  assert.deepEqual(inbox.map(n => [n.subject, n.by, n.unread]), [["Pantry won't scroll", "Josh", true]]);
  assert.match((await ryan.get("/admin")).text, /1 note, <b>1 unread<\/b>, 1 still open/);
  assert.match((await ryan.get("/dashboard")).text, /1 note to read/);
  const read = (await api(ryan, "GET", `items/${id}`)).json;
  assert.equal(read.can_set_status, true);
  assert.equal(read.can_edit, false);
  assert.equal((await api(ryan, "GET", "feedback")).json.inbox[0].unread, false, "opening it reads it");
  assert.equal((await api(ryan, "PATCH", `items/${id}`, { message: "edited" })).status, 400, "admins don't change what someone said");
  assert.equal((await api(ryan, "PATCH", `items/${id}`, { status: "planned" })).json.status, "planned");

  const answered = (await api(ryan, "POST", `items/${id}/replies`, { text: "Thanks! Fixing it this week." })).json;
  assert.deepEqual(answered.replies.map(r => [r.by, r.from_owner, r.text]), [["Ryan", true, "Thanks! Fixing it this week."]]);
  const mine = (await api(josh, "GET", "feedback")).json.mine;
  assert.deepEqual(mine.map(n => [n.status, n.replies, n.unread]), [["planned", 1, true]]);
  assert.match((await josh.get("/dashboard")).text, /1 reply to read/);
  const seen = (await api(josh, "GET", `items/${id}`)).json;
  assert.equal(seen.seen_by_owner, true);
  assert.equal((await api(josh, "GET", "feedback")).json.mine[0].unread, false);
  await api(josh, "POST", `items/${id}/replies`, { text: "Great, thank you" });
  assert.equal((await api(ryan, "GET", "feedback")).json.inbox[0].unread, true, "josh's answer is new to the admins");

  // Josh can change what he said; either side can delete it.
  assert.equal((await api(josh, "PATCH", `items/${id}`, { subject: "Pantry list stops scrolling" })).json.subject, "Pantry list stops scrolling");
  assert.equal((await api(kim, "DELETE", `items/${id}`)).status, 404);
  assert.equal((await api(ryan, "DELETE", `items/${id}`)).status, 200);
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM feedback_replies").n, 0);
});

test("many photos, seen only by the sender and the admins", async () => {
  const env = makeEnv(), ryan = await owner(env), josh = await person(env, "josh", "feedback"), kim = await person(env, "kim", "feedback");
  const id = (await api(josh, "POST", "items", { message: "Look at this" })).json.id;
  assert.equal((await api(josh, "POST", `items/${id}/photos`, { data: Buffer.from("not a picture").toString("base64") })).status, 400);
  for (let i = 0; i < PHOTOS_EACH; i++) {
    const r = await api(josh, "POST", `items/${id}/photos`, { data: JPEG, caption: `shot ${i + 1}` });
    assert.equal(r.status, 200, r.text);
  }
  assert.match((await api(josh, "POST", `items/${id}/photos`, { data: JPEG })).json.error, new RegExp(`at most ${PHOTOS_EACH} photos`));
  assert.equal((await api(ryan, "POST", `items/${id}/photos`, { data: JPEG })).status, 400, "only the sender adds photos");
  const n = (await api(ryan, "GET", `items/${id}`)).json;
  assert.equal(n.photos.length, PHOTOS_EACH);
  const photo = n.photos[0].id;
  const pic = await ryan.get(`/feedback/api/photos/${photo}`);
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get("Content-Type"), "image/jpeg");
  assert.equal((await josh.get(`/feedback/api/photos/${photo}`)).status, 200);
  assert.equal((await kim.get(`/feedback/api/photos/${photo}`)).status, 404, "someone else's photo isn't there for kim");
  assert.equal((await api(kim, "DELETE", `items/${id}/photos/${photo}`)).status, 404);
  assert.equal((await api(ryan, "DELETE", `items/${id}/photos/${photo}`)).json.photos.length, PHOTOS_EACH - 1);
  assert.equal((await api(ryan, "GET", "feedback")).json.inbox[0].photos, PHOTOS_EACH - 1);
});

test("links point at real things the sender can see, and keep what they were", async () => {
  const env = makeEnv(), ryan = await owner(env), josh = await person(env, "josh", "feedback", "recipes", "food", "pantry"), kim = await person(env, "kim", "recipes");
  const soup = (await josh.req("POST", "/recipes/api/recipes", { json: { title: "Tomato soup", ingredients: ["4 tomatoes", "1 onion"], source: "https://www.soups.test/tomato" } })).json;
  const kims = (await kim.req("POST", "/recipes/api/recipes", { json: { title: "Kim's secret stew" } })).json;
  const pick = (await josh.req("POST", "/food/api/picks", { json: { month: "2026-11", title: "Shakshuka", blurb: "Eggs in tomato" } })).json;
  const flour = (await josh.req("POST", "/pantry/api/items", { json: { name: "Flour", amount: "5 lb", low: "1 lb" } })).json;
  const col = (await josh.req("POST", "/todo/api/collections", { json: { name: "Home" } })).json;
  const task = (await josh.req("POST", "/todo/api/items", { json: { title: "Fix the gate", collection: col.id } })).json;
  assert.ok(soup.id && pick.id && flour.id && task.id, "made the things to link");

  const found = (await api(josh, "GET", "linkable?app=recipes&q=tom")).json.items;
  assert.deepEqual(found.map(i => [i.id, i.title, i.sub]), [[soup.id, "Tomato soup", "soups.test"]]);
  assert.deepEqual((await api(josh, "GET", "linkable?app=recipes&q=stew")).json.items, [], "kim's recipes aren't josh's to link");
  assert.equal((await api(josh, "GET", "linkable?app=trips")).status, 400, "josh doesn't have Trip planner");
  assert.equal((await api(josh, "GET", "linkable?app=drift&q=gate")).json.items[0].title, "Fix the gate");

  assert.match((await api(josh, "POST", "items", { message: "x", links: [{ app: "recipes", id: kims.id }] })).json.error, /isn't one you can see/);
  assert.equal((await api(josh, "POST", "items", { message: "x", links: [{ url: "javascript:alert(1)" }] })).status, 400);
  const made = await api(josh, "POST", "items", { kind: "idea", subject: "Soup ideas", message: "Could recipes suggest a side?", links: [
    { app: "recipes", id: soup.id }, { app: "food", id: pick.id }, { app: "pantry", id: flour.id }, { app: "drift", id: task.id },
    { app: "url", url: "https://example.com/side-dishes" }, { app: "recipes", id: soup.id }] });
  assert.equal(made.status, 201, made.text);
  const links = made.json.links;
  assert.deepEqual(links.map(l => [l.app, l.title]), [["recipes", "Tomato soup"], ["food", "Shakshuka"], ["pantry", "Flour"], ["drift", "Fix the gate"], ["url", "example.com/side-dishes"]],
    "the same thing twice is linked once");
  assert.equal(links[0].href, `/recipes/#${soup.id}`);
  assert.equal(links[0].detail, "4 tomatoes; 1 onion");
  assert.equal(links[1].sub, "2026-11");

  // The admins see the snapshot, even after the recipe's gone.
  await josh.req("DELETE", `/recipes/api/recipes/${soup.id}`);
  const seen = (await api(ryan, "GET", `items/${made.json.id}`)).json;
  assert.equal(seen.links[0].title, "Tomato soup");
  assert.equal((await api(ryan, "GET", "feedback")).json.inbox[0].links, 5);
  // Taking a link off, and adding one later, keeps the rest as they were.
  const fewer = (await api(josh, "PATCH", `items/${made.json.id}`, { links: links.slice(0, 2).map(({ app, id }) => ({ app, id })) })).json;
  assert.deepEqual(fewer.links.map(l => l.title), ["Tomato soup", "Shakshuka"]);
});

test("deleting an account takes its feedback with it", async () => {
  const env = makeEnv(), ryan = await owner(env), josh = await person(env, "josh", "feedback");
  const id = (await api(josh, "POST", "items", { message: "Bye" })).json.id;
  await api(josh, "POST", `items/${id}/photos`, { data: JPEG });
  await api(ryan, "POST", `items/${id}/replies`, { text: "Noted" });
  const jid = sqlOne(env, "SELECT id FROM users WHERE username = 'josh'").id;
  const res = await ryan.post("/admin/delete", { user_id: jid, confirm: "josh" });
  assert.ok(res.status < 400, res.text);
  for (const t of ["feedback", "feedback_photos", "feedback_replies"]) assert.equal(sql(env, `SELECT * FROM ${t}`).length, 0, t);
});
