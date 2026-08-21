import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseList, parseTagInput, serializeList, spiritFamilyFromLabel,
  defaultSweetnessForWine, inferWineFamilyAndStyle, migrateWineSweetnessValue,
  wineKindLabel, wineSweetnessStops,
  kegFillPercent, kegSizeLabel, nearestKegStop, pintsRemaining, pourPint, remainingFromPercent
} from "./catalog.js";

test("parseTagInput strips hashes and dedupes", () => {
  assert.deepEqual(parseTagInput("#irish #summer irish #rare"), ["irish", "summer", "rare"]);
});

test("parseList reads JSON or hashtags", () => {
  assert.deepEqual(parseList('["Peat","Vanilla"]'), ["Peat", "Vanilla"]);
  assert.deepEqual(parseList("#peat vanilla"), ["peat", "vanilla"]);
});

test("serializeList round-trips unique values", () => {
  assert.equal(serializeList(["Peat", "peat", " Oak "]), '["Peat","Oak"]');
});

test("spiritFamilyFromLabel lifts whiskey types into Whiskey family", () => {
  assert.deepEqual(spiritFamilyFromLabel("Bourbon"), { family: "Whiskey", type: "Bourbon" });
  assert.deepEqual(spiritFamilyFromLabel("Irish"), { family: "Whiskey", type: "Irish" });
  assert.deepEqual(spiritFamilyFromLabel("Corn whiskey"), { family: "Whiskey", type: "Corn whiskey" });
  assert.deepEqual(spiritFamilyFromLabel("Whiskey", "Rye"), { family: "Whiskey", type: "Rye" });
  assert.equal(spiritFamilyFromLabel("London Dry Gin").family, "Gin");
  assert.equal(spiritFamilyFromLabel("Mixer").family, "Mixer");
});

test("wineKindLabel prefers sparkling style over family", () => {
  assert.equal(wineKindLabel("Sparkling", "Champagne"), "Champagne");
  assert.equal(wineKindLabel("Red", ""), "Red");
});

test("defaultSweetnessForWine follows family and Prosecco exception", () => {
  assert.equal(defaultSweetnessForWine("Red"), "Dry");
  assert.equal(defaultSweetnessForWine("Sparkling", "Champagne"), "Brut");
  assert.equal(defaultSweetnessForWine("Sparkling", "Prosecco"), "Extra Dry");
  assert.equal(defaultSweetnessForWine("Dessert"), "Sweet");
  assert.equal(defaultSweetnessForWine("Fortified"), "Sweet");
});

test("migrateWineSweetnessValue maps old 1–5 scores onto labels", () => {
  assert.equal(migrateWineSweetnessValue(1, "Red"), "Dry");
  assert.equal(migrateWineSweetnessValue(3, "White"), "Off-dry");
  assert.equal(migrateWineSweetnessValue(5, "Red"), "Sweet");
  assert.equal(migrateWineSweetnessValue(2, "Sparkling", "Champagne"), "Brut");
  assert.equal(migrateWineSweetnessValue(3, "Sparkling"), "Extra Dry");
  assert.equal(migrateWineSweetnessValue(5, "Sparkling"), "Doux");
  assert.equal(migrateWineSweetnessValue("Brut", "Sparkling"), "Brut");
  assert.equal(migrateWineSweetnessValue("", "Red"), "Dry");
});

test("wineSweetnessStops switches labels for sparkling", () => {
  assert.deepEqual(wineSweetnessStops("Red"), ["Bone dry", "Dry", "Off-dry", "Medium", "Sweet"]);
  assert.ok(wineSweetnessStops("Sparkling", "Champagne").includes("Brut"));
});

test("inferWineFamilyAndStyle reads Champagne and Prosecco from text", () => {
  assert.deepEqual(inferWineFamilyAndStyle("Dom Perignon Champagne"), { type: "Sparkling", style: "Champagne" });
  assert.deepEqual(inferWineFamilyAndStyle("La Marca Prosecco"), { type: "Sparkling", style: "Prosecco" });
  assert.deepEqual(inferWineFamilyAndStyle("skin-contact orange wine"), { type: "Orange", style: "" });
  assert.equal(inferWineFamilyAndStyle("Chardonnay").type, "White");
});

test("pintsRemaining uses US pints and never goes negative", () => {
  assert.equal(pintsRemaining(19.5), 41);
  assert.equal(pintsRemaining(0), 0);
  assert.equal(pintsRemaining(-1), 0);
});

test("pourPint subtracts one US pint and stops at zero", () => {
  assert.equal(pourPint(19.5), 19.027);
  assert.equal(pourPint(0.2), 0);
  assert.equal(pourPint(0), 0);
});

test("keg remaining snaps to 25% stops", () => {
  assert.equal(kegFillPercent(19.5, 19.5), 100);
  assert.equal(nearestKegStop(9.75, 19.5), 50);
  assert.equal(remainingFromPercent(19.5, 25), 4.875);
  assert.equal(kegSizeLabel(19.5), "Sixth barrel · 19.5 L");
});
