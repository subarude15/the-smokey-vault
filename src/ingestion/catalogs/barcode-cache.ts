import { barcodeEntryToProduct, getBarcodeCacheEntry } from "../../barcode_cache.js";
import type { ProductSchema } from "../../cola_client.js";

/** Persistent unresolved/resolved barcode memory (source chip: cache). */
export function tryBarcodeCache(upc: string, rawUpc: string): ProductSchema | null {
  const remembered = getBarcodeCacheEntry(upc) ?? getBarcodeCacheEntry(rawUpc);
  if (!remembered) return null;
  return barcodeEntryToProduct(remembered);
}
