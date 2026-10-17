// Sending Web Push messages, with nothing but WebCrypto.
//
// A browser that opts in gives us a subscription: an endpoint at its push
// service (Google, Mozilla, Apple, Microsoft) and two keys. To send, we
// encrypt the message for that browser (RFC 8291, "aes128gcm") and POST it to
// the endpoint with a short token signed by our own key pair (VAPID, RFC 8292),
// which tells the push service the message really comes from this site.
//
// The key pair lives in two secrets, VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY
// (base64url, as `npx web-push generate-vapid-keys` prints them; see README).
// Until both are set, push is off and the page says so.

import { b64url, fromB64url } from "./crypto.js";

const enc = new TextEncoder();
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

export const configured = env => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

// Push services we send to. A subscription naming any other host is refused,
// so the Worker can't be used to POST to arbitrary addresses.
const PUSH_HOSTS = /(^|\.)(googleapis\.com|mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;

export function pushEndpoint(raw) {
  let u;
  try { u = new URL(String(raw ?? "")); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !PUSH_HOSTS.test(u.hostname)) return null;
  return u.href.length <= 1000 ? u.href : null;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

// RFC 8291: encrypts `payload` for one subscription, as a single aes128gcm
// record. `p256dh` and `auth` are the subscription's keys (base64url). Tests
// pass their own `salt` and `keys` (an ECDH key pair) to get a known answer.
export async function encrypt(payload, p256dh, auth, { salt = crypto.getRandomValues(new Uint8Array(16)), keys } = {}) {
  const uaPublic = fromB64url(p256dh), secret = fromB64url(auth);
  if (uaPublic.length !== 65 || secret.length !== 16) throw new Error("bad subscription keys");
  keys ||= await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, keys.privateKey, 256));

  const ikm = await hkdf(secret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record, so it ends with the last-record delimiter (2) and no padding.
  const data = typeof payload === "string" ? enc.encode(payload) : payload;
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(data, [2])));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, [asPublic.length], asPublic, sealed);
}

// The VAPID key, imported once per Worker instance.
let signing = null;
function signingKey(env) {
  if (signing?.pub !== env.VAPID_PUBLIC_KEY || signing?.priv !== env.VAPID_PRIVATE_KEY) {
    const pub = fromB64url(env.VAPID_PUBLIC_KEY);
    const jwk = { kty: "EC", crv: "P-256", d: env.VAPID_PRIVATE_KEY, x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), ext: true };
    signing = { pub: env.VAPID_PUBLIC_KEY, priv: env.VAPID_PRIVATE_KEY,
      key: crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]) };
    signing.key.catch(() => { signing = null; });
  }
  return signing.key;
}

// RFC 8292: "vapid t=<JWT for this push service>, k=<our public key>".
export async function vapidAuth(env, endpoint, at = Date.now()) {
  const part = obj => b64url(enc.encode(JSON.stringify(obj)));
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(at / 1000) + 12 * 3600,
    sub: env.PUSH_CONTACT || "https://sintfoap.xyz",
  };
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(env), enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

// Sends one message to one subscription. Returns the push service's status:
// 201 is delivered (or queued), 404 and 410 mean the subscription is gone.
export async function send(env, sub, message, { ttl = 86400, urgency = "normal", topic } = {}) {
  const body = await encrypt(JSON.stringify(message), sub.p256dh, sub.auth);
  const headers = {
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: await vapidAuth(env, sub.endpoint),
  };
  // A newer message with the same topic replaces one still waiting for the device.
  if (topic) headers.Topic = topic;
  const res = await fetch(sub.endpoint, { method: "POST", headers, body });
  if (res.status >= 400 && res.status !== 404 && res.status !== 410) {
    console.error("push refused:", res.status, new URL(sub.endpoint).host, (await res.text().catch(() => "")).slice(0, 200));
  }
  return res.status;
}
