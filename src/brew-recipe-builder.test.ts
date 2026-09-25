import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ANALYZE_EMPTY_MESSAGE,
  ANALYZE_FAILURE_MESSAGE,
  addRow,
  beginAnalyze,
  BLANK_KETTLE,
  brewRecipeSaveBody,
  BREW_SHEET_SOURCE_MAX_CHARS,
  builderIsDirty,
  canAnalyze,
  draftFromParsed,
  editSaved,
  emptyBuilderState,
  failAnalyze,
  finishAnalyze,
  finishSave,
  publicAnalyzeError,
  publicSaveError,
  removeRow,
  savedRecipeId,
  setWaterField,
  updateRow,
  withRawText
} from "../client/src/brew-recipe-builder.ts";
import { BREW_SHEET_NAV_LABEL, BREW_SHEET_PAGE_ID } from "../client/src/brew-sheet-page.ts";
import {
  GUEST_HIDDEN_PAGES,
  GUEST_LANDING_CANDIDATES,
  KEEPER_OPERATION_IDS,
  KEEPER_PAGES,
  NAV_LABELS,
  isKeeperOnlyPage,
  navLabel
} from "../client/src/shell-nav.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
const builderSrc = readFileSync(join(root, "client/src/BrewRecipeBuilder.tsx"), "utf8");

const CANDY_TEXT = `Candy Cloud Hazy DIPA
System: SS Brewtech V3
Do not add Whirlfloc.`;

const candyRecipe = {
  beerName: "Candy Cloud Hazy DIPA",
  style: "Hazy DIPA",
  system: "SS Brewtech V3 3-Kettle Electric",
  water: {
    source: "RO",
    strikeWater: "5.50 Gallons",
    sodiumPpm: "40",
    magnesiumPpm: "10"
  },
  fermentables: [{ ingredient: "2-Row Pale Malt", amount: "11.50 lbs", lovibond: "2" }],
  kettleAdditions: [],
  whirlpoolAdditions: [{ ingredient: "Mosaic LUPOMAX", amount: "2.00 oz", temperature: "170°F", time: "20 min" }],
  dryHopStages: [{ stage: "DH #1", variety: "Citra LUPOMAX", amount: "1.5 oz", when: "Day 2" }],
  fermentation: {
    yeast: "London Fog III",
    pitchRate: "1.0",
    steps: [{ when: "Day 3", temperature: "72°F", gravity: "1.030", action: "raise", note: "keep closed" }]
  },
  packaging: { targetCO2: "2.4", steps: ["Oxygen-free transfer"] },
  warnings: ["Do not add Whirlfloc"],
  checklist: ["Confirm mash pH"],
  notes: "Stash-Buster Edition"
};

test("Analyze is disabled until brewing instructions have text", () => {
  const empty = emptyBuilderState();
  assert.equal(canAnalyze(empty), false);
  assert.equal(canAnalyze(withRawText(empty, " \n\t")), false);
  const ready = withRawText(empty, CANDY_TEXT);
  assert.equal(canAnalyze(ready), true);
  assert.equal(canAnalyze(beginAnalyze(ready)), false);
  assert.match(builderSrc, /disabled=\{!canAnalyze\(state\)\}/);
});

test("a successful parse moves to review and keeps the pasted text", () => {
  const ready = withRawText(emptyBuilderState(), CANDY_TEXT);
  const reviewed = finishAnalyze(beginAnalyze(ready), candyRecipe);
  assert.equal(reviewed.phase, "review");
  assert.equal(reviewed.busy, "idle");
  assert.equal(reviewed.rawText, CANDY_TEXT);
  assert.equal(reviewed.draft?.beerName, "Candy Cloud Hazy DIPA");
  assert.equal(reviewed.draft?.style, "Hazy DIPA");
  assert.equal(reviewed.error, "");
  assert.equal(builderIsDirty(reviewed), true);
});

test("a parser failure keeps the pasted instructions and hides provider details", () => {
  const ready = withRawText(emptyBuilderState(), CANDY_TEXT);
  const failed = failAnalyze(beginAnalyze(ready));
  assert.equal(failed.phase, "paste");
  assert.equal(failed.rawText, CANDY_TEXT);
  assert.equal(failed.draft, null);
  assert.equal(failed.error, ANALYZE_FAILURE_MESSAGE);
  const leaked = "https://generativelanguage.googleapis.com/v1beta?key=sk-live Bearer secret";
  const message = publicAnalyzeError(502, leaked);
  assert.equal(message, ANALYZE_FAILURE_MESSAGE);
  assert.equal(message.includes("sk-live"), false);
  assert.equal(message.includes("http"), false);
  assert.equal(publicAnalyzeError(400, "Brewing instructions are required"), ANALYZE_EMPTY_MESSAGE);
  assert.equal(publicSaveError().includes("http"), false);
});

test("saving sends beer name, style, source text, and the full recipe", () => {
  const reviewed = finishAnalyze(withRawText(emptyBuilderState(), CANDY_TEXT), candyRecipe);
  const body = brewRecipeSaveBody(reviewed);
  assert.ok(body);
  assert.equal(body.name, "Candy Cloud Hazy DIPA");
  assert.equal(body.style, "Hazy DIPA");
  assert.equal(body.sourceText, CANDY_TEXT);
  assert.equal(body.recipe, reviewed.draft);
  assert.equal(body.recipe.water.sodiumPpm, "40");
  assert.equal((body.recipe.dryHopStages[0] as { variety: string }).variety, "Citra LUPOMAX");
  const saved = finishSave(reviewed, 12);
  assert.equal(saved.phase, "saved");
  assert.equal(saved.rawText, CANDY_TEXT);
  assert.equal(savedRecipeId({ recipe: { id: 12 } }), 12);
  const editing = editSaved(saved);
  assert.equal(editing.phase, "review");
  assert.equal(editing.savedId, 12);
  assert.equal(brewRecipeSaveBody(editing)?.sourceText, CANDY_TEXT);
  assert.match(builderSrc, /savedId \? "PATCH" : "POST"/);
});

test("editing known fields keeps unknown nested recipe keys", () => {
  const draft = draftFromParsed(candyRecipe);
  assert.ok(draft);
  const water = setWaterField(draft, "source", "100% RO");
  assert.equal(water.water.source, "100% RO");
  assert.equal(water.water.sodiumPpm, "40");
  assert.equal(water.water.magnesiumPpm, "10");
  assert.equal(water.fermentables, draft.fermentables);
  const row = updateRow(water, "fermentables", 0, { amount: "12.00 lbs" });
  assert.equal(row.fermentables[0].amount, "12.00 lbs");
  assert.equal(row.fermentables[0].lovibond, "2");
  assert.equal(row.water.sodiumPpm, "40");
  const state = finishAnalyze(withRawText(emptyBuilderState(), CANDY_TEXT), {
    ...candyRecipe,
    water: row.water,
    fermentables: row.fermentables
  });
  assert.equal(brewRecipeSaveBody(state)?.recipe.water.magnesiumPpm, "10");
  assert.equal(brewRecipeSaveBody(state)?.recipe.fermentation.pitchRate, "1.0");
  assert.equal(brewRecipeSaveBody(state)?.recipe.packaging.targetCO2, "2.4");
});

test("adding or removing a row leaves the rest of the recipe alone", () => {
  const draft = draftFromParsed(candyRecipe);
  assert.ok(draft);
  const beforeFermentables = draft.fermentables;
  const added = addRow(draft, "kettleAdditions", BLANK_KETTLE);
  assert.equal(added.water, draft.water);
  assert.equal(added.fermentables, beforeFermentables);
  assert.equal(added.whirlpoolAdditions, draft.whirlpoolAdditions);
  assert.equal(added.warnings, draft.warnings);
  assert.equal(added.fermentation, draft.fermentation);
  assert.equal(added.kettleAdditions.length, 1);
  assert.equal(draft.kettleAdditions.length, 0);
  const removed = removeRow(added, "fermentables", 0);
  assert.equal(removed.fermentables.length, 0);
  assert.equal(removed.kettleAdditions, added.kettleAdditions);
  assert.equal(removed.water.sodiumPpm, "40");
  assert.equal(beforeFermentables.length, 1);
});

test("guests cannot reach the Brew Sheet Builder", () => {
  assert.equal(BREW_SHEET_PAGE_ID, "brew_sheets");
  assert.equal(isKeeperOnlyPage(BREW_SHEET_PAGE_ID), true);
  assert.equal(GUEST_HIDDEN_PAGES.has(BREW_SHEET_PAGE_ID), true);
  assert.equal(KEEPER_PAGES.has(BREW_SHEET_PAGE_ID), true);
  assert.equal(NAV_LABELS[BREW_SHEET_PAGE_ID], BREW_SHEET_NAV_LABEL);
  assert.equal(navLabel(BREW_SHEET_PAGE_ID, "fallback"), "Brew Sheet Builder");
  assert.equal((GUEST_LANDING_CANDIDATES as readonly string[]).includes(BREW_SHEET_PAGE_ID), false);
  assert.ok(KEEPER_OPERATION_IDS.includes(BREW_SHEET_PAGE_ID));
  assert.match(appSrc, /page === BREW_SHEET_PAGE_ID && admin && <BrewRecipeBuilder\/>/);
  assert.match(appSrc, /page === "brewery" && <BreweryLab/);
  const collectionStart = appSrc.indexOf("const collectionNav");
  const keeperStart = appSrc.indexOf("const keeperNav");
  assert.ok(collectionStart >= 0 && keeperStart > collectionStart);
  assert.equal(appSrc.slice(collectionStart, keeperStart).includes("BREW_SHEET"), false);
  assert.match(appSrc.slice(keeperStart, keeperStart + 700), /BREW_SHEET_PAGE_ID/);
  assert.equal(BREW_SHEET_SOURCE_MAX_CHARS, 100_000);
  const parser = readFileSync(join(root, "src/brew_recipe_parser.ts"), "utf8");
  assert.match(parser, /export const BREW_RECIPE_PARSE_MAX_CHARS = 100_000/);
});
