import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ANALYZE_EMPTY_MESSAGE,
  ANALYZE_FAILURE_MESSAGE,
  addRow,
  addSession,
  beginAnalyze,
  BLANK_KETTLE,
  brewAgainRequest,
  canDownloadBrewSheetPdf,
  brewRecipeSaveBody,
  brewSheetFingerprint,
  BREW_SHEET_SOURCE_MAX_CHARS,
  builderIsDirty,
  canAnalyze,
  deleteRecipeConfirm,
  draftFromParsed,
  editSaved,
  emptyBuilderState,
  failAnalyze,
  finishAnalyze,
  finishSave,
  leaveNeedsConfirm,
  openSavedRecipe,
  publicAnalyzeError,
  publicSaveError,
  recipeCardLine,
  recipeCardsFromList,
  removeRow,
  savedRecipeId,
  sessionViews,
  setWaterField,
  showCreatedSession,
  sortSessions,
  updateRow,
  withDraft,
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
  assert.match(builderSrc, /initialLibraryState/);
  assert.doesNotMatch(appSrc, /page === "brew_sheets" && </);
});

const savedPayload = {
  recipe: {
    id: 4,
    name: "Candy Cloud Hazy DIPA",
    style: "Hazy DIPA",
    sourceText: CANDY_TEXT,
    updatedAt: "2026-09-25 18:04:00",
    recipe: { ...candyRecipe, targetOg: "1.080", targetFg: "1.020", targetAbv: "~7.8%", estimatedIbu: "25" }
  },
  sessions: [
    { id: 2, brewNumber: 1, brewedAt: "2026-06-02", status: "Completed", createdAt: "2026-06-02 12:00:00" },
    { id: 8, brewNumber: 3, brewedAt: null, status: "Planned", createdAt: "2026-09-25 18:04:00" },
    { id: 5, brewNumber: 2, brewedAt: "2026-08-14", status: "Completed", createdAt: "2026-08-14 09:00:00" }
  ]
};

test("library cards summarize saved recipes without the full document", () => {
  const cards = recipeCardsFromList({ recipes: [savedPayload.recipe, { id: 0, name: "skip" }] });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].name, "Candy Cloud Hazy DIPA");
  assert.equal(cards[0].style, "Hazy DIPA");
  assert.equal(cards[0].targetOg, "1.080");
  assert.equal(cards[0].updatedLabel, "Updated Sep 25, 2026");
  assert.match(recipeCardLine(cards[0]), /Target OG 1\.080/);
  assert.match(recipeCardLine(cards[0]), /7\.8% ABV/);
  assert.equal(JSON.stringify(cards[0]).includes("sodiumPpm"), false);
});

test("opening a saved recipe restores source text, draft, and saved id", () => {
  const opened = openSavedRecipe(savedPayload);
  assert.ok(opened);
  assert.equal(opened.phase, "review");
  assert.equal(opened.rawText, CANDY_TEXT);
  assert.equal(opened.savedId, 4);
  assert.equal(opened.draft?.beerName, "Candy Cloud Hazy DIPA");
  assert.equal(opened.draft?.water.sodiumPpm, "40");
  assert.deepEqual(opened.sessions.map((session) => session.brewNumber), [3, 2, 1]);
  assert.equal(brewRecipeSaveBody(opened)?.sourceText, CANDY_TEXT);
  assert.match(builderSrc, /savedId \? "PATCH" : "POST"/);
  assert.equal(leaveNeedsConfirm(opened, brewSheetFingerprint(opened)), false);
  const baseline = brewSheetFingerprint(opened);
  assert.equal(canDownloadBrewSheetPdf(opened, baseline), true);
  assert.equal(canDownloadBrewSheetPdf({ ...opened, phase: "preview", previewReturn: "review" }, baseline), true);
  assert.equal(canDownloadBrewSheetPdf({ ...opened, savedId: null }, baseline), false);
  assert.equal(canDownloadBrewSheetPdf(emptyBuilderState(), ""), false);
  const dirty = withDraft(opened, setWaterField(opened.draft!, "source", "Changed"));
  assert.equal(canDownloadBrewSheetPdf(dirty, baseline), false);
  assert.match(builderSrc, /BrewSheetPdfDownload/);
  assert.doesNotMatch(appSrc, /Download PDF/);
});

test("New Recipe clears the editor and leaves saved library cards in place", () => {
  const cards = recipeCardsFromList({ recipes: [savedPayload.recipe] });
  const opened = openSavedRecipe(savedPayload);
  assert.ok(opened);
  const next = emptyBuilderState();
  assert.equal(next.phase, "paste");
  assert.equal(next.savedId, null);
  assert.equal(next.draft, null);
  assert.equal(next.rawText, "");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, 4);
  assert.equal(builderIsDirty(next), false);
});

test("Brew Again posts a session on the existing recipe and shows it first", () => {
  const request = brewAgainRequest(4);
  assert.equal(request.path, "/admin/brewery/recipes/4/sessions");
  assert.equal(request.method, "POST");
  assert.deepEqual(request.body, { status: "Planned" });
  const opened = openSavedRecipe(savedPayload);
  assert.ok(opened);
  const created = { id: 9, brewNumber: 4, brewedAt: null, createdAt: "2026-09-25 19:00:00", status: "Planned" };
  const next = showCreatedSession(opened, created);
  assert.equal(next.phase, "saved");
  assert.equal(next.savedId, 4);
  assert.equal(next.brewNotice, "Brew #4 created");
  assert.equal(next.sessions[0].brewNumber, 4);
  assert.equal(next.draft, opened.draft);
  const edited = addSession(withDraft(opened, setWaterField(opened.draft!, "source", "RO")), created);
  assert.equal(edited.phase, "review");
  assert.equal(edited.draft?.water.sodiumPpm, "40");
  assert.equal(edited.sessions[0].brewNumber, 4);
  const savedAfter = finishSave(next, 4);
  assert.equal(savedAfter.phase, "saved");
  assert.equal(savedAfter.brewNotice, "");
  assert.equal(savedAfter.sessions[0].brewNumber, 4);
});

test("session display sorts by brew number and does not renumber", () => {
  const sessions = sortSessions(sessionViews(savedPayload.sessions));
  assert.deepEqual(sessions.map((session) => session.brewNumber), [3, 2, 1]);
  assert.deepEqual(savedPayload.sessions.map((session) => session.brewNumber), [1, 3, 2]);
});

test("deleting a recipe requires a confirmation that names brew sessions", () => {
  const message = deleteRecipeConfirm("Candy Cloud Hazy DIPA");
  assert.match(message, /Candy Cloud Hazy DIPA/);
  assert.match(message, /brew sessions/);
  assert.match(builderSrc, /deleteRecipeConfirm/);
  assert.match(builderSrc, /window\.confirm\(deleteRecipeConfirm/);
});

test("open, edit, and save keep unknown nested recipe keys", () => {
  const opened = openSavedRecipe(savedPayload);
  assert.ok(opened?.draft);
  const edited = withDraft(opened, setWaterField(opened.draft, "source", "100% RO"));
  const body = brewRecipeSaveBody(edited);
  assert.equal(body?.name, "Candy Cloud Hazy DIPA");
  assert.equal(body?.style, "Hazy DIPA");
  assert.equal(body?.sourceText, CANDY_TEXT);
  assert.equal(body?.recipe.water.source, "100% RO");
  assert.equal(body?.recipe.water.sodiumPpm, "40");
  assert.equal(body?.recipe.water.magnesiumPpm, "10");
  assert.equal(body?.recipe.fermentation.pitchRate, "1.0");
});
