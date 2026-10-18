// The site's service worker. It only shows push notifications (src/notify.js
// sends them) and opens the right page when one is tapped; it caches nothing.

self.addEventListener("push", event => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch {}
  const title = m.title || "sintfoap.xyz";
  event.waitUntil(self.registration.showNotification(title, {
    body: m.body || "",
    tag: m.tag || undefined,
    renotify: !!m.tag,
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    data: { url: m.url || "/dashboard" },
  }));
});

// Tapping one focuses a tab already on that page (or any of the site's tabs),
// else opens a new one.
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/dashboard", self.location.origin);
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const same = tabs.find(t => new URL(t.url).pathname === url.pathname) || tabs[0];
    if (same) {
      await same.focus();
      if (same.url !== url.href && "navigate" in same) await same.navigate(url.href).catch(() => {});
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});

// The push service replaced this browser's subscription: tell the site the new one.
self.addEventListener("pushsubscriptionchange", event => {
  event.waitUntil((async () => {
    const options = event.oldSubscription?.options;
    const sub = event.newSubscription || (options && await self.registration.pushManager.subscribe(options));
    if (!sub) return;
    await fetch("/notifications/api/devices", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
      body: JSON.stringify({ ...sub.toJSON(), label: "This browser, renewed", tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    }).catch(() => {});
  })());
});
