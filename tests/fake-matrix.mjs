// A stand-in Matrix homeserver for tests: the parts of the client-server API
// src/matrix.js uses, answered in memory. install() routes fetch() to it for
// matrix.test (and anything else to a 404), the way a Worker would reach it.

export class FakeMatrix {
  constructor({ user = "@ryan:matrix.test", token = "syt_good", password = "hunter22hunter22" } = {}) {
    this.user = user; this.token = token; this.password = password;
    this.events = [];          // [{room, event}] in order; a sync token is an index into it
    this.rooms = new Map();    // id → {name, encrypted, members: Map(mxid → name)}
    this.requests = [];        // [method, path] for checking what was asked
    this.loggedOut = [];
    this.n = 0;
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
  encrypted(room, sender) {
    const event = { type: "m.room.encrypted", event_id: `$e${++this.n}`, sender, origin_server_ts: Date.now(), content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "…" } };
    this.events.push({ room, event });
    return event.event_id;
  }
  edit(room, sender, target, body) {
    return this.say(room, sender, "* " + body, { "m.new_content": { msgtype: "m.text", body }, "m.relates_to": { rel_type: "m.replace", event_id: target } });
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
    if (url.hostname !== "hs.matrix.test") return json({ errcode: "M_UNRECOGNIZED" }, 404);
    this.requests.push([req.method, path]);
    const body = req.method === "GET" ? null : await req.json().catch(() => null);
    if (path === "/_matrix/client/v3/login") {
      if (body?.identifier?.user !== this.user && body?.identifier?.user !== "ryan" || body.password !== this.password) {
        return json({ errcode: "M_FORBIDDEN", error: "Invalid username or password" }, 403);
      }
      return json({ access_token: "syt_fromlogin", user_id: this.user, device_id: "SITE" });
    }
    const auth = req.headers.get("Authorization");
    if (auth !== `Bearer ${this.token}` && auth !== "Bearer syt_fromlogin") return json({ errcode: "M_UNKNOWN_TOKEN", error: "Unknown token" }, 401);
    if (path === "/_matrix/client/v3/account/whoami") return json({ user_id: this.user, device_id: "DEV" });
    if (path === "/_matrix/client/v3/logout") { this.loggedOut.push(auth); return json({}); }
    if (path === "/_matrix/client/v3/sync") return json(this.sync(url.searchParams.get("since")));
    let m = path.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/m\.room\.message\/([^/]+)$/);
    if (m && req.method === "PUT") {
      const room = decodeURIComponent(m[1]);
      if (!this.rooms.has(room)) return json({ errcode: "M_FORBIDDEN", error: "not in room" }, 403);
      const event = { type: "m.room.message", event_id: `$e${++this.n}`, sender: this.user, origin_server_ts: Date.now(), content: body,
        unsigned: { transaction_id: decodeURIComponent(m[2]) } };
      this.events.push({ room, event });
      return json({ event_id: event.event_id });
    }
    m = path.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/redact\/([^/]+)\/[^/]+$/);
    if (m && req.method === "PUT") {
      this.redact(decodeURIComponent(m[1]), this.user, decodeURIComponent(m[2]));
      return json({ event_id: `$e${this.n}` });
    }
    return json({ errcode: "M_UNRECOGNIZED" }, 404);
  }

  sync(since) {
    const from = since ? Number(since) : 0;
    const join = {}, leave = {};
    for (const [id, r] of this.rooms) {
      if (r.left) { if (from) leave[id] = { timeline: { events: [] } }; continue; }
      const timeline = this.events.slice(from).filter(e => e.room === id).map(e => e.event);
      if (from && !timeline.length && !r.changed) continue;
      r.changed = false;
      const state = [];
      if (!from || r.renamed) {
        if (r.name) state.push({ type: "m.room.name", state_key: "", content: { name: r.name } });
        if (r.encrypted) state.push({ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } });
        r.renamed = false;
      }
      for (const [mxid, name] of r.members) state.push({ type: "m.room.member", state_key: mxid, content: { membership: "join", displayname: name } });
      join[id] = { state: { events: state }, timeline: { events: timeline, limited: false },
        summary: { "m.heroes": [...r.members.keys()].filter(k => k !== this.user) } };
    }
    return { next_batch: String(this.events.length), rooms: { join, leave } };
  }
}
