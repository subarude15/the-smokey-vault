/**
 * Persist selected product-image enrichment results with provenance.
 * Does not overwrite inventory user images.
 */
import { db } from "../../db.js";
import { isLocalImagePath } from "../../images.js";
import type { EnrichmentEntityType } from "./types.js";
import type { ImageSourceType } from "../enrichment/image-sources.js";

export type ProductImageRecord = {
  entity_type: EnrichmentEntityType;
  entity_id: number;
  url: string | null;
  source_type: ImageSourceType | null;
  source_url: string | null;
  width: number | null;
  height: number | null;
  mime_type: string | null;
  score: number | null;
  verified: boolean;
  rejection_reason: string | null;
  updated_at: string;
};

export function ensureProductImagesTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_images (
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      url TEXT,
      source_type TEXT,
      source_url TEXT,
      width INTEGER,
      height INTEGER,
      mime_type TEXT,
      score REAL,
      verified INTEGER NOT NULL DEFAULT 0,
      rejection_reason TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (entity_type, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_product_images_entity
      ON product_images(entity_type, entity_id);
  `);
}

ensureProductImagesTable();

type Row = {
  entity_type: string;
  entity_id: number;
  url: string | null;
  source_type: string | null;
  source_url: string | null;
  width: number | null;
  height: number | null;
  mime_type: string | null;
  score: number | null;
  verified: number;
  rejection_reason: string | null;
  updated_at: string;
};

function mapRow(row: Row): ProductImageRecord {
  const sourceType = row.source_type as ImageSourceType | null;
  return {
    entity_type: row.entity_type as EnrichmentEntityType,
    entity_id: Number(row.entity_id),
    url: row.url?.trim() || null,
    source_type: sourceType,
    source_url: row.source_url?.trim() || null,
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    mime_type: row.mime_type,
    score: row.score == null ? null : Number(row.score),
    verified: Boolean(row.verified),
    rejection_reason: row.rejection_reason,
    updated_at: row.updated_at
  };
}

export function getProductImage(
  entityType: EnrichmentEntityType,
  entityId: number
): ProductImageRecord | null {
  const row = db.prepare(`
    SELECT * FROM product_images WHERE entity_type = ? AND entity_id = ?
  `).get(entityType, entityId) as Row | undefined;
  return row ? mapRow(row) : null;
}

/** True when inventory already has a user-associated image we must not replace. */
export function inventoryHasUserImage(row: Record<string, unknown>): boolean {
  const url = String(row.image_url ?? "").trim();
  if (!url) return false;
  // Local uploads and any non-empty shelf image count as user/existing association.
  return isLocalImagePath(url) || url.startsWith("http") || url.startsWith("/");
}

export function upsertProductImage(options: {
  entityType: EnrichmentEntityType;
  entityId: number;
  url?: string | null;
  sourceType?: ImageSourceType | null;
  sourceUrl?: string | null;
  width?: number | null;
  height?: number | null;
  mimeType?: string | null;
  score?: number | null;
  verified?: boolean;
  rejectionReason?: string | null;
}): ProductImageRecord {
  const existing = getProductImage(options.entityType, options.entityId);
  // Never replace an existing verified user/official selection with empty.
  const nextUrl = options.url?.trim() || existing?.url || null;
  const writingNew = Boolean(options.url?.trim());

  db.prepare(`
    INSERT INTO product_images (
      entity_type, entity_id, url, source_type, source_url,
      width, height, mime_type, score, verified, rejection_reason, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(entity_type, entity_id) DO UPDATE SET
      url = excluded.url,
      source_type = excluded.source_type,
      source_url = excluded.source_url,
      width = excluded.width,
      height = excluded.height,
      mime_type = excluded.mime_type,
      score = excluded.score,
      verified = excluded.verified,
      rejection_reason = excluded.rejection_reason,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    options.entityType,
    options.entityId,
    nextUrl,
    writingNew ? (options.sourceType ?? null) : (existing?.source_type ?? options.sourceType ?? null),
    writingNew ? (options.sourceUrl ?? null) : (existing?.source_url ?? options.sourceUrl ?? null),
    writingNew ? (options.width ?? null) : (existing?.width ?? options.width ?? null),
    writingNew ? (options.height ?? null) : (existing?.height ?? options.height ?? null),
    writingNew ? (options.mimeType ?? null) : (existing?.mime_type ?? options.mimeType ?? null),
    writingNew ? (options.score ?? null) : (existing?.score ?? options.score ?? null),
    writingNew ? (options.verified ? 1 : 0) : (existing?.verified ? 1 : options.verified ? 1 : 0),
    writingNew ? (options.rejectionReason ?? null) : (options.rejectionReason ?? existing?.rejection_reason ?? null)
  );

  return getProductImage(options.entityType, options.entityId)!;
}

/** Record a completed search that found nothing acceptable. */
export function markProductImageEmpty(
  entityType: EnrichmentEntityType,
  entityId: number,
  reason = "no_acceptable_image"
): ProductImageRecord {
  return upsertProductImage({
    entityType,
    entityId,
    url: null,
    sourceType: null,
    sourceUrl: null,
    width: null,
    height: null,
    mimeType: null,
    score: null,
    verified: false,
    rejectionReason: reason
  });
}

export function clearProductImagesForTests() {
  db.exec("DELETE FROM product_images");
}

export function hasAcceptedProductImage(
  entityType: EnrichmentEntityType,
  entityId: number
): boolean {
  const row = getProductImage(entityType, entityId);
  return Boolean(row?.url && row.verified && (row.score ?? 0) > 0);
}
