export { searchWebSnippets } from "./web-search.js";
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
  TRUSTED_MIN,
  ENRICH_BELOW,
  IDENTITY_FIELDS,
  RECOMMENDED_FIELDS,
  OPTIONAL_CONTENT_FIELDS,
  type EnrichmentPlan,
  type EnrichmentTask,
  type EnrichmentField
} from "./enrichment/index.js";
