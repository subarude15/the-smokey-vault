/**
 * Narrow reopen flag so exact-match official brewery images can replace
 * previously accepted machine product_images without touching user/shelf images.
 */
import { db } from "../../db.js";
import type { EnrichmentEntityType } from "./types.js";

export type OfficialImageRepairRequest = {
  entity_type: EnrichmentEntityType;
  entity_id: number;
  match_quality: string;
  official_page_url: string | null;
  official_image_url: string | null;
  created_at: string;
  consumed_at: string | null;
};

let ensured = false;

export function ensureOfficialImageRepairTable(): void {
  if (ensured) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS official_image_repair_requests (
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      match_quality TEXT NOT NULL,
      official_page_url TEXT,
      official_image_url TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      consumed_at TEXT,
      PRIMARY KEY (entity_type, entity_id)
    );
  `);
  ensured = true;
}

export function requestOfficialImageRepair(options: {
  entityType: EnrichmentEntityType;
  entityId: number;
  matchQuality: string;
  officialPageUrl?: string | null;
  officialImageUrl?: string | null;
}): void {
  ensureOfficialImageRepairTable();
  db.prepare(
    `INSERT INTO official_image_repair_requests (
       entity_type, entity_id, match_quality, official_page_url, official_image_url, created_at, consumed_at
     ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, NULL)
     ON CONFLICT(entity_type, entity_id) DO UPDATE SET
       match_quality = excluded.match_quality,
       official_page_url = excluded.official_page_url,
       official_image_url = excluded.official_image_url,
       created_at = CURRENT_TIMESTAMP,
       consumed_at = NULL`
  ).run(
    options.entityType,
    options.entityId,
    options.matchQuality,
    options.officialPageUrl ?? null,
    options.officialImageUrl ?? null
  );
}

export function getPendingOfficialImageRepair(
  entityType: EnrichmentEntityType,
  entityId: number
): OfficialImageRepairRequest | null {
  ensureOfficialImageRepairTable();
  const row = db
    .prepare(
      `SELECT entity_type, entity_id, match_quality, official_page_url, official_image_url, created_at, consumed_at
       FROM official_image_repair_requests
       WHERE entity_type = ? AND entity_id = ? AND consumed_at IS NULL`
    )
    .get(entityType, entityId) as OfficialImageRepairRequest | undefined;
  return row ?? null;
}

export function hasPendingOfficialImageRepair(
  entityType: EnrichmentEntityType,
  entityId: number
): boolean {
  return getPendingOfficialImageRepair(entityType, entityId) != null;
}

export function consumeOfficialImageRepair(
  entityType: EnrichmentEntityType,
  entityId: number
): void {
  ensureOfficialImageRepairTable();
  db.prepare(
    `UPDATE official_image_repair_requests
     SET consumed_at = CURRENT_TIMESTAMP
     WHERE entity_type = ? AND entity_id = ? AND consumed_at IS NULL`
  ).run(entityType, entityId);
}

export function clearOfficialImageRepairForTests(): void {
  ensureOfficialImageRepairTable();
  db.exec("DELETE FROM official_image_repair_requests");
}
