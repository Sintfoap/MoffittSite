// Pantry's scanner app (scanner/): pairing a phone with your pantry, and
// barcodes.
//
// Pairing, without typing a password on the phone:
//   1. The Pantry page asks for a code:   POST /pantry/api/scanners → {code, link, qr, qr_text, expires_in}
//      link is "sintfoap-scanner://pair?site=<this site>&code=<code>", shown as a QR code.
//   2. The app scans it and sends         POST /pantry/scanner/pair {code, name} (no session) → {key, site, name, username}
//      The code works once, for 10 minutes.
//   3. The app sends its key ("ps_…") as  Authorization: Bearer <key>  on /pantry/api/…, as you, but only to
//      Pantry's own API: not its Anthropic key and not pairing (scannerUser, below; src/worker.js).
//   GET /pantry/api/scanners → {scanners: [{id, name, prefix, created, last_used}]}; DELETE /pantry/api/scanners/<id> unpairs one.
//   Losing Pantry, or the account being turned off, stops every key working; unpairing ends one for good.
//
// Barcodes:
//   GET /pantry/api/barcode/<digits>?day= → {code, product: {name, size, brand, from} | null, line}
//     product is what you said it was the last time you scanned it ("yours"), else what Open Food
//     Facts knows ("openfoodfacts"), else null (the app asks for a name). line is what it would add,
//     shaped like a receipt's line (src/pantry_receipt.js proposal), matched to what you have.
//   Adding a line with {barcode, name, size} (POST /pantry/api/add, the same as /receipt/add) remembers
//   that barcode as that item.

import { db, now } from "./db.js";
import { randomToken, sha256, randomBytes } from "./crypto.js";
import { getUser } from "./auth.js";
import { BadRequest } from "./drift.js";
import { renderSVG, renderUnicodeCompact } from "./vendor/uqr.mjs";
import { listItems } from "./pantry.js";
import { proposal } from "./pantry_receipt.js";

const fail = msg => { throw new BadRequest(msg); };
const CODE_TTL = 10 * 60;
const MAX_SCANNERS = 10;
const TOUCH_EVERY = 5 * 60;
const KEY = /^ps_[A-Za-z0-9_-]{40,60}$/;
// No 0/O, 1/I/L: the code may be typed in by hand when the camera won't read the QR code.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const stamp = () => new Date().toISOString().slice(0, 19);
const tidy = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
export const BARCODE = /^\d{6,14}$/;

function newCode() {
  let out = "";
  while (out.length < 8) for (const b of randomBytes(16)) if (b < 256 - (256 % ALPHABET.length) && out.length < 8) out += ALPHABET[b % ALPHABET.length];
  return out;
}
const normalCode = raw => String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// ── pairing ────────────────────────────────────────────────────────────────

export async function startPairing(env, user, origin) {
  const d = await db(env);
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM pantry_scanners WHERE owner = ?").bind(user.id).first();
  if (n >= MAX_SCANNERS) fail(`you can pair at most ${MAX_SCANNERS} phones; unpair one first`);
  const code = newCode();
  await d.batch([
    d.prepare("DELETE FROM pantry_pair_codes WHERE expires < ? OR owner = ?").bind(now(), user.id),
    d.prepare("INSERT INTO pantry_pair_codes (code_hash, owner, expires) VALUES (?, ?, ?)").bind(await sha256(code), user.id, now() + CODE_TTL),
  ]);
  const link = `sintfoap-scanner://pair?site=${encodeURIComponent(origin)}&code=${code}`;
  return { code: code.slice(0, 4) + "-" + code.slice(4), link, qr: renderSVG(link), qr_text: renderUnicodeCompact(link), expires_in: CODE_TTL };
}

// The app's half: a code from the page, for a key. Answers like the rest of the site's APIs.
export async function finishPairing(env, body, origin) {
  const code = normalCode(body?.code);
  if (code.length !== 8) fail("that isn't a pairing code; scan the one on your Pantry page");
  const name = tidy(body?.name, 60) || "Phone";
  const d = await db(env);
  const row = await d.prepare("SELECT owner, expires FROM pantry_pair_codes WHERE code_hash = ?").bind(await sha256(code)).first();
  if (!row || row.expires < now()) fail("that code has run out or was already used; make another on your Pantry page");
  // Used up first, so the same code can't pair two phones.
  const gone = await d.prepare("DELETE FROM pantry_pair_codes WHERE code_hash = ?").bind(await sha256(code)).run();
  if (!gone.meta.changes) fail("that code was already used; make another on your Pantry page");
  const user = await getUser(env, { id: row.owner });
  if (!user || user.disabled || !user.areas.has("pantry")) fail("that account can't use Pantry");
  const key = "ps_" + randomToken(32);
  await d.prepare("INSERT INTO pantry_scanners (id_hash, owner, name, prefix, created) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256(key), user.id, name, key.slice(0, 8), stamp()).run();
  return { key, site: origin, name, username: user.username, display_name: user.display_name || user.username };
}

export async function listScanners(env, user) {
  const { results } = await (await db(env)).prepare("SELECT id_hash, name, prefix, created, last_used FROM pantry_scanners WHERE owner = ? ORDER BY created")
    .bind(user.id).all();
  return { scanners: results.map(r => ({ id: r.id_hash.slice(0, 16), name: r.name, prefix: r.prefix, created: r.created, last_used: r.last_used })) };
}

export async function unpair(env, user, id) {
  if (!/^[0-9a-f]{16}$/.test(id)) return null;
  const res = await (await db(env)).prepare("DELETE FROM pantry_scanners WHERE owner = ? AND substr(id_hash, 1, 16) = ?").bind(user.id, id).run();
  return res.meta.changes ? listScanners(env, user) : null;
}

// Whose pantry a Bearer key opens: the user, or null (no such key, or they've lost Pantry).
export async function scannerUser(env, request) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(\S+)$/i);
  if (!m || !KEY.test(m[1])) return null;
  const d = await db(env);
  const hash = await sha256(m[1]);
  const row = await d.prepare("SELECT owner, last_used FROM pantry_scanners WHERE id_hash = ?").bind(hash).first();
  if (!row) return null;
  const user = await getUser(env, { id: row.owner });
  if (!user || user.disabled || !user.areas.has("pantry")) return null;
  const t = stamp();
  if (!row.last_used || Date.parse(t + "Z") - Date.parse(row.last_used + "Z") > TOUCH_EVERY * 1000) {
    await d.prepare("UPDATE pantry_scanners SET last_used = ? WHERE id_hash = ?").bind(t, hash).run();
  }
  return user;
}

// ── barcodes ───────────────────────────────────────────────────────────────

// "2.27 kg", "16 oz (453 g)", "12 x 355 ml" → the size of one, as the add form takes it.
export function sizeOf(quantity) {
  const q = String(quantity || "").toLowerCase();
  const m = q.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|mg|lbs?|oz|fl\.?\s*oz|ml|cl|l|gal|ct|count)\b/);
  if (!m) return "";
  let [, n, unit] = m;
  n = n.replace(",", ".");
  if (unit === "cl") return `${Math.round(Number(n) * 10)} ml`;
  if (/^fl/.test(unit)) unit = "fl oz";
  if (unit === "lbs") unit = "lb";
  if (unit === "count") unit = "ct";
  return `${n} ${unit}`;
}

async function openFoodFacts(env, code) {
  const base = env.OPEN_FOOD_FACTS_URL || "https://world.openfoodfacts.org";
  try {
    const r = await fetch(`${base}/api/v2/product/${code}.json?fields=product_name,generic_name,brands,quantity`, {
      headers: { "User-Agent": "sintfoap-pantry/1.0", Accept: "application/json" },
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
    if (!r.ok) return null;
    const out = await r.json();
    const p = out?.product;
    if (out?.status !== 1 || !p) return null;
    const brands = String(p.brands || "").split(",").map(b => tidy(b, 60)).filter(Boolean);
    let name = tidy(p.product_name || p.generic_name, 80);
    // "Great Value Whole Wheat Flour" is whole wheat flour: the brand, at the front, isn't what it is.
    for (const b of brands) if (name.toLowerCase().startsWith(b.toLowerCase() + " ")) name = name.slice(b.length).trim();
    if (!name) return null;
    name = name[0].toUpperCase() + name.slice(1).toLowerCase();
    return { name, size: sizeOf(p.quantity), brand: brands[0] || "", from: "openfoodfacts" };
  } catch (e) {
    console.error("open food facts:", e.message);
    return null;
  }
}

export async function lookUp(env, user, code, day) {
  if (!BARCODE.test(code)) fail("a barcode is 6 to 14 digits");
  const d = await db(env);
  const row = await d.prepare("SELECT data FROM pantry_products WHERE owner = ? AND code = ?").bind(user.id, code).first();
  const mine = row && JSON.parse(row.data);
  const product = mine ? { name: mine.name, size: mine.size || "", brand: mine.brand || "", from: "yours" } : await openFoodFacts(env, code);
  const { items } = await listItems(env, user, day);
  let line = null;
  if (product) {
    line = proposal({ printed: "", name: product.name, count: 1, size: product.size, food: true, price: 0 }, items, new Map(), day);
    const known = mine?.item && items.find(i => i.id === mine.item);
    if (known) {
      // Scanned before: it's that item, whatever its name now.
      const again = proposal({ printed: "", name: known.name, count: 1, size: product.size, food: true, price: 0 }, [known], new Map(), day);
      line = { ...again, name: product.name, match: { ...again.match, how: "barcode" } };
    }
  }
  return { code, product, line };
}

// After an add: this barcode is that item, called this.
export function rememberProduct(d, owner, code, item, line) {
  return d.prepare(`INSERT INTO pantry_products (owner, code, data, updated) VALUES (?, ?, ?, ?)
    ON CONFLICT (owner, code) DO UPDATE SET data = excluded.data, updated = excluded.updated`)
    .bind(owner, code, JSON.stringify({ name: tidy(line.name || item.name, 80), size: tidy(line.size, 40), brand: tidy(line.brand, 60), item: item.id }), stamp());
}
