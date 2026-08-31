/**
 * Metadata job outcome is distinct from job lifecycle status.
 * A completed job is not automatically a successful enrichment.
 */
import { isUnresolvedField, type BottleCandidate, type ProductField } from "../candidate/index.js";
import { METADATA_ENRICHMENT_FIELDS, type MetadataEnrichmentField } from "../enrichment/metadata-fields.js";
import { TRUSTED_MIN } from "../enrichment/rules.js";
import { hasActiveEnrichmentJob, hasCompletedJob, hasFailedJob, getLatestCompletedJobResult } from "./store.js";
import {
  hasPersistableMetadataWork,
  hasRecommendedMetadataWork
} from "./inventory.js";
import type { EnrichmentEntityType } from "./types.js";

export type MetadataJobResultPayload = {
  requested: string[];
  updated: string[];
  unresolved: string[];
};

/** User-facing / availability labels for metadata enrichment. */
export type MetadataOutcomeLabel =
  | "complete"
  | "partial"
  | "no_result"
  | "missing"
  | "active"
  | "failed";

function fieldNeedsWork(f: ProductField<unknown>): boolean {
  return isUnresolvedField(f) || f.confidence < TRUSTED_MIN;
}

/** Recommended metadata gaps still open on the candidate. */
export function unresolvedMetadataFields(candidate: BottleCandidate): MetadataEnrichmentField[] {
  return METADATA_ENRICHMENT_FIELDS.filter((name) =>
    fieldNeedsWork(candidate[name] as ProductField<unknown>)
  );
}

export function parseMetadataJobResult(raw: string | null | undefined): MetadataJobResultPayload | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MetadataJobResultPayload>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      requested: Array.isArray(parsed.requested) ? parsed.requested.map(String) : [],
      updated: Array.isArray(parsed.updated) ? parsed.updated.map(String) : [],
      unresolved: Array.isArray(parsed.unresolved) ? parsed.unresolved.map(String) : []
    };
  } catch {
    return null;
  }
}

/**
 * Derive metadata outcome from candidate gaps + optional stored job result.
 * Never treats job.status===completed alone as success.
 */
export function metadataOutcomeFromState(options: {
  candidate: BottleCandidate;
  entityType: EnrichmentEntityType;
  entityId: number;
}): MetadataOutcomeLabel {
  const { candidate, entityType, entityId } = options;
  if (hasActiveEnrichmentJob(entityType, entityId, "metadata")) return "active";

  const gaps = unresolvedMetadataFields(candidate);
  const needsPersistable = hasPersistableMetadataWork(candidate, entityType);
  const needsRecommended = hasRecommendedMetadataWork(candidate);

  if (!needsPersistable && !needsRecommended) return "complete";

  if (hasFailedJob(entityType, entityId, "metadata") && gaps.length > 0) {
    return "failed";
  }

  if (!hasCompletedJob(entityType, entityId, "metadata")) {
    return gaps.length ? "missing" : "complete";
  }

  // Completed job — inspect stored progress when present.
  const stored = parseMetadataJobResult(
    getLatestCompletedJobResult(entityType, entityId, "metadata")
  );
  if (!gaps.length) return "complete";
  if (stored && stored.updated.length > 0) return "partial";
  if (stored && stored.updated.length === 0) return "no_result";
  // Legacy completed jobs without result payload: gaps remain ⇒ not Complete.
  return "no_result";
}

/** Map outcome → job statusLabel used by EnrichmentPanel. */
export function metadataOutcomeToJobStatusLabel(
  outcome: MetadataOutcomeLabel
): "complete" | "partial" | "no_result" | "failed" | "in_progress" | "waiting" | "not_started" {
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
      return "in_progress";
    case "missing":
      return "not_started";
    default:
      return "not_started";
  }
}

export function buildMetadataJobResultPayload(options: {
  requested: string[];
  before: BottleCandidate;
  after: BottleCandidate;
  inventoryUpdated: string[];
}): MetadataJobResultPayload {
  const { requested, before, after, inventoryUpdated } = options;
  const updated = new Set<string>(inventoryUpdated);
  for (const name of requested) {
    const fieldName = name as MetadataEnrichmentField;
    if (!METADATA_ENRICHMENT_FIELDS.includes(fieldName)) continue;
    const prev = before[fieldName] as ProductField<unknown>;
    const next = after[fieldName] as ProductField<unknown>;
    if (isUnresolvedField(prev) && !isUnresolvedField(next)) updated.add(name);
    else if (
      !isUnresolvedField(next)
      && (prev.value !== next.value || prev.confidence < next.confidence)
    ) {
      updated.add(name);
    }
  }
  const unresolved = unresolvedMetadataFields(after).map(String);
  return {
    requested: [...requested],
    updated: [...updated],
    unresolved
  };
}
