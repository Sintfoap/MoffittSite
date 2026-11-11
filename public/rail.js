// The site rail's own buttons, on every signed-in page:
// - Collapse folds the rail down to its icons, and back (or the \ key);
// - Menu, on a phone, opens the whole menu under the bar (html.rail-open);
// - Dark mode / Light mode picks the site's look over the system's.
// This browser remembers the fold and the look. Loaded just before the rail,
// without defer, so a folded rail or a picked look is in place before it's drawn.
(() => {
  const root = document.documentElement;
  const KEY = "sintfoap.rail", THEME = "sintfoap.theme";
  const get = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const put = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
  if (get(KEY) === "min") root.classList.add("rail-min");

  // ── the look ──────────────────────────────────────────────────────────
  // Pages colour themselves with @media (prefers-color-scheme) rules. A picked
  // look rewrites those rules' conditions so the picked one always matches and
  // the other never does; Drift also reads html[data-theme]. Drift's own
  // button used to keep its choice as drift:theme, so that's read once too.
  const QUERY = /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/g;
  const original = new WeakMap();
  const systemDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
  let theme = get(THEME);
  if (!theme) { try { const d = JSON.parse(get("drift:theme")); if (d === "dark" || d === "light") theme = d; } catch {} }
  function rewrite(rules) {
    for (const rule of rules) {
      if (rule.media && rule.cssRules) {
        if (!original.has(rule)) original.set(rule, rule.media.mediaText);
        const text = original.get(rule);
        if (/prefers-color-scheme/.test(text)) {
          rule.media.mediaText = theme ? text.replace(QUERY, (_, want) => want === theme ? "(min-width: 0px)" : "(max-width: 0px)") : text;
        }
        rewrite(rule.cssRules);
      }
    }
  }
  function apply() {
    if (theme) root.dataset.theme = theme; else delete root.dataset.theme;
    for (const sheet of document.styleSheets) { try { rewrite(sheet.cssRules); } catch {} }   // another site's sheet can't be read
    const dark = theme ? theme === "dark" : systemDark();
    for (const b of document.querySelectorAll("[data-theme-toggle]")) {
      const text = dark ? "Light mode" : "Dark mode";
      b.title = text; b.setAttribute("aria-label", text);
      const span = b.querySelector("span"); if (span) span.textContent = text;
    }
  }
  const toggle = () => {
    const dark = theme ? theme === "dark" : systemDark();
    theme = dark ? "light" : "dark";
    // Back to following the system when the pick matches it.
    if ((theme === "dark") === systemDark()) theme = null;
    put(THEME, theme); put("drift:theme", null);
    apply();
  };
  window.sintfoapTheme = { toggle, get dark() { return theme ? theme === "dark" : systemDark(); } };
  if (theme) apply();
  document.addEventListener("DOMContentLoaded", apply);   // styles later in the page, and the button's words

  // ── fold and menu ─────────────────────────────────────────────────────
  const label = () => {
    const min = root.classList.contains("rail-min");
    for (const b of document.querySelectorAll("[data-rail-fold]")) {
      const text = min ? "Expand sidebar" : "Collapse sidebar";
      b.setAttribute("aria-label", text);
      b.title = text;
      b.setAttribute("aria-expanded", String(!min));
    }
  };
  const fold = () => {
    const min = root.classList.toggle("rail-min");
    put(KEY, min ? "min" : "full");
    label();
    // Pages that size things to the window (Drift's map, chat's scroll) re-measure.
    window.dispatchEvent(new Event("resize"));
  };
  const menu = open => {
    root.classList.toggle("rail-open", open);
    for (const b of document.querySelectorAll("[data-rail-menu]")) b.setAttribute("aria-expanded", String(open));
  };
  document.addEventListener("DOMContentLoaded", label);
  document.addEventListener("click", e => {
    if (e.target.closest?.("[data-rail-fold]")) fold();
    else if (e.target.closest?.("[data-theme-toggle]")) toggle();
    else if (e.target.closest?.("[data-rail-menu]")) menu(!root.classList.contains("rail-open"));
    else if (root.classList.contains("rail-open") && !e.target.closest?.(".rail")) menu(false);
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && root.classList.contains("rail-open")) { menu(false); return; }
    const t = e.target;
    if (e.key !== "\\" || e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || t.matches?.("input, textarea, select") || document.querySelector("dialog[open]")) return;
    if (!document.querySelector(".rail")) return;
    e.preventDefault();
    fold();
  });
})();
