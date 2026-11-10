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
