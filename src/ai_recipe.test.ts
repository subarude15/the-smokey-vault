import assert from "node:assert/strict";
import { test } from "node:test";
import { AiRecipeParseError, parseGeneratedRecipe } from "./ai_recipe.js";

const valid = {
  name: "House Highball",
  ingredients: ["50 ml Buffalo Trace Eagle Rare", "120 ml soda water"],
  method: "Build over ice.",
  glassware: "Highball",
  garnish: "Lemon peel",
  season: "Summer",
  notes: "Bright and easy."
};

test("parseGeneratedRecipe accepts a complete recipe, including fenced JSON", () => {
  const recipe = parseGeneratedRecipe(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``);
  assert.equal(recipe.name, "House Highball");
  assert.deepEqual(recipe.ingredients, valid.ingredients);
  assert.equal(recipe.method, "Build over ice.");
  assert.equal(recipe.season, "Summer");
});

test("empty or incomplete JSON is a parse error, not an unavailable notice", () => {
  assert.throws(() => parseGeneratedRecipe(""), (error: unknown) => {
    assert.ok(error instanceof AiRecipeParseError);
    assert.match(error.message, /incomplete recipe/);
    return true;
  });
  assert.throws(() => parseGeneratedRecipe("{}"), (error: unknown) => {
    assert.ok(error instanceof AiRecipeParseError);
    assert.match(error.message, /missing required details/);
    return true;
  });
  assert.throws(() => parseGeneratedRecipe("{"), (error: unknown) => {
    assert.ok(error instanceof AiRecipeParseError);
    assert.match(error.message, /incomplete recipe/);
    return true;
  });
  assert.throws(() => parseGeneratedRecipe("{not json}"), (error: unknown) => {
    assert.ok(error instanceof AiRecipeParseError);
    assert.match(error.message, /unexpected format/);
    return true;
  });
});
