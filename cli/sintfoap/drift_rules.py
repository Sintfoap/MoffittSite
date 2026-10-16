"""
Drift's rules, the same as the web page's (public/todo/lib.js and plugins/):
quick-add parsing, dates, how each view orders items, and the List outline.
No UI here, so it's easy to test.
"""
from __future__ import annotations

import re
import time
from datetime import date, datetime, timedelta

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$")

# Drift's own plugins that bring a view, in the order the page shows them.
VIEW_LABELS = {"checklist": "Checklist", "event": "Calendar", "list": "List", "graph": "Graph"}
BUILT_IN = {
    "checklist": ("Checklist", "Tick items off as done, with an optional priority."),
    "event": ("Events", "Give items a date and time, and see them on a calendar."),
    "list": ("List", "Arrange items in your own order and nest them as an outline."),
    "graph": ("Graph", "Link items to each other and see them as a network."),
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


def parse_quick(text: str) -> tuple[str, dict]:
    """"Call Sam #family +home !2 ^fri @3pm" → ("Call Sam", {tags, collection, priority, date, time})."""
    f: dict = {}
    tags, words = [], []
    for w in str(text).split():
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
            words.append(w)
    if tags:
        f["tags"] = tags
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
    On Today and Calendar every item gets a date, so it shows up where you added it."""
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
    return meta
