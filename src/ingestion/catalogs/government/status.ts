/**
 * Keeper-facing government catalog health / diagnostics.
 * Observability only — does not create the DB or change lookup behavior.
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getGovernmentDbPath } from "./schema.js";
import { GOVERNMENT_DATASETS, type GovernmentDataset } from "./types.js";

export type GovernmentDatasetSnapshotHealth = {
  dataset: GovernmentDataset;
  currentSources: number;
  currentProducts: number;
  currentBarcodes: number;
  extractedAt: string | null;
  importedAt: string | null;
};

export type GovernmentCatalogHealth = {
  exists: boolean;
  path: string;
  totals: {
    sources: number;
    products: number;
    barcodes: number;
  };
  currentByDataset: Record<GovernmentDataset, GovernmentDatasetSnapshotHealth>;
  latestExtractedAt: string | null;
  latestImportedAt: string | null;
  lookupOperational: boolean;
  warning: string | null;
};

function emptyDataset(dataset: GovernmentDataset): GovernmentDatasetSnapshotHealth {
  return {
    dataset,
    currentSources: 0,
    currentProducts: 0,
    currentBarcodes: 0,
    extractedAt: null,
    importedAt: null
  };
}

function emptyByDataset(): Record<GovernmentDataset, GovernmentDatasetSnapshotHealth> {
  return Object.fromEntries(
    GOVERNMENT_DATASETS.map((dataset) => [dataset, emptyDataset(dataset)])
  ) as Record<GovernmentDataset, GovernmentDatasetSnapshotHealth>;
}

function baseHealth(
  path: string,
  warning: string | null,
  lookupOperational: boolean,
  exists: boolean
): GovernmentCatalogHealth {
  return {
    exists,
    path,
    totals: { sources: 0, products: 0, barcodes: 0 },
    currentByDataset: emptyByDataset(),
    latestExtractedAt: null,
    latestImportedAt: null,
    lookupOperational,
    warning
  };
}

/**
 * Report government catalog DB presence, current snapshot counts, and lookup readiness.
 * Never creates the database file.
 */
export function getGovernmentCatalogHealth(
  options: { dbPath?: string } = {}
): GovernmentCatalogHealth {
  const path = resolve(options.dbPath ?? getGovernmentDbPath());
  if (!existsSync(path)) {
    return baseHealth(
      path,
      "Government catalog database is missing. Import PA PLCB and/or Iowa catalogs before lookup can use them.",
      false,
      false
    );
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma("foreign_keys = ON");

    const tableCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master
         WHERE type = 'table' AND name IN ('catalog_sources', 'catalog_products', 'catalog_product_codes')`
      )
      .get() as { n: number };
    if (Number(tableCount?.n ?? 0) < 3) {
      return baseHealth(
        path,
        "Government catalog database exists but is missing required tables.",
        false,
        true
      );
    }

    const totals = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM catalog_sources) AS sources,
           (SELECT COUNT(*) FROM catalog_products) AS products,
           (SELECT COUNT(*) FROM catalog_product_codes) AS barcodes`
      )
      .get() as { sources: number; products: number; barcodes: number };

    const currentProductCount = db
      .prepare(`SELECT COUNT(*) AS n FROM catalog_products WHERE is_current = 1`)
      .get() as { n: number };

    const currentByDataset = emptyByDataset();
    const datasetRows = db
      .prepare(
        `SELECT
           s.dataset AS dataset,
           COUNT(DISTINCT s.id) AS current_sources,
           COUNT(DISTINCT p.id) AS current_products,
           COUNT(c.id) AS current_barcodes,
           MAX(s.extracted_at) AS extracted_at,
           MAX(s.imported_at) AS imported_at
         FROM catalog_sources s
         LEFT JOIN catalog_products p
           ON p.source_id = s.id AND p.is_current = 1
         LEFT JOIN catalog_product_codes c
           ON c.product_id = p.id
         WHERE s.is_current = 1
         GROUP BY s.dataset`
      )
      .all() as Array<{
      dataset: string;
      current_sources: number;
      current_products: number;
      current_barcodes: number;
      extracted_at: string | null;
      imported_at: string | null;
    }>;

    for (const row of datasetRows) {
      if (!(GOVERNMENT_DATASETS as readonly string[]).includes(row.dataset)) continue;
      const dataset = row.dataset as GovernmentDataset;
      currentByDataset[dataset] = {
        dataset,
        currentSources: Number(row.current_sources ?? 0),
        currentProducts: Number(row.current_products ?? 0),
        currentBarcodes: Number(row.current_barcodes ?? 0),
        extractedAt: row.extracted_at == null ? null : String(row.extracted_at),
        importedAt: row.imported_at == null ? null : String(row.imported_at)
      };
    }

    const latest = db
      .prepare(
        `SELECT
           MAX(extracted_at) AS extracted_at,
           MAX(imported_at) AS imported_at
         FROM catalog_sources`
      )
      .get() as { extracted_at: string | null; imported_at: string | null };

    // Probe that barcode join used by lookup is runnable (no rows returned).
    db.prepare(
      `SELECT 1 AS ok
       FROM catalog_product_codes c
       JOIN catalog_products p ON p.id = c.product_id
       JOIN catalog_sources s ON s.id = p.source_id
       WHERE 0`
    ).get();

    const currentProducts = Number(currentProductCount?.n ?? 0);
    const warning =
      currentProducts === 0
        ? "Government catalog database exists but has zero current products. Runtime lookup will miss until a catalog import marks a current snapshot."
        : null;

    return {
      exists: true,
      path,
      totals: {
        sources: Number(totals?.sources ?? 0),
        products: Number(totals?.products ?? 0),
        barcodes: Number(totals?.barcodes ?? 0)
      },
      currentByDataset,
      latestExtractedAt: latest?.extracted_at == null ? null : String(latest.extracted_at),
      latestImportedAt: latest?.imported_at == null ? null : String(latest.imported_at),
      lookupOperational: true,
      warning
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Catalog probe failed";
    return baseHealth(
      path,
      `Government catalog database exists but lookup is not operational (${message.slice(0, 160)}).`,
      false,
      true
    );
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}
