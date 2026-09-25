/**
 * Turns a BrewRecipeDocument into the sections of the Smokey Barrel brew sheet.
 * Rendering lives in BrewSheetDocument.tsx. No values are invented.
 */

export type SheetPair = { label: string; value: string };
export type SheetStat = SheetPair & { writeIn: string | null };
export type SheetTable = { columns: string[]; rows: string[][] };
export type DryHopBlock = { stage: string; table: SheetTable };

export type BrewSheetModel = {
  beerName: string;
  style: string;
  system: string;
  fermenter: string;
  stats: SheetStat[];
  water: SheetPair[];
  fermentables: SheetTable | null;
  kettle: SheetTable | null;
  whirlpool: SheetTable | null;
  dryHops: DryHopBlock[];
  yeast: string;
  fermentationFields: SheetPair[];
  fermentationLines: string[];
  fermentationSteps: SheetTable | null;
  packagingFields: SheetPair[];
  packagingSteps: string[];
  warnings: string[];
  checklist: string[];
  measurements: string[];
  notes: string;
};

type Column = { label: string; keys: string[] };

const WATER_LABELS: Record<string, string> = {
  source: "Water source",
  strikeWater: "Strike water",
  spargeWater: "Sparge water",
  totalWater: "Total water",
  mashRatio: "Mash ratio",
  mashTemperature: "Mash temperature",
  mashTemp: "Mash temperature",
  mashDuration: "Mash duration",
  targetMashPh: "Target mash pH",
  chloridePpm: "Chloride",
  sulfatePpm: "Sulfate",
  calciumPpm: "Calcium",
  sodiumPpm: "Sodium ppm",
  magnesiumPpm: "Magnesium ppm",
  preBoilVolume: "Pre-boil volume",
  preBoilGravity: "Pre-boil gravity",
  notes: "Treatment notes",
  treatmentNotes: "Treatment notes"
};

const FIELD_LABELS: Record<string, string> = {
  pitchRate: "Pitch rate",
  pitchTemperature: "Pitch temperature",
  pitchTemp: "Pitch temperature",
  targetCO2: "Target CO2",
  ...WATER_LABELS
};

const FERMENTABLE_COLUMNS: Column[] = [
  { label: "Amount", keys: ["amount"] },
  { label: "Ingredient", keys: ["ingredient", "name", "malt"] },
  { label: "Type / timing", keys: ["type", "timing", "time", "lovibond", "color"] },
  { label: "Bill %", keys: ["percentage", "percent", "bill", "billPercent"] }
];

const KETTLE_COLUMNS: Column[] = [
  { label: "Time", keys: ["time"] },
  { label: "Ingredient", keys: ["ingredient", "variety", "hop", "name"] },
  { label: "Amount", keys: ["amount"] },
  { label: "Role", keys: ["role", "use"] }
];

const WHIRLPOOL_COLUMNS: Column[] = [
  { label: "Ingredient", keys: ["ingredient", "variety", "hop", "name"] },
  { label: "Amount", keys: ["amount"] },
  { label: "Temperature", keys: ["temperature", "temp"] },
  { label: "Time", keys: ["time", "duration"] }
];

const DRY_HOP_COLUMNS: Column[] = [
  { label: "Variety", keys: ["variety", "ingredient", "hop", "name"] },
  { label: "Amount", keys: ["amount"] },
  { label: "When", keys: ["when", "timing", "time"] },
  { label: "Temperature", keys: ["temperature", "temp"] },
  { label: "Gravity", keys: ["gravity", "gravityTrigger"] }
];

const STEP_COLUMNS: Column[] = [
  { label: "When", keys: ["when", "day", "timing"] },
  { label: "Temperature", keys: ["temperature", "temp"] },
  { label: "Gravity", keys: ["gravity"] },
  { label: "Action", keys: ["action", "instruction", "note"] }
];

export function sheetScalar(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return null;
}

export function sheetLabel(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return key;
  return words.map((word, index) => {
    const lower = word.toLowerCase();
    if (lower === "ppm" || lower === "ppb") return lower;
    if (lower === "ph") return "pH";
    if (lower === "og" || lower === "fg" || lower === "ibu" || lower === "abv" || lower === "co2") return lower.toUpperCase();
    if (index === 0) return lower.charAt(0).toUpperCase() + lower.slice(1);
    return lower;
  }).join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pairsFromRecord(record: Record<string, unknown>, order: string[], skip: Set<string>): SheetPair[] {
  const used = new Set<string>();
  const pairs: SheetPair[] = [];
  const take = (key: string) => {
    if (skip.has(key) || used.has(key)) return;
    const value = sheetScalar(record[key]);
    if (!value) return;
    used.add(key);
    pairs.push({ label: sheetLabel(key), value });
  };
  order.forEach(take);
  Object.keys(record).forEach(take);
  return pairs;
}

function columnText(row: Record<string, unknown>, column: Column): string | null {
  const parts = column.keys.map((key) => sheetScalar(row[key])).filter((value): value is string => Boolean(value));
  return parts.length ? parts.join(" · ") : null;
}

function detailText(row: Record<string, unknown>, columns: Column[]): string | null {
  const used = new Set(columns.flatMap((column) => column.keys));
  const parts = Object.keys(row).flatMap((key) => {
    if (used.has(key)) return [];
    const value = sheetScalar(row[key]);
    return value ? [`${sheetLabel(key)}: ${value}`] : [];
  });
  return parts.length ? parts.join(" · ") : null;
}

function sheetTable(value: unknown, columns: Column[]): SheetTable | null {
  if (!Array.isArray(value)) return null;
  const records = value.filter(isRecord);
  if (!records.length) return null;
  const active = columns.filter((column) => records.some((row) => columnText(row, column)));
  const details = records.map((row) => detailText(row, columns));
  const withDetails = details.some(Boolean);
  if (!active.length && !withDetails) return null;
  const headers = active.map((column) => column.label);
  if (withDetails) headers.push("Details");
  return {
    columns: headers,
    rows: records.map((row, index) => {
      const cells = active.map((column) => columnText(row, column) ?? "");
      if (withDetails) cells.push(details[index] ?? "");
      return cells;
    })
  };
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(sheetScalar).filter((item): item is string => Boolean(item));
}

function stat(label: string, value: unknown, writeIn: string | null = null): SheetStat | null {
  const text = sheetScalar(value);
  if (!text) return null;
  return { label, value: text, writeIn };
}

function mentionsColdCrash(fermentation: Record<string, unknown>, steps: unknown[]): boolean {
  const blobs = [
    ...Object.entries(fermentation).filter(([key]) => key !== "steps").map(([, value]) => sheetScalar(value) ?? ""),
    ...steps.map((step) => {
      if (typeof step === "string") return step;
      if (!isRecord(step)) return "";
      return Object.values(step).map((value) => sheetScalar(value) ?? "").join(" ");
    })
  ];
  return blobs.some((text) => /cold\s*crash/i.test(text));
}

function dryHopBlocks(value: unknown): DryHopBlock[] {
  if (!Array.isArray(value)) return [];
  const groups: { stage: string; rows: Record<string, unknown>[] }[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) return;
    const stage = sheetScalar(item.stage) ?? sheetScalar(item.name) ?? (value.length > 1 ? `Dry hop ${index + 1}` : "Dry hop");
    const current = groups.find((group) => group.stage === stage);
    if (current) current.rows.push(item);
    else groups.push({ stage, rows: [item] });
  });
  return groups.flatMap((group) => {
    const rows = group.rows.map((row) => {
      const copy = { ...row };
      delete copy.stage;
      return copy;
    });
    const table = sheetTable(rows, DRY_HOP_COLUMNS);
    return table ? [{ stage: group.stage, table }] : [];
  });
}

function measurements(input: {
  water: Record<string, unknown>;
  boilTime: string;
  targetOg: string;
  targetFg: string;
  yeast: string;
  dryHops: DryHopBlock[];
  coldCrash: boolean;
  whirlpool: boolean;
  packaging: boolean;
}): string[] {
  const lines: string[] = [];
  if (sheetScalar(input.water.targetMashPh) || sheetScalar(input.water.mashTemperature) || sheetScalar(input.water.mashTemp)) {
    lines.push("Mash pH");
  }
  if (sheetScalar(input.water.preBoilGravity) || sheetScalar(input.water.preBoilVolume) || input.boilTime) {
    if (sheetScalar(input.water.preBoilGravity) || input.boilTime) lines.push("Pre-boil gravity");
    if (sheetScalar(input.water.preBoilVolume) || input.boilTime) lines.push("Pre-boil volume");
  }
  if (input.boilTime) lines.push("Post-boil volume");
  if (input.whirlpool) lines.push("Knockout temp");
  if (input.targetOg) lines.push("Actual OG");
  if (input.yeast) lines.push("Yeast / pitch date");
  input.dryHops.forEach((block) => lines.push(`${block.stage} date`));
  if (input.targetFg) lines.push("Actual FG");
  if (input.coldCrash) lines.push("Cold crash date");
  if (input.packaging) {
    lines.push("Packaging date");
    lines.push("Transfer / keg volume");
  }
  return lines;
}

export function brewSheetModel(recipe: unknown): BrewSheetModel {
  const row = isRecord(recipe) ? recipe : {};
  const water = isRecord(row.water) ? row.water : {};
  const fermentation = isRecord(row.fermentation) ? row.fermentation : {};
  const packaging = isRecord(row.packaging) ? row.packaging : {};
  const steps = Array.isArray(fermentation.steps) ? fermentation.steps : [];
  const stepRecords = steps.filter(isRecord);
  const yeast = sheetScalar(fermentation.yeast) ?? "";
  const boilTime = sheetScalar(row.boilTime) ?? "";
  const targetOg = sheetScalar(row.targetOg) ?? "";
  const targetFg = sheetScalar(row.targetFg) ?? "";
  const dryHops = dryHopBlocks(row.dryHopStages);
  const whirlpool = sheetTable(row.whirlpoolAdditions, WHIRLPOOL_COLUMNS);
  const packagingFields = pairsFromRecord(packaging, ["targetCO2"], new Set(["steps"]));
  const packagingSteps = strings(packaging.steps);
  const stats = [
    stat("Target packaged", row.targetPackaged),
    stat("Fermenter volume", row.fermenterVolume),
    stat("Boil time", row.boilTime),
    stat("Target OG", row.targetOg, "Actual OG"),
    stat("Target FG", row.targetFg, "Actual FG"),
    stat("Target ABV", row.targetAbv),
    stat("Estimated IBU", row.estimatedIbu),
    stat("Mash efficiency", row.mashEfficiency)
  ].filter((item): item is SheetStat => item != null);

  return {
    beerName: sheetScalar(row.beerName) ?? "",
    style: sheetScalar(row.style) ?? "",
    system: sheetScalar(row.system) ?? "",
    fermenter: sheetScalar(row.fermenter) ?? "",
    stats,
    water: pairsFromRecord(water, Object.keys(WATER_LABELS), new Set()),
    fermentables: sheetTable(row.fermentables, FERMENTABLE_COLUMNS),
    kettle: sheetTable(row.kettleAdditions, KETTLE_COLUMNS),
    whirlpool,
    dryHops,
    yeast,
    fermentationFields: pairsFromRecord(fermentation, ["pitchRate", "pitchTemperature", "pitchTemp"], new Set(["yeast", "steps"])),
    fermentationLines: steps.map(sheetScalar).filter((item): item is string => Boolean(item)),
    fermentationSteps: sheetTable(stepRecords, STEP_COLUMNS),
    packagingFields,
    packagingSteps,
    warnings: strings(row.warnings),
    checklist: strings(row.checklist),
    measurements: measurements({
      water,
      boilTime,
      targetOg,
      targetFg,
      yeast,
      dryHops,
      coldCrash: mentionsColdCrash(fermentation, steps),
      whirlpool: whirlpool != null,
      packaging: packagingFields.length > 0 || packagingSteps.length > 0
    }),
    notes: sheetScalar(row.notes) ?? ""
  };
}
