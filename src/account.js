// Routes for signing in and managing accounts:
//   /login, /login/2fa, /login/forgot, /login/reset, /login/verify-email, /signup, /logout, /dashboard, /account/*, /admin/*
// plus protect(), which guards every signed-in area of the site.

import { glance } from "./glance.js";
import { db, now } from "./db.js";
import { randomToken, safeEqual } from "./crypto.js";
import { renderSVG } from "./vendor/uqr.mjs";
import {
  AuthError, APPS, PLACES, canUse, getUser, createUser, setPassword, checkLogin, checkSignupAllowed, recordSignup,
  createSession, currentSession, endSession, endUserSessions, sessionCookie, clearCookie,
  startTotp, otpauthUri, confirmTotp, replaceRecoveryCodes, disableTotp, checkSecondFactor, recoveryCodesLeft, resetWithRecoveryCode,
  adminExists, cleanDisplayName, clientIp,
  setEmail, confirmEmail, startEmailReset, emailResetUser, resetWithEmailToken,
} from "./auth.js";
import { createKey, listKeys, revokeKey, toolSets } from "./apikeys.js";
import { mailReady, sendMail, MailError } from "./mail.js";
import { agenda, visitorNow } from "./drift.js";
import { installed } from "./store.js";
import { photosOf, dropPhotos } from "./photos.js";
import { userStats } from "./stats.js";
import {
  html, loginPage, signupPage, mfaPage, forgotPage, forgotDonePage, forgotEmailSentPage, resetPage, dashboardPage, accountPage, changePasswordRequiredPage, adminPage, adminStatsPage, adminClaimPage, messagePage,
} from "./pages.js";

const DEFAULT_NEXT = "/dashboard";

// Only same-site paths, so a crafted link can't bounce people elsewhere after login.
export function safeNext(raw) {
  const n = String(raw ?? "");
  return /^\/(?![\/\\])[^\s\u0000-\u001f]*$/.test(n) && n.length < 500 ? n : DEFAULT_NEXT;
}

// Refuses form posts and API writes that a browser says came from another site.
export function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (origin) return origin === new URL(request.url).origin;
  const site = request.headers.get("Sec-Fetch-Site");
  return !site || site === "same-origin" || site === "none";
}

const redirect = (to, cookie) => new Response(null, {
  status: 303, headers: { Location: to, "Cache-Control": "no-store", ...(cookie ? { "Set-Cookie": cookie } : {}) },
});

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function form(request) {
  if (Number(request.headers.get("Content-Length") || 0) > 16 * 1024) throw new AuthError("Request too large.", { status: 413 });
  try { return Object.fromEntries(await request.formData()); }
  catch { throw new AuthError("Couldn't read the form."); }
}

// ── protect: the gate in front of every signed-in area ─────────────────────
// Lets `inner(user)` run only for a signed-in user who may use `area`.
// Pages answer with a redirect to sign in; API calls answer with JSON errors.
export async function protect(request, env, area, inner) {
  const url = new URL(request.url);
  const api = url.pathname.includes("/api/");
  let s;
  try { s = await currentSession(env, request); }
  catch (e) { console.error("session check failed:", e); return api ? json({ error: "server error" }, 500) : messagePage("Something went wrong", "The sign-in service isn't working right now.", { status: 500 }); }

  if (!s) return api ? json({ error: "not signed in" }, 401) : redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  const { user } = s;
  if (user.must_change_pw || (user.areas.has("admin") && !user.totp_secret)) {
    return api ? json({ error: "finish setting up your account first" }, 403) : redirect("/account");
  }
  // One area, or a list of them, any of which lets the account in.
  if (![].concat(area).some(a => user.areas.has(a))) {
    return api ? json({ error: "no access" }, 403) : messagePage("No access", "Your account doesn't have access to this part of the site.", { user, status: 403 });
  }
  const res = await inner(user);
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", "private, no-store");
  return out;
}

// ── router ─────────────────────────────────────────────────────────────────
export const AUTH_PATHS = /^\/(login|signup|logout|dashboard|account|admin)(\/|$)/;

export async function handleAuth(request, env) {
  const { pathname, searchParams } = new URL(request.url);
  const method = request.method;
  if (method !== "GET" && method !== "HEAD" && method !== "POST") return messagePage("Not allowed", "That method isn't allowed here.", { status: 405 });
  if (method === "POST" && !sameOrigin(request)) return messagePage("Refused", "That form was sent from another website.", { status: 403 });
  try {
    if (pathname === "/login") return method === "POST" ? await loginPost(request, env) : await loginGet(request, env, searchParams);
    if (pathname === "/login/2fa") return await secondFactor(request, env, method, searchParams);
    if (pathname === "/login/forgot") return await forgot(request, env, method);
    if (pathname === "/login/forgot/email") return await forgotEmail(request, env, method);
    if (pathname === "/login/reset") return await emailReset(request, env, method, searchParams);
    if (pathname === "/login/verify-email") return await verifyEmail(request, env, searchParams);
    if (pathname === "/signup") return method === "POST" ? await signupPost(request, env) : await signupGet(request, env, searchParams);
    if (pathname === "/logout") { await endSession(env, request); return redirect("/login", clearCookie()); }
    if (pathname === "/dashboard" || pathname === "/dashboard/") return await dashboard(request, env);
    if (pathname === "/account" || pathname.startsWith("/account/")) return await account(request, env, pathname, method);
    if (pathname === "/admin/claim") return await adminClaim(request, env, method);
    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      return await protect(request, env, "admin", user => admin(request, env, user, pathname, method));
    }
    return messagePage("Not found", "There's nothing at this address.", { status: 404 });
  } catch (e) {
    if (e instanceof AuthError) return messagePage("Something's not right", e.message, { status: e.status });
    console.error("auth route error:", e);
    return messagePage("Something went wrong", "The sign-in service isn't working right now.", { status: 500 });
  }
}

const signupsOpen = env => String(env.SIGNUPS || "").toLowerCase() === "open";

// ── sign in ────────────────────────────────────────────────────────────────
async function loginGet(request, env, q) {
  const next = safeNext(q.get("next"));
  if (await currentSession(env, request)) return redirect(next);
  return html(loginPage({ next, signupsOpen: signupsOpen(env) }));
}

async function loginPost(request, env) {
  const f = await form(request), next = safeNext(f.next);
  let user;
  try { user = await checkLogin(env, request, f.username, f.password); }
  catch (e) {
    if (!(e instanceof AuthError)) throw e;
    return html(loginPage({ error: e.message, next, username: String(f.username ?? "").slice(0, 64), signupsOpen: signupsOpen(env) }),
      { status: e.status, headers: e.retryAfter ? { "Retry-After": String(e.retryAfter) } : {} });
  }
  await endSession(env, request);                       // never reuse a session from before sign-in
  if (user.totp_secret) return redirect(`/login/2fa?next=${encodeURIComponent(next)}`, sessionCookie(await createSession(env, request, user.id, "mfa")));
  return redirect(next, sessionCookie(await createSession(env, request, user.id)));
}

async function secondFactor(request, env, method, q) {
  const s = await currentSession(env, request, { stage: "mfa" });
  if (!s) return redirect("/login");
  if (method !== "POST") return html(mfaPage({ next: safeNext(q.get("next")) }));
  const f = await form(request), next = safeNext(f.next);
  try { await checkSecondFactor(env, request, s.user, f.code); }
  catch (e) {
    if (!(e instanceof AuthError)) throw e;
    return html(mfaPage({ error: e.message, next }), { status: e.status });
  }
  await endSession(env, request);
  return redirect(next, sessionCookie(await createSession(env, request, s.user.id)));
}

// ── forgot username or password ────────────────────────────────────────────
async function forgot(request, env, method) {
  if (method !== "POST") return html(forgotPage({ mail: mailReady(env) }));
  const f = await form(request);
  let user;
  try {
    if (String(f.new_password ?? "") !== String(f.new_password2 ?? "")) throw new AuthError("The two new passwords don't match.");
    user = await resetWithRecoveryCode(env, request, { recoveryCode: f.recovery_code, appCode: f.app_code, password: f.new_password });
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
    return html(forgotPage({ error: e.message, mail: mailReady(env) }), { status: e.status, headers: e.retryAfter ? { "Retry-After": String(e.retryAfter) } : {} });
  }
  await endSession(env, request);
  return html(forgotDonePage({ user, usedRecoveryCode: true, recoveryLeft: await recoveryCodesLeft(env, user.id) }),
    { headers: { "Set-Cookie": sessionCookie(await createSession(env, request, user.id)) } });
}

// Emails a reset link (with the username) to every account with that
// confirmed address. The answer is the same whether or not one matched.
async function forgotEmail(request, env, method) {
  if (method !== "POST" || !mailReady(env)) return redirect("/login/forgot");
  const f = await form(request), origin = new URL(request.url).origin;
  let matches;
  try { matches = await startEmailReset(env, request, f.email); }
  catch (e) {
    if (!(e instanceof AuthError)) throw e;
    return html(forgotPage({ error: e.message, mail: true }), { status: e.status });
  }
  for (const { user, token } of matches) {
    // A failed send is logged, not shown, so the page never reveals a match.
    await sendMail(env, {
      to: user.email,
      subject: "Reset your sintfoap.xyz password",
      text: `Someone asked to reset the password for your sintfoap.xyz account.\n\n` +
        `Your username is: ${user.username}\n\n` +
        `To choose a new password, open this link. It works once, for the next hour:\n${origin}/login/reset?token=${token}\n\n` +
        `If this wasn't you, you can ignore this email. Your password hasn't changed.\n`,
    }).catch(e => console.error("reset email failed:", e));
  }
  return html(forgotEmailSentPage());
}

async function emailReset(request, env, method, q) {
  if (method !== "POST") {
    const token = String(q.get("token") ?? "");
    const user = await emailResetUser(env, token);
    if (!user) return messagePage("Link expired", "This reset link has expired or was already used. Ask for a new one.", { status: 400, link: ["/login/forgot", "Forgot username or password"] });
    return html(resetPage({ token, user }));
  }
  const f = await form(request), token = String(f.token ?? "");
  let user;
  try {
    if (String(f.new_password ?? "") !== String(f.new_password2 ?? "")) throw new AuthError("The two new passwords don't match.");
    user = await resetWithEmailToken(env, request, { token, code: f.code, password: f.new_password });
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
    const u = await emailResetUser(env, token);
    if (!u) return messagePage("Link expired", e.message, { status: e.status, link: ["/login/forgot", "Forgot username or password"] });
    return html(resetPage({ token, user: u, error: e.message }), { status: e.status, headers: e.retryAfter ? { "Retry-After": String(e.retryAfter) } : {} });
  }
  await endSession(env, request);
  return html(forgotDonePage({ user, recoveryLeft: await recoveryCodesLeft(env, user.id) }),
    { headers: { "Set-Cookie": sessionCookie(await createSession(env, request, user.id)) } });
}

async function verifyEmail(request, env, q) {
  const user = await confirmEmail(env, q.get("token"));
  if (!user) return messagePage("Link expired", "This confirmation link has expired or was already used. You can send a new one from your account settings.", { status: 400, link: ["/account", "Account settings"] });
  return messagePage("Email confirmed", `${user.email} can now be used to reset the password for ${user.username}.`, { link: ["/account", "Account settings"] });
}

const sendConfirmation = (env, request, user, email, token) => sendMail(env, {
  to: email,
  subject: "Confirm your email for sintfoap.xyz",
  text: `Confirm this address for the sintfoap.xyz account ${user.username} by opening this link (it works for 24 hours):\n` +
    `${new URL(request.url).origin}/login/verify-email?token=${token}\n\n` +
    `Once confirmed, it can be used to reset that account's password. If you didn't ask for this, ignore this email.\n`,
});

// ── create an account ──────────────────────────────────────────────────────
async function signupGet(request, env, q) {
  const next = safeNext(q.get("next"));
  if (await currentSession(env, request)) return redirect(next);
  try { await checkSignupAllowed(env, request); }
  catch (e) { if (e instanceof AuthError) return html(signupPage({ closed: e.message }), { status: e.status }); throw e; }
  return html(signupPage({ next }));
}

async function signupPost(request, env) {
  const f = await form(request), next = safeNext(f.next);
  const values = { username: String(f.username ?? "").slice(0, 64), display_name: String(f.display_name ?? "").slice(0, 60) };
  let user;
  try {
    await checkSignupAllowed(env, request);
    if (String(f.password ?? "") !== String(f.password2 ?? "")) throw new AuthError("The two passwords don't match.");
    user = await createUser(env, { username: f.username, displayName: f.display_name, password: f.password });
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
    return html(signupPage({ error: e.message, next, values }), { status: e.status });
  }
  await recordSignup(env, request);
  await endSession(env, request);
  return redirect(next, sessionCookie(await createSession(env, request, user.id)));
}

// ── dashboard: home for a signed-in account ────────────────────────────────
async function dashboard(request, env) {
  const s = await currentSession(env, request);
  if (!s) return redirect(`/login?next=${encodeURIComponent("/dashboard")}`);
  const { user } = s;
  // Same rule as protect(): finish account setup before anything else.
  if (user.must_change_pw || (user.areas.has("admin") && !user.totp_secret)) return redirect("/account");
  const d = await db(env);
  const sessionCount = (await d.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND stage = 'full'").bind(user.id).first()).n;
  const { day, hour, label } = visitorNow(request);
  const drift = user.areas.has("todo");
  let agendaData = null;
  if (drift) {
    try { agendaData = await agenda(env, user, day); }
    catch (e) { console.error("dashboard agenda failed:", e); }
  }
  const apps = PLACES.filter(a => canUse(user, a));
  return html(dashboardPage({
    user, apps, glances: await glance(env, user, apps, { day, agenda: agendaData }), sessionCount, recoveryLeft: await recoveryCodesLeft(env, user.id),
    agenda: agendaData, installs: drift ? (await installed(env, user.id)).length : null, mail: mailReady(env),
    greeting: hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening",
    dateLabel: label,
  }));
}

// ── account page ───────────────────────────────────────────────────────────
async function account(request, env, pathname, method) {
  const s = await currentSession(env, request);
  if (!s) return redirect(`/login?next=${encodeURIComponent("/account")}`);
  let { user } = s;
  const show = async (extra = {}, status = 200) => {
    user = await getUser(env, { id: user.id });
    if (user.must_change_pw) return html(changePasswordRequiredPage({ user, error: extra.error }), { status });
    const d = await db(env);
    const sessionCount = (await d.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND stage = 'full'").bind(user.id).first()).n;
    const sets = toolSets(user);
    return html(accountPage({
      user, sessionCount, apiKeys: sets.length ? await listKeys(env, user.id) : null, toolSets: sets, keyNonce: randomToken(12), origin: new URL(request.url).origin, recoveryLeft: await recoveryCodesLeft(env, user.id), mail: mailReady(env),
      adminNeeds2fa: user.areas.has("admin") && !user.totp_secret, ...extra,
    }), { status });
  };
  const fail = (e, extra = {}) => { if (e instanceof AuthError) return show({ error: e.message, ...extra }, e.status); throw e; };

  if (method !== "POST") return pathname === "/account" ? show() : redirect("/account");
  const f = await form(request);

  // Someone whose password was reset can only choose a new one.
  if (user.must_change_pw && pathname !== "/account/password") return show();

  switch (pathname) {
    case "/account/profile":
      try {
        await (await db(env)).prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(cleanDisplayName(f.display_name), user.id).run();
        return show({ notice: "Display name saved." });
      } catch (e) { return fail(e); }

    case "/account/password":
      try {
        if (String(f.new_password ?? "") !== String(f.new_password2 ?? "")) throw new AuthError("The two new passwords don't match.");
        if (!user.must_change_pw) await checkLogin(env, request, user.username, f.current_password);
        await setPassword(env, user.id, f.new_password);
        await endUserSessions(env, user.id, { exceptHash: s.session.id_hash });
        return show({ notice: "Password changed. Other devices have been signed out." });
      } catch (e) {
        if (e instanceof AuthError && e.status === 401) e.message = "Your current password isn't right.";
        return fail(e);
      }

    case "/account/sessions":
      await endUserSessions(env, user.id, { exceptHash: s.session.id_hash });
      return show({ notice: "Signed out everywhere else." });

    // Setting up two-factor or recovery codes needs the password, because
    // together they can reset it: a borrowed session mustn't be enough.
    case "/account/2fa/start": {
      if (user.totp_secret) return show();
      try { await checkLogin(env, request, user.username, f.password); }
      catch (e) { return fail(passwordError(e)); }
      const secret = await startTotp(env, user.id);
      return show({ setup: setupView(user, secret) });
    }

    case "/account/2fa/confirm":
      try { return show({ recoveryCodes: await confirmTotp(env, user, f.code), notice: "Two-factor is on." }); }
      catch (e) { return fail(e, user.totp_pending ? { setup: setupView(user, user.totp_pending) } : {}); }

    case "/account/email":
      try {
        if (!mailReady(env)) throw new AuthError("Email isn't set up on this site yet.", { status: 503 });
        await checkLogin(env, request, user.username, f.password);
        const token = await setEmail(env, request, user.id, f.email);
        if (!token) return show({ notice: "Email removed." });
        const fresh = await getUser(env, { id: user.id });
        try { await sendConfirmation(env, request, fresh, fresh.email, token); }
        catch (e) {
          if (!(e instanceof MailError)) throw e;
          // Put the old address back, so a failed send changes nothing.
          console.error(e.message);
          const d = await db(env);
          await d.batch([
            d.prepare("UPDATE users SET email = ?, email_verified = ? WHERE id = ?").bind(user.email ?? null, user.email_verified ?? 0, user.id),
            d.prepare("DELETE FROM email_tokens WHERE user_id = ?").bind(user.id),
          ]);
          throw new AuthError(`The confirmation email couldn't be sent, so nothing was changed. The email service said: ${e.reason}`, { status: 502 });
        }
        return show({ notice: `We sent a link to ${fresh.email}. Open it to confirm the address.` });
      } catch (e) { return fail(passwordError(e)); }

    case "/account/recovery":
      try { await checkLogin(env, request, user.username, f.password); }
      catch (e) { return fail(passwordError(e)); }
      return show({ recoveryCodes: await replaceRecoveryCodes(env, user.id), notice: "New recovery codes made. Any old ones no longer work." });

    // Keys let an AI agent act as you in Drift, so they need the password too.
    case "/account/apikeys":
      try {
        if (!toolSets(user).length) throw new AuthError("Your account doesn't have Drift or Recipe box for AI agents.", { status: 403 });
        await checkLogin(env, request, user.username, f.password);
        const made = await createKey(env, user.id, f.name, f.nonce);
        return show({ newKey: { key: made.key, name: String(f.name).trim() } });
      } catch (e) { return fail(passwordError(e)); }

    case "/account/apikeys/revoke":
      await revokeKey(env, user.id, String(f.id ?? ""));
      return show({ notice: "Key revoked." });

    case "/account/2fa/disable":
      try {
        if (user.areas.has("admin")) throw new AuthError("Admin accounts must keep two-factor on.", { status: 403 });
        await checkLogin(env, request, user.username, f.password);
        await disableTotp(env, user.id, { keepRecoveryCodes: true });
        return show({ notice: "Two-factor is off. Your recovery codes still work for resetting your password." });
      } catch (e) { return fail(passwordError(e)); }
  }
  return redirect("/account");
}

const passwordError = e => {
  if (e instanceof AuthError && e.status === 401) e.message = "That password isn't right.";
  return e;
};

const setupView = (user, secret) => ({
  secret, qrSvg: renderSVG(otpauthUri(user.username, secret), { pixelSize: 6, border: 2 }),
});

// ── claiming admin (only while no admin exists) ────────────────────────────
async function adminClaim(request, env, method) {
  const s = await currentSession(env, request);
  if (!s) return redirect(`/login?next=${encodeURIComponent("/admin/claim")}`);
  if (await adminExists(env)) return redirect("/admin");
  const enabled = !!env.ADMIN_CLAIM_CODE;
  if (method !== "POST" || !enabled) return html(adminClaimPage({ user: s.user, enabled }));

  const f = await form(request);
  const d = await db(env), key = "claim:" + clientIp(request);
  const lock = await d.prepare("SELECT locked_until FROM auth_limits WHERE key = ?").bind(key).first();
  if (lock && lock.locked_until > now()) return html(adminClaimPage({ user: s.user, enabled, error: "Too many attempts. Try again later." }), { status: 429 });
  if (!safeEqual(f.code ?? "", env.ADMIN_CLAIM_CODE)) {
    await d.prepare(`INSERT INTO auth_limits (key, failures, window_start, locked_until) VALUES (?, 1, ?, 0)
                     ON CONFLICT(key) DO UPDATE SET failures = failures + 1,
                       locked_until = CASE WHEN failures + 1 >= 5 THEN ? ELSE 0 END`).bind(key, now(), now() + 3600).run();
    return html(adminClaimPage({ user: s.user, enabled, error: "That code isn't right." }), { status: 401 });
  }
  await d.prepare("INSERT OR IGNORE INTO user_areas (user_id, area) VALUES (?, 'admin')").bind(s.user.id).run();
  return redirect("/account");   // admins must set up two-factor next
}

// ── admin ──────────────────────────────────────────────────────────────────
// Every app in APPS gets a toggle per account on the admin page (and in the
// terminal's admin page, through /admin/api/access), so a new app needs
// nothing here: it shows up switched off for everyone.
async function setAccess(d, me, target, app, on) {
  if (target.id === me.id && app.area === "admin" && !on) throw new AuthError("You can't remove your own admin access.");
  if (on) await d.prepare("INSERT OR IGNORE INTO user_areas (user_id, area) VALUES (?, ?)").bind(target.id, app.area).run();
  else await d.prepare("DELETE FROM user_areas WHERE user_id = ? AND area = ?").bind(target.id, app.area).run();
}

// Sets which apps an account has, all at once: the ones in `ids` on, the rest
// off (your own admin access stays on). Returns {on: [names], off: [names]}, what changed.
async function setAccessAll(d, me, target, ids) {
  const want = new Set(ids.map(String));
  if (target.id === me.id) want.add("admin");
  const changed = { on: [], off: [] };
  for (const app of APPS) {
    const on = want.has(app.id);
    if (on === target.areas.has(app.area)) continue;
    await setAccess(d, me, target, app, on);
    changed[on ? "on" : "off"].push(app.name);
  }
  return changed;
}

// GET  /admin/api/access → {feedback: {total, unread, open}, apps: [{id, name, group, parent}], users: [{id, username, display_name, disabled, you, apps: [id]}]}
// POST /admin/api/access {user_id, app, on} → the same, after the change
// POST /admin/api/access {user_id, apps: [id]} → the same, with exactly those apps on
// How the feedback inbox stands, for the admin pages: {total, unread, open}.
async function feedbackCounts(d) {
  return await d.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(owner_seen IS NULL OR owner_seen < last_at), 0) AS unread,
    COALESCE(SUM(status IN ('new', 'planned')), 0) AS open FROM feedback`).first();
}

async function adminAccessApi(request, env, d, me, method) {
  const list = async () => {
    const { results } = await d.prepare(`
      SELECT u.id, u.username, u.display_name, u.disabled, (SELECT group_concat(area) FROM user_areas a WHERE a.user_id = u.id) AS areas
      FROM users u ORDER BY u.created_at`).all();
    return json({
      feedback: await feedbackCounts(d),
      apps: APPS.map(a => ({ id: a.id, name: a.name, group: a.group || "site", ...(a.parent ? { parent: a.parent } : {}) })),
      users: results.map(u => {
        const areas = new Set(u.areas ? u.areas.split(",") : []);
        return { id: u.id, username: u.username, display_name: u.display_name, disabled: !!u.disabled, you: u.id === me.id,
          apps: APPS.filter(a => areas.has(a.area)).map(a => a.id) };
      }),
    });
  };
  if (method === "GET") return list();
  if (method !== "POST") return json({ error: "method not allowed" }, 405);
  let body;
  try { body = await request.json(); } catch { return json({ error: "send JSON" }, 400); }
  const target = await getUser(env, { id: String(body?.user_id ?? "") });
  if (!target) return json({ error: "that account doesn't exist" }, 404);
  if (Array.isArray(body.apps)) {
    if (body.apps.some(id => !APPS.some(a => a.id === String(id)))) return json({ error: "unknown app" }, 400);
    await setAccessAll(d, me, target, body.apps);
    return list();
  }
  const app = APPS.find(a => a.id === String(body.app));
  if (!app) return json({ error: "unknown app" }, 400);
  try { await setAccess(d, me, target, app, body.on === true); }
  catch (e) { if (e instanceof AuthError) return json({ error: e.message }, e.status); throw e; }
  return list();
}

async function admin(request, env, me, pathname, method) {
  const d = await db(env);
  if (pathname === "/admin/api/access") return adminAccessApi(request, env, d, me, method);
  // Accounts against MAX_USERS, who's active, and what each person keeps (src/stats.js).
  if (pathname === "/admin/api/stats" || pathname === "/admin/stats") {
    if (method !== "GET") return json({ error: "method not allowed" }, 405);
    const stats = await userStats(env, d);
    return pathname === "/admin/stats" ? html(adminStatsPage({ user: me, stats })) : json(stats);
  }
  const show = async (extra = {}, status = 200) => {
    const { results: users } = await d.prepare(`
      SELECT u.id, u.username, u.display_name, u.created_at, u.disabled, u.must_change_pw, u.totp_secret IS NOT NULL AS totp,
        (SELECT group_concat(area) FROM user_areas a WHERE a.user_id = u.id) AS areas,
        (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.stage = 'full') AS sessions,
        (SELECT COUNT(*) FROM drift_items t WHERE t.owner = u.id) + (SELECT COUNT(*) FROM todo_tasks t WHERE t.owner = u.id) AS tasks
      FROM users u ORDER BY u.created_at`).all();
    const { results: orphans } = await d.prepare(`
      SELECT owner, COUNT(*) AS n FROM todo_tasks WHERE owner NOT IN (SELECT id FROM users) GROUP BY owner`).all();
    return html(adminPage({
      user: me, apps: APPS, orphans, feedback: await feedbackCounts(d),
      users: users.map(u => ({ ...u, areas: u.areas ? u.areas.split(",") : [] })), ...extra,
    }), { status });
  };
  if (method !== "POST") {
    if (pathname !== "/admin") return redirect("/admin");
    // After saving an account's apps: that account stays open, with what changed.
    const q = new URL(request.url).searchParams, saved = q.get("saved");
    const who = saved && await getUser(env, { id: saved });
    if (!who) return show();
    const on = q.get("on") ? q.get("on").split(",").filter(id => APPS.some(a => a.id === id)) : [];
    const off = q.get("off") ? q.get("off").split(",").filter(id => APPS.some(a => a.id === id)) : [];
    const names = ids => ids.map(id => APPS.find(a => a.id === id).name).join(", ");
    const notice = on.length || off.length
      ? `Saved ${who.username}'s apps.${on.length ? ` On: ${names(on)}.` : ""}${off.length ? ` Off: ${names(off)}.` : ""}`
      : `Nothing changed for ${who.username}.`;
    return show({ notice, open: who.id });
  }

  // Several apps for one account at once, from its checkboxes: back to the
  // page with that account still open, where it was (#u-<id>).
  if (pathname === "/admin/access-set") {
    let fd;
    try { fd = await request.formData(); } catch { return show({ error: "Couldn't read the form." }, 400); }
    const target = await getUser(env, { id: String(fd.get("user_id") ?? "") });
    if (!target) return show({ error: "That account doesn't exist." }, 404);
    const ids = fd.getAll("apps").map(String).filter(id => APPS.some(a => a.id === id));
    let changed;
    try { changed = await setAccessAll(d, me, target, ids); }
    catch (e) { if (e instanceof AuthError) return show({ error: e.message, open: target.id }, e.status); throw e; }
    const idsOf = names => names.map(n => APPS.find(a => a.name === n).id).join(",");
    const q = new URLSearchParams({ saved: target.id });
    if (changed.on.length) q.set("on", idsOf(changed.on));
    if (changed.off.length) q.set("off", idsOf(changed.off));
    return redirect(`/admin?${q}#u-${target.id}`);
  }

  const f = await form(request);
  const target = f.user_id ? await getUser(env, { id: String(f.user_id) }) : null;
  const needTarget = () => {
    if (!target) throw new AuthError("That account doesn't exist.", { status: 404 });
    if (target.id === me.id) throw new AuthError("Use your own account page for your account.", { status: 400 });
  };
  try {
    switch (pathname) {
      // Turns one app on or off for an account: /admin/access {user_id, app, on}
      // from the toggles, or /admin/area {user_id, area, op: grant|revoke}.
      case "/admin/access":
      case "/admin/area": {
        if (!target) throw new AuthError("That account doesn't exist.", { status: 404 });
        const app = pathname === "/admin/access" ? APPS.find(a => a.id === String(f.app)) : APPS.find(a => a.area === String(f.area));
        if (!app) throw new AuthError("Unknown app.");
        const on = pathname === "/admin/access" ? f.on === "1" : f.op === "grant";
        await setAccess(d, me, target, app, on);
        return show({ notice: `${app.name} is ${on ? "on" : "off"} for ${target.username}.`, open: target.id });
      }
      case "/admin/disable":
        needTarget();
        await d.prepare("UPDATE users SET disabled = 1 WHERE id = ?").bind(target.id).run();
        await endUserSessions(env, target.id);
        return show({ notice: `${target.username} is disabled and signed out.` });
      case "/admin/enable":
        needTarget();
        await d.prepare("UPDATE users SET disabled = 0 WHERE id = ?").bind(target.id).run();
        await d.prepare("DELETE FROM auth_limits WHERE key = ?").bind("user:" + target.username).run();
        return show({ notice: `${target.username} is enabled.` });
      case "/admin/reset-password": {
        needTarget();
        const password = randomToken(12);          // 16 characters
        await setPassword(env, target.id, password, { mustChange: true });
        await endUserSessions(env, target.id);
        await d.prepare("DELETE FROM auth_limits WHERE key = ?").bind("user:" + target.username).run();
        return show({ tempPassword: { username: target.username, password } });
      }
      case "/admin/reset-2fa":
        needTarget();
        await disableTotp(env, target.id);
        await endUserSessions(env, target.id);
        return show({ notice: `Two-factor removed from ${target.username}. They can set it up again from their account page.` });
      case "/admin/signout":
        needTarget();
        await endUserSessions(env, target.id);
        return show({ notice: `${target.username} is signed out everywhere.` });
      case "/admin/delete":
        needTarget();
        if (String(f.confirm ?? "").trim().toLowerCase() !== target.username) throw new AuthError(`Type ${target.username} in the box to delete that account.`);
        const photos = await photosOf(d, target.id);
        await d.batch([
          d.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target.id),
          d.prepare("DELETE FROM store_versions WHERE plugin_id IN (SELECT id FROM store_plugins WHERE owner = ?)").bind(target.id),
          d.prepare("DELETE FROM store_plugins WHERE owner = ?").bind(target.id),
          d.prepare("DELETE FROM drift_installs WHERE owner = ?").bind(target.id),
          d.prepare("DELETE FROM api_keys WHERE user_id = ?").bind(target.id),
          d.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(target.id),
          d.prepare("DELETE FROM email_tokens WHERE user_id = ?").bind(target.id),
          d.prepare("DELETE FROM user_areas WHERE user_id = ?").bind(target.id),
          d.prepare("DELETE FROM todo_tasks WHERE owner = ?").bind(target.id),
          d.prepare("DELETE FROM drift_items WHERE owner = ?").bind(target.id),
          d.prepare("DELETE FROM drift_collections WHERE owner = ?").bind(target.id),
          d.prepare("DELETE FROM drift_shares WHERE owner = ? OR user_id = ?").bind(target.id, target.id),
          d.prepare("DELETE FROM pantry_shares WHERE owner = ? OR user_id = ?").bind(target.id, target.id),
          // Their connections to other platforms go, with the rooms they brought in.
          d.prepare(`DELETE FROM chat_reactions WHERE message IN (SELECT m.id FROM chat_messages m JOIN chat_rooms r ON r.id = m.room
            WHERE r.kind = 'bridge' AND r.owner = ?)`).bind(target.id),
          ...["chat_messages", "chat_members", "chat_presence", "chat_ext_reads"].map(t =>
            d.prepare(`DELETE FROM ${t} WHERE room IN (SELECT id FROM chat_rooms WHERE kind = 'bridge' AND owner = ?)`).bind(target.id)),
          d.prepare("DELETE FROM chat_rooms WHERE kind = 'bridge' AND owner = ?").bind(target.id),
          d.prepare("DELETE FROM chat_crypto_inbox WHERE connection IN (SELECT id FROM chat_connections WHERE user_id = ?)").bind(target.id),
          d.prepare("DELETE FROM chat_connections WHERE user_id = ?").bind(target.id),
          // Their chat messages go; rooms they made stay, for admins to manage.
          d.prepare("DELETE FROM chat_reactions WHERE user_id = ? OR message IN (SELECT id FROM chat_messages WHERE user_id = ?)").bind(target.id, target.id),
          d.prepare("DELETE FROM chat_mentions WHERE user_id = ? OR message IN (SELECT id FROM chat_messages WHERE user_id = ?)").bind(target.id, target.id),
          d.prepare("DELETE FROM chat_messages WHERE user_id = ?").bind(target.id),
          d.prepare("DELETE FROM chat_members WHERE user_id = ?").bind(target.id),
          d.prepare("DELETE FROM chat_presence WHERE user_id = ?").bind(target.id),
          d.prepare("DELETE FROM chat_gif_favorites WHERE user_id = ?").bind(target.id),
          d.prepare("DELETE FROM push_devices WHERE user_id = ?").bind(target.id),
          d.prepare("DELETE FROM push_prefs WHERE user_id = ?").bind(target.id),
          d.prepare("DELETE FROM push_sent WHERE user_id = ?").bind(target.id),
          d.prepare("DELETE FROM meal_plans WHERE owner = ?").bind(target.id),
          ...["recipes", "recipe_photos", "recipe_shares"].map(t => d.prepare(`DELETE FROM ${t} WHERE owner = ?`).bind(target.id)),
          // Trips they made go, with everything in them; they come off everyone else's.
          ...["trip_entries", "trip_members"].map(t => d.prepare(`DELETE FROM ${t} WHERE trip IN (SELECT id FROM trips WHERE owner = ?)`).bind(target.id)),
          d.prepare("DELETE FROM trips WHERE owner = ?").bind(target.id),
          d.prepare("DELETE FROM trip_members WHERE user_id = ?").bind(target.id),
          // Their recipe board posts, follows, saves and reviews go (and the reviews of their posts).
          d.prepare("DELETE FROM board_reviews WHERE user_id = ? OR post IN (SELECT id FROM board_posts WHERE author = ?)").bind(target.id, target.id),
          d.prepare("DELETE FROM board_saves WHERE user_id = ? OR post IN (SELECT id FROM board_posts WHERE author = ?)").bind(target.id, target.id),
          ...["board_follows", "board_seen", "board_review_seen"].map(t => d.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(target.id)),
          d.prepare("DELETE FROM board_posts WHERE author = ?").bind(target.id),
          // Feedback they sent goes with them; replies they wrote on others' notes too.
          ...["feedback_photos", "feedback_replies"].map(t => d.prepare(`DELETE FROM ${t} WHERE item IN (SELECT id FROM feedback WHERE author = ?)`).bind(target.id)),
          d.prepare("DELETE FROM feedback WHERE author = ?").bind(target.id),
          d.prepare("DELETE FROM feedback_replies WHERE user_id = ?").bind(target.id),
          // Their marks and photos come off Food club; months they picked stay in its history.
          ...["food_marks", "food_photos"].map(t => d.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(target.id)),
          ...["sweep_rooms", "sweep_suggestions", "sweep_runs", "sweep_keys"].map(t => d.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(target.id)),
          d.prepare("DELETE FROM users WHERE id = ?").bind(target.id),
        ]);
        for (const [table, ids] of Object.entries(photos)) await dropPhotos(env, table, ids);
        return show({ notice: `${target.username} and their tasks are deleted.` });
      case "/admin/move-tasks": {
        const to = await getUser(env, { id: String(f.to) });
        if (!to) throw new AuthError("Pick an account to move the tasks to.");
        const from = String(f.from ?? "");
        if (await getUser(env, { id: from })) throw new AuthError("Those tasks already belong to an account.");
        const r = await d.prepare("UPDATE OR IGNORE todo_tasks SET owner = ? WHERE owner = ?").bind(to.id, from).run();
        return show({ notice: `Moved ${r.meta.changes} task${r.meta.changes === 1 ? "" : "s"} to ${to.username}.` });
      }
    }
  } catch (e) {
    if (e instanceof AuthError) return show({ error: e.message }, e.status);
    throw e;
  }
  return redirect("/admin");
}
