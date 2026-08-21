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

export function parseCommaList(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueList(value.map((entry) => String(entry)));
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return uniqueList(parsed.map((entry) => String(entry)));
  } catch {
    // Comma-separated names that may contain spaces, such as Idaho 7.
  }
  return uniqueList(value.split(","));
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

export const TAP_COUNT = 7;

export const US_PINT_L = 0.473176;

export const DEFAULT_KEG_L = 19.5;

export const KEG_SIZES = [
  { label: "Cornelius (5 gal)", liters: 18.9 },
  { label: "Sixth barrel", liters: 19.5 },
  { label: "Quarter barrel", liters: 29.3 },
  { label: "Half barrel", liters: 58.7 },
  { label: "20 L", liters: 20 },
  { label: "30 L", liters: 30 },
  { label: "50 L", liters: 50 }
];

export const KEG_REMAINING_STOPS = [
  { label: "Full", percent: 100 },
  { label: "¾", percent: 75 },
  { label: "Half", percent: 50 },
  { label: "¼", percent: 25 },
  { label: "Kicked", percent: 0 }
];

export function roundLiters(value: number): number {
  return Math.round(Math.max(0, value) * 1000) / 1000;
}

export function kegFillPercent(remainingL: number, kegSizeL: number): number {
  if (!(kegSizeL > 0)) return 0;
  return Math.max(0, Math.min(100, (Number(remainingL) / kegSizeL) * 100));
}

export function pintsRemaining(remainingL: number): number {
  return Math.floor(Math.max(0, Number(remainingL) || 0) / US_PINT_L + 1e-9);
}

export function pourPint(remainingL: number): number {
  return roundLiters(Math.max(0, Number(remainingL) - US_PINT_L));
}

export function remainingFromPercent(kegSizeL: number, percent: number): number {
  return roundLiters((Number(kegSizeL) || 0) * percent / 100);
}

export function nearestKegStop(remainingL: number, kegSizeL: number): number {
  const pct = kegFillPercent(remainingL, kegSizeL);
  return KEG_REMAINING_STOPS.reduce((best, stop) =>
    Math.abs(stop.percent - pct) < Math.abs(best - pct) ? stop.percent : best, KEG_REMAINING_STOPS[0].percent);
}

export function kegSizeLabel(liters: number): string {
  const match = KEG_SIZES.find((size) => Math.abs(size.liters - Number(liters)) < 0.05);
  if (match) return `${match.label} · ${match.liters} L`;
  const n = Number(liters);
  return Number.isFinite(n) && n > 0 ? `${n} L` : "";
}

export function brewToTap(brew: Record<string, unknown>, tappedDate = new Date().toISOString().slice(0, 10)): Record<string, unknown> {
  return {
    maker: brew.maker ?? "",
    brewery_batch: brew.batch_name ?? brew.name ?? "",
    style: brew.style ?? "",
    abv: brew.calculated_abv ?? brew.abv ?? 0,
    image_url: brew.image_url ?? "",
    tasting_notes: brew.tasting_notes ?? "",
    flavors: brew.flavors ?? "[]",
    tags: brew.tags ?? "[]",
    notes: brew.notes ?? "",
    base_ingredient: brew.base_ingredient ?? "",
    source_type: "Homebrew",
    keg_size_l: DEFAULT_KEG_L,
    remaining_l: DEFAULT_KEG_L,
    tapped_date: tappedDate
  };
}

export function isTapEmpty(item: Record<string, unknown> | null | undefined): boolean {
  const name = String(item?.brewery_batch ?? "").trim();
  return !name || /^none$/i.test(name);
}

export function tapTitle(item: Record<string, unknown>): string {
  return isTapEmpty(item) ? "None" : String(item.brewery_batch ?? "Untitled");
}

export function emptyTapBeerFields(): Record<string, unknown> {
  return {
    brewery_batch: "",
    maker: "",
    style: "",
    abv: 0,
    ibu: 0,
    tapped_date: "",
    remaining_l: 0,
    notes: "",
    tasting_notes: "",
    flavors: "[]",
    tags: "[]",
    image_url: "",
    base_ingredient: "",
    source_type: "Commercial"
  };
}

export function firstEmptyTapNumber(taps: Array<Record<string, unknown>>): number {
  const taken = new Set(taps.filter((tap) => !isTapEmpty(tap)).map((tap) => Number(tap.tap_number)));
  for (let n = 1; n <= TAP_COUNT; n++) {
    if (!taken.has(n)) return n;
  }
  return 1;
}

export const BREW_STATUSES = [
  "Planned",
  "Fermenting",
  "Conditioning",
  "Ready to Keg",
  "Archived"
] as const;

export type BrewStatus = typeof BREW_STATUSES[number];

export const ACTIVE_BREW_STATUSES: BrewStatus[] = BREW_STATUSES.filter((status) => status !== "Archived");

export const GRAVITY_FIELDS = ["target_og", "target_fg", "measured_og", "measured_fg"] as const;

export function normalizeBrewStatus(value: unknown): BrewStatus {
  const raw = String(value ?? "").trim().toLowerCase();
  return BREW_STATUSES.find((status) => status.toLowerCase() === raw) ?? "Planned";
}

export function nextBrewStatus(value: unknown): BrewStatus | null {
  const current = normalizeBrewStatus(value);
  if (current === "Archived") return null;
  const index = ACTIVE_BREW_STATUSES.indexOf(current);
  if (index < 0 || index >= ACTIVE_BREW_STATUSES.length - 1) return null;
  return ACTIVE_BREW_STATUSES[index + 1];
}

export function parseGravity(value: unknown): number | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 900 && n < 2000) return Math.round(n) / 1000;
  if (n >= 10 && n < 200) return Math.round((1 + n / 1000) * 1000) / 1000;
  if (n >= 0.9 && n < 2) return Math.round(n * 1000) / 1000;
  return null;
}

export function formatGravity(value: unknown): string {
  const gravity = parseGravity(value);
  return gravity == null ? "" : gravity.toFixed(3);
}

export function calculateAbv(og: unknown, fg: unknown): number | null {
  const original = parseGravity(og);
  const final = parseGravity(fg);
  if (original == null || final == null) return null;
  if (original <= final) return 0;
  return Math.round((original - final) * 131.25 * 10) / 10;
}

export function brewAbv(item: Record<string, unknown>): number | null {
  const og = parseGravity(item.measured_og) ?? parseGravity(item.target_og);
  const fg = parseGravity(item.measured_fg) ?? parseGravity(item.target_fg);
  return calculateAbv(og, fg);
}

export function formatAbv(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  return String(Math.round(n * 10) / 10);
}

export function prepareBrewWrite(body: Record<string, unknown>, existing?: Record<string, unknown>): Record<string, unknown> {
  const next = { ...body };
  for (const field of GRAVITY_FIELDS) {
    if (next[field] === undefined) continue;
    next[field] = parseGravity(next[field]);
  }
  if (next.status !== undefined) next.status = normalizeBrewStatus(next.status);
  if (next.hops !== undefined) next.hops = serializeList(parseCommaList(next.hops));
  if (next.flavors !== undefined) next.flavors = serializeList(parseCommaList(next.flavors));
  const abv = brewAbv({ ...existing, ...next });
  if (abv != null) next.calculated_abv = abv;
  return next;
}

export function compareBrews(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const aArchived = normalizeBrewStatus(a.status) === "Archived" ? 1 : 0;
  const bArchived = normalizeBrewStatus(b.status) === "Archived" ? 1 : 0;
  if (aArchived !== bArchived) return aArchived - bArchived;
  const rank = BREW_STATUSES.indexOf(normalizeBrewStatus(a.status)) - BREW_STATUSES.indexOf(normalizeBrewStatus(b.status));
  if (rank !== 0) return rank;
  const dateA = String(a.brew_date ?? "").trim() || "9999-99-99";
  const dateB = String(b.brew_date ?? "").trim() || "9999-99-99";
  const dates = dateA.localeCompare(dateB);
  if (dates !== 0) return dates;
  return String(a.batch_name ?? "").localeCompare(String(b.batch_name ?? ""), undefined, { sensitivity: "base" });
}

export function tapsForBatch(taps: Array<Record<string, unknown>>, batchName: unknown): number[] {
  const name = String(batchName ?? "").trim().toLowerCase();
  if (!name) return [];
  return taps
    .filter((tap) => !isTapEmpty(tap) && String(tap.brewery_batch ?? "").trim().toLowerCase() === name)
    .map((tap) => Number(tap.tap_number))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}

export function onTapLabel(tapNumbers: number[]): string {
  if (!tapNumbers.length) return "";
  if (tapNumbers.length === 1) return `On tap ${tapNumbers[0]}`;
  return `On taps ${tapNumbers.join(", ")}`;
}
