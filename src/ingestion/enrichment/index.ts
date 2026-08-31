/**
 * Deterministic enrichment planning over BottleCandidate.
 * Metadata executor fills recommended factual fields only (no tasting notes / images).
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

export {
  METADATA_ENRICHMENT_FIELDS,
  isMetadataEnrichmentField,
  proofFromAbv,
  abvFromProof,
  type MetadataEnrichmentField
} from "./metadata-fields.js";

export {
  executeMetadataEnrichment,
  type EnrichmentExecutionResult,
  type EnrichmentExecutionError,
  type MetadataEnrichmentDeps
} from "./execute-metadata.js";

export {
  extractMetadataFromWebText,
  type MetadataExtractRequest,
  type MetadataExtractResult
} from "./metadata-extract.js";
