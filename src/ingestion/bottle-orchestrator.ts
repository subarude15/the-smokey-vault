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
import { parseVisionLabel, type VisionLabel } from "../vision_label.js";
import { labelProductWithLocalOllama } from "./llm-enrichment.js";
import { runSmartFallback, type SmartFallbackDeps, type SmartFallbackQuery } from "./smart-fallback.js";

export type LabelIngestionResult = {
  source: "label";
  upc?: string;
  product: ProductSchema | (VisionLabel & { image_url: string });
  suggestions: Awaited<ReturnType<typeof searchCatalogBeerSuggestions>>;
};

export type BottleOrchestratorDeps = {
  lookupByBarcode?: (code: string, options?: LookupOptions) => Promise<LookupResult>;
  labelWithLocalOllama?: (imageBase64: string) => Promise<ProductSchema>;
  catalogBeerSuggestions?: (query: string, limit?: number) => Promise<LabelIngestionResult["suggestions"]>;
  smartFallback?: (query: SmartFallbackQuery, deps?: SmartFallbackDeps) => Promise<ProductSchema | null>;
};

const defaultDeps: Required<BottleOrchestratorDeps> = {
  lookupByBarcode: lookupProduct,
  labelWithLocalOllama: labelProductWithLocalOllama,
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
 * Local Ollama vision label path used by POST /api/scan/label.
 * Response shape matches the existing route body.
 */
export async function identifyByLocalLabelImage(
  imageBase64: string,
  deps: BottleOrchestratorDeps = {}
): Promise<LabelIngestionResult> {
  const resolved = resolveDeps(deps);
  const product = await resolved.labelWithLocalOllama(imageBase64);
  const suggestions = product.product_type === "beer"
    ? await resolved.catalogBeerSuggestions(`${product.brand} ${product.name}`.trim(), 5)
    : [];
  return {
    source: "label",
    upc: product.upc || undefined,
    product,
    suggestions
  };
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
