/**
 * Shared SQLite schema for government alcohol catalogs.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/** Filename used under the resolved government data directory. */
export const GOVERNMENT_CATALOG_FILENAME = "government-catalog.sqlite";

/**
 * Production persistent data directory for government catalogs.
 * Docker mounts host storage at /app/data (same host folder as /data for the vault DB).
 */
export const PRODUCTION_GOVERNMENT_DATA_DIR = "/app/data";

/** Local-dev relative default (cwd/data/...), for tests and documentation. */
export const DEFAULT_GOVERNMENT_DB_PATH = resolve("data", GOVERNMENT_CATALOG_FILENAME);

/**
 * Resolve the government catalog data directory.
 * Priority: GOVERNMENT_CATALOG_DATA_DIR → production /app/data → ./data
 */
export function getGovernmentDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.GOVERNMENT_CATALOG_DATA_DIR?.trim();
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(explicit);
  if (env.NODE_ENV === "production") return PRODUCTION_GOVERNMENT_DATA_DIR;
  return resolve("data");
}

/**
 * Resolve the government catalog SQLite path used by importers and runtime lookup.
 * Priority: GOVERNMENT_CATALOG_DB_PATH → <dataDir>/government-catalog.sqlite
 */
export function getGovernmentDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.GOVERNMENT_CATALOG_DB_PATH?.trim();
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(explicit);
  return resolve(getGovernmentDataDir(env), GOVERNMENT_CATALOG_FILENAME);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS catalog_sources (
  id INTEGER PRIMARY KEY,
  jurisdiction TEXT NOT NULL,
  dataset TEXT NOT NULL,
  source_version TEXT,
  extracted_at TEXT,
  imported_at TEXT NOT NULL,
  source_file_hash TEXT NOT NULL,
  source_file_name TEXT,
  is_current INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_catalog_sources_dataset_current
  ON catalog_sources(dataset, is_current);

CREATE TABLE IF NOT EXISTS catalog_source_rows (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES catalog_sources(id),
  source_row_key TEXT NOT NULL,
  source_item_id TEXT,
  source_container_id TEXT,
  source_manufacturer_code TEXT,
  raw_payload_json TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  UNIQUE(source_id, source_row_key)
);
CREATE INDEX IF NOT EXISTS idx_catalog_source_rows_item
  ON catalog_source_rows(source_item_id);

CREATE TABLE IF NOT EXISTS catalog_products (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES catalog_sources(id),
  source_item_id TEXT,
  domain TEXT NOT NULL,
  name TEXT NOT NULL,
  brand TEXT,
  volume_ml INTEGER,
  volume_raw TEXT,
  case_pack INTEGER,
  proof REAL,
  abv_percent REAL,
  abv_derivation TEXT,
  vintage_year INTEGER,
  vintage_status TEXT,
  country TEXT,
  region_raw TEXT,
  source_division TEXT,
  source_group TEXT,
  source_class TEXT,
  normalized_family TEXT,
  normalized_subcategory TEXT,
  source_extracted_at TEXT,
  quality_flags_json TEXT,
  is_current INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_catalog_products_item
  ON catalog_products(source_item_id);
CREATE INDEX IF NOT EXISTS idx_catalog_products_current
  ON catalog_products(is_current, source_id);

CREATE TABLE IF NOT EXISTS catalog_product_rows (
  product_id INTEGER NOT NULL REFERENCES catalog_products(id),
  source_row_id INTEGER NOT NULL REFERENCES catalog_source_rows(id),
  PRIMARY KEY (product_id, source_row_id)
);

CREATE TABLE IF NOT EXISTS catalog_product_codes (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES catalog_products(id),
  source_row_id INTEGER REFERENCES catalog_source_rows(id),
  code_raw TEXT NOT NULL,
  code_normalized TEXT,
  comparison_key TEXT,
  gtin_type TEXT,
  source_ordinal INTEGER,
  check_digit_valid INTEGER,
  is_preferred INTEGER NOT NULL DEFAULT 0,
  quality_flags_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_catalog_codes_normalized
  ON catalog_product_codes(code_normalized);
CREATE INDEX IF NOT EXISTS idx_catalog_codes_comparison
  ON catalog_product_codes(comparison_key);
CREATE INDEX IF NOT EXISTS idx_catalog_codes_raw
  ON catalog_product_codes(code_raw);
`;

let governmentDb: Database.Database | null = null;
let governmentDbPath: string | null = null;

export function openGovernmentDb(path = getGovernmentDbPath()): Database.Database {
  const resolved = resolve(path);
  if (governmentDb && governmentDbPath === resolved) return governmentDb;
  if (governmentDb) {
    governmentDb.close();
    governmentDb = null;
    governmentDbPath = null;
  }
  mkdirSync(dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  governmentDb = db;
  governmentDbPath = resolved;
  return db;
}

export function resetGovernmentDbConnection(): void {
  if (governmentDb) {
    governmentDb.close();
    governmentDb = null;
    governmentDbPath = null;
  }
}

export function hashFileBuffer(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function markDatasetNotCurrent(db: Database.Database, dataset: string): void {
  db.prepare(`UPDATE catalog_sources SET is_current = 0 WHERE dataset = ?`).run(dataset);
  db.prepare(
    `UPDATE catalog_products
     SET is_current = 0
     WHERE source_id IN (SELECT id FROM catalog_sources WHERE dataset = ?)`
  ).run(dataset);
}

export function formatImportStats(stats: {
  dataset: string;
  rowsRead: number;
  rowsImported: number;
  productsNormalized: number;
  barcodeAliases: number;
  validGtins: number;
  invalidGtins: number;
  flaggedBarcodes: number;
  ambiguousBarcodeMappings: number;
  productsWithProof: number;
  productsWithOrigin: number;
  productsWithRegion: number;
  duplicateSourceItemIds: number;
  snapshotHash: string;
  dbPath: string;
}): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  return [
    `Dataset: ${stats.dataset}`,
    `Rows read: ${fmt(stats.rowsRead)}`,
    `Rows imported: ${fmt(stats.rowsImported)}`,
    `Products normalized: ${fmt(stats.productsNormalized)}`,
    `Barcode aliases: ${fmt(stats.barcodeAliases)}`,
    `Valid GTINs: ${fmt(stats.validGtins)}`,
    `Invalid GTINs: ${fmt(stats.invalidGtins)}`,
    `Flagged barcodes: ${fmt(stats.flaggedBarcodes)}`,
    `Ambiguous barcode mappings: ${fmt(stats.ambiguousBarcodeMappings)}`,
    `Products with proof: ${fmt(stats.productsWithProof)}`,
    `Products with origin: ${fmt(stats.productsWithOrigin)}`,
    `Products with region: ${fmt(stats.productsWithRegion)}`,
    `Duplicate source item IDs: ${fmt(stats.duplicateSourceItemIds)}`,
    `Snapshot hash: ${stats.snapshotHash}`,
    `Database: ${stats.dbPath}`
  ].join("\n");
}
