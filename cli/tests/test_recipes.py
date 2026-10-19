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
