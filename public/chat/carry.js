// Carrying a connection's encryption keys from one browser to another.
//
// The crypto library keeps a connection's device keys in this browser's
// IndexedDB (two databases, "<store>::matrix-sdk-crypto" and its "-meta"),
// with every value encrypted under the connection's browser key. pack()
// copies those databases as they are, into one gzipped text; unpack() lays
// them down again in another browser, which then opens them with the same
// browser key. The site keeps the latest copy, sealed, for whichever of your
// browsers takes the keys next (src/bridges.js).
//
// Both take the IndexedDB factory to use, so the tests can give them one of
// their own.

export const storeNames = store => [`${store}::matrix-sdk-crypto`, `${store}::matrix-sdk-crypto-meta`];

const asPromise = req => new Promise((ok, fail) => { req.onsuccess = () => ok(req.result); req.onerror = () => fail(req.error); });
const finished = tx => new Promise((ok, fail) => { tx.oncomplete = () => ok(); tx.onerror = tx.onabort = () => fail(tx.error ?? new Error("the copy of the keys didn't finish")); });

// Opens a database only if it's there (opening one that isn't would make it).
function openIfThere(idb, name) {
  return new Promise((ok, fail) => {
    const req = idb.open(name);
    let absent = false;
    req.onupgradeneeded = () => { absent = true; req.transaction.abort(); };
    req.onsuccess = () => ok(req.result);
    req.onerror = e => { if (absent) { e.preventDefault?.(); ok(null); } else fail(req.error); };
    req.onblocked = () => fail(new Error("the keys are open in another tab"));
  });
}

async function dumpDb(idb, name) {
  const db = await openIfThere(idb, name);
  if (!db) return null;
  try {
    const names = [...db.objectStoreNames];
    const out = { name, version: db.version, stores: [] };
    if (!names.length) return out;
    // One transaction over every store, so the copy is all of a moment.
    const tx = db.transaction(names, "readonly");
    const done = finished(tx);
    for (const s of names) {
      const store = tx.objectStore(s);
      const entry = {
        name: s, keyPath: store.keyPath, autoIncrement: store.autoIncrement,
        indexes: [...store.indexNames].map(i => { const ix = store.index(i); return { name: ix.name, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry }; }),
        records: [],
      };
      out.stores.push(entry);
      const req = store.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        entry.records.push(entry.keyPath == null ? [encode(c.primaryKey), encode(c.value)] : [null, encode(c.value)]);
        c.continue();
      };
    }
    await done;
    return out;
  } finally { db.close(); }
}

async function loadDb(idb, d) {
  await asPromise(idb.deleteDatabase(d.name));
  const db = await new Promise((ok, fail) => {
    const req = idb.open(d.name, d.version);
    req.onupgradeneeded = () => {
      for (const s of d.stores) {
        const store = req.result.createObjectStore(s.name, { keyPath: s.keyPath ?? undefined, autoIncrement: s.autoIncrement });
        for (const i of s.indexes) store.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry });
      }
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
    req.onblocked = () => fail(new Error("the keys are open in another tab"));
  });
  try {
    if (!d.stores.length) return;
    const tx = db.transaction(d.stores.map(s => s.name), "readwrite");
    const done = finished(tx);
    for (const s of d.stores) {
      const store = tx.objectStore(s.name);
      for (const [k, v] of s.records) s.keyPath == null ? store.put(decode(v), decode(k)) : store.put(decode(v));
    }
    await done;
  } finally { db.close(); }
}

// The keys' databases → one text (gzipped JSON, base64), or null when
// this browser has none.
export async function pack(idb, store) {
  const dbs = [];
  for (const name of storeNames(store)) {
    const d = await dumpDb(idb, name);
    if (d) dbs.push(d);
  }
  if (!dbs.length) return null;
  return toB64(await squeeze(new TextEncoder().encode(JSON.stringify({ v: 1, dbs })), "CompressionStream"));
}

// That text → the same databases here, replacing any already here.
export async function unpack(idb, store, text) {
  const { v, dbs } = JSON.parse(new TextDecoder().decode(await squeeze(fromB64(text), "DecompressionStream")));
  if (v !== 1 || !Array.isArray(dbs)) throw new Error("that copy of the keys is from a version this page doesn't know");
  const want = storeNames(store);
  for (const d of dbs) {
    // (Only ever this connection's own two.)
    if (!want.includes(d.name)) throw new Error("that copy of the keys is for something else");
    await loadDb(idb, d);
  }
}

// Takes this browser's copy of the keys away.
export async function forget(idb, store) {
  for (const name of storeNames(store)) await asPromise(idb.deleteDatabase(name)).catch(() => {});
}

async function squeeze(bytes, kind) {
  const stream = new Blob([bytes]).stream().pipeThrough(new globalThis[kind]("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// ── what IndexedDB holds, as JSON ────────────────────────────────────────
// Values are whatever the library stored: objects, arrays, text, numbers,
// and bytes. Anything JSON can't say is written {"$": kind, …}, and an
// object that happens to have a "$" of its own is wrapped so it isn't
// taken for one.

const VIEWS = { Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, Uint8ClampedArray };

export function encode(v) {
  if (v === undefined) return { $: "u" };
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : { $: "f", v: String(v) };
  if (typeof v === "bigint") return { $: "n", v: String(v) };
  if (v instanceof ArrayBuffer) return { $: "a", d: toB64(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) {
    const t = Object.keys(VIEWS).find(k => v instanceof VIEWS[k]);
    if (!t) throw new Error("the keys hold something that can't be copied");
    return { $: "v", t, d: toB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  }
  if (v instanceof Date) return { $: "d", v: v.getTime() };
  if (Array.isArray(v)) return v.map(encode);
  if (v instanceof Map) return { $: "m", e: [...v].map(([k, x]) => [encode(k), encode(x)]) };
  if (v instanceof Set) return { $: "s", e: [...v].map(encode) };
  if (typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = encode(x);
    return "$" in o ? { $: "o", o } : o;
  }
  throw new Error("the keys hold something that can't be copied");
}

export function decode(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(decode);
  const obj = o => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, decode(x)]));
  switch (v.$) {
    case undefined: return obj(v);
    case "u": return undefined;
    case "f": return Number(v.v);
    case "n": return BigInt(v.v);
    case "a": return fromB64(v.d).buffer;
    case "v": { const b = fromB64(v.d); return VIEWS[v.t] === Uint8Array ? b : new VIEWS[v.t](b.buffer); }
    case "d": return new Date(v.v);
    case "m": return new Map(v.e.map(([k, x]) => [decode(k), decode(x)]));
    case "s": return new Set(v.e.map(decode));
    case "o": return obj(v.o);
  }
  throw new Error("that copy of the keys has something this page doesn't know");
}
