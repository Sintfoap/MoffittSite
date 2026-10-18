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
// With the account's Security Key (or Security Phrase), unlock() does what
// Element's "Verify with Security Key" does: it opens the account's secret
// storage, signs this session with the account's cross-signing key (so
// other apps see it as verified), and takes the key backup's key, so keys
// for older messages come from the backup and new ones go into it.
//
// It takes the library and a post(op, body) function rather than reaching
// for them, so the tests run it in Node against a stand-in homeserver.

import { fromHtml, messageContent, editContent } from "./format.js";

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
    // A backup key from an earlier unlock, kept in the library's store.
    const kept = await machine.getBackupKeys();
    if (kept?.decryptionKey && kept.backupVersion) vault.backup = { key: kept.decryptionKey, version: kept.backupVersion };
    vault.tried = new Set();   // sessions already asked of the backup
    await vault.pump();
    return vault;
  }

  // {verified, backup}: whether this session is signed by the account's
  // cross-signing key, and whether it has the key backup's key.
  async status() {
    const s = await this.machine.crossSigningStatus();
    return { verified: !!s.hasSelfSigning, backup: !!this.backup };
  }

  // The account's Security Key or Phrase → this session verified, and the
  // backup's key taken. Throws, saying why, if it can't.
  unlock(secret) {
    return this.lock(async () => {
      const { lib } = this, me = this.device.user_id;
      const data = async type => {
        try { return (await this.ask("request", { method: "GET", path: `user/${encodeURIComponent(me)}/account_data/${type}` })).response; }
        catch { return null; }
      };
      const id = (await data("m.secret_storage.default_key"))?.key;
      const desc = id && await data(`m.secret_storage.key.${id}`);
      if (!desc) throw new Error("this Matrix account has no Security Key set up yet; Element sets one up in Settings, Security & Privacy, Secure Backup");
      const ssss = await storageKey(secret, desc);
      const open = async name => {
        const enc = (await data(name))?.encrypted?.[id];
        return enc ? decryptSecret(ssss, name, enc) : null;
      };
      // Our own keys first, so the cross-signing keys can be checked against them.
      await this.machine.updateTrackedUsers([new lib.UserId(me)]);
      await this.flush();
      const status = await this.machine.importCrossSigningKeys(
        await open("m.cross_signing.master"), await open("m.cross_signing.self_signing"), await open("m.cross_signing.user_signing"));
      if (status.hasSelfSigning) {
        const device = await this.machine.getDevice(new lib.UserId(me), new lib.DeviceId(this.device.device_id));
        if (device) await this.send(await device.verify());
        const identity = await this.machine.getIdentity(new lib.UserId(me));
        if (identity && !identity.isVerified()) await this.send(await identity.verify());
      }
      const backupKey = await open("m.megolm_backup.v1");
      if (backupKey) {
        const key = lib.BackupDecryptionKey.fromBase64(backupKey);
        let info = null;
        try { info = (await this.ask("request", { method: "GET", path: "room_keys/version" })).response; } catch { /* no backup */ }
        if (info?.auth_data?.public_key === key.megolmV1PublicKey.publicKeyBase64) {
          await this.machine.saveBackupDecryptionKey(key, info.version);
          await this.machine.enableBackupV1(info.auth_data.public_key, info.version);
          this.backup = { key, version: info.version };
        }
      }
      this.forgetMisses(); this.tried.clear();
      await this.flush();
      return { verified: !!status.hasSelfSigning, backup: !!this.backup };
    });
  }

  // ── verifying with another of your devices (emoji) ───────────────────
  // As Element's "Verify with another device": this session asks your other
  // sessions (or one of them asks it), both show the same seven emoji, and
  // once you say they match on both, each trusts the other. Your other
  // session then signs this one with your cross-signing key and, asked,
  // shares the key backup's key, as a Security Key would.

  // Asks your other sessions to verify this one.
  requestVerification() {
    return this.lock(async () => {
      // (Knowing your other sessions first, to ask them.)
      await this.machine.updateTrackedUsers([new this.lib.UserId(this.device.user_id)]);
      await this.flush();
      const identity = await this.machine.getIdentity(new this.lib.UserId(this.device.user_id));
      if (!identity) throw new Error("your account has no cross-signing set up yet, so there's nothing to verify against; Element sets it up");
      const [, out] = await identity.requestVerification([this.lib.VerificationMethod.SasV1]);
      await this.send(out);
      await this.flush();
    });
  }

  // Where each verification with your own sessions is, for showing:
  // [{id, state, by_us, other_device, emoji}] where state is "requested"
  // (waiting for the other side, or for you to accept), "ready", "compare"
  // (emoji: [{symbol, name}] to compare), "waiting" (you said they match;
  // the other side hasn't yet), "done" or "cancelled".
  // It also takes the next step itself where no one needs asking.
  verifications() {
    return this.lock(async () => {
      const { lib } = this, P = lib.VerificationRequestPhase, out = [];
      // (Ones that finished leave the library's list; they're kept here to say how they ended.)
      this.flows ??= new Map();
      for (const req of await this.machine.getVerificationRequests(new lib.UserId(this.device.user_id))) {
        if (req.isSelfVerification()) this.flows.set(req.flowId, req);
      }
      for (const req of this.flows.values()) {
        const phase = req.phase();
        let sas = req.getVerification?.();
        if (sas && !(sas instanceof lib.Sas)) sas = null;
        // We asked and they're ready: start comparing emoji. They started it: go along.
        if (phase === P.Ready && req.weStarted() && !sas) {
          const started = await req.startSas();
          if (started) { sas = started[0]; await this.send(started[1]); }
        }
        if (sas && !sas.weStarted() && !sas.hasBeenAccepted()) { const r = sas.accept(); if (r) await this.send(r); }
        const done = req.isDone() || sas?.isDone();
        if (done && !this.verified?.has(req.flowId)) await this.afterVerified(req.flowId);
        const emoji = sas?.emoji?.();
        out.push({
          id: req.flowId, by_us: req.weStarted(), other_device: req.otherDeviceId?.toString() ?? null,
          state: req.isCancelled() || sas?.isCancelled() ? "cancelled" : done ? "done"
            : sas?.haveWeConfirmed() ? "waiting" : emoji ? "compare"
            : phase === P.Requested || phase === P.Created ? "requested" : "ready",
          ...(emoji ? { emoji: emoji.map(e => ({ symbol: e.symbol, name: e.description })) } : {}),
        });
      }
      await this.flush();
      return out;
    });
  }

  // Accepting a request from another session; then the emoji match, or don't.
  acceptVerification(id) { return this.onRequest(id, async req => req.acceptWithMethods([this.lib.VerificationMethod.SasV1])); }
  confirmVerification(id) {
    return this.onRequest(id, async req => {
      const sas = req.getVerification?.();
      for (const r of sas ? await sas.confirm() : []) await this.send(r);
    });
  }
  cancelVerification(id) { return this.onRequest(id, async req => (req.getVerification?.() ?? req).cancel()); }
  onRequest(id, fn) {
    return this.lock(async () => {
      const req = await this.machine.getVerificationRequest(new this.lib.UserId(this.device.user_id), id);
      if (!req) throw new Error("that verification has gone; start again");
      const r = await fn(req);
      if (r) await this.send(r);
      await this.flush();
    });
  }

  // Verified with another session: ask it for the secrets a Security Key
  // would open (it answers once it trusts this one), and take them as they come.
  async afterVerified(id) {
    (this.verified ??= new Set()).add(id);
    await this.machine.requestMissingSecretsIfNeeded();
  }

  // Secrets your other sessions sent: the cross-signing keys (the library
  // takes those itself; then this session signs itself with them) and the
  // key backup's key.
  async takeSecrets() {
    const { lib } = this, me = this.device.user_id;
    const status = await this.machine.crossSigningStatus();
    if (status.hasSelfSigning && !this.signedSelf) {
      const device = await this.machine.getDevice(new lib.UserId(me), new lib.DeviceId(this.device.device_id));
      if (device && !device.isCrossSignedByOwner()) await this.send(await device.verify());
      this.signedSelf = true;
    }
    if (this.backup) return;
    const keys = await this.machine.getSecretsFromInbox("m.megolm_backup.v1");
    for (const secret of keys ?? []) {
      const key = lib.BackupDecryptionKey.fromBase64(secret);
      let info = null;
      try { info = (await this.ask("request", { method: "GET", path: "room_keys/version" })).response; } catch { /* no backup */ }
      if (info?.auth_data?.public_key !== key.megolmV1PublicKey.publicKeyBase64) continue;
      await this.machine.saveBackupDecryptionKey(key, info.version);
      await this.machine.enableBackupV1(info.auth_data.public_key, info.version);
      this.backup = { key, version: info.version };
      this.forgetMisses(); this.tried.clear();
    }
    await this.machine.deleteSecretsFromInbox("m.megolm_backup.v1");
  }

  // A room key from the backup, for one message this session missed.
  async fromBackup(event) {
    const { lib } = this, sid = event.content?.session_id;
    if (!this.backup || !sid || this.tried.has(sid)) return false;
    this.tried.add(sid);
    const { version, key } = this.backup, enc = encodeURIComponent;
    let got;
    try { got = (await this.ask("request", { method: "GET", path: `room_keys/keys/${enc(event.room_id)}/${enc(sid)}?version=${enc(version)}` })).response; }
    catch { return false; }
    const d = got?.session_data;
    if (!d) return false;
    const session = JSON.parse(key.decryptV1(d.ephemeral, d.mac, d.ciphertext));
    await this.machine.importBackedUpRoomKeys(new Map([[new lib.RoomId(event.room_id), new Map([[sid, session]])]]), () => {}, version);
    return true;
  }

  // New keys came in: what couldn't be read may be now. (What could stays read.)
  forgetMisses() {
    for (const [raw, c] of this.cache) if (!c) this.cache.delete(raw);
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
        if (items.length) { ack = items.at(-1).id; this.forgetMisses(); await this.takeSecrets(); }
        await this.flush();
        if (!items.length) break;
      }
    });
  }

  // Makes every request the library has waiting, until it has none.
  async flush() {
    for (let round = 0; round < 10; round++) {
      const reqs = await this.machine.outgoingRequests();
      // Room keys go into the backup too, once this session has its key.
      const backup = this.backup && await this.machine.backupRoomKeys();
      if (backup) reqs.push(backup);
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
    const event = JSON.parse(raw);
    const attempt = () => this.lock(async () => {
      try {
        const out = await this.machine.decryptRoomEvent(raw, new lib.RoomId(event.room_id), new lib.DecryptionSettings(lib.TrustRequirement.Untrusted));
        return JSON.parse(out.event).content ?? null;
      } catch { return null; }
    });
    content = await attempt();
    if (!content && await this.lock(() => this.fromBackup(event).catch(() => false))) content = await attempt();
    this.cache.set(raw, content);
    return content;
  }

  // Message content → the encrypted content to send to a room, after
  // making sure everyone's devices in it have the room's key.
  encrypt(roomId, content, type = "m.room.message") {
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
      const out = JSON.parse(await this.machine.encryptRoomEvent(new lib.RoomId(roomId), type, JSON.stringify(content)));
      // What an edit replaces, or a reaction is on, stays readable, as Matrix has it.
      if (content["m.relates_to"] && !out["m.relates_to"]) out["m.relates_to"] = content["m.relates_to"];
      return out;
    });
  }
}

// ── what this browser has already read ────────────────────────────────────
// Decrypting takes the crypto library, which is large to load, so what was
// read once is kept: event id → decrypted content, in IndexedDB, sealed with
// AES-GCM under a key made from the connection's own browser key (the same
// key that locks the library's store). A chat then opens with its messages
// already readable, and the library only has to read the new ones.
//
// rows: where the sealed rows go, {get(ids) → Map, put(id, value)}; left
// out, IndexedDB (and where there's none, nowhere: nothing is kept).

export class Shelf {
  constructor(aes, rows) { this.aes = aes; this.rows = rows; }

  static async open(hexKey, { name, rows } = {}) {
    const bytes = Uint8Array.from(hexKey.match(/../g), h => parseInt(h, 16));
    const ikm = await subtle().importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
    const aes = await subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("sintfoap-e2ee-read") },
      ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    return new Shelf(aes, rows ?? await idbRows(name));
  }

  // event ids → Map of the ones kept, to their decrypted content.
  async get(ids) {
    const out = new Map();
    if (!ids.length) return out;
    let rows;
    try { rows = await this.rows.get(ids); } catch { return out; }
    await Promise.all([...rows].map(async ([id, { iv, data }]) => {
      try { out.set(id, JSON.parse(new TextDecoder().decode(await subtle().decrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) }, this.aes, data)))); }
      catch { /* sealed under another key: skip it */ }
    }));
    return out;
  }

  async put(id, content) {
    if (!id || !content) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) },
      this.aes, new TextEncoder().encode(JSON.stringify(content))));
    try { await this.rows.put(id, { iv, data }); } catch { /* full, or private mode: it's only a shortcut */ }
  }
}

async function idbRows(name) {
  const none = { get: async () => new Map(), put: async () => {} };
  if (!name || !globalThis.indexedDB) return none;
  const db = await new Promise(resolve => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("read");
    req.onsuccess = () => resolve(req.result);
    req.onerror = req.onblocked = () => resolve(null);
  });
  if (!db) return none;
  const done = tx => new Promise((ok, fail) => { tx.oncomplete = () => ok(); tx.onerror = tx.onabort = () => fail(tx.error); });
  return {
    async get(ids) {
      const tx = db.transaction("read"), store = tx.objectStore("read"), out = new Map();
      for (const id of ids) { const r = store.get(id); r.onsuccess = () => { if (r.result) out.set(id, r.result); }; }
      await done(tx);
      return out;
    },
    async put(id, value) {
      const tx = db.transaction("read", "readwrite");
      tx.objectStore("read").put(value, id);
      await done(tx);
    },
  };
}

// Decrypted content → the text chat shows, as the site does for plain rooms
// (src/matrix.js): formatting as the Markdown it stands for.
export function textOf(content, senderName) {
  const c = content?.["m.new_content"] ?? content;
  const html = c?.format === "org.matrix.custom.html" && typeof c.formatted_body === "string" && fromHtml(c.formatted_body);
  const body = html || (typeof c?.body === "string" ? c.body : "");
  const kind = c?.msgtype;
  const out = kind === "m.emote" ? `* ${senderName} ${body}`
    : ["m.image", "m.file", "m.video", "m.audio"].includes(kind) ? `[${kind.slice(2)}] ${body}`
    : html ? body : body.replace(/^(> .*\n)+\n/, "");
  return out.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim();
}

export const textContent = messageContent;
export const reactionContent = (eventId, emoji) => ({ "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key: emoji } });
export { editContent };

// ── secret storage (what a Security Key opens) ────────────────────────────
// As the Matrix spec has it: m.secret_storage.v1.aes-hmac-sha2. Each secret
// is AES-CTR encrypted and HMAC-SHA-256 signed with keys derived (HKDF) from
// the storage key and the secret's name. A Security Key is that storage key
// written in base58; a Security Phrase makes it with PBKDF2.

const subtle = () => globalThis.crypto.subtle;
const b64 = s => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(s).length / 4) * 4, "=")), c => c.charCodeAt(0));
const unb64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=+$/, "");
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function fromBase58(text) {
  let n = 0n;
  for (const c of text) {
    const v = B58.indexOf(c);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of text) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}
function toBase58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}

// A storage key (32 bytes) → the Security Key Element shows: "EsT…" in groups of four.
export function encodeRecoveryKey(key) {
  const bytes = [0x8b, 0x01, ...key];
  bytes.push(bytes.reduce((a, b) => a ^ b, 0));
  return toBase58(Uint8Array.from(bytes)).match(/.{1,4}/g).join(" ");
}
function decodeRecoveryKey(text) {
  const bytes = fromBase58(text.replace(/\s+/g, ""));
  if (!bytes || bytes.length !== 35 || bytes[0] !== 0x8b || bytes[1] !== 0x01) return null;
  if (bytes.reduce((a, b) => a ^ b, 0) !== 0) return null;
  return bytes.slice(2, 34);
}

async function derive(key, name) {
  const ikm = await subtle().importKey("raw", key, "HKDF", false, ["deriveBits"]);
  const bits = new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode(name) }, ikm, 512));
  return {
    aes: await subtle().importKey("raw", bits.slice(0, 32), "AES-CTR", false, ["encrypt", "decrypt"]),
    hmac: await subtle().importKey("raw", bits.slice(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
  };
}

// plaintext (bytes) → {iv, ciphertext, mac}, as secret storage keeps them.
export async function encryptSecret(key, name, plaintext, iv = crypto.getRandomValues(new Uint8Array(16))) {
  iv = Uint8Array.from(iv); iv[8] &= 0x7f;
  const k = await derive(key, name);
  const data = typeof plaintext === "string" ? new TextEncoder().encode(plaintext) : plaintext;
  const ciphertext = new Uint8Array(await subtle().encrypt({ name: "AES-CTR", counter: iv, length: 64 }, k.aes, data));
  const mac = await subtle().sign("HMAC", k.hmac, ciphertext);
  return { iv: unb64(iv), ciphertext: unb64(ciphertext), mac: unb64(mac) };
}

async function decryptSecret(key, name, { iv, ciphertext, mac }) {
  const k = await derive(key, name);
  if (!await subtle().verify("HMAC", k.hmac, b64(mac), b64(ciphertext))) throw new Error(`${name} couldn't be opened with that key`);
  return new TextDecoder().decode(await subtle().decrypt({ name: "AES-CTR", counter: b64(iv), length: 64 }, k.aes, b64(ciphertext)));
}

// A Security Key or Phrase, and the storage key's description → the
// storage key, checked against the description.
async function storageKey(secret, desc) {
  if (desc.algorithm !== "m.secret_storage.v1.aes-hmac-sha2") throw new Error("this account's secret storage uses a kind of key the site doesn't know");
  let key = decodeRecoveryKey(String(secret));
  if (!key && desc.passphrase?.algorithm === "m.pbkdf2") {
    const p = desc.passphrase;
    const base = await subtle().importKey("raw", new TextEncoder().encode(String(secret)), "PBKDF2", false, ["deriveBits"]);
    key = new Uint8Array(await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-512", salt: new TextEncoder().encode(p.salt), iterations: p.iterations },
      base, p.bits ?? 256));
  }
  if (!key) throw new Error("that isn't a Security Key (it's 48 letters and numbers, in groups of four)");
  if (desc.iv && desc.mac) {
    const check = await encryptSecret(key, "", new Uint8Array(32), b64(desc.iv));
    if (check.mac.replace(/=+$/, "") !== String(desc.mac).replace(/=+$/, "")) throw new Error("that Security Key or Phrase isn't the right one for this account");
  }
  return key;
}
