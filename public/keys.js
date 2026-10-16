// Site-wide keyboard shortcuts for the signed-in pages, shown in each page's
// key bar. Two-key "g" chords jump between apps (g h home, g d Drift, g p
// plugin store, g s settings, g a admin), so they never clash with a page's
// own single-key shortcuts. Any link with data-key="<letter>" is a target.
(() => {
  let armed = 0;
  document.addEventListener("keydown", e => {
    const t = e.target;
    if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || t.matches?.("input, textarea, select") || document.querySelector("dialog[open]")) return;
    if (armed && Date.now() - armed < 1500) {
      armed = 0;
      const a = document.querySelector(`a[data-key="${CSS.escape(e.key)}"]`);
      if (a) { e.preventDefault(); location.href = a.href; }
      return;
    }
    armed = e.key === "g" ? Date.now() : 0;
  });
})();
