/**
 * Bottle / product ingestion orchestration.
 *
 * Current call paths (preserved; this module is the composition root):
 *
 * 1. Barcode scan — GET /api/scan/upc/:code | /api/lookup/:code | /api/lookup/barcode
 *    → identifyByBarcode → lookupProduct
 *    Order inside lookupProduct: invalid → vault → barcode_cache → beer_cache
 *    → cola_cache → (mixers miss) → FWGS → COLA → OFF → upcitemdb → (beer: COLA last)
 *    → miss reason
 *    Stage modules: src/ingestion/catalogs/{vault,barcode-cache,beer-cache,cola-cache,fwgs,cola,open-food-facts,upcitemdb}
 *
 * 2. Overnight import — import_queue job → identifyByBarcode (mode: batch)
 *
 * 3. Local Ollama label — POST /api/scan/label
 *    → identifyByLocalLabelImage → labelProductWithLocalOllama → optional Catalog.beer
 *
 * 4. Cloud AI vision — POST /api/ai/vision-label | import-queue/:id/label
 *    → server callLlm + parseVisionLabel → assembleVisionLabelResult
 *
 * 5. Smart fallback — identifyWithSmartFallback
 *    → barcode/catalog lookup → name search → SearXNG → local llama3.1 text extract
 *
 * Internal (not HTTP): identifyByBarcodeWithCandidate wraps (1) with BottleCandidate
 * field provenance for later enrichment. See src/ingestion/candidate/.
 * Enrichment planning (pure): planEnrichment(candidate) → EnrichmentPlan — see
 * src/ingestion/enrichment/. Metadata execution: executeMetadataEnrichment
 * (abv/proof/volume/origin/ttb_id only; no tasting notes/images yet).
 *
 * Individual responsibilities stay in their modules (lookup, vision_label, cola_client,
 * barcode_cache, fwgs, catalog_beer, ai_providers). This file only sequences them.
 */
import type { ProductSchema } from "../cola_client.js";
import {
  lookupProduct,
  searchCatalogBeerSuggestions,
  type BottleSearchHit,
  type LookupOptions,
  type LookupResult
} from "../lookup.js";
import { parseVisionLabel, type VisionLabel, VISION_LABEL_PROMPT } from "../vision_label.js";
import { callLlm } from "../ai_client.js";
import { runSmartFallback, type SmartFallbackDeps, type SmartFallbackQuery } from "./smart-fallback.js";
import { candidateFromLookup, type BottleCandidate } from "./candidate/index.js";

export type LabelIngestionResult = {
  source: "label";
  upc?: string;
  product: ProductSchema | (VisionLabel & { image_url: string });
  suggestions: Awaited<ReturnType<typeof searchCatalogBeerSuggestions>>;
};

export type BottleOrchestratorDeps = {
  lookupByBarcode?: (code: string, options?: LookupOptions) => Promise<LookupResult>;
  identifyVisionLabel?: (imageBase64: string) => Promise<VisionLabel>;
  catalogBeerSuggestions?: (query: string, limit?: number) => Promise<LabelIngestionResult["suggestions"]>;
  smartFallback?: (query: SmartFallbackQuery, deps?: SmartFallbackDeps) => Promise<ProductSchema | null>;
};

async function defaultIdentifyVisionLabel(imageBase64: string): Promise<VisionLabel> {
  const image = imageBase64.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "").trim();
  if (!image) throw new Error("Image required");
  const content = await callLlm(VISION_LABEL_PROMPT, image);
  return parseVisionLabel(content);
}

const defaultDeps: Required<BottleOrchestratorDeps> = {
  lookupByBarcode: lookupProduct,
  identifyVisionLabel: defaultIdentifyVisionLabel,
  catalogBeerSuggestions: searchCatalogBeerSuggestions,
  smartFallback: runSmartFallback
};

function resolveDeps(overrides: BottleOrchestratorDeps = {}): Required<BottleOrchestratorDeps> {
  return { ...defaultDeps, ...overrides };
}

/** Live or batch barcode identification — same LookupResult shape as today. */
export async function identifyByBarcode(
  code: string,
  options: LookupOptions = {},
  deps: BottleOrchestratorDeps = {}
): Promise<LookupResult> {
  return resolveDeps(deps).lookupByBarcode(code, options);
}

/**
 * Same as identifyByBarcode, plus an internal BottleCandidate for provenance.
 * Public LookupResult is unchanged; candidate is not persisted or returned by HTTP routes yet.
 */
export async function identifyByBarcodeWithCandidate(
  code: string,
  options: LookupOptions = {},
  deps: BottleOrchestratorDeps = {}
): Promise<{ result: LookupResult; candidate: BottleCandidate }> {
  const result = await identifyByBarcode(code, options, deps);
  return { result, candidate: candidateFromLookup(result) };
}

/**
 * Local Ollama vision label path used by POST /api/scan/label.
 * Response shape matches the existing route body.
 */
export async function identifyByLocalLabelImage(
  imageBase64: string,
  deps: BottleOrchestratorDeps = {}
): Promise<LabelIngestionResult> {
  const resolved = resolveDeps(deps);
  const parsed = await resolved.identifyVisionLabel(imageBase64);
  return assembleVisionLabelResult(parsed, "", deps);
}

/**
 * After cloud LLM vision parse (+ optional saved image URL), attach Catalog.beer
 * suggestions the same way the multipart vision routes do today.
 */
export async function assembleVisionLabelResult(
  parsed: VisionLabel,
  imageUrl = "",
  deps: BottleOrchestratorDeps = {}
): Promise<LabelIngestionResult> {
  const resolved = resolveDeps(deps);
  const product = { ...parsed, image_url: imageUrl };
  const suggestions = parsed.product_type === "beer"
    ? await resolved.catalogBeerSuggestions(`${parsed.brand} ${parsed.name}`.trim(), 5)
    : [];
  return {
    source: "label",
    upc: parsed.upc || undefined,
    product,
    suggestions
  };
}

/** Catalog-first lookup with SearXNG + local llama3.1 when catalogs miss. */
export async function identifyWithSmartFallback(
  query: SmartFallbackQuery,
  smartDeps: SmartFallbackDeps = {},
  deps: BottleOrchestratorDeps = {}
): Promise<ProductSchema | null> {
  return resolveDeps(deps).smartFallback(query, smartDeps);
}

export { parseVisionLabel };
export type { BottleSearchHit, LookupOptions, LookupResult, SmartFallbackDeps, SmartFallbackQuery, VisionLabel };
