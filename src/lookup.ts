import { db } from "./db.js";
import {
  barcodeVariants,
  CACHE_TTL_SECONDS,
  ColaDetail,
  ColaSummary,
  ColaQuotaError,
  ean13Form,
  fetchColaQuota,
  getColaDetail,
  getLastQuota,
  isColaConfigured,
  isColaPaused,
  looksLikeBarcode,
  mapColaToSchema,
  normalizeUpc,
  primaryCatalogUpc,
  ProductSchema,
  productToInventoryFields,
  searchByBarcode,
  searchColasByQuery,
  upcAForm
} from "./cola_client.js";
import { localizeImage } from "./images.js";
import { barcodeEntryToProduct, getBarcodeCacheEntry, searchBarcodeCache } from "./barcode_cache.js";
import { fwgsToSchema, isFwgsThin, searchFwgs, searchFwgsByQuery, type FwgsProduct } from "./fwgs.js";
import { hasExplicitProductType, inferProductTable, isSpiritInventoryFamily, spiritFamilyFromLabel } from "./catalog.js";
import {
  missMessage,
  type ImportKind,
  type LookupResult,
  type LookupSource,
  type MissReason
} from "./lookup-shared.js";

export type { LookupResult, LookupSource } from "./lookup-shared.js";
export {
  isReadyLookup,
  LOOKUP_SOURCE_LABELS,
  LOOKUP_SOURCES,
  MISS_REASON_LABELS,
  MISS_REASONS,
  missMessage
} from "./lookup-shared.js";

export type BottleSearchHit = {
  source: "vault" | "cola_cloud" | "cache" | "fwgs" | "openfoodfacts";
  table: "spirits" | "packaged_beer" | "wines" | "brews";
  ttb_id?: string | null;
  product: Record<string, unknown>;
};

export type SearchTable = BottleSearchHit["table"];

export type LookupCatalogs = {
  searchFwgs?: (upc: string) => Promise<FwgsProduct | null>;
  searchCola?: (upc: string, waitOnBurst?: boolean) => Promise<ColaSummary | null>;
  searchOff?: (upc: string) => Promise<ProductSchema | null>;
  searchUpcItemDb?: (upc: string) => Promise<ProductSchema | null>;
};

export type LookupOptions = {
  forceRefresh?: boolean;
  kind?: ImportKind;
  mode?: "live" | "batch";
  catalogs?: LookupCatalogs;
};

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
  if (!String(row.name ?? "").trim()) return null;
  const age = Math.floor(Date.now() / 1000) - Number(row.cached_at ?? 0);
  if (!allowStale && age > CACHE_TTL_SECONDS) return null;
  return cacheRowToProduct(row);
}

export function rememberUnresolvedUpc(rawUpc: string) {
  const upc = normalizeUpc(rawUpc);
  if (!upc) return;
  const existing = db.prepare("SELECT name FROM cola_cache WHERE upc = ?").get(upc) as { name?: string } | undefined;
  if (String(existing?.name ?? "").trim()) return;
  saveToCache({
    upc,
    name: "",
    brand: "",
    category: "",
    abv: null,
    image_url: null,
    fill_level_percent: 100,
    bottle_count: 1,
    notes: null,
    volume_ml: null,
    product_type: null,
    ttb_id: null,
    origin: null,
    approval_date: null
  }, null, null, "pending");
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

function inferTable(product: ProductSchema | Record<string, unknown>): NonNullable<LookupResult["table"]> {
  return inferProductTable(product as Record<string, unknown>);
}

export function inferImportKind(
  product: ProductSchema | Record<string, unknown> | null | undefined,
  hint?: ImportKind
): ImportKind {
  if (!product) return hint ?? "spirits";
  const record = product as Record<string, unknown>;
  const table = inferProductTable(record);
  const category = String(record.category ?? record.categories ?? "");
  const subCategory = String(record.sub_category ?? record.subcategory ?? "");
  const family = spiritFamilyFromLabel(category, subCategory).family;

  if (hasExplicitProductType(record) || isSpiritInventoryFamily(family)) {
    if (table === "packaged_beer") return "beer";
    if (table === "wines") return "wines";
    if (family === "Mixer" || family === "Bitters" || /mixer|bitter/i.test(category)) return "mixers";
    return "spirits";
  }

  if (hint) return hint;

  if (table === "packaged_beer") return "beer";
  if (table === "wines") return "wines";
  if (family === "Mixer" || family === "Bitters" || /mixer|bitter/i.test(category)) return "mixers";
  return "spirits";
}

function tableForKind(kind: ImportKind): NonNullable<LookupResult["table"]> {
  if (kind === "beer") return "packaged_beer";
  if (kind === "wines") return "wines";
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

async function searchOpenFoodFactsByQuery(query: string, limit = 8): Promise<ProductSchema[]> {
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

function variantsFor(upc: string): LookupResult["variants"] {
  const upcA = upcAForm(upc);
  const ean13 = ean13Form(upc);
  if (!upcA && !ean13) return undefined;
  return { upcA: upcA || upc, ean13: ean13 || upc };
}

function placeholderProduct(upc: string) {
  return {
    upc,
    name: "",
    brand: "",
    category: "Spirits",
    abv: 0,
    image_url: "",
    notes: "",
    fill_level: 100,
    stock_count: 1,
    volume_ml: 750
  };
}

async function success(
  source: LookupSource,
  upc: string,
  product: ProductSchema,
  kindHint?: ImportKind
): Promise<LookupResult> {
  const localized = await withLocalImage(product);
  const kind = inferImportKind(localized, kindHint);
  return {
    source,
    upc,
    table: tableForKind(kind),
    kind,
    product: productToInventoryFields(localized),
    quota: getLastQuota() ?? undefined,
    variants: variantsFor(upc)
  };
}

function miss(
  reason: MissReason,
  upc: string,
  kind?: ImportKind,
  extra?: { raw?: string }
): LookupResult {
  const display = upc || extra?.raw || "";
  return {
    source: "not_found",
    upc: display,
    table: kind ? tableForKind(kind) : undefined,
    kind,
    product: placeholderProduct(display),
    reason,
    message: missMessage(reason, display, variantsFor(display)),
    quota: getLastQuota() ?? undefined,
    variants: variantsFor(display)
  };
}

function rawDigitLength(raw: string) {
  return String(raw ?? "").replace(/\D/g, "").length;
}

function formatAmbiguous(raw: string) {
  const length = rawDigitLength(raw);
  return length === 6 || length === 7 || length === 8 || (length >= 9 && length <= 11);
}

async function tryOffThenUpcitemdb(
  upc: string,
  catalogs: LookupCatalogs,
  kindHint?: ImportKind
): Promise<LookupResult | null> {
  try {
    const off = await (catalogs.searchOff ?? lookupOpenFoodFacts)(upc);
    if (off?.name.trim()) {
      const product = await withLocalImage(off);
      saveToCache(product, null, null, "openfoodfacts");
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
      return await success("upcitemdb", upc, product, kindHint ?? inferImportKind(product));
    }
  } catch {
    // Catalog miss.
  }
  return null;
}

export async function lookupProduct(rawUpc: string, options: LookupOptions = {}): Promise<LookupResult> {
  const { forceRefresh = false, kind: kindHint, mode = "live", catalogs = {} } = options;
  const waitOnBurst = mode === "batch";

  if (!looksLikeBarcode(rawUpc)) {
    return miss("invalid", rawUpc, kindHint);
  }

  const upc = primaryCatalogUpc(rawUpc);
  if (!upc) {
    return miss("invalid", rawUpc, kindHint);
  }

  const vaultHit = findInVault(upc, rawUpc);
  if (vaultHit) {
    const kind = inferImportKind(vaultHit.product, kindHint);
    return {
      source: "vault",
      table: vaultHit.table,
      kind,
      upc,
      product: vaultHit.product,
      quota: getLastQuota() ?? undefined,
      variants: variantsFor(upc)
    };
  }

  if (!forceRefresh) {
    const remembered = getBarcodeCacheEntry(upc) ?? getBarcodeCacheEntry(rawUpc);
    if (remembered) return await success("cache", upc, barcodeEntryToProduct(remembered), kindHint);
  }

  let staleFallback: ProductSchema | null = null;
  if (!forceRefresh) {
    const cached = getFromCache(upc);
    if (cached) {
      const cacheMeta = db.prepare("SELECT source FROM cola_cache WHERE upc = ?").get(upc) as { source?: string } | undefined;
      const cacheSource = String(cacheMeta?.source ?? "");
      if (cacheSource === "cola_cloud" || cacheSource === "fwgs" || !isColaConfigured()) {
        return await success("cache", upc, cached, kindHint);
      }
      staleFallback = cached;
    }
  }

  const kind = kindHint ?? "spirits";
  const skipCatalogs = kind === "mixers";
  const beerPath = kind === "beer";
  let quotaHit = isColaPaused();
  let colaQueried = false;
  let colaFound = false;

  if (skipCatalogs) {
    rememberUnresolvedUpc(upc);
    return miss("no_catalog", upc, "mixers");
  }

  const colaClient = catalogs.searchCola
    ?? ((code: string, wait?: boolean) => searchByBarcode(code, { waitOnBurst: wait }));
  const colaEnabled = Boolean(catalogs.searchCola) || (isColaConfigured() && !isColaPaused());

  if (!beerPath) {
    try {
      const fwgsHit = await (catalogs.searchFwgs ?? searchFwgs)(upc);
      if (fwgsHit?.name.trim()) {
        let product = fwgsToSchema(upc, fwgsHit);
        if (isFwgsThin(fwgsHit) && colaEnabled) {
          try {
            colaQueried = true;
            const summary = await colaClient(upc, waitOnBurst);
            if (summary) {
              colaFound = true;
              const colaProduct = mapColaToSchema(upc, summary);
              product = {
                ...product,
                brand: product.brand || colaProduct.brand,
                category: colaProduct.category || product.category,
                volume_ml: product.volume_ml ?? colaProduct.volume_ml,
                product_type: colaProduct.product_type ?? product.product_type,
                ttb_id: colaProduct.ttb_id,
                origin: colaProduct.origin ?? product.origin,
                approval_date: colaProduct.approval_date ?? product.approval_date,
                notes: [product.notes, colaProduct.notes].filter(Boolean).join(" | ") || product.notes
              };
            }
          } catch (error) {
            if (error instanceof ColaQuotaError) quotaHit = true;
          }
        }
        const localized = await withLocalImage(product);
        saveToCache(localized, null, null, "fwgs");
        return await success("fwgs", upc, localized, inferImportKind(localized, kindHint));
      }
    } catch {
      // FWGS is parse-resilient; a thrown error still falls through.
    }

    if (colaEnabled) {
      try {
        colaQueried = true;
        const summary = await colaClient(upc, waitOnBurst);
        if (summary && (summary.product_name || summary.brand_name)) {
          colaFound = true;
          const product = await withLocalImage(mapColaToSchema(upc, summary));
          saveToCache(product, summary, null, "cola_cloud");
          return await success("cola_cloud", upc, product, kindHint);
        }
      } catch (error) {
        if (error instanceof ColaQuotaError) quotaHit = true;
      }
    } else if (isColaConfigured() && isColaPaused()) {
      quotaHit = true;
    }
  }

  if (staleFallback) return await success("cache", upc, staleFallback, kindHint);

  const webHit = await tryOffThenUpcitemdb(upc, catalogs, beerPath ? "beer" : kindHint);
  if (webHit) return webHit;

  rememberUnresolvedUpc(upc);
  if (quotaHit) return miss("quota", upc, kindHint);
  if (formatAmbiguous(rawUpc)) return miss("variant", upc, kindHint, { raw: rawUpc });
  if (!beerPath && colaQueried && !colaFound) return miss("cola_gap", upc, kindHint);
  return miss("no_catalog", upc, beerPath ? "beer" : kindHint);
}

export async function enrichColaRecord(ttbId: string, upc = ""): Promise<LookupResult> {
  const detail = await getColaDetail(ttbId);
  if (!detail) {
    return miss("cola_gap", upc);
  }
  const product = await withLocalImage(mapColaToSchema(upc || detail.barcodes?.[0]?.barcode_value || "", detail, detail));
  if (product.upc) saveToCache(product, detail, detail, "cola_cloud");
  return await success("cola_cloud", product.upc || upc, product);
}

function findInVault(upc: string, rawUpc: string): { table: NonNullable<LookupResult["table"]>; product: Record<string, unknown> } | null {
  const candidates = [...new Set([upc, rawUpc, ...barcodeVariants(upc), ...barcodeVariants(rawUpc)].filter((value) => value))];
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
  "style", "varietal", "region", "upc", "brewery_batch", "batch_name", "hops", "flavors"
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
  const moduleTable = searchTableForModule(options?.table);

  const results: BottleSearchHit[] = searchVault(q, vaultTables);
  const seen = new Set(results.map(hitKey));

  const addHit = (hit: BottleSearchHit) => {
    if (moduleTable && hit.table !== moduleTable) return;
    const key = hitKey(hit);
    if (seen.has(key)) return;
    seen.add(key);
    results.push(hit);
  };

  for (const entry of searchBarcodeCache(q, 8)) {
    const product = barcodeEntryToProduct(entry);
    addHit({
      source: "cache",
      table: inferProductTable({ ...product, product_type: entry.category }),
      product: productToInventoryFields(product)
    });
  }

  const runFwgs = !moduleTable || moduleTable === "spirits" || moduleTable === "wines";
  const runOff = !moduleTable || moduleTable === "packaged_beer";

  if (runFwgs) {
    try {
      for (const fwgsHit of await searchFwgsByQuery(q, 6)) {
        const product = fwgsToSchema("", fwgsHit);
        addHit({
          source: "fwgs",
          table: inferProductTable(product),
          product: productToInventoryFields(product)
        });
      }
    } catch {
      // FWGS markup drift should not block other catalogs.
    }
  }

  if (runOff) {
    try {
      for (const off of await searchOpenFoodFactsByQuery(q, 8)) {
        addHit({
          source: "openfoodfacts",
          table: inferProductTable(off),
          product: productToInventoryFields(off)
        });
      }
    } catch {
      // Open Food Facts timeouts should not block local results.
    }
  }

  if (isColaConfigured() && !isColaPaused()) {
    try {
      const colaQuery = queryTokens(q).join(" ") || q;
      const summaries = await searchColasByQuery(
        colaQuery,
        10,
        moduleTable ? { productType: colaProductTypeForTable(moduleTable) } : undefined
      );
      for (const summary of summaries) {
        const product = productToInventoryFields(mapColaToSchema(summary.ttb_id || "", summary));
        addHit({
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

function hitKey(hit: BottleSearchHit) {
  return foldSearch(`${hit.product.name ?? ""}|${hit.product.brand ?? hit.product.brewery ?? hit.product.producer ?? ""}`);
}

export { fetchColaQuota };
