# Map range view Implementation Plan

> **For agentic workers:** use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** The Locations plugin's Map can show a stretch of days at once, each day's pins in its own colour, to check whether things planned on different days sit near each other.

**Architecture:** Pure helpers in `public/todo/plugins/location.js` (`rangeDays`, `normRange`, `rangeStops`, `dayColor`, all unit-tested in node). `MapView` gets a Day / Range mode: Range draws pins only (no routes or bases), a clickable legend, and per-day lists. Day mode is untouched. No server change.

**Tech Stack:** plain browser JS, Leaflet (already vendored), `node --test`.

## Decisions from the conversation

- Range = any first and last day (not just 7); ‹ › slide the whole window by its own length (**my call**; editing the dates allows any other shift); Today moves the window to start today, keeping its length.
- Switching Day → Range starts on the day being viewed, running 7 days; back to Day returns to the day you were on.
- Pins coloured by day; legend with date and count per day; clicking a legend entry hides or shows that day. Numbers restart at 1 each day.
- Unplaced / no-place events stay listed per day, with Pin buttons as in Day view.
- No route lines, Route ordering or bases in Range. Cap of 14 days (**my call**).
- Out of scope (**my call**): the MCP's `drift_get_map` picture, the phone app and the terminal UI. Say if you want any of them to get ranges too.

## Review Focus

- Range of one day (first = last) behaves like Day without breaking.
- First after last, or longer than the cap → corrected, not an error.
- Event spanning several days appears once per day it covers (each in that day's colour).
- Hidden day stays hidden when the window slides, only while it's still inside it; no stale ids after items change.
- Items with no `event` meta, undated items, or collections without Events: no crash, helpful hint.
- Unplaced events and their Pin buttons work from Range mode.

## Task 1: Range helpers (tests first)

**Files:** modify `public/todo/plugins/location.js`; test `tests/drift-locations.test.mjs`.

**Produces:**
- `MAX_RANGE = 14`
- `rangeDays(first, last) → string[]` (inclusive, capped at MAX_RANGE from `first`; `[]` if either is not `YYYY-MM-DD`; swaps nothing)
- `normRange(first, last, changed) → { first, last }` — `changed` is `"first"` or `"last"`; fixes first > last by moving the *other* end to match, and caps the length by moving the other end
- `rangeStops(items, days) → [{ day, stops, unplaced, elsewhere }]` using `dayStops`
- `dayColor(i) → "hsl(…)"` — golden-angle hue so neighbouring days differ most, lightness varies by index

- [ ] Tests: `rangeDays` inclusive/one-day/cap/bad input; `normRange` both directions and cap; `rangeStops` groups per day, multi-day event appears on each day, numbering restarts per day, unplaced/elsewhere per day; `dayColor` distinct for the first 14 days and deterministic.
- [ ] Run, see fail. Implement. Run, see pass. Commit.

## Task 2: Range mode in the Map view

**Files:** modify `public/todo/plugins/location.js` (`MapView`), `public/todo/index.html` (CSS); test: a DOM-free check that the module still imports in node; manual check in a browser with the dev site.

- [ ] Toolbar: Day / Range toggle; controls tagged `data-only="day"` or `"range"` and shown by mode (first/last date inputs, ‹ ›, Today, Fit in range).
- [ ] `drawRange()`: legend, per-day lists with colour swatches, unplaced/elsewhere sections, label; `drawRangeMap()`: coloured numbered markers keyed `day|id`, popups with the day, no lines/bases, fit when the visible set changes.
- [ ] Clicks: `mode`, `rfirst`/`rlast` (change), `rshift`, `toggleday`, `go`/`open`/`pin` work with keys.
- [ ] Run the whole suite, then look at it in a browser (light and dark, narrow width). Commit.

## Task 3: Docs

**Files:** modify `README.md` (Locations row and a short "Range" paragraph).

- [ ] Write it, run the full suite, commit.
