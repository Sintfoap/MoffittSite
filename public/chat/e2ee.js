// End-to-end encryption for chat connections, done here in the browser so
// the keys never leave it. Matrix's own crypto library (vendor/matrix-crypto,
// the one Element uses) holds this connection's device keys, in this
// browser's storage. The site only passes things along:
//   claim    makes this browser the one that holds the keys (once)
//   inbox    what each sync brought for them: to-device messages (room keys
//            from other people's devices) and whose devices changed
//   request  a key request the library wants made, sent on with the sign-in
// Encrypted messages come with `raw`, the event as it came, to decrypt here;
// sending encrypts here first and gives the site only the result.
//
// It takes the library and a post(op, body) function rather than reaching
// for them, so the tests run it in Node against a stand-in homeserver.

export class Vault {
  constructor(lib, machine, post, key) {
    this.lib = lib; this.machine = machine; this.post = post; this.key = key;
    this.chain = Promise.resolve();
    this.cache = new Map();   // raw → decrypted content (or null: no key for it yet)
  }

  // key: 64 hex characters only this browser knows. store: where the library
  // keeps the keys (IndexedDB) — left out, they're only kept in memory.
  static async open(lib, { post, key, store, passphrase }) {
    const { device } = await post("claim", { key });
    const machine = await lib.OlmMachine.initialize(new lib.UserId(device.user_id), new lib.DeviceId(device.device_id), store, passphrase);
    const vault = new Vault(lib, machine, post, key);
    vault.device = device;
    await vault.pump();
    return vault;
  }

  // One thing at a time: the library's requests have to be answered in order.
  lock(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  ask(op, body = {}) { return this.post(op, { key: this.key, ...body }); }

  // Takes what syncs brought from the inbox and gives it to the library, then
  // makes the requests that leads to (uploading keys, answering key shares).
  pump() {
    return this.lock(async () => {
      const { lib } = this;
      let ack = 0, got = false;
      for (let round = 0; round < 20; round++) {
        const { items, counts } = await this.ask("inbox", { ack });
        const otk = new Map(Object.entries(counts?.otk_counts ?? {}));
        const fallback = counts?.fallback ? new Set(counts.fallback) : undefined;
        if (!items.length && got) break;
        const batch = items.length ? items : [{ to_device: [], changed: [], left: [] }];
        for (const it of batch) {
          const lists = new lib.DeviceLists(it.changed.map(u => new lib.UserId(u)), it.left.map(u => new lib.UserId(u)));
          await this.machine.receiveSyncChanges(JSON.stringify(it.to_device), lists, otk, fallback);
        }
        got = true;
        if (items.length) { ack = items.at(-1).id; this.cache.clear(); }
        await this.flush();
        if (!items.length) break;
      }
    });
  }

  // Makes every request the library has waiting, until it has none.
  async flush() {
    for (let round = 0; round < 10; round++) {
      const reqs = await this.machine.outgoingRequests();
      if (!reqs.length) return;
      for (const r of reqs) await this.send(r);
    }
  }

  async send(r) {
    const T = this.lib.RequestType, enc = encodeURIComponent;
    const route = {
      [T.KeysUpload]: () => ["POST", "keys/upload"],
      [T.KeysQuery]: () => ["POST", "keys/query"],
      [T.KeysClaim]: () => ["POST", "keys/claim"],
      [T.SignatureUpload]: () => ["POST", "keys/signatures/upload"],
      [T.ToDevice]: () => ["PUT", `sendToDevice/${enc(r.event_type)}/${enc(r.txn_id)}`],
      [T.RoomMessage]: () => ["PUT", `rooms/${enc(r.room_id)}/send/${enc(r.event_type)}/${enc(r.txn_id)}`],
      [T.KeysBackup]: () => ["PUT", `room_keys/keys?version=${enc(r.version)}`],
    }[r.type];
    if (!route) return;
    const [method, path] = route();
    const { response } = await this.ask("request", { method, path, body: JSON.parse(r.body || "{}") });
    if (r.id) await this.machine.markRequestAsSent(r.id, r.type, JSON.stringify(response));
  }

  // An encrypted event as it came → its decrypted content, or null when this
  // browser hasn't (yet) been given the key for it.
  async decrypt(raw) {
    if (this.cache.has(raw)) return this.cache.get(raw);
    const { lib } = this;
    let content = null;
    try {
      const event = JSON.parse(raw);
      const out = await this.lock(() => this.machine.decryptRoomEvent(raw, new lib.RoomId(event.room_id),
        new lib.DecryptionSettings(lib.TrustRequirement.Untrusted)));
      content = JSON.parse(out.event).content ?? null;
    } catch { content = null; }
    this.cache.set(raw, content);
    return content;
  }

  // Message content → the encrypted content to send to a room, after
  // making sure everyone's devices in it have the room's key.
  encrypt(roomId, content) {
    return this.lock(async () => {
      const { lib } = this;
      const { response } = await this.ask("request", { method: "GET", path: `rooms/${encodeURIComponent(roomId)}/joined_members` });
      const names = Object.keys(response.joined ?? {});
      // (The library takes these over, so each call gets new ones.)
      const users = () => names.map(u => new lib.UserId(u));
      await this.machine.updateTrackedUsers(users());
      await this.flush();
      const claim = await this.machine.getMissingSessions(users());
      if (claim) await this.send(claim);
      for (const r of await this.machine.shareRoomKey(new lib.RoomId(roomId), users(), new lib.EncryptionSettings())) await this.send(r);
      const out = JSON.parse(await this.machine.encryptRoomEvent(new lib.RoomId(roomId), "m.room.message", JSON.stringify(content)));
      // What an edit replaces stays readable, as Matrix has it.
      if (content["m.relates_to"] && !out["m.relates_to"]) out["m.relates_to"] = content["m.relates_to"];
      return out;
    });
  }
}

// Decrypted content → the text chat shows, as the site does for plain rooms.
export function textOf(content, senderName) {
  const c = content?.["m.new_content"] ?? content;
  const body = typeof c?.body === "string" ? c.body : "";
  const kind = c?.msgtype;
  const out = kind === "m.emote" ? `* ${senderName} ${body}`
    : ["m.image", "m.file", "m.video", "m.audio"].includes(kind) ? `[${kind.slice(2)}] ${body}`
    : body.replace(/^(> .*\n)+\n/, "");
  return out.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim();
}

export const textContent = text => ({ msgtype: "m.text", body: text });
export const editContent = (eventId, text) => ({
  msgtype: "m.text", body: "* " + text, "m.new_content": { msgtype: "m.text", body: text },
  "m.relates_to": { rel_type: "m.replace", event_id: eventId },
});
