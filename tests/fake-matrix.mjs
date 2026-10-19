// A stand-in Matrix homeserver for tests: the parts of the client-server API
// src/matrix.js uses, answered in memory. install() routes fetch() to it for
// matrix.test (and anything else to a 404), the way a Worker would reach it.
//
// It also keeps what end-to-end encryption needs: each device's keys and
// one-time keys, to-device messages until that device syncs, and who changed
// their keys. A second account can be added with person() to talk to the
// site's device from a real crypto library, as someone in Element would.

export class FakeMatrix {
  constructor({ user = "@ryan:matrix.test", token = "syt_good", password = "hunter22hunter22" } = {}) {
    this.user = user; this.token = token; this.password = password;
    this.events = [];          // [{room, event}] in order; a sync token is an index into it
    this.rooms = new Map();    // id → {name, encrypted, members: Map(mxid → name)}
    this.requests = [];        // [method, path] for checking what was asked
    this.loggedOut = [];
    this.pushers = new Map();  // pushkey → {url, app_id, format}; refusePushers makes /pushers/set fail
    this.n = 0;
    // Other sessions, token → {user, device}. `token` is DEV's (tests change
    // it to make it stop working); the session a password sign-in makes is SITE.
    this.tokens = new Map([["syt_fromlogin", { user, device: "SITE" }]]);
    this.keys = new Map();     // "user|device" → {device_keys, otks: Map(id → key), fallback}
    this.inbox = new Map();    // "user|device" → [to-device events]
    this.changed = new Map();  // "user|device" → Set(users whose keys changed)
    this.cursors = new Map();  // token → how far that session's syncs got (for person())
    this.signing = new Map();  // user → {master_key, self_signing_key, user_signing_key}
    this.accountData = new Map();   // "user|type" → content
    this.backups = [];         // [{version, algorithm, auth_data, rooms: {room: {session: data}}}]
    this.signatures = [];      // every keys/signatures/upload body, to check what was signed
    this.typed = [];           // [room, user, body] for each "typing" the site sent
    this.receipts = [];        // [room, user, event id] for each read receipt the site sent
    this.media = new Map();    // media id → {bytes, type}; legacyMedia: no authenticated media API
    this.legacyMedia = false;
    this.behind = 0;           // the latest events syncs don't have yet (a sync worker lagging, as on matrix.org)
    this.unreadable = new Set(); // event ids reading one by id doesn't find yet
  }

  // An invite for the signed-in account to a room someone else is in.
  invite(id, by, { name, encrypted = false, members = {} } = {}) {
    const r = this.room(id, { name, encrypted, members });
    r.invited = by;
    return r;
  }

  // Ephemeral events for the next sync: who's typing, and read receipts.
  typing(room, users) { this.ephemeral(room, { type: "m.typing", content: { user_ids: users } }); }
  receipt(room, user, event) { this.ephemeral(room, { type: "m.receipt", content: { [event]: { "m.read": { [user]: { ts: Date.now() } } } } }); }
  ephemeral(room, e) {
    const r = this.rooms.get(room);
    (r.ephemeral ??= []).push(e); r.changed = true;
  }

  setAccountData(user, type, content) { this.accountData.set(`${user}|${type}`, content); }

  // Another account, signed in on one device: {token, user, device}.
  person(user, device, token) {
    this.tokens.set(token, { user, device });
    return { token, user, device };
  }

  room(id, { name, encrypted = false, members = {} } = {}) {
    const r = { name, encrypted, members: new Map(Object.entries(members)), left: false };
    this.rooms.set(id, r);
    return r;
  }

  // Something someone said, as the homeserver would hand it out.
  say(room, sender, body, extra = {}) {
    const event = { type: "m.room.message", event_id: `$e${++this.n}`, sender, origin_server_ts: Date.now(),
      content: { msgtype: "m.text", body, ...extra } };
    this.events.push({ room, event });
    return event.event_id;
  }
  // A picture someone sent: stored, then an image message pointing to it.
  image(room, sender, bytes, type = "image/gif", name = "cat.gif", info = {}) {
    const id = `m${++this.n}`;
    this.media.set(id, { bytes, type });
    return this.say(room, sender, name, { msgtype: "m.image", url: `mxc://hs.matrix.test/${id}`, info: { mimetype: type, size: bytes.length, ...info } });
  }
  encrypted(room, sender) {
    const event = { type: "m.room.encrypted", event_id: `$e${++this.n}`, sender, origin_server_ts: Date.now(), content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "…" } };
    this.events.push({ room, event });
    return event.event_id;
  }
  edit(room, sender, target, body) {
    return this.say(room, sender, "* " + body, { "m.new_content": { msgtype: "m.text", body }, "m.relates_to": { rel_type: "m.replace", event_id: target } });
  }
  react(room, sender, target, key) {
    const event = { type: "m.reaction", event_id: `$e${++this.n}`, sender, origin_server_ts: Date.now(),
      content: { "m.relates_to": { rel_type: "m.annotation", event_id: target, key } } };
    this.events.push({ room, event });
    return event.event_id;
  }
  // Reactions on a message that haven't been taken back: [[sender, key]].
  reactions(room, target) {
    const gone = new Set(this.events.filter(e => e.event.type === "m.room.redaction").map(e => e.event.redacts));
    return this.events.filter(e => e.room === room && e.event.type === "m.reaction" && !gone.has(e.event.event_id)
      && e.event.content["m.relates_to"].event_id === target).map(e => [e.event.sender, e.event.content["m.relates_to"].key]);
  }
  redact(room, sender, target) {
    this.events.push({ room, event: { type: "m.room.redaction", event_id: `$e${++this.n}`, sender, redacts: target, origin_server_ts: Date.now(), content: {} } });
  }
  bodies(room) {
    return this.events.filter(e => e.room === room && e.event.type === "m.room.message").map(e => e.event.content.body);
  }

  install() {
    this.realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => this.handle(new Request(input, init));
    return this;
  }
  uninstall() { globalThis.fetch = this.realFetch; }

  async handle(req) {
    const url = new URL(req.url), path = url.pathname;
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
    if (url.hostname === "matrix.test" && path === "/.well-known/matrix/client") return json({ "m.homeserver": { base_url: "https://hs.matrix.test" } });
    // An address that's down, and one whose proxy redirects to the real thing.
    if (url.hostname === "down.test") throw new TypeError("connection refused");
    if (url.hostname === "moved.test") return new Response(null, { status: 301, headers: { Location: "https://matrix.test" + path } });
    if (url.hostname !== "hs.matrix.test") return json({ errcode: "M_UNRECOGNIZED" }, 404);
    if (path.startsWith("/old/")) return new Response(null, { status: 308, headers: { Location: path.slice(4) + url.search } });
    this.requests.push([req.method, path]);
    // The old media API needs no sign-in.
    const old = path.match(/^\/_matrix\/media\/v3\/download\/hs\.matrix\.test\/([^/]+)$/);
    if (old && req.method === "GET") {
      const f = this.media.get(decodeURIComponent(old[1]));
      return f ? new Response(f.bytes, { headers: { "Content-Type": f.type } }) : json({ errcode: "M_NOT_FOUND" }, 404);
    }
    if (path === "/_matrix/media/v3/upload" && req.method === "POST" && !req.headers.get("Authorization")) return json({ errcode: "M_MISSING_TOKEN" }, 401);
    const body = req.method === "GET" || path === "/_matrix/media/v3/upload" ? null : await req.json().catch(() => null);
    if (path === "/_matrix/client/v3/login") {
      if (body?.identifier?.user !== this.user && body?.identifier?.user !== "ryan" || body.password !== this.password) {
        return json({ errcode: "M_FORBIDDEN", error: "Invalid username or password" }, 403);
      }
      return json({ access_token: "syt_fromlogin", user_id: this.user, device_id: "SITE" });
    }
    const auth = req.headers.get("Authorization");
    const tok = String(auth).replace(/^Bearer /, "");
    const who = tok === this.token ? { user: this.user, device: "DEV" } : this.tokens.get(tok);
    if (!who) return json({ errcode: "M_UNKNOWN_TOKEN", error: "Unknown token" }, 401);
    if (path === "/_matrix/client/v3/account/whoami") return json({ user_id: who.user, device_id: who.device });
    if (path === "/_matrix/client/v3/logout") { this.loggedOut.push(auth); return json({}); }
    if (path === "/_matrix/client/v3/sync") {
      const limit = JSON.parse(url.searchParams.get("filter") || "{}").room?.timeline?.limit;
      return json(this.sync(url.searchParams.get("since"), who, { limit: this.limited ? limit : undefined }));
    }
    if (path === "/_matrix/client/v3/pushers/set" && req.method === "POST") {
      if (this.refusePushers) return json({ errcode: "M_UNKNOWN", error: "pushers are turned off here" }, 400);
      if (body.kind === null) this.pushers.delete(body.pushkey);
      else this.pushers.set(body.pushkey, { url: body.data?.url, app_id: body.app_id, format: body.data?.format });
      return json({});
    }
    if (path === "/_matrix/media/v3/upload" && req.method === "POST") {
      const id = `m${++this.n}`;
      this.media.set(id, { bytes: new Uint8Array(await req.arrayBuffer()), type: req.headers.get("Content-Type"), name: url.searchParams.get("filename") });
      return json({ content_uri: `mxc://hs.matrix.test/${id}` });
    }
    const dl = path.match(/^\/_matrix\/client\/v1\/media\/download\/hs\.matrix\.test\/([^/]+)$/);
    if (dl && req.method === "GET") {
      if (this.legacyMedia) return json({ errcode: "M_UNRECOGNIZED" }, 404);
      const f = this.media.get(decodeURIComponent(dl[1]));
      return f ? new Response(f.bytes, { headers: { "Content-Type": f.type } }) : json({ errcode: "M_NOT_FOUND" }, 404);
    }
    if (path === "/_matrix/client/v3/joined_rooms") return json({ joined_rooms: [...this.rooms].filter(([, r]) => !r.left && !r.invited).map(([id]) => id) });
    let p = path.match(/^\/_matrix\/client\/v3\/profile\/([^/]+)$/);
    if (p) {
      const u = decodeURIComponent(p[1]), known = [...this.rooms.values()].some(r => r.members.has(u)) || (this.people ?? []).includes(u);
      return known ? json({ displayname: u.slice(1).split(":")[0] }) : json({ errcode: "M_NOT_FOUND", error: "Profile not found" }, 404);
    }
    if (path === "/_matrix/client/v3/createRoom" && req.method === "POST") {
      const id = `!new${++this.n}:matrix.test`;
      const encrypted = (body.initial_state ?? []).some(e => e.type === "m.room.encryption");
      const r = this.room(id, { encrypted, members: { [who.user]: "Ryan" } });
      r.invites = body.invite ?? []; r.direct = !!body.is_direct; r.changed = true;
      this.created = [...(this.created ?? []), { id, ...body }];
      return json({ room_id: id });
    }
    p = path.match(/^\/_matrix\/client\/v3\/join\/([^/]+)$/);
    if (p && req.method === "POST") {
      const r = this.rooms.get(decodeURIComponent(p[1]));
      if (!r?.invited) return json({ errcode: "M_FORBIDDEN", error: "not invited" }, 403);
      r.invited = false; r.members.set(who.user, "Ryan"); r.changed = true; r.renamed = true;
      return json({ room_id: decodeURIComponent(p[1]) });
    }
    p = path.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/leave$/);
    if (p && req.method === "POST") {
      const r = this.rooms.get(decodeURIComponent(p[1]));
      if (!r) return json({ errcode: "M_FORBIDDEN", error: "not in room" }, 403);
      r.left = true; r.invited = false;
      return json({});
    }
    let h = path.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/messages$/);
    if (h && req.method === "GET") return json(this.history(decodeURIComponent(h[1]), url.searchParams));
    if (path.startsWith("/_matrix/client/v3/keys/") || path.startsWith("/_matrix/client/v3/sendToDevice/")) return json(this.crypto(req.method, path, body, who));
    let a = path.match(/^\/_matrix\/client\/v3\/user\/([^/]+)\/account_data\/([^/]+)$/);
    if (a) {
      const user = decodeURIComponent(a[1]), type = decodeURIComponent(a[2]);
      if (user !== who.user) return json({ errcode: "M_FORBIDDEN", error: "not yours" }, 403);
      if (req.method === "PUT") { this.setAccountData(user, type, body); return json({}); }
      const content = this.accountData.get(`${user}|${type}`);
      return content ? json(content) : json({ errcode: "M_NOT_FOUND", error: "Account data not found" }, 404);
    }
    if (path.startsWith("/_matrix/client/v3/room_keys/")) {
      const out = this.roomKeys(req.method, path.slice("/_matrix/client/v3/room_keys/".length), url.searchParams.get("version"), body);
      return out ? json(out) : json({ errcode: "M_NOT_FOUND", error: "No backup found" }, 404);
    }
    // One event, and someone's membership, straight from the store: they don't lag.
    let ev = path.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/event\/([^/]+)$/);
    if (ev && req.method === "GET") {
      const found = !this.unreadable.has(decodeURIComponent(ev[2]))
        && this.events.find(e => e.room === decodeURIComponent(ev[1]) && e.event.event_id === decodeURIComponent(ev[2]));
      return found ? json({ ...found.event, room_id: found.room }) : json({ errcode: "M_NOT_FOUND", error: "Event not found" }, 404);
    }
    ev = path.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state\/m\.room\.member\/([^/]+)$/);
    if (ev && req.method === "GET") {
      const name = this.rooms.get(decodeURIComponent(ev[1]))?.members.get(decodeURIComponent(ev[2]));
      return name ? json({ membership: "join", displayname: name }) : json({ errcode: "M_NOT_FOUND" }, 404);
    }
    let m = path.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/joined_members$/);
    if (m && req.method === "GET") {
      const r = this.rooms.get(decodeURIComponent(m[1]));
      if (!r) return json({ errcode: "M_FORBIDDEN", error: "not in room" }, 403);
      return json({ joined: Object.fromEntries([...r.members].map(([id, name]) => [id, { display_name: name }])) });
    }
    m = path.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/(m\.room\.message|m\.room\.encrypted|m\.reaction)\/([^/]+)$/);
    if (m && req.method === "PUT") {
      const room = decodeURIComponent(m[1]);
      if (!this.rooms.has(room)) return json({ errcode: "M_FORBIDDEN", error: "not in room" }, 403);
      const event = { type: m[2], event_id: `$e${++this.n}`, sender: who.user, origin_server_ts: Date.now(), content: body,
        unsigned: { transaction_id: decodeURIComponent(m[3]) } };
      this.events.push({ room, event });
      return json({ event_id: event.event_id });
    }
    m = path.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/typing\/([^/]+)$/);
    if (m && req.method === "PUT") { this.typed.push([decodeURIComponent(m[1]), decodeURIComponent(m[2]), body]); return json({}); }
    m = path.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/receipt\/m\.read\/([^/]+)$/);
    if (m && req.method === "POST") { this.receipts.push([decodeURIComponent(m[1]), who.user, decodeURIComponent(m[2])]); return json({}); }
    m = path.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/redact\/([^/]+)\/[^/]+$/);
    if (m && req.method === "PUT") {
      this.redact(decodeURIComponent(m[1]), who.user, decodeURIComponent(m[2]));
      return json({ event_id: `$e${this.n}` });
    }
    return json({ errcode: "M_UNRECOGNIZED" }, 404);
  }

  // keys/upload, keys/query, keys/claim, keys/signatures/upload, sendToDevice.
  crypto(method, path, body, who) {
    const me = `${who.user}|${who.device}`;
    const p = path.slice("/_matrix/client/v3/".length);
    if (p === "keys/upload") {
      const k = this.keys.get(me) ?? this.keys.set(me, { otks: new Map() }).get(me);
      if (body.device_keys) {
        k.device_keys = body.device_keys;
        // Everyone else hears that this person's devices changed.
        for (const other of this.tokens.values()) {
          const id = `${other.user}|${other.device}`;
          if (id !== me) (this.changed.get(id) ?? this.changed.set(id, new Set()).get(id)).add(who.user);
        }
      }
      for (const [id, key] of Object.entries(body.one_time_keys ?? {})) k.otks.set(id, key);
      if (body.fallback_keys && Object.keys(body.fallback_keys).length) k.fallback = body.fallback_keys;
      return { one_time_key_counts: this.otkCounts(me) };
    }
    if (p === "keys/query") {
      const device_keys = {};
      for (const user of Object.keys(body.device_keys ?? {})) {
        device_keys[user] = {};
        for (const [id, k] of this.keys) if (id.startsWith(user + "|") && k.device_keys) device_keys[user][id.split("|")[1]] = k.device_keys;
      }
      const out = { device_keys, failures: {}, master_keys: {}, self_signing_keys: {}, user_signing_keys: {} };
      for (const user of Object.keys(body.device_keys ?? {})) {
        const sk = this.signing.get(user);
        if (!sk) continue;
        if (sk.master_key) out.master_keys[user] = sk.master_key;
        if (sk.self_signing_key) out.self_signing_keys[user] = sk.self_signing_key;
        if (sk.user_signing_key && user === who.user) out.user_signing_keys[user] = sk.user_signing_key;
      }
      return out;
    }
    if (p === "keys/device_signing/upload") {
      this.signing.set(who.user, { ...this.signing.get(who.user), ...body });
      for (const other of this.tokens.values()) {
        const id = `${other.user}|${other.device}`;
        if (id !== me) (this.changed.get(id) ?? this.changed.set(id, new Set()).get(id)).add(who.user);
      }
      return {};
    }
    if (p === "keys/claim") {
      const one_time_keys = {};
      for (const [user, devices] of Object.entries(body.one_time_keys ?? {})) {
        for (const device of Object.keys(devices)) {
          const k = this.keys.get(`${user}|${device}`);
          if (!k) continue;
          let found = [...k.otks].find(([id]) => id.startsWith("signed_curve25519:"));
          if (found) k.otks.delete(found[0]);
          else found = Object.entries(k.fallback ?? {})[0];
          if (found) ((one_time_keys[user] ??= {})[device] = { [found[0]]: found[1] });
        }
      }
      return { one_time_keys, failures: {} };
    }
    if (p === "keys/signatures/upload") {
      // Adds each signature to the device or cross-signing key it's for.
      this.signatures.push(body);
      for (const [user, objs] of Object.entries(body)) {
        for (const other of this.tokens.values()) {
          const id = `${other.user}|${other.device}`;
          if (id !== me) (this.changed.get(id) ?? this.changed.set(id, new Set()).get(id)).add(user);
        }
        for (const [keyId, signed] of Object.entries(objs)) {
          const device = this.keys.get(`${user}|${keyId}`)?.device_keys;
          const sk = this.signing.get(user);
          const target = device ?? Object.values(sk ?? {}).find(k => Object.keys(k.keys ?? {}).some(id => id.endsWith(":" + keyId)));
          if (!target) continue;
          for (const [signer, sigs] of Object.entries(signed.signatures ?? {})) target.signatures = { ...target.signatures, [signer]: { ...target.signatures?.[signer], ...sigs } };
        }
      }
      return { failures: {} };
    }
    const m = p.match(/^sendToDevice\/([^/]+)\/[^/]+$/);
    if (m && method === "PUT") {
      for (const [user, devices] of Object.entries(body.messages ?? {})) {
        for (const [device, content] of Object.entries(devices)) {
          const targets = device === "*" ? [...this.tokens.values()].filter(t => t.user === user).map(t => t.device) : [device];
          for (const d of targets) {
            const id = `${user}|${d}`;
            (this.inbox.get(id) ?? this.inbox.set(id, []).get(id)).push({ type: decodeURIComponent(m[1]), sender: who.user, content });
          }
        }
      }
      return {};
    }
    return { errcode: "M_UNRECOGNIZED" };
  }

  // The key backup: version, and room keys by room and session.
  roomKeys(method, p, version, body) {
    if (p === "version" && method === "POST") {
      const b = { version: String(this.backups.length + 1), algorithm: body.algorithm, auth_data: body.auth_data, rooms: {} };
      this.backups.push(b);
      return { version: b.version };
    }
    const latest = this.backups.at(-1);
    if (p === "version") return latest ? { version: latest.version, algorithm: latest.algorithm, auth_data: latest.auth_data, count: 0, etag: "1" } : null;
    const b = this.backups.find(b => b.version === version);
    if (!b) return null;
    if (p === "keys" && method === "PUT") {
      for (const [room, r] of Object.entries(body.rooms ?? {})) Object.assign((b.rooms[room] ??= {}), r.sessions);
      return { count: Object.values(b.rooms).reduce((n, r) => n + Object.keys(r).length, 0), etag: "2" };
    }
    const m = p.match(/^keys\/([^/]+)\/([^/]+)$/);
    if (m && method === "GET") return b.rooms[decodeURIComponent(m[1])]?.[decodeURIComponent(m[2])] ?? null;
    return null;
  }

  otkCounts(id) {
    const n = [...(this.keys.get(id)?.otks.keys() ?? [])].filter(k => k.startsWith("signed_curve25519:")).length;
    return { signed_curve25519: n };
  }

  // Everything that didn't fit in sync(): for a device that has keys here.
  syncCrypto(who, out) {
    const id = `${who.user}|${who.device}`;
    const events = this.inbox.get(id) ?? [];
    this.inbox.delete(id);
    if (events.length) out.to_device = { events };
    const changed = this.changed.get(id);
    this.changed.delete(id);
    if (changed?.size) out.device_lists = { changed: [...changed], left: [] };
    if (this.keys.has(id)) {
      out.device_one_time_keys_count = this.otkCounts(id);
      out.device_unused_fallback_key_types = this.keys.get(id).fallback ? ["signed_curve25519"] : [];
    }
    return out;
  }

  // Older history, as /messages has it: newest first, before `from` (an
  // index into events, as sync tokens are here).
  history(room, q) {
    const from = q.has("from") ? Number(q.get("from")) : this.events.length, limit = Number(q.get("limit") || 10);
    const types = JSON.parse(q.get("filter") || "{}").types;
    const before = this.events.map((e, i) => [e, i]).filter(([e, i]) => i < from && e.room === room && (!types || types.includes(e.event.type))).reverse().slice(0, limit);
    const redacted = new Set(this.events.filter(e => e.event.type === "m.room.redaction").map(e => e.event.redacts));
    const chunk = before.map(([e]) => {
      const edit = this.events.filter(x => x.event.content?.["m.relates_to"]?.rel_type === "m.replace" && x.event.content["m.relates_to"].event_id === e.event.event_id).at(-1);
      return { ...e.event, unsigned: { ...(redacted.has(e.event.event_id) ? { redacted_because: {} } : {}), ...(edit ? { "m.relations": { "m.replace": edit.event } } : {}) } };
    });
    this.requests.push(["history", room, from]);
    return { chunk, start: String(from), ...(before.length ? { end: String(before.at(-1)[1]) } : {}), state: [] };
  }

  sync(since, who, { limit } = {}) {
    const from = since ? Number(since) : 0, upto = Math.max(from, this.events.length - this.behind);
    const join = {}, leave = {}, invite = {};
    for (const [id, r] of this.rooms) {
      if (r.invited) {
        invite[id] = { invite_state: { events: [
          ...(r.name ? [{ type: "m.room.name", state_key: "", content: { name: r.name } }] : []),
          ...(r.encrypted ? [{ type: "m.room.encryption", state_key: "", content: {} }] : []),
          ...[...r.members].map(([mxid, name]) => ({ type: "m.room.member", state_key: mxid, sender: mxid, content: { membership: "join", displayname: name } })),
          { type: "m.room.member", state_key: this.user, sender: r.invited, content: { membership: "invite" } },
        ] } };
        continue;
      }
      if (r.left) { if (from) leave[id] = { timeline: { events: [] } }; continue; }
      const all = this.events.map((e, i) => [e, i]).slice(from, upto).filter(([e]) => e.room === id);
      // (Only the latest `limit` when asked, as a homeserver does, with where the rest begins.)
      const shown = limit && all.length > limit ? all.slice(-limit) : all;
      const timeline = shown.map(([e]) => e.event), prevBatch = String(shown[0]?.[1] ?? from);
      if (from && !timeline.length && !r.changed) continue;
      r.changed = false;
      const state = [];
      if (!from || r.renamed) {
        if (r.name) state.push({ type: "m.room.name", state_key: "", content: { name: r.name } });
        if (r.encrypted) state.push({ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } });
        r.renamed = false;
      }
      for (const [mxid, name] of r.members) state.push({ type: "m.room.member", state_key: mxid, content: { membership: "join", displayname: name } });
      const ephemeral = { events: r.ephemeral ?? [] };
      r.ephemeral = [];
      join[id] = { state: { events: state }, timeline: { events: timeline, limited: shown.length < all.length, prev_batch: prevBatch }, ephemeral,
        summary: { "m.heroes": [...r.members.keys()].filter(k => k !== this.user) } };
    }
    return this.syncCrypto(who, { next_batch: String(upto), rooms: { join, leave, invite } });
  }
}
