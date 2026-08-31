/**
 * Decide whether to enqueue background metadata enrichment after inventory save.
 */
import { planEnrichment, type PlanEnrichmentOptions } from "../enrichment/index.js";
import {
  candidateFromInventoryRow,
  shouldScheduleMetadataEnrichment
} from "./inventory.js";
import { enqueueMetadataJob, enrichmentJobCounts } from "./store.js";
import type { EnrichmentEntityType, EnrichmentJob } from "./types.js";
import { isEnrichmentEntityType } from "./types.js";
import type { EnrichmentLogger } from "./worker.js";

export type MaybeEnqueueResult =
  | { enqueued: false; reason: string }
  | { enqueued: true; created: boolean; job: EnrichmentJob };

/**
 * Enqueue metadata enrichment when the saved bottle is identified, not in review,
 * and still has recommended metadata gaps. Never throws for policy skips.
 */
export function maybeEnqueueMetadataEnrichment(options: {
  entityType: string;
  entityId: number;
  row: Record<string, unknown>;
  /** Optional planner conflicts (e.g. identity disagreements) for needsReview gating. */
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
  if (!shouldScheduleMetadataEnrichment({ candidate, entityType, entityId: options.entityId })) {
    return { enqueued: false, reason: "already_complete" };
  }

  const { job, created } = enqueueMetadataJob({
    entityType,
    entityId: options.entityId,
    upc: candidate.upc.value
  });

  options.logger?.info(
    {
      jobId: job.id,
      created,
      entityType,
      entityId: options.entityId,
      counts: enrichmentJobCounts()
    },
    created ? "enrichment job queued" : "enrichment job already active"
  );

  return { enqueued: true, created, job };
}
