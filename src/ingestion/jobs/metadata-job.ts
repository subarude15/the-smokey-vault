/**
 * Run one metadata enrichment job against a saved inventory entity.
 */
import {
  executeMetadataEnrichment,
  planEnrichment,
  type EnrichmentExecutionResult,
  type MetadataEnrichmentDeps
} from "../enrichment/index.js";
import {
  candidateFromInventoryRow,
  hasRecommendedMetadataWork,
  loadInventoryRow,
  persistMetadataImprovements
} from "./inventory.js";
import {
  buildMetadataJobResultPayload,
  type MetadataJobResultPayload,
  unresolvedMetadataFields
} from "./metadata-outcome.js";
import type { EnrichmentJob } from "./types.js";

export type MetadataJobResult = {
  skipped: boolean;
  reason?: string;
  execution?: EnrichmentExecutionResult;
  inventoryUpdated: string[];
  cacheUpdated: boolean;
  /** Lightweight progress for job.result_json. */
  resultPayload: MetadataJobResultPayload;
};

export async function runMetadataJob(
  job: EnrichmentJob,
  deps: MetadataEnrichmentDeps = {}
): Promise<MetadataJobResult> {
  const row = loadInventoryRow(job.entity_type, job.entity_id);
  if (!row) {
    throw new Error(`Inventory ${job.entity_type}#${job.entity_id} not found`);
  }

  const before = candidateFromInventoryRow(job.entity_type, row);
  const plan = planEnrichment(before);

  if (!plan.identified) {
    return {
      skipped: true,
      reason: "not_identified",
      inventoryUpdated: [],
      cacheUpdated: false,
      resultPayload: {
        requested: [],
        updated: [],
        unresolved: unresolvedMetadataFields(before).map(String)
      }
    };
  }
  if (plan.needsReview) {
    return {
      skipped: true,
      reason: "needs_review",
      inventoryUpdated: [],
      cacheUpdated: false,
      resultPayload: {
        requested: [],
        updated: [],
        unresolved: unresolvedMetadataFields(before).map(String)
      }
    };
  }
  if (!hasRecommendedMetadataWork(before)) {
    return {
      skipped: true,
      reason: "already_complete",
      inventoryUpdated: [],
      cacheUpdated: false,
      resultPayload: {
        requested: [],
        updated: [],
        unresolved: []
      }
    };
  }

  const execution = await executeMetadataEnrichment(before, plan, deps);

  // Transient system/dep failures with zero progress should retry, not look like
  // a successful "nothing found" completion.
  if (execution.errors.length > 0 && execution.updated.length === 0) {
    const message = execution.errors.map((e) => e.message).join("; ") || "metadata enrichment failed";
    throw new Error(message);
  }

  const persisted = persistMetadataImprovements({
    entityType: job.entity_type,
    entityId: job.entity_id,
    before,
    after: execution.candidate
  });

  const resultPayload = buildMetadataJobResultPayload({
    requested: execution.requested.map(String),
    before,
    after: execution.candidate,
    inventoryUpdated: persisted.inventoryUpdated,
    diagnostics: execution.diagnostics
  });

  return {
    skipped: false,
    execution,
    inventoryUpdated: persisted.inventoryUpdated,
    cacheUpdated: persisted.cacheUpdated,
    resultPayload
  };
}
