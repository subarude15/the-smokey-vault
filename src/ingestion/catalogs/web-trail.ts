import type { ProductSchema } from "../../cola_client.js";
import type { ImportKind, LookupResult } from "../../lookup-shared.js";
import { persistBeerHit } from "./beer-cache.js";
import { inferImportKind } from "./kind.js";
import { saveToCache } from "./cola-cache-store.js";
import { lookupOpenFoodFacts } from "./open-food-facts.js";
import { success, withLocalImage } from "./result.js";
import { lookupUpcItemDb } from "./upcitemdb.js";

export type OffCatalogFn = (upc: string) => Promise<ProductSchema | null>;
export type UpcItemDbCatalogFn = (upc: string) => Promise<ProductSchema | null>;

/** Open Food Facts, then upcitemdb — shared web trail after live liquor catalogs. */
export async function tryOffThenUpcitemdb(
  upc: string,
  catalogs: {
    searchOff?: OffCatalogFn;
    searchUpcItemDb?: UpcItemDbCatalogFn;
  },
  kindHint?: ImportKind
): Promise<LookupResult | null> {
  const beerKind = kindHint === "beer";
  try {
    const off = await (catalogs.searchOff ?? lookupOpenFoodFacts)(upc);
    if (off?.name.trim()) {
      const product = await withLocalImage(off);
      saveToCache(product, null, null, "openfoodfacts");
      if (beerKind) persistBeerHit(product, "openfoodfacts");
      return await success("openfoodfacts", upc, product, kindHint ?? inferImportKind(product));
    }
  } catch {
    // Continue to upcitemdb.
  }
  try {
    const item = await (catalogs.searchUpcItemDb ?? lookupUpcItemDb)(upc);
    if (item?.name.trim()) {
      const product = await withLocalImage(item);
      saveToCache(product, null, null, "upcitemdb");
      if (beerKind) persistBeerHit(product, "upcitemdb");
      return await success("upcitemdb", upc, product, kindHint ?? inferImportKind(product));
    }
  } catch {
    // Catalog miss.
  }
  return null;
}
