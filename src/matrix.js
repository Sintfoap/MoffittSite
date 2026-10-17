// Matrix, for chat connections (src/bridges.js): the client-server API with
// an access token, the way Element talks to a homeserver.
//
// Someone connects with their homeserver and either an access token (Element:
// Settings → Help & About → Access token) or their username and password,
// which are used once to sign in a new session ("device") and then forgotten.
// Each sync asks for what changed since the last one (/sync with a since
// token and no waiting), so it fits in one Worker request.
//
// End-to-end encrypted rooms can't be read or written here yet: that needs
// the device's Olm/Megolm keys, which this doesn't have. Their messages show
// as a note saying so, and sending to them is refused.

import { randomBytes, hex } from "./crypto.js";

export class ProviderError extends Error {
  // auth: the credentials no longer work, so the connection needs redoing.
  constructor(message, { auth = false } = {}) { super(message); this.auth = auth; }
}

const TIMEOUT = 8000;
// A long message from elsewhere is cut to this many characters.
const MAX_BODY = 4000;
const ENCRYPTED_NOTE = "🔒 Encrypted message. This site can't read end-to-end encrypted rooms yet.";

// Only what chat shows: messages, edits and deletions, and the state that
// names a room. No presence, receipts, typing or account data.
const STATE_TYPES = ["m.room.name", "m.room.topic", "m.room.canonical_alias", "m.room.encryption", "m.room.member"];
const filter = limit => JSON.stringify({
  presence: { not_types: ["*"] },
  account_data: { not_types: ["*"] },
  room: {
    ephemeral: { not_types: ["*"] },
    account_data: { not_types: ["*"] },
    state: { lazy_load_members: true, types: STATE_TYPES },
    timeline: { limit, lazy_load_members: true,
      types: ["m.room.message", "m.room.encrypted", "m.room.redaction", "m.room.name", "m.room.topic", "m.room.canonical_alias", "m.room.encryption"] },
  },
});

// "matrix.org", "https://matrix.example.com/" → an https origin. Only public
// host names: no addresses, no ports below 1024 other than 443, nothing local.
export function serverUrl(raw) {
  let s = String(raw ?? "").trim();
  if (!s) throw new ProviderError("homeserver is required");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch { throw new ProviderError("that isn't a homeserver address"); }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:") throw new ProviderError("the homeserver must use https");
  if (u.username || u.password || u.search || u.hash) throw new ProviderError("that isn't a homeserver address");
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(host)) throw new ProviderError("the homeserver needs a public host name");
  if (/(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(host)) throw new ProviderError("the homeserver needs a public host name");
  if (u.port && Number(u.port) < 1024) throw new ProviderError("that port isn't allowed");
  return `https://${host}${u.port ? ":" + u.port : ""}${u.pathname.replace(/\/+$/, "")}`;
}

async function call(base, method, path, { token, body, query } = {}) {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v != null) url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url, {
      method, redirect: "error", signal: AbortSignal.timeout(TIMEOUT),
      headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ProviderError(e?.name === "TimeoutError" ? "the homeserver didn't answer in time" : "couldn't reach the homeserver");
  }
  const data = await res.json().catch(() => null);
  if (res.ok && data) return data;
  const code = data?.errcode, msg = data?.error;
  if (res.status === 401 || code === "M_UNKNOWN_TOKEN" || code === "M_MISSING_TOKEN") {
    throw new ProviderError("Matrix says the sign-in is no longer valid; connect it again", { auth: true });
  }
  if (code === "M_FORBIDDEN" && path.endsWith("/login")) throw new ProviderError("Matrix says that username or password isn't right");
  if (res.status === 429 || code === "M_LIMIT_EXCEEDED") throw new ProviderError("Matrix is limiting requests; try again in a moment");
  throw new ProviderError(`Matrix said: ${String(msg || code || `error ${res.status}`).slice(0, 200)}`);
}

// Follows a server name's .well-known to its client API, as Element does.
async function discover(raw) {
  const base = serverUrl(raw);
  const u = new URL(base);
  if (u.pathname === "" || u.pathname === "/") {
    try {
      const res = await fetch(`${base}/.well-known/matrix/client`, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT) });
      const found = res.ok && (await res.json().catch(() => null))?.["m.homeserver"]?.base_url;
      if (found) return serverUrl(found);
    } catch { /* no .well-known: the address is the homeserver itself */ }
  }
  return base;
}

const txn = () => "sf" + hex(randomBytes(12));
const room = id => encodeURIComponent(id);

export const matrix = {
  id: "matrix",
  name: "Matrix",
  help: "Your homeserver (e.g. matrix.org), then either an access token from Element (Settings → Help & About → Access token) "
    + "or your Matrix username and password. A password is used once, to sign in a new session called sintfoap.xyz, and isn't kept. "
    + "End-to-end encrypted rooms show up, but their messages can't be read or sent here yet.",
  fields: [
    { name: "homeserver", label: "Homeserver", placeholder: "matrix.org", required: true },
    { name: "token", label: "Access token", secret: true, placeholder: "syt_… (or use a username and password)" },
    { name: "username", label: "Username", placeholder: "@you:matrix.org" },
    { name: "password", label: "Password", secret: true },
  ],

  // The fields from the form → {label, creds} to keep, sealed.
  async connect(fields) {
    const base = await discover(fields.homeserver);
    let token = String(fields.token ?? "").trim(), ownDevice = false;
    if (!token) {
      const user = String(fields.username ?? "").trim(), password = String(fields.password ?? "");
      if (!user || !password) throw new ProviderError("give an access token, or a username and password");
      const out = await call(base, "POST", "/_matrix/client/v3/login", { body: {
        type: "m.login.password", identifier: { type: "m.id.user", user }, password, initial_device_display_name: "sintfoap.xyz",
      } });
      token = out.access_token; ownDevice = true;
    }
    const me = await call(base, "GET", "/_matrix/client/v3/account/whoami", { token });
    return { label: me.user_id, creds: { base, token, user_id: me.user_id, device_id: me.device_id ?? null, own_device: ownDevice } };
  },

  // Signs out the session this site made; a token someone pasted in is theirs
  // (it's likely Element's own), so it's left alone.
  async disconnect(creds) {
    if (creds.own_device) await call(creds.base, "POST", "/_matrix/client/v3/logout", { token: creds.token, body: {} });
  },

  // What changed since `cursor` (or recent history, the first time):
  // {cursor, rooms: [{id, name?, fallback_name?, topic?, encrypted?, left?, events: [...]}]}.
  // name/topic are left out when this sync didn't say (fallback_name is
  // what to call a room with no name); events are
  //   {type: "message", id, sender, sender_name, mine, body, at, encrypted}
  //   {type: "edit", target, body, at}
  //   {type: "delete", target}
  async sync(creds, cursor) {
    const data = await call(creds.base, "GET", "/_matrix/client/v3/sync", { token: creds.token, query: {
      since: cursor || undefined, timeout: "0", set_presence: "offline", filter: filter(cursor ? 50 : 20),
    } });
    const rooms = [];
    for (const [id, r] of Object.entries(data.rooms?.join ?? {})) rooms.push(joinedRoom(id, r, creds.user_id));
    for (const id of Object.keys(data.rooms?.leave ?? {})) rooms.push({ id, left: true, events: [] });
    return { cursor: data.next_batch, rooms };
  },

  async send(creds, roomId, text) {
    const out = await call(creds.base, "PUT", `/_matrix/client/v3/rooms/${room(roomId)}/send/m.room.message/${txn()}`,
      { token: creds.token, body: { msgtype: "m.text", body: text } });
    return out.event_id;
  },

  async edit(creds, roomId, eventId, text) {
    await call(creds.base, "PUT", `/_matrix/client/v3/rooms/${room(roomId)}/send/m.room.message/${txn()}`, { token: creds.token, body: {
      msgtype: "m.text", body: "* " + text,
      "m.new_content": { msgtype: "m.text", body: text },
      "m.relates_to": { rel_type: "m.replace", event_id: eventId },
    } });
  },

  async remove(creds, roomId, eventId) {
    await call(creds.base, "PUT", `/_matrix/client/v3/rooms/${room(roomId)}/redact/${encodeURIComponent(eventId)}/${txn()}`,
      { token: creds.token, body: {} });
  },
};

// "@sam:example.org" → "sam"
const localpart = mxid => String(mxid).replace(/^@/, "").split(":")[0];

// A reply's body starts with the quoted message ("> <@x> …" lines, then a
// blank line); chat shows the reply alone.
const dropReplyQuote = body => body.replace(/^(> .*\n)+\n/, "");

function textOf(content, senderName) {
  const body = typeof content?.body === "string" ? content.body : "";
  const kind = content?.msgtype;
  let out = kind === "m.emote" ? `* ${senderName} ${body}`
    : ["m.image", "m.file", "m.video", "m.audio"].includes(kind) ? `[${kind.slice(2)}] ${body}`
    : dropReplyQuote(body);
  out = out.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim();
  return out.length > MAX_BODY ? out.slice(0, MAX_BODY) + "…" : out;
}

function joinedRoom(id, r, me) {
  const state = [...(r.state?.events ?? []), ...(r.timeline?.events ?? []).filter(e => e.state_key !== undefined)];
  const names = new Map();
  const out = { id, events: [] };
  for (const e of state) {
    const c = e.content ?? {};
    if (e.type === "m.room.member" && c.displayname) names.set(e.state_key, String(c.displayname).slice(0, 80));
    else if (e.type === "m.room.name") out.name = String(c.name ?? "").trim();
    else if (e.type === "m.room.topic") out.topic = String(c.topic ?? "").trim();
    else if (e.type === "m.room.canonical_alias" && c.alias) out.alias = String(c.alias);
    else if (e.type === "m.room.encryption") out.encrypted = true;
  }
  // A room with no name is named for its address, or the people in it
  // (Matrix's "heroes"). That's only a stand-in: it doesn't replace a name.
  const heroes = r.summary?.["m.heroes"];
  const standIn = out.alias || (heroes?.length ? heroes.map(h => names.get(h) || localpart(h)).join(", ") : undefined);
  if (standIn) out.fallback_name = standIn.slice(0, 60);
  delete out.alias;
  if (out.name !== undefined) out.name = out.name.slice(0, 60);
  if (out.topic !== undefined) out.topic = out.topic.slice(0, 200);
  const who = mxid => names.get(mxid) || localpart(mxid);

  for (const e of r.timeline?.events ?? []) {
    if (e.state_key !== undefined || e.unsigned?.redacted_because) continue;
    const at = Math.floor((e.origin_server_ts ?? Date.now()) / 1000);
    const c = e.content ?? {};
    if (e.type === "m.room.redaction") {
      const target = e.redacts ?? c.redacts;
      if (target) out.events.push({ type: "delete", target });
    } else if (e.type === "m.room.encrypted") {
      out.events.push({ type: "message", id: e.event_id, sender: e.sender, sender_name: who(e.sender), mine: e.sender === me,
        body: ENCRYPTED_NOTE, at, encrypted: true });
    } else if (e.type === "m.room.message") {
      const rel = c["m.relates_to"];
      if (rel?.rel_type === "m.replace" && rel.event_id) {
        const body = textOf(c["m.new_content"] ?? c, who(e.sender));
        if (body) out.events.push({ type: "edit", target: rel.event_id, sender: e.sender, body, at });
      } else {
        const body = textOf(c, who(e.sender));
        if (body) out.events.push({ type: "message", id: e.event_id, sender: e.sender, sender_name: who(e.sender), mine: e.sender === me, body, at, encrypted: false });
      }
    }
  }
  return out;
}
