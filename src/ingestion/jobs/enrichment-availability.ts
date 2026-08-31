/**
 * Enrichment availability is distinct from scheduling policy.
 * shouldSchedule*() === false does NOT mean complete.
 *
 * Metadata availability shares semantics with bottle job views via metadataOutcomeFromState.
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
import { metadataOutcomeFromState } from "./metadata-outcome.js";
import type { BottleCandidate } from "../candidate/index.js";
import type { EnrichmentEntityType } from "./types.js";

export type EnrichmentAvailability =
  | "complete"
  | "partial"
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
  const outcome = metadataOutcomeFromState(options);
  switch (outcome) {
    case "complete":
      return "complete";
    case "partial":
      return "partial";
    case "no_result":
      return "no_result";
    case "failed":
      return "failed";
    case "active":
      return "active";
    case "missing":
      return "missing";
    default:
      return "missing";
  }
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
