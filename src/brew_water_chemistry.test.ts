import assert from "node:assert/strict";
import test from "node:test";
import {
  BREWMASTER_CALCIUM_CHLORIDE,
  BREWING_SALT_PROFILES,
  DEFAULT_MASH_PH,
  LACTIC_DOSE_DEFERRED_LABEL,
  MINERAL_MATCH_TOLERANCE_PPM,
  VOLUME_INSUFFICIENT_MESSAGE,
  calculateMashPhGuidance,
  calculateMineralProfile,
  calculateWaterChemistry,
  formatGrams,
  parseGallons,
  parsePpmTarget,
  parseWaterVolumes,
  ppmFromSaltGrams,
  selectSaltsForTargets,
  solveNonNegativeLeastSquares
} from "./brew_water_chemistry.js";

const candyWater = {
  source: "100% Reverse Osmosis",
  strikeWater: "5.50 gal",
  spargeWater: "4.50 gal",
  targetMashPh: "5.20–5.35",
  chloridePpm: "200–225 ppm",
  sulfatePpm: "50–65 ppm",
  calciumPpm: "100–120 ppm"
};

test("midpoint parser resolves ranges and singles", () => {
  assert.equal(parsePpmTarget("200–225 ppm").ppm, 212.5);
  assert.equal(parsePpmTarget("50-65 ppm").ppm, 57.5);
  assert.equal(parsePpmTarget("100 to 120 ppm").ppm, 110);
  assert.equal(parsePpmTarget("150 ppm").ppm, 150);
  assert.equal(parsePpmTarget("~150 ppm").ppm, 150);
  assert.equal(parsePpmTarget("not a number").ppm, null);
  assert.equal(parsePpmTarget("").ppm, null);
  assert.equal(parsePpmTarget(null).ppm, null);
});

test("gallon parser accepts common volume forms", () => {
  assert.equal(parseGallons("5.50 gal"), 5.5);
  assert.equal(parseGallons("4 gallons"), 4);
  assert.equal(parseGallons("~4.50 Gallons"), 4.5);
  assert.equal(parseGallons("nope"), null);
});

test("Brewmaster calcium chloride contribution constants are exact", () => {
  assert.equal(BREWMASTER_CALCIUM_CHLORIDE.contributionsPerGramPerGallon.calciumPpm, 72);
  assert.equal(BREWMASTER_CALCIUM_CHLORIDE.contributionsPerGramPerGallon.chloridePpm, 127.5);
  const ppm = ppmFromSaltGrams("calcium_chloride_brewmaster", 1, 1);
  assert.equal(ppm.calciumPpm, 72);
  assert.equal(ppm.chloridePpm, 127.5);
});

test("all salt contributions live in one deterministic table", () => {
  const ids = BREWING_SALT_PROFILES.map((salt) => salt.id);
  assert.deepEqual(ids, [
    "calcium_chloride_brewmaster",
    "gypsum",
    "epsom",
    "sodium_chloride",
    "baking_soda",
    "chalk"
  ]);
  assert.equal(BREWING_SALT_PROFILES.every((salt) => salt.form.length > 0), true);
  const chalk = BREWING_SALT_PROFILES.find((salt) => salt.id === "chalk");
  assert.equal(chalk?.autoSelectable, false);
});

test("Candy Cloud targets resolve to exact midpoints from RO water", () => {
  const result = calculateMineralProfile(candyWater);
  assert.equal(result.source, "RO / distilled");
  assert.equal(result.targets.chloridePpm, 212.5);
  assert.equal(result.targets.sulfatePpm, 57.5);
  assert.equal(result.targets.calciumPpm, 110);
  assert.equal(result.volumes.strikeGal, 5.5);
  assert.equal(result.volumes.spargeGal, 4.5);
  assert.equal(result.volumes.totalGal, 10);
  assert.equal(result.volumes.canSplit, true);
  assert.ok(result.salts.length >= 1);
  assert.equal(result.salts.every((salt) => salt.totalGrams > 0), true);
  assert.equal(result.salts.every((salt) => salt.totalGrams >= 0), true);
});

test("strike + sparge enables proportional mash/sparge split", () => {
  const volumes = parseWaterVolumes({ strikeWater: "5.50 gal", spargeWater: "4.50 gal" });
  assert.equal(volumes.canSplit, true);
  assert.equal(volumes.totalGal, 10);
  const result = calculateMineralProfile(candyWater);
  for (const salt of result.salts) {
    assert.ok(salt.mashGrams != null && salt.spargeGrams != null);
    assert.ok(Math.abs((salt.mashGrams as number) - salt.totalGrams * 0.55) < 1e-9);
    assert.ok(Math.abs((salt.spargeGrams as number) - salt.totalGrams * 0.45) < 1e-9);
    assert.ok(Math.abs((salt.mashGrams as number) + (salt.spargeGrams as number) - salt.totalGrams) < 1e-9);
  }
});

test("strike-only without totalWater does not calculate salts", () => {
  const volumes = parseWaterVolumes({ strikeWater: "5.50 gal" });
  assert.equal(volumes.totalGal, null);
  assert.equal(volumes.canSplit, false);
  const result = calculateMineralProfile({
    strikeWater: "5.50 gal",
    chloridePpm: "200–225 ppm",
    sulfatePpm: "50–65 ppm",
    calciumPpm: "100–120 ppm"
  });
  assert.equal(result.salts.length, 0);
  assert.equal(result.status, "incomplete");
  assert.equal(result.statusMessage, VOLUME_INSUFFICIENT_MESSAGE);
});

test("sparge-only without totalWater does not calculate salts", () => {
  const volumes = parseWaterVolumes({ spargeWater: "4.50 gal" });
  assert.equal(volumes.totalGal, null);
  assert.equal(volumes.canSplit, false);
  const result = calculateMineralProfile({
    spargeWater: "4.50 gal",
    chloridePpm: "200–225 ppm",
    sulfatePpm: "50–65 ppm",
    calciumPpm: "100–120 ppm"
  });
  assert.equal(result.salts.length, 0);
  assert.equal(result.status, "incomplete");
  assert.equal(result.statusMessage, VOLUME_INSUFFICIENT_MESSAGE);
});

test("totalWater only calculates total grams without inventing a mash/sparge split", () => {
  const volumes = parseWaterVolumes({ totalWater: "10 gal", strikeWater: "5.50 gal" });
  assert.equal(volumes.canSplit, false);
  assert.equal(volumes.totalGal, 10);
  const result = calculateMineralProfile({
    totalWater: "10 gal",
    chloridePpm: "150 ppm",
    calciumPpm: "100 ppm"
  });
  assert.ok(result.salts.length > 0);
  assert.equal(result.volumes.canSplit, false);
  assert.equal(result.salts.every((salt) => salt.mashGrams == null && salt.spargeGrams == null), true);
});

test("achieved profile is computed from resulting salt masses including all counter-ions", () => {
  const result = calculateMineralProfile(candyWater);
  const totalGal = result.volumes.totalGal as number;
  const rebuilt = { calciumPpm: 0, chloridePpm: 0, sulfatePpm: 0 };
  for (const salt of result.salts) {
    const ppm = ppmFromSaltGrams(salt.id, salt.totalGrams, totalGal);
    rebuilt.calciumPpm += ppm.calciumPpm ?? 0;
    rebuilt.chloridePpm += ppm.chloridePpm ?? 0;
    rebuilt.sulfatePpm += ppm.sulfatePpm ?? 0;
  }
  assert.ok(Math.abs((result.achieved.calciumPpm ?? 0) - rebuilt.calciumPpm) < 1e-6);
  assert.ok(Math.abs((result.achieved.chloridePpm ?? 0) - rebuilt.chloridePpm) < 1e-6);
  assert.ok(Math.abs((result.achieved.sulfatePpm ?? 0) - rebuilt.sulfatePpm) < 1e-6);
});

test("achieved profile exposes chloride when sodium is fulfilled through NaCl", () => {
  const result = calculateMineralProfile({
    strikeWater: "5 gal",
    spargeWater: "5 gal",
    sodiumPpm: "40 ppm",
    chloridePpm: "40 ppm"
  });
  assert.ok(result.salts.some((salt) => salt.id === "sodium_chloride"));
  assert.ok((result.achieved.chloridePpm ?? 0) > 0);
  assert.ok((result.achieved.sodiumPpm ?? 0) > 0);
});

test("gypsum treatment exposes both calcium and sulfate in the achieved profile", () => {
  const result = calculateMineralProfile({
    totalWater: "10 gal",
    calciumPpm: "100 ppm",
    sulfatePpm: "50 ppm"
  });
  assert.ok(result.salts.some((salt) => salt.id === "gypsum"));
  assert.ok((result.achieved.sulfatePpm ?? 0) > 0);
  assert.ok((result.achieved.calciumPpm ?? 0) > 0);
});

test("Epsom without a sulfate target still exposes achieved sulfate counter-ion", () => {
  const result = calculateMineralProfile({
    totalWater: "10 gal",
    magnesiumPpm: "10 ppm"
  });
  assert.ok(result.salts.some((salt) => salt.id === "epsom"));
  assert.ok((result.achieved.magnesiumPpm ?? 0) > 0);
  assert.ok((result.achieved.sulfatePpm ?? 0) > 0);
  assert.equal(result.targets.sulfatePpm, undefined);
});

test("achieved profile exposes chloride from CaCl2", () => {
  const result = calculateMineralProfile({
    totalWater: "10 gal",
    calciumPpm: "72 ppm",
    chloridePpm: "127.5 ppm"
  });
  assert.ok(result.salts.some((salt) => salt.id === "calcium_chloride_brewmaster"));
  assert.ok((result.achieved.chloridePpm ?? 0) > 0);
});

test("achieved profile exposes sulfate from Epsom", () => {
  const result = calculateMineralProfile({
    ...candyWater,
    magnesiumPpm: "10 ppm"
  });
  assert.ok(result.salts.some((salt) => salt.id === "epsom"));
  assert.ok((result.achieved.magnesiumPpm ?? 0) > 0);
  assert.ok((result.achieved.sulfatePpm ?? 0) > 0);
});

test("chloride and calcium prefer calcium chloride; sulfate introduces gypsum", () => {
  const result = calculateMineralProfile(candyWater);
  const ids = result.salts.map((salt) => salt.id);
  assert.ok(ids.includes("calcium_chloride_brewmaster"));
  assert.ok(ids.includes("gypsum"));
  assert.equal(ids.includes("epsom"), false);
  assert.equal(ids.includes("baking_soda"), false);
  assert.equal(ids.includes("chalk"), false);
  assert.equal(ids.includes("sodium_chloride"), false);
});

test("magnesium target can introduce Epsom when Ca/Cl/SO4 already constrain the profile", () => {
  const result = calculateMineralProfile({
    ...candyWater,
    magnesiumPpm: "10 ppm"
  });
  assert.ok(result.salts.some((salt) => salt.id === "epsom"));
  assert.ok((result.achieved.magnesiumPpm ?? 0) > 0);
});

test("sodium with chloride uses sodium chloride without baking soda", () => {
  const result = calculateMineralProfile({
    strikeWater: "5 gal",
    spargeWater: "5 gal",
    sodiumPpm: "40 ppm",
    chloridePpm: "40 ppm"
  });
  assert.ok(result.salts.some((salt) => salt.id === "sodium_chloride"));
  assert.equal(result.salts.some((salt) => salt.id === "baking_soda"), false);
});

test("sodium-only profile does not silently choose NaCl", () => {
  const selection = selectSaltsForTargets({ sodiumPpm: 40 });
  assert.equal(selection.ok, false);
  if (!selection.ok) assert.match(selection.reason, /chloride or bicarbonate/i);
  const result = calculateMineralProfile({
    strikeWater: "5 gal",
    spargeWater: "5 gal",
    sodiumPpm: "40 ppm"
  });
  assert.equal(result.salts.length, 0);
  assert.equal(result.status, "incomplete");
  assert.match(result.statusMessage ?? "", /chloride or bicarbonate/i);
});

test("calcium-only profile is rejected as under-specified", () => {
  const selection = selectSaltsForTargets({ calciumPpm: 110 });
  assert.equal(selection.ok, false);
  if (!selection.ok) assert.match(selection.reason, /chloride and\/or sulfate/i);
  const result = calculateMineralProfile({
    strikeWater: "5 gal",
    spargeWater: "5 gal",
    calciumPpm: "100–120 ppm"
  });
  assert.equal(result.salts.length, 0);
  assert.equal(result.status, "incomplete");
  assert.match(result.statusMessage ?? "", /chloride and\/or sulfate/i);
});

test("baking soda appears when sodium and bicarbonate are both targeted", () => {
  const withBicarb = calculateMineralProfile({
    strikeWater: "5 gal",
    spargeWater: "5 gal",
    sodiumPpm: "50 ppm",
    bicarbonatePpm: "50 ppm"
  });
  assert.ok(withBicarb.salts.some((salt) => salt.id === "baking_soda"));
  assert.equal(withBicarb.salts.some((salt) => salt.id === "chalk"), false);
});

test("chalk is never auto-selected by the deterministic solver", () => {
  const withBakingSoda = selectSaltsForTargets({
    sodiumPpm: 50,
    bicarbonatePpm: 50
  });
  assert.equal(withBakingSoda.ok, true);
  if (withBakingSoda.ok) {
    assert.ok(withBakingSoda.salts.includes("baking_soda"));
    assert.equal(withBakingSoda.salts.includes("chalk"), false);
  }
  const candyPlusAlk = selectSaltsForTargets({
    calciumPpm: 110,
    chloridePpm: 212.5,
    sulfatePpm: 57.5,
    sodiumPpm: 40,
    bicarbonatePpm: 50
  });
  assert.equal(candyPlusAlk.ok, true);
  if (candyPlusAlk.ok) assert.equal(candyPlusAlk.salts.includes("chalk"), false);

  const bicarbWithoutSodium = calculateMineralProfile({
    strikeWater: "5 gal",
    spargeWater: "5 gal",
    bicarbonatePpm: "50 ppm"
  });
  assert.equal(bicarbWithoutSodium.salts.length, 0);
  assert.equal(bicarbWithoutSodium.status, "incomplete");
  assert.match(bicarbWithoutSodium.statusMessage ?? "", /sodium|chalk|bicarbonate/i);
  assert.equal(BREWING_SALT_PROFILES.find((salt) => salt.id === "chalk")?.autoSelectable, false);
});

test("no negative salt quantities from the solver", () => {
  const x = solveNonNegativeLeastSquares(
    [
      [72, 61.5],
      [127.5, 0],
      [0, 147.4]
    ],
    [110, 212.5, 57.5]
  );
  assert.equal(x.every((value) => value >= 0), true);
  const result = calculateMineralProfile(candyWater);
  assert.equal(result.salts.every((salt) => salt.totalGrams >= 0), true);
});

test("impossible exact combinations return mismatch instead of lying", () => {
  const result = calculateMineralProfile(candyWater);
  const caErr = Math.abs((result.achieved.calciumPpm ?? 0) - 110);
  const clErr = Math.abs((result.achieved.chloridePpm ?? 0) - 212.5);
  const so4Err = Math.abs((result.achieved.sulfatePpm ?? 0) - 57.5);
  const within = caErr <= MINERAL_MATCH_TOLERANCE_PPM
    && clErr <= MINERAL_MATCH_TOLERANCE_PPM
    && so4Err <= MINERAL_MATCH_TOLERANCE_PPM;
  if (within) {
    assert.equal(result.status, "matched");
    assert.equal(result.statusMessage, null);
  } else {
    assert.equal(result.status, "mismatch");
    assert.match(result.statusMessage ?? "", /not chemically achievable/i);
  }
  assert.ok(result.achieved.calciumPpm != null);
  assert.ok(result.achieved.chloridePpm != null);
  assert.ok(result.achieved.sulfatePpm != null);
  assert.ok(result.salts.every((salt) => typeof salt.totalGrams === "number"));
});

test("display rounds grams to 0.01 only after calculation", () => {
  assert.equal(formatGrams(7.2368), "7.24 g");
  assert.equal(formatGrams(7.234), "7.23 g");
  const result = calculateMineralProfile(candyWater);
  for (const salt of result.salts) {
    const displayed = Number(formatGrams(salt.totalGrams).replace(" g", ""));
    assert.ok(Math.abs(displayed - salt.totalGrams) < 0.01 + 1e-9);
  }
});

test("no salt additions when water volumes are missing entirely", () => {
  const result = calculateMineralProfile({
    chloridePpm: "200–225 ppm",
    sulfatePpm: "50–65 ppm",
    calciumPpm: "100–120 ppm"
  });
  assert.equal(result.salts.length, 0);
  assert.equal(result.status, "incomplete");
  assert.equal(result.statusMessage, VOLUME_INSUFFICIENT_MESSAGE);
});

test("unparseable mineral targets are retained without guessing", () => {
  const result = calculateMineralProfile({
    strikeWater: "5 gal",
    spargeWater: "5 gal",
    chloridePpm: "a lot"
  });
  assert.equal(result.salts.length, 0);
  assert.equal(result.targetDisplay[0]?.raw, "a lot");
  assert.equal(result.targetDisplay[0]?.calcPpm, null);
  assert.match(result.statusMessage ?? "", /could not be parsed/i);
});

test("targetMashPh from the recipe is preserved; absent defaults to 5.2–5.4", () => {
  const withTarget = calculateMashPhGuidance({ water: candyWater, fermentables: [] });
  assert.equal(withTarget.target.fromRecipe, true);
  assert.ok(withTarget.target.low >= 5.2 && withTarget.target.high <= 5.35);
  assert.equal(withTarget.measuredWriteIn, true);
  assert.equal(withTarget.acid, "88% lactic");
  const without = calculateMashPhGuidance({ water: { strikeWater: "5.5 gal" }, fermentables: [] });
  assert.equal(without.target.fromRecipe, false);
  assert.equal(without.target.low, DEFAULT_MASH_PH.low);
  assert.equal(without.target.high, DEFAULT_MASH_PH.high);
  assert.equal(without.measuredWriteIn, true);
});

test("no numeric lactic dose comes from a removed custom MCU model", () => {
  const guidance = calculateMashPhGuidance({
    water: { strikeWater: "5.50 gal", targetMashPh: "5.2–5.4" },
    fermentables: [
      { ingredient: "2-Row Pale Malt", amount: "11.50 lb", lovibond: "2" },
      { ingredient: "Crystal 60", amount: "1.00 lb", color: "60" },
      { ingredient: "Rice Hulls", amount: "1.00 lb" }
    ]
  });
  assert.equal(guidance.lacticAcid88Ml, null);
  assert.equal(guidance.predictedUntreatedMashPh, null);
  assert.equal(guidance.acidNeeded, null);
  assert.equal(guidance.confidence, "unavailable");
  assert.equal(guidance.lacticLabel, LACTIC_DOSE_DEFERRED_LABEL);
  assert.match(guidance.note, /insufficient|model/i);
  assert.equal(guidance.measuredWriteIn, true);
});

test("acid dose remains unavailable when fermentable color data is present but no model is configured", () => {
  const guidance = calculateMashPhGuidance({
    water: candyWater,
    fermentables: [
      { ingredient: "2-Row Pale Malt", amount: "11.50 lb" },
      { ingredient: "Flaked Oats", amount: "4.00 lb" }
    ]
  });
  assert.equal(guidance.lacticAcid88Ml, null);
  assert.equal(guidance.confidence, "unavailable");
  assert.equal(guidance.lacticLabel, LACTIC_DOSE_DEFERRED_LABEL);
  assert.equal(guidance.measuredWriteIn, true);
});

test("calculateWaterChemistry returns minerals and mash pH together", () => {
  const result = calculateWaterChemistry({
    water: candyWater,
    fermentables: [{ ingredient: "2-Row", amount: "12 lb", lovibond: "2" }]
  });
  assert.equal(result.minerals.targets.calciumPpm, 110);
  assert.equal(result.mashPh.measuredWriteIn, true);
  assert.ok(result.mashPh.target.label.includes("5."));
  assert.equal(result.mashPh.lacticAcid88Ml, null);
  assert.equal(result.mashPh.lacticLabel, LACTIC_DOSE_DEFERRED_LABEL);
});

test("RO starting ions are zero in the model", () => {
  const result = calculateMineralProfile({
    strikeWater: "1 gal",
    spargeWater: "0 gal",
    calciumPpm: "72 ppm",
    chloridePpm: "127.5 ppm"
  });
  const cacl2 = result.salts.find((salt) => salt.id === "calcium_chloride_brewmaster");
  assert.ok(cacl2);
  assert.ok(Math.abs(cacl2!.totalGrams - 1) < 0.05);
  assert.ok(Math.abs((result.achieved.calciumPpm ?? 0) - 72) < 2);
  assert.ok(Math.abs((result.achieved.chloridePpm ?? 0) - 127.5) < 2);
});
