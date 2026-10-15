// Shared test harness: runs requests through the Worker the way Cloudflare
// would, with Node's built-in SQLite standing in for D1.
import { DatabaseSync } from "node:sqlite";
import worker from "../src/worker.js";
import { totpCode, TOTP_PERIOD } from "../src/crypto.js";

export const ORIGIN = "https://sintfoap.test";

export function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return {
    prepare: sql => stmt(sql),
    // D1 runs a batch as one transaction.
    batch: async list => {
      db.exec("BEGIN");
      try { const out = list.map(s => db.prepare(s.sql).run(...s.args)); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    raw: db,
  };
}

// Stands in for Cloudflare's static-asset server (public/).
export const ASSETS = { fetch: async () => new Response("<!doctype html>static page", { headers: { "Content-Type": "text/html" } }) };

export function makeEnv(extra = {}) {
  return { TODO_DB: fakeD1(), ASSETS, SIGNUPS: "open", MAX_USERS: "100", PASSWORD_ITERATIONS: "10000", ...extra };
}

let ipCounter = 0;

// A browser: keeps its own session cookie and IP address.
export class Browser {
  constructor(env, { ip } = {}) { this.env = env; this.cookie = null; this.ip = ip || `203.0.113.${++ipCounter}`; }

  async req(method, path, { form, json, origin = method === "GET" ? null : ORIGIN, headers = {}, cookie } = {}) {
    const h = new Headers(headers);
    h.set("CF-Connecting-IP", this.ip);
    const c = cookie === undefined ? this.cookie : cookie;
    if (c) h.set("Cookie", `__Host-sid=${c}`);
    if (origin) h.set("Origin", origin);
    let body;
    if (form) { body = new URLSearchParams(form).toString(); h.set("Content-Type", "application/x-www-form-urlencoded"); }
    if (json !== undefined) { body = JSON.stringify(json); h.set("Content-Type", "application/json"); }
    const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: h, body }), this.env);
    const set = res.headers.get("Set-Cookie");
    if (set) {
      const m = set.match(/__Host-sid=([^;]*)/);
      this.cookie = m && m[1] ? m[1] : null;
    }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, text, json: data, setCookie: set, location: res.headers.get("Location") };
  }
  get(path, o) { return this.req("GET", path, o); }
  post(path, form, o = {}) { return this.req("POST", path, { form, ...o }); }

  signup(username, password = "correct horse battery", display_name = "") {
    return this.post("/signup", { username, display_name, password, password2: password });
  }
  login(username, password = "correct horse battery") { return this.post("/login", { username, password }); }
}

export const sql = (env, q, ...args) => env.TODO_DB.raw.prepare(q).all(...args);
export const sqlOne = (env, q, ...args) => env.TODO_DB.raw.prepare(q).get(...args);
export const run = (env, q, ...args) => env.TODO_DB.raw.prepare(q).run(...args);

export const stepNow = () => Math.floor(Date.now() / 1000 / TOTP_PERIOD);
export const codeAt = (secret, step) => totpCode(secret, step);

// Turns on two-factor for a signed-in browser; returns { secret, codes, step, page }.
export async function enable2fa(b, env, password = "correct horse battery") {
  await b.post("/account/2fa/start", { password });
  const secret = sqlOne(env, "SELECT totp_pending FROM users WHERE totp_pending IS NOT NULL").totp_pending;
  const step = stepNow();
  const r = await b.post("/account/2fa/confirm", { code: await codeAt(secret, step) });
  const codes = [...r.text.matchAll(/<span>([a-z2-7]{5}-[a-z2-7]{5})<\/span>/g)].map(m => m[1]);
  return { secret, codes, step, page: r };
}
