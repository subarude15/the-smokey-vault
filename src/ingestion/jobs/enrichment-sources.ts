/**
 * Lightweight enrichment source references (official product page, etc.).
 * Bounded — one row per entity + source_type. Not a crawler cache.
 */
import { db } from "../../db.js";

export type EnrichmentSourceType = "official_product_page";

export type EnrichmentSourceRecord = {
  entityType: string;
  entityId: number;
  sourceType: EnrichmentSourceType;
  sourceUrl: string;
  discoveredAt: string;
};

let ensured = false;

export function ensureEnrichmentSourcesTable(): void {
  if (ensured) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS enrichment_sources (
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      source_url TEXT NOT NULL,
      discovered_at TEXT NOT NULL,
      PRIMARY KEY (entity_type, entity_id, source_type)
    );
    CREATE INDEX IF NOT EXISTS idx_enrichment_sources_entity
      ON enrichment_sources(entity_type, entity_id);
  `);
  ensured = true;
}

export function getEnrichmentSource(
  entityType: string,
  entityId: number,
  sourceType: EnrichmentSourceType = "official_product_page"
): EnrichmentSourceRecord | null {
  ensureEnrichmentSourcesTable();
  const row = db
    .prepare(
      `SELECT entity_type, entity_id, source_type, source_url, discovered_at
       FROM enrichment_sources
       WHERE entity_type = ? AND entity_id = ? AND source_type = ?`
    )
    .get(entityType, entityId, sourceType) as
    | {
        entity_type: string;
        entity_id: number;
        source_type: string;
        source_url: string;
        discovered_at: string;
      }
    | undefined;
  if (!row?.source_url?.trim()) return null;
  return {
    entityType: row.entity_type,
    entityId: row.entity_id,
    sourceType: row.source_type as EnrichmentSourceType,
    sourceUrl: row.source_url.trim(),
    discoveredAt: row.discovered_at
  };
}

/** Upsert official product page (or other typed source). Newer URL replaces prior. */
export function upsertEnrichmentSource(options: {
  entityType: string;
  entityId: number;
  sourceType: EnrichmentSourceType;
  sourceUrl: string;
}): EnrichmentSourceRecord {
  ensureEnrichmentSourcesTable();
  const sourceUrl = String(options.sourceUrl ?? "").trim();
  if (!sourceUrl) {
    throw new Error("enrichment source URL required");
  }
  const discoveredAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO enrichment_sources (entity_type, entity_id, source_type, source_url, discovered_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(entity_type, entity_id, source_type) DO UPDATE SET
       source_url = excluded.source_url,
       discovered_at = excluded.discovered_at`
  ).run(
    options.entityType,
    options.entityId,
    options.sourceType,
    sourceUrl,
    discoveredAt
  );
  return {
    entityType: options.entityType,
    entityId: options.entityId,
    sourceType: options.sourceType,
    sourceUrl,
    discoveredAt
  };
}

export function clearEnrichmentSourcesForTests(): void {
  ensureEnrichmentSourcesTable();
  db.exec("DELETE FROM enrichment_sources");
}
