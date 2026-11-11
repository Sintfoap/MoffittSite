// The admin page's account list (src/pages.js adminPage): finding an account,
// opening or closing them all, All on / All off, and saying when an account's
// switches have changes that aren't saved yet. Saving is the form's own post.
(() => {
  const people = [...document.querySelectorAll("details.person")];
  const find = document.querySelector("[data-find-person]");
  find?.addEventListener("input", () => {
    const q = find.value.trim().toLowerCase();
    for (const p of people) p.hidden = !!q && !p.dataset.who.includes(q);
    const shown = people.filter(p => !p.hidden);
    if (q && shown.length === 1) shown[0].open = true;
  });
  for (const b of document.querySelectorAll("[data-expand]")) {
    b.addEventListener("click", () => { for (const p of people) if (!p.hidden) p.open = b.dataset.expand === "open"; });
  }

  for (const form of document.querySelectorAll("form[data-access]")) {
    const boxes = [...form.querySelectorAll('input[type=checkbox][name=apps]')];
    const was = boxes.map(b => b.checked);
    const note = form.querySelector("[data-unsaved]");
    const count = form.closest("details")?.querySelector("[data-count]");
    const update = () => {
      note.hidden = boxes.every((b, i) => b.checked === was[i]);
      if (count) count.textContent = `${boxes.filter(b => b.checked).length} of ${boxes.length} apps${note.hidden ? "" : " · unsaved"}`;
    };
    form.addEventListener("change", update);
    for (const b of form.querySelectorAll("[data-all]")) {
      b.addEventListener("click", () => { for (const x of boxes) if (!x.disabled) x.checked = b.dataset.all === "on"; update(); });
    }
  }

  // Back from saving: the saved account in view, not the top of the page.
  const open = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
  if (open?.matches("details.person")) { open.open = true; open.scrollIntoView({ block: "start" }); }
})();
