import { mapToSpiritCategory, mapToSpiritType, normalizeUpc, parseVolumeMl } from "./cola_client.js";
import type { BarcodeCacheEntry } from "./barcode_cache.js";

export type ImportTable = "spirits" | "wines" | "packaged_beer";

export type NormalizedImport = {
  table: ImportTable;
  values: Record<string, unknown>;
  cache: BarcodeCacheEntry;
};

const TABLES = new Set<ImportTable>(["spirits", "wines", "packaged_beer"]);
const BEER_WORDS = /\b(BEER|ALE|IPA|LAGER|STOUT|PORTER|PILSNER|SAISON|MALT|CIDER|SELTZER)\b/i;
const WINE_WORDS = /\b(WINE|SPARKLING|CHAMPAGNE|PROSECCO|VERMOUTH|SAKE|MEAD|RIESLING|CABERNET|CHARDONNAY|PINOT|MERLOT|SYRAH|ZINFANDEL|MALBEC|SAUVIGNON|NEBBIOLO)\b/i;
/** Canned and bottled beer is sold in 12 oz; everything else is a 750 ml bottle. */
const BEER_VOLUME_ML = 355;
const BOTTLE_VOLUME_ML = 750;

function text(row: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = String(row[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function count(value: unknown, fallback: number) {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 999) : fallback;
}

/** Barcodes arrive hyphenated or spaced; the padded form is what every lookup keys on. */
export function normalizeImportUpc(raw: unknown) {
  return normalizeUpc(String(raw ?? "").replace(/[\s-]/g, "").trim());
}

/**
 * Reads a strength that may be a percent (43) or a fraction (0.43). Anything at or under
 * 1.0 is treated as a fraction, which is how catalog exports usually write it.
 */
export function normalizeImportAbv(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const digits = typeof raw === "number" ? raw : Number.parseFloat(String(raw).match(/(\d+(?:\.\d+)?)/)?.[1] ?? "");
  if (!Number.isFinite(digits) || digits <= 0) return null;
  const percent = digits <= 1 ? digits * 100 : digits;
  return Number(percent.toFixed(1));
}

export function normalizeImportProof(raw: unknown, abv: number | null): number | null {
  if (raw !== null && raw !== undefined && raw !== "") {
    const parsed = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
    if (Number.isFinite(parsed) && parsed > 0) return Number(parsed.toFixed(1));
  }
  return abv === null ? null : Number((abv * 2).toFixed(1));
}

/** Folds a flavour list into the notes so nothing from the payload is silently dropped. */
export function combineImportNotes(description: string, flavorProfile: unknown) {
  const flavors = Array.isArray(flavorProfile)
    ? flavorProfile.map((entry) => String(entry ?? "").trim()).filter(Boolean).join(", ")
    : String(flavorProfile ?? "").trim();
  return [description, flavors ? `Notes: ${flavors}` : ""].filter(Boolean).join("\n\n");
}

/** Honours an explicit table, otherwise reads the category the way the scanner does. */
export function importTableFor(row: Record<string, unknown>): ImportTable {
  const declared = String(row.table ?? row.module ?? "").trim().toLowerCase();
  if (TABLES.has(declared as ImportTable)) return declared as ImportTable;
  const haystack = [row.category, row.subcategory, row.sub_category, row.product_type, row.style, row.type]
    .map((value) => String(value ?? ""))
    .join(" ");
  if (BEER_WORDS.test(haystack)) return "packaged_beer";
  if (WINE_WORDS.test(haystack)) return "wines";
  return "spirits";
}

/**
 * Turns one loosely-shaped catalog row into the columns its table expects, plus the
 * barcode_cache entry that lets a later scan of the same code resolve locally.
 */
export function normalizeImportItem(input: unknown): NormalizedImport | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const row = input as Record<string, unknown>;

  const name = text(row, "name", "product_name", "title");
  if (!name) return null;

  const table = importTableFor(row);
  const upc = normalizeImportUpc(row.upc ?? row.barcode ?? row.code);
  const brand = text(row, "brand", "brand_or_producer", "producer", "brewery", "maker", "brands");
  const category = text(row, "category", "categories")
    || (table === "wines" ? "Wine" : table === "packaged_beer" ? "Beer" : "Spirit");
  const subcategory = text(row, "subcategory", "sub_category", "style", "varietal");
  const abv = normalizeImportAbv(row.abv);
  const proof = normalizeImportProof(row.proof, abv);
  const volumeMl = typeof row.volume_ml === "number" && row.volume_ml > 0
    ? Math.round(row.volume_ml)
    : parseVolumeMl(row.volume_ml ?? row.size)
      ?? (table === "packaged_beer" ? BEER_VOLUME_ML : BOTTLE_VOLUME_ML);
  const description = combineImportNotes(text(row, "description", "notes", "tasting_notes"), row.flavor_profile ?? row.flavors)
    .slice(0, 900);
  const imageUrl = text(row, "image_url", "image", "photo");

  // A null strength is left out entirely so the column default stands instead of a fake 0.
  const shared = { upc, image_url: imageUrl, notes: description };
  let values: Record<string, unknown>;
  if (table === "wines") {
    const vintage = Math.round(Number(row.vintage));
    values = {
      ...shared,
      name,
      producer: brand,
      varietal: text(row, "varietal", "subcategory", "sub_category"),
      vintage: Number.isFinite(vintage) && vintage > 1000 ? vintage : null,
      type: text(row, "type", "wine_type") || "Red",
      style: text(row, "style"),
      region: text(row, "region"),
      bottle_count: count(row.bottle_count ?? row.count ?? row.stock_count, 1)
    };
  } else if (table === "packaged_beer") {
    values = {
      ...shared,
      name,
      brewery: brand,
      style: subcategory || text(row, "style"),
      abv: abv ?? undefined,
      count: count(row.count ?? row.stock_count ?? row.bottle_count, 1),
      vessel: text(row, "vessel") || "Can"
    };
  } else {
    values = {
      ...shared,
      name,
      brand,
      category: mapToSpiritCategory(subcategory || category),
      sub_category: mapToSpiritType(subcategory || category),
      abv: abv ?? undefined,
      volume_ml: volumeMl,
      fill_level: count(row.fill_level, 100),
      stock_count: count(row.stock_count ?? row.count ?? row.bottle_count, 1)
    };
  }

  return {
    table,
    values,
    cache: { upc, name, brand, category, subcategory, abv, proof, volume_ml: volumeMl, description, image_url: imageUrl, source: "imported" }
  };
}

/** Accepts a bare array, `{ items: [...] }`, or `{ rows: [...] }` so pasted JSON just works. */
export function readImportPayload(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["items", "rows", "products", "inventory"]) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}
