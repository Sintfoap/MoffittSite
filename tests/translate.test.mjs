// Tests for "Translate to English": a Drift item, a recipe and a board post read
// into English by Workers AI (a stand-in here), shown beside the original and
// never saved over it. Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps } from "./helpers.mjs";
import { resultFrom, parseAnswer, textFields } from "../src/translate.js";

// Stands in for Workers AI: a tiny Spanish → English dictionary.
const WORDS = { "Cena con abuela": "Dinner with grandma", "Traer el vino": "Bring the wine", "Tortilla española": "Spanish omelette",
  "4 huevos": "4 eggs", "2 patatas": "2 potatoes", "Batir los huevos.": "Beat the eggs.", "Freír a 180°C.": "Fry at 180°C.", "Receta de mamá": "Mom's recipe" };
function fakeAI(calls, { answer } = {}) {
  return {
    async run(model, input) {
      calls.push({ model, input });
      const fields = JSON.parse(input.messages[1].content);
      if (answer) return answer(fields);
      const tr = v => Array.isArray(v) ? v.map(tr) : WORDS[v] ?? v;
      const out = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, tr(v)]));
      const spanish = JSON.stringify(out) !== JSON.stringify(fields);
      return { response: { language: spanish ? "Spanish" : "English", fields: out } };
    },
  };
}

async function member(env, name, ...apps) {
  const b = new Browser(env);
  await b.signup(name);
  if (apps.length) grantApps(env, name, ...apps);
  return b;
}

test("a Drift item comes back in English, and the item itself is left as it was", async () => {
  const calls = [], env = makeEnv({ AI: fakeAI(calls) }), ryan = await member(env, "ryan");
  const col = (await ryan.req("GET", "/todo/api/state")).json.collections[0];
  const it = (await ryan.req("POST", "/todo/api/items", { json: { title: "Cena con abuela", notes: "Traer el vino", collection: col.id } })).json;
  const r = await ryan.req("POST", `/todo/api/items/${it.id}/translate`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { language: "Spanish", english: false, fields: { title: "Dinner with grandma", notes: "Bring the wine" } });
  assert.equal(calls[0].model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.equal(calls[0].input.response_format.type, "json_schema");
  const again = (await ryan.req("GET", "/todo/api/state")).json.items.find(x => x.id === it.id);
  assert.equal(again.title, "Cena con abuela", "nothing is saved by translating");

  // Only GET-free POSTs from the site, only items you can see.
  assert.equal((await ryan.req("GET", `/todo/api/items/${it.id}/translate`)).status, 405);
  assert.equal((await ryan.req("POST", `/todo/api/collections/${col.id}/translate`)).status, 404);
  const josh = await member(env, "josh");
  assert.equal((await josh.req("POST", `/todo/api/items/${it.id}/translate`)).status, 404);
  assert.equal(calls.length, 1);
});

test("English stays English, and an empty item has nothing to translate", async () => {
  const calls = [], env = makeEnv({ AI: fakeAI(calls) }), ryan = await member(env, "ryan");
  const col = (await ryan.req("GET", "/todo/api/state")).json.collections[0];
  const it = (await ryan.req("POST", "/todo/api/items", { json: { title: "Pay rent", collection: col.id } })).json;
  const r = await ryan.req("POST", `/todo/api/items/${it.id}/translate`);
  assert.deepEqual(r.json, { language: "English", english: true, fields: { title: "Pay rent" } });
  assert.deepEqual(JSON.parse(calls[0].input.messages[1].content), { title: "Pay rent" }, "empty notes aren't sent");
});

test("a recipe is translated line for line, ingredients and steps kept in step", async () => {
  const calls = [], env = makeEnv({ AI: fakeAI(calls), TRANSLATE_MODEL: "@cf/test/model" }), ryan = await member(env, "ryan", "recipes");
  const rec = (await ryan.req("POST", "/recipes/api/recipes", { json: { title: "Tortilla española", ingredients: ["4 huevos", "2 patatas"], steps: ["Batir los huevos.", "Freír a 180°C."], notes: "Receta de mamá" } })).json;
  const r = await ryan.req("POST", `/recipes/api/recipes/${rec.id}/translate`);
  assert.equal(r.status, 200);
  assert.equal(r.json.language, "Spanish");
  assert.deepEqual(r.json.fields, { title: "Spanish omelette", ingredients: ["4 eggs", "2 potatoes"], steps: ["Beat the eggs.", "Fry at 180°C."], notes: "Mom's recipe" });
  assert.equal(calls[0].model, "@cf/test/model");
  assert.equal((await ryan.req("GET", "/recipes/api/recipes")).json.recipes[0].title, "Tortilla española");
  // Saving it is an ordinary edit.
  const saved = await ryan.req("PATCH", `/recipes/api/recipes/${rec.id}`, { json: r.json.fields });
  assert.deepEqual(saved.json.ingredients, ["4 eggs", "2 potatoes"]);
  // Someone else's recipe isn't theirs to translate.
  const josh = await member(env, "josh", "recipes");
  assert.equal((await josh.req("POST", `/recipes/api/recipes/${rec.id}/translate`)).status, 404);
});

test("anyone on the board can translate a post, not just whoever posted it", async () => {
  const calls = [], env = makeEnv({ AI: fakeAI(calls) }), ryan = await member(env, "ryan", "board"), josh = await member(env, "josh", "board");
  const post = (await ryan.req("POST", "/board/api/posts", { json: { title: "Tortilla española", note: "Receta de mamá", recipe: { ingredients: ["4 huevos"], steps: ["Batir los huevos."] } } })).json;
  const r = await josh.req("POST", `/board/api/posts/${post.id}/translate`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.fields, { title: "Spanish omelette", note: "Mom's recipe", ingredients: ["4 eggs"], steps: ["Beat the eggs."] });
  assert.equal((await josh.req("POST", "/board/api/posts/b_0000000000/translate")).status, 404);
});

test("without Workers AI it falls back to your Claude key, or says what's missing", async () => {
  const env = makeEnv(), ryan = await member(env, "ryan");
  const col = (await ryan.req("GET", "/todo/api/state")).json.collections[0];
  const it = (await ryan.req("POST", "/todo/api/items", { json: { title: "Cena con abuela", collection: col.id } })).json;
  const r = await ryan.req("POST", `/todo/api/items/${it.id}/translate`);
  assert.equal(r.status, 503);
  assert.match(r.json.error, /Workers AI/);
});

test("when Workers AI fails, the page hears a plain error, not a crash", async () => {
  const env = makeEnv({ AI: { run: async () => { throw new Error("3040: capacity"); } } }), ryan = await member(env, "ryan");
  const col = (await ryan.req("GET", "/todo/api/state")).json.collections[0];
  const it = (await ryan.req("POST", "/todo/api/items", { json: { title: "Cena con abuela", collection: col.id } })).json;
  const err = console.error; console.error = () => {};
  try {
    const r = await ryan.req("POST", `/todo/api/items/${it.id}/translate`);
    assert.equal(r.status, 503);
    assert.match(r.json.error, /Couldn't translate/);
  } finally { console.error = err; }
});

test("answers are checked: a list that lost a line keeps the original, text answers are read", () => {
  const fields = { title: "Tortilla", ingredients: ["4 huevos", "2 patatas"] };
  const r = resultFrom({ language: "Spanish", fields: { title: "Omelette", ingredients: ["4 eggs"] } }, fields);
  assert.deepEqual(r.fields, { title: "Omelette", ingredients: ["4 huevos", "2 patatas"] });
  assert.equal(resultFrom({ nope: 1 }, fields), null);
  assert.deepEqual(parseAnswer('Sure!\n```json\n{"language":"French","fields":{}}\n```'), { language: "French", fields: {} });
  assert.equal(parseAnswer("no json here"), null);
  assert.deepEqual(textFields({ a: "", b: " x ", c: [], d: ["", " "], e: ["y", ""], f: 3 }), { b: " x ", e: ["y", ""] });
  // A blank line in a list stays blank.
  assert.deepEqual(resultFrom({ language: "Spanish", fields: { l: ["eggs", "junk"] } }, { l: ["huevos", ""] }).fields.l, ["eggs", ""]);
});
