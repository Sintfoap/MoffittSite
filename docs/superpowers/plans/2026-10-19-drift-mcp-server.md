# Drift MCP Server Implementation Plan

> **For agentic workers:** use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** LLM agents use Drift through a remote MCP endpoint, authenticated by API keys humans create on `/account`; plus `llm.txt`.

**Architecture:** `src/apikeys.js` (key storage/verification) + `src/mcp.js` (stateless JSON-RPC over `POST /mcp`, calls `drift.js`/`store.js` directly). Account page gets a key-management section. `/todo/api` stays cookie-only.

**Tech Stack:** Cloudflare Worker, D1 (node:sqlite fake in tests), plain JS, `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-19-drift-mcp-server-design.md`

## Global Constraints

- Keys: `sf_` + `randomToken(32)`; only SHA-256 stored; shown once; max 10 per account; name ≤ 60 chars.
- `/mcp` ignores cookies; Bearer only; refuses requests with an `Origin` header; body ≤ 64 KB; GET/DELETE → 405.
- Auth mirrors `protect()`: disabled, `must_change_pw`, admin without 2FA, or no `todo` area → 403; bad/revoked key → 401 + `WWW-Authenticate: Bearer`.
- No new dependencies. Tests: `node --no-warnings --test tests/*.test.mjs`.

## Review Focus

- Revoked key keeps working → test revoke then call (Task 1/3).
- User A's key touching user B's data by known id → isolation test (Task 3).
- `view`-role shared collection written via key → `isError` (Task 3).
- Cookie session sent to `/mcp`, or key sent to `/todo/api` → refused (Task 2).
- Oversize / malformed JSON → clean JSON-RPC error, no 500 (Task 2).

## Task 1: API key storage + account page

**Files:** Create `src/apikeys.js`; modify `src/db.js` (table), `src/account.js` (routes, admin delete), `src/pages.js` (section); test `tests/apikeys.test.mjs`.

**Interfaces — Produces (`src/apikeys.js`):**
- `createKey(env, userId, name) → { key, id_hash, prefix }` (throws `AuthError` at limit / bad name)
- `listKeys(env, userId) → [{ id_hash, name, prefix, created_at, last_used }]`
- `revokeKey(env, userId, idHash) → boolean`
- `findKey(env, token) → { user_id, id_hash } | null` (no touch)
- `touchKey(env, idHash)` (writes `last_used` at most every 5 min)

- [ ] Write tests: create needs correct password; key shown on result page once and absent from later `/account`; only hash in DB; list shows name+prefix; revoke scoped to owner; 11th key refused; section hidden without `todo` area; admin delete removes keys.
- [ ] Run, see fail. Implement. Run, see pass. Commit.

## Task 2: `/mcp` transport + auth

**Files:** Create `src/mcp.js`; modify `src/worker.js`, `wrangler.jsonc` (`/mcp`); test `tests/mcp.test.mjs`.

**Interfaces — Produces:** `export async function mcp(request, env)` → Response. Internal `TOOLS` array of `{ name, description, inputSchema, run(env, user, args) }` filled in Task 3.

- [ ] Tests: missing/malformed/unknown/revoked key → 401 with `WWW-Authenticate`; disabled user, area removed, `must_change_pw` → 403; cookie alone → 401; key on `/todo/api/state` → 401; `Origin` header → 403; GET → 405 `Allow: POST`; `initialize`, `ping`, `tools/list`, notification → 202, unknown method → -32601, bad JSON → -32700, oversize → error, batch.
- [ ] Implement, pass, commit.

## Task 3: Tools

**Files:** modify `src/mcp.js`; extend `tests/mcp.test.mjs`.

Tools as in spec table. `BadRequest` and null results (not found) → `isError` result.

- [ ] Tests: each tool happy path; validation error is `isError`; two-user isolation; `view` role cannot write, `edit` can; install/uninstall; agenda; restore via `deleted:false`; last collection delete refused.
- [ ] Implement, pass, commit.

## Task 4: llm.txt, README

**Files:** create `public/llm.txt`; modify `README.md`; test: `tests/mcp.test.mjs` asserts every tool name appears in `public/llm.txt`.

- [ ] Write, test, commit; run full suite.
