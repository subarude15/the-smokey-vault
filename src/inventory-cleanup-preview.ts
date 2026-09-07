import { ensureBeerCacheTable } from "./beer_cache.js";
import { canonicalGtin } from "./cola_client.js";
import { db } from "./db.js";
import { ensureImportQueueTable } from "./import_queue.js";
import { verifiedInventoryUpcAliases } from "./inventory-delete.js";
import { ensureEnrichmentSourcesTable } from "./ingestion/jobs/enrichment-sources.js";
import { ensureFieldOwnershipTable } from "./ingestion/jobs/field-ownership.js";
import { ensureOfficialImageRepairTable } from "./ingestion/jobs/official-image-repair.js";
import { ensureProductContentTable } from "./ingestion/jobs/product-content.js";
import { ensureProductImagesTable } from "./ingestion/jobs/product-images.js";
import { ensureEnrichmentJobsTable } from "./ingestion/jobs/store.js";

const INVENTORY_TABLES = ["spirits", "wines", "packaged_beer"] as const;
const ARTIFACT_TABLES = [
  "enrichment_jobs",
  "product_content",
  "product_images",
  "product_field_ownership",
  "enrichment_sources",
  "official_image_repair_requests"
] as const;
const LOOKUP_CACHE_TABLES = ["barcode_cache", "cola_cache", "beer_cache"] as const;
const SAMPLE_LIMIT = 50;

type ShelfTable = (typeof INVENTORY_TABLES)[number];

export type InventoryCleanupPreview = {
  readOnly: true;
  inventory: Record<ShelfTable, number> & { total: number };
  invalidPackagedBeerBarcodes: {
    count: number;
    items: Array<{ entityId: number; name: string; brewery: string; upc: string }>;
    truncated: boolean;
  };
  orphanedArtifacts: {
    total: number;
    byTable: Record<string, number>;
    items: Array<{ table: string; entityType: string; entityId: number; rows: number }>;
    truncated: boolean;
  };
  enrichmentJobs: Record<"pending" | "running" | "failed", number>;
  unreferencedLookupCache: {
    total: number;
    byTable: Record<string, number>;
    sampleUpcs: string[];
    truncated: boolean;
  };
  unlinkedImportReview: number;
};

function ensurePreviewTables(): void {
  ensureBeerCacheTable();
  ensureImportQueueTable();
  ensureEnrichmentJobsTable();
  ensureProductContentTable();
  ensureProductImagesTable();
  ensureFieldOwnershipTable();
  ensureEnrichmentSourcesTable();
  ensureOfficialImageRepairTable();
}

function countRows(table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function currentInventoryAliases(): Set<string> {
  const aliases = new Set<string>();
  for (const table of INVENTORY_TABLES) {
    const rows = db.prepare(`SELECT upc FROM ${table} WHERE trim(upc) <> ''`).all() as Array<{ upc: string }>;
    for (const row of rows) {
      for (const alias of verifiedInventoryUpcAliases(row.upc)) aliases.add(alias);
    }
  }
  return aliases;
}

function upcIsReferenced(raw: unknown, inventoryAliases: Set<string>): boolean {
  return verifiedInventoryUpcAliases(raw).some((alias) => inventoryAliases.has(alias));
}

function entityExists(entityType: string, entityId: number): boolean {
  if (!(INVENTORY_TABLES as readonly string[]).includes(entityType)) return false;
  return Boolean(db.prepare(`SELECT 1 FROM ${entityType} WHERE id = ? LIMIT 1`).get(entityId));
}

/**
 * Read-only inventory hygiene report. Findings are deliberately descriptive:
 * a cache row being unreferenced does not by itself make it safe to delete.
 */
export function previewInventoryCleanup(): InventoryCleanupPreview {
  ensurePreviewTables();

  const inventory = {
    spirits: countRows("spirits"),
    wines: countRows("wines"),
    packaged_beer: countRows("packaged_beer"),
    total: 0
  };
  inventory.total = inventory.spirits + inventory.wines + inventory.packaged_beer;

  const invalidRows = db.prepare(`
    SELECT id, name, brewery, upc
    FROM packaged_beer
    WHERE trim(upc) <> ''
    ORDER BY id
  `).all() as Array<{ id: number; name: string; brewery: string; upc: string }>;
  const invalid = invalidRows.filter((row) => !canonicalGtin(row.upc));

  const artifactCounts: Record<string, number> = {};
  const artifactItems: InventoryCleanupPreview["orphanedArtifacts"]["items"] = [];
  let orphanedEntityGroups = 0;
  for (const table of ARTIFACT_TABLES) {
    const rows = db.prepare(`
      SELECT entity_type, entity_id, COUNT(*) AS rows
      FROM ${table}
      GROUP BY entity_type, entity_id
      ORDER BY entity_type, entity_id
    `).all() as Array<{ entity_type: string; entity_id: number; rows: number }>;
    let tableCount = 0;
    for (const row of rows) {
      if (entityExists(row.entity_type, row.entity_id)) continue;
      orphanedEntityGroups += 1;
      tableCount += Number(row.rows);
      if (artifactItems.length < SAMPLE_LIMIT) {
        artifactItems.push({
          table,
          entityType: row.entity_type,
          entityId: Number(row.entity_id),
          rows: Number(row.rows)
        });
      }
    }
    artifactCounts[table] = tableCount;
  }
  const orphanedTotal = Object.values(artifactCounts).reduce((sum, count) => sum + count, 0);

  const jobCounts = { pending: 0, running: 0, failed: 0 };
  for (const row of db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM enrichment_jobs
    WHERE status IN ('pending', 'running', 'failed')
    GROUP BY status
  `).all() as Array<{ status: keyof typeof jobCounts; count: number }>) {
    jobCounts[row.status] = Number(row.count);
  }

  const inventoryAliases = currentInventoryAliases();
  const cacheCounts: Record<string, number> = {};
  const sampleUpcs: string[] = [];
  let unreferencedCacheTotal = 0;
  for (const table of LOOKUP_CACHE_TABLES) {
    const rows = db.prepare(`SELECT upc FROM ${table} ORDER BY upc`).all() as Array<{ upc: string }>;
    const unreferenced = rows.filter((row) => !upcIsReferenced(row.upc, inventoryAliases));
    cacheCounts[table] = unreferenced.length;
    unreferencedCacheTotal += unreferenced.length;
    for (const row of unreferenced) {
      if (sampleUpcs.length >= SAMPLE_LIMIT) break;
      if (!sampleUpcs.includes(row.upc)) sampleUpcs.push(row.upc);
    }
  }

  const importRows = db.prepare("SELECT upc FROM import_queue").all() as Array<{ upc: string }>;
  const unlinkedImportReview = importRows.filter((row) => !upcIsReferenced(row.upc, inventoryAliases)).length;

  return {
    readOnly: true,
    inventory,
    invalidPackagedBeerBarcodes: {
      count: invalid.length,
      items: invalid.slice(0, SAMPLE_LIMIT).map((row) => ({
        entityId: row.id,
        name: row.name,
        brewery: row.brewery,
        upc: row.upc
      })),
      truncated: invalid.length > SAMPLE_LIMIT
    },
    orphanedArtifacts: {
      total: orphanedTotal,
      byTable: artifactCounts,
      items: artifactItems,
      truncated: orphanedEntityGroups > artifactItems.length
    },
    enrichmentJobs: jobCounts,
    unreferencedLookupCache: {
      total: unreferencedCacheTotal,
      byTable: cacheCounts,
      sampleUpcs,
      truncated: unreferencedCacheTotal > sampleUpcs.length
    },
    unlinkedImportReview
  };
}
