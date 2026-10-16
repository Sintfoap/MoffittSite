// Entry point for the site's Worker.
//
// Static files in public/ are served by Cloudflare directly and never reach
// this code. Paths listed in "run_worker_first" in wrangler.jsonc come
// through here: the sign-in pages (src/account.js), /login/status for the
// homepage's sign-in link, and /todo, which needs a signed-in account with the
// "todo" area before the page or API is served. /plugins (the plugin store,
// src/store.js) is open to the same accounts.
import { plugins, installed, install, uninstall, PLUGIN_ID, SANDBOX_CSP } from "./store.js";
import { protect, handleAuth, AUTH_PATHS, sameOrigin } from "./account.js";
import { currentSession } from "./auth.js";
import { state, version, createItem, updateItem, createCollection, updateCollection, shareCollection, unshareCollection, readJson, BadRequest, ID } from "./drift.js";

// /todo/api/state, /todo/api/version, /todo/api/items[/<id>],
// /todo/api/collections[/<id>[/shares[/<username>]]]
const API = /^\/todo\/api\/(state|version|items|collections|installs)(?:\/([^/]+)(?:\/(shares)(?:\/([^/]+))?)?)?\/?$/;
const USERNAME = /^[a-z0-9_.-]{1,64}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url), { pathname } = url;
    // "/todo" → "/todo/" before anything else; the redirect itself reveals nothing.
    if (pathname === "/todo") {
      url.pathname = "/todo/";
      return Response.redirect(url.toString(), 308);
    }
    if (pathname.startsWith("/todo/")) {
      return protect(request, env, "todo", user => todo(request, env, user, pathname));
    }
    if (pathname === "/plugins") {
      url.pathname = "/plugins/";
      return Response.redirect(url.toString(), 308);
    }
    if (pathname.startsWith("/plugins/")) {
      return protect(request, env, "todo", user => plugins(request, env, user, pathname));
    }
    // The frame store plugins run in. It holds no data and needs no sign-in.
    if (pathname.startsWith("/sandbox/")) return sandbox(request, env);
    if (pathname === "/login/status") return loginStatus(request, env);
    if (AUTH_PATHS.test(pathname)) return handleAuth(request, env);
    return env.ASSETS.fetch(request);
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
  if (!pathname.startsWith("/todo/api/")) return env.ASSETS.fetch(request);
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
    const out = await update(env, as, id, changes);
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
