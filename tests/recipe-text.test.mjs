// Tests for reading a recipe out of plain text, with no AI: pasted text, or
// what text recognition read off a cookbook page (a two-column one, put back
// in order first). public/recipes/read.js and columns.js, and /recipes/api/text.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Browser, makeEnv, grantApps, sqlOne } from "./helpers.mjs";
import { readRecipe } from "../public/recipes/read.js";
import { arrange } from "../public/recipes/columns.js";

// What tesseract read off a two-column cookbook page (cli/sintfoap/site.py's
// tesseract_lines): the ingredients beside the method, read straight across.
const PAGE = JSON.parse(readFileSync(new URL("./recipe-ocr-page.json", import.meta.url)));

const BANANA = `42
CLASSIC BANANA BREAD
This is the loaf my grandmother made every Sunday. Use the ripest
bananas you can find.
Makes one 9x5-inch loaf · Prep 15 min · Bake 1 hr
INGREDIENTS
3 ripe bananas, mashed
1/3 cup melted butter
3⁄4 cup sugar
1 1/2 cups all-purpose flour, plus more
for dusting
METHOD
1. Preheat the oven to 350°F (175°C) and butter a 9x5-inch
loaf pan.
2. In a bowl, mix the butter into the mashed bananas.
3. Pour into the pan and bake for 1 hour.
Tip: Add a handful of walnuts with the flour.`;

test("headings: title in capitals, yield, times added up, wrapped lines joined, tips to the notes", () => {
  const r = readRecipe(BANANA);
  assert.equal(r.title, "Classic Banana Bread");
  assert.equal(r.yield, "Makes one 9x5-inch loaf");
  assert.equal(r.servings, null, "9x5 isn't how many it serves");
  assert.equal(r.time, "1 hr 15 min");
  assert.deepEqual(r.ingredients, ["3 ripe bananas, mashed", "1/3 cup melted butter", "3/4 cup sugar", "1 1/2 cups all-purpose flour, plus more for dusting"]);
  assert.deepEqual(r.steps, ["Preheat the oven to 350°F (175°C) and butter a 9x5-inch loaf pan.", "In a bowl, mix the butter into the mashed bananas.", "Pour into the pan and bake for 1 hour."]);
  assert.equal(r.notes, "This is the loaf my grandmother made every Sunday. Use the ripest bananas you can find.\n\nTip: Add a handful of walnuts with the flour.");
  assert.deepEqual(r.check, []);
});

test("no headings: the run of amount lines is the ingredients, short lines among them too", () => {
  const r = readRecipe(`Lemon Garlic Chicken
Serves 4
2 tablespoons olive oil
4 chicken thighs
Juice of 1 lemon
Salt and pepper

Heat the oil in a large skillet. Season the
chicken with salt and pepper.
Add the chicken and cook until golden, about 8 minutes.`);
  assert.equal(r.title, "Lemon Garlic Chicken");
  assert.equal(r.servings, 4);
  assert.deepEqual(r.ingredients, ["2 tablespoons olive oil", "4 chicken thighs", "Juice of 1 lemon", "Salt and pepper"]);
  assert.deepEqual(r.steps, ["Heat the oil in a large skillet. Season the chicken with salt and pepper.", "Add the chicken and cook until golden, about 8 minutes."]);
});

test("sections in the ingredients stay as their own lines; text with no recipe gives null", () => {
  const r = readRecipe("Pasta with Tomato Sauce\nFor the sauce:\n1 can (28 oz) tomatoes\n2 tbsp butter\nFor the pasta:\n1 lb spaghetti\nDirections\nSimmer the sauce 45 minutes.\nToss with the pasta.");
  assert.deepEqual(r.ingredients, ["For the sauce:", "1 can (28 oz) tomatoes", "2 tbsp butter", "For the pasta:", "1 lb spaghetti"]);
  assert.equal(r.steps.length, 2);
  assert.equal(readRecipe("Dear diary, today was long.\nI went to the shops."), null);
  assert.equal(readRecipe(""), null);
});

test("a two-column page read across is put back in columns, the biggest type is the title, misread fractions are pointed out", () => {
  const { text, title } = arrange(PAGE);
  assert.equal(title, "CLASSIC BANANA BREAD");
  assert.ok(text.indexOf("Pinch of salt") < text.indexOf("Preheat the oven"), "the left column comes first");
  const r = readRecipe(text, { title });
  assert.equal(r.title, "Classic Banana Bread");
  assert.equal(r.ingredients.length, 7);
  assert.equal(r.ingredients[0], "3 ripe bananas, mashed");
  assert.equal(r.steps.length, 4);
  assert.match(r.steps[1], /^In a bowl, mix the butter into the mashed bananas\. Mix in the baking soda and salt\.$/);
  assert.match(r.notes, /^This is the loaf/);
  assert.ok(!/BREADS/.test(r.notes), "the running head isn't a note");
  assert.ok(r.check.length >= 2 && r.check.every(l => r.ingredients.includes(l)));
});

test("/recipes/api/text: pasted text or recognized pages, nothing saved, no key needed", async () => {
  const env = makeEnv(), ryan = new Browser(env), josh = new Browser(env);
  await ryan.signup("ryan");
  await josh.signup("josh");
  grantApps(env, "ryan", "recipes");
  const post = (b, json) => b.req("POST", "/recipes/api/text", { json });
  const pasted = await post(ryan, { text: BANANA });
  assert.equal(pasted.status, 200, pasted.text);
  assert.equal(pasted.json.recipe.title, "Classic Banana Bread");
  const paged = await post(ryan, { pages: [PAGE] });
  assert.equal(paged.status, 200, paged.text);
  assert.equal(paged.json.recipe.steps.length, 4);
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM recipes").n, 0);

  assert.match((await post(ryan, { text: "nothing to see" })).json.error, /couldn't find a recipe/);
  assert.equal((await post(ryan, {})).status, 400);
  assert.equal((await post(ryan, { pages: [[{ text: "x" }]] })).status, 400);
  assert.equal((await post(ryan, { pages: Array(5).fill(PAGE) })).status, 400);
  assert.equal((await ryan.get("/recipes/api/text")).status, 405);
  assert.equal((await ryan.req("POST", "/recipes/api/text", { json: { text: BANANA }, origin: "https://evil.test" })).status, 403);
  assert.equal((await post(josh, { text: BANANA })).status, 403, "part of Recipe box");
});

test("the page may run text recognition in a worker, from the site only", async () => {
  const env = makeEnv(), ryan = new Browser(env);
  await ryan.signup("ryan");
  grantApps(env, "ryan", "recipes");
  const csp = (await ryan.get("/recipes/")).headers.get("Content-Security-Policy");
  assert.match(csp, /worker-src 'self'/);
  assert.match(csp, /script-src 'self';/);
});
