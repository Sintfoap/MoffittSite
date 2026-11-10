"""Recipe scaling in the terminal matches the website's (public/recipes/scale.js)."""
import json
from pathlib import Path

from sintfoap import recipe_rules as R

CASES = json.loads(Path(__file__).with_name("scale_cases.json").read_text())


def test_scaling_matches_the_website():
    for line, factor, want in CASES:
        assert R.scale_line(line, factor) == want, (line, factor)


def test_factor_from_servings_or_a_plain_multiplier():
    assert R.factor_for({"servings": 4}, servings=6) == 1.5
    assert R.factor_for({"servings": None}, factor=2) == 2
    assert R.factor_for({"servings": 4}) == 1


def test_an_export_is_cut_into_recipes_as_on_the_website():
    html = '<html><div class="recipe-details">one</div>\n<div class="recipe-details">two</div></html>'
    assert R.split_pages(html) == ['<div class="recipe-details">one</div>\n', '<div class="recipe-details">two</div></html>']
    assert R.split_pages("<p>a saved page</p>") == ["<p>a saved page</p>"]
    assert R.split_pages("  ") == []
    assert [len(b) for b in R.batches(["a", "b", "c"], 2)] == [2, 1]
    assert [len(b) for b in R.batches(["aaaa", "bbbb", "c"], 10, 6)] == [1, 2]
    assert R.skipped_summary([{"why": "had no recipe"}, {"why": "already in your box"}, {"why": "had no recipe"}]) == "2 had no recipe, 1 already in your box"


def test_an_export_piece_points_at_its_picture():
    assert R.photo_of('<img src="images/a1_0.jpg" class="recipe-photo"/>') == "images/a1_0.jpg"
    assert R.photo_of('<img src="https://x.test/a.jpg" class="recipe-photo">') == ""
    assert R.photo_of("<p>none</p>") == ""
    assert R.file_key("export/images/A1_0.JPG") == "a1_0.jpg"
    assert R.file_key("images\\b%202.jpg") == "b 2.jpg"


def test_tesseracts_tsv_becomes_lines_with_their_words():
    from sintfoap import site
    tsv = "\n".join([
        "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
        "4\t1\t1\t1\t1\t0\t10\t20\t300\t30\t-1\t",
        "5\t1\t1\t1\t1\t1\t10\t20\t40\t30\t96.5\t2",
        "5\t1\t1\t1\t1\t2\t60\t22\t80\t28\t91.0\tcups",
        "5\t1\t1\t1\t1\t3\t400\t20\t60\t30\t90.0\tMix.",
        "5\t1\t1\t1\t2\t1\t10\t60\t40\t30\t95\t ",
    ])
    [line] = site.tesseract_lines(tsv)
    assert line["text"] == "2 cups Mix."
    assert line["bbox"] == {"x0": 10, "y0": 20, "x1": 460, "y1": 50}
    assert [w["text"] for w in line["words"]] == ["2", "cups", "Mix."]
    assert round(line["confidence"], 1) == 92.5


def _page(photo=None, shadow=False, lines=18):
    """A cream page 200×280 (RGB) with text lines of dark specks and, if asked, a photo of noisy colour,
    as tests/recipe-picture.test.mjs draws it for the website."""
    W, H = 200, 280
    px = bytearray(W * H * 3)
    seed = 7

    def rnd():
        nonlocal seed
        seed = (seed * 1103515245 + 12345) % 2147483648
        return seed / 2147483648
    for y in range(H):
        for x in range(W):
            i, dim = (y * W + x) * 3, max(0, 60 - x) if shadow else 0
            px[i:i + 3] = bytes((245 - dim, 240 - dim, 228 - dim))
    text, top = [], photo["y1"] + 8 if photo else 12
    for n in range(lines):
        y0 = top + n * 12
        box = {"x0": 14, "y0": y0, "x1": 186, "y1": y0 + 7}
        if box["y1"] >= H:
            break
        text.append(box)
        for y in range(box["y0"], box["y1"]):
            for x in range(box["x0"], box["x1"]):
                if rnd() < 0.35:
                    i = (y * W + x) * 3
                    px[i:i + 3] = b"\x1e\x1e\x1e"
    if photo:
        for y in range(photo["y0"], photo["y1"]):
            for x in range(photo["x0"], photo["x1"]):
                i = (y * W + x) * 3
                px[i:i + 3] = bytes((int(120 + rnd() * 120), int(60 + rnd() * 90), int(20 + rnd() * 60)))
    return W, H, bytes(px), text


def test_the_dishs_photo_is_found_on_the_page_as_on_the_website():
    got = R.find_picture(*_page(photo={"x0": 20, "y0": 10, "x1": 180, "y1": 120}))
    assert got and abs(got["x0"] - 0.1) < 0.04 and abs(got["x1"] - 0.9) < 0.04
    assert abs(got["y0"] - 10 / 280) < 0.04 and abs(got["y1"] - 120 / 280) < 0.04
    assert R.find_picture(*_page(lines=22)) is None                  # only text
    assert R.find_picture(*_page(shadow=True, lines=22)) is None     # a shadow isn't a photo
    assert R.find_picture(*_page(photo={"x0": 90, "y0": 10, "x1": 106, "y1": 24})) is None  # a small spot
