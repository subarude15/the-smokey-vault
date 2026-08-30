/**
 * Enrichment planner types — pure decisions over BottleCandidate.
 * No HTTP / LLM / DB side effects.
 */

import type { BottleCandidateFieldName, FieldConflict } from "../candidate/types.js";

export const ENRICHMENT_PRIORITIES = ["required", "recommended", "optional"] as const;
export type EnrichmentPriority = (typeof ENRICHMENT_PRIORITIES)[number];

/**
 * Planner field ids. Includes candidate fields plus optional content
 * (tasting_notes, image) that are not stored on BottleCandidate yet.
 */
export const ENRICHMENT_FIELDS = [
  "upc",
  "name",
  "brand",
  "product_type",
  "category",
  "abv",
  "proof",
  "volume_ml",
  "origin",
  "ttb_id",
  "tasting_notes",
  "image"
] as const;

export type EnrichmentField = (typeof ENRICHMENT_FIELDS)[number];

export type EnrichmentTask = {
  field: EnrichmentField;
  priority: EnrichmentPriority;
  reason: string;
};

export type EnrichmentPlan = {
  /** True when identity fields are present at trusted confidence. */
  identified: boolean;
  /** True when trusted sources disagree on an identity field. */
  needsReview: boolean;
  tasks: EnrichmentTask[];
  /** Echo of unresolved candidate fields (excludes tasting_notes/image). */
  unresolvedCandidateFields: BottleCandidateFieldName[];
  /** Conflicts that triggered needsReview (identity only). */
  reviewConflicts: FieldConflict[];
};

export type PlanEnrichmentOptions = {
  /** Conflicts from mergeCandidates / mergeField — planner does not invent them. */
  conflicts?: FieldConflict[];
};
