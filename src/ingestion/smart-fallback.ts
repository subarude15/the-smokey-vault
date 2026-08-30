import { looksLikeBarcode, normalizeUpc, type ProductSchema } from "../cola_client.js";
import { isReadyLookup } from "../lookup-shared.js";
import { lookupProduct, searchBottles, type BottleSearchHit, type LookupResult } from "../lookup.js";
import { lookupProductFromRawText } from "./llm-enrichment.js";
import { inventoryRecordToProduct, smartWebQuery } from "./normalize.js";
import { searchWebSnippets } from "./web-search.js";

export type SmartFallbackQuery = {
  upc?: string;
  name?: string;
};

export type SmartFallbackDeps = {
  lookupByUpc?: (upc: string) => Promise<LookupResult>;
  searchByName?: (name: string) => Promise<{ results: BottleSearchHit[] }>;
  searchWeb?: (query: string, limit?: number) => Promise<string>;
  extractFromText?: (rawText: string) => Promise<ProductSchema>;
};

/**
 * Catalog-first product lookup with a SearXNG + local llama3.1 fallback when
 * vault/cache/FWGS/COLA/OFF miss. Returns null when nothing usable is found.
 */
export async function runSmartFallback(
  query: SmartFallbackQuery,
  deps: SmartFallbackDeps = {}
): Promise<ProductSchema | null> {
  const upc = String(query.upc ?? "").trim();
  const name = String(query.name ?? "").trim();
  if (!upc && !name) return null;

  const lookupByUpc = deps.lookupByUpc ?? ((code: string) => lookupProduct(code, { mode: "live" }));
  const searchByName = deps.searchByName ?? ((q: string) => searchBottles(q));
  const searchWeb = deps.searchWeb ?? searchWebSnippets;
  const extractFromText = deps.extractFromText ?? lookupProductFromRawText;

  if (upc && looksLikeBarcode(upc)) {
    try {
      const result = await lookupByUpc(upc);
      if (isReadyLookup(result) && result.product) {
        return inventoryRecordToProduct(result.product as Record<string, unknown>, result.upc || upc);
      }
    } catch {
      // Fall through to name search / web scrape.
    }
  }

  if (name) {
    try {
      const { results } = await searchByName(name);
      const hit = results.find((row) => String(row.product?.name ?? "").trim());
      if (hit?.product) return inventoryRecordToProduct(hit.product as Record<string, unknown>, upc);
    } catch {
      // Fall through to web scrape.
    }
  }

  const snippets = await searchWeb(smartWebQuery({ upc, name }));
  if (!snippets.trim()) return null;

  try {
    const product = await extractFromText(snippets);
    if (!String(product.name ?? "").trim()) return null;
    if (upc && !product.upc) {
      product.upc = normalizeUpc(upc) || product.upc;
    }
    return product;
  } catch {
    return null;
  }
}
