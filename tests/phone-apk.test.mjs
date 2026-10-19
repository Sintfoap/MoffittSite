// The Android app's side of the site (src/phone.js): the download page, the
// release check the phone app's update banner uses, and the domain link that
// lets the APK open the site without a browser bar.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv } from "./helpers.mjs";
import { latestRelease } from "../src/phone.js";

const realFetch = globalThis.fetch;
let releases, calls;
const release = (n, extra = {}) => ({
  tag_name: `app-v${n}`, name: `sintfoap for Android app-v${n}`, draft: false, prerelease: false, published_at: "2026-10-19T12:00:00Z", body: "notes",
  assets: [{ name: "sintfoap.apk", browser_download_url: `https://github.com/Sintfoap/MoffittSite/releases/download/app-v${n}/sintfoap.apk` }], ...extra,
});
beforeEach(async () => {
  releases = []; calls = 0;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith("https://api.github.com/")) return realFetch(url, init);
    calls++;
    return releases === "down" ? new Response("no", { status: 503 }) : new Response(JSON.stringify(releases), { headers: { "Content-Type": "application/json" } });
  };
  await latestRelease(makeEnv(), { fresh: true });   // forget what an earlier test was told
});
afterEach(() => { globalThis.fetch = realFetch; });

test("latest.json names the newest app release with its APK, and a QR code for the terminal", async () => {
  releases = [release(2), release(10), release(11, { draft: true }), release(12, { assets: [] }), { ...release(13), tag_name: "v13" }];
  await latestRelease(makeEnv(), { fresh: true });
  const r = await new Browser(makeEnv()).get("/app/latest.json");
  assert.equal(r.status, 200);
  assert.equal(r.json.version, 10);
  assert.match(r.json.url, /app-v10\/sintfoap\.apk$/);
  assert.equal(r.json.page, "https://sintfoap.test/app");
  assert.ok(r.json.qr.split("\n").length > 10);
});

test("before the first release there's nothing to download, but the page still works", async () => {
  const b = new Browser(makeEnv());
  assert.equal((await b.get("/app/latest.json")).json.version, null);
  const page = await b.get("/app");
  assert.equal(page.status, 200);
  assert.match(page.text, /no APK to download yet/);
  assert.match(page.text, /<svg/);
});

test("the download page links the APK, and GitHub is asked at most every few minutes", async () => {
  releases = [release(3)];
  await latestRelease(makeEnv(), { fresh: true });
  calls = 0;
  const b = new Browser(makeEnv());
  const page = await b.get("/app");
  assert.match(page.text, /href="https:\/\/github\.com\/Sintfoap\/MoffittSite\/releases\/download\/app-v3\/sintfoap\.apk"/);
  assert.match(page.text, /Version 3/);
  await b.get("/app/latest.json");
  assert.equal(calls, 0);
  // GitHub down: keep saying what it said last.
  releases = "down";
  assert.equal((await latestRelease(makeEnv(), { fresh: true })).version, 3);
});

test("assetlinks.json names the app's signing key only once one is set", async () => {
  assert.equal((await new Browser(makeEnv()).get("/.well-known/assetlinks.json")).status, 404);
  const fp = Array(32).fill("ab").join(":");
  const r = await new Browser(makeEnv({ ANDROID_CERT_SHA256: `${fp}, not-a-fingerprint` })).get("/.well-known/assetlinks.json");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, [{ relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: "xyz.sintfoap.app", sha256_cert_fingerprints: [fp.toUpperCase()] } }]);
});

test("the app's pages only answer GET", async () => {
  assert.equal((await new Browser(makeEnv()).req("POST", "/app/latest.json")).status, 405);
  assert.equal((await new Browser(makeEnv()).get("/app/nope")).status, 404);
});
