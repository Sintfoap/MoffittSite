// Site-wide keyboard shortcuts for the signed-in pages, shown in each page's
// key bar. Two-key "g" chords jump between apps (g h home, g d Drift, g p
// plugin store, g s settings, g a admin), so they never clash with a page's
// own single-key shortcuts. Any link with data-key="<letter>" is a target.
//
// When a page's key bar is wider than the window, it starts with "? all keys",
// and ? lists every shortcut in the bar (pages with their own list, like
// Drift's, keep theirs).
(() => {
  let armed = 0;
  const typing = t => t.isContentEditable || t.matches?.("input, textarea, select");
  document.addEventListener("keydown", e => {
    const t = e.target;
    if (e.metaKey || e.ctrlKey || e.altKey || typing(t) || document.querySelector("dialog[open]")) return;
    if (e.key === "?" && !document.getElementById("keysBtn") && document.querySelector(".keybar")) { e.preventDefault(); showAll(); return; }
    if (armed && Date.now() - armed < 1500) {
      armed = 0;
      const a = document.querySelector(`a[data-key="${CSS.escape(e.key)}"]`);
      if (a) { e.preventDefault(); location.href = a.href; }
      return;
    }
    armed = e.key === "g" ? Date.now() : 0;
  });

  let dialog = null;
  function showAll() {
    const bar = document.querySelector(".keybar");
    if (!bar) return;
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.className = "keys-all";
      dialog.setAttribute("aria-label", "Keyboard shortcuts");
      const style = document.createElement("style");
      style.textContent = `dialog.keys-all { max-width: min(520px, calc(100vw - 32px)); padding: 18px 22px; border: 1px solid var(--line-2, #a9a283);
        background: var(--panel, var(--surface, #fbfaf4)); color: var(--ink, #1c1d16); font: 14px var(--mono, var(--sans, monospace)); }
        dialog.keys-all::backdrop { background: rgb(0 0 0 / .35); }
        dialog.keys-all h2 { margin: 0 0 12px; font-size: 15px; }
        dialog.keys-all ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; }
        dialog.keys-all li { display: contents; }
        dialog.keys-all kbd { font: 700 13px var(--mono, var(--sans, monospace)); color: var(--gold, var(--accent, #8a6510)); text-align: right; }
        dialog.keys-all p { margin: 14px 0 0; font-size: 12.5px; color: var(--faint, #7a7764); }`;
      document.head.append(style);
      document.body.append(dialog);
      dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); });
    }
    const rows = [...bar.querySelectorAll(":scope > span:not([hidden]), :scope > a")].filter(x => !x.classList.contains("all-keys")).map(x => {
      const k = x.querySelector("kbd")?.textContent || "";
      return `<li><kbd>${k}</kbd><span>${x.textContent.slice(k.length).trim()}</span></li>`;
    });
    dialog.innerHTML = `<h2>Keyboard shortcuts</h2><ul>${rows.join("")}</ul><p>Esc closes this.</p>`;
    dialog.showModal();
  }

  // "? all keys" at the start of a key bar that doesn't fit.
  function fit() {
    const bar = document.querySelector(".keybar");
    if (!bar || document.getElementById("keysBtn")) return;
    let more = bar.querySelector(".all-keys");
    if (!more) {
      more = document.createElement("a");
      more.href = "#";
      more.className = "all-keys";
      more.innerHTML = "<kbd>?</kbd>all keys";
      more.addEventListener("click", e => { e.preventDefault(); showAll(); });
      bar.prepend(more);
    }
    more.hidden = false;
    more.hidden = bar.scrollWidth <= bar.clientWidth + 1;
  }
  addEventListener("load", fit);
  addEventListener("resize", fit);
})();
