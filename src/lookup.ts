import { db } from "./db.js";
import {
  barcodeVariants,
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
  table: "spirits" | "packaged_beer" | "wines" | "brews";
  ttb_id?: string | null;
  product: Record<string, unknown>;
};

export type SearchTable = BottleSearchHit["table"];

export function searchTableForModule(moduleId?: string): SearchTable | undefined {
  if (moduleId === "taps" || moduleId === "brews" || moduleId === "packaged_beer") return "packaged_beer";
  if (moduleId === "wines" || moduleId === "spirits") return moduleId;
  return undefined;
}

export function searchTablesForModule(moduleId?: string): SearchTable[] | undefined {
  if (moduleId === "taps") return ["brews", "packaged_beer"];
  const table = searchTableForModule(moduleId);
  return table ? [table] : undefined;
}

export function colaProductTypeForTable(table: SearchTable) {
  if (table === "packaged_beer" || table === "brews") return "malt beverage";
  if (table === "wines") return "wine";
  return "distilled spirits";
}

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

  const vaultHit = findInVault(upc, rawUpc);
  if (vaultHit) {
    return { source: "vault", table: vaultHit.table, upc, product: vaultHit.product, quota: getLastQuota() };
  }

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

function findInVault(upc: string, rawUpc: string): { table: NonNullable<LookupResult["table"]>; product: Record<string, unknown> } | null {
  const candidates = [...new Set([upc, rawUpc, ...barcodeVariants(upc)].filter((value) => value))];
  if (!candidates.length) return null;
  const placeholders = candidates.map(() => "?").join(",");
  for (const table of ["spirits", "packaged_beer", "wines"] as const) {
    const row = db.prepare(`SELECT * FROM ${table} WHERE upc IN (${placeholders}) AND upc != '' LIMIT 1`).get(...candidates) as Record<string, unknown> | undefined;
    if (row) return { table, product: row };
  }
  return null;
}

const SEARCH_FIELDS = [
  "name", "brand", "brewery", "producer", "maker", "category", "sub_category",
  "style", "varietal", "region", "upc", "brewery_batch", "batch_name"
] as const;

export function foldSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .toLowerCase();
}

export function queryTokens(query: string) {
  return foldSearch(query).split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}

export function haystackFor(row: Record<string, unknown>) {
  return foldSearch(SEARCH_FIELDS.map((key) => String(row[key] ?? "")).filter(Boolean).join(" "));
}

export function matchesQuery(row: Record<string, unknown>, query: string) {
  const tokens = queryTokens(query);
  if (!tokens.length) return false;
  const hay = haystackFor(row);
  return tokens.every((token) => hay.includes(token));
}

function scoreHit(row: Record<string, unknown>, tokens: string[]) {
  const name = foldSearch(String(row.name ?? row.brewery_batch ?? row.batch_name ?? ""));
  const brand = foldSearch(String(row.brand ?? row.brewery ?? row.producer ?? row.maker ?? ""));
  let score = 0;
  if (tokens.every((token) => name.includes(token))) score += 8;
  if (tokens[0] && name.split(/[^a-z0-9]+/).some((part) => part.startsWith(tokens[0]))) score += 4;
  if (tokens[0] && brand.split(/[^a-z0-9]+/).some((part) => part.startsWith(tokens[0]))) score += 3;
  const status = String(row.status ?? "");
  if (status === "Ready to Keg") score += 5;
  if (status === "Conditioning") score += 2;
  if (status === "Archived") score -= 2;
  return score;
}

function productForSearch(table: SearchTable, row: Record<string, unknown>): Record<string, unknown> {
  if (table !== "brews") return row;
  return {
    ...row,
    name: row.batch_name ?? row.name,
    brewery: row.maker ?? row.brewery,
    abv: row.calculated_abv ?? row.abv
  };
}

export function searchVault(query: string, table?: SearchTable | SearchTable[]): BottleSearchHit[] {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  const tables: SearchTable[] = table
    ? (Array.isArray(table) ? table : [table])
    : ["spirits", "packaged_beer", "wines"];
  const limits: Record<SearchTable, number> = {
    spirits: table ? 16 : 12,
    packaged_beer: table ? 16 : 8,
    wines: table ? 16 : 8,
    brews: 16
  };
  const hits: Array<BottleSearchHit & { score: number }> = [];
  for (const next of tables) {
    const rows = db.prepare(`SELECT * FROM ${next}`).all() as Record<string, unknown>[];
    hits.push(
      ...rows.filter((row) => matchesQuery(row, query))
        .map((row) => ({
          source: "vault" as const,
          table: next,
          product: productForSearch(next, row),
          score: scoreHit(row, tokens)
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limits[next])
    );
  }
  return hits.sort((a, b) => b.score - a.score).map((hit) => ({
    source: hit.source,
    table: hit.table,
    product: hit.product
  }));
}

export async function searchBottles(query: string, options?: { table?: string }): Promise<{ results: BottleSearchHit[]; quota?: ReturnType<typeof getLastQuota> }> {
  const q = query.trim();
  if (q.length < 2) return { results: [] };
  const vaultTables = searchTablesForModule(options?.table);
  const colaTable = searchTableForModule(options?.table);

  const results = searchVault(q, vaultTables);
  const seen = new Set(results.map(hitKey));

  if (isColaConfigured()) {
    try {
      const colaQuery = queryTokens(q).join(" ") || q;
      const summaries = await searchColasByQuery(colaQuery, 10, colaTable ? { productType: colaProductTypeForTable(colaTable) } : undefined);
      for (const summary of summaries) {
        const product = productToInventoryFields(mapColaToSchema(summary.ttb_id || "", summary));
        const hit: BottleSearchHit = {
          source: "cola_cloud",
          table: inferTable({ ...product, product_type: summary.product_type }),
          ttb_id: summary.ttb_id ?? null,
          product
        };
        if (colaTable && hit.table !== colaTable) continue;
        const key = hitKey(hit);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(hit);
      }
    } catch {
      // Local vault results are still useful when COLA is down.
    }
  }

  return { results: results.slice(0, 20), quota: getLastQuota() };
}

function hitKey(hit: BottleSearchHit) {
  return foldSearch(`${hit.product.name ?? ""}|${hit.product.brand ?? hit.product.brewery ?? hit.product.producer ?? ""}`);
}

export { fetchColaQuota };
