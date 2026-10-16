// Tests for signing in from a terminal (src/cli.js).
// Run with:  node --no-warnings --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, sqlOne, run, enable2fa } from "./helpers.mjs";
import { APPS } from "../src/auth.js";

// A terminal: no Origin header, no cookie jar; it sends its token as the session cookie.
class Terminal extends Browser {
  async start(name = "laptop") { return this.req("POST", "/login/cli/start", { json: { name }, origin: null }); }
  async poll(device_code) { return this.req("POST", "/login/cli/token", { json: { device_code }, origin: null }); }
}

const approve = (b, code) => b.post("/login/cli", { code, confirm: "yes" });

test("a terminal signs in once someone approves its code in the browser", async () => {
  const env = makeEnv(), b = new Browser(env), term = new Terminal(env);
  await b.signup("ryan");

  const s = await term.start("ryan-laptop");
  assert.equal(s.status, 200);
  assert.match(s.json.user_code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(s.json.verification_uri, "https://sintfoap.test/login/cli");
  assert.equal(s.json.verification_uri_complete, `https://sintfoap.test/login/cli?code=${s.json.user_code}`);
  assert.ok(!sqlOne(env, "SELECT code_hash FROM cli_logins").code_hash.includes(s.json.device_code), "only a hash is stored");

  assert.equal((await term.poll(s.json.device_code)).json.error, "authorization_pending");

  // Opening the link shows who's asking, and approves nothing by itself.
  const page = await b.get(`/login/cli?code=${s.json.user_code.toLowerCase().replace("-", "")}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /ryan-laptop/);
  assert.match(page.text, new RegExp(s.json.user_code));
  assert.equal((await term.poll(s.json.device_code)).json.error, "authorization_pending");

  // Typing the code shows the same confirmation; only the Approve button approves.
  const typed = await b.post("/login/cli", { code: s.json.user_code });
  assert.match(typed.text, /Approve/);
  assert.equal((await term.poll(s.json.device_code)).json.error, "authorization_pending");

  const ok = await approve(b, s.json.user_code);
  assert.equal(ok.status, 200);
  assert.match(ok.text, /signed in as ryan/);

  const t = await term.poll(s.json.device_code);
  assert.equal(t.status, 200);
  assert.equal(t.json.username, "ryan");
  assert.ok(t.json.token.length >= 40);

  // The token is a normal session: it reaches signed-in pages and can write without an Origin header.
  term.cookie = t.json.token;
  assert.equal((await term.get("/login/cli/me")).json.username, "ryan");
  const inbox = (await term.get("/todo/api/state")).json.collections[0].id;
  assert.equal((await term.req("POST", "/todo/api/items", { json: { title: "from the terminal", collection: inbox }, origin: null })).status, 201);
  assert.ok((await b.get("/todo/api/state")).json.items.some(i => i.title === "from the terminal"));

  // The code is spent.
  assert.equal((await new Terminal(env).poll(s.json.device_code)).json.error, "expired_token");
  assert.equal((await approve(b, s.json.user_code)).status, 400);
});

test("the approval page needs a signed-in browser and a same-site form", async () => {
  const env = makeEnv(), b = new Browser(env), term = new Terminal(env);
  const s = await term.start();

  const anon = await b.get(`/login/cli?code=${s.json.user_code}`);
  assert.equal(anon.status, 303);
  assert.equal(anon.location, `/login?next=${encodeURIComponent(`/login/cli?code=${s.json.user_code}`)}`);

  await b.signup("ryan");
  const forged = await b.req("POST", "/login/cli", { form: { code: s.json.user_code, confirm: "yes" }, origin: "https://evil.test" });
  assert.equal(forged.status, 403);
  assert.equal((await term.poll(s.json.device_code)).json.error, "authorization_pending");
});

test("refusing a code tells the terminal, and wrong or expired codes approve nothing", async () => {
  const env = makeEnv(), b = new Browser(env), term = new Terminal(env);
  await b.signup("ryan");

  const s = await term.start();
  await b.post("/login/cli", { code: s.json.user_code, action: "deny" });
  assert.equal((await term.poll(s.json.device_code)).json.error, "access_denied");
  assert.equal((await term.poll(s.json.device_code)).json.error, "expired_token");

  assert.equal((await approve(b, "ZZZZ-ZZZZ")).status, 400);
  assert.equal((await term.poll("not-a-real-code")).json.error, "expired_token");

  const old = await term.start();
  run(env, "UPDATE cli_logins SET expires_at = 0");
  assert.equal((await approve(b, old.json.user_code)).status, 400);
  assert.equal((await term.poll(old.json.device_code)).json.error, "expired_token");
});

test("signing out everywhere or disabling the account ends terminal sign-ins too", async () => {
  const env = makeEnv(), b = new Browser(env), term = new Terminal(env);
  await b.signup("ryan");
  const s = await term.start();
  await approve(b, s.json.user_code);
  term.cookie = (await term.poll(s.json.device_code)).json.token;
  assert.equal((await term.get("/todo/api/state")).status, 200);

  run(env, "UPDATE users SET disabled = 1");
  assert.equal((await term.get("/todo/api/state")).status, 401);
  assert.equal((await term.get("/login/cli/me")).status, 401);

  // A code approved just before the account was disabled gets nothing.
  run(env, "UPDATE users SET disabled = 0");
  const s2 = await term.start();
  await approve(b, s2.json.user_code);
  run(env, "UPDATE users SET disabled = 1");
  assert.equal((await term.poll(s2.json.device_code)).json.error, "access_denied");
});

test("the terminal can sign itself out", async () => {
  const env = makeEnv(), b = new Browser(env), term = new Terminal(env);
  await b.signup("ryan");
  const s = await term.start();
  await approve(b, s.json.user_code);
  const token = (await term.poll(s.json.device_code)).json.token;
  term.cookie = token;
  await term.req("POST", "/logout", { origin: null });
  assert.equal((await term.get("/todo/api/state", { cookie: token })).status, 401);
  assert.equal((await b.get("/todo/api/state")).status, 200, "the browser stays signed in");
});

test("two-factor accounts approve from their signed-in browser; admins must have it set up", async () => {
  const env = makeEnv(), b = new Browser(env), term = new Terminal(env);
  await b.signup("ryan");
  await enable2fa(b, env);
  const s = await term.start();
  assert.equal((await approve(b, s.json.user_code)).status, 200);
  assert.equal((await term.poll(s.json.device_code)).status, 200);

  const env2 = makeEnv(), admin = new Browser(env2), term2 = new Terminal(env2);
  await admin.signup("boss");
  run(env2, "INSERT INTO user_areas (user_id, area) SELECT id, 'admin' FROM users");
  const s2 = await term2.start();
  const r = await approve(admin, s2.json.user_code);
  assert.equal(r.status, 303);
  assert.equal(r.location, "/account");
  assert.equal((await term2.poll(s2.json.device_code)).json.error, "authorization_pending");
});

test("one address can only have a few codes waiting", async () => {
  const env = makeEnv(), ip = "198.51.100.9";
  for (let i = 0; i < 5; i++) assert.equal((await new Terminal(env, { ip }).start()).status, 200);
  assert.equal((await new Terminal(env, { ip }).start()).status, 429);
  assert.equal((await new Terminal(env).start()).status, 200, "other addresses are unaffected");
});

test("the terminal dashboard shows what /dashboard does", async () => {
  const env = makeEnv(), b = new Browser(env), term = new Terminal(env);
  await b.signup("ryan", undefined, "Ryan M");
  assert.equal((await term.get("/login/cli/dashboard")).status, 401);
  const s = await term.start();
  await approve(b, s.json.user_code);
  term.cookie = (await term.poll(s.json.device_code)).json.token;

  const d = (await term.get("/login/cli/dashboard")).json;
  assert.equal(d.site, "https://sintfoap.test");
  assert.deepEqual(d.user, { username: "ryan", display_name: "Ryan M", admin: false });
  // The same apps, in the same order, as the web dashboard gives a "todo" account.
  assert.deepEqual(d.apps.map(a => [a.name, a.url]), APPS.filter(a => a.area === "todo").map(a => [a.name, "https://sintfoap.test" + a.href]));
  assert.ok(d.apps.some(a => a.name === "Drift"));
  assert.equal(d.account.two_factor, false);
  assert.equal(d.account.sessions, 2, "the browser and the terminal");
  assert.equal(d.account.recovery_codes_left, 0);
  assert.equal(d.account.setup_needed, null);
  assert.equal(d.account.url, "https://sintfoap.test/account");

  // Same rule as the web dashboard: an admin without two-factor only gets account settings.
  run(env, "INSERT INTO user_areas (user_id, area) SELECT id, 'admin' FROM users");
  const admin = (await term.get("/login/cli/dashboard")).json;
  assert.equal(admin.user.admin, true);
  assert.deepEqual(admin.apps, []);
  assert.equal(admin.account.setup_needed, "set up two-factor");
});
