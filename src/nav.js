// The site's navigation, owned by the dashboard: what the side rail shows on
// every signed-in page (server pages, Drift, the plugin store, chat) and what
// the terminal UI offers. Pages never list their own entries; they render this.
import { PLACES, canUse } from "./auth.js";

// Until an account has finished setting up (a new password, or two-factor for
// an admin), the site only offers its settings, so that's all the menu shows.
export const setupDone = user => !user.must_change_pw && !(user.areas.has("admin") && !user.totp_secret);

// [{ id, label, href, icon, key, group }] for this account, in menu order.
// group "site" is home and the apps; "kitchen" the food apps (Recipe box, Meal
// plan, Recipe board, Recipe labels, Food club); "account" is settings and admin.
export function siteNav(user) {
  const ready = setupDone(user);
  const can = a => ready && canUse(user, a);
  const app = a => ({ id: a.id, label: a.name, href: a.href, icon: a.icon, key: a.key });
  return [
    ...(ready ? [{ id: "home", label: "Home", href: "/dashboard", icon: "home", key: "h", group: "site" }] : []),
    ...PLACES.filter(a => !a.group && can(a)).map(a => ({ ...app(a), group: "site" })),
    ...PLACES.filter(a => a.group === "kitchen" && can(a)).map(a => ({ ...app(a), group: "kitchen" })),
    { id: "account", label: "Settings", href: "/account", icon: "account", key: "s", group: "account" },
    ...PLACES.filter(a => a.group === "account" && can(a)).map(a => ({ ...app(a), group: "account" })),
  ];
}
