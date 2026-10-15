// Verifies the Cloudflare Access token on a request.
//
// Cloudflare Access sits in front of protected paths and refuses anyone who
// isn't on the policy. This is the second lock: every request that reaches a
// protected Function must carry a token signed by your Access team for the
// expected application, or it is refused. If Access is ever misconfigured or
// switched off, the protected paths fail closed instead of opening up.
//
// Configuration (Pages → Settings → Variables and Secrets):
//   ACCESS_TEAM_DOMAIN  e.g. "yourteam.cloudflareaccess.com"
//   <audVar>            the Access application's "Application Audience (AUD) Tag".
//                       Comma-separate several (e.g. production + preview apps).

const CERTS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 60;
let certs = { team: null, keys: new Map(), fetched: 0 };

const b64urlBytes = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function loadKeys(team, force = false) {
  if (!force && certs.team === team && Date.now() - certs.fetched < CERTS_TTL_MS) return certs.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`could not fetch Access certs (${r.status})`);
  const { keys = [] } = await r.json();
  const map = new Map();
  for (const jwk of keys) {
    if (jwk.kty !== "RSA" || !jwk.kid) continue;
    map.set(jwk.kid, await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  certs = { team, keys: map, fetched: Date.now() };
  return map;
}

function tokenFrom(request) {
  const h = request.headers.get("Cf-Access-Jwt-Assertion");
  if (h) return h;
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

// Returns { email, sub } for a valid token, or throws.
export async function verifyAccess(request, env, audVar) {
  const team = (env.ACCESS_TEAM_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const auds = String(env[audVar] || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!team || !auds.length) throw new AccessError(500, `Access is not configured (set ACCESS_TEAM_DOMAIN and ${audVar})`);

  const token = tokenFrom(request);
  if (!token) throw new AccessError(401, "not signed in");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessError(401, "malformed token");

  let header, claims;
  try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); }
  catch { throw new AccessError(401, "malformed token"); }
  if (header.alg !== "RS256") throw new AccessError(401, "unexpected token algorithm");

  let keys = await loadKeys(team);
  if (!keys.has(header.kid)) keys = await loadKeys(team, true);   // keys rotate
  const key = keys.get(header.kid);
  if (!key) throw new AccessError(401, "unknown signing key");

  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) throw new AccessError(401, "bad signature");

  const now = Math.floor(Date.now() / 1000);
  const tokenAuds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== `https://${team}`) throw new AccessError(401, "wrong issuer");
  if (!tokenAuds.some(a => auds.includes(a))) throw new AccessError(403, "token is for a different application");
  if (typeof claims.exp !== "number" || claims.exp < now - CLOCK_SKEW_S) throw new AccessError(401, "session expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_S) throw new AccessError(401, "token not yet valid");
  if (!claims.email) throw new AccessError(403, "token has no email (service tokens are not accepted here)");

  return { email: String(claims.email).toLowerCase(), sub: claims.sub };
}

export class AccessError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Pages middleware factory: protects every request under the directory it is
// mounted in, and exposes the signed-in user as context.data.user.
export function requireAccess(audVar) {
  return async context => {
    try {
      context.data.user = await verifyAccess(context.request, context.env, audVar);
    } catch (e) {
      const status = e instanceof AccessError ? e.status : 500;
      if (status === 500) console.error("access check failed:", e.message);
      const api = new URL(context.request.url).pathname.includes("/api/");
      const body = api ? JSON.stringify({ error: e.message }) : `${status === 500 ? "Server misconfigured" : "Not authorised"}: ${e.message}\n`;
      return new Response(body, {
        status,
        headers: { "Content-Type": api ? "application/json" : "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    const res = await context.next();
    // Never let a shared cache keep a copy of a protected page.
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "private, no-store");
    return out;
  };
}
