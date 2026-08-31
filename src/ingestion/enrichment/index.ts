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
  buildMetadataSearchQueries,
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
  hostLooksLikeBrandDomain,
  formatAuthoritativeSnippets,
  type SourceClass,
  type ClassifiedHit
} from "./tasting-notes-sources.js";

export {
  discoverOfficialDomains,
  classifySourceUrlWithDiscovery,
  registeredDomain,
  hostMatchesDiscoveredDomain,
  type OfficialDomainDiscovery
} from "./official-domain.js";

export {
  buildOfficialProductPageQueries,
  extractExpressionTokensFromHits,
  hasOfficialProductDetailHit,
  hostIsUnderOfficialDomain,
  isGenericOfficialPageUrl,
  isProductDetailPageUrl,
  safeOfficialPageDisplay,
  scoreOfficialProductPage,
  selectBestOfficialProductPage,
  type OfficialPageHit,
  type OfficialProductPageScoreBreakdown
} from "./official-product-page.js";

export {
  buildMetadataQueryTiers,
  buildImageQueryTiers,
  extractSearchTokens,
  searchAliasesForToken,
  queryQuotesEntireName,
  brandCoreToken,
  identityFromCandidate,
  type SearchQueryTier,
  type SearchIdentityInput
} from "./search-query.js";

export {
  extractStructuredProductFacts,
  fetchBoundedPageHtml,
  type StructuredProductFacts
} from "./page-extract.js";

export {
  extractOfficialPageImgCandidates,
  extractOfficialPageImgCandidatesAsync,
  extractCssBackgroundUrls,
  isLikelyPageDecoration,
  looksLikeClientRenderedShell,
  parseSrcsetUrls,
  type OfficialPageImgCandidate,
  type OfficialPageImgScanResult,
  type OfficialPageImageDiagnostic
} from "./official-page-images.js";

export {
  sanitizeJobDiagnostics,
  friendlyDiagnosticSummary,
  boundUrls,
  type JobDiagnosticsPayload,
  type EnrichmentDiagnosticStage,
  type NoResultReason,
  type FieldRejectReason
} from "./diagnostics.js";

export {
  checkEnrichmentHealth,
  checkSearxngHealth,
  checkOllamaHealth,
  ollamaBaseUrl,
  ollamaSafeHost,
  type EnrichmentHealthReport,
  type ServiceHealthResult,
  type ServiceHealthStatus,
  type EnrichmentHealthDeps
} from "./health.js";

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
  primaryVisionRejectionReason,
  type ImageCandidate,
  type VisionVerification,
  type ScoredImageCandidate
} from "./image-score.js";

export {
  verifyProductImage,
  parseVisionVerification,
  buildImageVerifyPrompt,
  identityContextForVision
} from "./image-verify.js";

export {
  buildImageScoreComponents,
  buildImageCandidateDiagnostic,
  collectImageRejectionReasons,
  checkVerificationDiagnosticConsistency,
  safeImageUrlParts,
  sumScoreComponents,
  formatImageRejectionReason,
  normalizeImageUrlForDedupe,
  mergeImageSeedsByNormalizedUrl,
  preferStrongerImageSeed,
  prioritizeImageCandidateDiagnostics,
  summarizeImageCandidateDiagnostics,
  imageCandidateIdFromUrl,
  isNonImageAssetUrl,
  isVerificationStageDiagnostic,
  orderSeedsForProbe,
  ImageCandidateDiagnosticStore,
  MAX_IMAGE_CANDIDATE_DIAGNOSTICS,
  type ImageCandidateDiagnostic,
  type ImageCandidateStageReached,
  type ImageScoreComponents
} from "./image-candidate-diagnostics.js";

export { readImageDimensionsFromHeader } from "./image-dimensions.js";

export {
  executeImageEnrichment,
  searchImageHits,
  extractProductImageUrlsFromHtml,
  type ImageEnrichmentDeps,
  type ImageEnrichmentResult,
  type ImageCandidateSeed,
  type ImageMeta
} from "./execute-images.js";
