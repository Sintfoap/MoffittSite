// Notifications page: turn push on or off for this browser, pick what's sent,
// and see every browser they go to. The Worker side is src/notify.js; the
// service worker that shows them is /sw.js.

const $ = s => document.querySelector(s);
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
let data = null;          // GET /notifications/api/state
let reg = null;           // this page's service worker registration
let hereId = null;        // this browser's device id, if it has a subscription

async function api(method, path, body) {
  const res = await fetch("/notifications/api/" + path, {
    method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname); throw new Error("not signed in"); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `the site answered ${res.status}`);
  return out;
}

function showError(e) {
  const box = $("#error");
  box.textContent = e ? e.message || String(e) : "";
  box.hidden = !e;
}

// The same id the Worker gives this browser's subscription.
async function deviceId(endpoint) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("push:" + endpoint)));
  return [...hash].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

// "Chrome on Android", for the list of browsers.
function label() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Firefox\//.test(ua) ? "Firefox"
    : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "A browser";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "iPad"
    : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const appleMobile = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const day = t => t ? new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";

function render() {
  const { configured, prefs, devices, apps, leads } = data;
  $("#unconfigured").hidden = configured;
  const on = !!hereId && devices.some(d => d.id === hereId);

  const state = $("#here-state");
  state.textContent = on ? "on" : "off";
  state.className = "state " + (on ? "on" : "off");
  let text, canEnable = false;
  if (!configured) text = "Nothing can be turned on until the site is set up.";
  else if (!supported()) text = appleMobile() && !standalone()
    ? "On iPhone and iPad, add this site to your Home Screen first (Share, then Add to Home Screen), open it from there, and come back to this page."
    : "This browser can't get push notifications.";
  else if (Notification.permission === "denied") text = "This browser is blocking notifications from this site. Allow them in the browser's site settings, then reload.";
  else if (on) text = "Notifications you've picked below come to this browser, even when the site isn't open.";
  else { text = "Turning them on asks the browser for permission."; canEnable = true; }
  $("#here-text").textContent = text;
  $("#enable").hidden = !canEnable;
  $("#disable").hidden = !on;
  $("#test").hidden = !configured || !devices.length;

  for (const box of document.querySelectorAll("[data-pref]")) box.checked = !!prefs[box.dataset.pref];
  const lead = $("#lead");
  if (!lead.options.length) {
    for (const m of leads) lead.add(new Option(m === 0 ? "when they start" : m >= 1440 ? "a day before" : m >= 60 ? `${m / 60} hour${m > 60 ? "s" : ""} before` : `${m} minutes before`, m));
  }
  lead.value = prefs.drift_lead;
  lead.disabled = !prefs.drift_events;
  $("#chat-prefs").hidden = !apps.chat;
  $("#drift-prefs").hidden = !apps.drift;
  $("#no-apps").hidden = apps.chat || apps.drift;

  const list = $("#devices");
  list.replaceChildren();
  if (!devices.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No browsers yet. Turn notifications on above, in each browser or phone you want them on.";
    list.append(li);
  }
  for (const d of devices) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = d.label;
    if (d.id === hereId) {
      const you = document.createElement("span");
      you.className = "you";
      you.textContent = "this browser";
      name.append(you);
    }
    const small = document.createElement("small");
    small.textContent = `Added ${day(d.created_at)}` + (d.last_ok ? ` · last delivered ${day(d.last_ok)}` : "");
    name.append(small);
    const remove = document.createElement("button");
    remove.className = "btn danger small";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => run(async () => {
      data = await api("DELETE", "devices/" + d.id);
      if (d.id === hereId) await (await reg?.pushManager.getSubscription())?.unsubscribe();
    }));
    li.append(name, remove);
    list.append(li);
  }
}

async function run(fn) {
  showError(null);
  try { await fn(); } catch (e) { showError(e); }
  if (data) render();
}

async function subscribe() {
  const key = fromB64url(data.public_key);
  try {
    return await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch (e) {
    // Subscribed before with a different key (the site's keys changed): start over.
    const old = await reg.pushManager.getSubscription();
    if (!old) throw e;
    await old.unsubscribe();
    return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  }
}

$("#enable").addEventListener("click", () => run(async () => {
  if (await Notification.requestPermission() !== "granted") return;
  const sub = await subscribe();
  data = await api("POST", "devices", { ...sub.toJSON(), label: label(), tz: TZ });
  hereId = data.device;
}));

$("#disable").addEventListener("click", () => run(async () => {
  data = await api("DELETE", "devices/" + hereId);
  await (await reg.pushManager.getSubscription())?.unsubscribe();
}));

$("#test").addEventListener("click", () => run(async () => {
  data = await api("POST", "test");
  if (!data.sent) throw new Error("None of your browsers took the test notification.");
}));

for (const box of document.querySelectorAll("[data-pref]")) {
  box.addEventListener("change", () => run(async () => { data = await api("PATCH", "prefs", { [box.dataset.pref]: box.checked }); }));
}
$("#lead").addEventListener("change", e => run(async () => { data = await api("PATCH", "prefs", { drift_lead: Number(e.target.value) }); }));

run(async () => {
  data = await api("GET", "state");
  if (supported()) {
    reg = await navigator.serviceWorker.register("/sw.js");
    const sub = await reg.pushManager.getSubscription();
    hereId = sub ? await deviceId(sub.endpoint) : null;
    // Drift's reminders follow the time zone of the browser you use most recently.
    if (hereId && data.devices.some(d => d.id === hereId) && data.prefs.tz !== TZ) data = await api("PATCH", "prefs", { tz: TZ });
  }
});
