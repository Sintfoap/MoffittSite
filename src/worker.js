// Entry point for the site's Worker.
//
// Static files in public/ are served by Cloudflare directly and never reach
// this code. Paths listed in "run_worker_first" in wrangler.jsonc come
// through here: the sign-in pages (src/account.js), /login/status for the
// homepage's sign-in link, and /todo, which needs a signed-in account with the
// "todo" area before the page or API is served. /plugins (the plugin store,
// src/store.js) is open to the same accounts.
import { plugins } from "./store.js";
import { protect, handleAuth, AUTH_PATHS, sameOrigin } from "./account.js";
import { currentSession } from "./auth.js";
import { list, create, update, readJson, BadRequest } from "./tasks.js";

const TASKS = /^\/todo\/api\/tasks\/?$/;
const TASK = /^\/todo\/api\/tasks\/([^/]+)$/;
const ID = /^t_[0-9a-z]{1,32}$/;

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

    if (TASKS.test(pathname)) {
      // GET  → the user's tasks, projects, tags, stats
      // POST → create a task from explicit fields ({title, due, ...})
      if (method === "GET") return json(await list(env, user.id, user.display_name));
      if (method === "POST") return json(await create(env, user.id, await readJson(request)), 201);
      return json({ error: "method not allowed" }, 405);
    }

    const m = pathname.match(TASK);
    if (m) {
      // PATCH  → change any of title notes done priority due project tags order deleted
      // DELETE → soft delete (PATCH {deleted:false} undoes it)
      if (!ID.test(m[1])) return json({ error: "not found" }, 404);
      let changes;
      if (method === "PATCH") changes = await readJson(request);
      else if (method === "DELETE") changes = { deleted: true };
      else return json({ error: "method not allowed" }, 405);
      const t = await update(env, user.id, m[1], changes);
      return t ? json(t) : json({ error: "not found" }, 404);
    }

    return json({ error: "not found" }, 404);
  });
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

// Turns thrown errors into JSON responses; unexpected ones are logged, not leaked.
async function handle(fn) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    console.error("todo api error:", e);
    return json({ error: "server error" }, 500);
  }
}
