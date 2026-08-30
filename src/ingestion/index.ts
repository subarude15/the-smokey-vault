export { searchWebSnippets } from "./web-search.js";
export { labelProductWithLocalOllama, lookupProductFromRawText } from "./llm-enrichment.js";
export { parseProductSchema, inventoryRecordToProduct, smartWebQuery } from "./normalize.js";
export { runSmartFallback, type SmartFallbackDeps, type SmartFallbackQuery } from "./smart-fallback.js";
export {
  identifyByBarcode,
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
