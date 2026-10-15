// Entry point for the site's Worker.
//
// Static files in public/ are served by Cloudflare directly and never reach
// this code. Paths listed in "run_worker_first" in wrangler.jsonc come
// through here: the sign-in pages (src/account.js), /login/status for the
// homepage's sign-in link, and /todo, which needs a signed-in account with the
// "todo" area before the page or API is served.
import { protect, handleAuth, AUTH_PATHS, sameOrigin } from "./account.js";
import { currentSession } from "./auth.js";
import { state, createItem, updateItem, createCollection, updateCollection, readJson, BadRequest, ID } from "./drift.js";

// /todo/api/state, /todo/api/items[/<id>], /todo/api/collections[/<id>]
const API = /^\/todo\/api\/(state|items|collections)(?:\/([^/]+))?\/?$/;

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
    const [, kind, id] = m;

    // GET → the user's collections, items and the plugins there are
    if (kind === "state") return method === "GET" && !id ? json(await state(env, user)) : json({ error: "not found" }, 404);

    const [create, update] = kind === "items" ? [createItem, updateItem] : [createCollection, updateCollection];
    if (!id) {
      // POST → create from explicit fields ({title, collection, meta, ...} or {name, plugins, ...})
      if (method === "POST") return json(await create(env, user.id, await readJson(request)), 201);
      return json({ error: "method not allowed" }, 405);
    }
    // PATCH  → change the fields sent; meta: {plugin: value | null}
    // DELETE → soft delete (PATCH {deleted:false} undoes it)
    if (!ID.test(id)) return json({ error: "not found" }, 404);
    let changes;
    if (method === "PATCH") changes = await readJson(request);
    else if (method === "DELETE") changes = { deleted: true };
    else return json({ error: "method not allowed" }, 405);
    const out = await update(env, user.id, id, changes);
    return out ? json(out) : json({ error: "not found" }, 404);
  });
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
