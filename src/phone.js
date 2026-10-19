// The Android app: a small APK (android/) that opens the phone app, /m/, full
// screen in Chrome, as a Trusted Web Activity. The screens are the site's, so
// they update with every deploy; the APK itself only changes for things like
// its icon or name, and the phone app offers that update itself.
//
//   GET /app                          a page to download it from, with a QR code to scan from a computer
//   GET /app/latest.json              → {version, name, url, published_at, notes, page, qr}: the newest
//                                       release on GitHub (version null before the first)
//   GET /.well-known/assetlinks.json  tells Android the APK signed with ANDROID_CERT_SHA256 speaks for
//                                     this site, which is what lets it open without a browser bar
//
// Releases are made by .github/workflows/android.yml when a tag app-v<N> is
// pushed: it builds the APK as version N and attaches it as sintfoap.apk.

import { renderSVG, renderUnicodeCompact } from "./vendor/uqr.mjs";
import { page, html, esc } from "./pages.js";

export const PHONE_PATHS = /^\/(app(\/|$)|\.well-known\/assetlinks\.json$)/;
export const PACKAGE = "xyz.sintfoap.app";
export const REPO = "Sintfoap/MoffittSite";
const TAG = /^app-v(\d{1,6})$/;
const ASSET = "sintfoap.apk";
const KEEP = 10 * 60 * 1000;   // how long one Worker keeps what GitHub said

let held = null;   // { at, release }

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", ...extra } });

// The newest app-v<N> release with its APK attached, or null.
export async function latestRelease(env, { fresh = false } = {}) {
  if (!fresh && held && Date.now() - held.at < KEEP) return held.release;
  let release = null;
  try {
    const r = await fetch(`https://api.github.com/repos/${env.APP_RELEASES_REPO || REPO}/releases?per_page=20`, {
      headers: { "User-Agent": "sintfoap.xyz", Accept: "application/vnd.github+json" },
      cf: { cacheTtl: 600, cacheEverything: true },
    });
    if (!r.ok) throw new Error(`GitHub said ${r.status}`);
    const found = (await r.json())
      .filter(x => !x.draft && !x.prerelease && TAG.test(x.tag_name) && x.assets?.some(a => a.name === ASSET))
      .sort((a, b) => +b.tag_name.match(TAG)[1] - +a.tag_name.match(TAG)[1])[0];
    if (found) release = {
      version: +found.tag_name.match(TAG)[1], name: found.name || found.tag_name,
      url: found.assets.find(a => a.name === ASSET).browser_download_url,
      published_at: found.published_at, notes: String(found.body || "").slice(0, 2000),
    };
  } catch (e) {
    console.error("app releases:", e.message);
    if (held) return held.release;   // GitHub is down or rate-limited: keep saying what it said last
  }
  held = { at: Date.now(), release };
  return release;
}

export async function handlePhone(request, env) {
  const { pathname, origin } = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method not allowed" }, 405);

  if (pathname === "/.well-known/assetlinks.json") {
    // Fingerprints are public (anyone can read them off the APK); several, comma-separated, for a key change.
    const prints = String(env.ANDROID_CERT_SHA256 || "").split(",").map(s => s.trim().toUpperCase()).filter(s => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(s));
    if (!prints.length) return json({ error: "not found" }, 404);
    return json([{ relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: PACKAGE, sha256_cert_fingerprints: prints } }]);
  }

  const pageUrl = origin + "/app";
  if (pathname === "/app/latest.json") {
    const r = await latestRelease(env);
    return json({ version: null, ...r, page: pageUrl, qr: renderUnicodeCompact(pageUrl) });
  }
  if (pathname === "/app" || pathname === "/app/") {
    const r = await latestRelease(env);
    const when = r && new Date(r.published_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    return html(page("The phone app", `
      <div class="kicker">sintfoap.xyz</div><h1>The phone app</h1>
      <div class="card">
        <p>sintfoap.xyz made for your phone: Drift, chat and your day, with a tab bar at the bottom. It isn't on the Play Store; you install it from here, and it tells you when there's a new version.</p>
        ${r ? `<a class="btn" href="${esc(r.url)}">Download for Android</a>
          <p class="hint">Version ${r.version}, from ${esc(when)}. Android asks once to let your browser install apps; allow it, then open the download.</p>`
          : `<p class="hint">There's no APK to download yet. You can still install it from Chrome, below.</p>`}
      </div>
      <div class="card">
        <h2>On a computer?</h2>
        <p>Scan this with your phone's camera to open this page there.</p>
        <div style="width:180px;background:#fff;padding:10px">${renderSVG(pageUrl)}</div>
      </div>
      <div class="card">
        <h2>Or without the APK</h2>
        <p>Open <a href="/m/">${esc(origin.replace(/^https?:\/\//, ""))}/m/</a> in Chrome, then ⋮ → Install app. Same app, installed by Chrome instead.</p>
      </div>`), { headers: { "Cache-Control": "public, max-age=300" } });
  }
  return json({ error: "not found" }, 404);
}
