/**
 * PR145 — Built-in cocktails must resolve to real preparation instructions,
 * not a bare method label like "Build" / "Shake" / "Stir".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { COCKTAIL_RECIPES } from "./cocktail-recipes.ts";
import { resolveCocktailInstructions } from "../client/src/cocktail-instructions.ts";

const BARE_LABELS = new Set([
  "build",
  "shake",
  "stir",
  "shake and top",
  "muddle and build",
  "shake hard and top"
]);

test("every seeded cocktail resolves to real steps, not a method-only placeholder", () => {
  assert.ok(COCKTAIL_RECIPES.length > 100, "sanity: the built-in catalog is populated");
  for (const recipe of COCKTAIL_RECIPES) {
    const resolved = resolveCocktailInstructions(recipe);
    assert.equal(resolved.kind, "steps", `${recipe.name} should render steps`);
    if (resolved.kind !== "steps") continue;
    assert.ok(resolved.steps.length >= 3, `${recipe.name} should have multiple steps`);
    // No step is just the bare technique label.
    for (const step of resolved.steps) {
      assert.ok(
        !BARE_LABELS.has(step.trim().toLowerCase()),
        `${recipe.name} step should be an instruction, not the bare label "${step}"`
      );
      assert.ok(step.trim().length >= 5, `${recipe.name} step should read as a sentence`);
    }
    // The short method label is preserved as secondary metadata.
    assert.equal(resolved.methodLabel, recipe.method, `${recipe.name} keeps its method label`);
  }
});

test("classic method-only cocktails now surface preparation steps", () => {
  const oldFashioned = COCKTAIL_RECIPES.find((recipe) => recipe.name === "Old Fashioned");
  assert.ok(oldFashioned);
  const resolved = resolveCocktailInstructions(oldFashioned!);
  assert.equal(resolved.kind, "steps");
  if (resolved.kind !== "steps") return;
  assert.match(resolved.steps.join(" "), /mixing glass|stir/i);
  assert.equal(resolved.methodLabel, "Stir");

  const mojito = COCKTAIL_RECIPES.find((recipe) => recipe.name === "Mojito");
  assert.ok(mojito);
  const mojitoSteps = resolveCocktailInstructions(mojito!);
  assert.equal(mojitoSteps.kind, "steps");
  if (mojitoSteps.kind !== "steps") return;
  assert.match(mojitoSteps.steps.join(" "), /ice|glass/i);
  assert.match(mojitoSteps.steps[mojitoSteps.steps.length - 1], /mint/i);
});
