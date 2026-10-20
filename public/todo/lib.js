// Small helpers shared by the page and the plugins. Nothing here touches the
// DOM, so the Worker can import the plugins (for their clean() rules) too.

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const icon = (p, s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" aria-hidden="true">${p}</svg>`;

// ── dates: plain "YYYY-MM-DD" and "YYYY-MM-DDTHH:MM" strings in the viewer's own time
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
export const nowStamp = () => new Date().toISOString().slice(0, 19);
export const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const today = () => iso(new Date());
export const addDays = (n, from) => { const d = from ? new Date(from + "T00:00") : new Date(); d.setDate(d.getDate() + n); return iso(d); };
export const dayOf = s => String(s || "").slice(0, 10);
export const timeOf = s => (String(s || "").split("T")[1] || "");

const WD = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export function parseDate(s) {
  s = String(s || "").trim().toLowerCase(); if (!s) return null;
  if (["tod", "today", "now"].includes(s)) return today();
  if (["tom", "tmr", "tomorrow"].includes(s)) return addDays(1);
  if (["week", "nextweek", "next-week"].includes(s)) { const d = new Date().getDay(); return addDays(((8 - d) % 7) || 7); }
  let m = s.match(/^\+?(\d+)([dw])$/); if (m) return addDays(+m[1] * (m[2] === "w" ? 7 : 1));
  const wi = WD.findIndex(w => s.length >= 3 && w.startsWith(s.slice(0, 3)));
  if (wi >= 0) { const d = new Date().getDay(); return addDays(((wi - d + 7) % 7) || 7); }
  if (DATE.test(s)) return s;
  m = s.match(/^(\d{1,2})[\/-](\d{1,2})$/);
  if (m) { const y = new Date().getFullYear(); let d = new Date(y, m[1] - 1, m[2]); if (iso(d) < today()) d = new Date(y + 1, m[1] - 1, m[2]); return iso(d); }
  return null;
}
// "9", "9:30", "930", "3pm", "3:15pm", "15:00" → "HH:MM"
export function parseTime(s) {
  const m = String(s || "").trim().toLowerCase().match(/^(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let h = +m[1]; const min = +(m[2] || 0);
  if (m[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (m[3][0] === "p" ? 12 : 0); }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// ── places: a what3words address is three words joined by dots ("filled.count.soap").
// Takes it as people paste it: "///filled.count.soap", "filled count soap" or a
// what3words.com / w3w.co link. Gives the bare lowercase words, or null.
const W3W = /^\p{L}[\p{L}\p{M}]*\.\p{L}[\p{L}\p{M}]*\.\p{L}[\p{L}\p{M}]*$/u;
export function parseWords(s) {
  let w = String(s ?? "").trim().toLowerCase();
  const link = w.match(/^(?:https?:\/\/)?(?:www\.)?(?:what3words\.com|w3w\.co)\/([^?#\s]+)/);
  if (link) { try { w = decodeURIComponent(link[1]); } catch { return null; } }
  w = w.replace(/^\/+/, "").replace(/[\s｡。・]+/g, ".");
  return w.length <= 100 && W3W.test(w) ? w : null;
}

// Quick-add: "Call Sam #family +home !2 ^fri @3pm ///filled.count.soap"
//   #tag   +collection   !1..!3 priority   ^date   @time   ///what3words
export function parseQuick(text) {
  const f = {}, tags = [], words = [];
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    if (w.length > 1 && w[0] === "#") tags.push(w.slice(1).toLowerCase());
    else if (w.length > 1 && w[0] === "+") f.collection = w.slice(1);
    else if (/^(!{1,3}|![0-3])$/.test(w)) f.priority = /\d/.test(w[1]) ? +w[1] : w.length;
    else if (w.length > 1 && w[0] === "^" && parseDate(w.slice(1))) f.date = parseDate(w.slice(1));
    else if (w.length > 1 && w[0] === "@" && parseTime(w.slice(1))) f.time = parseTime(w.slice(1));
    else if (w.startsWith("///") && parseWords(w)) f.location = parseWords(w);
    else words.push(w);
  }
  if (tags.length) f.tags = tags;
  return [words.join(" "), f];
}

export function niceDay(d) {
  if (!d) return "";
  const a = new Date(d + "T00:00"), b = new Date(today() + "T00:00");
  const n = Math.round((a - b) / 864e5);
  if (n === 0) return "Today"; if (n === 1) return "Tomorrow"; if (n === -1) return "Yesterday";
  if (n < 0 && n > -7) return `${-n} days ago`;
  if (n > 0 && n < 7) return a.toLocaleDateString(undefined, { weekday: "long" });
  return a.toLocaleDateString(undefined, { month: "short", day: "numeric", year: a.getFullYear() !== b.getFullYear() ? "numeric" : undefined });
}
export function niceTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: "numeric", minute: m ? "2-digit" : undefined });
}
