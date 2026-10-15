import { BadRequest } from "../../_lib/tasks.js";

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

// Turns thrown errors into JSON responses; unexpected ones are logged, not leaked.
export async function handle(fn) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    console.error("todo api error:", e);
    return json({ error: "server error" }, 500);
  }
}

// Mutations must come from this site's own pages, not from another origin.
export function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}
