// The phone app: its own screens for sintfoap.xyz, made for a phone rather
// than shrunk from the desktop pages. It reads and writes through the same
// APIs as the web pages and the terminal (cli/), so everything stays in sync.
//
//   #home              your day: Drift's today and chat rooms with something new
//   #drift[/<view>]    Drift: today, calendar, or a collection (drift.js)
//   #chat[/<room id>]  Chat: the room list, or one room (chat.js)
//   #more              your account, and the rest of the site
//
// Tabs only appear for the apps the admin page has turned on for you (the
// dashboard's menu, src/nav.js), as on the web and in the terminal.

import { $, esc, api, icon, toast, failed, plural, Gone, ago } from "./ui.js";

export const app = { dash: null, has: new Set(), screen: null };

const TABS = [
  { id: "home", label: "Home", icon: "home" },
  { id: "drift", label: "Drift", icon: "drift" },
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "more", label: "More", icon: "more" },
];
const SCREENS = { home: () => ({ show: showHome }), more: () => ({ show: showMore }), drift: () => import("./drift.js"), chat: () => import("./chat.js") };

function drawTabs(on) {
  $("#tabs").innerHTML = TABS.filter(t => t.id === "home" || t.id === "more" || app.has.has(t.id)).map(t =>
    `<a href="#${t.id}" class="tab" ${t.id === on ? 'aria-current="page"' : ""}>${icon(t.icon)}<span>${t.label}</span>${t.id === "chat" ? `<b class="badge" id="chatBadge" hidden></b>` : ""}</a>`).join("");
  updateChatBadge();
}
export function updateChatBadge(n = app.chatUnread || 0) {
  app.chatUnread = n;
  const b = $("#chatBadge");
  if (b) { b.hidden = !n; b.textContent = n > 99 ? "99+" : n; }
}

let current = null, entering;
async function route() {
  const [tab, ...rest] = (location.hash.slice(1) || "home").split("/");
  const id = SCREENS[tab] && (tab === "home" || tab === "more" || app.has.has(tab)) ? tab : "home";
  drawTabs(id);
  current?.hide?.();
  const main = $("#main");
  main.scrollTop = 0;
  document.body.dataset.screen = id;
  document.body.classList.remove("focus");
  // The new screen eases in; redraws within a screen don't.
  main.classList.add("enter");
  clearTimeout(entering);
  entering = setTimeout(() => main.classList.remove("enter"), 400);
  try {
    current = await SCREENS[id]();
    await current.show(main, rest.map(decodeURIComponent), app);
  } catch (e) { failed(e); }
}

// The Android app (android/, src/phone.js) opens /m/?app=<its version>. Kept,
// so the app can say when a newer APK is out.
const APP_KEY = "m:apk-version";
function apkVersion() {
  const q = new URLSearchParams(location.search).get("app");
  try {
    if (/^\d{1,6}$/.test(q || "")) { localStorage.setItem(APP_KEY, q); history.replaceState(null, "", "/m/" + location.hash); }
    return +localStorage.getItem(APP_KEY) || null;
  } catch { return /^\d{1,6}$/.test(q || "") ? +q : null; }
}
async function checkForUpdate() {
  app.apk = apkVersion();
  if (!app.apk) return;
  try {
    const latest = await api("GET", "/app/latest.json");
    if (latest.version > app.apk) { app.update = latest; showUpdate(); }
  } catch {}
}
function showUpdate() {
  const u = app.update, el = $("#update");
  if (!u || !el) return;
  el.innerHTML = `<a class="card nudge update" href="${esc(u.url)}"><b>A new version of the app is ready</b>
    <span>Version ${u.version}. Tap to download it, then open the download to install it over this one. Your data stays put.</span></a>`;
}

// How big the whole app is drawn (More → Size). Kept on this phone only.
const SIZE_KEY = "m:size";
export const SIZES = [["Small", 1], ["Medium", 1.2], ["Large", 1.35], ["Huge", 1.5]];
function appSize() { try { return +localStorage.getItem(SIZE_KEY) || 1.2; } catch { return 1.2; } }
function setSize(z) {
  document.documentElement.style.setProperty("--z", z);
  try { localStorage.setItem(SIZE_KEY, z); } catch {}
}
document.documentElement.style.setProperty("--z", appSize());

async function boot() {
  try { app.dash = await api("GET", "/login/cli/dashboard"); }
  catch (e) {
    if (e instanceof Gone) return;
    $("#main").innerHTML = `<div class="empty"><h2>Couldn't reach the site</h2><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  // Until the account has finished setting up, the site only offers its settings.
  if (app.dash.account.setup_needed) {
    $("#main").innerHTML = `<div class="empty"><h2>Finish setting up</h2><p>Your account needs you to ${esc(app.dash.account.setup_needed)} before anything else. That's done on the full site.</p><a class="btn" href="/account">Open account settings</a></div>`;
    return;
  }
  app.has = new Set(app.dash.nav.map(n => n.id));
  addEventListener("hashchange", route);
  route();
  checkForUpdate();
  if (app.has.has("chat")) import("./chat.js").then(c => c.watchUnread(app)).catch(() => {});
  // The site's service worker shows push notifications (Notifications, on the full site).
  navigator.serviceWorker?.register("/sw.js").catch(() => {});
}

/* ── Home ───────────────────────────────────────── */
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
async function showHome(main) {
  const d = app.dash;
  main.innerHTML = `<header class="hero"><p class="kicker">${esc(new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }))}</p>
    <h1>${esc(greeting())}, ${esc(d.user.display_name)}</h1></header>
    <div id="update"></div><div id="homeDrift"></div><div id="homeChat"></div>
    ${!d.account.two_factor ? `<a class="card nudge" href="/account"><b>Turn on two-factor sign-in</b><span>It keeps your account safe if your password ever leaks. Set it up on the full site.</span></a>` : ""}`;
  const jobs = [];
  showUpdate();
  if (app.has.has("drift")) jobs.push(import("./drift.js").then(m => m.homeCard($("#homeDrift"), app)));
  if (app.has.has("chat")) jobs.push(import("./chat.js").then(m => m.homeCard($("#homeChat"), app)));
  if (!jobs.length) $("#homeDrift").innerHTML = `<div class="empty"><p>No apps are turned on for your account yet. An admin can turn them on.</p></div>`;
  await Promise.all(jobs.map(j => j.catch(failed)));
}

/* ── More ───────────────────────────────────────── */
async function showMore(main) {
  const d = app.dash;
  // What the phone app doesn't have its own screens for opens on the full site.
  const elsewhere = d.nav.filter(n => !["home", "drift", "chat", "account"].includes(n.id));
  main.innerHTML = `<header class="bar"><h1>More</h1></header>
    <section class="card me"><div class="avatar" aria-hidden="true">${esc((d.user.display_name || d.user.username)[0].toUpperCase())}</div>
      <div><b>${esc(d.user.display_name)}</b><span class="mono">${esc(d.user.username)}${d.user.admin ? " · admin" : ""}</span></div></section>
    <h2 class="label">Settings</h2>
    <div class="card sizes"><div class="seg" role="radiogroup" aria-label="Size">${SIZES.map(([name, z]) =>
      `<button type="button" role="radio" data-size="${z}" aria-selected="${z === appSize()}" aria-checked="${z === appSize()}">${name}</button>`).join("")}</div>
      <p>How big everything is drawn on this phone.</p></div>
    <form class="card form" id="nameForm">
      <label for="dn">Display name</label>
      <div class="row"><input id="dn" name="display_name" maxlength="50" autocomplete="nickname" value="${esc(d.user.display_name)}"><button class="btn">Save</button></div>
    </form>
    <div class="card list">
      <div class="li"><span>Signed in on</span><b id="sessions">${plural(d.account.sessions, "device")}</b></div>
      <button class="li act" id="others" type="button">Sign out every other device</button>
      <a class="li act" href="/account">Password, two-factor and email ${icon("link", 16)}</a>
    </div>
    ${elsewhere.length ? `<h2 class="label">On the full site</h2><div class="card list">${elsewhere.map(n =>
      `<a class="li act" href="${esc(n.url)}">${esc(n.label)} ${icon("link", 16)}</a>`).join("")}</div>` : ""}
    <div class="card list">
      <a class="li act" href="/dashboard">Open the full site ${icon("link", 16)}</a>
      <a class="li act bad" href="/logout">Sign out ${icon("out", 16)}</a>
    </div>
    <div id="update"></div>
    ${app.apk ? `<p class="fine">sintfoap for Android, version ${app.apk}${app.update ? "" : " · up to date"}</p>`
      : `<div class="card list"><a class="li act" href="/app">Get the Android app ${icon("link", 16)}</a></div><p class="fine">sintfoap phone app</p>`}`;
  showUpdate();
  main.querySelector(".sizes").addEventListener("click", e => {
    const b = e.target.closest("[data-size]");
    if (b) { setSize(+b.dataset.size); showMore(main); }
  });
  $("#nameForm").addEventListener("submit", async e => {
    e.preventDefault();
    try {
      const out = await api("POST", "/login/cli/account", { display_name: $("#dn").value });
      d.user.display_name = out.display_name ?? $("#dn").value.trim();
      toast("Saved.");
      showMore(main);
    } catch (err) { failed(err); }
  });
  $("#others").addEventListener("click", async () => {
    if (!confirm("Sign out everywhere except this phone?")) return;
    try {
      const out = await api("POST", "/login/cli/account/sessions");
      d.account.sessions = out.sessions ?? 1;
      $("#sessions").textContent = plural(d.account.sessions, "device");
      toast("Signed out your other devices.");
    } catch (err) { failed(err); }
  });
}

export { ago };
boot();
