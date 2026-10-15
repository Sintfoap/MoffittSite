// GET  /todo/api/tasks  → the signed-in user's tasks, projects, tags, stats
// POST /todo/api/tasks  → create a task from explicit fields ({title, due, ...})
import { list, create, readJson } from "../../../_lib/tasks.js";
import { json, handle, sameOrigin } from "../_util.js";

export const onRequestGet = ({ env, data }) =>
  handle(async () => json(await list(env, data.user.email)));

export const onRequestPost = ({ request, env, data }) =>
  handle(async () => {
    if (!sameOrigin(request)) return json({ error: "cross-origin request refused" }, 403);
    return json(await create(env, data.user.email, await readJson(request)), 201);
  });
