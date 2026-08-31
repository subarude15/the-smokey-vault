/**
 * Enrichment availability is distinct from scheduling policy.
 * shouldSchedule*() === false does NOT mean complete.
 */
import { hasActiveEnrichmentJob, hasCompletedJob, hasFailedJob } from "./store.js";
import {
  getProductContent,
  productContentFullyPopulated
} from "./product-content.js";
import {
  hasAcceptedProductImage,
  inventoryHasUserImage
} from "./product-images.js";
import {
  hasPersistableMetadataWork,
  hasRecommendedMetadataWork
} from "./inventory.js";
import type { BottleCandidate } from "../candidate/index.js";
import type { EnrichmentEntityType } from "./types.js";

export type EnrichmentAvailability =
  | "complete"
  | "missing"
  | "active"
  | "no_result"
  | "failed";

function hasFailedEnrichmentJob(
  entityType: EnrichmentEntityType,
  entityId: number,
  jobType: "metadata" | "tasting_notes" | "image"
): boolean {
  return hasFailedJob(entityType, entityId, jobType);
}

export function metadataEnrichmentAvailability(options: {
  candidate: BottleCandidate;
  entityType: EnrichmentEntityType;
  entityId: number;
}): EnrichmentAvailability {
  const { candidate, entityType, entityId } = options;
  if (hasActiveEnrichmentJob(entityType, entityId, "metadata")) return "active";

  const needsPersistable = hasPersistableMetadataWork(candidate, entityType);
  const needsRecommended = hasRecommendedMetadataWork(candidate);

  // Shelf-applicable metadata is complete when persistable columns are satisfied
  // and either nothing else is recommended or a one-shot metadata job already ran.
  if (!needsPersistable && !needsRecommended) return "complete";
  if (!needsPersistable && hasCompletedJob(entityType, entityId, "metadata")) {
    return "complete";
  }

  if (hasFailedEnrichmentJob(entityType, entityId, "metadata") && (needsPersistable || needsRecommended)) {
    return "failed";
  }

  if (needsPersistable) return "missing";

  // Cache-only gaps, never attempted — still missing for scheduling, not "complete".
  return "missing";
}

export function tastingNotesEnrichmentAvailability(options: {
  entityType: EnrichmentEntityType;
  entityId: number;
}): EnrichmentAvailability {
  const { entityType, entityId } = options;
  const content = getProductContent(entityType, entityId);
  if (productContentFullyPopulated(content)) return "complete";
  if (hasActiveEnrichmentJob(entityType, entityId, "tasting_notes")) return "active";
  if (hasFailedEnrichmentJob(entityType, entityId, "tasting_notes")) return "failed";
  if (hasCompletedJob(entityType, entityId, "tasting_notes")) return "no_result";
  return "missing";
}

export function imageEnrichmentAvailability(options: {
  entityType: EnrichmentEntityType;
  entityId: number;
  row: Record<string, unknown>;
}): EnrichmentAvailability {
  const { entityType, entityId, row } = options;
  if (inventoryHasUserImage(row) || hasAcceptedProductImage(entityType, entityId)) {
    return "complete";
  }
  if (hasActiveEnrichmentJob(entityType, entityId, "image")) return "active";
  if (hasFailedEnrichmentJob(entityType, entityId, "image")) return "failed";
  if (hasCompletedJob(entityType, entityId, "image")) return "no_result";
  return "missing";
}

/** True only when metadata, tasting notes, and image enrichment are actually satisfied. */
export function bottleEnrichmentActuallyComplete(options: {
  candidate: BottleCandidate;
  entityType: EnrichmentEntityType;
  entityId: number;
  row: Record<string, unknown>;
}): boolean {
  return (
    metadataEnrichmentAvailability(options) === "complete"
    && tastingNotesEnrichmentAvailability(options) === "complete"
    && imageEnrichmentAvailability(options) === "complete"
  );
}
