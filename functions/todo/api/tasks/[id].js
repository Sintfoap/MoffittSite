// PATCH  /todo/api/tasks/:id  → change any of title notes done priority due project tags order deleted
// DELETE /todo/api/tasks/:id  → soft delete (PATCH {deleted:false} undoes it)
import { update, readJson } from "../../../_lib/tasks.js";
import { json, handle, sameOrigin } from "../_util.js";

const ID = /^t_[0-9a-z]{1,32}$/;

function edit(context, changes) {
  const { request, env, data, params } = context;
  return handle(async () => {
    if (!sameOrigin(request)) return json({ error: "cross-origin request refused" }, 403);
    if (!ID.test(params.id)) return json({ error: "not found" }, 404);
    const t = await update(env, data.user.email, params.id, await changes(request));
    return t ? json(t) : json({ error: "not found" }, 404);
  });
}

export const onRequestPatch = context => edit(context, readJson);
export const onRequestDelete = context => edit(context, async () => ({ deleted: true }));
