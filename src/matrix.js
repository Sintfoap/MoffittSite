// Matrix, for chat connections (src/bridges.js): the client-server API with
// an access token, the way Element talks to a homeserver.
//
// Someone connects with their homeserver and either an access token (Element:
// Settings → Help & About → Access token) or their username and password,
// which are used once to sign in a new session ("device") and then forgotten.
// Each sync asks for what changed since the last one (/sync with a since
// token and no waiting), so it fits in one Worker request.
//
// End-to-end encrypted rooms: the keys are only ever opened in a browser. A
// connection made with a password has a session ("device") of its own, and
// the browser that turns encryption on for it keeps that device's keys
// (public/chat/e2ee.js, with Matrix's own crypto library), sending the site a
// locked copy so they can follow you to your other browsers (carry.js). Here, encrypted events are kept as they
// came, the to-device messages and key counts each sync brings are handed to
// that browser, and the key requests it makes are passed on (cryptoRequest).

import { randomBytes, hex } from "./crypto.js";
import { fromHtml, messageContent, editContent } from "../public/chat/format.js";

export class ProviderError extends Error {
  // auth: the credentials no longer work, so the connection needs redoing.
  // refused: the site wouldn't make that request at all.
  constructor(message, { auth = false, refused = false } = {}) { super(message); this.auth = auth; this.refused = refused; }
}

const TIMEOUT = 8000;
// Pictures passed to and from Matrix, at most (bytes).
export const MAX_MEDIA = 10 * 1024 * 1024;
// A Matrix media address: mxc://<server>/<id>.
export const MXC = /^mxc:\/\/([A-Za-z0-9.:\[\]-]{1,255})\/([A-Za-z0-9_-]{1,255})$/;
// Pictures chat shows; anything else is passed on as data, never as a page.
export const IMAGE_TYPES = ["image/gif", "image/png", "image/jpeg", "image/webp"];
// A long message from elsewhere is cut to this many characters.
const MAX_BODY = 4000;
export const ENCRYPTED_NOTE = "🔒 Encrypted message";
// The app id the site's pushers are registered under.
export const PUSH_APP = "xyz.sintfoap.chat";

// Only what chat shows: messages, edits, reactions and deletions, the state
// that names a room, and who's typing and has read what. No presence or
// account data.
const STATE_TYPES = ["m.room.name", "m.room.topic", "m.room.canonical_alias", "m.room.encryption", "m.room.member"];
const HISTORY_TYPES = ["m.room.message", "m.room.encrypted", "m.reaction"];
const filter = limit => JSON.stringify({
  presence: { not_types: ["*"] },
  account_data: { not_types: ["*"] },
  room: {
    ephemeral: { types: ["m.typing", "m.receipt"] },
    account_data: { not_types: ["*"] },
    state: { lazy_load_members: true, types: STATE_TYPES },
    timeline: { limit, lazy_load_members: true,
      types: ["m.room.message", "m.room.encrypted", "m.reaction", "m.room.redaction", "m.room.name", "m.room.topic", "m.room.canonical_alias", "m.room.encryption"] },
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

// fetch, following up to a few redirects (reverse proxies often send one) as
// long as each lands on a public https host too. A network failure says
// which address it was and why, since "couldn't reach" alone can't be fixed.
async function send(url, init) {
  for (let hops = 0; ; hops++) {
    let res;
    try { res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) }); }
    catch (e) {
      const host = new URL(url).host;
      if (e?.name === "TimeoutError") throw new ProviderError(`${host} didn't answer in time`);
      throw new ProviderError(`couldn't reach ${host}${e?.message ? ` (${String(e.message).slice(0, 120)})` : ""}; check the address works from the internet, over https`);
    }
    const to = res.status >= 300 && res.status < 400 && res.headers.get("Location");
    if (!to) return res;
    if (hops >= 3) throw new ProviderError("the homeserver redirects too many times");
    const next = new URL(to, url);
    serverUrl(next.origin);   // throws if it points somewhere that isn't allowed
    // A sign-in token only goes to the host it was meant for.
    if (next.origin !== new URL(url).origin && init.headers?.Authorization) {
      const { Authorization, ...rest } = init.headers;
      init = { ...init, headers: rest };
    }
    url = next;
    // 301/302/303 turn a write into a GET, as browsers do; 307/308 keep it.
    if (![307, 308].includes(res.status)) init = { ...init, method: "GET", body: undefined };
  }
}

async function call(base, method, path, { token, body, query } = {}) {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v != null) url.searchParams.set(k, v);
  const res = await send(url, {
    method,
    headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
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
      const res = await send(new URL(`${base}/.well-known/matrix/client`), { method: "GET" });
      const found = res.ok && (await res.json().catch(() => null))?.["m.homeserver"]?.base_url;
      if (found) return serverUrl(found);
    } catch { /* no .well-known: the address is the homeserver itself */ }
  }
  return base;
}

const txn = () => "sf" + hex(randomBytes(12));

const SEG = "[^/?#]+";
const CRYPTO_PATHS = [
  ["POST", new RegExp(`^keys/(upload|query|claim|signatures/upload)$`)],
  ["PUT", new RegExp(`^sendToDevice/${SEG}/${SEG}$`)],
  ["PUT", new RegExp(`^rooms/${SEG}/send/${SEG}/${SEG}$`)],          // verification messages
  ["GET", new RegExp(`^rooms/${SEG}/joined_members$`)],
  ["GET", new RegExp(`^room_keys/version$`)],
  ["GET", new RegExp(`^room_keys/keys\\?version=${SEG}$`)],
  ["GET", new RegExp(`^room_keys/keys/${SEG}/${SEG}\\?version=${SEG}$`)],   // one session's key, from the backup
  ["PUT", new RegExp(`^room_keys/keys\\?version=${SEG}$`)],
  // The secrets a Security Key unlocks (cross-signing keys, the backup key), still encrypted.
  ["GET", new RegExp(`^user/(${SEG})/account_data/(m\\.secret_storage\\.default_key|m\\.secret_storage\\.key\\.${SEG}|m\\.cross_signing\\.(master|self_signing|user_signing)|m\\.megolm_backup\\.v1)$`)],
];
const room = id => encodeURIComponent(id);

export const matrix = {
  id: "matrix",
  name: "Matrix",
  help: "Your homeserver (e.g. matrix.org), then either an access token from Element (Settings → Help & About → Access token) "
    + "or your Matrix username and password. A password is used once, to sign in a new session called sintfoap.xyz, and isn't kept. "
    + "End-to-end encrypted rooms work on the chat page once you turn encryption on there, which needs the username-and-password way; "
    + "the keys then follow you to any browser you sign in to.",
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
  // {cursor, rooms: [{id, name?, fallback_name?, topic?, encrypted?, left?, back?, invite?, events: [...]}]}.
  // (invite: {by}, for a room you've been invited to and haven't joined yet.)
  // (back: where older history starts there, for history(); "" when there is none.)
  // name/topic are left out when this sync didn't say (fallback_name is
  // what to call a room with no name); events are
  //   {type: "message", id, sender, sender_name, mine, body, at, encrypted, reply?}
  //   {type: "edit", target, body, at}
  //   {type: "delete", target}
  // and, when this sync said, typing: [names] and receipts: [{user, name, event, at}].
  async sync(creds, cursor) {
    const data = await call(creds.base, "GET", "/_matrix/client/v3/sync", { token: creds.token, query: {
      since: cursor || undefined, timeout: "0", set_presence: "offline", filter: filter(cursor ? 50 : 20),
    } });
    const rooms = [];
    for (const [id, r] of Object.entries(data.rooms?.join ?? {})) {
      const out = joinedRoom(id, r, creds.user_id);
      // The first sync's timeline, when it isn't cut short, is the room's whole history.
      if (!cursor && r.timeline?.limited === false) out.back = "";
      rooms.push(out);
    }
    for (const id of Object.keys(data.rooms?.leave ?? {})) rooms.push({ id, left: true, events: [] });
    for (const [id, r] of Object.entries(data.rooms?.invite ?? {})) rooms.push(invitedRoom(id, r, creds.user_id));
    // For the browser holding this device's keys, if any.
    const crypto = {
      to_device: data.to_device?.events ?? [],
      changed: data.device_lists?.changed ?? [], left: data.device_lists?.left ?? [],
      otk_counts: data.device_one_time_keys_count ?? null, fallback: data.device_unused_fallback_key_types ?? null,
    };
    const any = crypto.to_device.length || crypto.changed.length || crypto.left.length || crypto.otk_counts;
    return { cursor: data.next_batch, rooms, ...(any ? { crypto } : {}) };
  },

  // Whether this connection can do encryption: only with a session of its
  // own, since a pasted token's session already has keys, kept in its app.
  canEncrypt: creds => !!creds.own_device,
  device: creds => ({ user_id: creds.user_id, device_id: creds.device_id }),

  // An encrypted message or edit, already encrypted by the browser.
  async sendEncrypted(creds, roomId, content) {
    const out = await call(creds.base, "PUT", `/_matrix/client/v3/rooms/${room(roomId)}/send/m.room.encrypted/${txn()}`,
      { token: creds.token, body: content });
    return out.event_id;
  },

  // One of the requests the browser's crypto library makes, passed on with
  // the token. Only the key and to-device endpoints it needs are allowed.
  async cryptoRequest(creds, method, path, body) {
    const ok = CRYPTO_PATHS.some(([m, re]) => m === method && re.test(path))
      // Only your own account data.
      && (!path.startsWith("user/") || path.split("/")[1] === encodeURIComponent(creds.user_id));
    if (!ok) throw new ProviderError("that request isn't one the encryption needs", { refused: true });
    const [p, q] = path.split("?");
    return call(creds.base, method, "/_matrix/client/v3/" + p, {
      token: creds.token, body: method === "GET" ? undefined : body ?? {},
      query: q ? Object.fromEntries(new URLSearchParams(q)) : undefined,
    });
  },

  // A pusher: the homeserver POSTs to `url` (a Matrix push gateway address,
  // …/_matrix/push/v1/notify) whenever an event arrives that this account's
  // push rules say should notify, the way it tells Element's phone app.
  // Only the event's id is sent; the site syncs to read it.
  async setPusher(creds, key, url) {
    await call(creds.base, "POST", "/_matrix/client/v3/pushers/set", { token: creds.token, body: {
      kind: "http", app_id: PUSH_APP, pushkey: key, app_display_name: "sintfoap.xyz", device_display_name: "sintfoap.xyz notifications",
      lang: "en", data: { url, format: "event_id_only" }, append: true,
    } });
  },

  // One message by its id, read from the homeserver's store rather than a
  // sync, the way Element's phone app reads the event a push names: a busy
  // homeserver (matrix.org) can push before its syncs have the event. As
  // sync has it ({type: "message", ...}), or null for anything else.
  async message(creds, roomId, eventId) {
    const e = await call(creds.base, "GET", `/_matrix/client/v3/rooms/${room(roomId)}/event/${encodeURIComponent(eventId)}`, { token: creds.token });
    if (typeof e?.sender !== "string" || e.event_id !== eventId) return null;
    const member = await call(creds.base, "GET", `/_matrix/client/v3/rooms/${room(roomId)}/state/m.room.member/${encodeURIComponent(e.sender)}`,
      { token: creds.token }).catch(() => null);
    const state = member?.displayname ? [{ type: "m.room.member", state_key: e.sender, content: member }] : [];
    return joinedRoom(roomId, { state: { events: state }, timeline: { events: [e] } }, creds.user_id).events
      .find(x => x.type === "message" && x.id === eventId) ?? null;
  },

  async removePusher(creds, key) {
    await call(creds.base, "POST", "/_matrix/client/v3/pushers/set", { token: creds.token, body: { kind: null, app_id: PUSH_APP, pushkey: key } });
  },

  // A picture: uploaded to the homeserver, then sent as an image message,
  // as Element sends one. {bytes, mimetype, name, width, height}.
  async sendImage(creds, roomId, { bytes, mimetype, name, width, height }) {
    const mxc = await this.upload(creds, bytes, mimetype, name);
    const out = await call(creds.base, "PUT", `/_matrix/client/v3/rooms/${room(roomId)}/send/m.room.message/${txn()}`, { token: creds.token, body: {
      msgtype: "m.image", body: name, url: mxc,
      info: { mimetype, size: bytes.byteLength, ...(width && height ? { w: width, h: height } : {}) },
    } });
    return out.event_id;
  },

  // Bytes to the homeserver's media store → their mxc:// address. (The
  // browser uploads an encrypted room's pictures this way too, encrypted.)
  async upload(creds, bytes, mimetype, name = "") {
    if (bytes.byteLength > MAX_MEDIA) throw new ProviderError("that file is too big to send");
    const url = new URL(`${creds.base}/_matrix/media/v3/upload`);
    if (name) url.searchParams.set("filename", name);
    const res = await send(url, { method: "POST", headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": mimetype }, body: bytes });
    const data = await res.json().catch(() => null);
    if (res.status === 401) throw new ProviderError("Matrix says the sign-in is no longer valid; connect it again", { auth: true });
    if (!res.ok || !MXC.test(data?.content_uri ?? "")) throw new ProviderError(`Matrix wouldn't take the file: ${String(data?.error || data?.errcode || `error ${res.status}`).slice(0, 200)}`);
    return data.content_uri;
  },

  // An mxc:// address → {bytes, mimetype}, through the authenticated media
  // API (Matrix 1.11), or the older one for homeservers without it.
  async download(creds, mxc) {
    const m = String(mxc).match(MXC);
    if (!m) throw new ProviderError("that isn't a Matrix media address", { refused: true });
    const path = `${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`;
    let res = await send(new URL(`${creds.base}/_matrix/client/v1/media/download/${path}`), { method: "GET", headers: { Authorization: `Bearer ${creds.token}` } });
    if (res.status === 404 || res.status === 400 || res.status === 405) {
      const old = await send(new URL(`${creds.base}/_matrix/media/v3/download/${path}`), { method: "GET", headers: {} });
      if (old.ok || res.status === 400 || res.status === 405) res = old;
    }
    if (res.status === 401) throw new ProviderError("Matrix says the sign-in is no longer valid; connect it again", { auth: true });
    if (!res.ok) throw new ProviderError(`Matrix couldn't give that file (${res.status})`);
    if (Number(res.headers.get("Content-Length")) > MAX_MEDIA) throw new ProviderError("that file is too big to show here");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_MEDIA) throw new ProviderError("that file is too big to show here");
    return { bytes, mimetype: String(res.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase() };
  },

  // reply: the id of the message it answers, if it does.
  async send(creds, roomId, text, { reply } = {}) {
    const out = await call(creds.base, "PUT", `/_matrix/client/v3/rooms/${room(roomId)}/send/m.room.message/${txn()}`,
      { token: creds.token, body: messageContent(text, { reply }) });
    return out.event_id;
  },

  async edit(creds, roomId, eventId, text) {
    await call(creds.base, "PUT", `/_matrix/client/v3/rooms/${room(roomId)}/send/m.room.message/${txn()}`, { token: creds.token, body: editContent(eventId, text) });
  },

  // "Typing…" for a few seconds, or not any more.
  async typing(creds, roomId, on) {
    await call(creds.base, "PUT", `/_matrix/client/v3/rooms/${room(roomId)}/typing/${encodeURIComponent(creds.user_id)}`,
      { token: creds.token, body: on ? { typing: true, timeout: 6000 } : { typing: false } });
  },

  // Says you've read the room up to this message.
  async receipt(creds, roomId, eventId) {
    await call(creds.base, "POST", `/_matrix/client/v3/rooms/${room(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`, { token: creds.token, body: {} });
  },

  // A reaction: an annotation of the message with the emoji as its key.
  async react(creds, roomId, eventId, key) {
    const out = await call(creds.base, "PUT", `/_matrix/client/v3/rooms/${room(roomId)}/send/m.reaction/${txn()}`,
      { token: creds.token, body: { "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key } } });
    return out.event_id;
  },

  // Accepting an invite, and leaving a room (or declining an invite).
  async join(creds, roomId) {
    await call(creds.base, "POST", `/_matrix/client/v3/join/${room(roomId)}`, { token: creds.token, body: {} });
  },
  async leave(creds, roomId) {
    await call(creds.base, "POST", `/_matrix/client/v3/rooms/${room(roomId)}/leave`, { token: creds.token, body: {} });
  },

  // A direct message with someone there (@name:server) → {id, name}: the
  // one you already have with them, or a new one, as Element makes them
  // (invite-only, encrypted when this connection can hold keys).
  async startDm(creds, user, { encrypted = false } = {}) {
    user = String(user ?? "").trim();
    if (!/^@[a-z0-9._=\-/+]+:[a-z0-9.-]+(:\d+)?$/i.test(user) || user.length > 255) throw new ProviderError("give their Matrix ID, like @sam:matrix.org");
    if (user === creds.user_id) throw new ProviderError("that's you");
    const me = encodeURIComponent(creds.user_id);
    let direct = {};
    try { direct = await call(creds.base, "GET", `/_matrix/client/v3/user/${me}/account_data/m.direct`, { token: creds.token }); }
    catch (e) { if (e.auth) throw e; }
    const joined = new Set((await call(creds.base, "GET", "/_matrix/client/v3/joined_rooms", { token: creds.token })).joined_rooms ?? []);
    const have = (direct[user] ?? []).find(id => joined.has(id));
    let profile;
    try { profile = await call(creds.base, "GET", `/_matrix/client/v3/profile/${encodeURIComponent(user)}`, { token: creds.token }); }
    catch (e) { if (e.auth) throw e; if (!have) throw new ProviderError(`Matrix doesn't know ${user}`); }
    const name = String(profile?.displayname || localpart(user)).slice(0, 60);
    if (have) return { id: have, name };
    const out = await call(creds.base, "POST", "/_matrix/client/v3/createRoom", { token: creds.token, body: {
      preset: "trusted_private_chat", is_direct: true, invite: [user],
      initial_state: encrypted ? [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }] : [],
    } });
    // So Element lists it under People too.
    await call(creds.base, "PUT", `/_matrix/client/v3/user/${me}/account_data/m.direct`,
      { token: creds.token, body: { ...direct, [user]: [...(direct[user] ?? []), out.room_id] } }).catch(() => {});
    return { id: out.room_id, name };
  },

  // A page of a room's older history, before `from` (where a sync's timeline
  // started, or the last page ended): {events, from} as sync has them, with
  // from null at the room's start. An edit made since comes with its message.
  async history(creds, roomId, from) {
    const data = await call(creds.base, "GET", `/_matrix/client/v3/rooms/${room(roomId)}/messages`, { token: creds.token, query: {
      dir: "b", from, limit: "40", filter: JSON.stringify({ lazy_load_members: true, types: HISTORY_TYPES }),
    } });
    const chunk = [...(data.chunk ?? [])].reverse();
    const r = joinedRoom(roomId, { state: { events: data.state ?? [] }, timeline: { events: chunk } }, creds.user_id);
    withEdits(r.events, chunk, roomId);
    return { events: r.events.filter(e => e.type === "message" || e.type === "reaction"), from: data.end && data.end !== from && chunk.length ? data.end : null };
  },

  // The homeserver's own search of a room (it can't see into encrypted
  // ones), newest first: {messages, next}, the messages as history has them
  // and next for the page after (null when there's no more). A hit on an
  // edit is the message it edited, as it reads now.
  async search(creds, roomId, text, next) {
    const data = await call(creds.base, "POST", "/_matrix/client/v3/search", { token: creds.token, query: { next_batch: next }, body: {
      search_categories: { room_events: {
        search_term: text, keys: ["content.body"], order_by: "recent",
        filter: { rooms: [roomId], types: ["m.room.message"], limit: 20 },
        event_context: { before_limit: 0, after_limit: 0, include_profile: true },
      } },
    } });
    const found = data.search_categories?.room_events ?? {};
    const results = (found.results ?? []).filter(x => x?.result?.event_id);
    // Names as the room had them then.
    const state = results.flatMap(x => Object.entries(x.context?.profile_info ?? {})
      .map(([user, p]) => ({ type: "m.room.member", state_key: user, content: { displayname: p?.displayname } })));
    const chunk = results.map(x => x.result).reverse();
    const r = joinedRoom(roomId, { state: { events: state }, timeline: { events: chunk } }, creds.user_id);
    withEdits(r.events, chunk, roomId);
    const seen = new Set(), messages = [];
    for (const e of r.events.reverse()) {
      const hit = e.type === "edit" ? { ...e, id: e.target, edited_at: e.at } : e;
      if ((hit.type !== "message" && hit.type !== "edit") || seen.has(hit.id)) continue;
      seen.add(hit.id);
      messages.push({ id: hit.id, sender: hit.sender, sender_name: hit.sender_name, mine: hit.mine, body: hit.body, at: hit.at, edited_at: hit.edited_at ?? null });
    }
    return { messages, next: typeof found.next_batch === "string" && found.next_batch && results.length ? found.next_batch : null };
  },

  // Deletes a message, or takes back a reaction (both are redactions).
  async remove(creds, roomId, eventId) {
    await call(creds.base, "PUT", `/_matrix/client/v3/rooms/${room(roomId)}/redact/${encodeURIComponent(eventId)}/${txn()}`,
      { token: creds.token, body: {} });
  },
};

// Edits made since a page of history: the newest one rides along with its
// message (in unsigned m.relations, as the homeserver bundles it).
function withEdits(events, chunk, roomId) {
  for (const e of events) {
    const ev = chunk.find(x => x.event_id === e.id);
    const edit = e.type === "message" && ev?.unsigned?.["m.relations"]?.["m.replace"];
    if (edit?.sender !== ev?.sender || !edit?.content) continue;
    const at = Math.floor((edit.origin_server_ts ?? Date.now()) / 1000);
    if (edit.type === "m.room.encrypted" && e.encrypted) Object.assign(e, { raw: JSON.stringify({ ...edit, room_id: roomId }), edited_at: at });
    else if (edit.type === "m.room.message" && !e.encrypted) {
      const body = textOf(edit.content["m.new_content"] ?? edit.content, e.sender_name);
      if (body) Object.assign(e, { body, edited_at: at });
    }
  }
}

// "@sam:example.org" → "sam"
const localpart = mxid => String(mxid).replace(/^@/, "").split(":")[0];

// A reply's body starts with the quoted message ("> <@x> …" lines, then a
// blank line); chat shows the reply alone.
const dropReplyQuote = body => body.replace(/^(> .*\n)+\n/, "");

function textOf(content, senderName) {
  // Formatting comes as HTML; chat keeps it as the Markdown it stands for.
  const html = content?.format === "org.matrix.custom.html" && typeof content.formatted_body === "string" && fromHtml(content.formatted_body);
  const body = html || (typeof content?.body === "string" ? content.body : "");
  const kind = content?.msgtype;
  let out = kind === "m.emote" ? `* ${senderName} ${body}`
    : ["m.image", "m.file", "m.video", "m.audio"].includes(kind) ? `[${kind.slice(2)}] ${body}`
    : html ? body : dropReplyQuote(body);
  out = out.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim();
  return out.length > MAX_BODY ? out.slice(0, MAX_BODY) + "…" : out;
}

// A room you've been invited to: named from what the invite shows, and who sent it.
function invitedRoom(id, r, me) {
  const out = { id, events: [], invite: { by: null } };
  const names = new Map();
  for (const e of r.invite_state?.events ?? []) {
    const c = e.content ?? {};
    if (e.type === "m.room.member" && c.displayname) names.set(e.state_key, String(c.displayname).slice(0, 80));
    if (e.type === "m.room.member" && e.state_key === me && c.membership === "invite") out.invite.by = e.sender;
    else if (e.type === "m.room.name") out.name = String(c.name ?? "").trim().slice(0, 60);
    else if (e.type === "m.room.encryption") out.encrypted = true;
  }
  const by = out.invite.by;
  out.invite.by = by ? names.get(by) || localpart(by) : "someone";
  // A direct message is named for who it's with.
  out.fallback_name = out.invite.by;
  return out;
}

// What a message answers, if it's a reply: {reply: its id}. (Outside the
// encryption in an encrypted room, as Matrix has it.)
function replyOf(c) {
  const id = c?.["m.relates_to"]?.["m.in_reply_to"]?.event_id;
  return typeof id === "string" && id.length <= 255 ? { reply: id } : {};
}

// A reaction → {target, key}. In an encrypted room it's encrypted too, but
// what it annotates (the emoji included) is outside the encryption, as
// Matrix has it, so it reads the same.
export function reactionOf(e) {
  if (e.type !== "m.reaction" && e.type !== "m.room.encrypted") return null;
  const rel = e.content?.["m.relates_to"];
  if (rel?.rel_type !== "m.annotation" || typeof rel.event_id !== "string" || typeof rel.key !== "string") return null;
  const key = rel.key.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return key && key.length <= 32 ? { target: rel.event_id, key } : null;
}

// A picture in an (unencrypted) image message: where it is and its shape,
// for chat to show it. The body stays "[image] name" for the terminal and search.
function imageOf(c) {
  if (c?.msgtype !== "m.image" || typeof c.url !== "string" || !MXC.test(c.url)) return null;
  const info = c.info ?? {}, mimetype = String(info.mimetype || "").toLowerCase();
  if (!IMAGE_TYPES.includes(mimetype)) return null;
  const dim = v => Number.isInteger(v) && v > 0 && v < 20000 ? v : null;
  return { mxc: c.url, mimetype, width: dim(info.w), height: dim(info.h), name: String(c.body || "").slice(0, 200) };
}

function joinedRoom(id, r, me) {
  const state = [...(r.state?.events ?? []), ...(r.timeline?.events ?? []).filter(e => e.state_key !== undefined)];
  const names = new Map();
  const out = { id, events: [], ...(r.timeline?.prev_batch ? { back: r.timeline.prev_batch } : {}) };
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
    } else if (reactionOf(e)) {
      out.events.push({ type: "reaction", id: e.event_id, ...reactionOf(e), sender: e.sender, sender_name: who(e.sender), mine: e.sender === me, at });
    } else if (e.type === "m.room.encrypted") {
      // Kept as it came, for the browser with the keys. Edits say what they
      // replace outside the encryption, as Matrix has it.
      const raw = JSON.stringify({ type: e.type, content: c, sender: e.sender, event_id: e.event_id, origin_server_ts: e.origin_server_ts, room_id: id });
      const rel = c["m.relates_to"];
      if (rel?.rel_type === "m.replace" && rel.event_id) out.events.push({ type: "edit", target: rel.event_id, sender: e.sender, raw, at });
      else out.events.push({ type: "message", id: e.event_id, sender: e.sender, sender_name: who(e.sender), mine: e.sender === me,
        body: ENCRYPTED_NOTE, at, encrypted: true, raw, ...replyOf(c) });
    } else if (e.type === "m.room.message") {
      const rel = c["m.relates_to"];
      if (rel?.rel_type === "m.replace" && rel.event_id) {
        const body = textOf(c["m.new_content"] ?? c, who(e.sender));
        if (body) out.events.push({ type: "edit", target: rel.event_id, sender: e.sender, sender_name: who(e.sender), mine: e.sender === me, body, at });
      } else {
        const body = textOf(c, who(e.sender));
        if (body) out.events.push({ type: "message", id: e.event_id, sender: e.sender, sender_name: who(e.sender), mine: e.sender === me, body, at, encrypted: false,
          ...replyOf(c), ...(imageOf(c) ? { media: imageOf(c) } : {}) });
      }
    }
  }
  // Who's typing now (when that changed), and how far people have read.
  for (const e of r.ephemeral?.events ?? []) {
    if (e.type === "m.typing" && Array.isArray(e.content?.user_ids)) {
      out.typing = e.content.user_ids.filter(u => typeof u === "string" && u !== me).slice(0, 10).map(who);
    } else if (e.type === "m.receipt") {
      for (const [event, kinds] of Object.entries(e.content ?? {})) {
        for (const [user, info] of Object.entries(kinds?.["m.read"] ?? {})) {
          if (user === me || info?.thread_id && info.thread_id !== "main") continue;
          (out.receipts ??= []).push({ user, name: who(user), event, at: Math.floor((info?.ts ?? Date.now()) / 1000) });
        }
      }
    }
  }
  if (out.receipts?.length > 50) out.receipts = out.receipts.slice(-50);
  return out;
}
