// Small cryptographic helpers built on Web Crypto (available in Workers and Node).

const enc = new TextEncoder();

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
export const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

export const randomToken = (n = 32) => b64url(randomBytes(n));

export async function sha256(text) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))));
}

// Compares two strings without leaking, through timing, where they differ.
export function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// ── passwords ──────────────────────────────────────────────────────────────
// Stored as "pbkdf2-sha256$<iterations>$<salt>$<hash>". The iteration count
// travels with each hash, so it can be raised later without breaking old ones
// (they are re-hashed at the next successful login).
//
// Cloudflare Workers caps PBKDF2 at 100,000 iterations. On the free plan each
// request gets about 10 ms of CPU, and 100,000 iterations take ~18 ms, so the
// default can be lowered with the PASSWORD_ITERATIONS variable if logins fail
// with "exceeded resource limits".
export const MAX_ITERATIONS = 100_000;

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password, iterations = MAX_ITERATIONS) {
  iterations = Math.min(MAX_ITERATIONS, Math.max(10_000, Math.trunc(iterations)));
  const salt = randomBytes(16);
  return `pbkdf2-sha256$${iterations}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, iterations))}`;
}

// Returns { ok, iterations } — iterations lets the caller decide to re-hash.
export async function verifyPassword(password, stored) {
  const [scheme, it, salt, hash] = String(stored || "").split("$");
  const iterations = Number(it);
  if (scheme !== "pbkdf2-sha256" || !Number.isInteger(iterations) || iterations > MAX_ITERATIONS || !salt || !hash) return { ok: false, iterations: 0 };
  const got = b64url(await pbkdf2(password, fromB64url(salt), iterations));
  return { ok: safeEqual(got, hash), iterations };
}

// ── TOTP (RFC 6238, as used by authenticator apps) ─────────────────────────
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(bytes) {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0; const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export const TOTP_PERIOD = 30;

export async function totpCode(secretB32, step, digits = 6) {
  const key = await crypto.subtle.importKey("raw", fromBase32(secretB32), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(step));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = mac[mac.length - 1] & 15;
  const n = ((mac[off] & 127) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(n % 10 ** digits).padStart(digits, "0");
}

// Accepts the current 30-second step or one either side (clock drift).
// Returns the matching step, or null. Steps at or before `lastStep` are
// refused so a code can't be replayed.
export async function verifyTotp(secretB32, code, lastStep = 0, now = Date.now()) {
  code = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 1000 / TOTP_PERIOD);
  for (const s of [step - 1, step, step + 1]) {
    if (s > lastStep && safeEqual(await totpCode(secretB32, s), code)) return s;
  }
  return null;
}
