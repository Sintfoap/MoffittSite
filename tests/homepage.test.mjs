// The homepage's sign-in link (public/index.html) and the status route behind it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, enable2fa } from "./helpers.mjs";

test("the homepage can tell whether you're signed in, and nothing more", async () => {
  const env = makeEnv(), b = new Browser(env);
  let r = await b.get("/login/status");
  assert.deepEqual(r.json, { signedIn: false });
  assert.equal(r.headers.get("Cache-Control"), "no-store");

  await b.signup("ryan");
  assert.deepEqual((await b.get("/login/status")).json, { signedIn: true });
  // The homepage link goes to /login, which sends a signed-in visitor on to their page.
  r = await b.get("/login");
  assert.equal(r.status, 303);
  assert.notEqual(r.location, "/login");

  await enable2fa(b, env);
  await b.get("/logout");
  await b.login("ryan");
  assert.deepEqual((await b.get("/login/status")).json, { signedIn: false }, "password alone, before the code, isn't signed in");

  const noDb = new Browser(makeEnv({ TODO_DB: undefined }));
  assert.deepEqual((await noDb.get("/login/status", { cookie: "a".repeat(43) })).json, { signedIn: false }, "previews just show Sign in");
});
