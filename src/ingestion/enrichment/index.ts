/**
 * Deterministic enrichment planning over BottleCandidate.
 * Does not perform searches, LLM calls, downloads, or persistence.
 */
export {
  ENRICHMENT_FIELDS,
  ENRICHMENT_PRIORITIES,
  type EnrichmentField,
  type EnrichmentPlan,
  type EnrichmentPriority,
  type EnrichmentTask,
  type PlanEnrichmentOptions
} from "./types.js";

export {
  ENRICH_BELOW,
  IDENTITY_FIELDS,
  OPTIONAL_CONTENT_FIELDS,
  RECOMMENDED_FIELDS,
  TRUSTED_MIN,
  isIdentityField,
  priorityForField
} from "./rules.js";

export { planEnrichment } from "./plan.js";
