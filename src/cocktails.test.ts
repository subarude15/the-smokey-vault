import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildShelf, compareCocktails, hasWord, isPlaceholderIngredients, matchCocktail,
  matchIngredient, spiritOnShelf, stripMeasure, wineOnShelf
} from "./cocktails.js";
import { COCKTAIL_RECIPES } from "./cocktail-recipes.js";

test("stripMeasure drops amounts and keeps the bottle name", () => {
  assert.equal(stripMeasure("45 ml bourbon or rye"), "bourbon or rye");
  assert.equal(stripMeasure("2 dashes Angostura bitters"), "angostura bitters");
  assert.equal(stripMeasure("6 mint sprigs"), "mint sprigs");
});

test("hasWord does not treat gin as a match for ginger beer", () => {
  assert.equal(hasWord("fever-tree ginger beer mixer", "gin"), false);
  assert.equal(hasWord("hendricks gin london dry", "gin"), true);
  assert.equal(hasWord("bacardi white rum rum", "white rum"), true);
});

test("pantry citrus and sugar are never missing", () => {
  const line = matchIngredient("25 ml lemon juice", []);
  assert.equal(line.state, "pantry");
  assert.equal(matchIngredient("1 sugar cube", []).state, "pantry");
});

test("bourbon can stand in for rye, and empty bottles drop out", () => {
  const shelf = buildShelf([
    { name: "Eagle Rare", brand: "Buffalo Trace", category: "Whiskey", sub_category: "Bourbon", fill_level: 75, stock_count: 1 },
    { name: "Angostura", category: "Bitters", fill_level: 100, stock_count: 1 },
    { name: "Empty Rye", category: "Whiskey", sub_category: "Rye", fill_level: 0, stock_count: 1 },
    { name: "Ginger Beer", category: "Mixer", fill_level: 100, stock_count: 1 }
  ]);
  const manhattan = matchCocktail({
    name: "Manhattan",
    ingredients: ["50 ml rye whiskey", "20 ml sweet vermouth", "1 dash bitters"]
  }, shelf);
  assert.equal(manhattan.readiness, "almost");
  assert.equal(manhattan.lines[0].state, "substitute");
  assert.match(String(manhattan.lines[0].using), /Eagle Rare/);
  assert.deepEqual(manhattan.missing, ["20 ml sweet vermouth"]);
  assert.equal(matchIngredient("45 ml gin", shelf).state, "missing");
});

test("unopened spare bottles still count when the open one is empty", () => {
  assert.equal(spiritOnShelf({ fill_level: 0, stock_count: 1 }), false);
  assert.equal(spiritOnShelf({ fill_level: 0, stock_count: 2 }), true);
  assert.equal(spiritOnShelf({ fill_level: 25, stock_count: 1 }), true);
  assert.equal(wineOnShelf({ bottle_count: 0 }), false);
  assert.equal(wineOnShelf({ bottle_count: 2 }), true);
});

test("sparkling wine covers Champagne and Prosecco recipes", () => {
  const shelf = buildShelf(
    [{ name: "Aperol", category: "Liqueur", fill_level: 100, stock_count: 1 }],
    [{ name: "La Marca", producer: "La Marca", type: "Sparkling", style: "Prosecco", bottle_count: 3 }]
  );
  const spritz = matchCocktail({
    ingredients: ["90 ml prosecco", "60 ml Aperol", "30 ml soda water"]
  }, shelf);
  assert.equal(spritz.readiness, "ready");
  assert.equal(spritz.lines[0].state, "have");
});

test("compareCocktails puts ready drinks first, then custom names", () => {
  const sorted = [
    { name: "Zombie", readiness: "missing", collection: "IBA Classics" },
    { name: "House Spritz", readiness: "ready", collection: "Custom Cocktails" },
    { name: "Negroni", readiness: "ready", collection: "IBA Classics" },
    { name: "Margarita", readiness: "almost", collection: "IBA Classics" }
  ].sort(compareCocktails).map((row) => row.name);
  assert.deepEqual(sorted, ["House Spritz", "Negroni", "Margarita", "Zombie"]);
});

test("recipe book replaces placeholder specs", () => {
  assert.ok(COCKTAIL_RECIPES.length > 80);
  assert.equal(COCKTAIL_RECIPES.some((recipe) => isPlaceholderIngredients(recipe.ingredients)), false);
  assert.ok(COCKTAIL_RECIPES.some((recipe) => recipe.name === "Paper Plane"));
  assert.ok(COCKTAIL_RECIPES.find((recipe) => recipe.name === "Old Fashioned")?.ingredients.some((line) => /bourbon|rye/.test(line)));
});

test("packaged ginger beer and a pouring tap count toward the shelf", () => {
  const shelf = buildShelf(
    [{ name: "Bacardi", category: "Rum", sub_category: "White", fill_level: 75, stock_count: 1 }],
    [],
    [{ name: "Ginger Beer", brewery: "Fever-Tree", style: "Mixer", count: 6 }],
    [{ brewery_batch: "House Pils", maker: "Vault", style: "Pilsner" }]
  );
  assert.equal(matchIngredient("120 ml ginger beer", shelf).state, "have");
  assert.equal(matchIngredient("90 ml pilsner", shelf).state, "have");
  const mule = matchCocktail({
    ingredients: ["45 ml white rum", "15 ml lime juice", "120 ml ginger beer"]
  }, shelf);
  assert.equal(mule.readiness, "ready");
});

test("sweet vermouth does not cover dry vermouth, but unlabeled vermouth covers both", () => {
  const dryOnly = buildShelf([
    { name: "Noilly Prat", category: "Mixer", sub_category: "Dry vermouth", fill_level: 100, stock_count: 1 }
  ]);
  assert.equal(matchIngredient("20 ml sweet vermouth", dryOnly).state, "missing");
  assert.equal(matchIngredient("20 ml dry vermouth", dryOnly).state, "have");
  const generic = buildShelf([
    { name: "House vermouth", category: "Mixer", sub_category: "Vermouth", fill_level: 100, stock_count: 1 }
  ]);
  assert.notEqual(matchIngredient("20 ml sweet vermouth", generic).state, "missing");
  assert.notEqual(matchIngredient("20 ml dry vermouth", generic).state, "missing");
});

test("scanner Bourbonxrye labels still match whiskey recipes", () => {
  const shelf = buildShelf([
    { name: "Knob Creek", category: "Whiskey", sub_category: "Bourbonxrye", fill_level: 100, stock_count: 1 }
  ]);
  assert.notEqual(matchIngredient("50 ml bourbon", shelf).state, "missing");
  assert.notEqual(matchIngredient("50 ml rye whiskey", shelf).state, "missing");
});
