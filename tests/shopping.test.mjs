// What a recipe's ingredient line puts on a shopping list (src/shopping.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { itemOf, keyOf, gather } from "../src/shopping.js";

test("an ingredient line becomes the food to buy, with the amount kept apart", () => {
  const cases = [
    ["3 cups all-purpose flour, sifted", "All-purpose flour", "3 cups"],
    ["1 1/2 cups milk", "Milk", "1 1/2 cups"],
    ["2 large eggs", "Eggs", "2"],
    ["salt to taste", "Salt", ""],
    ["Salt and pepper, to taste", "Salt and pepper", ""],
    ["2 tbsp butter, melted", "Butter", "2 tbsp"],
    ["1 (15 oz) can black beans, drained and rinsed", "Black beans", "1 can"],
    ["2 cloves garlic, minced", "Garlic", "2 cloves"],
    ["juice of 1 lemon", "Lemon", "1"],
    ["2 cups plus 2 tbsp flour", "Flour", "2 cups plus 2 tbsp"],
    ["a pinch of salt", "Salt", "a pinch"],
    ["2-3 cups chicken broth", "Chicken broth", "2-3 cups"],
    ["1 lb boneless, skinless chicken breasts", "Chicken breasts", "1 lb"],
    ["1 cup freshly grated parmesan", "Parmesan", "1 cup"],
    ["olive oil for frying", "Olive oil", ""],
    ["½ cup unsalted butter (1 stick), softened", "Unsalted butter", "½ cup"],
    ["- 2 eggs", "Eggs", "2"],
    ["100g dark chocolate", "Dark chocolate", "100g"],
    ["2 Tbsp. soy sauce", "Soy sauce", "2 Tbsp."],
    ["1 teaspoon ground cinnamon", "Ground cinnamon", "1 teaspoon"],
    ["2 1/2", "2 1/2", ""],
  ];
  for (const [line, name, amount] of cases) assert.deepEqual(itemOf(line), { name, amount }, line);
});

test("the same food is one item, whatever its plural or case", () => {
  assert.equal(keyOf("Eggs"), keyOf("egg"));
  assert.notEqual(keyOf("Brown sugar"), keyOf("Sugar"));
  assert.deepEqual(gather([
    { line: "2 cups flour", for: "Pancakes" }, { line: "2 eggs", for: "Pancakes" },
    { line: "1 cup Flour", for: "Bread" }, { line: "1 egg", for: "Bread" }, { line: "salt to taste", for: "Bread" },
  ]), [
    { name: "Flour", for: ["Pancakes", "Bread"], needs: ["2 cups for Pancakes", "1 cup for Bread"] },
    { name: "Eggs", for: ["Pancakes", "Bread"], needs: ["2 for Pancakes", "1 for Bread"] },
    { name: "Salt", for: ["Bread"], needs: ["For Bread"] },
  ]);
});
