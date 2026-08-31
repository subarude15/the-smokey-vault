/**
 * Load inventory rows and map enrichment results back onto table columns
 * (plus barcode_cache / cola_cache when a UPC is present for fields the shelf table lacks).
 */
import { getBarcodeCacheEntry, saveBarcodeCacheEntry } from "../../barcode_cache.js";
import { db } from "../../db.js";
import { getFromCache, saveToCache } from "../catalogs/cola-cache-store.js";
import {
  candidateFromProduct,
  field,
  isUnresolvedField,
  mergeField,
  type BottleCandidate,
  type ProductField
} from "../candidate/index.js";
import type { MetadataEnrichmentField } from "../enrichment/metadata-fields.js";
import { METADATA_ENRICHMENT_FIELDS } from "../enrichment/metadata-fields.js";
import { TRUSTED_MIN } from "../enrichment/rules.js";
import type { EnrichmentEntityType } from "./types.js";
import { applyFieldOverridesToCandidate } from "./field-overrides.js";

/** Inventory columns that can receive metadata enrichment, by table. */
const INVENTORY_COLUMN_FOR: Record<EnrichmentEntityType, Partial<Record<MetadataEnrichmentField, string>>> = {
  spirits: { abv: "abv", volume_ml: "volume_ml" },
  packaged_beer: { abv: "abv" },
  wines: { origin: "region" }
};

export function loadInventoryRow(
  entityType: EnrichmentEntityType,
  entityId: number
): Record<string, unknown> | null {
  const row = db.prepare(`SELECT * FROM ${entityType} WHERE id = ?`).get(entityId) as Record<string, unknown> | undefined;
  return row ?? null;
}

function applyMergeOnto(
  candidate: BottleCandidate,
  name: MetadataEnrichmentField,
  incoming: ProductField<unknown>
) {
  const merged = mergeField(candidate[name] as ProductField<unknown>, incoming, name);
  switch (name) {
    case "abv":
      candidate.abv = merged.field as BottleCandidate["abv"];
      break;
    case "proof":
      candidate.proof = merged.field as BottleCandidate["proof"];
      break;
    case "volume_ml":
      candidate.volume_ml = merged.field as BottleCandidate["volume_ml"];
      break;
    case "origin":
      candidate.origin = merged.field as BottleCandidate["origin"];
      break;
    case "ttb_id":
      candidate.ttb_id = merged.field as BottleCandidate["ttb_id"];
      break;
  }
}

function overlayUpcCaches(candidate: BottleCandidate): BottleCandidate {
  const upc = candidate.upc.value?.trim();
  if (!upc) return candidate;

  const cola = getFromCache(upc, { allowStale: true });
  if (cola) {
    const fromCola = candidateFromProduct(cola, "cola_cache");
    for (const name of METADATA_ENRICHMENT_FIELDS) {
      applyMergeOnto(candidate, name, fromCola[name] as ProductField<unknown>);
    }
  }

  const barcode = getBarcodeCacheEntry(upc);
  if (barcode) {
    const fromBarcode = candidateFromProduct(
      {
        upc: barcode.upc,
        name: barcode.name,
        brand: barcode.brand,
        category: barcode.category,
        abv: barcode.abv,
        proof: barcode.proof,
        volume_ml: barcode.volume_ml
      },
      "barcode_cache"
    );
    for (const name of ["abv", "proof", "volume_ml"] as const) {
      applyMergeOnto(candidate, name, fromBarcode[name] as ProductField<unknown>);
    }
  }

  return candidate;
}

/**
 * Convert a saved shelf row into a BottleCandidate.
 * Source is vault (trusted). product_type is inferred from the table when absent.
 * Default numeric zeros (common SQLite defaults) are treated as unresolved for enrichment.
 * When a UPC is present, barcode_cache / cola_cache fill metadata gaps without weakening vault values.
 */
export function candidateFromInventoryRow(
  entityType: EnrichmentEntityType,
  row: Record<string, unknown>
): BottleCandidate {
  const inferredType =
    entityType === "packaged_beer" ? "beer" : entityType === "wines" ? "wine" : "spirit";

  const normalized: Record<string, unknown> = {
    ...row,
    brand: row.brand ?? row.brewery ?? row.producer ?? "",
    category: row.category ?? row.style ?? row.varietal ?? row.type ?? "",
    product_type: row.product_type || inferredType,
    origin: row.origin ?? row.region ?? null,
    volume_ml: row.volume_ml,
    abv: row.abv,
    proof: row.proof,
    ttb_id: row.ttb_id
  };

  // Treat default 0 abv / volume as unknown for enrichment planning.
  if (normalized.abv === 0 || normalized.abv === "0") normalized.abv = null;
  if (normalized.volume_ml === 0 || normalized.volume_ml === "0") normalized.volume_ml = null;

  const candidate = candidateFromProduct(normalized, "vault");
  if (isUnresolvedField(candidate.product_type)) {
    candidate.product_type = field(inferredType, "vault");
  }
  const withCaches = overlayUpcCaches(candidate);
  const entityId = Number(row.id);
  if (Number.isFinite(entityId) && entityId > 0) {
    return applyFieldOverridesToCandidate(entityType, entityId, withCaches);
  }
  return withCaches;
}

function fieldNeedsWork(f: ProductField<unknown>): boolean {
  return isUnresolvedField(f) || f.confidence < TRUSTED_MIN;
}

/** True when a shelf-persistable metadata column still needs enrichment. */
export function hasPersistableMetadataWork(
  candidate: BottleCandidate,
  entityType: EnrichmentEntityType
): boolean {
  const columnMap = INVENTORY_COLUMN_FOR[entityType];
  return METADATA_ENRICHMENT_FIELDS.some((name) => {
    if (!columnMap[name]) return false;
    return fieldNeedsWork(candidate[name] as ProductField<unknown>);
  });
}

/** True when any metadata enrichment field on the candidate still needs work. */
export function hasRecommendedMetadataWork(candidate: BottleCandidate): boolean {
  return METADATA_ENRICHMENT_FIELDS.some((name) => fieldNeedsWork(candidate[name] as ProductField<unknown>));
}

/**
 * Whether background metadata enrichment is still useful for this saved entity.
 * Persistable shelf gaps always qualify. Cache-only gaps (origin/ttb/proof on spirits)
 * qualify only when no completed metadata job exists yet for the entity (one-shot).
 */
export function shouldScheduleMetadataEnrichment(options: {
  candidate: BottleCandidate;
  entityType: EnrichmentEntityType;
  entityId: number;
}): boolean {
  const { candidate, entityType, entityId } = options;
  if (hasPersistableMetadataWork(candidate, entityType)) return true;
  if (!hasRecommendedMetadataWork(candidate)) return false;
  // Remaining gaps are cache-only (or unkeyed without UPC).
  if (!candidate.upc.value?.trim()) return false;
  const completed = db.prepare(`
    SELECT 1 AS ok FROM enrichment_jobs
    WHERE entity_type = ? AND entity_id = ? AND job_type = 'metadata' AND status = 'completed'
    LIMIT 1
  `).get(entityType, entityId) as { ok: number } | undefined;
  return !completed;
}

function shouldPersistField(
  before: ProductField<unknown>,
  after: ProductField<unknown>
): boolean {
  if (isUnresolvedField(after)) return false;
  if (isUnresolvedField(before)) return true;
  if (after.confidence < before.confidence) return false;
  if (after.confidence === before.confidence && after.value === before.value) return false;
  return after.confidence > before.confidence;
}

/**
 * Persist safely improved metadata onto the inventory row (+ barcode/cola cache when UPC exists).
 * Never writes weaker values over stronger stored data.
 */
export function persistMetadataImprovements(options: {
  entityType: EnrichmentEntityType;
  entityId: number;
  before: BottleCandidate;
  after: BottleCandidate;
}): { inventoryUpdated: string[]; cacheUpdated: boolean } {
  const { entityType, entityId, before, after } = options;
  const columnMap = INVENTORY_COLUMN_FOR[entityType];
  const sets: string[] = [];
  const values: unknown[] = [];
  const inventoryUpdated: string[] = [];

  for (const name of METADATA_ENRICHMENT_FIELDS) {
    const column = columnMap[name];
    if (!column) continue;
    if (!shouldPersistField(before[name] as ProductField<unknown>, after[name] as ProductField<unknown>)) continue;
    sets.push(`${column} = ?`);
    values.push(after[name].value);
    inventoryUpdated.push(column);
  }

  if (sets.length) {
    db.prepare(`
      UPDATE ${entityType}
      SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(...values, entityId);
  }

  let cacheUpdated = false;
  const upc = after.upc.value?.trim();
  if (upc && after.name.value) {
    const cachePatch: Record<string, unknown> = {
      upc,
      name: after.name.value,
      brand: after.brand.value ?? "",
      category: after.category.value ?? "Other",
      source: "enrichment"
    };
    let touchCache = false;
    for (const name of METADATA_ENRICHMENT_FIELDS) {
      if (!shouldPersistField(before[name] as ProductField<unknown>, after[name] as ProductField<unknown>)) continue;
      if (name === "abv") {
        cachePatch.abv = after.abv.value;
        touchCache = true;
      }
      if (name === "proof") {
        cachePatch.proof = after.proof.value;
        touchCache = true;
      }
      if (name === "volume_ml") {
        cachePatch.volume_ml = after.volume_ml.value ?? 750;
        touchCache = true;
      }
      if (name === "origin" || name === "ttb_id") touchCache = true;
    }
    if (touchCache) {
      saveBarcodeCacheEntry(cachePatch as Parameters<typeof saveBarcodeCacheEntry>[0]);
      if (after.abv.value != null || after.origin.value || after.ttb_id.value || after.volume_ml.value != null) {
        saveToCache(
          {
            upc,
            name: String(after.name.value),
            brand: String(after.brand.value ?? ""),
            category: String(after.category.value ?? "Spirits"),
            abv: after.abv.value,
            image_url: null,
            fill_level_percent: 100,
            bottle_count: 1,
            notes: null,
            volume_ml: after.volume_ml.value,
            product_type: after.product_type.value,
            ttb_id: after.ttb_id.value,
            origin: after.origin.value,
            approval_date: null
          },
          null,
          null,
          "enrichment"
        );
      }
      cacheUpdated = true;
    }
  }

  return { inventoryUpdated, cacheUpdated };
}
