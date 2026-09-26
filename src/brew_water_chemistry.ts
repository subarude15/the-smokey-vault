/**
 * Deterministic brewing-water chemistry for Smokey Barrel.
 *
 * Architecture: recipe text / AI supplies mineral targets + volumes;
 * this module alone decides salt grams and mash-pH starting guidance.
 * Preview and PDF both read the result through brewSheetModel — no second path.
 *
 * Source water for this PR: 100% RO / distilled (starting ions treated as zero).
 */

export type MineralIon =
  | "calciumPpm"
  | "magnesiumPpm"
  | "sodiumPpm"
  | "chloridePpm"
  | "sulfatePpm"
  | "bicarbonatePpm";

export type BrewingSaltId =
  | "calcium_chloride_brewmaster"
  | "gypsum"
  | "epsom"
  | "sodium_chloride"
  | "baking_soda"
  | "chalk";

export type IonContributions = Partial<Record<MineralIon, number>>;

export type BrewingSaltProfile = {
  id: BrewingSaltId;
  label: string;
  /** Documented chemical form / product note. */
  form: string;
  /** ppm contributed to treated water by 1.0 g of salt per US gallon. */
  contributionsPerGramPerGallon: IonContributions;
};

/**
 * Brewmaster Calcium Chloride product profile.
 * Values are the manufacturer’s published brewing contribution figures for the
 * product Nick uses — not a generic CaCl2 molecular-weight derivation.
 * 1.0 g per US gallon → 72 ppm Calcium, 127.5 ppm Chloride.
 */
export const BREWMASTER_CALCIUM_CHLORIDE: BrewingSaltProfile = {
  id: "calcium_chloride_brewmaster",
  label: "Calcium Chloride",
  form: "Brewmaster Calcium Chloride (published product brewing contribution)",
  contributionsPerGramPerGallon: {
    calciumPpm: 72,
    chloridePpm: 127.5
  }
};

/**
 * Established brewing-water contribution constants (ppm per g per US gallon).
 * Forms documented per salt. Used for every non-Brewmaster salt in one table.
 */
export const BREWING_SALT_PROFILES: BrewingSaltProfile[] = [
  BREWMASTER_CALCIUM_CHLORIDE,
  {
    id: "gypsum",
    label: "Gypsum",
    form: "CaSO4·2H2O (gypsum / calcium sulfate dihydrate)",
    contributionsPerGramPerGallon: {
      calciumPpm: 61.5,
      sulfatePpm: 147.4
    }
  },
  {
    id: "epsom",
    label: "Epsom Salt",
    form: "MgSO4·7H2O (Epsom salt / magnesium sulfate heptahydrate)",
    contributionsPerGramPerGallon: {
      magnesiumPpm: 26.1,
      sulfatePpm: 102.9
    }
  },
  {
    id: "sodium_chloride",
    label: "Sodium Chloride",
    form: "NaCl (standard food-grade non-iodized salt)",
    contributionsPerGramPerGallon: {
      sodiumPpm: 103.9,
      chloridePpm: 160.3
    }
  },
  {
    id: "baking_soda",
    label: "Baking Soda",
    form: "NaHCO3 (sodium bicarbonate)",
    contributionsPerGramPerGallon: {
      sodiumPpm: 72.3,
      bicarbonatePpm: 191.8
    }
  },
  {
    id: "chalk",
    label: "Chalk",
    form: "CaCO3 (calcium carbonate); dry addition assumes full contribution in the model",
    contributionsPerGramPerGallon: {
      calciumPpm: 105.8,
      bicarbonatePpm: 158.4
    }
  }
];

const SALT_BY_ID = Object.fromEntries(BREWING_SALT_PROFILES.map((salt) => [salt.id, salt])) as Record<
  BrewingSaltId,
  BrewingSaltProfile
>;

const ION_LABELS: Record<MineralIon, string> = {
  calciumPpm: "Calcium",
  magnesiumPpm: "Magnesium",
  sodiumPpm: "Sodium",
  chloridePpm: "Chloride",
  sulfatePpm: "Sulfate",
  bicarbonatePpm: "Bicarbonate"
};

const ION_SHORT: Record<MineralIon, string> = {
  calciumPpm: "Ca",
  magnesiumPpm: "Mg",
  sodiumPpm: "Na",
  chloridePpm: "Cl",
  sulfatePpm: "SO4",
  bicarbonatePpm: "HCO3"
};

/** ±1 ppm for “matched” status; full precision kept internally. */
export const MINERAL_MATCH_TOLERANCE_PPM = 1;

/** Default guidance when recipe has no targetMashPh. Room-temp mash-pH measurement range. */
export const DEFAULT_MASH_PH = { low: 5.2, high: 5.4, target: 5.3 } as const;

export type ParsedPpmTarget = {
  raw: string;
  /** Midpoint of a range, or the single value. Null when unparseable. */
  ppm: number | null;
};

export type WaterVolumes = {
  strikeGal: number | null;
  spargeGal: number | null;
  totalGal: number | null;
  /** True when strike and sparge are both known so a proportional split is valid. */
  canSplit: boolean;
};

export type SaltAddition = {
  id: BrewingSaltId;
  label: string;
  totalGrams: number;
  mashGrams: number | null;
  spargeGrams: number | null;
};

export type MineralProfileStatus = "matched" | "mismatch" | "incomplete";

export type WaterMineralResult = {
  source: "RO / distilled";
  volumes: WaterVolumes;
  targets: Partial<Record<MineralIon, number>>;
  targetDisplay: { ion: MineralIon; label: string; short: string; raw: string; calcPpm: number | null }[];
  achieved: Partial<Record<MineralIon, number>>;
  salts: SaltAddition[];
  status: MineralProfileStatus;
  statusMessage: string | null;
  residualsPpm: Partial<Record<MineralIon, number>>;
};

export type MashPhGuidance = {
  target: { low: number; high: number; target: number; label: string; fromRecipe: boolean };
  predictedUntreatedMashPh: number | null;
  acidNeeded: boolean | null;
  lacticAcid88Ml: number | null;
  confidence: "estimated" | "unavailable";
  note: string;
  measuredWriteIn: true;
};

export type WaterChemistryResult = {
  minerals: WaterMineralResult;
  mashPh: MashPhGuidance;
};

/** Parse "200–225 ppm", "200-225 ppm", "200 to 225 ppm", "150 ppm", "~150 ppm". */
export function parsePpmTarget(raw: unknown): ParsedPpmTarget {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return { raw: String(raw), ppm: raw };
  }
  if (typeof raw !== "string") return { raw: "", ppm: null };
  const text = raw.trim();
  if (!text) return { raw: "", ppm: null };

  const normalized = text
    .replace(/~/g, "")
    .replace(/ppm/gi, "")
    .replace(/[–—−]/g, "-")
    .replace(/\s+to\s+/gi, "-")
    .replace(/\s+/g, " ")
    .trim();

  const range = normalized.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (!(low >= 0 && high >= 0) || high < low) return { raw: text, ppm: null };
    return { raw: text, ppm: (low + high) / 2 };
  }

  const single = normalized.match(/^(\d+(?:\.\d+)?)$/);
  if (single) {
    const value = Number(single[1]);
    if (!(value >= 0)) return { raw: text, ppm: null };
    return { raw: text, ppm: value };
  }

  return { raw: text, ppm: null };
}

/** Parse "5.50 gal", "4 gallons", "~4.50 Gallons". */
export function parseGallons(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/~/g, "").replace(/\s+/g, " ");
  if (!text) return null;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(?:gal(?:lon)?s?)?$/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseWaterVolumes(water: Record<string, unknown>): WaterVolumes {
  const strikeGal = parseGallons(water.strikeWater);
  const spargeGal = parseGallons(water.spargeWater);
  const explicitTotal = parseGallons(water.totalWater);
  const canSplit = strikeGal != null && spargeGal != null;
  const totalGal = canSplit
    ? strikeGal + spargeGal
    : explicitTotal != null
      ? explicitTotal
      : strikeGal != null
        ? strikeGal
        : spargeGal != null
          ? spargeGal
          : null;
  return { strikeGal, spargeGal, totalGal, canSplit };
}

/** Display grams to 0.01 after full-precision calculation — never round early. */
export function formatGrams(grams: number): string {
  return `${(Math.round(grams * 100) / 100).toFixed(2)} g`;
}

export function formatPpm(ppm: number, digits = 1): string {
  const factor = 10 ** digits;
  return `${(Math.round(ppm * factor) / factor).toFixed(digits)} ppm`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePhRange(raw: unknown): { low: number; high: number; target: number } | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw < 14) {
    return { low: raw, high: raw, target: raw };
  }
  if (typeof raw !== "string") return null;
  const text = raw
    .trim()
    .replace(/~/g, "")
    .replace(/[–—−]/g, "-")
    .replace(/\s+to\s+/gi, "-")
    .replace(/\s+/g, " ");
  const range = text.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (!(low > 0 && high < 14) || high < low) return null;
    return { low, high, target: (low + high) / 2 };
  }
  const single = text.match(/^(\d+(?:\.\d+)?)$/);
  if (!single) return null;
  const value = Number(single[1]);
  if (!(value > 0 && value < 14)) return null;
  return { low: value, high: value, target: value };
}

/**
 * Choose the smallest sensible salt set for the supplied targets.
 * Does not enable baking soda / chalk / Epsom / NaCl unless the targets need them.
 */
export function selectSaltsForTargets(targets: Partial<Record<MineralIon, number>>): BrewingSaltId[] {
  const has = (ion: MineralIon) => targets[ion] != null && Number.isFinite(targets[ion]);
  const salts: BrewingSaltId[] = [];

  if (has("calciumPpm") || has("chloridePpm")) salts.push("calcium_chloride_brewmaster");
  if (has("calciumPpm") || has("sulfatePpm")) salts.push("gypsum");
  if (has("magnesiumPpm")) salts.push("epsom");

  const needBicarb = has("bicarbonatePpm");
  if (needBicarb) {
    salts.push("baking_soda");
    if (has("calciumPpm")) salts.push("chalk");
  }

  if (has("sodiumPpm") && !needBicarb) salts.push("sodium_chloride");
  if (has("sodiumPpm") && needBicarb && !salts.includes("baking_soda")) salts.push("baking_soda");

  // Extra chloride without calcium: NaCl can supply Cl without more Ca from CaCl2 alone.
  if (has("chloridePpm") && !has("calciumPpm") && !salts.includes("sodium_chloride")) {
    salts.push("sodium_chloride");
  }

  return [...new Set(salts)];
}

/**
 * Non-negative least squares via coordinate descent.
 * Minimizes ||A x - b||² subject to x ≥ 0. No external solver dependency.
 */
export function solveNonNegativeLeastSquares(A: number[][], b: number[], iterations = 800): number[] {
  const ionCount = A.length;
  const saltCount = A[0]?.length ?? 0;
  const x = Array.from({ length: saltCount }, () => 0);
  if (!ionCount || !saltCount) return x;

  for (let iter = 0; iter < iterations; iter++) {
    for (let j = 0; j < saltCount; j++) {
      let numerator = 0;
      let denominator = 0;
      for (let i = 0; i < ionCount; i++) {
        let without = 0;
        for (let k = 0; k < saltCount; k++) {
          if (k === j) continue;
          without += A[i][k] * x[k];
        }
        const column = A[i][j];
        numerator += column * (b[i] - without);
        denominator += column * column;
      }
      x[j] = denominator > 0 ? Math.max(0, numerator / denominator) : 0;
    }
  }
  return x;
}

function achievedFromGramsPerGallon(
  gramsPerGallon: number[],
  saltIds: BrewingSaltId[],
  ions: MineralIon[]
): Partial<Record<MineralIon, number>> {
  const achieved: Partial<Record<MineralIon, number>> = {};
  for (const ion of ions) {
    let sum = 0;
    saltIds.forEach((id, index) => {
      const contrib = SALT_BY_ID[id].contributionsPerGramPerGallon[ion] ?? 0;
      sum += contrib * gramsPerGallon[index];
    });
    achieved[ion] = sum;
  }
  return achieved;
}

function emptyMineralResult(
  volumes: WaterVolumes,
  targetDisplay: WaterMineralResult["targetDisplay"],
  targets: Partial<Record<MineralIon, number>>,
  statusMessage: string
): WaterMineralResult {
  return {
    source: "RO / distilled",
    volumes,
    targets,
    targetDisplay,
    achieved: {},
    salts: [],
    status: "incomplete",
    statusMessage,
    residualsPpm: {}
  };
}

export function calculateMineralProfile(water: Record<string, unknown>): WaterMineralResult {
  const volumes = parseWaterVolumes(water);
  const ionKeys: MineralIon[] = [
    "calciumPpm",
    "magnesiumPpm",
    "sodiumPpm",
    "chloridePpm",
    "sulfatePpm",
    "bicarbonatePpm"
  ];

  const targetDisplay = ionKeys.flatMap((ion) => {
    const rawValue = water[ion];
    if (rawValue == null || rawValue === "") return [];
    const parsed = parsePpmTarget(rawValue);
    if (!parsed.raw && parsed.ppm == null) return [];
    return [{
      ion,
      label: ION_LABELS[ion],
      short: ION_SHORT[ion],
      raw: parsed.raw || String(rawValue),
      calcPpm: parsed.ppm
    }];
  });

  const targets: Partial<Record<MineralIon, number>> = {};
  for (const row of targetDisplay) {
    if (row.calcPpm != null) targets[row.ion] = row.calcPpm;
  }

  const parseableTargets = Object.keys(targets) as MineralIon[];
  if (!targetDisplay.length) {
    return emptyMineralResult(volumes, targetDisplay, targets, "No mineral targets were supplied by this recipe.");
  }
  if (!parseableTargets.length) {
    return emptyMineralResult(
      volumes,
      targetDisplay,
      targets,
      "Mineral targets could not be parsed confidently. Salt additions were not calculated."
    );
  }

  if (volumes.totalGal == null || volumes.totalGal <= 0) {
    const message = volumes.canSplit
      ? "Add strike and sparge water volumes to calculate salt additions."
      : "Add strike and sparge water volumes to calculate salt additions.";
    return emptyMineralResult(volumes, targetDisplay, targets, message);
  }

  // Need a known treatment volume. Prefer strike+sparge; allow total-only for total grams (no split).
  if (!volumes.canSplit && volumes.totalGal == null) {
    return emptyMineralResult(
      volumes,
      targetDisplay,
      targets,
      "Add strike and sparge water volumes to calculate salt additions."
    );
  }

  const saltIds = selectSaltsForTargets(targets);
  const ions = parseableTargets;
  const A = ions.map((ion) =>
    saltIds.map((id) => SALT_BY_ID[id].contributionsPerGramPerGallon[ion] ?? 0)
  );
  const b = ions.map((ion) => targets[ion] ?? 0);
  const gramsPerGallon = solveNonNegativeLeastSquares(A, b);
  const achieved = achievedFromGramsPerGallon(gramsPerGallon, saltIds, ions);

  const residualsPpm: Partial<Record<MineralIon, number>> = {};
  let matched = true;
  for (const ion of ions) {
    const target = targets[ion] ?? 0;
    const got = achieved[ion] ?? 0;
    residualsPpm[ion] = got - target;
    if (Math.abs(got - target) > MINERAL_MATCH_TOLERANCE_PPM) matched = false;
  }

  const totalGal = volumes.totalGal;
  const mashFraction = volumes.canSplit && totalGal > 0 ? (volumes.strikeGal as number) / totalGal : null;
  const salts: SaltAddition[] = saltIds.flatMap((id, index) => {
    const totalGrams = gramsPerGallon[index] * totalGal;
    if (totalGrams <= 1e-9) return [];
    const mashGrams = mashFraction != null ? totalGrams * mashFraction : null;
    const spargeGrams = mashFraction != null ? totalGrams - (mashGrams as number) : null;
    return [{
      id,
      label: SALT_BY_ID[id].label,
      totalGrams,
      mashGrams,
      spargeGrams
    }];
  });

  if (!salts.length) {
    return {
      source: "RO / distilled",
      volumes,
      targets,
      targetDisplay,
      achieved,
      salts: [],
      status: "incomplete",
      statusMessage: "No mineral targets were supplied by this recipe.",
      residualsPpm
    };
  }

  return {
    source: "RO / distilled",
    volumes,
    targets,
    targetDisplay,
    achieved,
    salts,
    status: matched ? "matched" : "mismatch",
    statusMessage: matched
      ? null
      : "Exact target combination is not chemically achievable with the selected brewing salts.",
    residualsPpm
  };
}

type GrainRow = {
  pounds: number;
  lovibond: number | null;
  isMaltLike: boolean;
};

function parsePounds(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase().replace(/~/g, "").replace(/\s+/g, " ");
  const lb = text.match(/^(\d+(?:\.\d+)?)\s*(?:lb|lbs|pound|pounds)\b/);
  if (lb) return Number(lb[1]);
  const oz = text.match(/^(\d+(?:\.\d+)?)\s*(?:oz|ounce|ounces)\b/);
  if (oz) return Number(oz[1]) / 16;
  const kg = text.match(/^(\d+(?:\.\d+)?)\s*(?:kg|kilogram|kilograms)\b/);
  if (kg) return Number(kg[1]) * 2.20462262;
  const g = text.match(/^(\d+(?:\.\d+)?)\s*(?:g|gram|grams)\b/);
  if (g) return Number(g[1]) / 453.59237;
  return null;
}

function parseLovibond(row: Record<string, unknown>): number | null {
  for (const key of ["lovibond", "color", "colorLovibond", "l"]) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === "string") {
      const match = value.trim().replace(/°?\s*l(ovibond)?/i, "").match(/^(\d+(?:\.\d+)?)/);
      if (match) {
        const n = Number(match[1]);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    }
  }
  return null;
}

function isNonMaltAdjunct(name: string): boolean {
  return /\b(rice\s*hulls?|maltodextrin|sugar|dextrose|lactose|honey|cand[yi]|table\s*sugar|corn\s*sugar)\b/i.test(name);
}

/**
 * Mash-pH / 88% lactic starting-dose model (estimate, not exact).
 *
 * Assumptions:
 * - Source water alkalinity ≈ 0 (RO / distilled).
 * - Base untreated mash pH for a pale grist on RO water ≈ 5.75.
 * - Color-based acidity via MCU = Σ(°L × lb) / strike gallons (only rows with color).
 * - predictedUntreatedMashPh = 5.75 - 0.022 × MCU / (1 + 0.035 × MCU)
 *   (saturating so very dark mashes stay in a plausible band).
 * - Buffering ≈ 45 mEq per kg grain per pH unit (conservative mid-range literature value).
 * - 88% w/w lactic acid ≈ 11.8 mEq/mL.
 * - Dose applies to mash only — no sparge acidification in this PR.
 * - Requires color/lovibond on enough of the malt-like grist mass (≥70%).
 */
export function calculateMashPhGuidance(input: {
  water: Record<string, unknown>;
  fermentables: unknown;
}): MashPhGuidance {
  const fromRecipe = parsePhRange(input.water.targetMashPh);
  const target = fromRecipe
    ? {
        low: fromRecipe.low,
        high: fromRecipe.high,
        target: fromRecipe.target,
        label: `${formatPhValue(fromRecipe.low)}–${formatPhValue(fromRecipe.high)}`,
        fromRecipe: true
      }
    : {
        low: DEFAULT_MASH_PH.low,
        high: DEFAULT_MASH_PH.high,
        target: DEFAULT_MASH_PH.target,
        label: `${DEFAULT_MASH_PH.low}–${DEFAULT_MASH_PH.high}`,
        fromRecipe: false
      };

  const unavailable = (note: string): MashPhGuidance => ({
    target,
    predictedUntreatedMashPh: null,
    acidNeeded: null,
    lacticAcid88Ml: null,
    confidence: "unavailable",
    note,
    measuredWriteIn: true
  });

  const volumes = parseWaterVolumes(input.water);
  if (volumes.strikeGal == null || volumes.strikeGal <= 0) {
    return unavailable("88% lactic acid: calculate after mash pH measurement / insufficient malt acidity data");
  }

  const rows = Array.isArray(input.fermentables) ? input.fermentables.filter(isRecord) : [];
  const grains: GrainRow[] = rows.flatMap((row) => {
    const pounds = parsePounds(row.amount);
    if (pounds == null || pounds <= 0) return [];
    const name = String(row.ingredient ?? row.name ?? row.malt ?? "");
    return [{
      pounds,
      lovibond: parseLovibond(row),
      isMaltLike: !isNonMaltAdjunct(name)
    }];
  });

  const maltLike = grains.filter((grain) => grain.isMaltLike);
  const maltMass = maltLike.reduce((sum, grain) => sum + grain.pounds, 0);
  if (maltMass <= 0) {
    return unavailable("88% lactic acid: calculate after mash pH measurement / insufficient malt acidity data");
  }

  const coloredMass = maltLike
    .filter((grain) => grain.lovibond != null)
    .reduce((sum, grain) => sum + grain.pounds, 0);
  if (coloredMass / maltMass < 0.7) {
    return unavailable("88% lactic acid: calculate after mash pH measurement / insufficient malt acidity data");
  }

  let mcu = 0;
  for (const grain of maltLike) {
    if (grain.lovibond == null) continue;
    mcu += (grain.lovibond * grain.pounds) / volumes.strikeGal;
  }

  const predicted = 5.75 - (0.022 * mcu) / (1 + 0.035 * mcu);
  const acidNeeded = predicted > target.high + 0.02;
  if (!acidNeeded) {
    return {
      target,
      predictedUntreatedMashPh: predicted,
      acidNeeded: false,
      lacticAcid88Ml: null,
      confidence: "estimated",
      note: "None recommended initially. Verify mash pH after dough-in.",
      measuredWriteIn: true
    };
  }

  const deltaPh = predicted - target.target;
  const grainKg = maltMass / 2.20462262;
  const bufferingMeqPerKgPerPh = 45;
  const lacticMeqPerMl = 11.8;
  const lacticAcid88Ml = (deltaPh * bufferingMeqPerKgPerPh * grainKg) / lacticMeqPerMl;

  return {
    target,
    predictedUntreatedMashPh: predicted,
    acidNeeded: true,
    lacticAcid88Ml,
    confidence: "estimated",
    note: "Starting dose only. Verify mash pH after dough-in.",
    measuredWriteIn: true
  };
}

function formatPhValue(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? rounded.toFixed(1) : String(rounded);
}

export function calculateWaterChemistry(input: {
  water?: unknown;
  fermentables?: unknown;
}): WaterChemistryResult {
  const water = isRecord(input.water) ? input.water : {};
  const minerals = calculateMineralProfile(water);
  const mashPh = calculateMashPhGuidance({ water, fermentables: input.fermentables });
  return { minerals, mashPh };
}

/** Contribution helper for tests: ppm from grams of a salt in a given gallon volume. */
export function ppmFromSaltGrams(
  saltId: BrewingSaltId,
  grams: number,
  gallons: number
): IonContributions {
  if (gallons <= 0) return {};
  const profile = SALT_BY_ID[saltId];
  const gPerGal = grams / gallons;
  const out: IonContributions = {};
  for (const [ion, ppm] of Object.entries(profile.contributionsPerGramPerGallon) as [MineralIon, number][]) {
    out[ion] = ppm * gPerGal;
  }
  return out;
}
