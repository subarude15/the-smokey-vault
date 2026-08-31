/**
 * Admin-only enrichment review mutations: resolve conflicts, verify fields, re-run jobs.
 */
import { db } from "../../db.js";
import {
  CONFIDENCE,
  isUnresolvedField,
  type BottleCandidateFieldName,
  type FieldConflict,
  type ProductField
} from "../candidate/index.js";
import { buildBottleEnrichmentView, collectCacheConflicts } from "./enrichment-view.js";
import {
  applyFieldOverridesToCandidate,
  getFieldOverride,
  hasFieldOverride,
  isReviewableField,
  upsertFieldOverride,
  type OverrideAction,
  type ReviewableField
} from "./field-overrides.js";
import { candidateFromInventoryRow, loadInventoryRow } from "./inventory.js";
import { recordReviewAudit } from "./review-audit.js";
import {
  enqueueEnrichmentJob,
  enqueueImageJob,
  enqueueMetadataJob,
  enqueueTastingNotesJob,
  listJobsForEntity
} from "./store.js";
import {
  isEnrichmentEntityType,
  isEnrichmentJobType,
  type EnrichmentEntityType,
  type EnrichmentJob,
  type EnrichmentJobType
} from "./types.js";

export type ConflictChoice = "keep" | "accept";

/** Inventory column for a reviewable field, when the shelf table can store it. */
export function inventoryColumnForField(
  entityType: EnrichmentEntityType,
  fieldName: ReviewableField
): string | null {
  switch (fieldName) {
    case "name":
      return "name";
    case "brand":
      return entityType === "packaged_beer" ? "brewery" : entityType === "wines" ? "producer" : "brand";
    case "category":
      return entityType === "packaged_beer" ? "style" : entityType === "wines" ? "varietal" : "category";
    case "abv":
      return entityType === "wines" ? null : "abv";
    case "volume_ml":
      return entityType === "spirits" ? "volume_ml" : null;
    case "origin":
      return entityType === "wines" ? "region" : null;
    case "upc":
      return "upc";
    case "product_type":
    case "proof":
    case "ttb_id":
      return null;
    default:
      return null;
  }
}

function persistInventoryField(
  entityType: EnrichmentEntityType,
  entityId: number,
  fieldName: ReviewableField,
  value: string | number | null
): boolean {
  const column = inventoryColumnForField(entityType, fieldName);
  if (!column) return false;
  db.prepare(
    `UPDATE ${entityType} SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(value, entityId);
  return true;
}

function findConflictForField(
  entityType: EnrichmentEntityType,
  entityId: number,
  fieldName: ReviewableField
): FieldConflict | null {
  const row = loadInventoryRow(entityType, entityId);
  if (!row) return null;
  const conflicts = collectCacheConflicts(entityType, row).filter(
    (c) => !hasFieldOverride(entityType, entityId, c.field)
  );
  return conflicts.find((c) => c.field === fieldName) ?? null;
}

export class ReviewActionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function requireEntity(entityType: string, entityId: number): {
  entityType: EnrichmentEntityType;
  row: Record<string, unknown>;
} {
  if (!isEnrichmentEntityType(entityType)) {
    throw new ReviewActionError("Enrichment not available for this module", 404);
  }
  if (!Number.isFinite(entityId) || entityId <= 0) {
    throw new ReviewActionError("Invalid id", 400);
  }
  const row = loadInventoryRow(entityType, entityId);
  if (!row) throw new ReviewActionError("Item not found", 404);
  return { entityType, row };
}

/**
 * Resolve an identity conflict: keep current or accept competing.
 * Persists selection as user/VERY_HIGH override (+ inventory column when available).
 */
export function resolveFieldConflict(input: {
  entityType: string;
  entityId: number;
  field: string;
  choice: ConflictChoice;
}) {
  const { entityType, entityId } = { entityType: input.entityType, entityId: input.entityId };
  const loaded = requireEntity(entityType, entityId);
  if (!isReviewableField(input.field)) {
    throw new ReviewActionError("Field is not reviewable");
  }
  if (input.choice !== "keep" && input.choice !== "accept") {
    throw new ReviewActionError("choice must be keep or accept");
  }

  const conflict = findConflictForField(loaded.entityType, entityId, input.field);
  if (!conflict) {
    throw new ReviewActionError("No open conflict for that field", 404);
  }

  const kept = conflict.existing;
  const competing = conflict.incoming;
  const selected = input.choice === "keep" ? kept : competing;
  const action: OverrideAction = input.choice === "keep" ? "resolve_keep" : "resolve_accept";
  const selectedValue = selected.value as string | number | null;

  upsertFieldOverride({
    entityType: loaded.entityType,
    entityId,
    field: input.field,
    value: selectedValue,
    action,
    previousValue: kept.value as string | number | null,
    previousSource: kept.source,
    competingValue: competing.value as string | number | null,
    competingSource: competing.source
  });
  persistInventoryField(loaded.entityType, entityId, input.field, selectedValue);

  const audit = recordReviewAudit({
    entityType: loaded.entityType,
    entityId,
    action,
    field: input.field,
    oldValue: kept.value as string | number | null,
    newValue: selectedValue,
    detail: {
      choice: input.choice,
      keptSource: kept.source,
      competingSource: competing.source,
      confidence: CONFIDENCE.VERY_HIGH
    }
  });

  return {
    ok: true as const,
    field: input.field,
    choice: input.choice,
    value: selectedValue,
    source: "user" as const,
    confidence: CONFIDENCE.VERY_HIGH,
    auditId: audit.id,
    view: buildBottleEnrichmentView({ entityType: loaded.entityType, entityId })
  };
}

/**
 * Mark an existing field value as user-verified without changing the value.
 */
export function verifyEnrichmentField(input: {
  entityType: string;
  entityId: number;
  field: string;
}) {
  const loaded = requireEntity(input.entityType, input.entityId);
  if (!isReviewableField(input.field)) {
    throw new ReviewActionError("Field is not reviewable");
  }

  const candidate = applyFieldOverridesToCandidate(
    loaded.entityType,
    input.entityId,
    candidateFromInventoryRow(loaded.entityType, loaded.row)
  );
  const productField = candidate[input.field as BottleCandidateFieldName] as ProductField<unknown>;
  if (isUnresolvedField(productField)) {
    throw new ReviewActionError("Cannot verify a missing field");
  }

  const value = productField.value as string | number | null;
  upsertFieldOverride({
    entityType: loaded.entityType,
    entityId: input.entityId,
    field: input.field,
    value,
    action: "verify",
    previousValue: value,
    previousSource: productField.source
  });
  persistInventoryField(loaded.entityType, input.entityId, input.field, value);

  const audit = recordReviewAudit({
    entityType: loaded.entityType,
    entityId: input.entityId,
    action: "verify_field",
    field: input.field,
    oldValue: value,
    newValue: value,
    detail: {
      previousSource: productField.source,
      previousConfidence: productField.confidence,
      confidence: CONFIDENCE.VERY_HIGH
    }
  });

  return {
    ok: true as const,
    field: input.field,
    value,
    source: "user" as const,
    confidence: CONFIDENCE.VERY_HIGH,
    auditId: audit.id,
    view: buildBottleEnrichmentView({ entityType: loaded.entityType, entityId: input.entityId })
  };
}

/**
 * Admin re-run / retry enrichment. Bypasses one-shot maybeEnqueue gates.
 * Still dedupes active pending/running jobs. Returns immediately.
 */
export function rerunEnrichmentJob(input: {
  entityType: string;
  entityId: number;
  jobType: string;
}): {
  ok: true;
  created: boolean;
  job: EnrichmentJob;
  auditId: number;
  view: ReturnType<typeof buildBottleEnrichmentView>;
} {
  const loaded = requireEntity(input.entityType, input.entityId);
  if (!isEnrichmentJobType(input.jobType)) {
    throw new ReviewActionError("Unknown enrichment job type");
  }

  const upc = String(loaded.row.upc ?? "").trim();
  const prior = listJobsForEntity(loaded.entityType, input.entityId).find(
    (j) => j.job_type === input.jobType
  );
  const priorFailed = prior?.status === "failed";

  const enqueueInput = {
    entityType: loaded.entityType,
    entityId: input.entityId,
    upc
  };

  let result: { job: EnrichmentJob; created: boolean };
  if (input.jobType === "metadata") result = enqueueMetadataJob(enqueueInput);
  else if (input.jobType === "tasting_notes") result = enqueueTastingNotesJob(enqueueInput);
  else if (input.jobType === "image") result = enqueueImageJob(enqueueInput);
  else result = enqueueEnrichmentJob({ ...enqueueInput, jobType: input.jobType as EnrichmentJobType });

  const auditAction =
    priorFailed && result.created ? "retry_failed_job" : "rerun_enrichment";

  const audit = recordReviewAudit({
    entityType: loaded.entityType,
    entityId: input.entityId,
    action: auditAction,
    jobType: input.jobType as EnrichmentJobType,
    detail: {
      created: result.created,
      jobId: result.job.id,
      status: result.job.status,
      attempts: result.job.attempts,
      lastError: result.job.last_error
    }
  });

  return {
    ok: true,
    created: result.created,
    job: result.job,
    auditId: audit.id,
    view: buildBottleEnrichmentView({ entityType: loaded.entityType, entityId: input.entityId })
  };
}

/** Test helper: weaker enrichment cannot overwrite a user-verified field on the candidate. */
export function candidateWithOverrides(
  entityType: EnrichmentEntityType,
  entityId: number,
  row: Record<string, unknown>
) {
  return applyFieldOverridesToCandidate(
    entityType,
    entityId,
    candidateFromInventoryRow(entityType, row)
  );
}

export function getOverrideForTests(
  entityType: EnrichmentEntityType,
  entityId: number,
  fieldName: ReviewableField
) {
  return getFieldOverride(entityType, entityId, fieldName);
}
