import { db } from "./db.js";
import { barcodeVariants, canonicalGtin, isValidGtin } from "./cola_client.js";
import { recordAdminAuditEvent } from "./ingestion/jobs/admin-audit.js";
import { ensureEnrichmentSourcesTable } from "./ingestion/jobs/enrichment-sources.js";
import { ensureFieldOwnershipTable } from "./ingestion/jobs/field-ownership.js";
import { ensureOfficialImageRepairTable } from "./ingestion/jobs/official-image-repair.js";
import { ensureProductContentTable } from "./ingestion/jobs/product-content.js";
import { ensureProductImagesTable } from "./ingestion/jobs/product-images.js";
import { ensureEnrichmentJobsTable } from "./ingestion/jobs/store.js";
import { isEnrichmentEntityType, type EnrichmentEntityType } from "./ingestion/jobs/types.js";

export const INVENTORY_TABLES = [
  "spirits",
  "taps",
  "brews",
  "packaged_beer",
  "wines"
] as const;

export type InventoryTable = (typeof INVENTORY_TABLES)[number];

export type InventoryDeleteResult =
  | { status: "not_found" }
  | { status: "busy" }
  | {
      status: "deleted";
      cacheEvicted: boolean;
      cacheKeys: string[];
      deletedRows: Record<string, number>;
    };

const UPC_INVENTORY_TABLES = ["spirits", "wines", "packaged_beer"] as const;
const ENTITY_ARTIFACT_TABLES = [
  "enrichment_jobs",
  "product_content",
  "product_images",
  "product_field_ownership",
  "enrichment_sources",
  "official_image_repair_requests"
] as const;
const UPC_CACHE_TABLES = ["barcode_cache", "cola_cache", "beer_cache", "import_queue"] as const;

function ensureInventoryDeleteTables(): void {
  ensureEnrichmentJobsTable();
  ensureProductContentTable();
  ensureProductImagesTable();
  ensureFieldOwnershipTable();
  ensureEnrichmentSourcesTable();
  ensureOfficialImageRepairTable();
}

ensureInventoryDeleteTables();

export function isInventoryTable(value: string): value is InventoryTable {
  return (INVENTORY_TABLES as readonly string[]).includes(value);
}

/**
 * Exact raw code plus checksum-valid GTIN aliases only. Invalid historical
 * values are cleaned by exact key and never padded into a guessed barcode.
 */
export function verifiedInventoryUpcAliases(raw: unknown): string[] {
  const cleaned = String(raw ?? "").replace(/\D/g, "");
  if (!cleaned) return [];
  const aliases = new Set<string>([cleaned]);
  const canonical = canonicalGtin(cleaned);
  if (!canonical) return [...aliases];
  aliases.add(canonical);
  for (const variant of barcodeVariants(cleaned)) {
    if (isValidGtin(variant)) aliases.add(variant);
  }
  return [...aliases];
}

function hasRunningEnrichment(entityType: EnrichmentEntityType, entityId: number): boolean {
  return Boolean(db.prepare(`
    SELECT 1 AS present
    FROM enrichment_jobs
    WHERE entity_type = ? AND entity_id = ? AND status = 'running'
    LIMIT 1
  `).get(entityType, entityId));
}

function remainingInventoryUsesAliases(aliases: Set<string>): boolean {
  if (!aliases.size) return false;
  for (const table of UPC_INVENTORY_TABLES) {
    const rows = db.prepare(`SELECT upc FROM ${table} WHERE trim(upc) <> ''`).all() as Array<{ upc: string }>;
    for (const row of rows) {
      if (verifiedInventoryUpcAliases(row.upc).some((alias) => aliases.has(alias))) return true;
    }
  }
  return false;
}

function deleteByEntity(table: string, entityType: EnrichmentEntityType, entityId: number): number {
  return db.prepare(`DELETE FROM ${table} WHERE entity_type = ? AND entity_id = ?`).run(
    entityType,
    entityId
  ).changes;
}

function deleteByUpcAliases(table: string, aliases: string[]): number {
  if (!aliases.length) return 0;
  const placeholders = aliases.map(() => "?").join(",");
  return db.prepare(`DELETE FROM ${table} WHERE upc IN (${placeholders})`).run(...aliases).changes;
}

/**
 * Atomically remove one inventory item and its item-scoped application data.
 * Historical pour records and shared/authoritative government catalogs remain.
 */
export function deleteInventoryItemSafely(
  table: InventoryTable,
  entityIdRaw: number
): InventoryDeleteResult {
  ensureInventoryDeleteTables();
  const entityId = Math.floor(Number(entityIdRaw));
  if (!Number.isFinite(entityId) || entityId <= 0) return { status: "not_found" };

  const hasUpc = UPC_INVENTORY_TABLES.includes(table as (typeof UPC_INVENTORY_TABLES)[number]);
  const row = db.prepare(`SELECT id${hasUpc ? ", upc" : ""} FROM ${table} WHERE id = ?`).get(
    entityId
  ) as { id: number; upc?: string } | undefined;
  if (!row) return { status: "not_found" };

  const enrichmentEntity = isEnrichmentEntityType(table) ? table : null;
  if (enrichmentEntity && hasRunningEnrichment(enrichmentEntity, entityId)) {
    return { status: "busy" };
  }

  const cacheKeys = verifiedInventoryUpcAliases(row.upc);

  return db.transaction((): InventoryDeleteResult => {
    const deletedRows: Record<string, number> = {};
    deletedRows.reviews = db.prepare(
      "DELETE FROM reviews WHERE table_name = ? AND item_id = ?"
    ).run(table, entityId).changes;
    deletedRows.votes = db.prepare(
      "DELETE FROM votes WHERE table_name = ? AND item_id = ?"
    ).run(table, entityId).changes;
    deletedRows.daily_votes = db.prepare(
      "DELETE FROM daily_votes WHERE target_table = ? AND item_id = ?"
    ).run(table, entityId).changes;
    deletedRows.restock_got = db.prepare(
      "DELETE FROM restock_got WHERE key IN (?, ?)"
    ).run(`${table}:${entityId}`, `${table}-drinkby:${entityId}`).changes;

    if (enrichmentEntity) {
      for (const artifactTable of ENTITY_ARTIFACT_TABLES) {
        deletedRows[artifactTable] = deleteByEntity(artifactTable, enrichmentEntity, entityId);
      }
    }

    deletedRows[table] = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(entityId).changes;

    let cacheEvicted = false;
    if (cacheKeys.length && !remainingInventoryUsesAliases(new Set(cacheKeys))) {
      cacheEvicted = true;
      for (const cacheTable of UPC_CACHE_TABLES) {
        deletedRows[cacheTable] = deleteByUpcAliases(cacheTable, cacheKeys);
      }
    }

    recordAdminAuditEvent("inventory_item_deleted", {
      table,
      entityId,
      cacheEvicted,
      cacheKeyCount: cacheKeys.length,
      deletedRows
    });

    return { status: "deleted", cacheEvicted, cacheKeys, deletedRows };
  })();
}
