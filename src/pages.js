// Server-rendered pages for signing in and managing accounts, in the
// portfolio's style. No scripts: every action is a plain form post.

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CSP = [
  "default-src 'none'", "style-src 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
  "img-src 'self' data:", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");

export function html(body, { status = 200, headers = {} } = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", ...headers,
    },
  });
}

const CREST = `<svg viewBox="0 0 120 120" width="54" height="54" aria-hidden="true"><circle cx="60" cy="60" r="54" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="60" cy="60" r="45" fill="none" stroke="currentColor" stroke-width="1"/><g transform="translate(60,66)" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"><line x1="-11" y1="-11" x2="11" y2="11"/><line x1="11" y1="-11" x2="-11" y2="11"/><line x1="0" y1="-24" x2="0" y2="-2"/><line x1="-6" y1="-18" x2="6" y2="-18"/></g><path d="M 34 78 Q 44 66 60 66 Q 76 66 86 78 L 82 88 Q 71 78 60 78 Q 49 78 38 88 Z" fill="currentColor"/></svg>`;

const STYLE = `
  :root { --bg:#0b0f0a; --panel:#121a12; --line:oklch(0.78 0.11 85 / 0.25); --gold:oklch(0.78 0.11 85); --gold-dim:oklch(0.62 0.08 85);
          --ink:oklch(0.95 0.02 80); --muted:oklch(0.78 0.04 80); --bad:oklch(0.72 0.15 30); --good:oklch(0.78 0.12 150); }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--ink); font-family: 'EB Garamond', Georgia, serif; }
  body { min-height: 100vh; background: radial-gradient(circle at 50% 30%, #16261a 0%, #0b0f0a 70%); padding: 32px 16px 64px; }
  a { color: var(--gold); }
  .top { display: flex; align-items: center; gap: 14px; max-width: 960px; margin: 0 auto 36px; }
  .top a.crest { color: oklch(0.82 0.05 85); display: block; }
  .top .who { margin-left: auto; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px 14px;
          font-family: 'Jost', sans-serif; font-size: 12px; letter-spacing: 1.5px; color: var(--muted); }
  main { max-width: 440px; margin: 0 auto; }
  main.wide { max-width: 960px; }
  .kicker { font-family: 'Jost', sans-serif; font-size: 12px; letter-spacing: 4px; color: var(--gold); text-transform: uppercase; }
  h1 { font-weight: 500; font-size: clamp(32px, 6vw, 46px); margin: 10px 0 24px; }
  h2 { font-weight: 500; font-size: 24px; margin: 0 0 12px; }
  p { color: var(--muted); font-size: 18px; line-height: 1.5; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 24px; margin-bottom: 20px; }
  label { display: block; font-family: 'Jost', sans-serif; font-size: 12px; letter-spacing: 1.5px; color: var(--muted); text-transform: uppercase; margin: 14px 0 6px; }
  input[type=text], input[type=password], input[type=email], select { width: 100%; padding: 11px 12px; font: 18px 'EB Garamond', Georgia, serif; color: var(--ink);
          background: #0b0f0a; border: 1px solid var(--line); border-radius: 4px; }
  input:focus, select:focus { outline: 2px solid var(--gold); outline-offset: 1px; }
  .hint { font-size: 15px; color: var(--gold-dim); margin: 6px 0 0; }
  button, .btn { display: inline-block; margin-top: 20px; padding: 11px 22px; font: 500 13px 'Jost', sans-serif; letter-spacing: 2px; text-transform: uppercase;
          color: #1a1206; background: var(--gold); border: 0; border-radius: 4px; cursor: pointer; text-decoration: none; }
  button.quiet { background: transparent; color: var(--gold); border: 1px solid var(--line); }
  button.danger { background: transparent; color: var(--bad); border: 1px solid oklch(0.72 0.15 30 / 0.4); }
  button.small { margin-top: 0; padding: 6px 10px; font-size: 11px; letter-spacing: 1px; }
  .msg { padding: 12px 14px; border-radius: 4px; margin-bottom: 18px; font-size: 17px; }
  .msg.bad { background: oklch(0.72 0.15 30 / 0.12); border: 1px solid oklch(0.72 0.15 30 / 0.4); color: oklch(0.85 0.08 30); }
  .msg.good { background: oklch(0.78 0.12 150 / 0.1); border: 1px solid oklch(0.78 0.12 150 / 0.35); color: oklch(0.88 0.06 150); }
  .alt { margin-top: 22px; font-size: 17px; color: var(--muted); }
  .qr { background: #fff; padding: 12px; width: 220px; border-radius: 4px; }
  .qr svg { display: block; width: 100%; height: auto; }
  code, .mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 15px; word-break: break-all; color: var(--ink); }
  .codes { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 18px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 17px; }
  table { width: 100%; border-collapse: collapse; font-size: 16px; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font: 12px 'Jost', sans-serif; letter-spacing: 1.5px; text-transform: uppercase; color: var(--muted); }
  td form { display: inline-block; margin: 0 6px 6px 0; }
  .tag { display: inline-block; padding: 1px 8px; border: 1px solid var(--line); border-radius: 99px; font: 12px 'Jost', sans-serif; margin: 0 4px 4px 0; }
  .tag.off { color: var(--bad); }
  .row { display: flex; gap: 10px; align-items: end; flex-wrap: wrap; }
  .row > * { flex: 1; min-width: 140px; }
  .row button { flex: 0; }
  .scroll { overflow-x: auto; }
  .apps { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; margin-bottom: 28px; }
  a.app { display: block; text-decoration: none; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 22px; }
  a.app:hover, a.app:focus-visible { border-color: var(--gold); outline: none; }
  a.app h2 { margin-bottom: 6px; }
  a.app p { margin: 0; font-size: 17px; }
  a.app .go { display: block; margin-top: 14px; font: 500 12px 'Jost', sans-serif; letter-spacing: 2px; text-transform: uppercase; color: var(--gold); }
`;

export function page(title, body, { user, wide = false } = {}) {
  const who = user
    ? `<div class="who">${esc(user.display_name)}<a href="/dashboard">Dashboard</a><a href="/account">Settings</a>${user.areas?.has("admin") ? `<a href="/admin">Admin</a>` : ""}<a href="/logout">Sign out</a></div>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · sintfoap.xyz</title><meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500&family=Jost:wght@400;500&display=swap" rel="stylesheet">
<style>${STYLE}</style></head><body>
<div class="top"><a class="crest" href="/" aria-label="Home">${CREST}</a>${who}</div>
<main class="${wide ? "wide" : ""}">${body}</main></body></html>`;
}

const msg = (text, kind = "bad") => text ? `<div class="msg ${kind}" role="${kind === "bad" ? "alert" : "status"}">${esc(text)}</div>` : "";
const hiddenNext = next => next ? `<input type="hidden" name="next" value="${esc(next)}">` : "";

export const loginPage = ({ error, next, username = "", signupsOpen }) => page("Sign in", `
  <div class="kicker">sintfoap.xyz</div><h1>Sign in</h1>
  <form method="post" action="/login" class="card">${msg(error)}${hiddenNext(next)}
    <label for="u">Username</label><input id="u" type="text" name="username" value="${esc(username)}" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
    <label for="p">Password</label><input id="p" type="password" name="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>
  <p class="alt"><a href="/login/forgot">Forgot your username or password?</a></p>
  ${signupsOpen ? `<p class="alt">New here? <a href="/signup${next ? `?next=${encodeURIComponent(next)}` : ""}">Create an account</a></p>` : ""}`);

export const signupPage = ({ error, next, values = {}, closed }) => page("Create an account", closed
  ? `<div class="kicker">sintfoap.xyz</div><h1>Create an account</h1>${msg(closed)}<p class="alt"><a href="/login">Back to sign in</a></p>`
  : `<div class="kicker">sintfoap.xyz</div><h1>Create an account</h1>
  <form method="post" action="/signup" class="card">${msg(error)}${hiddenNext(next)}
    <label for="u">Username</label><input id="u" type="text" name="username" value="${esc(values.username)}" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
    <p class="hint">3–32 characters: letters, numbers, - and _.</p>
    <label for="d">Display name</label><input id="d" type="text" name="display_name" value="${esc(values.display_name)}" autocomplete="nickname" maxlength="50">
    <p class="hint">What the site calls you. Defaults to your username.</p>
    <label for="p">Password</label><input id="p" type="password" name="password" autocomplete="new-password" minlength="12" maxlength="128" required>
    <p class="hint">At least 12 characters. A few random words works well.</p>
    <label for="p2">Password again</label><input id="p2" type="password" name="password2" autocomplete="new-password" required>
    <button type="submit">Create account</button>
  </form>
  <p class="alt">Already have one? <a href="/login${next ? `?next=${encodeURIComponent(next)}` : ""}">Sign in</a></p>`);

export const mfaPage = ({ error, next }) => page("Two-factor code", `
  <div class="kicker">sintfoap.xyz</div><h1>Enter your code</h1>
  <form method="post" action="/login/2fa" class="card">${msg(error)}${hiddenNext(next)}
    <label for="c">6-digit code from your authenticator app</label>
    <input id="c" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="11" required autofocus>
    <p class="hint">Lost your phone? Enter one of your recovery codes instead.</p>
    <button type="submit">Continue</button>
  </form>
  <p class="alt"><a href="/logout">Start over</a></p>`);

export const forgotPage = ({ error, mail }) => page("Forgot username or password", `
  <div class="kicker">sintfoap.xyz</div><h1>Forgot your username or password?</h1>
  ${msg(error)}
  ${mail ? `<form method="post" action="/login/forgot/email" class="card">
    <h2>By email</h2>
    <p>If you confirmed an email address in your account settings, we'll send your username and a link to choose a new password.</p>
    <label for="e">Email</label><input id="e" type="email" name="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" required>
    <button type="submit">Email me a link</button>
  </form>` : ""}
  <form method="post" action="/login/forgot" class="card">
    ${mail ? `<h2>With a recovery code</h2>` : ""}
    <p>Use one of the recovery codes you saved from your account settings. It tells us which account is yours, so you don't need your username.</p>
    <label for="r">Recovery code</label>
    <input id="r" type="text" name="recovery_code" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="20" placeholder="xxxxx-xxxxx" required autofocus>
    <label for="a">Code from your authenticator app</label>
    <input id="a" type="text" name="app_code" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
    <p class="hint">Only if you use two-factor. Leave it empty otherwise.</p>
    <label for="n">New password</label><input id="n" type="password" name="new_password" autocomplete="new-password" minlength="12" maxlength="128" required>
    <label for="n2">New password again</label><input id="n2" type="password" name="new_password2" autocomplete="new-password" required>
    <button type="submit">Reset password</button>
  </form>
  <p class="alt">${mail ? "No email or recovery codes" : "No recovery codes"}, or lost your phone too? Ask the site's admin to reset your password.</p>
  <p class="alt"><a href="/login">Back to sign in</a></p>`);

export const forgotDonePage = ({ user, recoveryLeft, usedRecoveryCode }) => page("Password reset", `
  <div class="kicker">sintfoap.xyz</div><h1>You're back in</h1>
  <div class="card">
    <p>Your username is <span class="mono">${esc(user.username)}</span>. Your password is changed, and every other device has been signed out.</p>
    ${usedRecoveryCode ? `<p>That recovery code is used up. You have ${recoveryLeft} left${recoveryLeft < 3 ? ", so make new ones in your account settings" : ""}.</p>` : ""}
    <a class="btn" href="/account">Go to your account</a>
  </div>`, { user });

export const forgotEmailSentPage = () => page("Check your email", `
  <div class="kicker">sintfoap.xyz</div><h1>Check your email</h1>
  <p>If that address is confirmed on an account here, we've sent it the username and a link to choose a new password. The link works once, for an hour.</p>
  <p>Nothing arriving? Check your spam folder, or use a recovery code instead.</p>
  <p class="alt"><a href="/login/forgot">Back</a> · <a href="/login">Sign in</a></p>`);

export const resetPage = ({ token, user, error }) => page("Choose a new password", `
  <div class="kicker">sintfoap.xyz</div><h1>Choose a new password</h1>
  <form method="post" action="/login/reset" class="card">${msg(error)}
    <input type="hidden" name="token" value="${esc(token)}">
    <p>Username <span class="mono">${esc(user.username)}</span></p>
    <input type="text" name="username" value="${esc(user.username)}" autocomplete="username" hidden>
    <label for="n">New password</label><input id="n" type="password" name="new_password" autocomplete="new-password" minlength="12" maxlength="128" required autofocus>
    <label for="n2">New password again</label><input id="n2" type="password" name="new_password2" autocomplete="new-password" required>
    ${user.totp_secret ? `<label for="c">Code from your authenticator app</label>
    <input id="c" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="11" required>
    <p class="hint">Lost your phone? Enter one of your recovery codes instead.</p>` : ""}
    <button type="submit">Save password</button>
  </form>`);

export const changePasswordRequiredPage = ({ user, error }) => page("Choose a new password", `
  <div class="kicker">Account</div><h1>Choose a new password</h1>
  <p>Your password was reset. Pick a new one to continue.</p>
  <form method="post" action="/account/password" class="card">${msg(error)}
    <input type="hidden" name="forced" value="1">
    <label for="n">New password</label><input id="n" type="password" name="new_password" autocomplete="new-password" minlength="12" required autofocus>
    <label for="n2">New password again</label><input id="n2" type="password" name="new_password2" autocomplete="new-password" required>
    <button type="submit">Save password</button>
  </form>`, { user });

export function dashboardPage({ user, apps, sessionCount }) {
  const cards = apps.length
    ? `<div class="apps">${apps.map(a => `<a class="app" href="${esc(a.href)}"><h2>${esc(a.name)}</h2><p>${esc(a.blurb)}</p><span class="go">Open →</span></a>`).join("")}</div>`
    : `<section class="card"><p>Your account doesn't have any apps yet. Ask the site's admin for access.</p></section>`;
  return page("Dashboard", `
    <div class="kicker">Dashboard</div><h1>Welcome, ${esc(user.display_name)}</h1>
    ${cards}
    <section class="card"><h2>Your account</h2>
      <p>Signed in as <span class="mono">${esc(user.username)}</span>. Two-factor is ${user.totp_secret ? "on" : "off"}. Signed in on ${sessionCount} device${sessionCount === 1 ? "" : "s"}.</p>
      <a class="btn" href="/account">Account settings</a></section>`, { user, wide: true });
}

export function accountPage({ user, error, notice, recoveryLeft, sessionCount, setup, recoveryCodes, adminNeeds2fa, mail }) {
  const isAdmin = user.areas.has("admin");
  let twofa;
  if (setup) {
    twofa = `<h2>Set up two-factor</h2>
      <p>Scan this with an authenticator app (Google Authenticator, 1Password, Authy…), then enter the 6-digit code it shows.</p>
      <div class="qr">${setup.qrSvg}</div>
      <p class="hint">Can't scan? Enter this key by hand: <span class="mono">${esc(setup.secret.replace(/(.{4})/g, "$1 ").trim())}</span></p>
      <form method="post" action="/account/2fa/confirm">
        <label for="c">Code from the app</label><input id="c" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required autofocus>
        <button type="submit">Turn on two-factor</button>
      </form>
      <form method="get" action="/account"><button class="quiet" type="submit">Cancel</button></form>`;
  } else if (user.totp_secret) {
    twofa = `<h2>Two-factor is on</h2>
      <p>Signing in asks for a code from your phone after your password.</p>
      ${isAdmin ? `<p class="hint">Two-factor is required for admin accounts, so it can't be turned off here.</p>` : `
      <form method="post" action="/account/2fa/disable">
        <label for="dp">Password, to turn two-factor off</label><input id="dp" type="password" name="password" autocomplete="current-password" required>
        <button class="danger" type="submit">Turn off two-factor</button>
      </form>`}`;
  } else {
    twofa = `<h2>Two-factor is off</h2>
      <p>${adminNeeds2fa ? "Admin accounts need two-factor before they can use the rest of the site." : "Add a code from your phone on top of your password."}</p>
      <form method="post" action="/account/2fa/start">
        <label for="sp">Password</label><input id="sp" type="password" name="password" autocomplete="current-password" required>
        <button type="submit">Set up two-factor</button>
      </form>`;
  }
  const recovery = recoveryCodes ? `<h2>Save your recovery codes</h2>
      <p>Each one works once, to reset a forgotten password${user.totp_secret ? " or to sign in if you lose your phone" : ""}. They won't be shown again, so save them somewhere safe now, such as a password manager.</p>
      <div class="codes">${recoveryCodes.map(c => `<span>${esc(c)}</span>`).join("")}</div>
      <a class="btn" href="/account">I've saved them</a>`
    : `<h2>Recovery codes</h2>
      <p>${recoveryLeft
        ? `You have ${recoveryLeft} recovery code${recoveryLeft === 1 ? "" : "s"} left.`
        : "You have none, so if you forget your password only the admin can reset it."}
        A recovery code resets a forgotten password from the <a href="/login/forgot">forgot password</a> page${user.totp_secret ? ", along with a code from your phone" : ""}.</p>
      <form method="post" action="/account/recovery">
        <label for="rp">Password</label><input id="rp" type="password" name="password" autocomplete="current-password" required>
        <button class="${recoveryLeft ? "quiet" : ""}" type="submit">${recoveryLeft ? "Make new recovery codes" : "Make recovery codes"}</button>
        ${recoveryLeft ? `<p class="hint">This replaces the ones you have.</p>` : ""}
      </form>`;
  return page("Account settings", `
    <div class="kicker">Account settings</div><h1>${esc(user.display_name)}</h1>
    ${msg(error)}${msg(notice, "good")}
    ${recoveryCodes ? `<section class="card">${recovery}</section>` : ""}
    <section class="card">${twofa}</section>
    ${recoveryCodes ? "" : `<section class="card">${recovery}</section>`}
    ${mail ? `<section class="card"><h2>Email</h2>
      <p>${user.email
        ? `<span class="mono">${esc(user.email)}</span> ${user.email_verified ? "is confirmed, so it can reset your password." : "isn't confirmed yet. Open the link we sent to it."}`
        : "Add an email address to get your username and a reset link if you forget your password. It's used for nothing else."}</p>
      <form method="post" action="/account/email">
        <label for="em">Email</label><input id="em" type="email" name="email" value="${esc(user.email)}" autocomplete="email" maxlength="254">
        <p class="hint">Leave it empty to remove your address.</p>
        <label for="ep">Password</label><input id="ep" type="password" name="password" autocomplete="current-password" required>
        <button type="submit">${user.email ? "Save email" : "Add email"}</button>
      </form></section>` : ""}
    <section class="card"><h2>Profile</h2>
      <p>Username <span class="mono">${esc(user.username)}</span></p>
      <form method="post" action="/account/profile">
        <label for="dn">Display name</label><input id="dn" type="text" name="display_name" value="${esc(user.display_name)}" maxlength="50" required>
        <button type="submit">Save</button>
      </form></section>
    <section class="card"><h2>Password</h2>
      <form method="post" action="/account/password">
        <label for="cp">Current password</label><input id="cp" type="password" name="current_password" autocomplete="current-password" required>
        <label for="n">New password</label><input id="n" type="password" name="new_password" autocomplete="new-password" minlength="12" required>
        <label for="n2">New password again</label><input id="n2" type="password" name="new_password2" autocomplete="new-password" required>
        <button type="submit">Change password</button>
        <p class="hint">This also signs you out everywhere else.</p>
      </form></section>
    <section class="card"><h2>Sessions</h2>
      <p>Signed in on ${sessionCount} device${sessionCount === 1 ? "" : "s"}, including this one.</p>
      <form method="post" action="/account/sessions"><button class="quiet" type="submit">Sign out everywhere else</button></form></section>
    <p class="alt"><a href="/dashboard">Back to your dashboard</a></p>`, { user });
}

const date = t => new Date(t * 1000).toISOString().slice(0, 10);

export function adminPage({ user, users, orphans, areas, error, notice, tempPassword }) {
  const post = (action, label, fields, cls = "quiet small", confirm = "") =>
    `<form method="post" action="/admin/${action}">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("")}${confirm}<button class="${cls}" type="submit">${label}</button></form>`;
  const rows = users.map(u => {
    const self = u.id === user.id;
    return `<tr><td><strong>${esc(u.display_name)}</strong><br><span class="mono">${esc(u.username)}</span><br><span class="hint">since ${date(u.created_at)}</span></td>
      <td>${areas.map(a => u.areas.includes(a)
        ? (self && a === "admin" ? `<span class="tag">${a}</span>` : post("area", `${a} ✕`, { user_id: u.id, area: a, op: "revoke" }, "quiet small"))
        : post("area", `+ ${a}`, { user_id: u.id, area: a, op: "grant" }, "quiet small")).join("")}</td>
      <td>${u.disabled ? `<span class="tag off">disabled</span>` : ""}${u.totp ? `<span class="tag">2FA</span>` : ""}${u.must_change_pw ? `<span class="tag">must change pw</span>` : ""}<br><span class="hint">${u.sessions} session${u.sessions === 1 ? "" : "s"} · ${u.tasks} task${u.tasks === 1 ? "" : "s"}</span></td>
      <td>${self ? `<span class="hint">you</span>` : [
        post(u.disabled ? "enable" : "disable", u.disabled ? "Enable" : "Disable", { user_id: u.id }, u.disabled ? "quiet small" : "danger small"),
        post("reset-password", "Reset password", { user_id: u.id }),
        u.totp ? post("reset-2fa", "Reset 2FA", { user_id: u.id }) : "",
        u.sessions ? post("signout", "Sign out", { user_id: u.id }) : "",
        post("delete", "Delete", { user_id: u.id }, "danger small", `<input type="text" name="confirm" placeholder="type ${esc(u.username)}" aria-label="Type the username to confirm" style="width:150px;padding:5px 8px;font-size:14px;margin-right:6px">`),
      ].join("")}</td></tr>`;
  }).join("");
  const orphanRows = orphans.length ? `<section class="card"><h2>Tasks with no account</h2>
    <p>These todo lists belong to an owner that isn't an account, such as lists made before this login existed. Move them to an account to give them back.</p>
    <table><tr><th>Owner</th><th>Tasks</th><th></th></tr>${orphans.map(o => `<tr><td class="mono">${esc(o.owner)}</td><td>${o.n}</td><td>
      <form method="post" action="/admin/move-tasks" class="row"><input type="hidden" name="from" value="${esc(o.owner)}">
        <select name="to" aria-label="Move to">${users.map(u => `<option value="${esc(u.id)}">${esc(u.username)}</option>`).join("")}</select>
        <button class="quiet small" type="submit">Move</button></form></td></tr>`).join("")}</table></section>` : "";
  return page("Admin", `
    <div class="kicker">Admin</div><h1>Accounts</h1>
    ${msg(error)}${msg(notice, "good")}
    ${tempPassword ? `<div class="msg good">Temporary password for <strong>${esc(tempPassword.username)}</strong>: <span class="mono">${esc(tempPassword.password)}</span><br>Send it to them privately. They'll have to change it when they sign in, and it won't be shown again.</div>` : ""}
    <section class="card scroll"><table><tr><th>Account</th><th>Areas</th><th>Status</th><th>Actions</th></tr>${rows}</table></section>
    ${orphanRows}`, { user, wide: true });
}

export const adminClaimPage = ({ user, error, enabled }) => page("Become admin", `
  <div class="kicker">Admin</div><h1>Become the admin</h1>
  ${enabled ? `<p>No account is the admin yet. Enter the claim code from the site's Cloudflare settings to make this account (<span class="mono">${esc(user.username)}</span>) the admin.</p>
  <form method="post" action="/admin/claim" class="card">${msg(error)}
    <label for="c">Claim code</label><input id="c" type="password" name="code" autocomplete="off" required autofocus>
    <button type="submit">Make me admin</button>
  </form>` : `<p>Claiming admin is switched off. Set the <span class="mono">ADMIN_CLAIM_CODE</span> secret on the Worker to turn it on.</p>`}`, { user });

export const messagePage = (title, text, { user, status = 200, link = ["/", "Home"] } = {}) =>
  html(page(title, `<div class="kicker">sintfoap.xyz</div><h1>${esc(title)}</h1><p>${esc(text)}</p><p class="alt"><a href="${esc(link[0])}">${esc(link[1])}</a></p>`, { user }), { status });
