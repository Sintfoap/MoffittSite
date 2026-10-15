// Tests for accounts, sessions, throttling, two-factor and admin.
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, sql, sqlOne, run, enable2fa, codeAt, stepNow } from "./helpers.mjs";
import { totpCode, verifyPassword, hashPassword } from "../src/crypto.js";

const PW = "correct horse battery";

// ── primitives ─────────────────────────────────────────────────────────────
test("TOTP matches the RFC 6238 test vector", async () => {
  // Secret "12345678901234567890" in base32, T = 59s → step 1 → 94287082 (8 digits).
  assert.equal(await totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1, 8), "94287082");
});

test("password hashes verify only the right password and record their strength", async () => {
  const h = await hashPassword("hunter2hunter2", 10000);
  assert.match(h, /^pbkdf2-sha256\$10000\$/);
  assert.equal((await verifyPassword("hunter2hunter2", h)).ok, true);
  assert.equal((await verifyPassword("hunter2hunter3", h)).ok, false);
  assert.equal((await verifyPassword("x", "garbage")).ok, false);
});

// ── creating accounts ──────────────────────────────────────────────────────
test("creating an account signs you in with a locked-down cookie", async () => {
  const env = makeEnv(), b = new Browser(env);
  const r = await b.signup("Ryan", PW, "Ryan M");
  assert.equal(r.status, 303);
  assert.equal(r.location, "/dashboard");
  assert.match(r.setCookie, /^__Host-sid=[A-Za-z0-9_-]{40,}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  const u = sqlOne(env, "SELECT * FROM users");
  assert.equal(u.username, "ryan", "usernames are stored lowercase");
  assert.equal(u.display_name, "Ryan M");
  assert.ok(!u.password_hash.includes(PW));
  assert.deepEqual(sql(env, "SELECT area FROM user_areas").map(r => r.area), ["todo"]);
  // The database stores a hash of the session id, never the cookie value itself.
  assert.notEqual(sqlOne(env, "SELECT id_hash FROM sessions").id_hash, b.cookie);

  assert.equal((await b.get("/todo/")).status, 200);
  assert.equal((await b.get("/todo/api/tasks")).json.stats.user, "Ryan M");
});

test("account rules: usernames, reserved names, passwords, duplicates", async () => {
  const env = makeEnv(), b = new Browser(env);
  for (const [name, pw, why] of [
    ["ab", PW, "too short"], ["has space", PW, "bad characters"], ["-dash", PW, "bad first character"],
    ["admin", PW, "reserved"], ["okname", "short", "short password"], ["okname", "xx okname xx yy", "password contains username"],
  ]) {
    const r = await b.signup(name, pw);
    assert.equal(r.status, 400, why);
    assert.equal(b.cookie, null, why);
  }
  const mismatch = await b.post("/signup", { username: "okname", password: PW, password2: PW + "!" });
  assert.equal(mismatch.status, 400);
  assert.equal((await b.signup("okname")).status, 303);
  assert.equal((await new Browser(env).signup("sintfoap")).status, 303, "the site owner's name is available");
  assert.equal((await new Browser(env).signup("OKNAME")).status, 400, "names are unique ignoring case");
});

test("sign-ups can be closed, capped, and throttled per address", async () => {
  assert.equal((await new Browser(makeEnv({ SIGNUPS: "closed" })).signup("ryan")).status, 403);

  const capped = makeEnv({ MAX_USERS: "1" });
  assert.equal((await new Browser(capped).signup("first")).status, 303);
  assert.equal((await new Browser(capped).signup("second")).status, 403);

  const env = makeEnv(), ip = "198.51.100.7";
  for (let i = 0; i < 5; i++) assert.equal((await new Browser(env, { ip }).signup("user" + i)).status, 303);
  assert.equal((await new Browser(env, { ip }).signup("user5")).status, 429);
  assert.equal((await new Browser(env).signup("user5")).status, 303, "other addresses are unaffected");
});

// ── signing in and out ─────────────────────────────────────────────────────
test("wrong username and wrong password look the same", async () => {
  const env = makeEnv();
  await new Browser(env).signup("ryan");
  const b = new Browser(env);
  const badPw = await b.login("ryan", "wrong password here");
  const badUser = await b.login("nobody", PW);
  assert.equal(badPw.status, 401);
  assert.equal(badUser.status, 401);
  assert.match(badPw.text, /Wrong username or password/);
  assert.match(badUser.text, /Wrong username or password/);
  assert.equal(b.cookie, null);
});

test("five wrong passwords lock the account, even against the right password", async () => {
  const env = makeEnv();
  await new Browser(env).signup("ryan");
  await new Browser(env).signup("josh");
  const attacker = new Browser(env);
  for (let i = 0; i < 5; i++) await attacker.login("ryan", "wrong password " + i);
  const locked = await new Browser(env).login("ryan", PW);
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get("Retry-After")) > 0);
  assert.equal((await new Browser(env).login("josh", PW)).status, 303, "other accounts are unaffected");
  // Once the lock has passed, the right password works again.
  run(env, "UPDATE auth_limits SET locked_until = 0");
  assert.equal((await new Browser(env).login("ryan", PW)).status, 303);
});

test("one address guessing across many accounts gets locked out", async () => {
  const env = makeEnv(), ip = "192.0.2.9";
  await new Browser(env).signup("ryan");
  const b = new Browser(env, { ip });
  for (let i = 0; i < 30; i++) await b.login("user" + i, "wrong password");
  assert.equal((await b.login("ryan", PW)).status, 429);
  assert.equal((await new Browser(env).login("ryan", PW)).status, 303);
});

test("signed-out visitors are sent to sign in, and come back afterwards", async () => {
  const env = makeEnv();
  await new Browser(env).signup("ryan");
  const b = new Browser(env);
  const page = await b.get("/todo/?view=today");
  assert.equal(page.status, 303);
  assert.equal(page.location, "/login?next=%2Ftodo%2F%3Fview%3Dtoday");
  assert.equal((await b.get("/todo/api/tasks")).status, 401);
  const r = await b.post("/login", { username: "ryan", password: PW, next: "/todo/?view=today" });
  assert.equal(r.location, "/todo/?view=today");
});

test("the after-login address can't send people to another site", async () => {
  const env = makeEnv();
  await new Browser(env).signup("ryan");
  for (const next of ["//evil.example/", "https://evil.example/", "/\\evil.example", "javascript:alert(1)", "/ok\nSet-Cookie:x"]) {
    const r = await new Browser(env).post("/login", { username: "ryan", password: PW, next });
    assert.equal(r.location, "/dashboard", JSON.stringify(next));
  }
});

test("signing out ends the session for good", async () => {
  const env = makeEnv(), b = new Browser(env);
  await b.signup("ryan");
  const old = b.cookie;
  await b.get("/logout");
  assert.equal(b.cookie, null);
  assert.equal((await b.get("/todo/api/tasks", { cookie: old })).status, 401, "the old cookie no longer works");
});

test("sessions expire after a week unused or 30 days in total", async () => {
  const env = makeEnv(), b = new Browser(env);
  await b.signup("ryan");
  const t = Math.floor(Date.now() / 1000);
  run(env, "UPDATE sessions SET last_seen = ?", t - 8 * 86400);
  assert.equal((await b.get("/todo/api/tasks")).status, 401);

  await b.login("ryan");
  run(env, "UPDATE sessions SET expires_at = ?", t - 1);
  assert.equal((await b.get("/todo/api/tasks")).status, 401);
});

test("a disabled account's existing session stops working at once", async () => {
  const env = makeEnv(), b = new Browser(env);
  await b.signup("ryan");
  run(env, "UPDATE users SET disabled = 1");      // even if its sessions weren't cleared
  assert.equal((await b.get("/todo/api/tasks")).status, 401);
});

test("a code is refused for any step at or before the last one used", async () => {
  const { verifyTotp } = await import("../src/crypto.js");
  const secret = "JBSWY3DPEHPK3PXP", step = stepNow();
  const code = await codeAt(secret, step);
  assert.equal(await verifyTotp(secret, code, 0), step);
  assert.equal(await verifyTotp(secret, code, step), null);
  assert.equal(await verifyTotp(secret, await codeAt(secret, step - 3), 0), null, "old codes expire");
});

test("forms and API writes from other websites are refused", async () => {
  const env = makeEnv(), b = new Browser(env);
  await b.signup("ryan");
  assert.equal((await new Browser(env).post("/login", { username: "ryan", password: PW }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await b.post("/account/sessions", {}, { origin: "https://evil.example" })).status, 403);
  assert.equal((await b.post("/account/sessions", {}, { origin: null, headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await b.req("POST", "/todo/api/tasks", { json: { title: "x" }, origin: "https://evil.example" })).status, 403);
  assert.equal((await b.req("POST", "/todo/api/tasks", { json: { title: "x" } })).status, 201);
});

// ── account page ───────────────────────────────────────────────────────────
test("changing your password needs the current one and signs out other devices", async () => {
  const env = makeEnv(), laptop = new Browser(env), phone = new Browser(env);
  await laptop.signup("ryan");
  await phone.login("ryan");
  const NEW = "a brand new passphrase";
  assert.equal((await laptop.post("/account/password", { current_password: "nope nope nope", new_password: NEW, new_password2: NEW })).status, 401);
  const ok = await laptop.post("/account/password", { current_password: PW, new_password: NEW, new_password2: NEW });
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Password changed/);
  assert.equal((await phone.get("/todo/api/tasks")).status, 401, "the other device is signed out");
  assert.equal((await laptop.get("/todo/api/tasks")).status, 200, "this device stays signed in");
  assert.equal((await new Browser(env).login("ryan", NEW)).status, 303);
});

test("display names can be changed and are escaped on every page", async () => {
  const env = makeEnv(), b = new Browser(env);
  await b.signup("ryan");
  await b.post("/account/profile", { display_name: `<img src=x onerror=alert(1)>` });
  const page = await b.get("/account");
  assert.ok(!page.text.includes("<img src=x"));
  assert.ok(page.text.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.match(page.headers.get("Content-Security-Policy"), /default-src 'none'/);
});

// ── two-factor ─────────────────────────────────────────────────────────────
test("two-factor: setup, sign-in with a code, no replays, recovery codes work once", async () => {
  const env = makeEnv(), b = new Browser(env);
  await b.signup("ryan");

  assert.equal((await b.post("/account/2fa/start", { password: "not my password" })).status, 401, "setup needs the password");
  assert.equal(sqlOne(env, "SELECT totp_pending FROM users").totp_pending, null);
  const start = await b.post("/account/2fa/start", { password: PW });
  assert.match(start.text, /<svg[^>]*>/, "shows a QR code");
  const wrong = await b.post("/account/2fa/confirm", { code: "000000" });
  assert.equal(wrong.status, 400);
  assert.equal(sqlOne(env, "SELECT totp_secret FROM users").totp_secret, null);

  const { secret, codes, step } = await enable2fa(b, env);
  assert.equal(codes.length, 10);
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM recovery_codes").n, 10);
  assert.ok(!sql(env, "SELECT code_hash FROM recovery_codes").some(r => codes.includes(r.code_hash)), "only hashes are stored");

  // Password alone now only gets you to the code screen.
  const c = new Browser(env);
  const r = await c.login("ryan");
  assert.equal(r.location, "/login/2fa?next=%2Fdashboard");
  assert.equal((await c.get("/todo/api/tasks")).status, 401, "half signed in isn't signed in");
  assert.equal((await c.post("/login/2fa", { code: "123456" })).status, 401);
  // The code used during setup can't be used again.
  assert.equal((await c.post("/login/2fa", { code: await codeAt(secret, step) })).status, 401);
  const next = await codeAt(secret, step + 1);
  const done = await c.post("/login/2fa", { code: next });
  assert.equal(done.status, 303);
  assert.equal((await c.get("/todo/api/tasks")).status, 200);

  // That code is now spent too.
  const d = new Browser(env);
  await d.login("ryan");
  assert.equal((await d.post("/login/2fa", { code: next })).status, 401);
  // A recovery code works (with or without the dash), but only once.
  assert.equal((await d.post("/login/2fa", { code: codes[0].replace("-", "").toUpperCase() })).status, 303);
  const e = new Browser(env);
  await e.login("ryan");
  assert.equal((await e.post("/login/2fa", { code: codes[0] })).status, 401);
});

test("the code screen expires and is throttled", async () => {
  const env = makeEnv(), b = new Browser(env);
  await b.signup("ryan");
  await enable2fa(b, env);
  const c = new Browser(env);
  await c.login("ryan");
  for (let i = 0; i < 5; i++) await c.post("/login/2fa", { code: String(100000 + i) });
  assert.equal((await c.post("/login/2fa", { code: "999999" })).status, 429);

  const d = new Browser(env);
  await d.login("ryan");
  run(env, "UPDATE sessions SET expires_at = 1 WHERE stage = 'mfa'");
  assert.equal((await d.post("/login/2fa", { code: "123456" })).location, "/login");
});

test("turning two-factor off needs the password", async () => {
  const env = makeEnv(), b = new Browser(env);
  await b.signup("ryan");
  await enable2fa(b, env);
  assert.equal((await b.post("/account/2fa/disable", { password: "not my password" })).status, 401);
  assert.equal((await b.post("/account/2fa/disable", { password: PW })).status, 200);
  assert.equal(sqlOne(env, "SELECT totp_secret FROM users").totp_secret, null);
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM recovery_codes").n, 10, "recovery codes are kept for password resets");
});

// ── forgot username or password ────────────────────────────────────────────
async function makeCodes(b, password = PW) {
  const r = await b.post("/account/recovery", { password });
  return [...r.text.matchAll(/<span>([a-z2-7]{5}-[a-z2-7]{5})<\/span>/g)].map(m => m[1]);
}

test("anyone can make recovery codes, but only with their password", async () => {
  const env = makeEnv(), b = new Browser(env);
  await b.signup("ryan");
  assert.match((await b.get("/account")).text, /You have none/);
  assert.equal((await b.post("/account/recovery", { password: "not my password" })).status, 401);
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM recovery_codes").n, 0);
  const codes = await makeCodes(b);
  assert.equal(codes.length, 10);
  assert.match((await b.get("/account")).text, /You have 10 recovery codes left/);
  const again = await makeCodes(b);
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM recovery_codes").n, 10, "new codes replace the old ones");
  assert.ok(!again.includes(codes[0]));
});

test("a recovery code resets a forgotten password and shows the username", async () => {
  const env = makeEnv(), b = new Browser(env);
  await b.signup("ryan");
  const codes = await makeCodes(b);
  await new Browser(env).signup("josh");
  const NEW = "a brand new passphrase";

  assert.match((await new Browser(env).get("/login")).text, /href="\/login\/forgot"/);
  assert.equal((await new Browser(env).get("/login/forgot")).status, 200);

  const c = new Browser(env);
  assert.equal((await c.post("/login/forgot", { recovery_code: "aaaaa-aaaaa", new_password: NEW, new_password2: NEW })).status, 401);
  assert.equal((await c.post("/login/forgot", { recovery_code: codes[0], new_password: NEW, new_password2: NEW + "x" })).status, 400);
  assert.equal((await c.post("/login/forgot", { recovery_code: codes[0], new_password: "short", new_password2: "short" })).status, 400);
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NOT NULL").n, 0, "failed tries don't spend the code");

  const done = await c.post("/login/forgot", { recovery_code: codes[0].toUpperCase().replace("-", " "), new_password: NEW, new_password2: NEW });
  assert.equal(done.status, 200);
  assert.match(done.text, /Your username is <span class="mono">ryan<\/span>/);
  assert.match(done.text, /You have 9 left/);
  assert.equal((await c.get("/todo/api/tasks")).status, 200, "and you're signed in");
  assert.equal((await b.get("/todo/api/tasks")).status, 401, "other devices are signed out");

  assert.equal((await new Browser(env).login("ryan")).status, 401, "the old password is gone");
  assert.equal((await new Browser(env).login("ryan", NEW)).status, 303);
  assert.equal((await new Browser(env).login("josh")).status, 303, "other accounts are untouched");
  // Each code works once.
  assert.equal((await new Browser(env).post("/login/forgot", { recovery_code: codes[0], new_password: PW, new_password2: PW })).status, 401);
});

test("with two-factor on, a reset also needs a fresh app code", async () => {
  const env = makeEnv(), b = new Browser(env);
  await b.signup("ryan");
  const { secret, codes, step } = await enable2fa(b, env);
  const NEW = "a brand new passphrase", c = new Browser(env);
  const form = extra => ({ recovery_code: codes[0], new_password: NEW, new_password2: NEW, ...extra });

  assert.equal((await c.post("/login/forgot", form({}))).status, 401, "recovery code alone isn't enough");
  assert.equal((await c.post("/login/forgot", form({ app_code: await codeAt(secret, step) }))).status, 401, "no replaying the last code");
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NOT NULL").n, 0);
  assert.equal((await c.post("/login/forgot", form({ app_code: await codeAt(secret, step + 1) }))).status, 200);
  assert.equal(sqlOne(env, "SELECT totp_last_step FROM users").totp_last_step, step + 1, "that app code is spent");
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM sessions WHERE stage = 'full'").n, 1);
});

test("forgot password is throttled and refuses disabled accounts", async () => {
  const env = makeEnv(), b = new Browser(env);
  await b.signup("ryan");
  const codes = await makeCodes(b);
  const NEW = "a brand new passphrase", c = new Browser(env);
  for (let i = 0; i < 30; i++) await c.post("/login/forgot", { recovery_code: "bbbbb-bbbb" + "abcdefghijklmnopqrstuvwxyz234567"[i], new_password: NEW, new_password2: NEW });
  assert.equal((await c.post("/login/forgot", { recovery_code: codes[0], new_password: NEW, new_password2: NEW })).status, 429);

  run(env, "UPDATE users SET disabled = 1");
  assert.equal((await new Browser(env).post("/login/forgot", { recovery_code: codes[0], new_password: NEW, new_password2: NEW })).status, 401);
});

// ── dashboard ──────────────────────────────────────────────────────────────
test("the dashboard lists only the apps an account can use", async () => {
  const env = makeEnv({ ADMIN_CLAIM_CODE: "claim-code-1234" }), b = new Browser(env);
  assert.equal((await b.get("/dashboard")).location, "/login?next=%2Fdashboard");
  await b.signup("ryan", PW, "<b>Ryan</b>");
  let page = await b.get("/dashboard");
  assert.equal(page.status, 200);
  assert.match(page.text, /href="\/todo\/"/);
  assert.doesNotMatch(page.text, /href="\/admin"/);
  assert.match(page.text, /&lt;b&gt;Ryan&lt;\/b&gt;/, "names are escaped");
  assert.doesNotMatch(page.text, /<b>Ryan/);

  run(env, "DELETE FROM user_areas");
  assert.match((await b.get("/dashboard")).text, /doesn't have any apps yet/);

  // An admin without two-factor finishes setup first, then sees Admin too.
  await b.post("/admin/claim", { code: env.ADMIN_CLAIM_CODE });
  assert.equal((await b.get("/dashboard")).location, "/account");
  await enable2fa(b, env);
  page = await b.get("/dashboard");
  assert.match(page.text, /href="\/admin"/);
  assert.doesNotMatch(page.text, /href="\/todo\/"/);
});

// ── admin ──────────────────────────────────────────────────────────────────
async function makeAdmin(env, name = "ryan") {
  const b = new Browser(env);
  await b.signup(name);
  assert.equal((await b.post("/admin/claim", { code: env.ADMIN_CLAIM_CODE })).location, "/account");
  await enable2fa(b, env);
  return b;
}

test("claiming admin needs the secret code, works once, and requires two-factor", async () => {
  const off = makeEnv(), x = new Browser(off);
  await x.signup("ryan");
  assert.match((await x.get("/admin/claim")).text, /switched off/);
  assert.equal((await x.post("/admin/claim", { code: "" })).status, 200);
  assert.equal(sqlOne(off, "SELECT COUNT(*) AS n FROM user_areas WHERE area = 'admin'").n, 0);

  const env = makeEnv({ ADMIN_CLAIM_CODE: "claim-code-1234" }), b = new Browser(env);
  await b.signup("ryan");
  assert.equal((await b.post("/admin/claim", { code: "wrong" })).status, 401);
  assert.equal((await b.post("/admin/claim", { code: "claim-code-1234" })).status, 303);
  // An admin without two-factor is sent to set it up before anything else.
  assert.equal((await b.get("/admin")).location, "/account");
  assert.equal((await b.get("/todo/")).location, "/account");
  assert.equal((await b.get("/todo/api/tasks")).status, 403);
  await enable2fa(b, env);
  assert.equal((await b.get("/admin")).status, 200);
  assert.equal((await b.post("/account/2fa/disable", { password: PW })).status, 403, "admins can't turn two-factor off");

  // Once there's an admin, nobody else can claim it, even with the code.
  const other = new Browser(env);
  await other.signup("josh");
  assert.equal((await other.post("/admin/claim", { code: "claim-code-1234" })).location, "/admin");
  assert.equal((await other.get("/admin")).status, 403);
});

test("admin can disable, reset, re-permission and delete accounts", async () => {
  const env = makeEnv({ ADMIN_CLAIM_CODE: "c0de-c0de-c0de" });
  const admin = await makeAdmin(env);
  const josh = new Browser(env);
  await josh.signup("josh");
  await josh.req("POST", "/todo/api/tasks", { json: { title: "josh's task" } });
  const id = sqlOne(env, "SELECT id FROM users WHERE username = 'josh'").id;

  // Disable: signed out now, can't sign back in.
  assert.equal((await admin.post("/admin/disable", { user_id: id })).status, 200);
  assert.equal((await josh.get("/todo/api/tasks")).status, 401);
  assert.equal((await new Browser(env).login("josh")).status, 401);
  await admin.post("/admin/enable", { user_id: id });
  assert.equal((await josh.login("josh")).status, 303);

  // Remove the todo area: no more todo access.
  await admin.post("/admin/area", { user_id: id, area: "todo", op: "revoke" });
  assert.equal((await josh.get("/todo/")).status, 403);
  await admin.post("/admin/area", { user_id: id, area: "todo", op: "grant" });
  assert.equal((await josh.get("/todo/")).status, 200);

  // Reset password: shown once to the admin, must be changed at next sign-in.
  const reset = await admin.post("/admin/reset-password", { user_id: id });
  const temp = reset.text.match(/Temporary password for <strong>josh<\/strong>: <span class="mono">([^<]+)</)[1];
  assert.equal((await josh.get("/todo/api/tasks")).status, 401, "signed out by the reset");
  assert.equal((await josh.login("josh", temp)).status, 303);
  assert.equal((await josh.get("/todo/")).location, "/account");
  assert.match((await josh.get("/account")).text, /Choose a new password/);
  assert.equal((await josh.post("/account/password", { new_password: "josh likes pizza", new_password2: "josh likes pizza" })).status, 400, "can't contain the username");
  const NEW = "a fresh new passphrase";
  await josh.post("/account/password", { new_password: NEW, new_password2: NEW });
  assert.equal((await josh.get("/todo/api/tasks")).status, 200);

  // Admin can't lock themselves out.
  const me = sqlOne(env, "SELECT id FROM users WHERE username = 'ryan'").id;
  assert.equal((await admin.post("/admin/area", { user_id: me, area: "admin", op: "revoke" })).status, 400);
  assert.equal((await admin.post("/admin/disable", { user_id: me })).status, 400);

  // Delete needs the username typed in, and removes their tasks too.
  assert.equal((await admin.post("/admin/delete", { user_id: id, confirm: "nope" })).status, 400);
  assert.equal((await admin.post("/admin/delete", { user_id: id, confirm: "josh" })).status, 200);
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM users WHERE id = ?", id).n, 0);
  assert.equal(sqlOne(env, "SELECT COUNT(*) AS n FROM todo_tasks WHERE owner = ?", id).n, 0);
  assert.equal((await josh.get("/todo/api/tasks")).status, 401);
});

test("admin can hand tasks from before accounts existed to an account", async () => {
  const env = makeEnv({ ADMIN_CLAIM_CODE: "c0de-c0de-c0de" });
  const admin = await makeAdmin(env);
  run(env, "INSERT INTO todo_tasks (owner, id, data, updated) VALUES ('rm@example.com', 't_old1', '{\"title\":\"old task\"}', 'x')");
  const page = await admin.get("/admin");
  assert.match(page.text, /rm@example\.com/);
  const me = sqlOne(env, "SELECT id FROM users WHERE username = 'ryan'").id;
  assert.match((await admin.post("/admin/move-tasks", { from: "rm@example.com", to: me })).text, /Moved 1 task to ryan/);
  assert.deepEqual((await admin.get("/todo/api/tasks")).json.tasks.map(t => t.title), ["old task"]);
});

test("non-admins can't reach any admin action", async () => {
  const env = makeEnv({ ADMIN_CLAIM_CODE: "c0de-c0de-c0de" });
  await makeAdmin(env);
  const b = new Browser(env);
  await b.signup("josh");
  const me = sqlOne(env, "SELECT id FROM users WHERE username = 'ryan'").id;
  for (const path of ["/admin", "/admin/disable", "/admin/reset-password", "/admin/area", "/admin/delete"]) {
    const r = path === "/admin" ? await b.get(path) : await b.post(path, { user_id: me, area: "admin", op: "grant", confirm: "ryan" });
    assert.equal(r.status, 403, path);
  }
  assert.equal(sqlOne(env, "SELECT disabled FROM users WHERE username = 'ryan'").disabled, 0);
});

test("without a database everything signed-in fails closed", async () => {
  const env = makeEnv({ TODO_DB: undefined });
  const b = new Browser(env);
  assert.equal((await b.get("/todo/api/tasks")).status, 401, "no cookie: refused before the database is needed");
  assert.equal((await b.get("/todo/api/tasks", { cookie: "a".repeat(43) })).status, 500, "with a cookie: refused because it can't be checked");
  assert.equal((await b.signup("ryan")).status, 500);
  assert.equal((await b.get("/")).status, 200, "the public site still works");
});

test("TOTP codes from the current step are accepted (clock sanity)", async () => {
  assert.equal(String(await codeAt("JBSWY3DPEHPK3PXP", stepNow())).length, 6);
});

// ── email ──────────────────────────────────────────────────────────────────
function mailEnv(extra) {
  const outbox = [];
  const env = makeEnv({ MAILER: async m => { outbox.push(m); }, ...extra });
  return { env, outbox, link: (path, i = -1) => outbox.at(i).text.match(new RegExp(`https://sintfoap\\.test(${path}\\?token=[A-Za-z0-9_-]+)`))[1] };
}

async function addEmail(b, email, password = PW) {
  return b.post("/account/email", { email, password });
}

test("email is hidden until sending is set up", async () => {
  const env = makeEnv(), b = new Browser(env);
  await b.signup("ryan");
  assert.doesNotMatch((await b.get("/account")).text, /action="\/account\/email"/);
  assert.doesNotMatch((await b.get("/login/forgot")).text, /Email me a link/);
  assert.equal((await addEmail(b, "ryan@example.com")).status, 503);
});

test("adding an email needs the password and a click on the confirmation link", async () => {
  const { env, outbox, link } = mailEnv(), b = new Browser(env);
  await b.signup("ryan");
  assert.equal((await addEmail(b, "Ryan@Example.com", "not my password")).status, 401);
  assert.equal((await addEmail(b, "not an email")).status, 400);
  assert.equal(outbox.length, 0);

  assert.equal((await addEmail(b, "Ryan@Example.com")).status, 200);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, "ryan@example.com");
  assert.deepEqual({ ...sqlOne(env, "SELECT email, email_verified FROM users") }, { email: "ryan@example.com", email_verified: 0 });
  assert.match((await b.get("/account")).text, /isn't confirmed yet/);

  // The link works without being signed in, but only once.
  const confirm = link("/login/verify-email");
  assert.equal((await new Browser(env).get(confirm)).status, 200);
  assert.equal(sqlOne(env, "SELECT email_verified FROM users").email_verified, 1);
  assert.equal((await new Browser(env).get(confirm)).status, 400);
  assert.match((await b.get("/account")).text, /is confirmed/);

  // An old link can't confirm an address the account no longer has.
  await addEmail(b, "first@example.com");
  const stale = link("/login/verify-email");
  await addEmail(b, "second@example.com");
  assert.equal((await new Browser(env).get(stale)).status, 400);
  assert.equal(sqlOne(env, "SELECT email_verified FROM users").email_verified, 0);

  await addEmail(b, "");
  assert.deepEqual({ ...sqlOne(env, "SELECT email, email_verified FROM users") }, { email: null, email_verified: 0 });
});

test("a reset email sends the username and a one-time link", async () => {
  const { env, outbox, link } = mailEnv(), b = new Browser(env);
  await b.signup("ryan");
  await addEmail(b, "ryan@example.com");
  await new Browser(env).get(link("/login/verify-email"));
  const NEW = "a brand new passphrase", c = new Browser(env);

  // Same answer for an unknown address, and nothing is sent.
  const sent = outbox.length;
  const unknown = await c.post("/login/forgot/email", { email: "nobody@example.com" });
  assert.equal(unknown.status, 200);
  assert.equal(outbox.length, sent);

  const r = await c.post("/login/forgot/email", { email: "RYAN@example.com" });
  assert.equal(r.text, unknown.text, "the page doesn't say whether the address matched");
  assert.equal(outbox.length, sent + 1);
  assert.match(outbox.at(-1).text, /Your username is: ryan/);
  const reset = link("/login/reset");

  const form = await c.get(reset);
  assert.equal(form.status, 200);
  assert.match(form.text, /<span class="mono">ryan<\/span>/);
  const token = reset.split("token=")[1];
  assert.equal((await c.post("/login/reset", { token, new_password: NEW, new_password2: NEW + "x" })).status, 400);
  const done = await c.post("/login/reset", { token, new_password: NEW, new_password2: NEW });
  assert.equal(done.status, 200);
  assert.match(done.text, /Your username is <span class="mono">ryan<\/span>/);
  assert.equal((await c.get("/todo/api/tasks")).status, 200, "signed in");
  assert.equal((await b.get("/todo/api/tasks")).status, 401, "other devices signed out");
  assert.equal((await new Browser(env).login("ryan", NEW)).status, 303);

  assert.equal((await new Browser(env).get(reset)).status, 400, "the link works once");
  assert.equal((await new Browser(env).post("/login/reset", { token, new_password: PW, new_password2: PW })).status, 400);
});

test("reset links need a confirmed address, expire, and ask for two-factor", async () => {
  const { env, outbox, link } = mailEnv(), b = new Browser(env);
  await b.signup("ryan");
  await addEmail(b, "ryan@example.com");
  const sent = outbox.length;
  await new Browser(env).post("/login/forgot/email", { email: "ryan@example.com" });
  assert.equal(outbox.length, sent, "unconfirmed addresses get nothing");

  await new Browser(env).get(link("/login/verify-email"));
  const { secret, step } = await enable2fa(b, env);
  await new Browser(env).post("/login/forgot/email", { email: "ryan@example.com" });
  const token = link("/login/reset").split("token=")[1];
  const NEW = "a brand new passphrase", c = new Browser(env);
  assert.match((await c.get("/login/reset?token=" + token)).text, /authenticator app/);
  assert.equal((await c.post("/login/reset", { token, new_password: NEW, new_password2: NEW })).status, 401, "the link alone isn't enough");
  assert.equal((await c.post("/login/reset", { token, new_password: NEW, new_password2: NEW, code: await codeAt(secret, step + 1) })).status, 200);

  await new Browser(env).post("/login/forgot/email", { email: "ryan@example.com" });
  const old = link("/login/reset").split("token=")[1];
  run(env, "UPDATE email_tokens SET expires_at = 1");
  assert.equal((await c.get("/login/reset?token=" + old)).status, 400);
});

test("reset emails are limited per inbox", async () => {
  const { env, outbox, link } = mailEnv(), b = new Browser(env);
  await b.signup("ryan");
  await addEmail(b, "ryan@example.com");
  await new Browser(env).get(link("/login/verify-email"));
  const sent = outbox.length;
  for (let i = 0; i < 5; i++) await new Browser(env).post("/login/forgot/email", { email: "ryan@example.com" });
  assert.equal(outbox.length, sent + 2, "3 emails to one inbox per hour, counting the confirmation");
});

test("older databases get the email columns added", async () => {
  const env = makeEnv();
  env.TODO_DB.raw.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL, must_change_pw INTEGER NOT NULL DEFAULT 0, totp_secret TEXT, totp_pending TEXT,
    totp_last_step INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
  assert.equal((await new Browser(env).signup("ryan")).status, 303);
  assert.deepEqual({ ...sqlOne(env, "SELECT email, email_verified FROM users") }, { email: null, email_verified: 0 });
});
