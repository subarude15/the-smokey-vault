import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findRecipesForBottle,
  generatedRecipeIncludesBottle,
  guestSafeRecipe,
  mixologistRequiredBottlePrompt,
  moduleSupportsFindDrink,
  recipeIngredientMatchesBottle,
  shelfBottleFromItem,
  shelfKindForModule
} from "./cocktails.js";

const captainMorgan = {
  name: "Original Spiced Rum",
  brand: "Captain Morgan",
  category: "Rum",
  sub_category: "Spiced",
  fill_level: 80,
  stock_count: 1,
  upc: "087000201156"
};

const titos = {
  name: "Handmade Vodka",
  brand: "Tito's",
  category: "Vodka",
  fill_level: 100,
  stock_count: 1,
  upc: "619947000019"
};

const makers = {
  name: "Maker's Mark",
  brand: "Maker's Mark",
  category: "Whiskey",
  sub_category: "Bourbon",
  fill_level: 100,
  stock_count: 2
};

test("A. Captain Morgan matches a spiced rum recipe ingredient", () => {
  const bottle = shelfBottleFromItem(captainMorgan, "spirit");
  assert.equal(recipeIngredientMatchesBottle("2 oz spiced rum", bottle), true);
});

test("B. Tito's matches a vodka recipe ingredient", () => {
  const bottle = shelfBottleFromItem(titos, "spirit");
  assert.equal(recipeIngredientMatchesBottle("1.5 oz vodka", bottle), true);
});

test("C. Maker's Mark matches a bourbon recipe ingredient", () => {
  const bottle = shelfBottleFromItem(makers, "spirit");
  assert.equal(recipeIngredientMatchesBottle("2 oz. Bourbon", bottle), true);
  assert.equal(recipeIngredientMatchesBottle("1½ oz bourbon", bottle), true);
});

test("D. Gin does not match ginger ale", () => {
  const bottle = shelfBottleFromItem({ name: "London Dry", brand: "Beefeater", category: "Gin", fill_level: 100, stock_count: 1 }, "spirit");
  assert.equal(recipeIngredientMatchesBottle("ginger ale", bottle), false);
});

test("E. Rum does not match rum extract", () => {
  const bottle = shelfBottleFromItem(captainMorgan, "spirit");
  assert.equal(recipeIngredientMatchesBottle("1 tsp rum extract", bottle), false);
});

test("F. Existing matching recipes are returned before any AI fallback is needed", () => {
  const recipes = [
    { name: "Vodka Soda", ingredients: ["1.5 oz vodka", "soda water"], collection: "IBA Classics", readiness: "missing" },
    { name: "Spiced Daiquiri", ingredients: ["2 oz spiced rum", "1 oz lime juice", "0.75 oz simple syrup"], collection: "Custom Cocktails" },
    { name: "Gin Fizz", ingredients: ["2 oz gin", "lemon juice"], collection: "IBA Classics" }
  ];
  const matches = findRecipesForBottle(captainMorgan, "spirit", recipes);
  assert.deepEqual(matches.map((row) => row.name), ["Spiced Daiquiri"]);
  assert.equal(matches[0].matched_ingredient, "2 oz spiced rum");
  assert.ok(matches.length > 0, "book matches must be found so the UI can skip AI");
});

test("G. AI fallback prompt includes the selected bottle as a required ingredient", () => {
  const bottle = shelfBottleFromItem(captainMorgan, "spirit");
  const prompt = mixologistRequiredBottlePrompt(bottle);
  assert.match(prompt, /Captain Morgan Original Spiced Rum/);
  assert.match(prompt, /HARD REQUIREMENT/);
  assert.match(prompt, /MUST include/i);
});

test("H. Generated recipe is rejected when the required bottle is missing", () => {
  const bottle = shelfBottleFromItem(captainMorgan, "spirit");
  assert.equal(
    generatedRecipeIncludesBottle({ ingredients: ["2 oz vodka", "0.75 oz lime juice"] }, bottle),
    false
  );
});

test("I. Generated recipe is accepted when the required ingredient is present", () => {
  const bottle = shelfBottleFromItem(captainMorgan, "spirit");
  assert.equal(
    generatedRecipeIncludesBottle({
      ingredients: ["2 oz Captain Morgan Original Spiced Rum", "0.75 oz lime juice", "0.5 oz simple syrup"]
    }, bottle),
    true
  );
  assert.equal(
    generatedRecipeIncludesBottle({ ingredients: ["2 oz spiced rum", "ginger beer"] }, bottle),
    true
  );
});

test("J. Find-drink helpers do not mutate inventory fields", () => {
  const item = { ...captainMorgan };
  const before = structuredClone(item);
  findRecipesForBottle(item, "spirit", [
    { name: "Stormy", ingredients: ["2 oz spiced rum", "ginger beer"], collection: "IBA Classics" }
  ]);
  recipeIngredientMatchesBottle("2 oz spiced rum", shelfBottleFromItem(item, "spirit"));
  assert.deepEqual(item, before);
});

test("K. Guest-safe recipe payload strips UPC and inventory counts", () => {
  const safe = guestSafeRecipe({
    name: "Stormy",
    ingredients: ["2 oz spiced rum", "ginger beer"],
    upc: "087000201156",
    stock_count: 4,
    fill_level: 80,
    bottle_count: 2,
    method: "Build",
    glassware: "Highball"
  });
  assert.equal("upc" in safe, false);
  assert.equal("stock_count" in safe, false);
  assert.equal("fill_level" in safe, false);
  assert.equal("bottle_count" in safe, false);
  assert.equal(safe.name, "Stormy");
  assert.deepEqual(safe.ingredients, ["2 oz spiced rum", "ginger beer"]);
});

test("L. Button is supported for spirits (and wines)", () => {
  assert.equal(moduleSupportsFindDrink("spirits"), true);
  assert.equal(moduleSupportsFindDrink("wines"), true);
  assert.equal(shelfKindForModule("spirits"), "spirit");
  assert.equal(shelfKindForModule("wines"), "wine");
});

test("M. Unsupported modules do not show the find-drink action", () => {
  assert.equal(moduleSupportsFindDrink("packaged_beer"), false);
  assert.equal(moduleSupportsFindDrink("taps"), false);
  assert.equal(moduleSupportsFindDrink("brews"), false);
  assert.equal(shelfKindForModule("packaged_beer"), "beer");
});
