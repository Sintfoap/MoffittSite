// Translating to English: a Drift item, a Recipe box recipe or a Recipe board
// post, shown beside the original. Nothing is changed here; saving the English
// is an ordinary edit, made by the page (or the terminal) only when asked.
//
// /todo/api/items/<id>/translate       POST → {language, english, fields: {title, notes}}
// /recipes/api/recipes/<id>/translate  POST → {language, english, fields: {title, yield, time, ingredients, steps, notes}}
// /board/api/posts/<id>/translate      POST → {language, english, fields: {title, note, yield, time, ingredients, steps, notes}}
//
// language is what it was written in ("Spanish"), english is true when it
// already was, and fields hold only what had text, in the same shape (a list
// keeps its number of lines, so an ingredient stays beside its translation).
//
// It reads with Workers AI, the site's own (the "ai" binding in wrangler.jsonc;
// no key, and Cloudflare's free daily allowance covers it). TRANSLATE_MODEL, a
// Text variable, picks the model. Without the binding, or when it fails, the
// person's own Claude API key from Sweep (src/sweep.js) is used if they have one.

import { BadRequest } from "./drift.js";
import { keyOf, askClaude, SweepError, DEFAULT_MODEL } from "./sweep.js";

export const DEFAULT_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
// At most this much text goes out at once (a long recipe is about 4000).
export const MAX_CHARS = 12000;

export class TranslateError extends Error {}

const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const tidy = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, n);

// Only the fields with something in them: strings, and lists of strings.
export function textFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (Array.isArray(v)) { const l = v.map(x => String(x ?? "")); if (l.some(x => x.trim())) out[k] = l; }
    else if (typeof v === "string" && v.trim()) out[k] = v;
  }
  return out;
}

const SYSTEM = `You translate text into English for someone reading their own to-do list, calendar or recipe box.

You get a JSON object of fields. Answer with the same fields translated into natural English: the same keys, and every list with exactly as many lines as it had, line for line, in the same order. Keep numbers, amounts, units, times, temperatures, links, names of people and places, and emoji as they are; translate the words around them. A dish's name can keep its original name when English speakers use it too (paella, pho). Text that is already English stays exactly as it is. Don't add notes, explanations or quotes.

language is the language the fields were written in, named in English ("Spanish", "Japanese"); if they mix languages, the main one other than English; if they're all English, "English".`;

function schemaFor(fields) {
  const props = {};
  for (const [k, v] of Object.entries(fields)) props[k] = Array.isArray(v) ? { type: "array", items: { type: "string" } } : { type: "string" };
  return {
    type: "object", additionalProperties: false, required: ["language", "fields"],
    properties: { language: { type: "string" }, fields: { type: "object", additionalProperties: false, required: Object.keys(props), properties: props } },
  };
}

// A model's answer as JSON: an object already, or text holding one (maybe in a ``` block).
export function parseAnswer(v) {
  if (isObj(v)) return v;
  const s = String(v ?? "");
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) try { return JSON.parse(s.slice(a, b + 1)); } catch {}
  return null;
}

// The answer checked against what was sent: every field back, lists line for line.
// A field the model dropped or reshaped keeps its original text.
export function resultFrom(answer, fields) {
  if (!isObj(answer) || !isObj(answer.fields)) return null;
  const language = tidy(answer.language, 40).replace(/[."]/g, "") || "Unknown";
  const out = {};
  let changed = false;
  for (const [k, orig] of Object.entries(fields)) {
    const got = answer.fields[k];
    if (Array.isArray(orig)) {
      const ok = Array.isArray(got) && got.length === orig.length;
      out[k] = ok ? got.map((x, i) => orig[i].trim() ? tidy(x, 5000) || orig[i] : orig[i]) : orig;
    } else out[k] = typeof got === "string" && got.trim() ? tidy(got, 20000) : orig;
    if (JSON.stringify(out[k]) !== JSON.stringify(orig)) changed = true;
  }
  // Nothing came back different: it was English already.
  return changed ? { language, english: false, fields: out } : { language: "English", english: true, fields: out };
}

async function withWorkersAI(env, fields) {
  const res = await env.AI.run(env.TRANSLATE_MODEL || DEFAULT_AI_MODEL, {
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: JSON.stringify(fields) }],
    response_format: { type: "json_schema", json_schema: schemaFor(fields) },
    max_tokens: 6000, temperature: 0.1,
  });
  return parseAnswer(res?.response ?? res);
}

async function withClaude(env, key, fields) {
  const reply = await askClaude(key, {
    model: env.TRANSLATE_MODEL_CLAUDE || env.RECIPES_MODEL || env.SWEEP_MODEL || DEFAULT_MODEL, max_tokens: 16000,
    output_config: { effort: "low", format: { type: "json_schema", schema: schemaFor(fields) } },
    system: SYSTEM, messages: [{ role: "user", content: JSON.stringify(fields) }],
  }, "that text");
  return parseAnswer(reply);
}

// Whether this site can translate for this account at all.
export async function canTranslate(env, user) {
  return !!env.AI || !!(await keyOf(env, user).catch(() => null));
}

// {language, english, fields} for the fields given, or a TranslateError saying why not.
export async function translate(env, user, given) {
  const fields = textFields(given);
  if (!Object.keys(fields).length) throw new BadRequest("there's no text to translate");
  if (JSON.stringify(fields).length > MAX_CHARS) throw new BadRequest(`that's too much text to translate at once (at most ${MAX_CHARS} characters)`);

  let answer = null, failed = null;
  if (env.AI) {
    try { answer = resultFrom(await withWorkersAI(env, fields), fields); }
    catch (e) { failed = e; console.error("workers ai translate failed:", e?.message || e); }
  }
  if (!answer) {
    const key = await keyOf(env, user).catch(() => null);
    if (key) {
      try { answer = resultFrom(await withClaude(env, key, fields), fields); }
      catch (e) { failed = e; if (!env.AI && e instanceof SweepError) throw new TranslateError(e.message); }
    }
    else if (!env.AI) throw new TranslateError("Translation isn't set up on this site yet: it needs Workers AI (the \"ai\" binding in wrangler.jsonc).");
  }
  if (!answer) {
    if (failed) console.error("translate failed:", failed?.message || failed);
    throw new TranslateError("Couldn't translate that right now. Try again in a minute.");
  }
  return answer;
}

// The text of a recipe that's worth translating (its labels are the site's own list).
export const recipeText = r => ({ title: r.title, yield: r.yield, time: r.time, ingredients: r.ingredients, steps: r.steps, notes: r.notes });
