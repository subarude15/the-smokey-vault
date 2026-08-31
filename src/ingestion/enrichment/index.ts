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
  metadataSearchQuery,
  type EnrichmentExecutionResult,
  type EnrichmentExecutionError,
  type MetadataEnrichmentDeps
} from "./execute-metadata.js";

export {
  extractMetadataFromWebText,
  type MetadataExtractRequest,
  type MetadataExtractResult
} from "./metadata-extract.js";

export {
  classifySourceUrl,
  classifyHit,
  isAuthoritativeSource,
  formatAuthoritativeSnippets,
  type SourceClass,
  type ClassifiedHit
} from "./tasting-notes-sources.js";

export {
  extractOfficialTastingNotes,
  generateHouseTastingProfile,
  formatHouseProfile,
  parseOfficialNotesExtract,
  parseHouseProfile,
  type OfficialNotesExtractResult,
  type HouseProfileResult
} from "./tasting-notes-extract.js";

export {
  executeTastingNotesEnrichment,
  type TastingNotesEnrichmentDeps,
  type TastingNotesExecutionResult
} from "./execute-tasting-notes.js";

export {
  IMAGE_MIN_WIDTH,
  IMAGE_MIN_HEIGHT,
  IMAGE_LARGE_MIN,
  IMAGE_MAX_ASPECT_RATIO,
  IMAGE_SCORE,
  IMAGE_ACCEPTANCE_THRESHOLD,
  IMAGE_VISION_CANDIDATE_FLOOR,
  IMAGE_MAX_VISION_CHECKS
} from "./image-thresholds.js";

export {
  classifyImageSource,
  isAcceptableImageSource,
  type ImageSourceType
} from "./image-sources.js";

export {
  hardRejectCandidate,
  scoreImageCandidateBase,
  applyVisionScoreAdjustments,
  evaluateCandidate,
  meetsAcceptanceThreshold,
  type ImageCandidate,
  type VisionVerification,
  type ScoredImageCandidate
} from "./image-score.js";

export {
  verifyProductImage,
  parseVisionVerification,
  buildImageVerifyPrompt
} from "./image-verify.js";

export {
  executeImageEnrichment,
  searchImageHits,
  type ImageEnrichmentDeps,
  type ImageEnrichmentResult,
  type ImageCandidateSeed,
  type ImageMeta
} from "./execute-images.js";
