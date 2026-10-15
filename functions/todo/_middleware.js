// Everything under /todo/ (the page and its API) requires a valid Cloudflare
// Access session for the todo application.
import { requireAccess } from "../_lib/access.js";

export const onRequest = requireAccess("ACCESS_AUD_TODO");
