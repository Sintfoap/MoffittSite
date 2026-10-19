"""Scaling recipes, as public/recipes/scale.js does on the website: the
quantity at the start of an ingredient line ("1 1/2 cups", "1½", "2-3 cloves")
is multiplied and written back as a kitchen fraction where one is close.
tests/scale_cases.json is shared with the site's tests, so the two agree."""
from __future__ import annotations

import math
import re

GLYPHS = {"¼": 1 / 4, "½": 1 / 2, "¾": 3 / 4, "⅓": 1 / 3, "⅔": 2 / 3, "⅕": 1 / 5, "⅖": 2 / 5, "⅗": 3 / 5, "⅘": 4 / 5,
          "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8}
_G = "".join(GLYPHS)
_AMOUNT = rf"(?:\d+\s*[{_G}]|\d+\s+\d+/\d+|\d+/\d+|\d+(?:[.,]\d+)?|[{_G}])"
_LEAD = re.compile(rf"^(\s*(?:[-*•]\s+)?)({_AMOUNT})(?:(\s*(?:-|–|—|to|or)\s*)({_AMOUNT}))?", re.I)

NICE = [(0, ""), (1 / 8, "⅛"), (1 / 4, "¼"), (1 / 3, "⅓"), (3 / 8, "⅜"), (1 / 2, "½"), (5 / 8, "⅝"), (2 / 3, "⅔"),
        (3 / 4, "¾"), (7 / 8, "⅞"), (1, "")]
NEAR = 0.04


def amount(text: str) -> float:
    s = text.strip()
    if m := re.fullmatch(rf"(\d+)\s*([{_G}])", s):
        return int(m[1]) + GLYPHS[m[2]]
    if m := re.fullmatch(r"(\d+)\s+(\d+)/(\d+)", s):
        return int(m[1]) + int(m[2]) / int(m[3]) if int(m[3]) else math.nan
    if m := re.fullmatch(r"(\d+)/(\d+)", s):
        return int(m[1]) / int(m[2]) if int(m[2]) else math.nan
    if s in GLYPHS:
        return GLYPHS[s]
    try:
        return float(s.replace(",", "."))
    except ValueError:
        return math.nan


def _round2(n: float) -> str:
    # Like JavaScript's String(Math.round(n * 100) / 100).
    r = math.floor(n * 100 + 0.5) / 100
    return str(int(r)) if r == int(r) else repr(r)


def format_amount(n: float) -> str:
    if not math.isfinite(n) or n <= 0:
        return "0"
    whole = math.floor(n)
    frac = n - whole
    best = NICE[0]
    for c in NICE:
        if abs(frac - c[0]) < abs(frac - best[0]):
            best = c
    if abs(frac - best[0]) <= NEAR:
        w = whole + 1 if best[0] == 1 else whole
        return (f"{w}{best[1]}" if w else best[1]) if best[1] else str(w)
    return _round2(n)


def scale_line(line: str, factor: float) -> str:
    text = str(line or "")
    if not math.isfinite(factor) or factor <= 0 or factor == 1:
        return text
    m = _LEAD.match(text)
    if not m:
        return text
    a = amount(m[2])
    b = None if m[4] is None else amount(m[4])
    if not math.isfinite(a) or (b is not None and not math.isfinite(b)):
        return text
    out = format_amount(a * factor) + ("" if b is None else m[3] + format_amount(b * factor))
    return m[1] + out + text[m.end():]


def factor_for(recipe: dict, servings: float | None = None, factor: float | None = None) -> float:
    if recipe.get("servings") and servings and servings > 0:
        f = servings / recipe["servings"]
    else:
        f = factor or 1
    return min(100, max(0.05, f))
