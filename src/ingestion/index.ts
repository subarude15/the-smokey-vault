export { searchWebSnippets, searchWebHits, type WebSearchHit } from "./web-search.js";
export { labelProductWithLocalOllama, lookupProductFromRawText } from "./llm-enrichment.js";
export { parseProductSchema, inventoryRecordToProduct, smartWebQuery } from "./normalize.js";
export { runSmartFallback, type SmartFallbackDeps, type SmartFallbackQuery } from "./smart-fallback.js";
export {
  identifyByBarcode,
  identifyByBarcodeWithCandidate,
  identifyByLocalLabelImage,
  identifyWithSmartFallback,
  assembleVisionLabelResult,
  parseVisionLabel,
  type BottleOrchestratorDeps,
  type LabelIngestionResult,
  type BottleSearchHit,
  type LookupOptions,
  type LookupResult,
  type VisionLabel
} from "./bottle-orchestrator.js";

export {
  CONFIDENCE,
  SOURCE_CONFIDENCE,
  candidateFromLookup,
  candidateFromProduct,
  mergeCandidates,
  unresolvedFields,
  confidenceForSource,
  field,
  mergeField,
  type BottleCandidate,
  type ProductField,
  type ProductFieldSource
} from "./candidate/index.js";

export {
  planEnrichment,
  executeMetadataEnrichment,
  TRUSTED_MIN,
  ENRICH_BELOW,
  IDENTITY_FIELDS,
  RECOMMENDED_FIELDS,
  OPTIONAL_CONTENT_FIELDS,
  METADATA_ENRICHMENT_FIELDS,
  type EnrichmentPlan,
  type EnrichmentTask,
  type EnrichmentField,
  type EnrichmentExecutionResult
} from "./enrichment/index.js";

export {
  ensureEnrichmentJobsTable,
  enqueueMetadataJob,
  enqueueTastingNotesJob,
  enqueueImageJob,
  maybeEnqueueMetadataEnrichment,
  maybeEnqueueTastingNotesEnrichment,
  maybeEnqueueImageEnrichment,
  startEnrichmentWorker,
  stopEnrichmentWorker,
  enrichmentJobCounts,
  getProductContent,
  getProductImage,
  type EnrichmentJob,
  type EnrichmentJobCounts,
  type ProductContent,
  type ProductImageRecord
} from "./jobs/index.js";

export {
  executeTastingNotesEnrichment,
  executeImageEnrichment,
  classifySourceUrl,
  classifyImageSource,
  type TastingNotesEnrichmentDeps,
  type ImageEnrichmentDeps
} from "./enrichment/index.js";
