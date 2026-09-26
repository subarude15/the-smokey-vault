/**
 * Deterministic brewing-water chemistry for Smokey Barrel.
 *
 * Architecture: recipe text / AI supplies mineral targets + volumes;
 * this module alone decides salt grams and mash-pH starting guidance.
 * Preview and PDF both read the result through brewSheetModel — no second path.
 *
 * Source water for this PR: 100% RO / distilled (starting ions treated as zero).
 *
 * Mash-pH acid dosing: structured API is ready for a future established model.
 * This PR does not emit a numeric lactic mL dose from a homemade MCU equation.
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
  /**
   * When false, the salt stays in metadata only and is never auto-selected by
   * the deterministic solver (e.g. dry chalk dissolution is not modeled).
   */
  autoSelectable: boolean;
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
  autoSelectable: true,
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
    autoSelectable: true,
    contributionsPerGramPerGallon: {
      calciumPpm: 61.5,
      sulfatePpm: 147.4
    }
  },
  {
    id: "epsom",
    label: "Epsom Salt",
    form: "MgSO4·7H2O (Epsom salt / magnesium sulfate heptahydrate)",
    autoSelectable: true,
    contributionsPerGramPerGallon: {
      magnesiumPpm: 26.1,
      sulfatePpm: 102.9
    }
  },
  {
    id: "sodium_chloride",
    label: "Sodium Chloride",
    form: "NaCl (standard food-grade non-iodized salt)",
    autoSelectable: true,
    contributionsPerGramPerGallon: {
      sodiumPpm: 103.9,
      chloridePpm: 160.3
    }
  },
  {
    id: "baking_soda",
    label: "Baking Soda",
    form: "NaHCO3 (sodium bicarbonate)",
    autoSelectable: true,
    contributionsPerGramPerGallon: {
      sodiumPpm: 72.3,
      bicarbonatePpm: 191.8
    }
  },
  {
    id: "chalk",
    label: "Chalk",
    form: "CaCO3 (calcium carbonate); dry chalk dissolution is not modeled and is never auto-selected",
    autoSelectable: false,
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

const ALL_IONS: MineralIon[] = [
  "calciumPpm",
  "magnesiumPpm",
  "sodiumPpm",
  "chloridePpm",
  "sulfatePpm",
  "bicarbonatePpm"
];

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

/** Safe lactic line until an established mash-pH acid model is plugged in. */
export const LACTIC_DOSE_DEFERRED_LABEL = "Determine starting dose from measured mash pH";

export const VOLUME_INSUFFICIENT_MESSAGE =
  "Strike-only or sparge-only water is not enough to calculate salt additions. Provide both strike and sparge volumes, or an explicit total water volume.";

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

/**
 * Mash-pH guidance. Dose fields stay null until a defensible, documented model
 * is selected and wired in — do not invent mL from a homemade MCU equation.
 */
export type MashPhGuidance = {
  target: { low: number; high: number; target: number; label: string; fromRecipe: boolean };
  /** Configured mash acid for this brewery. */
  acid: "88% lactic";
  /** Reserved for a future established untreated-mash-pH prediction. */
  predictedUntreatedMashPh: number | null;
  /** Reserved for a future model that decides whether acid is needed. */
  acidNeeded: boolean | null;
  /** Reserved for a future numeric 88% lactic starting dose (mL). */
  lacticAcid88Ml: number | null;
  confidence: "estimated" | "unavailable";
  /** Keeper / sheet-facing dose line. */
  lacticLabel: string;
  note: string;
  measuredWriteIn: true;
};

export type WaterChemistryResult = {
  minerals: WaterMineralResult;
  mashPh: MashPhGuidance;
};

export type SaltSelection =
  | { ok: true; salts: BrewingSaltId[] }
  | { ok: false; reason: string };

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

/**
 * Treatment volume rules:
 * A) strike + sparge both known → total = sum, mash/sparge split allowed
 * B) explicit totalWater only (incomplete strike/sparge) → total grams only, no split
 * Lone strike or lone sparge without totalWater → insufficient (totalGal null)
 */
export function parseWaterVolumes(water: Record<string, unknown>): WaterVolumes {
  const strikeGal = parseGallons(water.strikeWater);
  const spargeGal = parseGallons(water.spargeWater);
  const explicitTotal = parseGallons(water.totalWater);
  const canSplit = strikeGal != null && spargeGal != null;
  const totalGal = canSplit
    ? strikeGal + spargeGal
    : explicitTotal != null
      ? explicitTotal
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

export function ionLabel(ion: MineralIon): string {
  return ION_LABELS[ion];
}

export function ionShort(ion: MineralIon): string {
  return ION_SHORT[ion];
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
 * Choose salts only when the recipe already constrains the desired profile.
 * The calculator must not invent a Cl/SO4 or Na/HCO3 balance the recipe omitted.
 * Chalk is never auto-selected (dry dissolution is not modeled).
 */
export function selectSaltsForTargets(targets: Partial<Record<MineralIon, number>>): SaltSelection {
  const has = (ion: MineralIon) => targets[ion] != null && Number.isFinite(targets[ion]);
  const hasCa = has("calciumPpm");
  const hasMg = has("magnesiumPpm");
  const hasNa = has("sodiumPpm");
  const hasCl = has("chloridePpm");
  const hasSo4 = has("sulfatePpm");
  const hasHco3 = has("bicarbonatePpm");

  if (hasCa && !hasCl && !hasSo4) {
    return {
      ok: false,
      reason: "Calcium target requires a chloride and/or sulfate target before salt additions can be calculated."
    };
  }
  if (hasNa && !hasCl && !hasHco3) {
    return {
      ok: false,
      reason: "Sodium target requires chloride or bicarbonate/alkalinity guidance before selecting a sodium salt."
    };
  }
  if (hasCl && !hasCa && !hasNa) {
    return {
      ok: false,
      reason: "Chloride target requires a calcium and/or sodium target before salt additions can be calculated."
    };
  }
  if (hasSo4 && !hasCa && !hasMg) {
    return {
      ok: false,
      reason: "Sulfate target requires a calcium and/or magnesium target before salt additions can be calculated."
    };
  }
  if (hasHco3 && !hasNa) {
    return {
      ok: false,
      reason: "Bicarbonate target requires sodium guidance before selecting baking soda. Dry chalk dissolution is not modeled."
    };
  }

  const salts: BrewingSaltId[] = [];
  if (hasCa && hasCl) salts.push("calcium_chloride_brewmaster");
  if (hasCa && hasSo4) salts.push("gypsum");
  if (hasMg) salts.push("epsom");
  if (hasNa && hasCl) salts.push("sodium_chloride");
  if (hasNa && hasHco3) salts.push("baking_soda");

  const selectable = salts.filter((id) => SALT_BY_ID[id].autoSelectable);
  if (!selectable.length) {
    return {
      ok: false,
      reason: "Mineral targets are under-specified for a deterministic salt selection."
    };
  }
  return { ok: true, salts: [...new Set(selectable)] };
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

/** Rebuild achieved ppm for every ion the selected salts can contribute. */
function achievedFromGramsPerGallon(
  gramsPerGallon: number[],
  saltIds: BrewingSaltId[]
): Partial<Record<MineralIon, number>> {
  const achieved: Partial<Record<MineralIon, number>> = {};
  for (const ion of ALL_IONS) {
    let sum = 0;
    saltIds.forEach((id, index) => {
      const contrib = SALT_BY_ID[id].contributionsPerGramPerGallon[ion] ?? 0;
      sum += contrib * gramsPerGallon[index];
    });
    if (sum > 1e-12) achieved[ion] = sum;
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

  const targetDisplay = ALL_IONS.flatMap((ion) => {
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
    return emptyMineralResult(volumes, targetDisplay, targets, VOLUME_INSUFFICIENT_MESSAGE);
  }

  const selection = selectSaltsForTargets(targets);
  if (!selection.ok) {
    return emptyMineralResult(volumes, targetDisplay, targets, selection.reason);
  }

  const saltIds = selection.salts;
  const ions = parseableTargets;
  const A = ions.map((ion) =>
    saltIds.map((id) => SALT_BY_ID[id].contributionsPerGramPerGallon[ion] ?? 0)
  );
  const b = ions.map((ion) => targets[ion] ?? 0);
  const gramsPerGallon = solveNonNegativeLeastSquares(A, b);
  const achieved = achievedFromGramsPerGallon(gramsPerGallon, saltIds);

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
    return emptyMineralResult(
      volumes,
      targetDisplay,
      targets,
      "No salt additions were produced for the supplied mineral targets."
    );
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

/**
 * Mash-pH / 88% lactic guidance.
 *
 * Preserves recipe targetMashPh (else defaults to 5.2–5.4) and the measured
 * write-in line. Numeric lactic mL stays null until an established model is
 * selected — do not invent a dose from a homemade MCU formula.
 */
export function calculateMashPhGuidance(input: {
  water: Record<string, unknown>;
  fermentables: unknown;
}): MashPhGuidance {
  void input.fermentables;
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

  return {
    target,
    acid: "88% lactic",
    predictedUntreatedMashPh: null,
    acidNeeded: null,
    lacticAcid88Ml: null,
    confidence: "unavailable",
    lacticLabel: LACTIC_DOSE_DEFERRED_LABEL,
    note: "Not calculated — malt acidity data/model insufficient. Verify mash pH after dough-in.",
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
