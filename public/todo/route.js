// Bases and route planning for Locations' Map view. Shared by the page, the
// phone app and the Worker (which plans the routes, src/routing.js), so
// nothing here touches the DOM.
//
// A collection's bases are where each day starts and ends:
//   collection.bases = [{ place, lat, lng, from, to }]
//     from, to   "YYYY-MM-DD": the days it's the base for (from = to for one day),
//                both null for the home base, the base on every other day
// The base for a day is the one that covers it most closely: a single day's
// beats a stretch of days, and any of them beats home.
//
// A day's route visits its places in an order that keeps to, first, the
// events' times, then their links in the Graph plugin: items joined by a link
// are visited one after the other, in either order for a plain link and in
// the link's direction for a typed one ("leads to", "depends on" …). Within
// that, the orders are ranked by how long the travel takes, and the few best
// are offered to cycle between.

import { DATE } from "./lib.js";

export const MAX_BASES = 100;
export const PROFILES = { "driving-car": "Drive", "foot-walking": "Walk", "cycling-regular": "Cycle" };
export const isHome = b => b.from == null;

// Checks and tidies a collection's bases. `cleanPlace` is Locations' clean().
export function cleanBases(v, fail, cleanPlace) {
  if (!Array.isArray(v)) fail("bases must be a list");
  if (v.length > MAX_BASES) fail(`a collection can have at most ${MAX_BASES} bases`);
  const out = [];
  for (const b of v) {
    if (!b || typeof b !== "object" || Array.isArray(b)) fail("each base must be an object");
    const loc = cleanPlace(b, fail);
    if (!loc.place && loc.lat == null) fail("a base needs a place");
    const from = b.from ?? null, to = b.to ?? b.from ?? null;
    if ((from === null) !== (to === null)) fail("a base's from and to go together");
    if (from !== null && (!DATE.test(from) || !DATE.test(to))) fail("a base's from and to must be dates (YYYY-MM-DD)");
    if (from !== null && to < from) fail("a base can't end before it starts");
    out.push({ ...loc, from, to });
  }
  // One home base: the last one sent.
  const home = out.findLast(isHome);
  return out.filter(b => !isHome(b) || b === home);
}

const span = b => isHome(b) ? Infinity : (Date.parse(b.to) - Date.parse(b.from));
// The base for day `d`, or null. Ties go to the one added last.
export function baseFor(bases, d) {
  let best = null;
  for (const b of bases || []) if (isHome(b) || (b.from <= d && d <= b.to)) if (!best || span(b) <= span(best)) best = b;
  return best;
}

// "Home", "This day", "1 Oct – 5 Oct" for a base on day `d`.
export function baseScope(b, niceDay) {
  if (isHome(b)) return "Home base";
  if (b.from === b.to) return "Base for " + niceDay(b.from);
  return `Base from ${niceDay(b.from)} to ${niceDay(b.to)}`;
}

const mins = t => t ? +t.slice(0, 2) * 60 + +t.slice(3, 5) : null;
const SLACK = 5 * 60;            // arriving up to five minutes late isn't late
const LATE_WEIGHT = 20;          // a minute late counts as twenty minutes more travel

// The best orders to visit `stops` in, best first.
//   stops   [{ id, start, end }]  start and end "HH:MM" on the day, or "" for no set time
//   links   [{ a, b, type }]      Graph's edges(); a typed link goes from a to b
//   dur     seconds of travel between points, dur[i][j]; the points are the base
//           (when `base`) and then the stops, in the order given
//   dist    metres between the same points, or null
// Each option is { order: [ids], duration, distance, late: [ids] }: the
// travel, with the way back to the base, and the timed stops you'd reach late.
// `loose` is true when the links couldn't all be kept, and were kept as
// "before" only.
export function planRoutes(stops, links, dur, { base = false, dist = null, k = 5, budget = 20000 } = {}) {
  const n = stops.length, o = base ? 1 : 0;
  if (!n) return { options: [], loose: false };
  const at = new Map(stops.map((s, i) => [s.id, i]));
  const start = stops.map(s => mins(s.start)), end = stops.map(s => mins(s.end));
  const timed = stops.map((_, i) => i).filter(i => start[i] != null).sort((a, b) => start[a] - start[b]);
  const rank = new Map(timed.map((i, r) => [i, r]));

  // Links between the day's stops: groups of linked stops stay together, and a
  // typed link puts its ends in its direction (unless their times say otherwise).
  const group = stops.map((_, i) => i), find = i => group[i] === i ? i : (group[i] = find(group[i]));
  const before = stops.map(() => []);
  for (const { a, b, type } of links) {
    const i = at.get(a), j = at.get(b);
    if (i == null || j == null || i === j) continue;
    group[find(i)] = find(j);
    if (type && !(rank.has(i) && rank.has(j) && rank.get(i) > rank.get(j))) before[j].push(i);
  }
  const g = stops.map((_, i) => find(i)), size = {};
  for (const r of g) size[r] = (size[r] || 0) + 1;

  const search = (together, ordered) => {
    const best = [], used = new Array(n).fill(false), seq = [], left = { ...size };
    let steps = 0;
    const worst = () => best.length < k ? Infinity : best[best.length - 1].score;
    const go = (last, travel, score, clock, nextTimed, open, late) => {
      if (++steps > budget) return;
      if (seq.length === n) {
        const back = base ? dur[last][0] : 0, total = score + back;
        if (total >= worst()) return;
        best.push({ order: seq.slice(), travel: travel + back, score: total, late: late.slice() });
        best.sort((x, y) => x.score - y.score);
        if (best.length > k) best.pop();
        return;
      }
      const next = [];
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        if (rank.has(i) && rank.get(i) !== nextTimed) continue;
        if (ordered && before[i].some(p => !used[p])) continue;
        if (together && open != null && g[i] !== open) continue;
        next.push([last == null ? 0 : dur[last][i + o], i]);
      }
      next.sort((x, y) => x[0] - y[0]);
      for (const [t, i] of next) {
        if (score + t >= worst()) break;
        // The clock starts at the first timed stop (you leave the base in time for it).
        let c = clock == null ? null : clock + t, lateBy = 0;
        if (start[i] != null) {
          if (c != null && c > start[i] * 60 + SLACK) lateBy = c - start[i] * 60;
          c = Math.max(c ?? 0, start[i] * 60) + Math.max(0, ((end[i] ?? start[i]) - start[i]) * 60);
        }
        used[i] = true; seq.push(stops[i].id); left[g[i]]--;
        if (lateBy) late.push(stops[i].id);
        go(i + o, travel + t, score + t + lateBy * LATE_WEIGHT, c, nextTimed + (rank.has(i) ? 1 : 0), left[g[i]] ? g[i] : null, late);
        if (lateBy) late.pop();
        used[i] = false; seq.pop(); left[g[i]]++;
      }
    };
    go(base ? 0 : null, 0, 0, null, 0, null, []);
    return best;
  };
  let loose = false, found = search(true, true);
  if (!found.length) { loose = true; found = search(false, true); }
  if (!found.length) found = search(false, false);

  const options = found.map(r => {
    const ids = r.order.map(id => at.get(id) + o), path = base ? [0, ...ids, 0] : ids;
    let distance = null;
    if (dist) { distance = 0; for (let x = 1; x < path.length; x++) distance += dist[path[x - 1]][path[x]]; }
    return { order: r.order, duration: Math.round(r.travel), distance: distance == null ? null : Math.round(distance), late: r.late };
  });
  return { options, loose };
}

// "8 min", "1 h 5 min"
export function niceDuration(s) {
  const m = Math.max(1, Math.round(s / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
