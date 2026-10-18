// End-to-end encryption in Matrix rooms, for real: the chat page's vault
// (public/chat/e2ee.js) with Matrix's crypto library, through the site, to a
// stand-in homeserver (tests/fake-matrix.mjs), and Sam on the other side with
// the same library talking to the homeserver directly, as Element would.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Browser, makeEnv, grantApps, sqlOne } from "./helpers.mjs";
import { FakeMatrix } from "./fake-matrix.mjs";
import * as lib from "../public/chat/vendor/matrix-crypto/node.mjs";
import { Vault, textOf, textContent, editContent, reactionContent, encryptSecret, encodeRecoveryKey } from "../public/chat/e2ee.js";

const ROOM = "!secret:matrix.test";
let hs;
afterEach(() => hs?.uninstall());

const api = (b, method, path, json) => b.req(method, "/chat/api" + path, json === undefined ? {} : { json });
const hexKey = c => c.repeat(64);
// (Polling syncs at most every few seconds; the tests don't wait.)
const syncNow = (b, conn) => api(b, "POST", `/connections/${conn.id}/sync`);

async function setup() {
  hs = new FakeMatrix().install();
  hs.room(ROOM, { name: "Secrets", encrypted: true, members: { "@ryan:matrix.test": "Ryan", "@sam:matrix.test": "Sam" } });
  const env = makeEnv({ CHAT_BRIDGE_KEY: "test-bridge-key-0123456789abcdef" });
  const ryan = new Browser(env);
  assert.equal((await ryan.signup("ryan")).status, 303);
  grantApps(env, "ryan", "chat", "chat-bridges");
  const conn = (await api(ryan, "POST", "/connections", { provider: "matrix", homeserver: "matrix.test", username: "ryan", password: "hunter22hunter22" })).json;
  return { env, ryan, conn };
}

// The chat page's side: the vault, posting to the site's crypto routes.
const siteVault = (b, conn, key = hexKey("a")) => Vault.open(lib, {
  key,
  post: async (op, body) => {
    const r = await api(b, "POST", `/connections/${conn.id}/crypto/${op}`, body);
    if (r.status !== 200) throw Object.assign(new Error(r.json.error), { status: r.status });
    return r.json;
  },
});

// Someone on their own device (Sam, or Ryan's Element), syncing straight
// from the homeserver.
async function onMatrix(user = "@sam:matrix.test", device = "SAMDEV", token = "syt_sam") {
  const who = hs.person(user, device, token);
  let since = null, n = 0;
  const timeline = [];
  const call = async (method, path, body) => {
    const [p, q] = path.split("?");
    const res = await hs.handle(new Request(`https://hs.matrix.test/_matrix/client/v3/${p}${q ? "?" + q : ""}`, {
      method, headers: { Authorization: `Bearer ${who.token}`, "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    }));
    return res.json();
  };
  const vault = await Vault.open(lib, { key: hexKey("5"), post: async (op, body) => {
    if (op === "claim") return { device: { user_id: who.user, device_id: who.device } };
    if (op === "request") return { response: await call(body.method, body.path, body.body) };
    // inbox: a sync of his own.
    const s = hs.sync(since, who);
    since = s.next_batch;
    for (const [room, r] of Object.entries(s.rooms.join)) for (const e of r.timeline.events) timeline.push({ ...e, room_id: room });
    const counts = { otk_counts: s.device_one_time_keys_count ?? {}, fallback: s.device_unused_fallback_key_types ?? [] };
    const item = { id: ++n, to_device: s.to_device?.events ?? [], changed: s.device_lists?.changed ?? [], left: [] };
    return { items: item.to_device.length || item.changed.length ? [item] : [], counts };
  } });
  const say = async (content, type) => {
    const enc = await vault.encrypt(ROOM, content, type);
    return (await call("PUT", `rooms/${encodeURIComponent(ROOM)}/send/m.room.encrypted/t${++n}`, enc)).event_id;
  };
  // What Sam's Element shows: each message's text, edits applied.
  const read = async () => {
    await vault.pump();
    const shown = new Map();
    for (const e of timeline.filter(e => e.type === "m.room.encrypted")) {
      const c = await vault.decrypt(JSON.stringify(e));
      const rel = e.content["m.relates_to"];
      if (rel?.rel_type === "m.replace") { if (shown.has(rel.event_id)) shown.set(rel.event_id, textOf(c)); }
      else shown.set(e.event_id, c ? textOf(c) : null);
    }
    return [...shown.values()];
  };
  return { vault, say, read, call };
}
const samOnMatrix = () => onMatrix();

test("an encrypted room can be read and written from the chat page, and the site never sees the words", async () => {
  const { env, ryan, conn } = await setup();
  assert.equal(conn.can_encrypt, true, "a password sign-in has a session of its own to hold keys");
  assert.equal(conn.keys_held, false);
  const ryanVault = await siteVault(ryan, conn);
  assert.ok(hs.keys.get("@ryan:matrix.test|SITE")?.device_keys, "the browser uploaded the site session's keys");
  assert.equal((await api(ryan, "GET", "/connections")).json[0].keys_held, true);

  const sam = await samOnMatrix();
  await sam.say(textContent("the door code is 4471"));

  // Ryan's page polls; the sync it runs brings Sam's message and the room key for it.
  await syncNow(ryan, conn);
  const room = (await api(ryan, "GET", "/state")).json.rooms.find(r => r.encrypted);
  assert.equal(room.keys_held, true);
  const msgs = (await api(ryan, "GET", `/rooms/${room.id}/messages`)).json.messages;
  await ryanVault.pump();
  assert.equal(msgs.length, 1);
  assert.equal(textOf(await ryanVault.decrypt(msgs[0].raw)), "the door code is 4471");
  assert.equal(msgs[0].author_name, "Sam");

  // Ryan answers: encrypted here, so the site only passes on ciphertext.
  const sent = await api(ryan, "POST", `/rooms/${room.id}/messages`, { encrypted: await ryanVault.encrypt(ROOM, textContent("got it, thanks")) });
  assert.equal(sent.status, 201);
  assert.equal(sent.json.mine, true);
  assert.equal(textOf(await ryanVault.decrypt(sent.json.raw)), "got it, thanks", "your own messages read back too");
  assert.deepEqual(await sam.read(), ["the door code is 4471", "got it, thanks"]);

  // Ryan edits it, encrypted too; Sam sees the new words.
  const edited = await api(ryan, "PATCH", `/rooms/${room.id}/messages/${sent.json.id}`,
    { encrypted: await ryanVault.encrypt(ROOM, editContent(sent.json.ext_id, "got it, see you at 6")) });
  assert.equal(edited.status, 200);
  assert.ok(edited.json.edited_at);
  assert.equal(textOf(await ryanVault.decrypt(edited.json.raw)), "got it, see you at 6");
  assert.deepEqual(await sam.read(), ["the door code is 4471", "got it, see you at 6"]);

  // Sam edits his; Ryan's page shows the edit.
  const samFirst = JSON.parse(msgs[0].raw).event_id;
  await sam.say(editContent(samFirst, "the door code is 4472"));
  await syncNow(ryan, conn);
  const after = (await api(ryan, "GET", `/rooms/${room.id}/messages`)).json.messages;
  await ryanVault.pump();
  const his = after.find(m => m.ext_id === samFirst);
  assert.ok(his.edited_at);
  assert.equal(textOf(await ryanVault.decrypt(his.raw)), "the door code is 4472");

  // Nowhere on the site or the homeserver is there a word of it in the clear.
  const everything = JSON.stringify(hs.events) + JSON.stringify(sqlOne(env, "SELECT group_concat(body || COALESCE(ext_raw, ''), '|') AS all_text FROM chat_messages"));
  for (const words of ["door code", "got it"]) assert.ok(!everything.includes(words), `"${words}" was seen in the clear`);
});

test("one browser holds a connection's keys; others are told where they are", async () => {
  const { ryan, conn } = await setup();
  await siteVault(ryan, conn);
  await assert.rejects(siteVault(ryan, conn, hexKey("b")), /another browser holds/);
  // The same browser comes back fine.
  await siteVault(ryan, conn);
  // The key requests passed on are only the ones encryption needs.
  const r = await api(ryan, "POST", `/connections/${conn.id}/crypto/request`, { key: hexKey("a"), method: "GET", path: "account/whoami" });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /isn't one the encryption needs/);
  const theirs = await api(ryan, "POST", `/connections/${conn.id}/crypto/request`,
    { key: hexKey("a"), method: "GET", path: `user/${encodeURIComponent("@sam:matrix.test")}/account_data/m.megolm_backup.v1` });
  assert.equal(theirs.status, 403, "only your own account's secrets");
  const bad = await api(ryan, "POST", `/connections/${conn.id}/crypto/inbox`, { key: "nope" });
  assert.equal(bad.status, 400);
});

test("plain text can't be sent to an encrypted room, and encrypted content only goes to one", async () => {
  const { ryan } = await setup();
  const room = (await api(ryan, "GET", "/state")).json.rooms.find(r => r.encrypted);
  const plain = await api(ryan, "POST", `/rooms/${room.id}/messages`, { body: "hello" });
  assert.equal(plain.status, 403);
  assert.match(plain.json.error, /browser that holds its keys/);
  const mine = await api(ryan, "POST", "/rooms", { name: "Plain" });
  const r = await api(ryan, "POST", `/rooms/${mine.json.id}/messages`, { encrypted: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "x" } });
  assert.equal(r.status, 400);
});

test("a Security Key verifies the site's session, and older messages come from the key backup", async () => {
  const { ryan, conn } = await setup();
  const me = "@ryan:matrix.test";
  // Ryan's Element, set up the way Element does it: cross-signing, a key
  // backup, and both kept in secret storage under a Security Key (made from
  // a Security Phrase).
  const element = await onMatrix(me, "ELEMENT", "syt_element");
  const boot = await element.vault.machine.bootstrapCrossSigning(true);
  if (boot.uploadKeysRequest) await element.vault.send(boot.uploadKeysRequest);
  await element.call("POST", "keys/device_signing/upload", JSON.parse(boot.uploadSigningKeysRequest.body));
  await element.vault.send(boot.uploadSignaturesRequest);
  const exported = await element.vault.machine.exportCrossSigningKeys();
  const backupKey = lib.BackupDecryptionKey.createRandomKey();
  const pub = backupKey.megolmV1PublicKey.publicKeyBase64;
  const { version } = await element.call("POST", "room_keys/version", { algorithm: "m.megolm_backup.v1.curve25519-aes-sha2", auth_data: { public_key: pub } });
  await element.vault.machine.enableBackupV1(pub, version);
  element.vault.backup = { key: backupKey, version };

  const phrase = "correct horse battery staple", salt = "saltysalt";
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(phrase), "PBKDF2", false, ["deriveBits"]);
  const ssss = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-512", salt: new TextEncoder().encode(salt), iterations: 1000 }, base, 256));
  const check = await encryptSecret(ssss, "", new Uint8Array(32));
  hs.setAccountData(me, "m.secret_storage.default_key", { key: "k1" });
  hs.setAccountData(me, "m.secret_storage.key.k1", { algorithm: "m.secret_storage.v1.aes-hmac-sha2", iv: check.iv, mac: check.mac,
    passphrase: { algorithm: "m.pbkdf2", salt, iterations: 1000 } });
  for (const [name, value] of [["m.cross_signing.master", exported.masterKey], ["m.cross_signing.self_signing", exported.self_signing_key],
    ["m.cross_signing.user_signing", exported.userSigningKey], ["m.megolm_backup.v1", backupKey.toBase64()]]) {
    hs.setAccountData(me, name, { encrypted: { k1: await encryptSecret(ssss, name, value) } });
  }

  // Sam writes before the site has keys: only Element gets the room key, and backs it up.
  const sam = await samOnMatrix();
  await sam.say(textContent("from before the site"));
  await element.vault.pump();
  assert.equal(Object.keys(hs.backups[0].rooms[ROOM] ?? {}).length, 1, "Element backed the room key up");

  const vault = await siteVault(ryan, conn);
  await syncNow(ryan, conn);
  const room = (await api(ryan, "GET", "/state")).json.rooms.find(r => r.encrypted);
  const [old] = (await api(ryan, "GET", `/rooms/${room.id}/messages`)).json.messages;
  assert.equal(await vault.decrypt(old.raw), null, "nothing to read it with yet");
  assert.deepEqual(await vault.status(), { verified: false, backup: false });

  await assert.rejects(vault.unlock("not a key at all"), /isn't the right one/);
  await assert.rejects(vault.unlock(encodeRecoveryKey(crypto.getRandomValues(new Uint8Array(32)))), /isn't the right one/);
  // The Security Key Element shows, or the phrase it was made from: either works.
  assert.match(encodeRecoveryKey(ssss), /^Es\w{2}( \w{4}){11}$/);
  assert.deepEqual(await vault.unlock(phrase), { verified: true, backup: true });
  assert.deepEqual(await vault.unlock(encodeRecoveryKey(ssss)), { verified: true, backup: true });

  // The old message reads now, its key fetched from the backup.
  assert.equal(textOf(await vault.decrypt(old.raw)), "from before the site");
  // The site's session is signed with Ryan's self-signing key, so Element sees it as verified.
  const ssk = Object.keys(hs.signing.get(me).self_signing_key.keys)[0];
  assert.ok(hs.keys.get(`${me}|SITE`).device_keys.signatures[me][ssk], "signed by the self-signing key");
  await element.vault.pump();
  await element.vault.machine.updateTrackedUsers([new lib.UserId(me)]);
  await element.vault.flush();
  const seen = await element.vault.machine.getDevice(new lib.UserId(me), new lib.DeviceId("SITE"));
  assert.ok(seen.isCrossSignedByOwner(), "Element sees the site's session as verified");

  // And keys for what's sent from now on go into the backup too.
  await api(ryan, "POST", `/rooms/${room.id}/messages`, { encrypted: await vault.encrypt(ROOM, textContent("backed up")) });
  await vault.pump();
  assert.equal(Object.keys(hs.backups[0].rooms[ROOM]).length, 2, "the site's own room key went into the backup");
});

test("reactions in an encrypted room are encrypted too, and go both ways", async () => {
  const { ryan, conn } = await setup();
  const vault = await siteVault(ryan, conn);
  const sam = await samOnMatrix();
  const first = await sam.say(textContent("pizza tonight?"));
  await sam.say(reactionContent(first, "🍕"), "m.reaction");
  await syncNow(ryan, conn);
  const room = (await api(ryan, "GET", "/state")).json.rooms.find(r => r.encrypted);
  const [m] = (await api(ryan, "GET", `/rooms/${room.id}/messages`)).json.messages;
  assert.deepEqual(m.reactions.map(r => [r.emoji, r.names]), [["🍕", "Sam"]], "what a reaction is on, and its emoji, are outside the encryption");

  // From here it needs the browser to encrypt it, as Element does.
  const plain = await api(ryan, "POST", `/rooms/${room.id}/messages/${m.id}/reactions`, { emoji: "👍", on: true });
  assert.equal(plain.status, 403);
  assert.match(plain.json.error, /browser that holds its keys/);
  const mismatched = await vault.encrypt(ROOM, reactionContent(m.ext_id, "🎉"), "m.reaction");
  assert.equal((await api(ryan, "POST", `/rooms/${room.id}/messages/${m.id}/reactions`, { emoji: "👍", on: true, encrypted: mismatched })).status, 400);
  const out = await api(ryan, "POST", `/rooms/${room.id}/messages/${m.id}/reactions`,
    { emoji: "👍", on: true, encrypted: await vault.encrypt(ROOM, reactionContent(m.ext_id, "👍"), "m.reaction") });
  assert.equal(out.status, 200);
  assert.deepEqual(out.json.reactions.map(r => [r.emoji, r.mine]), [["🍕", false], ["👍", true]]);
  const sent = hs.events.at(-1).event;
  assert.equal(sent.type, "m.room.encrypted", "sent encrypted");
  assert.deepEqual(sent.content["m.relates_to"], { rel_type: "m.annotation", event_id: m.ext_id, key: "👍" });
  await sam.read();
  // Taking it back is a redaction, which isn't encrypted, so it needs no keys.
  await api(ryan, "POST", `/rooms/${room.id}/messages/${m.id}/reactions`, { emoji: "👍", on: false });
  assert.equal(hs.events.at(-1).event.type, "m.room.redaction");
});
