// The phone app's small shared pieces: talking to the site, escaping, icons,
// the toast, and bottom sheets.

export const $ = (s, el = document) => el.querySelector(s);
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// Any of the site's JSON APIs, as the signed-in browser. A lost session goes
// back through sign-in and returns here.
export class Gone extends Error {}
export async function api(method, path, body) {
  const r = await fetch(path, {
    method, credentials: "same-origin", cache: "no-store", redirect: "manual",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.type === "opaqueredirect" || r.status === 401) { signIn(); throw new Gone("signed out"); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status} ${r.statusText}`);
  return r.json();
}
export const signIn = () => location.replace("/login?next=" + encodeURIComponent("/m/" + location.hash));

// 24×24 line icons.
const P = {
  home: '<path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z"/>',
  drift: '<rect x="4.5" y="4.5" width="15" height="15" rx="4"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  chat: '<path d="M5 6.5A1.5 1.5 0 0 1 6.5 5h11A1.5 1.5 0 0 1 19 6.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4 3.5V16h.5"/>',
  more: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  send: '<path d="M5 12h12M12 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m6 12.5 4 4 8-9"/>',
  cal: '<rect x="4" y="5.5" width="16" height="14" rx="3"/><path d="M4 10h16M9 3.5v4M15 3.5v4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  left: '<path d="M14 7l-5 5 5 5"/>',
  right: '<path d="M10 7l5 5-5 5"/>',
  up: '<path d="M7 14l5-5 5 5"/>',
  down: '<path d="M7 10l5 5 5-5"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  out: '<path d="M14 5h5v14h-5M10 8l-4 4 4 4M6 12h9"/>',
  link: '<path d="M14 5h5v5M19 5l-8 8M17 14v5H5V7h5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  note: '<path d="M6 4h9l3 3v13H6z"/><path d="M9 11h6M9 15h4"/>',
  pin: '<path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.3"/>',
};
export const icon = (name, size = 22) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ""}</svg>`;

// A short note at the bottom of the screen, with an optional Undo.
let toastTimer;
export function toast(text, undo) {
  const t = $("#toast");
  t.innerHTML = `<span>${esc(text)}</span>${undo ? `<button type="button">Undo</button>` : ""}`;
  t.hidden = false;
  if (undo) t.querySelector("button").onclick = () => { t.hidden = true; undo(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, undo ? 5000 : 2600);
}
export const failed = e => { if (!(e instanceof Gone)) toast(e.message === "Failed to fetch" ? "Couldn't reach the site." : e.message); };

// A sheet that slides up from the bottom. Returns the <dialog>; it removes
// itself when closed. Tapping outside the sheet closes it.
export function sheet(html, { onClose } = {}) {
  const d = document.createElement("dialog");
  d.className = "sheet";
  // Focus the sheet itself, not its first field: no keyboard popping up until you tap one.
  d.tabIndex = -1;
  d.innerHTML = `<div class="grab" aria-hidden="true"></div>${html}`;
  document.body.append(d);
  d.addEventListener("click", e => { if (e.target === d) d.close(); });
  d.addEventListener("close", () => { d.remove(); onClose?.(); });
  d.showModal();
  d.focus();
  return d;
}

// Relative times for lists: "now", "5m", "3h", "Tue", "Nov 2".
export function ago(sec) {
  const s = Date.now() / 1000 - sec;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  const d = new Date(sec * 1000);
  if (s < 6 * 86400) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Runs fn every `ms` while the app is on screen, and once when it comes back.
export function every(ms, fn) {
  const tick = () => { if (!document.hidden) fn(); };
  const id = setInterval(tick, ms);
  document.addEventListener("visibilitychange", tick);
  return () => { clearInterval(id); document.removeEventListener("visibilitychange", tick); };
}
