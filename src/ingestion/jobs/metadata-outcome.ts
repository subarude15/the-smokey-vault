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
import type { JobDiagnosticsPayload } from "../enrichment/diagnostics.js";

export type MetadataJobResultPayload = {
  requested: string[];
  updated: string[];
  unresolved: string[];
  /** Keeper/admin diagnostics — never secrets/prompts. */
  diagnostics?: JobDiagnosticsPayload | null;
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
      unresolved: Array.isArray(parsed.unresolved) ? parsed.unresolved.map(String) : [],
      diagnostics: parsed.diagnostics ?? null
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

  // Completed job — inspect bottle gaps and stored progress.
  const stored = parseMetadataJobResult(
    getLatestCompletedJobResult(entityType, entityId, "metadata")
  );
  if (!gaps.length) return "complete";

  // Bottle completeness is independent of the latest run's update count.
  // A bottle with meaningful metadata (beyond shelf-default volume) and remaining
  // gaps stays Partial even when a rerun finds nothing new (updated=[]).
  // Empty bottles with empty reruns stay No result.
  const meaningfulPopulated = METADATA_ENRICHMENT_FIELDS.filter((name) => {
    if (name === "volume_ml") return false;
    return !fieldNeedsWork(candidate[name] as ProductField<unknown>);
  }).length;
  if (meaningfulPopulated > 0) return "partial";

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

/**
 * Wording for the most recent completed metadata *run*, distinct from bottle completeness.
 * A search that found nothing new is not an overall metadata failure when the bottle is Partial.
 */
export function metadataLastRunLabel(options: {
  bottleOutcome: MetadataOutcomeLabel;
  stored: MetadataJobResultPayload | null;
  jobFailed?: boolean;
}): string | null {
  if (options.jobFailed) return "Failed";
  const stored = options.stored;
  if (!stored) return null;
  if (stored.updated.length > 0) {
    const n = stored.updated.length;
    return `Updated ${n} field${n === 1 ? "" : "s"}`;
  }
  // Successful completion with zero new fields.
  if (options.bottleOutcome === "partial" || options.bottleOutcome === "complete") {
    return "No new data found";
  }
  return "No result";
}

export function buildMetadataJobResultPayload(options: {
  requested: string[];
  before: BottleCandidate;
  after: BottleCandidate;
  inventoryUpdated: string[];
  diagnostics?: JobDiagnosticsPayload | null;
}): MetadataJobResultPayload {
  const { requested, before, after, inventoryUpdated, diagnostics } = options;
  const updated = new Set<string>(inventoryUpdated.filter((name) => name !== "sub_category"));
  // Map inventory column aliases back to enrichment field names.
  if (inventoryUpdated.includes("region")) updated.add("origin");
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

  // Final unresolved MUST come from the post-persist/post-reload candidate.
  // A field that is present & trusted on the final bottle cannot stay unresolved.
  const unresolved = unresolvedMetadataFields(after)
    .map(String)
    .filter((name) => !updated.has(name));

  const nextDiagnostics = diagnostics
    ? {
        ...diagnostics,
        unresolved,
        accepted: [...new Set([...(diagnostics.accepted ?? []), ...updated])],
        summary: rebuildMetadataDiagnosticSummary([...updated], unresolved, diagnostics.summary)
      }
    : null;
  if (nextDiagnostics && updated.size > 0) {
    nextDiagnostics.noResultReason = null;
  }

  return {
    requested: [...requested],
    updated: [...updated],
    unresolved,
    diagnostics: nextDiagnostics
  };
}

/** Keeper summary from final updated/unresolved — never lists an updated field as still missing. */
export function rebuildMetadataDiagnosticSummary(
  updated: string[],
  unresolved: string[],
  previousSummary?: string | null
): string | null {
  if (updated.length > 0) {
    if (!unresolved.length) return "Metadata fields filled";
    return `Updated ${updated.join(", ")}; still missing ${unresolved.join(", ")}`;
  }
  if (previousSummary?.trim()) return previousSummary.trim();
  if (unresolved.length) return `Still missing ${unresolved.join(", ")}`;
  return previousSummary ?? null;
}
