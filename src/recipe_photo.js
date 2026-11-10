// Recipe box: a recipe read from a photo (a recipe card, a cookbook page, a
// screenshot) by Claude. Nothing is saved here: the page and the terminal show
// what was read in the recipe editor, and saving it is an ordinary new recipe.
//
// /recipes/api/photo   POST {images: [{data (base64)}, ...]} → {recipe}: up to 4 pictures of one recipe
// /recipes/api/key     PUT {key} → {photo}; DELETE → {photo}
//
// It reads with the person's own Anthropic API key, the one Sweep uses
// (src/sweep.js): added once, on either page, sealed under CHAT_BRIDGE_KEY and
// never sent back. RECIPES_MODEL picks the model (SWEEP_MODEL, then Sweep's
// default, if it isn't set).

import { db } from "./db.js";
import { BadRequest } from "./drift.js";
import { bridgeReady } from "./bridges.js";
import { imageType } from "./food.js";
import { keyOf, setKey, dropKey, askClaude, SweepError, DEFAULT_MODEL } from "./sweep.js";
import { servingsOf } from "../public/recipes/scale.js";

const fail = msg => { throw new BadRequest(msg); };
const isObj = v => v && typeof v === "object" && !Array.isArray(v);

// Anthropic takes pictures of up to 5 MB of base64 (3.75 MB of picture).
export const LIMITS = { images: 4, imageBytes: 3_750_000, body: 16 * 1024 * 1024, title: 200, yield: 100, time: 50, lines: 100, ingredient: 300, step: 3000, notes: 5000 };

// Whether photo import can run for this account: {ready, sealing, key: {hint, added_at} | null}.
export async function photoState(env, user) {
  const sealing = bridgeReady(env);
  const key = sealing ? await (await db(env)).prepare("SELECT hint, added_at FROM sweep_keys WHERE user_id = ?").bind(user.id).first() : null;
  return { ready: !!key, sealing, key: key || null };
}

export async function saveKey(env, user, body) {
  await setKey(env, user, body);
  return { photo: await photoState(env, user) };
}

export async function forgetKey(env, user) {
  await dropKey(env, user);
  return { photo: await photoState(env, user) };
}

function decode(data) {
  const s = String(data ?? "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!s || !/^[A-Za-z0-9+/]+=*$/.test(s)) fail("send each picture as base64");
  let bytes;
  try { bytes = Uint8Array.from(atob(s), c => c.charCodeAt(0)); } catch { fail("send each picture as base64"); }
  return { s, bytes };
}

const SYSTEM = `You read photos of recipes (recipe cards, handwritten notes, cookbook pages, screenshots of recipe apps or websites) and write out the recipe in them, for someone saving it to their recipe box.

Write down what the photo says rather than improving it: keep their amounts, units, wording and spelling of ingredients, and fix only obvious reading slips. Each ingredient is one line with its amount ("2 cups flour"). Each step is one line; drop the step numbers. Section headings in an ingredient list ("For the sauce:") stay as their own line. If there are several pictures, they're pages of the same recipe in order.

servings is the number of servings as a number, or 0 if the recipe doesn't say. yield is what it says it makes, as written ("Serves 4", "2 dozen cookies"), or "". time is the total time as written ("1 hr 15 min"), adding prep and cook when only those are given, or "". notes holds anything else worth keeping: tips, variations, oven temperatures said apart from the steps, who the recipe is from. Leave out anything you can't read rather than guessing.

If there's no recipe in the pictures, set found to false, leave the rest empty, and say what you see instead in notes in a few words.`;

const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["found", "title", "servings", "yield", "time", "ingredients", "steps", "notes"],
  properties: {
    found: { type: "boolean" },
    title: { type: "string" },
    servings: { type: "number" },
    yield: { type: "string" },
    time: { type: "string" },
    ingredients: { type: "array", items: { type: "string" } },
    steps: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
};

const tidy = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, n);
const tidyLines = (v, n) => (Array.isArray(v) ? v : []).map(x => tidy(x, n).replace(/\s+/g, " ")).filter(Boolean).slice(0, LIMITS.lines);

// Claude's answer as a recipe draft (the fields the editor takes), or null if it found none.
export function draftFrom(found) {
  if (!isObj(found) || !found.found) return null;
  const r = {
    title: tidy(found.title, LIMITS.title) || "Untitled recipe",
    yield: tidy(found.yield, LIMITS.yield),
    time: tidy(found.time, LIMITS.time),
    ingredients: tidyLines(found.ingredients, LIMITS.ingredient),
    steps: tidyLines(found.steps, LIMITS.step).map(l => l.replace(/^(?:step\s*)?\d+[.):]\s+/i, "")),
    notes: tidy(found.notes, LIMITS.notes),
    source: "",
  };
  const n = Number(found.servings);
  r.servings = n > 0 && n <= 1000 ? Math.round(n * 100) / 100 : servingsOf(r.yield);
  if (!r.ingredients.length && !r.steps.length) return null;
  return r;
}

export async function readPhoto(env, user, body) {
  if (!isObj(body)) fail("body must be a JSON object");
  const list = Array.isArray(body.images) ? body.images : body.image != null ? [{ data: body.image }] : [];
  if (!list.length) fail("send {images: [{data}, ...]}: a picture of the recipe, as base64");
  if (list.length > LIMITS.images) fail(`send at most ${LIMITS.images} pictures of one recipe`);
  const content = [];
  for (const img of list) {
    const { s, bytes } = decode(isObj(img) ? img.data : img);
    if (bytes.length > LIMITS.imageBytes) fail(`that picture is too big (at most ${Math.round(LIMITS.imageBytes / 1e6 * 10) / 10} MB); make it smaller first`);
    const type = imageType(bytes);
    if (!type) fail("that isn't a JPEG, PNG, WebP or GIF picture");
    content.push({ type: "image", source: { type: "base64", media_type: type, data: s } });
  }
  const key = await keyOf(env, user);
  if (!key) fail("add your Anthropic API key first: the photo is read with it");
  content.push({ type: "text", text: list.length > 1 ? `These ${list.length} pictures are one recipe. Write it out.` : "Write out the recipe in this picture." });
  let reply;
  try {
    reply = await askClaude(key, {
      model: env.RECIPES_MODEL || env.SWEEP_MODEL || DEFAULT_MODEL, max_tokens: 16000,
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM, messages: [{ role: "user", content }],
    }, "that photo");
  } catch (e) {
    // Sweep's page has the key form below its message; here, the next try asks for one.
    if (e instanceof SweepError && /didn't accept your API key/.test(e.message)) throw new SweepError("Anthropic didn't accept your API key. Try again to add a new one.");
    throw e;
  }
  let found;
  try { found = JSON.parse(reply); } catch { throw new SweepError("Claude's answer couldn't be read."); }
  const recipe = draftFrom(found);
  if (!recipe) fail(`couldn't find a recipe in that picture${found?.notes ? ` (Claude saw: ${tidy(found.notes, 200)})` : ""}`);
  return { recipe };
}

export async function readPhotoBody(request) {
  const raw = await request.text();
  if (raw.length > LIMITS.body) fail("those pictures are too big; send smaller ones");
  try { return JSON.parse(raw); } catch { fail("invalid JSON"); }
}
