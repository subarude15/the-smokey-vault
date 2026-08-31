/**
 * Decide whether to enqueue background enrichment jobs after inventory save.
 */
import { planEnrichment, type PlanEnrichmentOptions } from "../enrichment/index.js";
import {
  candidateFromInventoryRow,
  shouldScheduleMetadataEnrichment
} from "./inventory.js";
import {
  getProductContent,
  productContentFullyPopulated
} from "./product-content.js";
import {
  hasAcceptedProductImage,
  inventoryHasUserImage
} from "./product-images.js";
import {
  enqueueImageJob,
  enqueueMetadataJob,
  enqueueTastingNotesJob,
  enrichmentJobCounts,
  hasCompletedJob
} from "./store.js";
import type { EnrichmentEntityType, EnrichmentJob } from "./types.js";
import { isEnrichmentEntityType } from "./types.js";
import type { EnrichmentLogger } from "./worker.js";

export type MaybeEnqueueResult =
  | { enqueued: false; reason: string }
  | { enqueued: true; created: boolean; job: EnrichmentJob };

function logEnqueue(
  logger: EnrichmentLogger | undefined,
  job: EnrichmentJob,
  created: boolean,
  entityType: string,
  entityId: number
) {
  logger?.info(
    {
      jobId: job.id,
      created,
      jobType: job.job_type,
      entityType,
      entityId,
      counts: enrichmentJobCounts()
    },
    created ? "enrichment job queued" : "enrichment job already active"
  );
}

/**
 * Enqueue metadata enrichment when the saved bottle is identified, not in review,
 * and still has recommended metadata gaps. Never throws for policy skips.
 */
export function maybeEnqueueMetadataEnrichment(options: {
  entityType: string;
  entityId: number;
  row: Record<string, unknown>;
  planOptions?: PlanEnrichmentOptions;
  logger?: EnrichmentLogger;
  /** Admin/backfill may re-run metadata when gaps remain after a completed job. */
  force?: boolean;
}): MaybeEnqueueResult {
  if (!isEnrichmentEntityType(options.entityType)) {
    return { enqueued: false, reason: "unsupported_entity" };
  }
  const entityType = options.entityType as EnrichmentEntityType;
  const candidate = candidateFromInventoryRow(entityType, options.row);
  const plan = planEnrichment(candidate, options.planOptions ?? {});

  if (!plan.identified) return { enqueued: false, reason: "not_identified" };
  if (plan.needsReview) return { enqueued: false, reason: "needs_review" };
  if (!shouldScheduleMetadataEnrichment({
    candidate,
    entityType,
    entityId: options.entityId,
    force: options.force === true
  })) {
    return { enqueued: false, reason: "already_complete" };
  }

  const { job, created } = enqueueMetadataJob({
    entityType,
    entityId: options.entityId,
    upc: candidate.upc.value
  });
  logEnqueue(options.logger, job, created, entityType, options.entityId);
  return { enqueued: true, created, job };
}

export function shouldScheduleTastingNotesEnrichment(options: {
  entityType: EnrichmentEntityType;
  entityId: number;
}): boolean {
  const content = getProductContent(options.entityType, options.entityId);
  if (productContentFullyPopulated(content)) return false;
  // One-shot: after a completed tasting_notes job, do not keep re-queueing null results.
  if (hasCompletedJob(options.entityType, options.entityId, "tasting_notes")) {
    return false;
  }
  return true;
}

/**
 * Enqueue tasting-note enrichment independently from metadata.
 * Gate: identified, not needsReview, content gaps remain, no prior completed job.
 */
export function maybeEnqueueTastingNotesEnrichment(options: {
  entityType: string;
  entityId: number;
  row: Record<string, unknown>;
  planOptions?: PlanEnrichmentOptions;
  logger?: EnrichmentLogger;
}): MaybeEnqueueResult {
  if (!isEnrichmentEntityType(options.entityType)) {
    return { enqueued: false, reason: "unsupported_entity" };
  }
  const entityType = options.entityType as EnrichmentEntityType;
  const candidate = candidateFromInventoryRow(entityType, options.row);
  const plan = planEnrichment(candidate, options.planOptions ?? {});

  if (!plan.identified) return { enqueued: false, reason: "not_identified" };
  if (plan.needsReview) return { enqueued: false, reason: "needs_review" };
  if (!shouldScheduleTastingNotesEnrichment({ entityType, entityId: options.entityId })) {
    return { enqueued: false, reason: "already_complete" };
  }

  const { job, created } = enqueueTastingNotesJob({
    entityType,
    entityId: options.entityId,
    upc: candidate.upc.value
  });
  logEnqueue(options.logger, job, created, entityType, options.entityId);
  return { enqueued: true, created, job };
}

export function shouldScheduleImageEnrichment(options: {
  entityType: EnrichmentEntityType;
  entityId: number;
  row: Record<string, unknown>;
}): boolean {
  if (inventoryHasUserImage(options.row, options.entityType, options.entityId)) return false;
  if (hasAcceptedProductImage(options.entityType, options.entityId)) return false;
  if (hasCompletedJob(options.entityType, options.entityId, "image")) return false;
  return true;
}

/**
 * Enqueue image enrichment independently from metadata / tasting notes.
 * Skips when a user/shelf image already exists or a prior image job completed.
 */
export function maybeEnqueueImageEnrichment(options: {
  entityType: string;
  entityId: number;
  row: Record<string, unknown>;
  planOptions?: PlanEnrichmentOptions;
  logger?: EnrichmentLogger;
}): MaybeEnqueueResult {
  if (!isEnrichmentEntityType(options.entityType)) {
    return { enqueued: false, reason: "unsupported_entity" };
  }
  const entityType = options.entityType as EnrichmentEntityType;
  const candidate = candidateFromInventoryRow(entityType, options.row);
  const plan = planEnrichment(candidate, options.planOptions ?? {});

  if (!plan.identified) return { enqueued: false, reason: "not_identified" };
  if (plan.needsReview) return { enqueued: false, reason: "needs_review" };
  if (!shouldScheduleImageEnrichment({
    entityType,
    entityId: options.entityId,
    row: options.row
  })) {
    return { enqueued: false, reason: "already_complete" };
  }

  const { job, created } = enqueueImageJob({
    entityType,
    entityId: options.entityId,
    upc: candidate.upc.value
  });
  logEnqueue(options.logger, job, created, entityType, options.entityId);
  return { enqueued: true, created, job };
}
