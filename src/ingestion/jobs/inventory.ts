/**
 * Load inventory rows and map enrichment results back onto table columns
 * (plus barcode_cache / cola_cache when a UPC is present for fields the shelf table lacks).
 */
import { getBarcodeCacheEntry, saveBarcodeCacheEntry } from "../../barcode_cache.js";
import { resolveMonotonicSpiritClassification } from "../../catalog.js";
import {
  isUsableCanonicalFamily,
  normalizeCanonicalAbv,
  normalizeCanonicalProof,
  normalizeCanonicalTaxonomy,
  normalizeCanonicalVolumeMl
} from "../../canonical-normalize.js";
import { db } from "../../db.js";
import { getFromCache, saveToCache } from "../catalogs/cola-cache-store.js";
import {
  candidateFromProduct,
  emptyField,
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
import type { BottleCandidateFieldName } from "../candidate/types.js";

/** Inventory columns that can receive metadata enrichment, by table. */
const INVENTORY_COLUMN_FOR: Record<EnrichmentEntityType, Partial<Record<MetadataEnrichmentField, string>>> = {
  spirits: { category: "category", abv: "abv", volume_ml: "volume_ml" },
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
  name: BottleCandidateFieldName,
  incoming: ProductField<unknown>
) {
  const merged = mergeField(candidate[name] as ProductField<unknown>, incoming, name);
  (candidate as unknown as Record<string, ProductField<unknown>>)[name] = merged.field;
}

function overlayUpcCaches(candidate: BottleCandidate): BottleCandidate {
  const upc = candidate.upc.value?.trim();
  if (!upc) return candidate;

  const cola = getFromCache(upc, { allowStale: true });
  if (cola) {
    const fromCola = candidateFromProduct(cola, "cola_cache");
    for (const name of [...METADATA_ENRICHMENT_FIELDS, "category", "product_type", "name", "brand"] as const) {
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
    for (const name of ["abv", "proof", "volume_ml", "category", "name", "brand"] as const) {
      applyMergeOnto(candidate, name, fromBarcode[name] as ProductField<unknown>);
    }
  }

  return candidate;
}

/**
 * Convert a saved shelf row into a BottleCandidate.
 * Source is vault (trusted). product_type is inferred from the table when absent.
 * Default numeric zeros (common SQLite defaults) and junk commerce taxonomy are
 * treated as unresolved for enrichment planning.
 * When a UPC is present, barcode_cache / cola_cache fill metadata gaps without weakening vault values.
 */
export function candidateFromInventoryRow(
  entityType: EnrichmentEntityType,
  row: Record<string, unknown>
): BottleCandidate {
  const inferredType =
    entityType === "packaged_beer" ? "beer" : entityType === "wines" ? "wine" : "spirit";

  const categoryRaw = String(row.category ?? row.style ?? row.varietal ?? row.type ?? "");
  const subRaw = String(row.sub_category ?? "");
  const tax = normalizeCanonicalTaxonomy(categoryRaw, subRaw);
  const usableFamily = tax.family || (isUsableCanonicalFamily(categoryRaw) ? categoryRaw : "");
  const classification = tax.type || usableFamily;

  const normalized: Record<string, unknown> = {
    ...row,
    brand: row.brand ?? row.brewery ?? row.producer ?? "",
    category: classification || usableFamily,
    sub_category: tax.type,
    product_type: row.product_type || tax.productType || inferredType,
    origin: row.origin ?? row.region ?? null,
    volume_ml: normalizeCanonicalVolumeMl(row.volume_ml),
    abv: normalizeCanonicalAbv(row.abv, {
      productType: String(row.product_type || tax.productType || inferredType)
    }),
    proof: normalizeCanonicalProof(row.proof),
    ttb_id: row.ttb_id
  };

  const candidate = candidateFromProduct(normalized, "vault");
  if (isUnresolvedField(candidate.product_type)) {
    candidate.product_type = field(inferredType, "vault");
  }
  if (!classification && !usableFamily) {
    candidate.category = emptyField();
  }
  return overlayUpcCaches(candidate);
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
 * Whether metadata enrichment should be queued.
 *
 * Automatic path (force=false): one-shot — after a completed metadata job, do not
 * re-queue on save/page-load even when gaps remain (avoids endless retry loops).
 *
 * Admin/backfill path (force=true): may re-queue when recommended/persistable gaps
 * remain so expanded enrichment capability can fill prior no-result/partial bottles.
 */
export function shouldScheduleMetadataEnrichment(options: {
  candidate: BottleCandidate;
  entityType: EnrichmentEntityType;
  entityId: number;
  /** Explicit admin/backfill rerun — not used by ordinary save/ensure. */
  force?: boolean;
}): boolean {
  const { candidate, entityType, entityId, force = false } = options;
  const needsPersistable = hasPersistableMetadataWork(candidate, entityType);
  const needsRecommended = hasRecommendedMetadataWork(candidate);
  if (!needsPersistable && !needsRecommended) return false;

  // Cache-only gaps still require a UPC key for catalog/web lookup.
  if (!needsPersistable && !candidate.upc.value?.trim()) return false;

  const completed = db.prepare(`
    SELECT 1 AS ok FROM enrichment_jobs
    WHERE entity_type = ? AND entity_id = ? AND job_type = 'metadata' AND status = 'completed'
    LIMIT 1
  `).get(entityType, entityId) as { ok: number } | undefined;

  if (completed) {
    return force;
  }
  return true;
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
 * Spirit classification specificity is monotonic (Scotch Whisky cannot collapse to Whiskey).
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
  const currentRow = loadInventoryRow(entityType, entityId);

  for (const name of METADATA_ENRICHMENT_FIELDS) {
    const column = columnMap[name];
    if (!column) continue;
    if (!shouldPersistField(before[name] as ProductField<unknown>, after[name] as ProductField<unknown>)) continue;

    if (name === "category" && entityType === "spirits") {
      const desired = resolveMonotonicSpiritClassification({
        incomingLabel: String(after.category.value ?? ""),
        existingFamily: String(currentRow?.category ?? ""),
        existingType: String(currentRow?.sub_category ?? "")
      });
      if (!desired.family) continue;
      sets.push("category = ?", "sub_category = ?");
      values.push(desired.family, desired.type);
      inventoryUpdated.push("category", "sub_category");
      continue;
    }

    sets.push(`${column} = ?`);
    values.push(after[name].value);
    inventoryUpdated.push(column);
  }

  // Sync spirit hierarchy when the candidate is more specific than the inventory row,
  // even if the overlaid candidate field did not "improve" vs before (cache already had Scotch).
  if (entityType === "spirits" && !isUnresolvedField(after.category)) {
    const row = currentRow ?? loadInventoryRow(entityType, entityId);
    const desired = resolveMonotonicSpiritClassification({
      incomingLabel: String(after.category.value ?? ""),
      existingFamily: String(row?.category ?? ""),
      existingType: String(row?.sub_category ?? "")
    });
    const rowFamily = String(row?.category ?? "");
    const rowType = String(row?.sub_category ?? "");
    if (
      desired.family
      && (desired.family !== rowFamily || desired.type !== rowType)
      && !inventoryUpdated.includes("category")
    ) {
      sets.push("category = ?", "sub_category = ?");
      values.push(desired.family, desired.type);
      inventoryUpdated.push("category", "sub_category");
    }
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
    const desiredClass =
      entityType === "spirits" && !isUnresolvedField(after.category)
        ? resolveMonotonicSpiritClassification({
            incomingLabel: String(after.category.value ?? ""),
            existingFamily: String(currentRow?.category ?? ""),
            existingType: String(currentRow?.sub_category ?? "")
          })
        : null;
    const cachePatch: Record<string, unknown> = {
      upc,
      name: after.name.value,
      brand: after.brand.value ?? "",
      category: desiredClass?.family || after.category.value || "Other",
      subcategory: desiredClass?.type || "",
      source: "enrichment"
    };
    let touchCache = false;
    for (const name of METADATA_ENRICHMENT_FIELDS) {
      if (!shouldPersistField(before[name] as ProductField<unknown>, after[name] as ProductField<unknown>)) {
        // Still allow classification cache sync when inventory hierarchy was repaired above.
        if (!(name === "category" && inventoryUpdated.includes("category"))) continue;
      }
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
      if (name === "category") {
        if (desiredClass?.family) {
          cachePatch.category = desiredClass.family;
          cachePatch.subcategory = desiredClass.type;
        }
        touchCache = true;
      }
      if (name === "origin" || name === "ttb_id") touchCache = true;
    }
    if (inventoryUpdated.includes("category")) touchCache = true;
    if (touchCache) {
      saveBarcodeCacheEntry(cachePatch as Parameters<typeof saveBarcodeCacheEntry>[0]);
      if (after.abv.value != null || after.origin.value || after.ttb_id.value || after.volume_ml.value != null || inventoryUpdated.includes("category")) {
        saveToCache(
          {
            upc,
            name: String(after.name.value),
            brand: String(after.brand.value ?? ""),
            category: String(
              desiredClass?.type || desiredClass?.family || after.category.value || "Spirits"
            ),
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
