// Accounts, sessions, login throttling and two-factor codes.
//
// Sessions live in a cookie that scripts can't read (HttpOnly), that is only
// sent over HTTPS to this exact host (__Host-, Secure) and not on cross-site
// form posts (SameSite=Lax). The database stores only a hash of each session
// id, so a copy of the database can't be used to sign in.

import { db, now } from "./db.js";
import {
  randomToken, randomBytes, hex, sha256, hashPassword, verifyPassword, MAX_ITERATIONS,
  base32, verifyTotp,
} from "./crypto.js";

export const COOKIE = "__Host-sid";
const DAY = 86400;
export const SESSION_TTL = 30 * DAY;     // hard limit
export const SESSION_IDLE = 7 * DAY;     // signed out after a week unused
const MFA_TTL = 5 * 60;                  // time to type the code after the password
const TOUCH_EVERY = 5 * 60;              // how often last_seen is written

// Every app on the site, in menu order. This is the one list the dashboard,
// the side rail on every page (src/nav.js), the admin page's access toggles
// and the terminal UI all read. Each app is its own area, so an admin turns it
// on or off per account. A new app is off for everyone until an admin turns it
// on; only apps marked `onForNew` are given to new accounts.
// `key` is the letter for its "g" shortcut; `icon` names a drawing in src/pages.js.
// (Drift's area is "todo", the name it had before it was called Drift.)
export const APPS = [
  { id: "drift", area: "todo", name: "Drift", href: "/todo/", icon: "todo", key: "d", blurb: "Your items as checklists, calendars and lists.", onForNew: true },
  { id: "admin", area: "admin", name: "Admin", href: "/admin", icon: "admin", key: "a", blurb: "Accounts, access and resets." },
  { id: "plugins", area: "plugins", name: "Plugin store", href: "/plugins/", icon: "plugins", key: "p", blurb: "Find, write and share plugins for Drift." },
  { id: "chat", area: "chat", name: "Chat", href: "/chat/", icon: "chat", key: "c", blurb: "Rooms to talk in with everyone else here." },
];

export const AREAS = APPS.map(a => a.area);                                // every area the site knows about
export const DEFAULT_AREAS = APPS.filter(a => a.onForNew).map(a => a.area); // what a new account can use
export const areaOf = id => APPS.find(a => a.id === id).area;

const RESERVED = new Set(["admin", "administrator", "root", "system", "support", "help", "login", "logout",
  "signup", "account", "dashboard", "api", "www", "mail", "moderator", "owner", "security", "null", "undefined"]);

export class AuthError extends Error {
  constructor(message, { status = 400, retryAfter } = {}) { super(message); this.status = status; this.retryAfter = retryAfter; }
}

// ── validation ─────────────────────────────────────────────────────────────
export function cleanUsername(raw) {
  const u = String(raw ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(u)) {
    throw new AuthError("Usernames are 3–32 characters: letters, numbers, - and _, starting with a letter or number.");
  }
  return u;
}

export function cleanDisplayName(raw) {
  const d = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!d || d.length > 50) throw new AuthError("Display names are 1–50 characters.");
  return d;
}

export function checkPassword(pw, username) {
  pw = String(pw ?? "");
  if (pw.length < 12) throw new AuthError("Passwords need at least 12 characters.");
  if (pw.length > 128) throw new AuthError("Passwords can be at most 128 characters.");
  if (username && pw.toLowerCase().includes(username)) throw new AuthError("Passwords can't contain your username.");
  return pw;
}

const iterationsFor = env => Math.min(MAX_ITERATIONS, Number(env.PASSWORD_ITERATIONS) || MAX_ITERATIONS);

// ── users ──────────────────────────────────────────────────────────────────
export async function getUser(env, { id, username }) {
  const d = await db(env);
  const row = id
    ? await d.prepare("SELECT * FROM users WHERE id = ?").bind(id).first()
    : await d.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
  if (!row) return null;
  const { results } = await d.prepare("SELECT area FROM user_areas WHERE user_id = ?").bind(row.id).all();
  return { ...row, areas: new Set(results.map(r => r.area)) };
}

export async function countUsers(env) {
  const d = await db(env);
  return (await d.prepare("SELECT COUNT(*) AS n FROM users").first()).n;
}

export async function adminExists(env) {
  const d = await db(env);
  return !!(await d.prepare("SELECT 1 AS x FROM user_areas WHERE area = 'admin' LIMIT 1").first());
}

export async function createUser(env, { username, displayName, password, areas = DEFAULT_AREAS }) {
  username = cleanUsername(username);
  if (RESERVED.has(username)) throw new AuthError("That username isn't available.");
  displayName = cleanDisplayName(displayName || username);
  checkPassword(password, username);
  const d = await db(env);
  if (await d.prepare("SELECT 1 AS x FROM users WHERE username = ?").bind(username).first()) {
    throw new AuthError("That username is taken.");
  }
  const id = "u_" + hex(randomBytes(8));
  const hash = await hashPassword(password, iterationsFor(env));
  await d.batch([
    d.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, username, displayName, hash, now()),
    ...areas.map(a => d.prepare("INSERT INTO user_areas (user_id, area) VALUES (?, ?)").bind(id, a)),
  ]);
  return getUser(env, { id });
}

export async function setPassword(env, userId, password, { mustChange = false } = {}) {
  const d = await db(env);
  const user = await getUser(env, { id: userId });
  checkPassword(password, user.username);
  await d.prepare("UPDATE users SET password_hash = ?, must_change_pw = ? WHERE id = ?")
    .bind(await hashPassword(password, iterationsFor(env)), mustChange ? 1 : 0, userId).run();
}

// ── login throttling ───────────────────────────────────────────────────────
// Per username: 5 free failures, then a lock of 1, 2, 4, 8, then 15 minutes.
// Per IP address: 30 failures in 15 minutes locks that address for 15 minutes.
// New accounts: 5 per address per hour.
const POLICIES = {
  user: { free: 5, window: 15 * 60, lock: n => Math.min(15 * 60, 60 * 2 ** (n - 5)) },
  ip: { free: 30, window: 15 * 60, lock: () => 15 * 60 },
  signup: { free: 5, window: 60 * 60, lock: () => 60 * 60 },
};

async function lockedFor(d, key) {
  const row = await d.prepare("SELECT locked_until FROM auth_limits WHERE key = ?").bind(key).first();
  const left = row ? row.locked_until - now() : 0;
  return left > 0 ? left : 0;
}

async function bump(d, key, policy) {
  const t = now();
  const row = await d.prepare("SELECT failures, window_start FROM auth_limits WHERE key = ?").bind(key).first();
  const fresh = !row || t - row.window_start > policy.window;
  const failures = fresh ? 1 : row.failures + 1;
  const locked = failures >= policy.free ? t + policy.lock(failures) : 0;
  await d.prepare(`INSERT INTO auth_limits (key, failures, window_start, locked_until) VALUES (?, ?, ?, ?)
                   ON CONFLICT(key) DO UPDATE SET failures = excluded.failures,
                     window_start = excluded.window_start, locked_until = excluded.locked_until`)
    .bind(key, failures, fresh ? t : row.window_start, locked).run();
}

const clear = (d, key) => d.prepare("DELETE FROM auth_limits WHERE key = ?").bind(key).run();

function tooMany(seconds) {
  const m = Math.ceil(seconds / 60);
  return new AuthError(`Too many attempts. Try again in ${m} minute${m === 1 ? "" : "s"}.`, { status: 429, retryAfter: seconds });
}

export const clientIp = request => request.headers.get("CF-Connecting-IP") || "unknown";

// A fixed hash to check against when the username doesn't exist, so a wrong
// username costs the same one hash as a wrong password and reveals nothing.
const DUMMY_HASH = "pbkdf2-sha256$100000$jVvohoIoxGO0x74WVPnJOA$b_O_8QhgjaH6uEyQiq3P5AE9V1hlr_hXSkPiJ2dfi3k";

// Checks a username and password. Returns the user, or throws AuthError.
export async function checkLogin(env, request, rawUsername, password) {
  const d = await db(env);
  const username = String(rawUsername ?? "").trim().toLowerCase().slice(0, 64);
  const ipKey = "ip:" + clientIp(request), userKey = "user:" + username;
  const wait = Math.max(await lockedFor(d, ipKey), await lockedFor(d, userKey));
  if (wait) throw tooMany(wait);

  const user = username ? await getUser(env, { username }) : null;
  const { ok, iterations } = await verifyPassword(String(password ?? "").slice(0, 256), user?.password_hash || DUMMY_HASH);
  if (!user || !ok || user.disabled) {
    await bump(d, userKey, POLICIES.user);
    await bump(d, ipKey, POLICIES.ip);
    throw new AuthError(user?.disabled && ok ? "This account is disabled." : "Wrong username or password.", { status: 401 });
  }
  await clear(d, userKey);
  if (iterations !== iterationsFor(env)) {   // re-hash when the strength setting changed
    await d.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(password, iterationsFor(env)), user.id).run();
  }
  return user;
}

export async function checkSignupAllowed(env, request) {
  if (String(env.SIGNUPS || "").toLowerCase() !== "open") throw new AuthError("New accounts are closed right now.", { status: 403 });
  const max = Number(env.MAX_USERS) || 100;
  if (await countUsers(env) >= max) throw new AuthError("This site isn't taking new accounts right now.", { status: 403 });
  const d = await db(env);
  const wait = await lockedFor(d, "signup:" + clientIp(request));
  if (wait) throw tooMany(wait);
}

export async function recordSignup(env, request) {
  await bump(await db(env), "signup:" + clientIp(request), POLICIES.signup);
}

// ── sessions ───────────────────────────────────────────────────────────────
export async function createSession(env, request, userId, stage = "full") {
  const d = await db(env), t = now(), token = randomToken(32);
  const ttl = stage === "full" ? SESSION_TTL : MFA_TTL;
  await d.prepare("INSERT INTO sessions (id_hash, user_id, stage, created_at, last_seen, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(await sha256(token), userId, stage, t, t, t + ttl, (request.headers.get("User-Agent") || "").slice(0, 200)).run();
  return { token, maxAge: ttl };
}

export function readCookie(request, name = COOKIE) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name.replace(/[-]/g, "\\-")}=([^;]+)`));
  return m ? m[1] : null;
}

export const sessionCookie = ({ token, maxAge }) =>
  `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
export const clearCookie = () => `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

// Returns { session, user } for the request's cookie, or null.
export async function currentSession(env, request, { stage = "full" } = {}) {
  const token = readCookie(request);
  if (!token || token.length > 100) return null;
  const d = await db(env), t = now(), idHash = await sha256(token);
  const s = await d.prepare("SELECT * FROM sessions WHERE id_hash = ?").bind(idHash).first();
  if (!s || s.stage !== stage) return null;
  if (s.expires_at <= t || (stage === "full" && t - s.last_seen > SESSION_IDLE)) {
    await d.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(idHash).run();
    return null;
  }
  const user = await getUser(env, { id: s.user_id });
  if (!user || user.disabled) return null;
  if (t - s.last_seen > TOUCH_EVERY) await d.prepare("UPDATE sessions SET last_seen = ? WHERE id_hash = ?").bind(t, idHash).run();
  return { session: s, user };
}

export async function endSession(env, request) {
  const token = readCookie(request);
  if (token) await (await db(env)).prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(token)).run();
}

export async function endUserSessions(env, userId, { exceptHash } = {}) {
  const d = await db(env);
  await (exceptHash
    ? d.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?").bind(userId, exceptHash)
    : d.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId)).run();
}

// ── two-factor ─────────────────────────────────────────────────────────────
export async function startTotp(env, userId) {
  const secret = base32(randomBytes(20));
  await (await db(env)).prepare("UPDATE users SET totp_pending = ? WHERE id = ?").bind(secret, userId).run();
  return secret;
}

export const otpauthUri = (username, secret) =>
  `otpauth://totp/${encodeURIComponent("sintfoap.xyz:" + username)}?secret=${secret}&issuer=sintfoap.xyz&algorithm=SHA1&digits=6&period=30`;

// Confirms setup with a code from the app; returns new recovery codes (shown once).
export async function confirmTotp(env, user, code) {
  if (!user.totp_pending) throw new AuthError("Start two-factor setup again.");
  const step = await verifyTotp(user.totp_pending, code);
  if (step === null) throw new AuthError("That code didn't match. Check the time on your phone and try the newest code.");
  const d = await db(env);
  await d.prepare("UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = ? WHERE id = ?").bind(step, user.id).run();
  return replaceRecoveryCodes(env, user.id);
}

export async function replaceRecoveryCodes(env, userId) {
  const d = await db(env);
  const codes = Array.from({ length: 10 }, () => {
    const s = base32(randomBytes(7)).slice(0, 10).toLowerCase();
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  await d.batch([
    d.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(userId),
    ...await Promise.all(codes.map(async c =>
      d.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)").bind(userId, await sha256(c)))),
  ]);
  return codes;
}

// Recovery codes outlive two-factor (they also reset a forgotten password),
// so turning it off yourself keeps them. An admin reset removes both.
export async function disableTotp(env, userId, { keepRecoveryCodes = false } = {}) {
  const d = await db(env);
  await d.batch([
    d.prepare("UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = 0 WHERE id = ?").bind(userId),
    ...keepRecoveryCodes ? [] : [d.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(userId)],
  ]);
}

// "abcde-fghij", "ABCDEFGHIJ" or " abcde fghij " → "abcde-fghij"; anything else → null.
function recoveryForm(raw) {
  const c = String(raw ?? "").trim().toLowerCase().replace(/[\s-]/g, "");
  return /^[a-z2-7]{10}$/.test(c) ? `${c.slice(0, 5)}-${c.slice(5)}` : null;
}

// Checks a 6-digit code or a recovery code (each recovery code works once).
// Throttled like passwords. Returns "totp" or "recovery", or throws.
export async function checkSecondFactor(env, request, user, raw) {
  const d = await db(env), key = "mfa:" + user.id, ipKey = "ip:" + clientIp(request);
  const wait = Math.max(await lockedFor(d, key), await lockedFor(d, ipKey));
  if (wait) throw tooMany(wait);
  const code = String(raw ?? "").trim().toLowerCase();

  const step = user.totp_secret ? await verifyTotp(user.totp_secret, code, user.totp_last_step) : null;
  if (step !== null) {
    // Only one request can claim a given step, even if two arrive at once.
    const r = await d.prepare("UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?").bind(step, user.id, step).run();
    if (r.meta.changes) { await clear(d, key); return "totp"; }
  } else if (recoveryForm(code)) {
    const norm = recoveryForm(code);
    const r = await d.prepare("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
      .bind(now(), user.id, await sha256(norm)).run();
    if (r.meta.changes) { await clear(d, key); return "recovery"; }
  }
  await bump(d, key, POLICIES.user);
  await bump(d, ipKey, POLICIES.ip);
  throw new AuthError("That code didn't work.", { status: 401 });
}

export async function recoveryCodesLeft(env, userId) {
  return (await (await db(env)).prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL").bind(userId).first()).n;
}

// ── forgotten username or password ─────────────────────────────────────────
// Accounts have no email address, so a recovery code is what proves who you
// are. Each code belongs to one account, so it also tells you your username.
// Accounts with two-factor need a code from the app as well, so a recovery
// code on its own (say, from a leaked notes file) can't take over the account.
// Returns the user, now with the new password and signed out everywhere.
export async function resetWithRecoveryCode(env, request, { recoveryCode, appCode, password }) {
  const d = await db(env), ipKey = "ip:" + clientIp(request);
  const ipWait = await lockedFor(d, ipKey);
  if (ipWait) throw tooMany(ipWait);

  const norm = recoveryForm(recoveryCode), hash = norm && await sha256(norm);
  const row = hash && await d.prepare("SELECT user_id FROM recovery_codes WHERE code_hash = ? AND used_at IS NULL").bind(hash).first();
  const user = row ? await getUser(env, { id: row.user_id }) : null;
  const userKey = user && "mfa:" + user.id;
  const failed = async () => {
    await bump(d, ipKey, POLICIES.ip);
    if (userKey) await bump(d, userKey, POLICIES.user);
    return new AuthError(user?.totp_secret ? "That recovery code or app code didn't work." : "That recovery code didn't work.", { status: 401 });
  };
  if (!user || user.disabled) throw await failed();
  const userWait = await lockedFor(d, userKey);
  if (userWait) throw tooMany(userWait);

  let step = null;
  if (user.totp_secret) {
    step = await verifyTotp(user.totp_secret, appCode, user.totp_last_step);
    if (step === null) throw await failed();
  }
  checkPassword(password, user.username);

  // Spend the recovery code (and app code) first, so two requests racing with
  // the same codes can't both reset the password.
  const used = await d.prepare("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL").bind(now(), user.id, hash).run();
  if (!used.meta.changes) throw await failed();
  if (step !== null) await d.prepare("UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?").bind(step, user.id, step).run();

  await setPassword(env, user.id, password);
  await endUserSessions(env, user.id);
  await clear(d, userKey);
  await clear(d, "user:" + user.username);
  return user;
}

// ── email ──────────────────────────────────────────────────────────────────
// An address is optional. It only counts for password resets once its owner
// opens the confirmation link, so nobody can point resets at an address they
// don't control. Links carry a random token; the database keeps its hash.
const VERIFY_TTL = DAY, RESET_TTL = 60 * 60;
const MAIL_POLICIES = {
  ip: { free: 10, window: 60 * 60, lock: () => 60 * 60 },     // emails asked for per address per hour
  to: { free: 3, window: 60 * 60, lock: () => 60 * 60 },      // emails sent to one inbox per hour
};

export function cleanEmail(raw) {
  const e = String(raw ?? "").trim().toLowerCase();
  if (e.length > 254 || !/^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(e)) throw new AuthError("That doesn't look like an email address.");
  return e;
}

async function emailToken(d, userId, purpose, email, ttl) {
  const token = randomToken(32);
  await d.prepare("INSERT INTO email_tokens (token_hash, user_id, purpose, email, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256(token), userId, purpose, email, now() + ttl).run();
  return token;
}

async function findEmailToken(d, token, purpose) {
  if (!token || String(token).length > 100) return null;
  return d.prepare("SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > ?")
    .bind(await sha256(String(token)), purpose, now()).first();
}

// Counts an email about to be sent; throws once a sender or inbox has had enough.
async function mailAllowed(d, request, email) {
  const keys = [["mailip:" + clientIp(request), MAIL_POLICIES.ip], ["mailto:" + email, MAIL_POLICIES.to]];
  for (const [key] of keys) { const wait = await lockedFor(d, key); if (wait) throw tooMany(wait); }
  for (const [key, policy] of keys) await bump(d, key, policy);
}

// Sets (or, with an empty address, removes) a user's email. Returns a
// confirmation token to email to the new address, or null when removed.
export async function setEmail(env, request, userId, raw) {
  const d = await db(env);
  const email = String(raw ?? "").trim() ? cleanEmail(raw) : null;
  if (email) await mailAllowed(d, request, email);
  await d.batch([
    d.prepare("UPDATE users SET email = ?, email_verified = 0 WHERE id = ?").bind(email, userId),
    d.prepare("DELETE FROM email_tokens WHERE user_id = ?").bind(userId),
  ]);
  return email ? emailToken(d, userId, "verify", email, VERIFY_TTL) : null;
}

// Opening the confirmation link. Returns the user, or null if the link is
// stale (expired, used, or for an address the account no longer has).
export async function confirmEmail(env, token) {
  const d = await db(env);
  const row = await findEmailToken(d, token, "verify");
  if (!row) return null;
  await d.prepare("DELETE FROM email_tokens WHERE token_hash = ?").bind(row.token_hash).run();
  const r = await d.prepare("UPDATE users SET email_verified = 1 WHERE id = ? AND email = ?").bind(row.user_id, row.email).run();
  return r.meta.changes ? getUser(env, { id: row.user_id }) : null;
}

// "Forgot username or password" by email. Returns [{ user, token }] for every
// enabled account with that confirmed address (one inbox can have several),
// and an empty list otherwise; callers answer the same either way.
export async function startEmailReset(env, request, raw) {
  const d = await db(env);
  let email;
  try { email = cleanEmail(raw); } catch { return []; }
  await mailAllowed(d, request, email);
  const { results } = await d.prepare("SELECT id FROM users WHERE email = ? AND email_verified = 1 AND disabled = 0").bind(email).all();
  return Promise.all(results.map(async ({ id }) => ({
    user: await getUser(env, { id }), token: await emailToken(d, id, "reset", email, RESET_TTL),
  })));
}

// The user a reset link belongs to, or null if the link no longer works.
export async function emailResetUser(env, token) {
  const d = await db(env);
  const row = await findEmailToken(d, token, "reset");
  const user = row && await getUser(env, { id: row.user_id });
  return user && !user.disabled && user.email_verified && user.email === row.email ? user : null;
}

// Finishes a reset from an emailed link. Accounts with two-factor also need
// an app code or a recovery code, so an email inbox alone can't take one over.
export async function resetWithEmailToken(env, request, { token, code, password }) {
  const d = await db(env);
  const ipWait = await lockedFor(d, "ip:" + clientIp(request));
  if (ipWait) throw tooMany(ipWait);
  const user = await emailResetUser(env, token);
  if (!user) {
    await bump(d, "ip:" + clientIp(request), POLICIES.ip);
    throw new AuthError("This reset link has expired or was already used. Ask for a new one.", { status: 400 });
  }
  checkPassword(password, user.username);
  if (user.totp_secret) await checkSecondFactor(env, request, user, code);
  const used = await d.prepare("DELETE FROM email_tokens WHERE token_hash = ? AND purpose = 'reset'").bind(await sha256(String(token))).run();
  if (!used.meta.changes) throw new AuthError("This reset link was already used.", { status: 400 });
  await d.prepare("DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'reset'").bind(user.id).run();
  await setPassword(env, user.id, password);
  await endUserSessions(env, user.id);
  await clear(d, "user:" + user.username);
  return user;
}
