import {
  CANONICAL_WHISKEY_TYPES,
  canonicalFamilyFromText,
  canonicalWhiskeyTypeFromText,
  isCompatibleClassificationSpecialization,
  normalizeCanonicalAbv,
  normalizeCanonicalProof,
  normalizeCanonicalTaxonomy,
  normalizeCanonicalVolumeMl,
  stripPackageTokensFromName
} from "./canonical-normalize.js";

export const WHISKEY_TYPES = [...CANONICAL_WHISKEY_TYPES];

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
  // Unresolved — never invent Mixer without affirmative evidence.
  if (!familyRaw && !typeRaw) return { family: "", type: "" };

  const tax = normalizeCanonicalTaxonomy(familyRaw, typeRaw);
  if (tax.family) {
    return { family: tax.family, type: tax.type };
  }

  // Preserve empty / junk as unresolved — never return Food / Beverages as family.
  if (tax.discardedJunk || tax.wasCommerceTaxonomy) {
    return { family: "", type: "" };
  }

  // Non-junk unknown labels (rare custom families) pass through when usable length.
  if (familyRaw && familyRaw.length <= 40 && !familyRaw.includes(">")) {
    return { family: familyRaw, type: typeRaw };
  }
  return { family: "", type: "" };
}

/**
 * Merge an incoming classification label with an existing spirits row family/type.
 * Specificity is monotonic: Whiskey + Scotch Whisky cannot collapse to Whiskey / "".
 */

/** Affirmative mixer evidence in trusted identity text (name / category / product_type). */
const MIXER_AFFIRMATIVE_RE =
  /\b(mixer|tonic(?:\s+water)?|soda(?:\s+water)?|syrup|ginger\s*beer|club\s*soda|seltzer|sparkling\s*water|grenadine|collins\s*mix|sweet\s*(?:&|and)\s*sour)\b/i;

export function hasAffirmativeMixerEvidence(text: string): boolean {
  return MIXER_AFFIRMATIVE_RE.test(String(text ?? ""));
}

/**
 * Conservative first-save classification reconciliation.
 * Uses trusted lookup name / category / product_type evidence only — never brand-only guessing.
 * Strong spirit identity in the name outranks a weak upstream Mixer (or empty) category.
 */
export function reconcileSpiritClassificationForFirstSave(input: {
  name?: string | null;
  category?: string | null;
  subCategory?: string | null;
  productType?: string | null;
}): { family: string; type: string } {
  const name = String(input.name ?? "").trim();
  const category = String(input.category ?? "").trim();
  const subCategory = String(input.subCategory ?? "").trim();
  const productType = String(input.productType ?? "").trim();

  const fromLabels = spiritFamilyFromLabel(category, subCategory);

  const nameFamily = canonicalFamilyFromText(name);
  const nameWhiskeyType = canonicalWhiskeyTypeFromText(name);
  let identityFamily = nameFamily ?? "";
  let identityType = "";
  if (nameFamily === "Whiskey" || nameWhiskeyType) {
    identityFamily = "Whiskey";
    identityType = nameWhiskeyType && !/^(whisky|whiskey)$/i.test(nameWhiskeyType) ? nameWhiskeyType : "";
  } else if (nameFamily) {
    identityFamily = nameFamily;
    identityType = "";
  }
  if (!identityFamily && productType) {
    const ptFamily = canonicalFamilyFromText(productType);
    const ptWhiskey = canonicalWhiskeyTypeFromText(productType);
    if (ptFamily === "Whiskey" || ptWhiskey) {
      identityFamily = "Whiskey";
      identityType = ptWhiskey && !/^(whisky|whiskey)$/i.test(ptWhiskey) ? ptWhiskey : "";
    } else if (ptFamily && ptFamily !== "Mixer") {
      identityFamily = ptFamily;
    }
  }

  const mixerHaystack = `${name} ${category} ${subCategory} ${productType}`;
  const mixerAffirmative = hasAffirmativeMixerEvidence(mixerHaystack);

  // Name/product_type spirit evidence wins over Mixer or empty.
  if (identityFamily && identityFamily !== "Mixer") {
    if (!fromLabels.family || fromLabels.family === "Mixer") {
      return { family: identityFamily, type: identityType };
    }
    if (fromLabels.family === identityFamily) {
      return resolveMonotonicSpiritClassification({
        incomingLabel: identityType || identityFamily,
        existingFamily: fromLabels.family,
        existingType: fromLabels.type
      });
    }
  }

  if (fromLabels.family === "Mixer") {
    if (mixerAffirmative && !(identityFamily && identityFamily !== "Mixer")) {
      return { family: "Mixer", type: "" };
    }
    // Weak Mixer without affirmative evidence — do not persist.
    return identityFamily
      ? { family: identityFamily, type: identityType }
      : { family: "", type: "" };
  }

  if (fromLabels.family) return fromLabels;
  if (identityFamily) return { family: identityFamily, type: identityType };
  return { family: "", type: "" };
}

export function resolveMonotonicSpiritClassification(options: {
  incomingLabel: string;
  existingFamily?: string | null;
  existingType?: string | null;
}): { family: string; type: string } {
  const incoming = spiritFamilyFromLabel(String(options.incomingLabel ?? ""), "");
  const existing = spiritFamilyFromLabel(
    String(options.existingFamily ?? ""),
    String(options.existingType ?? "")
  );

  const incomingLabel = incoming.type || incoming.family;
  const existingLabel = existing.type || existing.family;

  // Incoming specializes existing → take incoming split.
  if (
    incomingLabel
    && existingLabel
    && isCompatibleClassificationSpecialization(existingLabel, incomingLabel)
  ) {
    return {
      family: incoming.family || existing.family,
      type: incoming.type || existing.type
    };
  }

  // Existing is already more specific than a generic incoming family → keep existing type.
  if (
    incomingLabel
    && existingLabel
    && isCompatibleClassificationSpecialization(incomingLabel, existingLabel)
  ) {
    return {
      family: existing.family || incoming.family,
      type: existing.type
    };
  }

  // Same family, incoming has no type, existing has type → preserve type.
  if (incoming.family && existing.family === incoming.family && existing.type && !incoming.type) {
    return { family: existing.family, type: existing.type };
  }

  // Incoming family with type (or first fill).
  if (incoming.family) {
    return {
      family: incoming.family,
      type: incoming.type || (existing.family === incoming.family ? existing.type : "")
    };
  }

  return { family: existing.family, type: existing.type };
}

export type ProductTable = "spirits" | "packaged_beer" | "wines";

const SPIRIT_TABLE_FAMILIES = new Set([
  "Whiskey", "Gin", "Rum", "Tequila", "Mezcal", "Vodka", "Cognac", "Brandy",
  "Amaro", "Liqueur", "Bitters"
]);

const WHISKEY_MALT = /\b(single\s+malt|scotch\s+malt|islay\s+malt|malt\s+scotch|malt\s+whisk(?:y|ey))\b/i;
const BEER_TABLE_WORDS = /\b(beer|ale|ipa|lager|stout|porter|pilsner|saison|cider|seltzer|malt\s+beverage)\b/i;
const WINE_TABLE_WORDS = /\b(wine|sparkling|champagne|prosecco|vermouth|sake|mead|riesling|cabernet|chardonnay|pinot|merlot|syrah|zinfandel|malbec|sauvignon|nebbiolo)\b/i;

function productHaystack(product: Record<string, unknown>) {
  const category = String(product.category ?? product.categories ?? product.style ?? "");
  const subCategory = String(product.sub_category ?? product.subcategory ?? product.type ?? "");
  const name = String(product.name ?? product.product_name ?? "");
  const type = String(product.product_type ?? "");
  return `${type} ${category} ${subCategory} ${name}`;
}

export function hasExplicitProductType(product: Record<string, unknown>) {
  const type = String(product.product_type ?? "").trim().toUpperCase();
  return /DISTILLED\s+SPIRIT|MALT\s+BEVERAGE|\bWINE\b/.test(type);
}

/** Routes a loose product record to the inventory table it belongs in. */
export function inferProductTable(product: Record<string, unknown>): ProductTable {
  const type = String(product.product_type ?? "").trim().toUpperCase();
  if (/DISTILLED\s+SPIRIT/.test(type)) return "spirits";
  if (/MALT\s+BEVERAGE/.test(type)) return "packaged_beer";
  if (/\bWINE\b/.test(type)) return "wines";

  const category = String(product.category ?? product.categories ?? product.style ?? "");
  const subCategory = String(product.sub_category ?? product.subcategory ?? product.type ?? "");
  const haystack = productHaystack(product);
  const family = spiritFamilyFromLabel(category, subCategory).family;
  if (SPIRIT_TABLE_FAMILIES.has(family)) return "spirits";
  if (/\bspirit/i.test(category) && !BEER_TABLE_WORDS.test(haystack)) return "spirits";

  if (WINE_TABLE_WORDS.test(haystack)) return "wines";
  if (!WHISKEY_MALT.test(haystack) && BEER_TABLE_WORDS.test(haystack)) return "packaged_beer";
  return "spirits";
}

/** True when a packaged_beer row looks like a spirit misfiling, not actual beer. */
export function packagedBeerRowLooksLikeSpirit(row: Record<string, unknown>) {
  const haystack = `${row.name ?? ""} ${row.style ?? ""} ${row.brewery ?? ""} ${row.notes ?? ""}`;
  const table = inferProductTable({
    name: row.name,
    category: row.style,
    brand: row.brewery,
    product_type: ""
  });
  if (table !== "spirits") return false;
  return !BEER_TABLE_WORDS.test(haystack);
}

export function isSpiritInventoryFamily(family: string) {
  return SPIRIT_TABLE_FAMILIES.has(family);
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

export const FILL_STOPS = [
  { label: "Full", percent: 100 },
  { label: "¾", percent: 75 },
  { label: "Half", percent: 50 },
  { label: "¼", percent: 25 },
  { label: "Empty", percent: 0 }
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

export function nearestFillStop(fill: unknown): number {
  const pct = Math.max(0, Math.min(100, Number(fill) || 0));
  return FILL_STOPS.reduce((best, stop) =>
    Math.abs(stop.percent - pct) < Math.abs(best - pct) ? stop.percent : best, FILL_STOPS[0].percent);
}

export function fillStopLabel(fill: unknown): string {
  const pct = nearestFillStop(fill);
  return FILL_STOPS.find((stop) => stop.percent === pct)?.label ?? `${pct}%`;
}

export const WINE_BODY_STOPS = [
  { value: 1, label: "Light" },
  { value: 2, label: "Light-medium" },
  { value: 3, label: "Medium" },
  { value: 4, label: "Medium-full" },
  { value: 5, label: "Full" }
] as const;

export function wineBodyValue(value: unknown): number {
  const n = Math.round(Number(value));
  return n >= 1 && n <= 5 ? n : 3;
}

export function wineBodyLabel(value: unknown): string {
  const n = wineBodyValue(value);
  return WINE_BODY_STOPS.find((stop) => stop.value === n)?.label ?? "Medium";
}

export function wineDrinkByOverdue(item: Record<string, unknown> | null | undefined, now = new Date()): boolean {
  const raw = String(item?.drink_by_date ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const due = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(due.getTime())) return false;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return due < today;
}

export function pourSpirit(fill: unknown): number {
  return Math.max(0, nearestFillStop(fill) - 25);
}

export function spiritStock(count: unknown): number {
  const n = Math.floor(Number(count));
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

export function spiritStockLabel(count: unknown): string {
  const n = count == null || String(count).trim() === "" ? 1 : spiritStock(count);
  if (n <= 0) return "No bottles";
  return n === 1 ? "1 bottle" : `${n} bottles`;
}

export function isSpiritEmpty(item: Record<string, unknown> | null | undefined): boolean {
  if (!item) return true;
  const stock = item.stock_count == null || String(item.stock_count).trim() === "" ? 1 : spiritStock(item.stock_count);
  return nearestFillStop(item.fill_level) <= 0 && stock <= 1;
}

export function openNextSpirit(item: Record<string, unknown>): { fill_level: number; stock_count: number } | null {
  const stock = item.stock_count == null || String(item.stock_count).trim() === "" ? 1 : spiritStock(item.stock_count);
  if (nearestFillStop(item.fill_level) > 0 || stock <= 1) return null;
  return { fill_level: 100, stock_count: stock - 1 };
}

export function compareSpirits(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const empty = (isSpiritEmpty(a) ? 1 : 0) - (isSpiritEmpty(b) ? 1 : 0);
  if (empty !== 0) return empty;
  const family = String(a.category ?? "").localeCompare(String(b.category ?? ""), undefined, { sensitivity: "base" });
  if (family !== 0) return family;
  const brand = String(a.brand ?? "").localeCompare(String(b.brand ?? ""), undefined, { sensitivity: "base" });
  if (brand !== 0) return brand;
  return String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { sensitivity: "base" });
}

export function prepareSpiritWrite(body: Record<string, unknown>): Record<string, unknown> {
  const next = { ...body };
  if (next.fill_level !== undefined) next.fill_level = nearestFillStop(next.fill_level);
  if (next.stock_count !== undefined) next.stock_count = spiritStock(next.stock_count);

  if (typeof next.name === "string" && next.name.trim()) {
    next.name = stripPackageTokensFromName(next.name);
  }

  // Deterministic first-save (and update) classification reconciliation.
  const reconciled = reconcileSpiritClassificationForFirstSave({
    name: typeof next.name === "string" ? next.name : "",
    category: next.category == null ? "" : String(next.category),
    subCategory: next.sub_category == null ? "" : String(next.sub_category),
    productType: next.product_type == null ? "" : String(next.product_type)
  });
  next.category = reconciled.family;
  if (next.sub_category !== undefined || reconciled.type || next.category) {
    next.sub_category = reconciled.type;
  }
  if (next.abv !== undefined) {
    next.abv = normalizeCanonicalAbv(next.abv, {
      productType: String(next.product_type ?? "spirit")
    });
  }
  if (next.proof !== undefined) {
    next.proof = normalizeCanonicalProof(next.proof);
  }
  if (next.volume_ml !== undefined) {
    const volume = normalizeCanonicalVolumeMl(next.volume_ml);
    next.volume_ml = volume;
  }
  return next;
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

export const BEER_VESSELS = ["Can", "Bottle", "Crowler", "Growler"] as const;

export const PACK_COUNT_STOPS = [
  { label: "Out", count: 0 },
  { label: "Single", count: 1 },
  { label: "4-pack", count: 4 },
  { label: "Sixer", count: 6 },
  { label: "12-pack", count: 12 },
  { label: "Case", count: 24 }
];

export function normalizeBeerVessel(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase();
  if (/crowler/.test(raw)) return "Crowler";
  if (/growler/.test(raw)) return "Growler";
  if (/bottle|btl/.test(raw)) return "Bottle";
  if (/can|tin/.test(raw)) return "Can";
  return BEER_VESSELS.find((vessel) => vessel.toLowerCase() === raw) ?? "Can";
}

export function packagedCount(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

export function drinkOnePackaged(count: unknown): number {
  return Math.max(0, packagedCount(count) - 1);
}

export function packagedStockLabel(count: unknown, vessel?: unknown): string {
  const n = packagedCount(count);
  const kind = normalizeBeerVessel(vessel).toLowerCase();
  if (n <= 0) return "Out of stock";
  if (n === 1) return `1 ${kind}`;
  if (kind === "can") return `${n} cans`;
  return `${n} ${kind}s`;
}

export function comparePackagedBeer(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const empty = (packagedCount(a.count) <= 0 ? 1 : 0) - (packagedCount(b.count) <= 0 ? 1 : 0);
  if (empty !== 0) return empty;
  const brewery = String(a.brewery ?? "").localeCompare(String(b.brewery ?? ""), undefined, { sensitivity: "base" });
  if (brewery !== 0) return brewery;
  return String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { sensitivity: "base" });
}

export function preparePackagedWrite(body: Record<string, unknown>): Record<string, unknown> {
  const next = { ...body };
  if (next.count !== undefined) next.count = packagedCount(next.count);
  if (next.vessel !== undefined) next.vessel = normalizeBeerVessel(next.vessel);
  return next;
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

/** Brewfather often syncs untitled rows as "Batch". Prefer the style so the board is readable. */
export function brewDisplayName(batchName: unknown, style: unknown = ""): string {
  const name = String(batchName ?? "").trim();
  const kind = String(style ?? "").trim();
  if (!name || /^(batch|untitled(?:\s+batch)?)$/i.test(name)) return kind || "Untitled batch";
  return name;
}
