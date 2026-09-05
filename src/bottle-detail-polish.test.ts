/**
 * PR #96 — bottle detail visual polish + generated-recipe highlight fix.
 * Presentation / layout only: no inventory mutation, enrichment, navigation,
 * or recipe-matching behavior changes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  moduleSupportsFindDrink,
  recipeIngredientMatchesBottle,
  shelfBottleFromItem
} from "./cocktails.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
const cssSrc = readFileSync(join(root, "client/src/styles.css"), "utf8");
const catalogSrc = readFileSync(join(root, "client/src/catalog.ts"), "utf8");
const publicSrc = readFileSync(join(root, "client/src/BottlePublicContent.tsx"), "utf8");

function bottleDetailSlice(): string {
  const start = appSrc.indexOf("function BottleDetail");
  assert.ok(start >= 0, "BottleDetail present");
  const end = appSrc.indexOf("\nfunction ", start + 1);
  assert.ok(end > start, "BottleDetail bounds");
  return appSrc.slice(start, end);
}

function findDrinkModalSlice(): string {
  const start = appSrc.indexOf("function FindDrinkWithBottleModal");
  assert.ok(start >= 0, "FindDrinkWithBottleModal present");
  const end = appSrc.indexOf("\nfunction ", start + 1);
  assert.ok(end > start, "FindDrinkWithBottleModal bounds");
  return appSrc.slice(start, end);
}

/** Mirror the generated-recipe highlight rule used in the modal. */
function highlightGeneratedIngredients(
  ingredients: string[],
  bottle: ReturnType<typeof shelfBottleFromItem>
) {
  const matchedIndex = ingredients.findIndex((line) =>
    recipeIngredientMatchesBottle(line, bottle)
  );
  return ingredients.map((line, index) => ({
    line,
    matched: index === matchedIndex
  }));
}

test("A. guest Find a Drink CTA remains visible on supported modules", () => {
  const detail = bottleDetailSlice();
  assert.match(detail, /moduleSupportsFindDrink\(module\.id\) && \(/);
  assert.match(detail, /className="primary find-drink-cta"/);
  assert.match(detail, /Find a drink with this/);
  assert.equal(moduleSupportsFindDrink("spirits"), true);
  assert.equal(moduleSupportsFindDrink("wines"), true);
});

test("B. guest action is visually grouped separately from Keeper-only actions", () => {
  const detail = bottleDetailSlice();
  assert.match(detail, /bottle-detail-guest-actions/);
  assert.match(detail, /bottle-detail-keeper-actions/);
  const guestIdx = detail.indexOf("bottle-detail-guest-actions");
  const keeperIdx = detail.indexOf("bottle-detail-keeper-actions");
  assert.ok(guestIdx >= 0 && keeperIdx > guestIdx, "guest actions render before keeper actions");
  assert.match(cssSrc, /\.bottle-detail-guest-actions/);
  assert.match(cssSrc, /\.bottle-detail-keeper-actions\{[^}]*border-top:/);
});

test("C. Keeper controls remain available", () => {
  const detail = bottleDetailSlice();
  assert.match(detail, /\{admin && \(/);
  assert.match(detail, /Pour a drink/);
  assert.match(detail, /Drink one/);
  assert.match(detail, /Open next/);
  assert.match(detail, /Put on tap/);
  assert.match(detail, /onClick=\{onEdit\}/);
  assert.match(detail, /"Edit"\}/);
});

test("D. destructive Remove\/Clear actions remain admin-only", () => {
  const detail = bottleDetailSlice();
  assert.match(detail, /\{admin && \([\s\S]*bottle-detail-keeper-actions/);
  assert.match(detail, /className="secondary danger"[^>]*>Clear tap/);
  assert.match(detail, /className="secondary danger"[^>]*>[\s\S]*?Remove/);
});

test("E. bottle detail image still uses display_image_url precedence and does not mutate inventory.image_url", () => {
  const detail = bottleDetailSlice();
  assert.match(detail, /display_image_url\s*\?\?\s*item\.image_url/);
  assert.doesNotMatch(detail, /image_url\s*=/);
  assert.match(cssSrc, /\.bottle-detail-image img\{[^}]*object-fit:\s*contain/);
});

test("F. TastingProfileView still renders exactly once according to PR95 precedence", () => {
  const detail = bottleDetailSlice();
  assert.equal([...detail.matchAll(/<TastingProfileView/g)].length, 1);
  assert.match(detail, /item\.tasting_notes \? <TastingProfileView/);
  assert.match(publicSrc, /hasPersonalNotes \? "" : selectGuestEnrichedTastingText/);
  assert.equal([...publicSrc.matchAll(/<TastingProfileView/g)].length, 1);
  assert.match(publicSrc, /TASTING PROFILE/);
  assert.doesNotMatch(publicSrc, /\{official \? <TastingProfileView/);
  assert.doesNotMatch(publicSrc, /\{house \? <TastingProfileView/);
});

test("G. PR93 guest UPC\/count hiding remains intact", () => {
  const detail = bottleDetailSlice();
  assert.match(detail, /if\s*\(!admin\)\s*\{[\s\S]*?skip\.add\("upc"\)/);
  assert.match(detail, /if\s*\(!admin\)\s*\{[\s\S]*?skip\.add\("bottle_count"\)/);
  assert.match(detail, /admin && item\.upc \?/);
  assert.match(detail, /admin && item\.bottle_count != null/);
});

test("H. generated recipe highlights only the actual required bottle ingredient", () => {
  const bottle = shelfBottleFromItem(
    {
      name: "Original Spiced Rum",
      brand: "Captain Morgan",
      category: "Rum",
      sub_category: "Spiced"
    },
    "spirit"
  );
  const lines = [
    "2 oz Captain Morgan Original Spiced Rum",
    "0.75 oz lime juice",
    "0.5 oz simple syrup"
  ];
  const marked = highlightGeneratedIngredients(lines, bottle);
  assert.deepEqual(
    marked.map((row) => row.matched),
    [true, false, false]
  );
  const modal = findDrinkModalSlice();
  assert.match(
    modal,
    /generated\.ingredients\.findIndex\(\(line\) => recipeIngredientMatchesBottle\(line, bottle\)\)/
  );
  assert.match(modal, /isMatch \? "have matched-bottle" : "have"/);
});

test("I. unrelated generated ingredients are NOT marked matched-bottle", () => {
  const bottle = shelfBottleFromItem(
    {
      name: "Original Spiced Rum",
      brand: "Captain Morgan",
      category: "Rum",
      sub_category: "Spiced"
    },
    "spirit"
  );
  const marked = highlightGeneratedIngredients(
    ["2 oz Captain Morgan Original Spiced Rum", "0.75 oz lime juice", "0.5 oz syrup"],
    bottle
  );
  assert.equal(marked.filter((row) => row.matched).length, 1);
  assert.equal(marked[1].matched, false);
  assert.equal(marked[2].matched, false);
  const modal = findDrinkModalSlice();
  assert.doesNotMatch(
    modal,
    /generated\.ingredients\.map\(\(line\) => \(\s*<li[^>]*className="have matched-bottle"/
  );
});

test("J. existing recipe matched ingredient still gets this bottle", () => {
  const modal = findDrinkModalSlice();
  assert.match(modal, /matched_ingredient/);
  assert.match(modal, /matched-bottle/);
  assert.match(modal, /· this bottle/);
});

test("K. mobile layout source guards remain intact", () => {
  assert.match(
    cssSrc,
    /\.bottle-detail-hero\{[^}]*grid-template-columns:\s*180px\s+minmax\(0,\s*1fr\)/
  );
  assert.match(cssSrc, /\.bottle-detail-hero\{grid-template-columns:1fr\}/);
  assert.match(
    cssSrc,
    /\.bottle-detail-hero h1\{[^}]*overflow-wrap:\s*anywhere/
  );
  assert.match(cssSrc, /\.bottle-detail-actions\{[^}]*flex-wrap:\s*wrap/);
  assert.match(cssSrc, /\.bottle-detail-guest-actions/);
  assert.match(cssSrc, /\.bottle-detail-keeper-actions/);
});

test("L. Draft Taps\/Homebrew behavior is unchanged", () => {
  assert.equal(moduleSupportsFindDrink("taps"), false);
  assert.equal(moduleSupportsFindDrink("brews"), false);
  const detail = bottleDetailSlice();
  assert.match(detail, /moduleSupportsFindDrink\(module\.id\)/);
  assert.match(detail, /module\.id === "taps"/);
  assert.match(detail, /module\.id === "brews"/);
  assert.match(detail, /Pour a pint/);
  assert.match(detail, /Advance to/);
});

test("M. no API\/data\/enrichment logic changes introduced", () => {
  assert.match(catalogSrc, /recipeIngredientMatchesBottle/);
  assert.match(catalogSrc, /shelfBottleFromItem/);
  assert.doesNotMatch(bottleDetailSlice(), /fetch\([`'"]\/api\/inventory/);
  assert.match(cssSrc, /\.find-drink-cta/);
  assert.match(cssSrc, /\.tasting-profile-label/);
  assert.match(cssSrc, /\.guest-reviews\{[^}]*border-top:/);
});
