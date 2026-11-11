// Whether a recipe already reads as English, so "Translate to English" is
// offered only for the ones that don't. It's a guess from common words: the
// translate key (E) still works on any recipe. The terminal UI has the same
// rule (cli/sintfoap/recipe_rules.py, looks_english), checked against the same
// cases in tests.

const WORDS = new Set(`a an and or the of to in on with for into over from until about at by as is it its
  then than this that these your you be are can if not until while when each per few more less
  cup cups tbsp tsp tablespoon tablespoons teaspoon teaspoons oz ounce ounces lb lbs pound pounds g gram grams kg ml liter litre
  pinch dash clove cloves can cans package stick sticks slice slices piece pieces large medium small whole half quarter
  chopped diced minced sliced grated melted softened beaten fresh dried ground frozen optional taste divided peeled
  salt pepper oil butter sugar flour egg eggs water milk cream cheese onion onions garlic lemon juice sauce rice chicken beef pork
  add mix stir bake cook heat boil simmer serve place combine whisk pour cover remove let set aside preheat oven pan bowl
  minutes minute hour hours degrees until golden brown top bottom side sides together well into large`.split(/\s+/));

// The recipe's words: its title, ingredients, steps and notes.
export function recipeWords(r) {
  const text = [r.title, ...(r.ingredients || []), ...(r.steps || []), r.notes].filter(Boolean).join(" ");
  return text.toLowerCase().match(/\p{L}+/gu) || [];
}

// true unless the words look like another language: mostly letters outside
// English's alphabet, or few of English's everyday cooking words. Too few
// words to tell counts as English, so a short recipe isn't nagged about.
export function looksEnglish(r) {
  const words = recipeWords(r);
  if (words.length < 6) return true;
  const foreign = words.filter(w => /[^a-z]/.test(w)).length;
  if (foreign / words.length > 0.2) return false;
  const known = words.filter(w => WORDS.has(w)).length;
  return known / words.length >= 0.2;
}
