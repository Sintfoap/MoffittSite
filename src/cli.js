// Signing in from a terminal (the sintfoap command in cli/), without typing a
// password into it. It works like a TV signing in to a streaming service:
//
//   1. The terminal asks for a code:   POST /login/cli/start   {name}
//        → {device_code, user_code, verification_uri, verification_uri_complete, interval, expires_in}
//   2. The person opens /login/cli in a browser, signs in there as usual
//      (password, then two-factor if they have it) and approves that code.
//   3. The terminal polls:             POST /login/cli/token   {device_code}
//        → 400 {error: "authorization_pending" | "access_denied" | "expired_token"}
//        → 200 {token, username, display_name, expires_in}
//
// The token is an ordinary session (src/auth.js), sent by the terminal as the
// __Host-sid cookie. So it expires like any session, shows up in the session
// count, and "Sign out everywhere" or a password change ends it too.
//
//   GET /login/cli/me          → {username, display_name, areas} for whoever the token belongs to.
//   GET /login/cli/dashboard   → what /dashboard shows, for the terminal dashboard (cli/).

import { db, now } from "./db.js";
import { randomBytes, randomToken, sha256 } from "./crypto.js";
import { createSession, currentSession, clientIp, getUser, recoveryCodesLeft, APPS } from "./auth.js";
import { sameOrigin } from "./account.js";
import { agenda, visitorNow } from "./drift.js";
import { installed } from "./store.js";
import { html, page, esc, messagePage } from "./pages.js";

export const CLI_PATHS = /^\/login\/cli(\/|$)/;

const CODE_TTL = 10 * 60;      // how long the code in the terminal works
const POLL_EVERY = 5;          // seconds the terminal waits between polls
const PENDING_PER_IP = 5;      // codes one address can have waiting at once
// No 0/O, 1/I/L: the code is read off one screen and typed into another.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const redirect = to => new Response(null, { status: 303, headers: { Location: to, "Cache-Control": "no-store" } });

function newUserCode() {
  let out = "";
  while (out.length < 8) {
    for (const b of randomBytes(16)) {
      // Drop bytes past the last full multiple of the alphabet, so every letter is equally likely.
      if (b < 256 - (256 % ALPHABET.length) && out.length < 8) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out.slice(0, 4) + "-" + out.slice(4);
}

// "kq7m 4txp", "KQ7M4TXP" and "KQ7M-4TXP" are all the same code.
function normalizeCode(raw) {
  const s = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 8 ? s.slice(0, 4) + "-" + s.slice(4) : "";
}

async function body(request) {
  const text = await request.text();
  if (text.length > 4096) return null;
  if (!text) return {};
  const type = request.headers.get("Content-Type") || "";
  try { return type.includes("application/json") ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text)); }
  catch { return null; }
}

export async function handleCli(request, env) {
  const { pathname } = new URL(request.url);
  const method = request.method;
  try {
    if (pathname === "/login/cli/start") return method === "POST" ? await start(request, env) : json({ error: "method not allowed" }, 405);
    if (pathname === "/login/cli/token") return method === "POST" ? await token(request, env) : json({ error: "method not allowed" }, 405);
    if (pathname === "/login/cli/me") return method === "GET" ? await me(request, env) : json({ error: "method not allowed" }, 405);
    if (pathname === "/login/cli/dashboard") return method === "GET" ? await dashboard(request, env) : json({ error: "method not allowed" }, 405);
    if (pathname === "/login/cli" || pathname === "/login/cli/") return await approvePage(request, env, method);
    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error("cli login error:", e);
    return pathname.startsWith("/login/cli/") ? json({ error: "server error" }, 500)
      : messagePage("Something went wrong", "The sign-in service isn't working right now.", { status: 500 });
  }
}

// ── the terminal's side ────────────────────────────────────────────────────
async function start(request, env) {
  const b = await body(request);
  if (!b) return json({ error: "invalid request" }, 400);
  const d = await db(env), t = now(), ip = clientIp(request);
  await d.prepare("DELETE FROM cli_logins WHERE expires_at <= ?").bind(t).run();
  const { n } = await d.prepare("SELECT COUNT(*) AS n FROM cli_logins WHERE ip = ? AND status = 'pending'").bind(ip).first();
  if (n >= PENDING_PER_IP) return json({ error: "too many sign-ins waiting; finish or wait for one to expire" }, 429);

  const deviceCode = randomToken(32), userCode = newUserCode();
  const name = String(b.name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60) || "a terminal";
  await d.prepare("INSERT INTO cli_logins (code_hash, user_code, status, user_id, name, ip, created_at, expires_at) VALUES (?, ?, 'pending', NULL, ?, ?, ?, ?)")
    .bind(await sha256(deviceCode), userCode, name, ip, t, t + CODE_TTL).run();
  const origin = new URL(request.url).origin;
  return json({
    device_code: deviceCode, user_code: userCode,
    verification_uri: `${origin}/login/cli`,
    verification_uri_complete: `${origin}/login/cli?code=${userCode}`,
    interval: POLL_EVERY, expires_in: CODE_TTL,
  });
}

async function token(request, env) {
  const b = await body(request);
  const deviceCode = String(b?.device_code ?? "");
  if (!deviceCode || deviceCode.length > 100) return json({ error: "invalid request" }, 400);
  const d = await db(env), hash = await sha256(deviceCode);
  const row = await d.prepare("SELECT * FROM cli_logins WHERE code_hash = ?").bind(hash).first();
  if (!row || row.expires_at <= now()) return json({ error: "expired_token" }, 400);
  if (row.status === "pending") return json({ error: "authorization_pending" }, 400);
  // Approved or denied, the code is used up either way.
  await d.prepare("DELETE FROM cli_logins WHERE code_hash = ?").bind(hash).run();
  if (row.status !== "approved") return json({ error: "access_denied" }, 400);
  const user = await getUser(env, { id: row.user_id });
  if (!user || user.disabled) return json({ error: "access_denied" }, 400);
  const s = await createSession(env, request, user.id);
  return json({ token: s.token, username: user.username, display_name: user.display_name, expires_in: s.maxAge });
}

async function me(request, env) {
  const s = await currentSession(env, request);
  if (!s) return json({ error: "not signed in" }, 401);
  const { user } = s;
  return json({ username: user.username, display_name: user.display_name, areas: [...user.areas].sort() });
}

// The same things /dashboard shows: the apps this account's areas give it and
// the account summary, plus what the account page would nag about.
async function dashboard(request, env) {
  const s = await currentSession(env, request);
  if (!s) return json({ error: "not signed in" }, 401);
  const { user } = s, origin = new URL(request.url).origin;
  const d = await db(env);
  const sessions = (await d.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND stage = 'full'").bind(user.id).first()).n;
  // Same rule as protect(): until setup is finished, the site only offers /account.
  const setup = user.must_change_pw ? "choose a new password" : user.areas.has("admin") && !user.totp_secret ? "set up two-factor" : null;
  const drift = !setup && user.areas.has("todo"), clock = visitorNow(request);
  let today = null;
  if (drift) {
    try {
      const a = await agenda(env, user, clock.day);
      const out = it => ({ title: it.title, collection: it.collection, when: it.when, start: it.start });
      today = { late: a.late.map(out), due: a.due.map(out), url: origin + "/todo/" };
    } catch (e) { console.error("dashboard agenda failed:", e); }
  }
  return json({
    site: origin,
    user: { username: user.username, display_name: user.display_name, admin: user.areas.has("admin") },
    apps: setup ? [] : APPS.filter(a => user.areas.has(a.area)).map(a => ({ name: a.name, blurb: a.blurb, url: origin + a.href })),
    account: {
      two_factor: !!user.totp_secret, sessions, recovery_codes_left: await recoveryCodesLeft(env, user.id),
      email: user.email || null, email_confirmed: !!user.email_verified, setup_needed: setup, url: origin + "/account",
      plugins_installed: drift ? (await installed(env, user.id)).length : null,
    },
    // The web dashboard's Today card: open Drift items due today and overdue.
    // null for accounts without Drift (or while setup is needed).
    date: clock.label,
    today,
  });
}

// ── the browser's side ─────────────────────────────────────────────────────
async function approvePage(request, env, method) {
  const url = new URL(request.url);
  const s = await currentSession(env, request);
  if (!s) return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  const { user } = s;
  // Same rule as protect(): finish account setup before handing out new sign-ins.
  if (user.must_change_pw || (user.areas.has("admin") && !user.totp_secret)) return redirect("/account");

  if (method === "GET" || method === "HEAD") {
    const code = normalizeCode(url.searchParams.get("code"));
    return html(approveHtml({ user, code, row: code ? await pendingRow(env, code) : null }));
  }
  if (method !== "POST") return messagePage("Not allowed", "That method isn't allowed here.", { status: 405 });
  if (!sameOrigin(request)) return messagePage("Refused", "That form was sent from another website.", { status: 403 });

  const f = await body(request);
  const code = normalizeCode(f?.code);
  const row = code ? await pendingRow(env, code) : null;
  if (!row) return html(approveHtml({ user, code: "", error: "That code didn't match a terminal waiting to sign in. Codes work for 10 minutes; run sintfoap login again for a new one." }), { status: 400 });

  const d = await db(env);
  if (f.action === "deny") {
    await d.prepare("UPDATE cli_logins SET status = 'denied' WHERE code_hash = ? AND status = 'pending'").bind(row.code_hash).run();
    return messagePage("Sign-in refused", `The terminal waiting with code ${code} won't be signed in.`, { user, link: ["/dashboard", "Dashboard"] });
  }
  // Not the same as the confirmation screen: someone could send you a link with
  // their own code in it, so approving always needs this button press.
  if (f.confirm !== "yes") return html(approveHtml({ user, code, row }));
  await d.prepare("UPDATE cli_logins SET status = 'approved', user_id = ? WHERE code_hash = ? AND status = 'pending'").bind(user.id, row.code_hash).run();
  return messagePage("Terminal signed in", `${row.name} is now signed in as ${user.username}. You can go back to your terminal.`, { user, link: ["/dashboard", "Dashboard"] });
}

async function pendingRow(env, code) {
  const d = await db(env);
  return d.prepare("SELECT * FROM cli_logins WHERE user_code = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 1")
    .bind(code, now()).first();
}

function approveHtml({ user, code, row, error }) {
  const err = error ? `<div class="msg bad" role="alert">${esc(error)}</div>` : "";
  if (!row) {
    return page("Sign in a terminal", `
  <div class="kicker">Terminal</div><h1>Sign in a terminal</h1>
  <p>Run <span class="mono">sintfoap login</span>, then type the code it shows.</p>
  <form method="post" action="/login/cli" class="card">${err}
    <label for="c">Code</label><input id="c" type="text" name="code" value="${esc(code)}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH" required autofocus>
    <button type="submit">Continue</button>
  </form>`, { user });
  }
  const mins = Math.max(1, Math.ceil((row.expires_at - now()) / 60));
  return page("Sign in a terminal", `
  <div class="kicker">Terminal</div><h1>Sign in a terminal?</h1>
  <div class="card">
    <p><strong>${esc(row.name)}</strong> is asking to sign in as <span class="mono">${esc(user.username)}</span> with code</p>
    <p class="codes" style="font-size:28px;letter-spacing:3px">${esc(code)}</p>
    <p class="hint">Only approve this if you just ran <span class="mono">sintfoap login</span> yourself and this matches the code it shows. That terminal will be signed in to your account, like another browser. The code expires in ${mins} minute${mins === 1 ? "" : "s"}.</p>
    <form method="post" action="/login/cli" style="display:inline">
      <input type="hidden" name="code" value="${esc(code)}"><input type="hidden" name="confirm" value="yes">
      <button type="submit">Approve</button>
    </form>
    <form method="post" action="/login/cli" style="display:inline">
      <input type="hidden" name="code" value="${esc(code)}"><input type="hidden" name="action" value="deny">
      <button type="submit" class="quiet">Refuse</button>
    </form>
  </div>`, { user });
}
