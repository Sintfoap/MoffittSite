// Entry point for the site's Worker.
//
// Static files in public/ are served by Cloudflare directly and never reach
// this code. Paths listed in "run_worker_first" in wrangler.jsonc come
// through here: the sign-in pages (src/account.js), /login/status for the
// homepage's sign-in link, and /todo, which needs a signed-in account with the
// "todo" area before the page or API is served. /plugins (the plugin store,
// src/store.js) and /chat (src/chat.js) each need their own app turned on for
// the account on the admin page, and so do /notifications (src/notify.js),
// /recipes, the Recipe box (src/recipes.js), /sweep, which suggests Drift
// items from chat rooms (src/sweep.js), and /groceries, Grocery autopilot,
// which sends a Drift list and recipes to a store (src/groceries.js).
// /mcp is the MCP server AI agents use Drift through, with an API key (src/mcp.js).
// /login/cli is signing in from a terminal (src/cli.js). /app and
// /.well-known/assetlinks.json are the Android app's download page, release
// check and domain link (src/phone.js). /_matrix/push/v1/notify
// is where Matrix homeservers tell the site about new messages for
// notifications (src/notify.js). scheduled() is the cron trigger in
// wrangler.jsonc: Drift's reminders, and syncing chat connections.
// /books/api is the public book suggestions page's votes (src/books.js); anyone
// can use it, signed in or not.
import { plugins, installed, install, uninstall, PLUGIN_ID, SANDBOX_CSP } from "./store.js";
import { hasPlaces, searchPlaces, nameOf } from "./places.js";
import { protect, handleAuth, AUTH_PATHS, sameOrigin } from "./account.js";
import { currentSession, areaOf } from "./auth.js";
import { handleCli, CLI_PATHS } from "./cli.js";
import { mcp, MCP_PATHS } from "./mcp.js";
import { handlePhone, PHONE_PATHS } from "./phone.js";
import { withRail } from "./pages.js";
import { chat } from "./chat.js";
import { recipes } from "./recipes.js";
import { books } from "./books.js";
import { sweepApp } from "./sweep.js";
import { groceries } from "./groceries.js";
import { notifications, driftReminders, pushGateway, bridgeUpkeep } from "./notify.js";
import { state, version, createItem, updateItem, createCollection, updateCollection, setBases, shareCollection, unshareCollection, readJson, BadRequest, ID } from "./drift.js";
import { planDay } from "./routing.js";

// /todo/api/state, /todo/api/version, /todo/api/items[/<id>],
// /todo/api/collections[/<id>[/shares[/<username>]]]
const API = /^\/todo\/api\/(state|version|items|collections|installs|places|route)(?:\/([^/]+)(?:\/(shares)(?:\/([^/]+))?)?)?\/?$/;
const USERNAME = /^[a-z0-9_.-]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), { pathname } = url;
    // "/todo" → "/todo/" before anything else; the redirect itself reveals nothing.
    if (pathname === "/todo") {
      url.pathname = "/todo/";
      return Response.redirect(url.toString(), 308);
    }
    if (pathname.startsWith("/todo/")) {
      return protect(request, env, areaOf("drift"), user => todo(request, env, user, pathname));
    }
    if (pathname === "/plugins") {
      url.pathname = "/plugins/";
      return Response.redirect(url.toString(), 308);
    }
    if (pathname.startsWith("/plugins/")) {
      return protect(request, env, areaOf("plugins"), user => plugins(request, env, user, pathname));
    }
    if (pathname === "/chat") {
      url.pathname = "/chat/";
      return Response.redirect(url.toString(), 308);
    }
    if (pathname.startsWith("/chat/")) {
      return protect(request, env, areaOf("chat"), user => chat(request, env, user, pathname, ctx));
    }
    if (pathname === "/notifications") {
      url.pathname = "/notifications/";
      return Response.redirect(url.toString(), 308);
    }
    if (pathname.startsWith("/notifications/")) {
      return protect(request, env, areaOf("notifications"), user => notifications(request, env, user, pathname));
    }
    if (pathname === "/recipes") {
      url.pathname = "/recipes/";
      return Response.redirect(url.toString(), 308);
    }
    if (pathname.startsWith("/recipes/")) {
      return protect(request, env, areaOf("recipes"), user => recipes(request, env, user, pathname));
    }
    if (pathname === "/sweep") {
      url.pathname = "/sweep/";
      return Response.redirect(url.toString(), 308);
    }
    if (pathname.startsWith("/sweep/")) {
      return protect(request, env, areaOf("sweep"), user => sweepApp(request, env, user, pathname));
    }
    if (pathname === "/groceries") {
      url.pathname = "/groceries/";
      return Response.redirect(url.toString(), 308);
    }
    if (pathname.startsWith("/groceries/")) {
      return protect(request, env, areaOf("groceries"), user => groceries(request, env, user, pathname));
    }
    // Book suggestions: public, so no sign-in (src/books.js). The page itself is public/books/.
    if (pathname === "/books/api" || pathname.startsWith("/books/api/")) return books(request, env);
    // The frame store plugins run in. It holds no data and needs no sign-in.
    if (pathname.startsWith("/sandbox/")) return sandbox(request, env);
    if (pathname === "/_matrix/push/v1/notify") return pushGateway(request, env, ctx ? p => ctx.waitUntil(p) : undefined);
    if (pathname === "/login/status") return loginStatus(request, env);
    if (MCP_PATHS.test(pathname)) return mcp(request, env);
    if (CLI_PATHS.test(pathname)) return handleCli(request, env);
    if (PHONE_PATHS.test(pathname)) return handlePhone(request, env);
    if (AUTH_PATHS.test(pathname)) return handleAuth(request, env);
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(driftReminders(env, controller.scheduledTime).catch(e => console.error("drift reminders failed:", e)));
    ctx.waitUntil(bridgeUpkeep(env).catch(e => console.error("connection upkeep failed:", e)));
  },
};

// For the homepage's sign-in link: whether this browser is signed in, nothing more.
// Never fails: if the session can't be checked, the visitor just sees "Sign in".
async function loginStatus(request, env) {
  let s = null;
  try { s = await currentSession(env, request); }
  catch (e) { console.error("session check failed:", e); }
  return new Response(JSON.stringify({ signedIn: !!s }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Everything under /todo/ for a signed-in user: the API, or the page itself.
async function todo(request, env, user, pathname) {
  if (!pathname.startsWith("/todo/api/")) return withRail(await env.ASSETS.fetch(request), user, "drift");
  const method = request.method;
  return handle(async () => {
    if (method !== "GET" && !sameOrigin(request)) return json({ error: "cross-origin request refused" }, 403);
    const m = pathname.match(API);
    if (!m) return json({ error: "not found" }, 404);
    const [, kind, id, sub, who] = m;

    // GET → the user's collections, items and the plugins there are
    if (kind === "state") return method === "GET" && !id ? json(await state(env, user)) : json({ error: "not found" }, 404);
    // GET → a fingerprint that changes whenever any of the user's data does
    if (kind === "version") return method === "GET" && !id ? json({ version: await version(env, user.id) }) : json({ error: "not found" }, 404);

    // GET places?q=…[&near=lat,lng] → {results: [{place, lat, lng}]}, places matching q (Locations' search)
    // GET places?lat=…&lng=…        → {place}, the name of that spot
    // {off: true} when the site has no OpenRouteService key.
    if (kind === "places") {
      if (method !== "GET" || id) return json({ error: "not found" }, 404);
      if (!hasPlaces(env)) return json({ off: true, results: [], place: "" });
      const q = new URL(request.url).searchParams, num = k => Number(q.get(k));
      if (q.has("lat")) {
        const lat = num("lat"), lng = num("lng");
        if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return json({ error: "lat and lng must be coordinates" }, 400);
        const place = await nameOf(env, lat, lng);
        return place === null ? json({ error: "couldn’t reach the map service" }, 502) : json({ place });
      }
      const [lat, lng] = String(q.get("near") || "").split(",").map(Number);
      const results = await searchPlaces(env, q.get("q"), Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null);
      return results === null ? json({ error: "couldn’t reach the map service" }, 502) : json({ results });
    }

    // GET route?collection=<id>&day=YYYY-MM-DD[&profile=driving-car|foot-walking|cycling-regular][&option=n]
    //   → the day's route from its base and back (src/routing.js)
    if (kind === "route") {
      if (method !== "GET" || id) return json({ error: "not found" }, 404);
      const q = new URL(request.url).searchParams, day = q.get("day") || "";
      if (!ID.test(q.get("collection") || "") || !DAY.test(day)) return json({ error: "collection and day (YYYY-MM-DD) are needed" }, 400);
      const out = await planDay(env, user, q.get("collection"), day, q.get("profile") || undefined, q.get("option"));
      return out ? json(out) : json({ error: "not found" }, 404);
    }

    // GET    installs       → the ids of the store plugins you've added to Drift
    // POST   installs/<id>  → add an approved store plugin
    // DELETE installs/<id>  → remove it (collections using it keep their data)
    if (kind === "installs") {
      if (sub) return json({ error: "not found" }, 404);
      if (!id) return method === "GET" ? json({ installed: await installed(env, user.id) }) : json({ error: "method not allowed" }, 405);
      if (!PLUGIN_ID.test(id)) return json({ error: "not found" }, 404);
      const out = method === "POST" ? await install(env, user.id, id) : method === "DELETE" ? await uninstall(env, user.id, id) : undefined;
      if (out === undefined) return json({ error: "method not allowed" }, 405);
      return out ? json(out) : json({ error: "not found" }, 404);
    }

    if (sub) {
      // POST   collections/<id>/shares             {username, role} → share it, or change their role
      // DELETE collections/<id>/shares/<username>  → stop sharing (or leave, if it's you)
      if (kind !== "collections" || !ID.test(id)) return json({ error: "not found" }, 404);
      let out;
      if (!who && method === "POST") out = await shareCollection(env, user, id, await readJson(request));
      else if (who && method === "DELETE") out = USERNAME.test(decodeURIComponent(who)) ? await unshareCollection(env, user, id, decodeURIComponent(who)) : null;
      else return json({ error: "method not allowed" }, 405);
      return out ? json(out, method === "POST" ? 201 : 200) : json({ error: "not found" }, 404);
    }

    // Items act as `user` (they may be in someone else's shared collection);
    // collections can only be created and changed by their owner.
    const [create, update, as] = kind === "items" ? [createItem, updateItem, user] : [createCollection, updateCollection, user.id];
    if (!id) {
      // POST → create from explicit fields ({title, collection, meta, ...} or {name, plugins, ...})
      if (method === "POST") return json(await create(env, as, await readJson(request)), 201);
      return json({ error: "method not allowed" }, 405);
    }
    // PATCH  → change the fields sent; meta: {plugin: value | null}
    // DELETE → soft delete (PATCH {deleted:false} undoes it)
    if (!ID.test(id)) return json({ error: "not found" }, 404);
    let changes;
    if (method === "PATCH") changes = await readJson(request);
    else if (method === "DELETE") changes = { deleted: true };
    else return json({ error: "method not allowed" }, 405);
    // A collection's bases alone can be changed by anyone who can edit it.
    const basesOnly = kind === "collections" && changes && typeof changes === "object" && Object.keys(changes).join() === "bases";
    const out = basesOnly ? await setBases(env, user, id, changes.bases) : await update(env, as, id, changes);
    return out ? json(out) : json({ error: "not found" }, 404);
  });
}

// Store plugins run inside this page, in a sandboxed frame with no access to
// the site. Its policy also stops plugin code from sending anything anywhere.
async function sandbox(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  const asset = await env.ASSETS.fetch(request);
  const res = new Response(asset.body, asset);
  res.headers.set("Content-Security-Policy", SANDBOX_CSP);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Cache-Control", "no-cache");
  return res;
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

// Turns thrown errors into JSON responses; unexpected ones are logged, not leaked.
async function handle(fn) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    console.error("drift api error:", e);
    return json({ error: "server error" }, 500);
  }
}
