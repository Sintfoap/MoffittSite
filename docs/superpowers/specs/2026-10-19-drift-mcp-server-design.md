# Drift MCP server — design

## Goal

An LLM agent can do everything a signed-in human can do in Drift, acting as the
human who gave it an API key. Humans create and revoke keys on their account
page. An `llm.txt` tells agents (and people configuring them) how it works.

## Decisions already made

- **Scope:** Drift only (the `todo` area: collections, items, sharing, store-plugin installs). Not chat, recipes, notifications, or authoring/reviewing store plugins (separate `plugins` area; plugin code needs human review).
- **Shape:** remote MCP endpoint on the Worker, not a local stdio proxy.
- **Key permissions:** full Drift access only. No read-only or per-collection scopes.

## Architecture

```
agent ── POST /mcp (Bearer sf_…) ──> src/mcp.js ──> src/drift.js / src/store.js
human ── /account (cookie session) ─> src/account.js ──> src/apikeys.js (api_keys table)
```

- `src/apikeys.js` — create / list / revoke / verify keys. Depends on `db.js`, `crypto.js`, `auth.js` (`getUser`).
- `src/mcp.js` — JSON-RPC handler, tool table. Depends on `apikeys.js` and `drift.js`.
- `/mcp` is added to `run_worker_first` in `wrangler.jsonc` and routed in `src/worker.js` *before* `protect()` paths; it never uses `protect()` or cookies.
- `/todo/api` stays cookie-only. Keys are never accepted there.

## API keys

Table (in `src/db.js`):

```
api_keys(
  id_hash    TEXT PRIMARY KEY,   -- SHA-256 of the full key
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,      -- ≤ 60 chars, chosen by the human
  prefix     TEXT NOT NULL,      -- first 8 chars of the key, for recognising it
  created_at INTEGER NOT NULL,
  last_used  INTEGER             -- updated at most once per TOUCH_EVERY
)
INDEX api_keys_user (user_id)
```

- Key format: `sf_` + `randomToken(32)`. Only the hash is stored; the full key is shown exactly once, on the page returned by the create POST (`Cache-Control: no-store`).
- Limit 10 keys per account.
- Account page (`accountPage` in `src/pages.js`): section "API keys for AI agents", shown only to accounts with the `todo` area. Lists name, prefix, created, last used, with a Revoke button each. Create form: name + current password. Links to `/llm.txt`. Text states that changing the password or signing out everywhere does **not** revoke keys; revoke them here.
- Routes in `account()`: `POST /account/apikeys` (create; password required; failures go through the existing password-check path and throttling) and `POST /account/apikeys/revoke` (`{id_hash}` scoped to `user_id`). Same-origin check already applies to all `/account` POSTs.
- Admin delete of an account also deletes its keys (add to the existing batch in `admin()`).

## Authentication on `/mcp`

1. Read `Authorization: Bearer <key>`; reject missing / malformed / > 100 chars with 401 + `WWW-Authenticate: Bearer`.
2. Hash, look up in `api_keys`, load the user (`getUser`).
3. Reject (401) if no key row. Reject (403) if the user is disabled, has `must_change_pw`, is an admin without 2FA, or lacks the `todo` area. These mirror `protect()`'s checks, so a key can never do more than a fresh sign-in could.
4. Touch `last_used` (throttled).

Failed-key throttling is not added: keys carry 256 bits of entropy, so guessing is infeasible. Cookies are ignored, so CSRF does not apply. Requests with an `Origin` header that is not absent are refused (DNS-rebinding guidance in the MCP spec; real agents don't send one).

## Protocol

Streamable HTTP, stateless, JSON responses only (never SSE).

- `POST /mcp` with one JSON-RPC message (batches accepted as arrays). Body capped at 64 KB (`readJson`'s limit).
- Requests handled: `initialize` (echoes a supported `protocolVersion`, declares `tools` capability, `serverInfo`, and short `instructions` pointing at `/llm.txt`), `ping`, `tools/list`, `tools/call`. Notifications (no `id`) get `202` with no body. Unknown methods → JSON-RPC `-32601`.
- `GET` / `DELETE` on `/mcp` → `405` with `Allow: POST`.
- Domain errors (`BadRequest`, not-found, access) become `{isError: true, content:[{type:"text", text}]}` tool results so the model can read and fix them. Unexpected errors are logged and returned as a generic JSON-RPC internal error.
- Tool results: one text content block containing JSON.

## Tools

All act as the key's owner and call the same `drift.js` functions the web API does, so validation, ownership checks, sharing roles and limits are identical.

| Tool | Does | Backed by |
|---|---|---|
| `drift_get_state` | collections (with shares, roles), items, plugins, store plugins | `state()` |
| `drift_get_agenda` `{day}` | late + due events for `YYYY-MM-DD` | `agenda()` |
| `drift_create_item` | `{title, collection, notes?, tags?, meta?}` | `createItem()` |
| `drift_update_item` | `{id, ...fields}`; `meta: {plugin: value\|null}`; move via `collection`; `deleted: false` restores | `updateItem()` |
| `drift_delete_item` `{id}` | soft delete | `updateItem({deleted:true})` |
| `drift_create_collection` | `{name, plugins?, view?}` | `createCollection()` |
| `drift_update_collection` | `{id, name?, plugins?, view?, order?, deleted?}` | `updateCollection()` |
| `drift_delete_collection` `{id}` | soft delete (refuses the last one) | `updateCollection()` |
| `drift_share_collection` | `{id, username, role: edit\|view}` | `shareCollection()` |
| `drift_unshare_collection` | `{id, username}` | `unshareCollection()` |
| `drift_install_plugin` / `drift_uninstall_plugin` `{id}` | store plugins | `install()` / `uninstall()` |

Each tool has a JSON Schema `inputSchema` and a description that documents the data model, including the built-in plugin `meta` slices:

- `checklist: {done, priority 0–3}`
- `event: {start, end}` — `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, `end` may be null
- `list: {order, parent}` — `parent` is another item id or null
- `graph`: no per-item meta

Ids: items `i_…`, collections `c_…`. Not-found maps to an `isError` result ("not found"), matching the web API's 404.

## `llm.txt`

Static file `public/llm.txt` (served at `/llm.txt`, not in `run_worker_first`). Sections: what Drift is; data model (collections, items, `meta`, ids, soft delete, sharing roles, limits from `LIMITS`); how a human gets a key; MCP URL (`https://<site>/mcp`), auth header, example client config (`claude mcp add --transport http drift <url> --header "Authorization: Bearer sf_…"`); every tool with arguments; worked examples (add a task with priority, schedule an event, make a nested list, share a collection); error behaviour; what is out of scope; safety notes (treat the key like a password; revoke on the account page). Mentioned in the README tree and linked from the account section.

## Testing

`tests/mcp.test.mjs` on the existing node harness (`node --no-warnings --test tests/*.test.mjs`, already run by CI):

- Keys: create needs the right password; key shown once and only the hash stored; list excludes secrets; revoke works and is scoped to owner; 10-key limit; section hidden without the `todo` area; admin delete removes keys.
- Auth: missing / malformed / unknown / revoked key → 401; disabled user, area removed, `must_change_pw` → 403; cookie alone is refused on `/mcp`; key is refused on `/todo/api`.
- Protocol: `initialize`, `ping`, `tools/list` (all tools present with schemas), notification → 202, unknown method, bad JSON, oversize body, GET → 405.
- Tools: each tool's happy path; validation errors surface as `isError`; two users' data are isolated even with known ids; shared-collection `view` role cannot write, `edit` can; install/uninstall plugin; agenda matches the web helper.

Also update `README.md` (file tree, a short "API keys and MCP" section).

## Out of scope / later

Read-only or per-collection key scopes; key expiry; stdio package; MCP resources/prompts; OAuth; failed-key rate limiting; plugin authoring; other apps.
