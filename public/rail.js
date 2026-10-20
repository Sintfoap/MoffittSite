// Folds the site rail down to its icons, and back. The rail's button or the
// \ key does it, and this browser remembers the choice. Loaded just before the
// rail, without defer, so a folded rail is folded before it's ever drawn.
(() => {
  const root = document.documentElement;
  const KEY = "sintfoap.rail";
  try { if (localStorage.getItem(KEY) === "min") root.classList.add("rail-min"); } catch {}

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
    try { localStorage.setItem(KEY, min ? "min" : "full"); } catch {}
    label();
    // Pages that size things to the window (Drift's map, chat's scroll) re-measure.
    window.dispatchEvent(new Event("resize"));
  };
  document.addEventListener("DOMContentLoaded", label);
  document.addEventListener("click", e => { if (e.target.closest?.("[data-rail-fold]")) fold(); });
  document.addEventListener("keydown", e => {
    const t = e.target;
    if (e.key !== "\\" || e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || t.matches?.("input, textarea, select") || document.querySelector("dialog[open]")) return;
    if (!document.querySelector(".rail")) return;
    e.preventDefault();
    fold();
  });
})();
