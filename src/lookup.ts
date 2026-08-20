import { db } from "./db.js";
import {
  CACHE_TTL_SECONDS,
  ColaDetail,
  ColaSummary,
  fetchColaQuota,
  getColaDetail,
  getLastQuota,
  isColaConfigured,
  mapColaToSchema,
  normalizeUpc,
  ProductSchema,
  productToInventoryFields,
  searchByBarcode,
  searchColasByQuery
} from "./cola_client.js";
import { localizeImage } from "./images.js";

export type LookupSource = "vault" | "cache" | "cola_cloud" | "openfoodfacts" | "upcitemdb" | "not_found";

export type LookupResult = {
  source: LookupSource;
  upc: string;
  table?: "spirits" | "packaged_beer" | "wines";
  product: Record<string, unknown> | null;
  message?: string;
  quota?: ReturnType<typeof getLastQuota>;
};

export type BottleSearchHit = {
  source: "vault" | "cola_cloud";
  table: "spirits" | "packaged_beer" | "wines";
  ttb_id?: string | null;
  product: Record<string, unknown>;
};

type CacheRow = {
  upc: string;
  name: string;
  brand: string;
  category: string | null;
  abv: number | null;
  image_url: string | null;
  fill_level_percent: number;
  bottle_count: number;
  notes: string | null;
  volume_ml: number | null;
  product_type: string | null;
  ttb_id: string | null;
  origin: string | null;
  approval_date: string | null;
  cached_at: number;
  source: string;
};

export function ensureColaCacheTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cola_cache (
      upc TEXT PRIMARY KEY,
      name TEXT,
      brand TEXT,
      category TEXT,
      abv REAL,
      image_url TEXT,
      fill_level_percent INTEGER DEFAULT 100,
      bottle_count INTEGER DEFAULT 1,
      notes TEXT,
      volume_ml REAL,
      product_type TEXT,
      ttb_id TEXT,
      origin TEXT,
      approval_date TEXT,
      cached_at INTEGER,
      source TEXT DEFAULT 'cola_cloud'
    );
  `);
}

ensureColaCacheTable();

function cacheRowToProduct(row: CacheRow): ProductSchema {
  return {
    upc: row.upc,
    name: row.name,
    brand: row.brand ?? "",
    category: row.category || "Spirits",
    abv: row.abv,
    image_url: row.image_url,
    fill_level_percent: row.fill_level_percent ?? 100,
    bottle_count: row.bottle_count ?? 1,
    notes: row.notes,
    volume_ml: row.volume_ml,
    product_type: row.product_type,
    ttb_id: row.ttb_id,
    origin: row.origin,
    approval_date: row.approval_date
  };
}

export function getFromCache(upc: string, { allowStale = false } = {}): ProductSchema | null {
  const row = db.prepare("SELECT * FROM cola_cache WHERE upc = ?").get(upc) as CacheRow | undefined;
  if (!row) return null;
  const age = Math.floor(Date.now() / 1000) - Number(row.cached_at ?? 0);
  if (!allowStale && age > CACHE_TTL_SECONDS) return null;
  return cacheRowToProduct(row);
}

export function saveToCache(
  product: ProductSchema,
  summary?: ColaSummary | null,
  detail?: ColaDetail | null,
  source = "cola_cloud"
) {
  db.prepare(`
    INSERT INTO cola_cache (
      upc, name, brand, category, abv, image_url, fill_level_percent, bottle_count,
      notes, volume_ml, product_type, ttb_id, origin, approval_date, cached_at, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(upc) DO UPDATE SET
      name=excluded.name, brand=excluded.brand, category=excluded.category, abv=excluded.abv,
      image_url=excluded.image_url, fill_level_percent=excluded.fill_level_percent,
      bottle_count=excluded.bottle_count, notes=excluded.notes, volume_ml=excluded.volume_ml,
      product_type=excluded.product_type, ttb_id=excluded.ttb_id, origin=excluded.origin,
      approval_date=excluded.approval_date, cached_at=excluded.cached_at, source=excluded.source
  `).run(
    product.upc,
    product.name,
    product.brand,
    product.category,
    product.abv,
    product.image_url,
    product.fill_level_percent,
    product.bottle_count,
    product.notes,
    product.volume_ml,
    product.product_type ?? summary?.product_type ?? null,
    product.ttb_id ?? summary?.ttb_id ?? detail?.ttb_id ?? null,
    product.origin ?? summary?.origin_name ?? detail?.origin_name ?? null,
    product.approval_date ?? summary?.approval_date ?? null,
    Math.floor(Date.now() / 1000),
    source
  );
}

function inferTable(product: ProductSchema | Record<string, unknown>): "spirits" | "packaged_beer" | "wines" {
  const record = product as Record<string, unknown>;
  const type = String(record.product_type ?? "").toUpperCase();
  const category = String(record.category ?? record.categories ?? "");
  if (/MALT|BEER|ALE|LAGER|STOUT|PORTER|IPA|CIDER|SELTZER/i.test(`${type} ${category}`)) return "packaged_beer";
  if (/WINE|SPARKLING|VERMOUTH|SAKE|MEAD/i.test(`${type} ${category}`)) return "wines";
  return "spirits";
}

async function withLocalImage(product: ProductSchema): Promise<ProductSchema> {
  const local = await localizeImage(product.image_url);
  if (!local || local === product.image_url) return product;
  return { ...product, image_url: local };
}

function mapOffToSchema(upc: string, offProduct: Record<string, unknown>): ProductSchema {
  const nutriments = (offProduct.nutriments as Record<string, unknown> | undefined) ?? {};
  const abvRaw = offProduct.abv ?? offProduct.alcohol_100g ?? nutriments.alcohol_100g;
  const abv = typeof abvRaw === "number" ? Math.round(abvRaw * 10) / 10 : Number.parseFloat(String(abvRaw ?? "")) || null;
  const name = String(offProduct.product_name || offProduct.product_name_en || offProduct.generic_name || "Unknown");
  const brand = String(offProduct.brands || offProduct.brand || "");
  const category = String(offProduct.categories || offProduct.category || "Mixer").split(",")[0]?.trim() || "Mixer";
  return {
    upc,
    name,
    brand,
    category,
    abv: Number.isFinite(abv as number) ? abv : null,
    image_url: String(offProduct.image_front_url || offProduct.image_url || "") || null,
    fill_level_percent: 100,
    bottle_count: 1,
    notes: null,
    volume_ml: null,
    product_type: null,
    ttb_id: null,
    origin: null,
    approval_date: null
  };
}

async function lookupOpenFoodFacts(upc: string): Promise<ProductSchema | null> {
  const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(upc)}.json`, {
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) return null;
  const data = await response.json() as { status: number; product?: Record<string, unknown> };
  if (!data.status || !data.product) return null;
  return mapOffToSchema(upc, data.product);
}

async function lookupUpcItemDb(upc: string): Promise<ProductSchema | null> {
  const response = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`, {
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) return null;
  const data = await response.json() as { items?: Array<{ title?: string; brand?: string; category?: string; images?: string[] }> };
  const item = data.items?.[0];
  if (!item?.title) return null;
  return {
    upc,
    name: item.title,
    brand: item.brand ?? "",
    category: item.category ?? "Mixer",
    abv: null,
    image_url: item.images?.[0] ?? null,
    fill_level_percent: 100,
    bottle_count: 1,
    notes: null,
    volume_ml: null,
    product_type: null,
    ttb_id: null,
    origin: null,
    approval_date: null
  };
}

async function success(source: LookupSource, upc: string, product: ProductSchema, table?: LookupResult["table"]): Promise<LookupResult> {
  const localized = await withLocalImage(product);
  return {
    source,
    upc,
    table: table ?? inferTable(localized),
    product: productToInventoryFields(localized),
    quota: getLastQuota()
  };
}

export async function lookupProduct(
  rawUpc: string,
  { enrich = true, forceRefresh = false }: { enrich?: boolean; forceRefresh?: boolean } = {}
): Promise<LookupResult> {
  const upc = normalizeUpc(rawUpc);
  if (!upc) {
    return { source: "not_found", upc: rawUpc, product: null, message: "Invalid barcode." };
  }

  const spirit = db.prepare("SELECT * FROM spirits WHERE upc=? OR upc=?").get(upc, rawUpc);
  if (spirit) return { source: "vault", table: "spirits", upc, product: spirit as Record<string, unknown>, quota: getLastQuota() };

  const beer = db.prepare("SELECT * FROM packaged_beer WHERE upc=? OR upc=?").get(upc, rawUpc);
  if (beer) return { source: "vault", table: "packaged_beer", upc, product: beer as Record<string, unknown>, quota: getLastQuota() };

  let staleFallback: ProductSchema | null = null;
  if (!forceRefresh) {
    const cached = getFromCache(upc);
    if (cached) {
      const cacheMeta = db.prepare("SELECT source FROM cola_cache WHERE upc = ?").get(upc) as { source?: string } | undefined;
      const fromCola = cacheMeta?.source === "cola_cloud";
      if (fromCola || !isColaConfigured()) return await success("cache", upc, cached);
      staleFallback = cached;
    }
  }

  if (isColaConfigured()) {
    try {
      const summary = await searchByBarcode(upc);
      if (summary) {
        let detail: ColaDetail | null = null;
        if (enrich && summary.ttb_id) {
          try {
            detail = await getColaDetail(summary.ttb_id);
          } catch {
            detail = null;
          }
        }
        const product = await withLocalImage(mapColaToSchema(upc, summary, detail));
        saveToCache(product, summary, detail, "cola_cloud");
        return await success("cola_cloud", upc, product);
      }
    } catch {
      // Fall through to Open Food Facts when COLA is unavailable.
    }
  }

  if (staleFallback) return await success("cache", upc, staleFallback);

  try {
    const off = await lookupOpenFoodFacts(upc);
    if (off) {
      const product = await withLocalImage(off);
      saveToCache(product, null, null, "open_food_facts");
      return await success("openfoodfacts", upc, product);
    }
  } catch {
    // Continue to upcitemdb.
  }

  try {
    const item = await lookupUpcItemDb(upc);
    if (item) {
      const product = await withLocalImage(item);
      saveToCache(product, null, null, "upcitemdb");
      return await success("upcitemdb", upc, product);
    }
  } catch {
    // Not found.
  }

  return {
    source: "not_found",
    upc,
    product: {
      upc,
      name: "",
      brand: "",
      category: "Mixer",
      abv: 0,
      image_url: "",
      notes: "",
      fill_level: 100,
      stock_count: 1,
      volume_ml: 750
    },
    message: `No catalog match for UPC ${upc}. Add details manually or search by name.`,
    quota: getLastQuota()
  };
}

export async function enrichColaRecord(ttbId: string, upc = ""): Promise<LookupResult> {
  const detail = await getColaDetail(ttbId);
  if (!detail) {
    return { source: "not_found", upc, product: null, message: "COLA record not found." };
  }
  const product = await withLocalImage(mapColaToSchema(upc || detail.barcodes?.[0]?.barcode_value || "", detail, detail));
  if (product.upc) saveToCache(product, detail, detail, "cola_cloud");
  return await success("cola_cloud", product.upc || upc, product);
}

function searchVault(query: string): BottleSearchHit[] {
  const like = `%${query}%`;
  const spirits = db.prepare(`
    SELECT * FROM spirits
    WHERE name LIKE ? OR brand LIKE ? OR category LIKE ? OR upc LIKE ?
    ORDER BY name LIMIT 8
  `).all(like, like, like, like) as Record<string, unknown>[];
  const beers = db.prepare(`
    SELECT * FROM packaged_beer
    WHERE name LIKE ? OR brewery LIKE ? OR style LIKE ? OR upc LIKE ?
    ORDER BY name LIMIT 5
  `).all(like, like, like, like) as Record<string, unknown>[];
  const wines = db.prepare(`
    SELECT * FROM wines
    WHERE name LIKE ? OR producer LIKE ? OR varietal LIKE ? OR region LIKE ?
    ORDER BY name LIMIT 5
  `).all(like, like, like, like) as Record<string, unknown>[];

  return [
    ...spirits.map((product) => ({ source: "vault" as const, table: "spirits" as const, product })),
    ...beers.map((product) => ({ source: "vault" as const, table: "packaged_beer" as const, product })),
    ...wines.map((product) => ({ source: "vault" as const, table: "wines" as const, product }))
  ];
}

export async function searchBottles(query: string): Promise<{ results: BottleSearchHit[]; quota?: ReturnType<typeof getLastQuota> }> {
  const q = query.trim();
  if (q.length < 2) return { results: [] };

  const results = searchVault(q);

  if (isColaConfigured()) {
    try {
      const summaries = await searchColasByQuery(q, 10);
      for (const summary of summaries) {
        const product = productToInventoryFields(mapColaToSchema(summary.ttb_id || "", summary));
        results.push({
          source: "cola_cloud",
          table: inferTable({ ...product, product_type: summary.product_type }),
          ttb_id: summary.ttb_id ?? null,
          product
        });
      }
    } catch {
      // Local vault results are still useful when COLA is down.
    }
  }

  return { results: results.slice(0, 20), quota: getLastQuota() };
}

export { fetchColaQuota };
