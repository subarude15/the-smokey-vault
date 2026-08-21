import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseList, parseTagInput, serializeList, spiritFamilyFromLabel,
  defaultSweetnessForWine, inferWineFamilyAndStyle, migrateWineSweetnessValue,
  wineKindLabel, wineSweetnessStops,
  kegFillPercent, kegSizeLabel, nearestKegStop, pintsRemaining, pourPint, remainingFromPercent, brewToTap,
  emptyTapBeerFields, firstEmptyTapNumber, isTapEmpty, tapTitle,
  brewAbv, compareBrews, formatGravity, nextBrewStatus, normalizeBrewStatus,
  onTapLabel, parseCommaList, parseGravity, prepareBrewWrite, tapsForBatch,
  comparePackagedBeer, drinkOnePackaged, normalizeBeerVessel, packagedStockLabel, packagedToTap, preparePackagedWrite
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

test("brewToTap copies a brewery batch onto a homebrew tap", () => {
  const tap = brewToTap({
    batch_name: "Vault IPA",
    maker: "Nick",
    style: "IPA",
    calculated_abv: 6.4,
    tasting_notes: "Citrus and pine",
    flavors: '["Citrus"]',
    tags: '["house"]',
    notes: "Kegged 8/21",
    image_url: "/api/media/images/ipa.png"
  }, "2026-08-21");
  assert.equal(tap.source_type, "Homebrew");
  assert.equal(tap.brewery_batch, "Vault IPA");
  assert.equal(tap.maker, "Nick");
  assert.equal(tap.abv, 6.4);
  assert.equal(tap.keg_size_l, 19.5);
  assert.equal(tap.remaining_l, 19.5);
  assert.equal(tap.tapped_date, "2026-08-21");
});

test("packagedToTap copies a cold-room beer onto a commercial tap", () => {
  const tap = packagedToTap({
    name: "Nugget Nectar",
    brewery: "Tröegs",
    style: "Imperial Amber",
    abv: 7.5,
    vessel: "Can"
  }, "2026-08-21");
  assert.equal(tap.source_type, "Commercial");
  assert.equal(tap.brewery_batch, "Nugget Nectar");
  assert.equal(tap.maker, "Tröegs");
  assert.equal(tap.abv, 7.5);
  assert.equal(tap.remaining_l, 19.5);
});

test("packaged stock labels, drink-one, and out-of-stock sort", () => {
  assert.equal(normalizeBeerVessel("12oz can"), "Can");
  assert.equal(normalizeBeerVessel("bottle"), "Bottle");
  assert.equal(packagedStockLabel(6, "Can"), "6 cans");
  assert.equal(packagedStockLabel(1, "Bottle"), "1 bottle");
  assert.equal(packagedStockLabel(0, "Can"), "Out of stock");
  assert.equal(drinkOnePackaged(6), 5);
  assert.equal(drinkOnePackaged(0), 0);
  const sorted = [
    { name: "Zebra", brewery: "A", count: 0 },
    { name: "Alpha", brewery: "B", count: 4 },
    { name: "Beta", brewery: "A", count: 2 }
  ].sort(comparePackagedBeer).map((row) => row.name);
  assert.deepEqual(sorted, ["Beta", "Alpha", "Zebra"]);
});

test("preparePackagedWrite clamps count and normalizes vessel", () => {
  const saved = preparePackagedWrite({ count: -3, vessel: "crowler" });
  assert.equal(saved.count, 0);
  assert.equal(saved.vessel, "Crowler");
});

test("empty taps are None and firstEmptyTapNumber picks a free handle", () => {
  assert.equal(isTapEmpty({ brewery_batch: "" }), true);
  assert.equal(isTapEmpty({ brewery_batch: "None" }), true);
  assert.equal(isTapEmpty({ brewery_batch: "Vault IPA" }), false);
  assert.equal(tapTitle({ brewery_batch: "" }), "None");
  assert.equal(firstEmptyTapNumber([
    { tap_number: 1, brewery_batch: "IPA" },
    { tap_number: 2, brewery_batch: "" }
  ]), 2);
  assert.equal(emptyTapBeerFields().brewery_batch, "");
  assert.equal(emptyTapBeerFields().remaining_l, 0);
});

test("parseGravity accepts SG, points, and 1050-style values", () => {
  assert.equal(parseGravity("1.050"), 1.05);
  assert.equal(parseGravity(1.054), 1.054);
  assert.equal(parseGravity(1050), 1.05);
  assert.equal(parseGravity(50), 1.05);
  assert.equal(parseGravity(""), null);
  assert.equal(formatGravity(1.05), "1.050");
});

test("brewAbv prefers measured gravity and uses (OG − FG) × 131.25", () => {
  assert.equal(brewAbv({ target_og: 1.054, target_fg: 1.012 }), 5.5);
  assert.equal(brewAbv({
    target_og: 1.054,
    target_fg: 1.012,
    measured_og: 1.060,
    measured_fg: 1.010
  }), 6.6);
  assert.equal(brewAbv({ measured_og: 1.054, target_fg: 1.012 }), 5.5);
  assert.equal(brewAbv({ target_og: 1.050 }), null);
});

test("nextBrewStatus walks the pipeline and never auto-archives", () => {
  assert.equal(normalizeBrewStatus(""), "Planned");
  assert.equal(nextBrewStatus("Planned"), "Fermenting");
  assert.equal(nextBrewStatus("Fermenting"), "Conditioning");
  assert.equal(nextBrewStatus("Conditioning"), "Ready to Keg");
  assert.equal(nextBrewStatus("Ready to Keg"), null);
  assert.equal(nextBrewStatus("Archived"), null);
});

test("compareBrews keeps active batches ahead of archived, then along the pipeline", () => {
  const rows = [
    { batch_name: "Old Stout", status: "Archived", brew_date: "2026-01-01" },
    { batch_name: "House IPA", status: "Ready to Keg", brew_date: "2026-08-01" },
    { batch_name: "Pils", status: "Fermenting", brew_date: "2026-08-10" },
    { batch_name: "Earlier Pils", status: "Fermenting", brew_date: "2026-07-01" }
  ];
  const sorted = [...rows].sort(compareBrews).map((row) => row.batch_name);
  assert.deepEqual(sorted, ["Earlier Pils", "Pils", "House IPA", "Old Stout"]);
});

test("tapsForBatch matches brewery batch names onto handles", () => {
  const taps = [
    { tap_number: 3, brewery_batch: "Vault IPA" },
    { tap_number: 1, brewery_batch: "None" },
    { tap_number: 7, brewery_batch: "vault ipa" }
  ];
  assert.deepEqual(tapsForBatch(taps, "Vault IPA"), [3, 7]);
  assert.equal(onTapLabel([3]), "On tap 3");
  assert.equal(onTapLabel([3, 7]), "On taps 3, 7");
});

test("prepareBrewWrite normalizes gravity and stores calculated ABV", () => {
  const saved = prepareBrewWrite({
    status: "fermenting",
    target_og: 1054,
    target_fg: 12,
    measured_og: "",
    measured_fg: "",
    hops: "Citra, Mosaic, Idaho 7",
    flavors: "Grapefruit, pine"
  });
  assert.equal(saved.status, "Fermenting");
  assert.equal(saved.target_og, 1.054);
  assert.equal(saved.target_fg, 1.012);
  assert.equal(saved.calculated_abv, 5.5);
  assert.equal(saved.hops, '["Citra","Mosaic","Idaho 7"]');
  assert.equal(saved.flavors, '["Grapefruit","pine"]');
});

test("parseCommaList keeps multi-word hop names", () => {
  assert.deepEqual(parseCommaList("Citra, Mosaic, Idaho 7"), ["Citra", "Mosaic", "Idaho 7"]);
  assert.deepEqual(parseCommaList('["Nelson Sauvin"]'), ["Nelson Sauvin"]);
});
