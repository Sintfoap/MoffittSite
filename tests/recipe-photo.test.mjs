// Tests for Recipe box's photo import: a picture of a recipe read by Claude, or
// by Workers AI without a key (stand-ins here), into a draft to check, and the
// API key it's read with.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps, sqlOne } from "./helpers.mjs";
import { draftFrom, pictureFrom } from "../src/recipe_photo.js";

let calls = [], reply = () => ({}), status = 200, stop = "end_turn";
const real = globalThis.fetch;
beforeEach(() => {
  calls = []; status = 200; stop = "end_turn";
  reply = () => ({ found: true, title: "Nana's Shortbread", servings: 0, yield: "Makes 24", time: "",
    ingredients: ["2 cups flour", "1 cup butter", " ", "1/2 cup sugar"], steps: ["1. Cream the butter and sugar.", "Step 2: Add flour.", "Bake at 325°F for 20 min."],
    notes: "From Nana, 1974.", picture: [0.1, 0.05, 0.9, 0.4] });
  globalThis.fetch = async (input, init) => {
    const url = new URL(input.url || input);
    if (url.host !== "api.anthropic.com") return real(input, init);
    if (url.pathname === "/v1/models") return new Response("{}", { status: init.headers["x-api-key"] === BAD ? 401 : 200 });
    const body = JSON.parse(init.body);
    calls.push({ headers: init.headers, body });
    if (status !== 200) return new Response(JSON.stringify({ type: "error", error: { message: "nope" } }), { status });
    return new Response(JSON.stringify({ stop_reason: stop, content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(reply(body)) }] }),
      { headers: { "Content-Type": "application/json" } });
  };
});
afterEach(() => { globalThis.fetch = real; });

const SEAL = { CHAT_BRIDGE_KEY: "test-bridge-key-0123456789" };
const KEY = "sk-ant-api03-" + "k".repeat(40), BAD = "sk-ant-api03-" + "x".repeat(40);
// The smallest pictures that are what they say: a JPEG's and a PNG's first bytes.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]).toString("base64");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString("base64");
const api = (b, method, path, json) => b.req(method, "/recipes/api/" + path, json === undefined ? {} : { json });

async function setup(extra = SEAL) {
  const env = makeEnv(extra), ryan = new Browser(env);
  await ryan.signup("ryan");
  grantApps(env, "ryan", "recipes");
  return { env, ryan };
}

test("without a key, the box says so; a key is checked, kept sealed and shared with Sweep", async () => {
  const { env, ryan } = await setup();
  assert.deepEqual((await api(ryan, "GET", "recipes")).json.photo, { ready: false, ai: false, sealing: true, key: null });
  const none = await api(ryan, "POST", "photo", { images: [{ data: JPEG }] });
  assert.equal(none.status, 400);
  assert.match(none.json.error, /API key/);
  assert.equal(calls.length, 0);

  assert.equal((await api(ryan, "PUT", "key", { key: "nope" })).status, 400);
  assert.match((await api(ryan, "PUT", "key", { key: BAD })).json.error, /didn't accept/);
  const saved = await api(ryan, "PUT", "key", { key: KEY });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.photo.ready, true);
  assert.equal(saved.json.photo.key.hint, "kkkk");
  const row = sqlOne(env, "SELECT secret FROM sweep_keys");
  assert.ok(!row.secret.includes(KEY), "the key is sealed");
  assert.equal((await api(ryan, "GET", "recipes")).json.photo.ready, true);
  assert.equal((await api(ryan, "DELETE", "key")).json.photo.ready, false);
});

test("a site without CHAT_BRIDGE_KEY can't keep a key, and says so", async () => {
  const { ryan } = await setup({});
  assert.equal((await api(ryan, "GET", "recipes")).json.photo.sealing, false);
  const r = await api(ryan, "PUT", "key", { key: KEY });
  assert.equal(r.status, 503);
  assert.match(r.json.error, /CHAT_BRIDGE_KEY/);
});

test("a photo is read into a draft to check: nothing is saved until the recipe is", async () => {
  const { env, ryan } = await setup({ ...SEAL, RECIPES_MODEL: "claude-test" });
  await api(ryan, "PUT", "key", { key: KEY });
  const r = await api(ryan, "POST", "photo", { images: [{ data: JPEG }, { data: "data:image/png;base64," + PNG }] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.recipe, {
    title: "Nana's Shortbread", yield: "Makes 24", time: "", servings: 24, source: "",
    ingredients: ["2 cups flour", "1 cup butter", "1/2 cup sugar"],
    steps: ["Cream the butter and sugar.", "Add flour.", "Bake at 325°F for 20 min."], notes: "From Nana, 1974.",
    picture: { x0: 0.1, y0: 0.05, x1: 0.9, y1: 0.4 },
  });
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM recipes").n, 0);

  const [call] = calls;
  assert.equal(call.headers["x-api-key"], KEY);
  assert.equal(call.body.model, "claude-test");
  assert.equal(call.body.output_config.format.type, "json_schema");
  const [a, b, words] = call.body.messages[0].content;
  assert.deepEqual(a.source, { type: "base64", media_type: "image/jpeg", data: JPEG });
  assert.equal(b.source.media_type, "image/png", "the type comes from the bytes, and a data: prefix is dropped");
  assert.equal(b.source.data, PNG);
  assert.match(words.text, /2 pictures/);

  // Saving the checked draft is an ordinary new recipe.
  // (Where the dish's photo is says what to crop for its picture; it isn't a field of the recipe.)
  const { picture, ...draft } = r.json.recipe;
  const saved = await api(ryan, "POST", "recipes", { ...draft, title: "Nana's Shortbread (1974)" });
  assert.equal(saved.status, 201);
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM recipes").n, 1);
});

test("what isn't a recipe, or a picture, is turned away with a reason", async () => {
  const { ryan } = await setup();
  await api(ryan, "PUT", "key", { key: KEY });
  const pic = [{ data: JPEG }];
  reply = () => ({ found: false, title: "", servings: 0, yield: "", time: "", ingredients: [], steps: [], notes: "A cat on a sofa." });
  const cat = await api(ryan, "POST", "photo", { images: pic });
  assert.equal(cat.status, 400);
  assert.match(cat.json.error, /couldn.t find a recipe.*cat on a sofa/i);

  assert.match((await api(ryan, "POST", "photo", { images: [{ data: Buffer.from("just some text").toString("base64") }] })).json.error, /isn't a JPEG/);
  assert.match((await api(ryan, "POST", "photo", { images: [{ data: "not base64!" }] })).json.error, /base64/);
  assert.equal((await api(ryan, "POST", "photo", { images: Array(5).fill(pic[0]) })).status, 400);
  assert.equal((await api(ryan, "POST", "photo", {})).status, 400);
  assert.equal((await ryan.get("/recipes/api/photo")).status, 405);
  assert.equal((await ryan.req("POST", "/recipes/api/photo", { json: { images: pic }, origin: "https://evil.test" })).status, 403);

  stop = "refusal";
  assert.match((await api(ryan, "POST", "photo", { images: pic })).json.error, /declined to read that photo/);
  stop = "end_turn"; status = 529;
  const busy = await api(ryan, "POST", "photo", { images: pic });
  assert.equal(busy.status, 503);
  assert.match(busy.json.error, /busy/);
  status = 401;
  assert.match((await api(ryan, "POST", "photo", { images: pic })).json.error, /didn't accept your API key. Try again/);
});

// Stands in for Workers AI's vision model: answers with `answer`, or throws it when it's an Error.
function fakeAI(seen, answer) {
  return { async run(model, input) { seen.push({ model, input }); if (answer instanceof Error) throw answer; return { response: answer }; } };
}
const AI_READ = { found: true, title: "Nana's Shortbread", servings: 0, yield: "makes 24", time: "45 min",
  ingredients: ["2 cups flour", "½ cup sugar"], steps: ["1. Cream butter & sugar.", "Bake 325° 30-35 min."], notes: "", picture: [0, 0, 1, 1] };

test("without a key, Workers AI reads the photo: no picture box, nothing saved", async () => {
  const seen = [];
  const { env, ryan } = await setup({ ...SEAL, AI: fakeAI(seen, AI_READ), RECIPES_AI_MODEL: "@cf/test/vision" });
  assert.deepEqual((await api(ryan, "GET", "recipes")).json.photo, { ready: false, ai: true, sealing: true, key: null });
  const r = await api(ryan, "POST", "photo", { images: [{ data: JPEG }, { data: PNG }] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.by, "ai");
  assert.deepEqual(r.json.recipe, {
    title: "Nana's Shortbread", yield: "makes 24", time: "45 min", servings: 24, source: "",
    ingredients: ["2 cups flour", "½ cup sugar"], steps: ["Cream butter & sugar.", "Bake 325° 30-35 min."], notes: "", picture: null,
  });
  assert.equal(calls.length, 0, "Claude isn't asked");
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM recipes").n, 0);
  const [{ model, input }] = seen;
  assert.equal(model, "@cf/test/vision");
  assert.equal(input.response_format.type, "json_schema");
  assert.ok(!("picture" in input.response_format.json_schema.properties), "no box is asked for");
  assert.doesNotMatch(input.messages[0].content, /picture is where/);
  const [words, a, b] = input.messages[1].content;
  assert.match(words.text, /2 pictures/);
  assert.equal(a.image_url.url, "data:image/jpeg;base64," + JPEG);
  assert.equal(b.image_url.url, "data:image/png;base64," + PNG);
});

test("Workers AI: an answer as text is read, no recipe is turned away, a failure is a plain error", async () => {
  const seen = [];
  const ai = fakeAI(seen, "Here it is:\n```json\n" + JSON.stringify(AI_READ) + "\n```");
  const { env, ryan } = await setup({ ...SEAL, AI: ai });
  assert.equal((await api(ryan, "POST", "photo", { images: [{ data: JPEG }] })).json.recipe.title, "Nana's Shortbread");
  env.AI = fakeAI(seen, { found: false, title: "", servings: 0, yield: "", time: "", ingredients: [], steps: [], notes: "a cat" });
  const cat = await api(ryan, "POST", "photo", { images: [{ data: JPEG }] });
  assert.equal(cat.status, 400);
  assert.match(cat.json.error, /couldn.t find a recipe.*a cat/);
  env.AI = fakeAI(seen, new Error("3040: out of capacity"));
  const down = await api(ryan, "POST", "photo", { images: [{ data: JPEG }] });
  assert.equal(down.status, 503);
  assert.match(down.json.error, /couldn't read that photo right now/);
  assert.doesNotMatch(down.json.error, /3040/);
});

test("with a key, Claude reads it; when Claude can't, Workers AI does and says why", async () => {
  const seen = [];
  const { ryan } = await setup({ ...SEAL, AI: fakeAI(seen, AI_READ) });
  await api(ryan, "PUT", "key", { key: KEY });
  const r = await api(ryan, "POST", "photo", { images: [{ data: JPEG }] });
  assert.equal(r.json.by, "claude");
  assert.equal(seen.length, 0);
  status = 529;
  const busy = await api(ryan, "POST", "photo", { images: [{ data: JPEG }] });
  assert.equal(busy.status, 200, busy.text);
  assert.equal(busy.json.by, "ai");
  assert.match(busy.json.why, /busy/);
  // Claude read it and found no recipe: that's the answer.
  status = 200;
  reply = () => ({ found: false, title: "", servings: 0, yield: "", time: "", ingredients: [], steps: [], notes: "A dog." });
  assert.match((await api(ryan, "POST", "photo", { images: [{ data: JPEG }] })).json.error, /Claude saw: A dog/);
  assert.equal(seen.length, 1);
});

test("photo import is part of Recipe box: off for accounts without it", async () => {
  const env = makeEnv(SEAL), josh = new Browser(env);
  await josh.signup("josh");
  assert.equal((await api(josh, "POST", "photo", { images: [{ data: JPEG }] })).status, 403);
  assert.equal((await api(josh, "PUT", "key", { key: KEY })).status, 403);
});

test("a draft keeps what's readable and drops what isn't", () => {
  assert.equal(draftFrom({ found: false }), null);
  assert.equal(draftFrom({ found: true, title: "Empty", ingredients: [], steps: [] }), null);
  const d = draftFrom({ found: true, title: "", servings: 4, yield: "", time: "45 min", ingredients: Array(150).fill("salt"), steps: [], notes: "" });
  assert.equal(d.title, "Untitled recipe");
  assert.equal(d.servings, 4);
  assert.equal(d.ingredients.length, 100);
  assert.equal(d.picture, null);
});

test("the dish's photo is kept only as a sensible box", () => {
  assert.deepEqual(pictureFrom([0, 0, 1, 0.5]), { x0: 0, y0: 0, x1: 1, y1: 0.5 });
  for (const bad of [[], [0, 0, 1], [0, 0, 2, 1], [0.5, 0.5, 0.52, 0.9], ["0", 0, 1, 1], null]) assert.equal(pictureFrom(bad), null, JSON.stringify(bad));
});
