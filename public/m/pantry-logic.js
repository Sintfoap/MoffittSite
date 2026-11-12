// Pantry's scanner in the phone app (pantry.js): the lines being checked
// before they go in the pantry, without the screens, so the tests can run them
// (tests/phone-app.test.mjs). Shaped like the site's receipt lines
// (src/pantry_receipt.js), and the same as the Android scanner app's
// (scanner/.../Lines.kt), so both send the same thing to /pantry/api/add.

export const LEVELS = ["Empty", "Almost out", "¼ left", "½ left", "¾ left", "Full"];
export const KINDS = [["", "Guess"], ["measured", "Measured"], ["counted", "Counted"], ["gauged", "Gauged"]];
export const HOW = { remembered: "remembered from this store", name: "matched by name", barcode: "known barcode" };

const key = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-6);

// A line: what it adds to (target: an item's id, or "" for new), how much, and when it expires.
export function blank(over = {}) {
  return {
    key: key(), store: "", printed: "", barcode: "", name: "", brand: "", target: "", how: "",
    kind: "", staple: false, place: "", unit: "", size: "", low: "", lowLevel: null,
    amount: "", each: "", expires: "", expiresBy: "", level: null, on: true, skip: false, error: "", ...over,
  };
}

export const isNew = l => !l.target;
export const title = l => (l.name || "").trim() || (l.printed || "").trim() || "Something unnamed";

// A proposal from the site (a receipt's line, or a barcode's).
export function fromProposal(p, { store = "", barcode = "", brand = "" } = {}) {
  const m = p.match || null, n = p.new || {};
  return blank({
    store, printed: p.printed || "", barcode, brand, name: p.name || "",
    target: m?.id || "", how: m?.how || "",
    kind: n.kind === "staple" ? "measured" : n.kind || "", place: n.place || "", unit: n.unit || "", size: n.size ?? p.size ?? "",
    amount: p.amount || "", each: p.amount || "", expires: p.expires || "", expiresBy: p.expires_by || "",
    on: !p.skip, skip: !!p.skip,
  });
}

// What a barcode lookup (GET /pantry/api/barcode/<code>) adds: what it's known as, or a line to name.
export function fromBarcode(code, out) {
  if (out?.product && out.line) {
    const l = fromProposal(out.line, { barcode: code, brand: out.product.brand || "" });
    l.size = out.product.size || out.line.new?.size || "";
    return l;
  }
  return blank({ barcode: code, amount: "1", each: "1" });   // nobody knows it: you name it, once
}

// As the site's /pantry/api/add takes it.
export function toSend(l) {
  const o = { key: l.key, printed: l.printed, amount: l.amount, expires: l.expires, expires_by: l.expires ? l.expiresBy : "" };
  if (l.level != null) o.level = l.level;
  if (l.barcode) Object.assign(o, { barcode: l.barcode, size: l.size, brand: l.brand });
  if (!isNew(l)) return { ...o, item: l.target, name: l.name };
  Object.assign(o, { name: l.name, kind: l.kind, place: l.place, unit: l.unit, size: l.size, staple: l.staple });
  if (l.staple) o.low = l.kind === "gauged" ? (l.lowLevel ?? 1) : l.low;
  return o;
}

// One more of the same thing: "10 lb" and "10 lb" make "20 lb"; "2" and "1" make "3". Otherwise as it was.
export function bump(amount, each) {
  const re = /^\s*(\d+(?:\.\d+)?)\s*(.*)$/;
  const a = re.exec(amount || ""), b = re.exec(each || "");
  if (!a || !b || a[2].trim().toLowerCase() !== b[2].trim().toLowerCase()) return amount;
  const n = Math.round((+a[1] + +b[1]) * 1000) / 1000;
  return `${n} ${a[2].trim()}`.trim();
}

// A barcode the camera read, one more of what's in the basket, or new to look up.
// → {lines, again: the line it added one more to} or {lines, look: the code to look up} or null (not a barcode).
export function scan(lines, raw) {
  const code = sameBarcode(raw);
  if (!isBarcode(code)) return null;
  const i = lines.findLastIndex(l => l.barcode === code);
  if (i < 0) return { lines, look: code };
  const l = { ...lines[i], amount: bump(lines[i].amount, lines[i].each || "1"), error: "" };
  return { lines: lines.with(i, l), again: l };
}

// iOS and some readers give a UPC-A as 13 digits with a 0 in front; Android (and the site's memory
// of your barcodes) has the 12. One product, one code.
export function sameBarcode(raw) {
  const code = String(raw ?? "").trim();
  return /^0\d{12}$/.test(code) ? code.slice(1) : code;
}
export const isBarcode = code => /^\d{6,14}$/.test(code);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// 2026-12-09 → "Dec 9" (with the year when it isn't this one).
export function nice(day, today = localDay()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
  if (!m) return day;
  return `${MONTHS[+m[2] - 1]} ${+m[3]}` + (m[1] !== today.slice(0, 4) ? `, ${m[1]}` : "");
}
export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const plusDays = (day, n) => { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Whether an estimated date is close enough that the real one is worth checking (milk, meat, bread).
export function dateMatters(l, today = localDay()) {
  return l.expiresBy === "estimated" && /^\d{4}-\d{2}-\d{2}$/.test(l.expires) && l.expires < plusDays(today, 31);
}

// What the site said to an add, for the lines sent: the ones it took go, the rest keep its reason.
export function afterAdd(lines, sent, out) {
  const why = new Map((out.failed || []).map(f => [f.key, f.error]));
  const sentKeys = new Set(sent.map(l => l.key));
  return lines.filter(l => !sentKeys.has(l.key) || why.has(l.key)).map(l => why.has(l.key) ? { ...l, error: why.get(l.key) } : l);
}

// "Added 2: Flour, Eggs. Ticked off your shopping list: eggs. 1 still needs a fix."
export function addedLine(outs, left) {
  const added = outs.flatMap(o => (o.added || []).map(a => a.name));
  const ticked = outs.flatMap(o => (o.ticked || []).map(t => t.title));
  const fixes = left.filter(l => l.error).length;
  return [
    added.length ? `Added ${added.length}: ${added.join(", ")}.` : "",
    ticked.length ? `Ticked off your shopping list: ${ticked.join(", ")}.` : "",
    fixes ? `${fixes} still need${fixes === 1 ? "s" : ""} a fix.` : "",
  ].filter(Boolean).join(" ");
}

// The lines to send, a batch per store (a receipt's store remembers its abbreviations).
export function batches(lines) {
  const out = new Map();
  for (const l of lines.filter(l => l.on)) {
    if (!out.has(l.store)) out.set(l.store, []);
    out.get(l.store).push(l);
  }
  return [...out].map(([store, ls]) => ({ store, lines: ls }));
}

// A line that can't go yet: a new barcode nobody has named.
export const unnamed = lines => lines.find(l => l.on && isNew(l) && !(l.name || "").trim()) || null;
