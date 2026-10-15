// Entry point for the site's Worker.
//
// Static files in public/ are served by Cloudflare directly and never reach
// this code. Only paths listed in "run_worker_first" in wrangler.jsonc
// (everything under /todo) come through here, where they must pass the
// Cloudflare Access check before the page or API is served.
import { protect } from "./access.js";
import { list, create, update, readJson, BadRequest } from "./tasks.js";

const TASKS = /^\/todo\/api\/tasks\/?$/;
const TASK = /^\/todo\/api\/tasks\/([^/]+)$/;
const ID = /^t_[0-9a-z]{1,32}$/;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/todo" || pathname.startsWith("/todo/")) {
      return protect(request, env, "ACCESS_AUD_TODO", user => todo(request, env, user, pathname));
    }
    return env.ASSETS.fetch(request);
  },
};

// Everything under /todo/ for a signed-in user: the API, or the page itself.
async function todo(request, env, user, pathname) {
  if (!pathname.startsWith("/todo/api/")) return env.ASSETS.fetch(request);
  const method = request.method;
  return handle(async () => {
    if (method !== "GET" && !sameOrigin(request)) return json({ error: "cross-origin request refused" }, 403);

    if (TASKS.test(pathname)) {
      // GET  → the user's tasks, projects, tags, stats
      // POST → create a task from explicit fields ({title, due, ...})
      if (method === "GET") return json(await list(env, user.email));
      if (method === "POST") return json(await create(env, user.email, await readJson(request)), 201);
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
      const t = await update(env, user.email, m[1], changes);
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

// Mutations must come from this site's own pages, not from another origin.
function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}
