"""
Drift's rules, the same as the web page's (public/todo/lib.js and plugins/):
quick-add parsing, dates, how each view orders items, and the List outline.
No UI here, so it's easy to test.
"""
from __future__ import annotations

import math
import re
import time
from datetime import date, datetime, timedelta

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$")

# Drift's own plugins that bring a view, in the order the page shows them.
VIEW_LABELS = {"checklist": "Checklist", "event": "Calendar", "list": "List", "graph": "Graph", "location": "Map"}
BUILT_IN = {
    "checklist": ("Checklist", "Tick items off as done, with an optional priority."),
    "event": ("Events", "Give items a date and time, and see them on a calendar."),
    "list": ("List", "Arrange items in your own order and nest them as an outline."),
    "graph": ("Graph", "Link items to each other and see them as a network."),
    "location": ("Locations", "Give items a place, found by search or pinned on a map, and see each day's events on a map."),
}
PRIORITY = ["None", "Low", "Medium", "High"]


# ── dates ──────────────────────────────────────────────────────────────────

def today() -> str:
    return date.today().isoformat()


def add_days(n: int, start: str | None = None) -> str:
    d = date.fromisoformat(start) if start else date.today()
    return (d + timedelta(days=n)).isoformat()


def day_of(s: str | None) -> str:
    return str(s or "")[:10]


def time_of(s: str | None) -> str:
    parts = str(s or "").split("T")
    return parts[1] if len(parts) > 1 else ""


WD = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def parse_date(s: str) -> str | None:
    """today, tom, week, +3d, 2w, fri, 2026-11-02, 11/2 → YYYY-MM-DD."""
    s = str(s or "").strip().lower()
    if not s:
        return None
    if s in ("tod", "today", "now"):
        return today()
    if s in ("tom", "tmr", "tomorrow"):
        return add_days(1)
    wd = date.today().weekday()
    if s in ("week", "nextweek", "next-week"):
        return add_days((7 - wd) % 7 or 7)
    m = re.fullmatch(r"\+?(\d+)([dw])", s)
    if m:
        return add_days(int(m[1]) * (7 if m[2] == "w" else 1))
    if len(s) >= 3:
        for i, w in enumerate(WD):
            if w.startswith(s[:3]):
                return add_days((i - wd) % 7 or 7)
    if DATE.match(s):
        try:
            return date.fromisoformat(s).isoformat()
        except ValueError:
            return None
    m = re.fullmatch(r"(\d{1,2})[/-](\d{1,2})", s)
    if m:
        y = date.today().year
        try:
            d = date(y, int(m[1]), int(m[2]))
            if d < date.today():
                d = date(y + 1, int(m[1]), int(m[2]))
        except ValueError:
            return None
        return d.isoformat()
    return None


def parse_time(s: str) -> str | None:
    """9, 9:30, 930, 3pm, 3:15pm, 15:00 → HH:MM."""
    m = re.fullmatch(r"(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a|p)?", str(s or "").strip().lower())
    if not m:
        return None
    h, mins = int(m[1]), int(m[2] or 0)
    if m[3]:
        if not 1 <= h <= 12:
            return None
        h = h % 12 + (12 if m[3][0] == "p" else 0)
    if h > 23 or mins > 59:
        return None
    return f"{h:02d}:{mins:02d}"


# ── places ─────────────────────────────────────────────────────────────────
# A place is {place, lat, lng}: what it's called, and where it is once found.

_NUM = r"(-?\d{1,3}(?:\.\d+)?)"
_LINKS = [re.compile(r"[?&]mlat=(-?[\d.]+)&mlon=(-?[\d.]+)"), re.compile(r"#map=\d+/(-?[\d.]+)/(-?[\d.]+)"), re.compile(r"@(-?[\d.]+),(-?[\d.]+)"),
          re.compile(r"[?&](?:q|query|ll)=(-?[\d.]+)(?:,|%2C)(-?[\d.]+)", re.I), re.compile(r"^geo:(-?[\d.]+),(-?[\d.]+)", re.I)]


def parse_coords(s: str) -> dict | None:
    """"37.80, -122.27", or a map link with coordinates in it → {lat, lng}; None if there are none."""
    t = str(s or "").strip()
    m = re.fullmatch(_NUM + r"\s*[,\s]\s*" + _NUM, t) or next((x for x in (r.search(t) for r in _LINKS) if x), None)
    if not m:
        return None
    try:
        lat, lng = float(m[1]), float(m[2])
    except ValueError:
        return None
    return {"lat": lat, "lng": lng} if abs(lat) <= 90 and abs(lng) <= 180 else None


def place_label(loc: dict) -> str:
    """What to call a place: its name, or its coordinates."""
    if loc.get("place"):
        return loc["place"]
    return f"{loc['lat']:.5f}, {loc['lng']:.5f}" if placed(loc) else ""


def osm_link(loc: dict) -> str:
    return f"https://www.openstreetmap.org/?mlat={loc['lat']}&mlon={loc['lng']}#map=17/{loc['lat']}/{loc['lng']}"


def distance(a: dict, b: dict) -> float:
    """Metres between two {lat, lng}, as the crow flies."""
    r = math.pi / 180
    d_lat, d_lng = (b["lat"] - a["lat"]) * r, (b["lng"] - a["lng"]) * r
    h = math.sin(d_lat / 2) ** 2 + math.cos(a["lat"] * r) * math.cos(b["lat"] * r) * math.sin(d_lng / 2) ** 2
    return 2 * 6371008.8 * math.asin(min(1, math.sqrt(h)))


def nice_distance(m: float, miles: bool = False) -> str:
    if miles:
        mi = m / 1609.344
        return f"{mi:.1f} mi" if mi < 10 else f"{round(mi)} mi"
    if m < 1000:
        return f"{round(m / 10) * 10} m"
    return f"{m / 1000:.1f} km" if m < 10000 else f"{round(m / 1000)} km"


def placed(loc: dict | None) -> bool:
    return bool(loc and loc.get("lat") is not None and loc.get("lng") is not None)


def day_stops(items: list[dict], d: str) -> dict:
    """The Map view's day, as the web page has it: {stops: [{item, n, from}], unplaced, elsewhere}."""
    evs = sorted([it for it in items if it["meta"].get("event") and on_day(it["meta"]["event"], d)], key=by_start)
    stops, unplaced, elsewhere, prev = [], [], [], None
    for it in evs:
        loc = it["meta"].get("location")
        if placed(loc):
            stops.append({"item": it, "n": len(stops) + 1, "from": distance(prev, loc) if prev else None})
            prev = loc
        else:
            (unplaced if loc and loc.get("place") else elsewhere).append(it)
    return {"stops": stops, "unplaced": unplaced, "elsewhere": elsewhere}


def _mercator(lat: float, lng: float) -> tuple[float, float]:
    s = math.sin(math.radians(max(-85.0, min(85.0, lat))))
    return (lng + 180) / 360, 0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)


def stop_label(n: int) -> str:
    return str(n) if n < 10 else chr(ord("A") + n - 10) if n < 36 else "+"


def text_map(stops: list[dict], sel: str | None = None, width: int = 60, height: int = 13, base: dict | None = None) -> dict:
    """The day's stops drawn on a grid of characters, for the terminal's Map view.
    Fits every stop in; with `sel` (an item id) it centres on that stop, still
    with every stop in view. A cell is about twice as tall as it is wide. With
    `base` (a placed {lat, lng}) the route starts and ends there, marked "⌂".
    Returns {cells: rows of characters (" ", "·" for the route, or a stop's
    label), marks: {(row, col): item id, or "base"}, metres: metres across one column}."""
    loc = lambda s: s["item"]["meta"]["location"]
    pts = [(s, *_mercator(loc(s)["lat"], loc(s)["lng"])) for s in stops]
    home = (None, *_mercator(base["lat"], base["lng"])) if stops and placed(base) else None
    every = pts + ([home] if home else [])
    cells = [[" "] * width for _ in range(height)]
    if not pts:
        return {"cells": cells, "marks": {}, "metres": 0.0}
    xs, ys = [p[1] for p in every], [p[2] for p in every]
    lats = [loc(s)["lat"] for s in stops] + ([base["lat"]] if home else [])
    lat0 = sum(lats) / len(lats)
    per_unit = 40075016.686 * math.cos(math.radians(lat0))     # metres in one unit of x at this latitude
    floor = 15 / per_unit                                      # at most 15 m to a column
    dx = max((max(xs) - min(xs)) / max(width - 6, 1), (max(ys) - min(ys)) / max(2 * (height - 2), 1), floor)
    cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    at = next((p for p in pts if p[0]["item"]["id"] == sel), None)
    if at:
        cx, cy = at[1], at[2]
        dx = max([dx] + [abs(x - cx) / max(width / 2 - 2, 1) for x in xs] + [abs(y - cy) / max(height - 2, 1) for y in ys])
    dy = 2 * dx

    def cell(x: float, y: float) -> tuple[int, int]:
        return round((y - cy) / dy + (height - 1) / 2), round((x - cx) / dx + (width - 1) / 2)

    where = [cell(x, y) for _, x, y in pts]
    route = ([cell(home[1], home[2])] if home else []) + where + ([cell(home[1], home[2])] if home else [])
    for (r0, c0), (r1, c1) in zip(route, route[1:]):
        n = max(abs(r1 - r0), abs(c1 - c0))
        for i in range(1, n):
            r, c = round(r0 + (r1 - r0) * i / n), round(c0 + (c1 - c0) * i / n)
            if 0 <= r < height and 0 <= c < width:
                cells[r][c] = "·"
    marks: dict = {}
    if home:
        r, c = route[0]
        if 0 <= r < height and 0 <= c < width:
            cells[r][c], marks[(r, c)] = "⌂", "base"
    for (s, _, _), (r, c) in zip(pts, where):
        if 0 <= r < height and 0 <= c < width:
            # The picked stop stays on top of any it shares a cell with.
            if (r, c) in marks and marks[(r, c)] == sel:
                continue
            cells[r][c] = stop_label(s["n"])
            marks[(r, c)] = s["item"]["id"]
    return {"cells": cells, "marks": marks, "metres": dx * per_unit}


# ── bases and routes ──────────────────────────────────────────────────────
# As public/todo/route.js has them. A collection's bases are where each day
# starts and ends: [{place, lat, lng, from, to}], from and to both None for
# the home base. The site plans the routes (GET /todo/api/route).

PROFILES = {"driving-car": "Drive", "foot-walking": "Walk", "cycling-regular": "Cycle"}
VERB = {"driving-car": "drive", "foot-walking": "walk", "cycling-regular": "ride"}


def is_home(b: dict) -> bool:
    return b.get("from") is None


def base_for(bases: list[dict] | None, d: str) -> dict | None:
    """The base for day `d`: the one that covers it most closely (a day's, then a stretch's), then home."""
    def span(b: dict) -> float:
        return math.inf if is_home(b) else (date.fromisoformat(b["to"]) - date.fromisoformat(b["from"])).days
    best = None
    for b in bases or []:
        if (is_home(b) or b["from"] <= d <= b["to"]) and (best is None or span(b) <= span(best)):
            best = b
    return best


def base_scope(b: dict) -> str:
    if is_home(b):
        return "Home base"
    if b["from"] == b["to"]:
        return "Base for " + nice_day(b["from"])
    return f"Base from {nice_day(b['from'])} to {nice_day(b['to'])}"


def straight_note(r: dict) -> str:
    """Why a route is drawn in straight lines, or "" when it follows the streets."""
    if r.get("off"):
        return "straight lines: the site needs an OpenRouteService key to follow the streets"
    if not r.get("streets"):
        return "straight lines: OpenRouteService didn't send the streets" + (f" ({r['trouble']})" if r.get("trouble") else " just now")
    return "travel times are estimates" if r.get("estimated") else ""


def nice_duration(s: float) -> str:
    """"8 min", "1 h 5 min"."""
    m = max(1, round(s / 60))
    return f"{m} min" if m < 60 else f"{m // 60} h" + (f" {m % 60} min" if m % 60 else "")


def parse_quick(text: str) -> tuple[str, dict]:
    """"Lunch #family +home !2 ^fri @1pm ~ Ferry Building" → ("Lunch", {tags, collection, priority, date, time, place}).
    After "~", plain words are the place."""
    f: dict = {}
    tags, words, place, at = [], [], [], False
    for w in str(text).split():
        if not at and w[0] == "~":
            at, w = True, w[1:]
            if not w:
                continue
        if len(w) > 1 and w[0] == "#":
            tags.append(w[1:].lower())
        elif len(w) > 1 and w[0] == "+":
            f["collection"] = w[1:]
        elif re.fullmatch(r"!{1,3}|![0-3]", w):
            f["priority"] = int(w[1]) if w[1:].isdigit() else len(w)
        elif len(w) > 1 and w[0] == "^" and parse_date(w[1:]):
            f["date"] = parse_date(w[1:])
        elif len(w) > 1 and w[0] == "@" and parse_time(w[1:]):
            f["time"] = parse_time(w[1:])
        else:
            (place if at else words).append(w)
    if tags:
        f["tags"] = tags
    if place:
        f["place"] = " ".join(place)
    return " ".join(words), f


def nice_day(d: str) -> str:
    if not d:
        return ""
    try:
        a = date.fromisoformat(d)
    except ValueError:
        return d
    n = (a - date.today()).days
    if n == 0:
        return "Today"
    if n == 1:
        return "Tomorrow"
    if n == -1:
        return "Yesterday"
    if -7 < n < 0:
        return f"{-n} days ago"
    if 0 < n < 7:
        return a.strftime("%A")
    return f"{a.strftime('%b')} {a.day}" + (f", {a.year}" if a.year != date.today().year else "")


def nice_time(t: str) -> str:
    if not t:
        return ""
    h, m = (int(x) for x in t.split(":")[:2])
    return f"{(h % 12) or 12}{f':{m:02d}' if m else ''}{'pm' if h >= 12 else 'am'}"


def when(event: dict) -> str:
    t, et = time_of(event["start"]), time_of(event.get("end"))
    if not t:
        return "All day"
    return nice_time(t) + (f"–{nice_time(et)}" if et and day_of(event.get("end")) == day_of(event["start"]) else "")


def event_chip(event: dict) -> str:
    d, t = day_of(event["start"]), time_of(event["start"])
    out = nice_day(d) + (f" {nice_time(t)}" if t else "")
    if event.get("end") and day_of(event["end"]) != d:
        out += f" – {nice_day(day_of(event['end']))}"
    return out


# ── items ──────────────────────────────────────────────────────────────────

def is_open(it: dict) -> bool:
    return not (it["meta"].get("checklist") or {}).get("done")


def is_late(it: dict) -> bool:
    ev = it["meta"].get("event")
    return bool(ev) and is_open(it) and day_of(ev.get("end") or ev["start"]) < today()


def on_day(event: dict, d: str) -> bool:
    return day_of(event["start"]) <= d <= day_of(event.get("end") or event["start"])


def by_start(it: dict):
    s = it["meta"]["event"]["start"]
    return (len(s), s)


def day_plan(events: list[dict], d: str, now_hour: int | None = None) -> dict:
    """One day for the hour-by-hour view, as the web's Calendar draws it: items with
    no time slot that day (all-day ones, and timed ones carried over from an earlier
    day), timed items by the hour they start, the hours a timed item runs through,
    and the range of hours to show (8am–8pm, stretched to fit)."""
    untimed: list[dict] = []
    hours: dict[int, list[dict]] = {}
    busy: set[int] = set()
    lo, hi = 8, 20
    for it in events:
        ev = it["meta"]["event"]
        if not on_day(ev, d):
            continue
        if not time_of(ev["start"]) or day_of(ev["start"]) != d:
            untimed.append(it)
            continue
        h = int(time_of(ev["start"])[:2])
        hours.setdefault(h, []).append(it)
        end = ev.get("end")
        last = h
        if end and time_of(end):
            last = max(h, int(time_of(end)[:2]) - (1 if end.endswith(":00") else 0)) if day_of(end) == d else 23
        busy.update(range(h, last + 1))
        lo, hi = min(lo, h), max(hi, last)
    if now_hour is not None:
        lo, hi = min(lo, now_hour), max(hi, now_hour)
    for lst in hours.values():
        lst.sort(key=by_start)
    untimed.sort(key=by_start)
    return {"untimed": untimed, "hours": hours, "busy": busy, "lo": lo, "hi": hi}


def checklist_rank(it: dict):
    m = it["meta"]
    return (-(m["checklist"].get("priority") or 0), (m.get("event") or {}).get("start") or "9999",
            (m.get("list") or {}).get("order") or 0, it.get("created") or "")


def list_order(it: dict) -> float:
    o = (it["meta"].get("list") or {}).get("order")
    if o is not None:
        return float(o)
    try:   # items never placed sort by when they were made
        return datetime.fromisoformat((it.get("created") or "1970-01-01T00:00:00") + "+00:00").timestamp()
    except ValueError:
        return 0.0


def outline(items: list[dict]) -> tuple[dict, dict]:
    """parent id (or None) → ordered children, ignoring parents that are gone or would loop."""
    by_id = {it["id"]: it for it in items}

    def raw(it):
        p = (it["meta"].get("list") or {}).get("parent")
        return p if p in by_id else None

    parent_of = {}
    for it in items:
        p, q, seen = raw(it), raw(it), {it["id"]}
        while q:
            if q in seen:
                p = None
                break
            seen.add(q)
            q = raw(by_id[q])
        parent_of[it["id"]] = p
    kids: dict = {}
    for it in items:
        kids.setdefault(parent_of[it["id"]], []).append(it)
    for lst in kids.values():
        lst.sort(key=list_order)
    return parent_of, kids


def walk_outline(items: list[dict]) -> list[tuple[dict, int]]:
    _, kids = outline(items)
    out = []

    def walk(p, depth):
        for it in kids.get(p, []):
            out.append((it, depth))
            walk(it["id"], depth + 1)
    walk(None, 0)
    return out


def list_move(item: dict, scope: list[dict], how: str) -> dict | None:
    """The new meta.list for moving an item in/out/up/down the outline, or None if it can't move."""
    parent_of, kids = outline(scope)
    parent = parent_of.get(item["id"])
    sibs = kids.get(parent, [])
    i = next((n for n, s in enumerate(sibs) if s["id"] == item["id"]), -1)
    if i < 0:
        return None
    if how == "indent":
        if i < 1:
            return None
        np = sibs[i - 1]
        last = kids.get(np["id"], [])
        return {"parent": np["id"], "order": list_order(last[-1]) + 1 if last else list_order(np)}
    if how == "outdent":
        if not parent:
            return None
        grand = parent_of.get(parent)
        up = kids.get(grand, [])
        j = next(n for n, s in enumerate(up) if s["id"] == parent)
        nxt = up[j + 1] if j + 1 < len(up) else None
        return {"parent": grand, "order": (list_order(up[j]) + list_order(nxt)) / 2 if nxt else list_order(up[j]) + 1}
    if how == "up" and i > 0:
        a, b = (sibs[i - 2] if i > 1 else None), sibs[i - 1]
        return {"parent": parent, "order": (list_order(a) + list_order(b)) / 2 if a else list_order(b) - 1}
    if how == "down" and i < len(sibs) - 1:
        a, b = sibs[i + 1], (sibs[i + 2] if i + 2 < len(sibs) else None)
        return {"parent": parent, "order": (list_order(a) + list_order(b)) / 2 if b else list_order(a) + 1}
    return None


def fresh_meta(plugins: list[str], quick: dict, *, dated_view: bool = False, day: str | None = None) -> dict:
    """What a new item starts with, from the plugins that are on (each plugin's fresh()).
    On Today, Calendar and the Map every item gets a date, so it shows up where you added it."""
    meta: dict = {}
    if "checklist" in plugins:
        meta["checklist"] = {"done": False, "priority": quick.get("priority", 0)}
    if "event" in plugins or dated_view:
        if quick.get("date") or quick.get("time") or dated_view:
            d = quick.get("date") or day or today()
            meta["event"] = {"start": f"{d}T{quick['time']}" if quick.get("time") else d, "end": None}
    if "list" in plugins:
        meta["list"] = {"order": time.time(), "parent": None}
    if "graph" in plugins:
        meta["graph"] = {"links": [], "x": None, "y": None}
    if "location" in plugins and quick.get("place"):
        meta["location"] = {"place": quick["place"], "lat": None, "lng": None}
    return meta
