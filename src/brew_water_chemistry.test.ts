import assert from "node:assert/strict";
import test from "node:test";
import {
  BREWMASTER_CALCIUM_CHLORIDE,
  BREWING_SALT_PROFILES,
  DEFAULT_MASH_PH,
  MINERAL_MATCH_TOLERANCE_PPM,
  calculateMashPhGuidance,
  calculateMineralProfile,
  calculateWaterChemistry,
  formatGrams,
  parseGallons,
  parsePpmTarget,
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

test("mash/sparge salt split is proportional and sums to total", () => {
  const result = calculateMineralProfile(candyWater);
  for (const salt of result.salts) {
    assert.ok(salt.mashGrams != null && salt.spargeGrams != null);
    assert.ok(Math.abs((salt.mashGrams as number) - salt.totalGrams * 0.55) < 1e-9);
    assert.ok(Math.abs((salt.spargeGrams as number) - salt.totalGrams * 0.45) < 1e-9);
    assert.ok(Math.abs((salt.mashGrams as number) + (salt.spargeGrams as number) - salt.totalGrams) < 1e-9);
  }
});

test("achieved profile is computed from resulting salt masses", () => {
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

test("magnesium target can introduce Epsom", () => {
  const result = calculateMineralProfile({
    ...candyWater,
    magnesiumPpm: "10 ppm"
  });
  assert.ok(result.salts.some((salt) => salt.id === "epsom"));
  assert.ok((result.achieved.magnesiumPpm ?? 0) > 0);
});

test("sodium target can introduce sodium chloride without baking soda by default", () => {
  const result = calculateMineralProfile({
    strikeWater: "5 gal",
    spargeWater: "5 gal",
    sodiumPpm: "40 ppm",
    chloridePpm: "40 ppm"
  });
  assert.ok(result.salts.some((salt) => salt.id === "sodium_chloride"));
  assert.equal(result.salts.some((salt) => salt.id === "baking_soda"), false);
});

test("baking soda appears only when bicarbonate is targeted", () => {
  const withBicarb = calculateMineralProfile({
    strikeWater: "5 gal",
    spargeWater: "5 gal",
    sodiumPpm: "50 ppm",
    bicarbonatePpm: "50 ppm"
  });
  assert.ok(withBicarb.salts.some((salt) => salt.id === "baking_soda"));
  const without = selectSaltsForTargets({ sodiumPpm: 40 });
  assert.ok(without.includes("sodium_chloride"));
  assert.equal(without.includes("baking_soda"), false);
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
  // Ca + Cl + SO4 midpoints are not independently achievable with CaCl2 + gypsum alone.
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

test("no salt additions when water volumes are insufficient", () => {
  const result = calculateMineralProfile({
    chloridePpm: "200–225 ppm",
    sulfatePpm: "50–65 ppm",
    calciumPpm: "100–120 ppm"
  });
  assert.equal(result.salts.length, 0);
  assert.equal(result.status, "incomplete");
  assert.match(result.statusMessage ?? "", /strike and sparge/i);
});

test("total-only volume calculates total grams without inventing a mash/sparge split", () => {
  const result = calculateMineralProfile({
    totalWater: "10 gal",
    chloridePpm: "150 ppm",
    calciumPpm: "100 ppm"
  });
  assert.ok(result.salts.length > 0);
  assert.equal(result.volumes.canSplit, false);
  assert.equal(result.salts.every((salt) => salt.mashGrams == null && salt.spargeGrams == null), true);
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
  const without = calculateMashPhGuidance({ water: { strikeWater: "5.5 gal" }, fermentables: [] });
  assert.equal(without.target.fromRecipe, false);
  assert.equal(without.target.low, DEFAULT_MASH_PH.low);
  assert.equal(without.target.high, DEFAULT_MASH_PH.high);
});

test("acid dose is not calculated when fermentable color data is insufficient", () => {
  const guidance = calculateMashPhGuidance({
    water: candyWater,
    fermentables: [
      { ingredient: "2-Row Pale Malt", amount: "11.50 lb" },
      { ingredient: "Flaked Oats", amount: "4.00 lb" }
    ]
  });
  assert.equal(guidance.lacticAcid88Ml, null);
  assert.equal(guidance.confidence, "unavailable");
  assert.match(guidance.note, /insufficient malt acidity data/i);
  assert.equal(guidance.measuredWriteIn, true);
});

test("acid result is estimated starting dose when color data supports it", () => {
  const guidance = calculateMashPhGuidance({
    water: { strikeWater: "5.50 gal", targetMashPh: "5.2–5.4" },
    fermentables: [
      { ingredient: "2-Row Pale Malt", amount: "11.50 lb", lovibond: "2" },
      { ingredient: "Crystal 60", amount: "1.00 lb", color: "60" },
      { ingredient: "Rice Hulls", amount: "1.00 lb" }
    ]
  });
  assert.equal(guidance.confidence, "estimated");
  assert.equal(guidance.measuredWriteIn, true);
  if (guidance.acidNeeded) {
    assert.ok((guidance.lacticAcid88Ml ?? 0) > 0);
    assert.match(guidance.note, /Starting dose|Verify mash pH/i);
  } else {
    assert.equal(guidance.lacticAcid88Ml, null);
    assert.match(guidance.note, /None recommended|Verify mash pH/i);
  }
});

test("calculateWaterChemistry returns minerals and mash pH together", () => {
  const result = calculateWaterChemistry({
    water: candyWater,
    fermentables: [{ ingredient: "2-Row", amount: "12 lb", lovibond: "2" }]
  });
  assert.equal(result.minerals.targets.calciumPpm, 110);
  assert.equal(result.mashPh.measuredWriteIn, true);
  assert.ok(result.mashPh.target.label.includes("5."));
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
