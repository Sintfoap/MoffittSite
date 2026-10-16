// Events: items that happen on a date, optionally at a time.
// meta.event = { start, end }   "YYYY-MM-DD" (all day) or "YYYY-MM-DDTHH:MM"; end may be null

import { esc, icon, DATE, DATETIME, today, addDays, iso, dayOf, timeOf, niceDay, niceTime } from "../lib.js";

const cal = icon('<rect x="4" y="5.5" width="16" height="14" rx="3" stroke="currentColor" stroke-width="2"/><path d="M4 10h16" stroke="currentColor" stroke-width="2"/>', 13);
const isOpen = it => !it.meta.checklist?.done;

function when(m) {
  const t = timeOf(m.start), et = timeOf(m.end);
  return t ? niceTime(t) + (et && dayOf(m.end) === dayOf(m.start) ? "–" + niceTime(et) : "") : "All day";
}
// Does the event cover this day? (multi-day events show on every day they span)
const onDay = (m, d) => dayOf(m.start) <= d && d <= dayOf(m.end || m.start);
const byStart = (a, b) => (a.meta.event.start.length - b.meta.event.start.length) || a.meta.event.start.localeCompare(b.meta.event.start);

function monthGrid(ctx, events) {
  const vs = ctx.viewState, sel = vs.day || today();
  const first = new Date((vs.month || today().slice(0, 7)) + "-01T00:00");
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));   // weeks start on Monday
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const day = iso(d), inMonth = d.getMonth() === first.getMonth();
    if (i === 35 && !inMonth) break;
    const evs = events.filter(it => onDay(it.meta.event, day)).sort(byStart);
    const cls = ["day", inMonth ? "" : "out", day === today() ? "now" : "", day === sel ? "sel" : ""].join(" ");
    cells.push(`<button class="${cls}" data-act="event:pick" data-day="${day}" aria-label="${esc(niceDay(day))}, ${evs.length} event${evs.length === 1 ? "" : "s"}">
      <span class="dn">${d.getDate()}</span>
      ${evs.slice(0, 3).map(it => `<span class="ev ${isOpen(it) ? "" : "past"}">${esc(it.title)}</span>`).join("")}
      ${evs.length > 3 ? `<span class="more">+${evs.length - 3}</span>` : ""}
      <span class="dots">${evs.slice(0, 4).map(() => "<i></i>").join("")}</span>
    </button>`);
  }
  const label = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const wd = [...Array(7)].map((_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: "short" }));
  return `<div class="cal">
    <div class="cal-head"><h2>${esc(label)}</h2>
      <span><button class="ghost" data-act="event:month" data-step="-1" aria-label="Previous month">‹</button>
      <button class="ghost" data-act="event:month" data-step="0">Today</button>
      <button class="ghost" data-act="event:month" data-step="1" aria-label="Next month">›</button></span></div>
    <div class="cal-grid">${wd.map(w => `<span class="wd">${esc(w)}</span>`).join("")}${cells.join("")}</div>
  </div>`;
}

export default {
  id: "event",
  name: "Events",
  description: "Give items a date and time, and see them on a calendar.",
  icon: '<rect x="4" y="5.5" width="16" height="14" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M4 10h16M9 3.5v4M15 3.5v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',

  clean(v, fail) {
    if (!v || typeof v !== "object" || Array.isArray(v)) fail("event must be an object");
    const ok = s => DATE.test(s) || DATETIME.test(s);
    const start = String(v.start ?? ""), end = v.end == null || v.end === "" ? null : String(v.end);
    if (!ok(start)) fail("event.start must be YYYY-MM-DD or YYYY-MM-DDTHH:MM");
    if (end !== null) {
      if (!ok(end)) fail("event.end must be YYYY-MM-DD or YYYY-MM-DDTHH:MM");
      if (DATE.test(start) !== DATE.test(end)) fail("event.start and event.end must both have a time, or neither");
      if (end < start) fail("event.end is before event.start");
    }
    return { start, end };
  },

  fresh(quick, ctx) {
    if (!quick.date && !quick.time && ctx.tab !== "event") return undefined;
    const day = quick.date || (ctx.tab === "event" && ctx.viewState.day) || today();
    return { start: quick.time ? `${day}T${quick.time}` : day, end: null };
  },

  chips(item) {
    const m = item.meta.event, d = dayOf(m.start), t = timeOf(m.start);
    const late = isOpen(item) && dayOf(m.end || m.start) < today();
    const cls = late ? "over" : d === today() ? "today" : "";
    return [`<span class="chip due ${cls}">${cal}${esc(niceDay(d))}${t ? " " + esc(niceTime(t)) : ""}${m.end && dayOf(m.end) !== d ? " – " + esc(niceDay(dayOf(m.end))) : ""}</span>`];
  },

  editor(item) {
    const m = item.meta.event;
    return `<div class="grid">
      <label>Date<input type="date" name="day" value="${esc(dayOf(m.start))}"></label>
      <label>Time<input type="time" name="time" value="${esc(timeOf(m.start))}"></label>
      <label>Ends<input type="date" name="endDay" value="${esc(m.end ? dayOf(m.end) : "")}"></label>
      <label>End time<input type="time" name="endTime" value="${esc(timeOf(m.end))}"></label>
    </div>
    <span class="quickdates">
      <button type="button" data-set="day=${today()}">Today</button><button type="button" data-set="day=${addDays(1)}">Tomorrow</button>
      <button type="button" data-set="day=${addDays(7)}">In a week</button>
    </span>`;
  },
  read(f) {
    if (!f.day) return null;
    const timed = Boolean(f.time);
    const start = timed ? `${f.day}T${f.time}` : f.day;
    let end = null;
    if (f.endTime && timed) end = `${f.endDay || f.day}T${f.endTime}`;
    else if (f.endDay && f.endDay !== f.day) end = timed ? `${f.endDay}T${f.time}` : f.endDay;
    return { start, end: end && end >= start ? end : null };
  },

  keys: {
    t: (item, ctx) => ctx.setMeta(item.id, "event", { start: today() + (timeOf(item.meta.event?.start) ? "T" + timeOf(item.meta.event.start) : ""), end: null }),
  },

  actions: {
    pick(_, ctx, el) { ctx.viewState.day = el.dataset.day; ctx.render(); },
    month(_, ctx, el) {
      const step = +el.dataset.step, vs = ctx.viewState;
      if (!step) { vs.month = today().slice(0, 7); vs.day = today(); }
      else { const d = new Date((vs.month || today().slice(0, 7)) + "-01T00:00"); d.setMonth(d.getMonth() + step); vs.month = iso(d).slice(0, 7); }
      ctx.render();
    },
  },

  view: {
    label: "Calendar",
    render(ctx) {
      const events = ctx.items.filter(it => it.meta.event);
      const sel = ctx.viewState.day || today();
      const day = events.filter(it => onDay(it.meta.event, sel)).sort(byStart);
      const later = events.filter(it => dayOf(it.meta.event.start) > sel && dayOf(it.meta.event.start) <= addDays(14, sel)).sort(byStart);
      let html = monthGrid(ctx, events);
      html += ctx.group(niceDay(sel), day, day.length ? "" : `<p class="hint">Nothing on this day. Items you add now land here.</p>`, { skip: ["event"], chips: it => [`<span class="chip">${esc(when(it.meta.event))}</span>`] });
      if (later.length) html += ctx.group("Next two weeks", later);
      return html;
    },
  },
};
