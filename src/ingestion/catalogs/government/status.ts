/**
 * Keeper-facing government catalog health / diagnostics.
 * Observability only — does not create the DB or change lookup behavior.
 */
import Database from "better-sqlite3";
import {
  accessSync,
  constants,
  existsSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  getGovernmentDbPath,
  PRODUCTION_GOVERNMENT_DATA_DIR
} from "./schema.js";
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
  /** Directory that should hold the catalog DB (prefer /app/data in production). */
  dataDir: string;
  /** Whether dataDir exists and is writable (never creates the directory). */
  dataDirWritable: boolean;
  /** Byte size of the catalog DB file when present. */
  fileSizeBytes: number | null;
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

/** Probe writability without creating directories. Never leaves probe files behind. */
export function probeDirectoryWritable(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    accessSync(dir, constants.W_OK);
    const probe = join(dir, `.gov-catalog-write-probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function fileSizeBytes(path: string): number | null {
  try {
    if (!existsSync(path)) return null;
    return Number(statSync(path).size);
  } catch {
    return null;
  }
}

function baseHealth(
  path: string,
  dataDir: string,
  dataDirWritable: boolean,
  warning: string | null,
  lookupOperational: boolean,
  exists: boolean,
  size: number | null = null
): GovernmentCatalogHealth {
  return {
    exists,
    path,
    dataDir,
    dataDirWritable,
    fileSizeBytes: size,
    totals: { sources: 0, products: 0, barcodes: 0 },
    currentByDataset: emptyByDataset(),
    latestExtractedAt: null,
    latestImportedAt: null,
    lookupOperational,
    warning
  };
}

function missingDbWarning(path: string, dataDir: string, dataDirWritable: boolean): string {
  const parts = [
    `Government catalog database is missing at ${path}.`,
    "Import PA PLCB and/or Iowa catalogs before lookup can use them."
  ];
  if (!existsSync(dataDir)) {
    parts.push(
      `Data directory ${dataDir} does not exist — mount persistent storage at ${PRODUCTION_GOVERNMENT_DATA_DIR} (and/or set GOVERNMENT_CATALOG_DB_PATH).`
    );
  } else if (!dataDirWritable) {
    parts.push(`Data directory ${dataDir} is not writable.`);
  }
  return parts.join(" ");
}

/**
 * Report government catalog DB presence, current snapshot counts, and lookup readiness.
 * Never creates the database file or data directory.
 */
export function getGovernmentCatalogHealth(
  options: { dbPath?: string } = {}
): GovernmentCatalogHealth {
  const path = resolve(options.dbPath ?? getGovernmentDbPath());
  // Always report the directory that owns the resolved DB file (importers write here).
  const dataDir = dirname(path);
  const dataDirWritable = probeDirectoryWritable(dataDir);
  const size = fileSizeBytes(path);

  if (!existsSync(path)) {
    return baseHealth(
      path,
      dataDir,
      dataDirWritable,
      missingDbWarning(path, dataDir, dataDirWritable),
      false,
      false,
      null
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
        dataDir,
        dataDirWritable,
        "Government catalog database exists but is missing required tables.",
        false,
        true,
        size
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
    let warning: string | null = null;
    if (currentProducts === 0) {
      warning =
        "Government catalog database exists but has zero current products. Runtime lookup will miss until a catalog import marks a current snapshot.";
    } else if (!dataDirWritable) {
      warning = `Government catalog is readable but data directory ${dataDir} is not writable — imports will fail until the mount is fixed.`;
    }

    return {
      exists: true,
      path,
      dataDir,
      dataDirWritable,
      fileSizeBytes: size,
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
      dataDir,
      dataDirWritable,
      `Government catalog database exists but lookup is not operational (${message.slice(0, 160)}).`,
      false,
      true,
      size
    );
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Bounded startup/health log fields (no catalog payloads). */
export function governmentCatalogHealthLogFields(
  health: GovernmentCatalogHealth
): Record<string, unknown> {
  return {
    path: health.path,
    dataDir: health.dataDir,
    dataDirWritable: health.dataDirWritable,
    exists: health.exists,
    fileSizeBytes: health.fileSizeBytes,
    lookupOperational: health.lookupOperational,
    warning: health.warning,
    totals: health.totals,
    currentProducts: {
      plcb_spirits: health.currentByDataset.plcb_spirits.currentProducts,
      plcb_wines: health.currentByDataset.plcb_wines.currentProducts,
      iowa: health.currentByDataset.iowa.currentProducts
    }
  };
}
