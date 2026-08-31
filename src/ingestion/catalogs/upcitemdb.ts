import type { ProductSchema } from "../../cola_client.js";
import {
  normalizeCanonicalTaxonomy,
  stripPackageTokensFromName
} from "../../canonical-normalize.js";

export async function lookupUpcItemDb(upc: string): Promise<ProductSchema | null> {
  const response = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`, {
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) return null;
  const data = await response.json() as { items?: Array<{ title?: string; brand?: string; category?: string; images?: string[] }> };
  const item = data.items?.[0];
  if (!item?.title) return null;
  const tax = normalizeCanonicalTaxonomy(item.category ?? "", "");
  const nameRaw = item.title;
  return {
    upc,
    name: stripPackageTokensFromName(nameRaw) || nameRaw,
    brand: item.brand ?? "",
    category: tax.family || "",
    abv: null,
    image_url: item.images?.[0] ?? null,
    fill_level_percent: 100,
    bottle_count: 1,
    notes: null,
    volume_ml: null,
    product_type: tax.productType,
    ttb_id: null,
    origin: null,
    approval_date: null
  };
}
