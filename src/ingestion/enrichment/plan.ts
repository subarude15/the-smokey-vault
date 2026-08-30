import type { BottleCandidate, BottleCandidateFieldName, FieldConflict, ProductField } from "../candidate/types.js";
import { isUnresolvedField, unresolvedFields } from "../candidate/index.js";
import {
  ENRICH_BELOW,
  IDENTITY_FIELDS,
  OPTIONAL_CONTENT_FIELDS,
  RECOMMENDED_FIELDS,
  TRUSTED_MIN,
  isIdentityField,
  priorityForField
} from "./rules.js";
import type {
  EnrichmentField,
  EnrichmentPlan,
  EnrichmentTask,
  PlanEnrichmentOptions
} from "./types.js";

function candidateField(
  candidate: BottleCandidate,
  name: BottleCandidateFieldName
): ProductField<unknown> {
  return candidate[name] as ProductField<unknown>;
}

function isTrusted(field: ProductField<unknown>): boolean {
  return !isUnresolvedField(field) && field.confidence >= TRUSTED_MIN;
}

function needsEnrichment(field: ProductField<unknown>): boolean {
  if (isUnresolvedField(field)) return true;
  return field.confidence < ENRICH_BELOW;
}

function reasonFor(field: EnrichmentField, productField: ProductField<unknown> | null): string {
  if (!productField || isUnresolvedField(productField)) {
    return `${field} is unresolved`;
  }
  if (productField.confidence < ENRICH_BELOW) {
    return `${field} is only ${productField.confidence} confidence from ${productField.source} (below ${ENRICH_BELOW})`;
  }
  return `${field} needs enrichment`;
}

function pushTask(tasks: EnrichmentTask[], field: EnrichmentField, productField: ProductField<unknown> | null) {
  if (tasks.some((task) => task.field === field)) return;
  tasks.push({
    field,
    priority: priorityForField(field),
    reason: reasonFor(field, productField)
  });
}

/**
 * Pure enrichment planner: BottleCandidate (+ optional merge conflicts) → EnrichmentPlan.
 * No HTTP, LLM, DB, or candidate mutation.
 */
export function planEnrichment(
  candidate: BottleCandidate,
  options: PlanEnrichmentOptions = {}
): EnrichmentPlan {
  const conflicts = options.conflicts ?? [];
  const tasks: EnrichmentTask[] = [];
  const unresolved = unresolvedFields(candidate);

  for (const name of IDENTITY_FIELDS) {
    const f = candidateField(candidate, name);
    if (needsEnrichment(f)) pushTask(tasks, name, f);
  }

  for (const name of RECOMMENDED_FIELDS) {
    const f = candidateField(candidate, name);
    if (needsEnrichment(f)) pushTask(tasks, name, f);
  }

  // Optional content is never on the candidate today — always unresolved, never required.
  for (const name of OPTIONAL_CONTENT_FIELDS) {
    pushTask(tasks, name, null);
  }

  const identified = IDENTITY_FIELDS.every((name) => isTrusted(candidateField(candidate, name)));

  const reviewConflicts = conflicts.filter((conflict) => {
    if (!isIdentityField(conflict.field)) return false;
    const existingTrusted = !isUnresolvedField(conflict.existing) && conflict.existing.confidence >= TRUSTED_MIN;
    const incomingTrusted = !isUnresolvedField(conflict.incoming) && conflict.incoming.confidence >= TRUSTED_MIN;
    return existingTrusted && incomingTrusted;
  });

  const needsReview = reviewConflicts.length > 0;

  // Stable task order: required → recommended → optional, then field name.
  const rank = { required: 0, recommended: 1, optional: 2 } as const;
  tasks.sort((a, b) => rank[a.priority] - rank[b.priority] || a.field.localeCompare(b.field));

  return {
    identified,
    needsReview,
    tasks,
    unresolvedCandidateFields: unresolved,
    reviewConflicts
  };
}
