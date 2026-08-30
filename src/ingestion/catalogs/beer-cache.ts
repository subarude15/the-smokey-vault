import {
  beerCacheToProduct,
  getBeerCacheEntry,
  saveBeerCacheEntry,
  type BeerCacheSource
} from "../../beer_cache.js";
import type { ProductSchema } from "../../cola_client.js";

/** Packaged-beer barcode memory (source chip: beer_cache). */
export function tryBeerCache(upc: string, rawUpc: string): ProductSchema | null {
  const beerCached = getBeerCacheEntry(upc) ?? getBeerCacheEntry(rawUpc);
  if (!beerCached) return null;
  return beerCacheToProduct(beerCached);
}

export function persistBeerHit(
  product: ProductSchema,
  source: BeerCacheSource | string,
  extra?: { catalog_beer_id?: string | null; untappd_bid?: string | null }
) {
  if (!product.upc || !String(product.name ?? "").trim()) return;
  saveBeerCacheEntry({
    upc: product.upc,
    catalog_beer_id: extra?.catalog_beer_id ?? null,
    untappd_bid: extra?.untappd_bid ?? null,
    brewery: product.brand,
    name: product.name,
    style: product.category,
    abv: product.abv,
    image_url: product.image_url,
    source
  });
}
