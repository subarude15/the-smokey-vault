export const WHISKEY_TYPES = [
  "Bourbon", "Rye", "Scotch", "Irish", "Corn whiskey", "Tennessee",
  "Canadian", "Japanese", "Blended", "Wheat whiskey"
];

export function parseList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueList(value.map((entry) => String(entry)));
  }
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return uniqueList(parsed.map((entry) => String(entry)));
  } catch {
    // Plain text / hashtag input.
  }
  return uniqueList(value.split(/[\s,]+/));
}

export function serializeList(values: string[]): string {
  return JSON.stringify(uniqueList(values));
}

export function parseTagInput(input: string): string[] {
  return uniqueList(input.split(/[\s,]+/).map((part) => part.replace(/^#/, "")));
}

function uniqueList(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.replace(/^#/, "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function spiritFamilyFromLabel(category: string, subCategory = ""): { family: string; type: string } {
  const familyRaw = category.trim();
  const typeRaw = subCategory.trim();
  const haystack = `${familyRaw} ${typeRaw}`.toLowerCase();
  if (!familyRaw) return { family: "Mixer", type: typeRaw };
  if (familyRaw.toLowerCase() === "whiskey" || familyRaw.toLowerCase() === "whisky") {
    return { family: "Whiskey", type: typeRaw };
  }
  const whiskeyType = WHISKEY_TYPES.find((value) => haystack.includes(value.toLowerCase()));
  if (whiskeyType || /whisky|whiskey/.test(haystack)) {
    return { family: "Whiskey", type: typeRaw || whiskeyType || familyRaw };
  }
  if (/gin/.test(haystack)) return { family: "Gin", type: typeRaw };
  if (/tequila/.test(haystack)) return { family: "Tequila", type: typeRaw };
  if (/mezcal/.test(haystack)) return { family: "Mezcal", type: typeRaw };
  if (/\brum\b/.test(haystack)) return { family: "Rum", type: typeRaw };
  if (/amaro/.test(haystack)) return { family: "Amaro", type: typeRaw };
  if (/liqueur|cordial/.test(haystack)) return { family: "Liqueur", type: typeRaw };
  if (/bitter/.test(haystack)) return { family: "Bitters", type: typeRaw };
  if (/vodka/.test(haystack)) return { family: "Vodka", type: typeRaw };
  if (/cognac/.test(haystack)) return { family: "Cognac", type: typeRaw };
  if (/brandy|armagnac|pisco/.test(haystack)) return { family: "Brandy", type: typeRaw };
  return { family: familyRaw, type: typeRaw };
}

export const WINE_FAMILIES = [
  "Red", "White", "Rosé", "Orange", "Sparkling", "Dessert", "Fortified"
];

export const SPARKLING_STYLES = [
  "Champagne", "Prosecco", "Cava", "Crémant", "Pét-nat", "Other"
];

export const STILL_WINE_SWEETNESS = [
  "Bone dry", "Dry", "Off-dry", "Medium", "Sweet"
];

export const SPARKLING_SWEETNESS = [
  "Brut Nature", "Extra Brut", "Brut", "Extra Dry", "Sec", "Demi-sec", "Doux"
];

export function isSparklingWine(type?: string | null, style?: string | null): boolean {
  if (String(type ?? "").trim().toLowerCase() === "sparkling") return true;
  const sparkle = String(style ?? "").trim().toLowerCase();
  return SPARKLING_STYLES.some((value) => value.toLowerCase() === sparkle);
}

export function wineKindLabel(type?: string | null, style?: string | null): string {
  const sparkle = String(style ?? "").trim();
  if (sparkle) return sparkle;
  return String(type ?? "").trim();
}

export function wineSweetnessStops(type?: string | null, style?: string | null): string[] {
  return isSparklingWine(type, style) ? [...SPARKLING_SWEETNESS] : [...STILL_WINE_SWEETNESS];
}

export function defaultSweetnessForWine(type?: string | null, style?: string | null): string {
  const family = String(type ?? "").trim();
  if (/dessert|fortified/i.test(family)) return "Sweet";
  if (isSparklingWine(family, style)) {
    if (/prosecco/i.test(String(style ?? ""))) return "Extra Dry";
    return "Brut";
  }
  return "Dry";
}

export function migrateWineSweetnessValue(value: unknown, type?: string | null, style?: string | null): string {
  if (value == null || String(value).trim() === "") return defaultSweetnessForWine(type, style);
  const raw = String(value).trim();
  const known = [...STILL_WINE_SWEETNESS, ...SPARKLING_SWEETNESS]
    .find((stop) => stop.toLowerCase() === raw.toLowerCase());
  if (known) return known;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 1 && n <= 5) {
    if (isSparklingWine(type, style)) {
      if (n <= 2) return "Brut";
      if (n === 3) return "Extra Dry";
      return n >= 5 ? "Doux" : "Demi-sec";
    }
    if (n <= 2) return "Dry";
    if (n === 3) return "Off-dry";
    return "Sweet";
  }
  return raw;
}

export function inferWineFamilyAndStyle(text: string): { type: string; style: string } {
  const hay = text.toLowerCase();
  if (/champagne/.test(hay)) return { type: "Sparkling", style: "Champagne" };
  if (/prosecco/.test(hay)) return { type: "Sparkling", style: "Prosecco" };
  if (/\bcava\b/.test(hay)) return { type: "Sparkling", style: "Cava" };
  if (/cr[eé]mant/.test(hay)) return { type: "Sparkling", style: "Crémant" };
  if (/p[eé]t[- ]?nat|pétillant naturel/.test(hay)) return { type: "Sparkling", style: "Pét-nat" };
  if (/sparkling/.test(hay)) return { type: "Sparkling", style: "" };
  if (/ros[eé]|blush/.test(hay)) return { type: "Rosé", style: "" };
  if (/orange wine|skin[- ]contact/.test(hay)) return { type: "Orange", style: "" };
  if (/dessert|late harvest|sauternes|ice ?wine/.test(hay)) return { type: "Dessert", style: "" };
  if (/\bport\b|sherry|madeira|marsala|fortified/.test(hay)) return { type: "Fortified", style: "" };
  if (/white|chardonnay|sauvignon|riesling|pinot gr|albari[nñ]o|viognier/.test(hay)) return { type: "White", style: "" };
  return { type: "Red", style: "" };
}
