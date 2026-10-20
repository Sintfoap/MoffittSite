// Weather: the forecast on calendar days, and a warning when an outdoor item
// lands on a wet one.
// meta.weather = { outdoor }   outdoor: true to be warned when its day looks wet
//
// The forecast is the site's (src/weather.js, from Open-Meteo): the next 16
// days at a spot. An item's spot is its place (Locations), else its
// collection's base for the day, else near you; a calendar day's is the
// collection's base, else near you. A day is wet when rain is at least
// WET_CHANCE% likely, WET_MM of it is expected, or there's a thunderstorm.
//
// With the plugin on, the Calendar's days show their weather, outdoor items
// carry a warning chip on a wet day (on Today too), and the Forecast view lists
// the days ahead with what's on each.

import { esc, today, addDays, dayOf } from "../lib.js";
import { baseFor } from "../route.js";

export const WET_CHANCE = 50, WET_MM = 2;
// Tagging an item one of these while Weather is on marks it as outdoors.
export const OUTDOOR_TAGS = ["outdoor", "outdoors", "outside"];

// What a WMO weather code (as Open-Meteo sends it) looks like: [words, emoji].
export function sky(code) {
  if (code === 0) return ["Clear", "☀️"];
  if (code === 1) return ["Mostly clear", "🌤️"];
  if (code === 2) return ["Partly cloudy", "⛅"];
  if (code === 3) return ["Cloudy", "☁️"];
  if (code === 45 || code === 48) return ["Fog", "🌫️"];
  if (code >= 51 && code <= 57) return ["Drizzle", "🌦️"];
  if (code >= 61 && code <= 67) return ["Rain", "🌧️"];
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return ["Snow", "🌨️"];
  if (code >= 80 && code <= 82) return ["Showers", "🌦️"];
  if (code >= 95) return ["Thunderstorms", "⛈️"];
  return ["", "·"];
}
export const wet = d => !!d && ((d.rain ?? 0) >= WET_CHANCE || (d.precip ?? 0) >= WET_MM || d.code >= 95);
// °F where people expect it (an American English browser), else °C.
const fahrenheit = () => /^en-US$/i.test(globalThis.navigator?.language || "");
export const temp = (c, f = fahrenheit()) => c == null ? "" : `${Math.round(f ? c * 9 / 5 + 32 : c)}°`;
const hiLo = d => [temp(d.hi), temp(d.lo)].filter(Boolean).join(" / ");
// "Rain, 70% chance" when it's wet, else what the sky does.
const why = d => wet(d) ? `${sky(d.code)[0] || "Rain"}${d.rain != null ? `, ${d.rain}% chance` : ""}` : sky(d.code)[0];
export const outdoors = it => !!it.meta.weather?.outdoor;

// ── the forecast, asked of the site once per spot every half hour ──────────

const TTL = 30 * 60e3, RETRY = 2 * 60e3;
const asked = new Map();     // spot key → { at, data, loading, failed }
const placed = m => !!m && m.lat != null && m.lng != null;
const keyOf = spot => placed(spot) ? `${spot.lat.toFixed(2)},${spot.lng.toFixed(2)}` : "here";

// The forecast at `spot` (null: near you) as far as it's known: the site's
// answer, or null while it's on its way. `redraw` is called when it arrives.
export function forecastAt(spot, redraw) {
  const k = keyOf(spot), e = asked.get(k);
  if (e && (e.loading || Date.now() - e.at < (e.failed ? RETRY : TTL))) return e.data;
  const entry = { at: Date.now(), data: e?.data || null, loading: true, failed: false };
  asked.set(k, entry);
  const q = k === "here" ? "" : `?lat=${spot.lat.toFixed(2)}&lng=${spot.lng.toFixed(2)}`;
  fetch("/todo/api/weather" + q, { credentials: "same-origin" })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(r.statusText)))
    .then(d => { entry.data = d; })
    .catch(() => { entry.failed = true; })
    .finally(() => { entry.loading = false; entry.at = Date.now(); redraw?.(); });
  return entry.data;
}
const failed = spot => !!asked.get(keyOf(spot))?.failed;

// Where an item's weather comes from on `day`, and where a day's does.
const colOf = (it, ctx) => ctx.collections?.find(c => c.id === it.collection) || ctx.collection;
export const spotFor = (it, day, col) => placed(it.meta.location) ? it.meta.location : daySpot(col, day);
export const daySpot = (col, day) => { const b = baseFor(col?.bases, day); return placed(b) ? b : null; };
const dayIn = (fc, day) => fc?.days?.find(d => d.day === day) || null;

const covers = (it, day) => !!it.meta.event && dayOf(it.meta.event.start) <= day && day <= dayOf(it.meta.event.end || it.meta.event.start);
const weatherOn = (it, day, ctx) => dayIn(forecastAt(spotFor(it, day, colOf(it, ctx)), ctx.render), day);

// The days an event covers that the forecast reaches, each with its weather.
function itemDays(it, ctx) {
  const ev = it.meta.event;
  if (!ev) return [];
  const out = [], last = dayOf(ev.end || ev.start);
  for (let day = dayOf(ev.start) < today() ? today() : dayOf(ev.start), n = 0; day <= last && n < 16; day = addDays(1, day), n++) {
    const d = weatherOn(it, day, ctx);
    if (d) out.push(d);
  }
  return out;
}
// Is this an outdoor item, still to do, on `day`, and is that day wet where it is?
export const wetOn = (it, day, ctx) => outdoors(it) && it.meta.checklist?.done !== true && covers(it, day) && wet(weatherOn(it, day, ctx));

function chip(d, warn) {
  const [words, e] = sky(d.code);
  return warn
    ? `<span class="chip wx wet" title="${esc(`${why(d)} ${d.day === today() ? "today" : "that day"}, and this is outdoors`)}">☂ ${esc(why(d))}</span>`
    : `<span class="chip wx" title="${esc(words)}">${e} ${esc(hiLo(d))}</span>`;
}

export default {
  id: "weather",
  name: "Weather",
  description: "See the forecast on calendar days, and get a warning when an outdoor item lands on a rainy one.",
  icon: '<path d="M7 18.5h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 11a3.75 3.75 0 0 0 0 7.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 21.5l.6-1.2M13 21.5l.6-1.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',

  clean(v, fail) {
    if (!v || typeof v !== "object" || Array.isArray(v)) fail("weather must be an object");
    if (v.outdoor != null && typeof v.outdoor !== "boolean") fail("weather.outdoor must be true or false");
    return { outdoor: v.outdoor !== false };
  },

  // A new item tagged #outdoor (or #outdoors, #outside) is watched for rain.
  fresh(quick) {
    return (quick.tags || []).some(t => OUTDOOR_TAGS.includes(t)) ? { outdoor: true } : undefined;
  },

  chips(item, ctx) {
    const days = itemDays(item, ctx);
    if (!days.length) return [];
    const w = outdoors(item) && item.meta.checklist?.done !== true ? days.find(wet) : null;
    return [chip(w || days[0], !!w)];
  },

  editor(item, ctx) {
    const days = itemDays(item, ctx), w = days.find(wet);
    const line = !item.meta.event ? "Give it a date to see its forecast."
      : !days.length ? (dayOf(item.meta.event.end || item.meta.event.start) < today() ? "Its day has passed." : "The forecast reaches 16 days ahead; check back closer to the day.")
      : days.map(d => `${d === days[0] && days.length === 1 ? "" : d.day.slice(5) + ": "}${sky(d.code)[1]} ${sky(d.code)[0]}, ${hiLo(d)}${d.rain != null ? `, ${d.rain}% chance of rain` : ""}`).join(" · ");
    return `<label class="inline"><input type="checkbox" name="outdoor" ${outdoors(item) ? "checked" : ""}> Outdoors: warn me when its day looks wet</label>
      <p class="hint${w && outdoors(item) ? " wx-warn" : ""}">${esc(line)}</p>`;
  },
  read: f => ({ outdoor: f.outdoor !== false }),

  // The weather for a day on the Calendar: a few characters in a month's cell,
  // or a sentence (`long`) above the day's hours, with any outdoor items it
  // spoils named.
  day(day, ctx, long = false) {
    const spot = daySpot(ctx.collection, day), d = dayIn(forecastAt(spot, ctx.render), day);
    const spoilt = ctx.items.filter(it => wetOn(it, day, ctx));
    if (!long) {
      if (!d) return "";
      return `<span class="wx${spoilt.length ? " warn" : ""}" title="${esc(`${why(d)}, ${hiLo(d)}${spoilt.length ? ` · rain on ${spoilt.length} outdoor item${spoilt.length === 1 ? "" : "s"}` : ""}`)}">${spoilt.length ? "☂" : sky(d.code)[1]}<span class="t">${esc(temp(d.hi))}</span></span>`;
    }
    if (!d) return "";
    const warn = spoilt.length ? `<p class="wx-warn">☂ Looks wet for ${spoilt.map(it => `“${esc(it.title)}”`).join(", ")}, which ${spoilt.length === 1 ? "is" : "are"} outdoors.</p>` : "";
    return `<p class="wx-line">${sky(d.code)[1]} ${esc(sky(d.code)[0])} · ${esc(hiLo(d))}${d.rain != null ? ` · ${d.rain}% chance of rain` : ""}${spot ? ` <small>at ${esc(spot.place || "the base")}</small>` : ""}</p>${warn}`;
  },

  view: {
    label: "Forecast",
    render(ctx) {
      const col = ctx.collection, home = daySpot(col, today()), fc = forecastAt(home, ctx.render);
      const where = home ? `at ${esc(home.place || "the base")}` : fc?.near && fc.days?.length ? "near you" : "";
      if (!fc) return `<div class="group"><h2>Forecast</h2><p class="hint">${failed(home) ? "Couldn’t get the forecast. It’ll try again in a couple of minutes." : "Getting the forecast…"}</p></div>`;
      if (!fc.days?.length) return `<div class="group"><h2>Forecast</h2><p class="hint">The site couldn’t tell where you are. Turn on Locations and give this collection a home base on its Map, and the forecast is for there.</p></div>`;
      const events = ctx.items.filter(it => it.meta.event);
      const out = fc.days.filter(d => d.day >= today()).map(d => {
        const day = d.day, dd = dayIn(forecastAt(daySpot(col, day), ctx.render), day) || d;
        const on = events.filter(it => covers(it, day)).sort((a, b) => a.meta.event.start.localeCompare(b.meta.event.start));
        const spoilt = on.filter(it => wetOn(it, day, ctx));
        return `<div class="group wx-day${wet(dd) ? " wet" : ""}"><h2>${esc(day === today() ? "Today" : new Date(day + "T00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }))}
            <span class="wx-sum">${sky(dd.code)[1]} ${esc(sky(dd.code)[0])} · ${esc(hiLo(dd))}${dd.rain != null ? ` · ${dd.rain}% rain` : ""}</span></h2>
          ${spoilt.length ? `<p class="wx-warn">☂ ${spoilt.length === 1 ? "An outdoor item" : `${spoilt.length} outdoor items`} on a wet day. Move ${spoilt.length === 1 ? "it" : "them"}, or bring an umbrella.</p>` : ""}
          ${on.length ? `<ul class="items">${on.map(it => ctx.row(it, { skip: ["weather"], chips: x => spoilt.includes(x) ? [`<span class="chip wx wet">☂ Outdoors</span>`] : [] })).join("")}</ul>` : ""}</div>`;
      }).join("");
      return `<p class="hint wx-where">The next ${fc.days.length} days${where ? " " + where : ""}. Mark an item as outdoors (or tag it #outdoor) to be warned when its day looks wet.</p>${out}`;
    },
  },
};
