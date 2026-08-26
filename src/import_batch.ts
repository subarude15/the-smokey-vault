import { mapToSpiritCategory, mapToSpiritType, normalizeUpc, parseVolumeMl } from "./cola_client.js";
import { inferProductTable } from "./catalog.js";
import type { BarcodeCacheEntry } from "./barcode_cache.js";

export type ImportTable = "spirits" | "wines" | "packaged_beer";

export type NormalizedImport = {
  table: ImportTable;
  values: Record<string, unknown>;
  cache: BarcodeCacheEntry;
};

const TABLES = new Set<ImportTable>(["spirits", "wines", "packaged_beer"]);
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
  return inferProductTable({
    category: row.category,
    sub_category: row.subcategory ?? row.sub_category,
    product_type: row.product_type,
    style: row.style,
    type: row.type,
    name: row.name ?? row.product_name ?? row.title
  });
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
  if (typeof body === "string") return parseImportText(body);
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.csv === "string") return parseImportText(record.csv);
    if (typeof record.text === "string") return parseImportText(record.text);
    for (const key of ["items", "rows", "products", "inventory"]) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === "\"" && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else if (ch === "\"") {
        quoted = false;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "\"") {
      quoted = true;
      continue;
    }
    if (ch === "," || ch === "\t" || ch === ";") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

const UPC_HEADER = /^(upc|barcode|ean|gtin|code)$/i;

function headerKey(value: string) {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (UPC_HEADER.test(key)) return "upc";
  if (key === "module") return "table";
  return key;
}

/** Harvester-style CSV: headered rows, or a bare list of UPCs. */
export function parseImportCsv(text: string): Record<string, unknown>[] {
  const lines = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const first = splitCsvLine(lines[0]!);
  const hasHeader = first.some((cell) => UPC_HEADER.test(cell) || /^(name|table|kind|brand)$/i.test(cell));
  if (!hasHeader) {
    return lines.map((line) => {
      const cells = splitCsvLine(line);
      const upc = cells.find((cell) => /\d{6,}/.test(cell.replace(/\D/g, ""))) ?? cells[0] ?? "";
      return { upc };
    });
  }
  const keys = first.map(headerKey);
  const rows: Record<string, unknown>[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const row: Record<string, unknown> = {};
    keys.forEach((key, index) => {
      if (key) row[key] = cells[index] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

export function parseImportText(text: string): unknown[] {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return readImportPayload(JSON.parse(trimmed));
    } catch {
      // Fall through to CSV so a paste that isn't quite JSON still works.
    }
  }
  return parseImportCsv(trimmed);
}

export function importRowHasName(row: Record<string, unknown>) {
  return Boolean(String(row.name ?? row.product_name ?? row.title ?? "").trim());
}
