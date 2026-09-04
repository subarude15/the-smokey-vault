/**
 * Persist selected product-image enrichment results with provenance.
 * Does not overwrite inventory user images.
 */
import { db } from "../../db.js";
import { isLocalImagePath } from "../../images.js";
import {
  isAcceptableImageSource,
  type ImageSourceType
} from "../enrichment/image-sources.js";
import { isEnrichmentEntityType, type EnrichmentEntityType } from "./types.js";

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

/**
 * True when inventory already has a *user* image we must not replace.
 * Remote lookup/CDN URLs and lookup-fallback provenance are NOT user images.
 */
export function inventoryHasUserImage(
  row: Record<string, unknown>,
  entityType?: EnrichmentEntityType,
  entityId?: number
): boolean {
  const url = String(row.image_url ?? "").trim();
  if (!url) return false;
  // Remote catalog / lookup URLs are never user uploads.
  if (url.startsWith("http://") || url.startsWith("https://")) return false;
  if (!isLocalImagePath(url)) return false;
  if (entityType != null && entityId != null) {
    const stored = getProductImage(entityType, entityId);
    if (stored?.source_type === "lookup") return false;
    if (stored?.source_type === "user") return true;
  }
  // Local media path without lookup provenance — treat as user/shelf upload.
  return true;
}

/** Persist a barcode-lookup / reference fallback image (not verified, not official). */
export function recordLookupImageFallback(options: {
  entityType: EnrichmentEntityType;
  entityId: number;
  url: string | null | undefined;
}): void {
  const url = String(options.url ?? "").trim();
  if (!url) return;
  const existing = getProductImage(options.entityType, options.entityId);
  if (existing?.source_type === "user") return;
  if (existing?.verified && existing.source_type && existing.source_type !== "lookup") return;
  upsertProductImage({
    entityType: options.entityType,
    entityId: options.entityId,
    url,
    sourceType: "lookup",
    verified: false,
    score: null,
    rejectionReason: null
  });
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
  if (!row?.url || !row.verified) return false;
  if (row.source_type === "lookup") return false;
  return (row.score ?? 0) > 0;
}

/** True when a product image URL is a remote http(s) asset (not locally durable). */
export function isRemoteProductImageUrl(url?: string | null): boolean {
  const value = String(url ?? "").trim();
  return value.startsWith("http://") || value.startsWith("https://");
}

/**
 * Accepted machine enrichment whose bytes are already persisted in the local
 * media store. Distinct from mere acceptance — remote hotlinked URLs do not qualify.
 */
export function hasDurableAcceptedProductImage(
  entityType: EnrichmentEntityType,
  entityId: number
): boolean {
  const row = getProductImage(entityType, entityId);
  if (!hasAcceptedProductImage(entityType, entityId) || !row?.url) return false;
  return isLocalImagePath(row.url);
}

/**
 * Accepted machine enrichment that still points at a remote http(s) URL and
 * therefore needs local persistence / repair. Does not redefine acceptance.
 */
export function productImageNeedsLocalization(
  entityType: EnrichmentEntityType,
  entityId: number
): boolean {
  const row = getProductImage(entityType, entityId);
  if (!hasAcceptedProductImage(entityType, entityId) || !row?.url) return false;
  if (row.source_type === "user") return false;
  return isRemoteProductImageUrl(row.url);
}

/**
 * Same acceptance gate enrichment uses for machine-selected display images.
 * Lookup / unverified / unapproved candidates do not qualify.
 */
export function isAcceptedEnrichedProductImage(
  image: ProductImageRecord | null | undefined
): boolean {
  return Boolean(image?.url)
    && Boolean(image?.verified)
    && image?.source_type != null
    && image.source_type !== "lookup"
    && isAcceptableImageSource(image.source_type);
}

/** URL of the currently accepted enriched product image, if any. */
export function acceptedEnrichedImageUrl(
  entityType: EnrichmentEntityType,
  entityId: number
): string | null {
  const image = getProductImage(entityType, entityId);
  if (!isAcceptedEnrichedProductImage(image) || !image?.url) return null;
  return image.url;
}

/**
 * Public UI display image for an inventory row.
 * Precedence: user/shelf inventory image → accepted enriched image → null.
 * Does not mutate inventory.image_url and does not promote lookup candidates.
 */
export function resolveInventoryDisplayImageUrl(
  entityType: EnrichmentEntityType,
  entityId: number,
  row: Record<string, unknown>
): string | null {
  const shelf = String(row.image_url ?? "").trim();
  if (inventoryHasUserImage(row, entityType, entityId) && shelf) return shelf;
  return acceptedEnrichedImageUrl(entityType, entityId);
}

/**
 * Attach derived `display_image_url` for enrichment inventory tables.
 * Safe for public inventory responses (URL only — no diagnostics).
 */
export function attachInventoryDisplayImageUrl(
  entityType: string,
  row: Record<string, unknown>
): Record<string, unknown> {
  if (!isEnrichmentEntityType(entityType)) return row;
  const id = Number(row.id);
  if (!Number.isFinite(id) || id <= 0) return { ...row, display_image_url: null };
  return {
    ...row,
    display_image_url: resolveInventoryDisplayImageUrl(entityType, id, row)
  };
}
