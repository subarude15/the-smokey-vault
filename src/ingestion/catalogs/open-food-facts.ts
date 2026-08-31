import type { ProductSchema } from "../../cola_client.js";
import { normalizeCanonicalAbv, normalizeCanonicalTaxonomy, stripPackageTokensFromName } from "../../canonical-normalize.js";

export function mapOffToSchema(upc: string, offProduct: Record<string, unknown>): ProductSchema {
  const nutriments = (offProduct.nutriments as Record<string, unknown> | undefined) ?? {};
  const abvRaw = offProduct.abv ?? offProduct.alcohol_100g ?? nutriments.alcohol_100g;
  const parsedAbv = typeof abvRaw === "number" ? Math.round(abvRaw * 10) / 10 : Number.parseFloat(String(abvRaw ?? ""));
  const abv = normalizeCanonicalAbv(Number.isFinite(parsedAbv) ? parsedAbv : null);
  const nameRaw = String(offProduct.product_name || offProduct.product_name_en || offProduct.generic_name || "Unknown");
  const brand = String(offProduct.brands || offProduct.brand || "");
  const categoryRaw = String(offProduct.categories || offProduct.category || "").split(",")[0]?.trim() || "";
  const tax = normalizeCanonicalTaxonomy(categoryRaw, "");
  return {
    upc,
    name: stripPackageTokensFromName(nameRaw) || nameRaw,
    brand,
    category: tax.family || (tax.discardedJunk ? "" : categoryRaw) || "Mixer",
    abv,
    image_url: String(offProduct.image_front_url || offProduct.image_url || "") || null,
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

export async function lookupOpenFoodFacts(upc: string): Promise<ProductSchema | null> {
  const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(upc)}.json`, {
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) return null;
  const data = await response.json() as { status: number; product?: Record<string, unknown> };
  if (!data.status || !data.product) return null;
  return mapOffToSchema(upc, data.product);
}

export async function searchOpenFoodFactsByQuery(query: string, limit = 8): Promise<ProductSchema[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  try {
    const params = new URLSearchParams({
      search_terms: q,
      search_simple: "1",
      action: "process",
      json: "1",
      page_size: String(Math.min(limit, 20)),
      fields: "code,product_name,brands,categories,image_front_url,abv,alcohol_100g,nutriments"
    });
    const response = await fetch(`https://world.openfoodfacts.org/cgi/search.pl?${params}`, {
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) return [];
    const data = await response.json() as { products?: Array<Record<string, unknown>> };
    return (data.products ?? [])
      .filter((product) => {
        const cats = String(product.categories ?? "").toLowerCase();
        const name = String(product.product_name ?? "").toLowerCase();
        return /beer|ale|lager|cider|beverage|seltzer/.test(cats)
          || /beer|ale|lager|ipa|stout|porter|cider|seltzer/.test(name);
      })
      .slice(0, limit)
      .map((product) => mapOffToSchema(String(product.code ?? ""), product));
  } catch {
    return [];
  }
}
