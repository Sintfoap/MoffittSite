"""Getting a photo ready for tesseract, and putting right what it misreads most
in recipes: the fractions. As public/recipes/ocr.js does on the website.

ink(image): the photo the right way up, at a size tesseract reads well, as
clean black ink on white: each pixel is compared with the paper around it
(Sauvola's threshold, on the darkest of its red, green and blue), so ruled
lines, coloured ink, shadows and tinted paper aren't read as text.

fix_fractions(ink, lines): tesseract's English has no ½ ¼ ¾ ⅓, so it reads them
as %, ¥, Y2, 14 or a lone 1. The first word of each line that looks like one of
those is compared, shape for shape, with the fractions drawn in a serif and a
sans-serif type found on this computer (and with whole numbers, so a real "1"
stays a 1), and the closest wins.

Both need Pillow (pip install pillow); without it the photo goes to tesseract as it is."""
from __future__ import annotations

import math
import re

LONG, SHORTEST = 2400, 1600   # the longer side: at most 2400, at least 1600


def ink(im):
    """(the photo upright and sized, its black-and-white copy, the scale from the stored photo)."""
    from PIL import Image, ImageChops, ImageFilter, ImageMath, ImageOps
    im = ImageOps.exif_transpose(im).convert("RGB")
    long = max(im.size)
    k = LONG / long if long > LONG else SHORTEST / long if long < SHORTEST else 1.0
    if k != 1:
        im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.Resampling.LANCZOS)
    r, g, b = im.split()
    gray = ImageChops.darker(ImageChops.darker(r, g), b)
    rad = max(4, round(max(im.size) / 40))
    mean = gray.filter(ImageFilter.BoxBlur(rad))
    msq = gray.point(lambda v: v * v // 255).filter(ImageFilter.BoxBlur(rad))   # the mean of the squares, over 255
    ev = getattr(ImageMath, "unsafe_eval", None) or ImageMath.eval
    bw = ev("convert((g >= m * (1 + 0.2 * (((s * 255 - m * m) * (s * 255 > m * m)) ** 0.5 / 128 - 1))) * 255, 'L')",
            g=gray.convert("F"), m=mean.convert("F"), s=msq.convert("F"))
    return im, bw, k


# ── the fractions ───────────────────────────────────────────────────────────

FRACTIONS = ["½", "¼", "¾", "⅓", "⅔", "⅛"]
WHOLE = ["", "1", "2", "3"]
SUSPECT = re.compile(r"^\d?(?:[%¥£§®©°¢»«$&@#*]{1,2}|[Yy][a-z0-9]?|[Il|][/:]?\d|1[2348]|\d/\d)$")
SIZE = 32
FONTS = {
    "serif": ["DejaVuSerif.ttf", "LiberationSerif-Regular.ttf", "Times New Roman.ttf", "times.ttf", "Georgia.ttf", "georgia.ttf",
              "/System/Library/Fonts/Supplemental/Times New Roman.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
              "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf"],
    "sans": ["DejaVuSans.ttf", "LiberationSans-Regular.ttf", "Arial.ttf", "arial.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"],
}


def _tight(img) -> tuple[int, list[int]] | None:
    """An 'L' picture's dark pixels, cut tight and scaled to SIZE high: (width, pixels as 0/1)."""
    from PIL import Image
    box = img.point(lambda v: 255 if v < 128 else 0).getbbox()
    if not box:
        return None
    crop = img.crop(box)
    w = max(1, round(crop.width * SIZE / crop.height))
    small = crop.resize((w, SIZE), Image.Resampling.NEAREST)
    return w, [1 if v < 128 else 0 for v in small.tobytes()]


_fonts: list | None = None


def _found_fonts() -> list:
    global _fonts
    if _fonts is None:
        from PIL import ImageFont
        _fonts = []
        for names in FONTS.values():
            for name in names:
                try:
                    _fonts.append(ImageFont.truetype(name, 80))
                    break
                except OSError:
                    continue
    return _fonts


def _draw(text: str, fraction: bool) -> list[dict]:
    from PIL import Image, ImageDraw
    out = []
    for font in _found_fonts():
        im = Image.new("L", (320, 120), 255)
        ImageDraw.Draw(im).text((10, 10), text, font=font, fill=0)
        s = _tight(im)
        if s:
            out.append({"text": text, "fraction": fraction, "w": s[0], "px": s[1]})
    return out


_drawn: list | None = None


def _candidates() -> list[dict]:
    global _drawn
    if _drawn is None:
        _drawn = [c for whole in WHOLE for f in FRACTIONS + [""] if whole + f for c in _draw(whole + f, bool(f))]
    return _drawn


def _soft(w0: int, px: list[int], w: int) -> list[float]:
    out = [0.0] * (w * SIZE)
    for y in range(SIZE):
        for x in range(w):
            n = 0
            for dy in range(-2, 3):
                yy = y + dy
                if not 0 <= yy < SIZE:
                    continue
                for dx in range(-2, 3):
                    xx = math.floor((x + dx + 0.5) * w0 / w)
                    if 0 <= xx < w0:
                        n += px[yy * w0 + xx]
            out[y * w + x] = n
    return out


def _alike(a: tuple[int, list[int]], b: dict) -> float:
    """As ocr.js's alike(): softened ink compared at the word's width, whole and lower right."""
    aw = a[0]
    if b["w"] / aw > 1.6 or aw / b["w"] > 1.6:
        return 0.0
    sa, sb = _soft(aw, a[1], aw), _soft(b["w"], b["px"], aw)

    def cos(x0: int, y0: int) -> float:
        ab = aa = bb = 0.0
        for y in range(y0, SIZE):
            for x in range(x0, aw):
                p, q = sa[y * aw + x], sb[y * aw + x]
                ab += p * q
                aa += p * p
                bb += q * q
        return ab / (math.sqrt(aa * bb) or 1)
    return (cos(0, 0) + cos(aw // 2, SIZE // 2)) / 2 * (1 - 0.25 * abs(math.log(aw / b["w"])))


def _closest(shape, read: str) -> str | None:
    best, best_whole = None, 0.0
    extra = _draw(read, False) if re.fullmatch(r"\d{2,3}", read) else []
    for c in _candidates() + extra:
        s = _alike(shape, c)
        if not c["fraction"]:
            best_whole = max(best_whole, s)
        if best is None or s > best[0]:
            best = (s, c["text"], c["fraction"])
    return best[1] if best and best[2] and best[0] > 0.75 and best[0] > best_whole + 0.03 else None


def _suspect(line: dict) -> bool:
    ws = line.get("words") or []
    if len(ws) < 2:
        return False
    w, t = ws[0], ws[0]["text"].strip()
    if SUSPECT.match(t):
        return True
    if re.fullmatch(r"\d", t):
        b = w["bbox"]
        return (b["x1"] - b["x0"]) / ((b["y1"] - b["y0"]) or 1) > 0.6 or w.get("confidence", 100) < 85
    return False


def fix_fractions(bw, lines: list[dict]) -> int:
    """Puts the fractions right in tesseract's lines (in `bw`'s pixels), in place: how many it changed."""
    if not _found_fonts():
        return 0
    n = 0
    for line in lines:
        if not _suspect(line):
            continue
        w = line["words"][0]
        b = w["bbox"]
        crop = bw.crop((max(0, b["x0"] - 2), max(0, b["y0"] - 2), min(bw.width, b["x1"] + 2), min(bw.height, b["y1"] + 2)))
        shape = _tight(crop)
        got = shape and _closest(shape, w["text"].strip())
        if not got or got == w["text"]:
            continue
        line["text"] = line["text"].replace(w["text"], got, 1)
        w["text"] = got
        n += 1
    return n
