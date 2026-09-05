/**
 * PR #97 — unify What Can I Make? with Ask the Mixologist on one page.
 * Source-level regression guards for navigation, aliasing, panel integration,
 * and unchanged cocktail / find-drink / AI contracts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
const cssSrc = readFileSync(join(root, "client/src/styles.css"), "utf8");

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `missing end marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

function cocktailsSlice(): string {
  return sliceBetween(appSrc, "function Cocktails(", "function RecipeModal(");
}

function mixologistPanelSlice(): string {
  return sliceBetween(appSrc, "function MixologistPanel(", "function lastBackupLabel(");
}

function findDrinkSlice(): string {
  return sliceBetween(appSrc, "function FindDrinkWithBottleModal(", "function Cocktails(");
}

function navSlice(): string {
  const start = appSrc.indexOf("const collectionNav");
  assert.ok(start >= 0, "collectionNav present");
  const end = appSrc.indexOf("const keeperNav", start);
  assert.ok(end > start, "keeperNav follows collectionNav");
  return appSrc.slice(start, end);
}

test("A. sidebar contains ONE cocktail-discovery destination", () => {
  const nav = navSlice();
  assert.match(nav, /id:"cocktails"/);
  assert.equal((nav.match(/id:"cocktails"/g) || []).length, 1);
  assert.match(nav, /What Can I Make\?/);
});

test("B. standalone AI Mixologist nav item is gone", () => {
  const nav = navSlice();
  assert.doesNotMatch(nav, /id:"mixologist"/);
  assert.doesNotMatch(nav, /AI Mixologist/);
  assert.doesNotMatch(appSrc, /mixologist:\s*"AI Mix"/);
});

test("C. cocktails guest tab still controls unified page visibility", () => {
  assert.match(appSrc, /cocktails:\s*"cocktails"/);
  assert.match(appSrc, /mixologist:\s*"cocktails"/);
  assert.match(appSrc, /cocktails:\s*"Cocktails"/);
  assert.doesNotMatch(appSrc, /mixologist_enabled/);
  assert.doesNotMatch(appSrc, /ai_tab|cocktail_ai/);
});

test("D. legacy mixologist page/state resolves to unified cocktails + focus", () => {
  assert.match(appSrc, /next === "mixologist"/);
  assert.match(appSrc, /setCocktailFocus\("mixologist"\)/);
  assert.match(appSrc, /setPage\("cocktails"\)/);
  assert.match(appSrc, /page !== "mixologist"/);
  assert.doesNotMatch(appSrc, /page === "mixologist"\s*&&/);
  assert.doesNotMatch(appSrc, /function Mixologist\s*\(/);
});

test("E. unified page contains saved recipe browser", () => {
  const cocktails = cocktailsSlice();
  assert.match(cocktails, /What can I make\?/);
  assert.match(cocktails, /\/cocktails\/match/);
  assert.match(cocktails, /shown\.map/);
});

test("F. unified page contains Ask the Mixologist section", () => {
  const cocktails = cocktailsSlice();
  assert.match(cocktails, /<MixologistPanel/);
  assert.match(cocktails, /Ask the Mixologist/);
  const panel = mixologistPanelSlice();
  assert.match(panel, /ASK THE MIXOLOGIST/);
  assert.match(panel, /id="ask-the-mixologist"/);
});

test("G. no second PageTitle is rendered for Mixologist", () => {
  const panel = mixologistPanelSlice();
  assert.doesNotMatch(panel, /<PageTitle/);
  assert.match(panel, /className="mixologist-panel"/);
  assert.match(panel, /id="mixologist-heading"/);
});

test("H. Ready / Missing one / All filters remain intact", () => {
  const cocktails = cocktailsSlice();
  assert.match(cocktails, /Ready now/);
  assert.match(cocktails, /Off the menu/);
  assert.match(cocktails, /Missing one/);
  assert.match(cocktails, /All recipes/);
});

test("I. search remains intact", () => {
  const cocktails = cocktailsSlice();
  assert.match(cocktails, /cocktail-search/);
  assert.match(cocktails, /Negroni, mezcal, coupe/);
});

test("J. Surprise me remains intact", () => {
  const cocktails = cocktailsSlice();
  assert.match(cocktails, /Surprise me/);
  assert.match(cocktails, /function surprise\(/);
});

test("K. bartender favorites remain intact", () => {
  const cocktails = cocktailsSlice();
  assert.match(cocktails, /Bartender favorites/);
  assert.match(cocktails, /bartender_fav/);
});

test("L. season and collection filtering remain intact", () => {
  const cocktails = cocktailsSlice();
  assert.match(cocktails, /SEASON/);
  assert.match(cocktails, /COLLECTION/);
  assert.match(cocktails, /setSeason/);
  assert.match(cocktails, /setCollection/);
});

test("M. Keeper recipe import remains intact", () => {
  const cocktails = cocktailsSlice();
  assert.match(cocktails, /Add from a link/);
  assert.match(cocktails, /RecipeImportModal/);
});

test("N. Mixologist still POSTs to /ai/mixologist", () => {
  const panel = mixologistPanelSlice();
  assert.match(panel, /"\/ai\/mixologist"/);
  assert.match(panel, /method:"POST"/);
});

test("O. existing timeout/loading/failure behavior remains intact", () => {
  const panel = mixologistPanelSlice();
  assert.match(panel, /AI_MIXOLOGIST_TIMEOUT_MS/);
  assert.match(panel, /mixologistLoadingStep/);
  assert.match(panel, /mixologistFailureMessage/);
  assert.match(panel, /aria-live="polite"/);
  assert.match(panel, /aria-busy/);
});

test("P. generated recipes still render correctly", () => {
  const panel = mixologistPanelSlice();
  assert.match(panel, /generated-recipe/);
  assert.match(panel, /recipe\.ingredients/);
  assert.match(panel, /recipe\.method/);
  assert.match(panel, /recipe\.glassware/);
  assert.match(panel, /recipe\.garnish/);
  assert.match(panel, /recipe\.notes/);
  assert.match(panel, /recipe\.season/);
});

test("Q. Keeper can still save generated recipes to Custom Cocktails", () => {
  const panel = mixologistPanelSlice();
  assert.match(panel, /\/cocktails\/custom/);
  assert.match(panel, /Add to Custom Cocktails/);
  assert.match(panel, /Saved to Custom Cocktails/);
});

test("R. guests do not gain recipe-save permission", () => {
  const panel = mixologistPanelSlice();
  assert.match(panel, /if\s*\(\s*!admin\s*\)/);
  assert.match(panel, /Unlock Admin Mode to save this recipe to Custom Cocktails/);
});

test("S. redundant Recommend from the shelf AI action is removed", () => {
  const panel = mixologistPanelSlice();
  assert.doesNotMatch(panel, /Recommend from the shelf/);
  assert.doesNotMatch(panel, /Recommend the single best cocktail/);
  assert.match(panel, /Something with what I already have/);
});

test("T. empty recipe result provides Ask the Mixologist without auto-calling AI", () => {
  const cocktails = cocktailsSlice();
  assert.match(cocktails, /No matching cocktails/);
  assert.match(cocktails, /Ask the Mixologist/);
  assert.match(cocktails, /scrollToMixologist/);
  const emptyIdx = cocktails.indexOf("No matching cocktails");
  const emptyBlock = cocktails.slice(emptyIdx, emptyIdx + 700);
  assert.doesNotMatch(emptyBlock, /ask\(|\/ai\/mixologist/);
});

test("U. PR94 Find a Drink with This remains intact", () => {
  assert.match(appSrc, /Find a drink with this/);
  const modal = findDrinkSlice();
  assert.match(modal, /\/cocktails\/match/);
  assert.match(modal, /\/ai\/mixologist/);
  assert.doesNotMatch(modal, /navigate\("cocktails"\)|go\("cocktails"\)/);
});

test("V. no cocktail/inventory/enrichment backend behavior changes in this PR", () => {
  const serverCocktails = readFileSync(join(root, "src/cocktails.ts"), "utf8");
  assert.match(serverCocktails, /export/);
  assert.doesNotMatch(appSrc, /mixologist_enabled/);
  assert.match(cssSrc, /\.mixologist-panel/);
});
