import test from "node:test";
import assert from "node:assert/strict";
import {
  brewRecipeDocumentSchema,
  createBrewRecipeSchema,
  createBrewSessionSchema
} from "./brew_sheets.js";

test("brew sheet recipe accepts the structured document used by the PDF workflow", () => {
  const recipe = brewRecipeDocumentSchema.parse({
    beerName: "Candy Cloud Hazy DIPA",
    style: "Hazy DIPA",
    targetOg: "1.080",
    targetFg: "1.020–1.022",
    targetAbv: "7.8%",
    estimatedIbu: "25",
    water: {
      strikeWater: "5.50 Gal",
      spargeWater: "4.50 Gal",
      targetMashPh: "5.20–5.35"
    },
    fermentables: [
      { ingredient: "2-Row Pale Malt", amount: "11.50 lbs" }
    ],
    dryHopStages: [
      { stage: "DH #1", variety: "Citra LUPOMAX", amount: "1.5 oz" }
    ],
    warnings: ["Do not add Whirlfloc or Irish Moss"]
  });

  assert.equal(recipe.beerName, "Candy Cloud Hazy DIPA");
  assert.equal(recipe.fermentables.length, 1);
  assert.equal(recipe.warnings.length, 1);
});

test("create brew recipe requires a name and structured recipe", () => {
  const result = createBrewRecipeSchema.safeParse({
    name: "",
    recipe: { beerName: "Candy Cloud Hazy DIPA" }
  });
  assert.equal(result.success, false);
});

test("brew session defaults to Planned with an empty actuals object", () => {
  const session = createBrewSessionSchema.parse({});
  assert.equal(session.status, "Planned");
  assert.deepEqual(session.actuals, {});
});
