// Recipe box's tools for the MCP server (src/mcp.js): an AI agent with an API
// key can find, read, add and change the key owner's recipes, mark the ones
// they made (with stars), and send a recipe's ingredients to a Drift list.
//
// Only accounts with Recipe box *and* its own admin toggle, "Recipe box for AI
// agents" (the `recipes-mcp` area, off until an admin turns it on), get them.
// Every tool calls the same functions as Recipe box's web API (src/recipes.js),
// so the same checks and limits apply. Deleting a recipe stays on the website.

import { db } from "./db.js";
import { BadRequest } from "./drift.js";
import { list, get, create, update, shop, importFrom, labelList, NotARecipe } from "./recipes.js";
import { ingredientTerms, ingredientHits } from "../public/recipes/ingredients.js";
import { scaleLine, factorFor, format } from "../public/recipes/scale.js";

const fail = msg => { throw new BadRequest(msg); };
const found = v => v ?? fail("recipe not found");
const ID = /^r_[0-9a-f]{10}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PAGE_DEFAULT = 50, PAGE_MAX = 200;

const needId = a => {
  const id = String(a.id ?? "");
  if (!ID.test(id)) fail("id must be a recipe id like r_0123456789 (from recipes_search)");
  return id;
};
const plain = s => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const labelText = l => `${l.key}: ${l.value}`;

// What a search result shows: enough to choose, without the steps.
const summary = (r, hits) => ({
  id: r.id, title: r.title, labels: r.labels.map(labelText), yield: r.yield || undefined, servings: r.servings ?? undefined,
  time: r.time || undefined, made: r.made || undefined, rating: r.rating || undefined, source: r.source || undefined,
  ingredients: r.ingredients.length, ...(hits ? { matching_ingredients: hits.map(i => r.ingredients[i]) } : {}),
});

// A label the agent named: its id, or "Key: Value" (case and accents don't matter).
function labelMatcher(raw, all) {
  const want = String(raw ?? "").trim();
  if (!want) fail("label must be a label id or \"Key: Value\"");
  const l = all.find(x => x.id === want) || all.find(x => plain(labelText(x)) === plain(want).replace(/\s*:\s*/, ": "));
  if (l) return r => r.labels.some(x => x.id === l.id);
  // Just a key ("Season") matches any of its values.
  const keyed = all.filter(x => plain(x.key) === plain(want));
  if (keyed.length) return r => r.labels.some(x => keyed.some(k => k.id === x.id));
  fail(`no label called ${JSON.stringify(want)}; recipes_labels lists them`);
}

async function search(env, user, a) {
  const limit = a.limit ?? PAGE_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) fail(`limit must be a whole number from 1 to ${PAGE_MAX}`);
  const cursor = a.cursor ?? "0";
  if (!/^\d{1,9}$/.test(String(cursor))) fail("cursor must be a next_cursor from a previous result");
  let box = await list(env, user);
  if (a.query != null) {
    const words = plain(a.query).split(/\s+/).filter(Boolean);
    box = box.filter(r => {
      const hay = plain([r.title, r.notes, r.time, r.yield, ...r.labels.map(labelText), ...r.ingredients].join("\n"));
      return words.every(w => hay.includes(w));
    });
  }
  let hits = null;
  if (a.ingredients != null) {
    const terms = ingredientTerms(a.ingredients);
    if (!terms.length) fail("ingredients must name at least one ingredient, like \"eggs, spinach, -nuts\"");
    hits = new Map();
    box = box.filter(r => { const h = ingredientHits(r, terms); if (h) hits.set(r.id, h); return !!h; });
  }
  if (a.labels != null) {
    if (!Array.isArray(a.labels)) fail("labels must be a list");
    const all = await labelList(await db(env));
    for (const m of a.labels.map(l => labelMatcher(l, all))) box = box.filter(m);
  }
  if (a.made === true) box = box.filter(r => r.made);
  if (a.made === false) box = box.filter(r => !r.made);
  if (a.min_rating != null) {
    if (!Number.isInteger(a.min_rating) || a.min_rating < 1 || a.min_rating > 5) fail("min_rating must be 1 to 5");
    box = box.filter(r => r.rating >= a.min_rating);
  }
  const sorts = {
    title: null,
    rating: (x, y) => y.rating - x.rating,
    made: (x, y) => (y.made || "").localeCompare(x.made || ""),
    newest: (x, y) => (y.created || "").localeCompare(x.created || ""),
  };
  if (a.sort != null && !(a.sort in sorts)) fail(`sort must be one of ${Object.keys(sorts).join(", ")}`);
  if (sorts[a.sort]) box = [...box].sort(sorts[a.sort]);
  const from = Number(cursor), page = box.slice(from, from + limit);
  const out = { recipes: page.map(r => summary(r, hits?.get(r.id))), total: box.length };
  if (from + limit < box.length) out.next_cursor = String(from + limit);
  return out;
}

async function getRecipe(env, user, a) {
  const r = found(await get(await db(env), user.id, needId(a)));
  if (a.servings == null && a.factor == null) return r;
  if (a.servings != null && !(Number(a.servings) > 0 && Number(a.servings) <= 1000)) fail("servings must be a number from 1 to 1000");
  if (a.factor != null && !(Number(a.factor) > 0 && Number(a.factor) <= 100)) fail("factor must be a number above 0, at most 100");
  const factor = factorFor(r, a);
  return {
    ...r, ingredients: r.ingredients.map(l => scaleLine(l, factor)), original_ingredients: r.ingredients,
    scaled: { factor: format(factor), servings: r.servings ? Math.round(r.servings * factor * 100) / 100 : null },
  };
}

// {url} reads the recipe off the page, like "Add from a link"; anything else sent with it replaces what was read.
async function createRecipe(env, user, a) {
  const { url, ...fields } = a;
  if (url == null) return create(env, user, fields);
  let read;
  try { read = await importFrom(url); }
  catch (e) {
    if (e instanceof NotARecipe) fail("couldn't find a recipe on that page; read it yourself and send title, ingredients and steps (and source: the link) instead");
    throw e;
  }
  return create(env, user, { ...read, ...fields });
}

const madeIt = (env, user, a) => {
  if (!DAY.test(String(a.day ?? ""))) fail("day must be YYYY-MM-DD, the day it was made");
  return update(env, user, needId(a), { made: a.day, ...(a.rating != null ? { rating: a.rating } : {}) });
};

async function shopRecipe(env, user, a) {
  const { id, ...body } = a;
  return found(await shop(env, user, needId({ id }), body));
}

// ── what the agent sees ────────────────────────────────────────────────────
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const idProp = { type: "string", description: "Recipe id, like r_0123456789 (from recipes_search)" };
const FIELDS = {
  title: { type: "string", description: "Up to 200 characters." },
  source: { type: "string", description: "The link it came from." },
  image: { type: "string", description: "An https link to a picture of the dish." },
  yield: { type: "string", description: "What it makes, like \"Serves 4\" or \"24 cookies\"." },
  servings: { type: ["number", "null"], description: "How many it serves, for scaling. Read from yield when left out." },
  time: { type: "string", description: "How long it takes, like \"45 min\"." },
  ingredients: { type: "array", items: { type: "string" }, description: "One line per ingredient, amount first (\"2 cups flour\"), up to 100." },
  steps: { type: "array", items: { type: "string" }, description: "One step per line, up to 100." },
  notes: { type: "string", description: "Up to 5000 characters." },
  labels: { type: "array", items: { type: "string" }, description: "Label ids from recipes_labels (the site's one shared list; new labels can't be made here). Replaces the recipe's labels." },
};
const MINE = {
  made: { type: "string", description: "The day you last made it, YYYY-MM-DD, or \"\" for not yet." },
  rating: { type: "integer", minimum: 0, maximum: 5, description: "Your stars, 1 to 5, or 0 for none." },
};

export const RECIPE_TOOLS = [
  { name: "recipes_search", description: "Find recipes in your Recipe box. With no arguments, lists them all by title. " +
      "query matches words anywhere (title, notes, labels, ingredients); ingredients finds recipes by what's in them (\"eggs, spinach\" needs both, \"-nuts\" leaves out any with nuts) " +
      "and returns the matching lines; labels needs every label named (an id, \"Key: Value\" like \"Season: Fall\", or just a key). " +
      `Results are summaries (no steps): call recipes_get for the whole recipe. ${PAGE_DEFAULT} come at a time; pass next_cursor for more.`,
    inputSchema: obj({
      query: { type: "string" },
      ingredients: { type: "string", description: "Comma-separated; a leading - (or \"no \", \"without \") leaves out recipes with it." },
      labels: { type: "array", items: { type: "string" } },
      made: { type: "boolean", description: "true: only ones you've made; false: only ones you haven't." },
      min_rating: { type: "integer", minimum: 1, maximum: 5 },
      sort: { type: "string", enum: ["title", "rating", "made", "newest"], description: "Default title. made is most recently made first." },
      limit: { type: "integer", minimum: 1, maximum: PAGE_MAX },
      cursor: { type: "string" },
    }), run: search },
  { name: "recipes_get", description: "Read one recipe whole: ingredients, steps, notes, labels, and your made-it day and stars. " +
      "Pass servings (or factor, when the recipe doesn't say how many it serves) to get the ingredients scaled; the unscaled lines come back as original_ingredients.",
    inputSchema: obj({ id: idProp, servings: { type: "number" }, factor: { type: "number" } }, ["id"]), run: getRecipe },
  { name: "recipes_labels", description: "The site's list of recipe labels ({id, key, value}, like Season: Fall), shared by everyone. Recipes pick their labels from it by id.",
    inputSchema: obj({}), run: async env => ({ labels: await labelList(await db(env)) }) },
  { name: "recipes_create", description: "Add a recipe to your Recipe box. Send url alone to read it from the page (most recipe sites work); " +
      "fields sent with url replace what was read. Or send title (required) and the rest yourself. Returns the new recipe with its id.",
    inputSchema: obj({ url: { type: "string", description: "A recipe page's web address." }, ...FIELDS, ...MINE }), run: createRecipe },
  { name: "recipes_update", description: "Change only the fields you send on one of your recipes. Lists (ingredients, steps, labels) are replaced as a whole. " +
      "A recipe you shared on the Recipe board changes there too.",
    inputSchema: obj({ id: idProp, ...FIELDS, ...MINE }, ["id"]),
    run: async (env, user, { id, ...changes }) => found(await update(env, user, needId({ id }), changes)) },
  { name: "recipes_made_it", description: "Mark that you made a recipe on a day (it keeps the latest), and optionally give it stars. Made-it days and stars are yours alone, never shown to others.",
    inputSchema: obj({ id: idProp, day: { type: "string", description: "YYYY-MM-DD" }, rating: MINE.rating }, ["id", "day"]),
    run: async (env, user, a) => found(await madeIt(env, user, a)) },
  { name: "recipes_shop", description: "Put a recipe's ingredients, scaled, on a Drift list to shop from (needs Drift). " +
      "Without list, they go on your list called \"Shopping list\" (made if you have none). Ingredients already open on the list get the new amounts added to their notes instead of a second item. " +
      "If you have Pantry, what it has is left off and listed in have, unless pantry is false. Returns a one-line summary too.",
    inputSchema: obj({
      id: idProp, servings: { type: "number" }, factor: { type: "number" },
      lines: { type: "array", items: { type: "integer", minimum: 0 }, description: "Which ingredient lines, by index from 0. Default all." },
      list: { type: "string", description: "A Drift collection id you can add to (drift_get_state lists them)." },
      pantry: { type: "boolean", description: "false adds everything, even what Pantry has. Default true." },
    }, ["id"]), run: shopRecipe },
];
