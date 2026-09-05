import { db } from "./db.js";
import {
  ColaSummary,
  fetchColaQuota,
  getLastQuota,
  isColaConfigured,
  isColaPaused,
  looksLikeBarcode,
  mapColaToSchema,
  normalizeUpc,
  primaryCatalogUpc,
  ProductSchema,
  productToInventoryFields,
  searchColasByQuery
} from "./cola_client.js";
import { barcodeEntryToProduct, searchBarcodeCache } from "./barcode_cache.js";
import {
  beerCacheHitKey,
  beerCacheToInventoryFields,
  saveBeerCacheEntry,
  searchBeerCache
} from "./beer_cache.js";
import {
  catalogBeerToInventoryFields,
  isCatalogBeerConfigured,
  isCatalogBeerQuotaExhausted,
  searchCatalogBeers
} from "./catalog_beer.js";
import { enrichFromUntappdPage } from "./untappd_scrape.js";
import { fwgsToSchema, searchFwgsByQuery, type FwgsProduct } from "./fwgs.js";
import { inferProductTable } from "./catalog.js";
import {
  type ImportKind,
  type LookupResult
} from "./lookup-shared.js";
import type { SmartFallbackDeps, SmartFallbackQuery } from "./ingestion/smart-fallback.js";
import {
  findInVault,
  formatAmbiguous,
  inferImportKind,
  inferTable,
  miss,
  persistBeerHit,
  rememberUnresolvedUpc,
  resolveColaCache,
  resolveColaClient,
  searchOpenFoodFactsByQuery,
  success,
  tryBarcodeCache,
  tryGovernmentStage,
  tryBeerCache,
  tryBeerColaStage,
  tryFwgsStage,
  tryOffThenUpcitemdb,
  trySpiritsColaStage,
  variantsFor
} from "./ingestion/catalogs/index.js";

export type { LookupResult, LookupSource } from "./lookup-shared.js";
export type { SmartFallbackDeps, SmartFallbackQuery };
export {
  isReadyLookup,
  LOOKUP_SOURCE_LABELS,
  LOOKUP_SOURCES,
  MISS_REASON_LABELS,
  MISS_REASONS,
  missMessage
} from "./lookup-shared.js";

/** Re-exports: implementations live under src/ingestion/ (behavior unchanged). */
export { parseProductSchema } from "./ingestion/normalize.js";
export { searchWebSnippets } from "./ingestion/web-search.js";
export { labelProductWithLocalOllama, lookupProductFromRawText } from "./ingestion/llm-enrichment.js";
export {
  ensureColaCacheTable,
  getFromCache,
  saveToCache,
  rememberUnresolvedUpc,
  inferImportKind,
  enrichColaRecord
} from "./ingestion/catalogs/index.js";

export async function lookupProductWithSmartFallback(
  query: SmartFallbackQuery,
  deps: SmartFallbackDeps = {}
) {
  // Dynamic import avoids a static cycle: smart-fallback → lookupProduct → this module.
  const { runSmartFallback } = await import("./ingestion/smart-fallback.js");
  return runSmartFallback(query, deps);
}
export type BottleSearchHit = {
  source: "vault" | "cola_cloud" | "catalog_beer" | "beer_cache" | "cache" | "fwgs" | "openfoodfacts";
  table: "spirits" | "packaged_beer" | "wines" | "brews";
  ttb_id?: string | null;
  catalog_beer_id?: string | null;
  product: Record<string, unknown>;
};

export type SearchTable = BottleSearchHit["table"];

export type LookupCatalogs = {
  searchIowa?: (upc: string) => Promise<ProductSchema | null>;
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

/** Unique local vault + beer_cache hits needed before Catalog.beer name search is skipped. */
export const LOCAL_BEER_SUFFICIENCY_THRESHOLD = 5;

function isBeerSearchModule(moduleId?: string) {
  return moduleId === "packaged_beer" || moduleId === "shelf" || moduleId === "taps" || moduleId === "keg" || moduleId === "brews";
}

/**
 * Persist a beer_cache mapping for a Keeper scan → search pick.
 * The scanned UPC from the request body is the cache key — never hit.product.upc,
 * Catalog.beer id, or an unrelated search-result barcode.
 */
export async function rememberBeerFromHit(upc: string, hit: BottleSearchHit) {
  // Canonical UPC-A form so EAN-13 twins share one row; lookup still accepts either.
  const code = primaryCatalogUpc(upc) || normalizeUpc(upc);
  if (!code) return;
  const brewery = String(hit.product.brewery ?? hit.product.brand ?? hit.product.maker ?? "").trim();
  const name = String(hit.product.name ?? hit.product.batch_name ?? "").trim();
  if (!name) return;
  let imageUrl = String(hit.product.image_url ?? "").trim() || null;
  let untappdBid: string | null = String(hit.product.untappd_bid ?? "") || null;
  if (!imageUrl && brewery) {
    const scraped = await enrichFromUntappdPage(brewery, name);
    if (scraped?.image_url) imageUrl = scraped.image_url;
    if (scraped?.untappd_bid) untappdBid = scraped.untappd_bid;
  }
  saveBeerCacheEntry({
    upc: code,
    catalog_beer_id: hit.catalog_beer_id ?? (String(hit.product.catalog_beer_id ?? "") || null),
    untappd_bid: untappdBid,
    brewery,
    name,
    style: String(hit.product.style ?? hit.product.category ?? "").trim(),
    abv: Number(hit.product.abv ?? 0) || null,
    image_url: imageUrl,
    source: hit.source === "catalog_beer" ? "catalog_beer" : "vault_seed"
  });
}

export async function searchCatalogBeerSuggestions(query: string, limit = 5) {
  const beers = await searchCatalogBeers(query, limit);
  return beers.map((beer) => ({
    source: "catalog_beer" as const,
    table: "packaged_beer" as const,
    catalog_beer_id: beer.id,
    product: catalogBeerToInventoryFields(beer)
  }));
}

/**
 * Public barcode orchestration entrypoint.
 *
 * Spirits/wines: vault → barcode_cache → Iowa → cola_cache → FWGS → COLA → OFF → upcitemdb → miss
 * Beer: vault → barcode_cache → beer_cache → cola_cache → OFF → upcitemdb → COLA → miss
 * Mixers: vault → barcode_cache → cola_cache → no_catalog (catalogs skipped)
 */
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
    const remembered = tryBarcodeCache(upc, rawUpc);
    if (remembered) return await success("cache", upc, remembered, kindHint);
  }

  const kind = kindHint ?? "spirits";
  const beerPath = kind === "beer";

  if (beerPath && !forceRefresh) {
    const beerCached = tryBeerCache(upc, rawUpc);
    if (beerCached) {
      return await success("beer_cache", upc, beerCached, kindHint);
    }
  }

  // Local government catalogs (PA PLCB + Iowa) — spirits/wines only, before cola_cache / remote.
  if (!beerPath && kind !== "mixers") {
    const government = await tryGovernmentStage({
      upc,
      kindHint,
      searchIowaFn: catalogs.searchIowa
    });
    if (government.hit) return government.hit;
  }

  let staleFallback: ProductSchema | null = null;
  const colaCache = resolveColaCache(upc, { beerPath, forceRefresh });
  if (colaCache.kind === "hit") {
    return await success("cache", upc, colaCache.product, kindHint);
  }
  if (colaCache.kind === "stale") {
    staleFallback = colaCache.product;
  }

  const skipCatalogs = kind === "mixers";
  let quotaHit = isColaPaused();
  let colaQueried = false;
  let colaFound = false;

  if (skipCatalogs) {
    rememberUnresolvedUpc(upc);
    return miss("no_catalog", upc, "mixers");
  }

  const { colaClient, colaEnabled } = resolveColaClient(catalogs.searchCola);

  if (!beerPath) {
    const fwgs = await tryFwgsStage({
      upc,
      kindHint,
      waitOnBurst,
      searchFwgsFn: catalogs.searchFwgs,
      colaClient,
      colaEnabled
    });
    colaQueried = colaQueried || fwgs.colaQueried;
    colaFound = colaFound || fwgs.colaFound;
    quotaHit = quotaHit || fwgs.quotaHit;
    if (fwgs.hit) return fwgs.hit;

    const cola = await trySpiritsColaStage({
      upc,
      kindHint,
      waitOnBurst,
      colaClient,
      colaEnabled
    });
    colaQueried = colaQueried || cola.colaQueried;
    colaFound = colaFound || cola.colaFound;
    quotaHit = quotaHit || cola.quotaHit;
    if (cola.hit) return cola.hit;
  }

  if (staleFallback) return await success("cache", upc, staleFallback, kindHint);

  const webHit = await tryOffThenUpcitemdb(upc, catalogs, beerPath ? "beer" : kindHint);
  if (webHit) return webHit;

  if (beerPath && colaEnabled) {
    const beerCola = await tryBeerColaStage({
      upc,
      kindHint,
      waitOnBurst,
      colaClient,
      colaEnabled,
      persistBeer: persistBeerHit
    });
    colaQueried = colaQueried || beerCola.colaQueried;
    colaFound = colaFound || beerCola.colaFound;
    quotaHit = quotaHit || beerCola.quotaHit;
    if (beerCola.hit) return beerCola.hit;
  }

  rememberUnresolvedUpc(upc);
  if (quotaHit) return miss("quota", upc, kindHint);
  if (formatAmbiguous(rawUpc)) return miss("variant", upc, kindHint, { raw: rawUpc });
  if (!beerPath && colaQueried && !colaFound) return miss("cola_gap", upc, kindHint);
  return miss("no_catalog", upc, beerPath ? "beer" : kindHint);
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
  const beerSearch = isBeerSearchModule(options?.table);

  const results: BottleSearchHit[] = searchVault(q, vaultTables);
  const seen = new Set(results.map(hitKey));

  const addHit = (hit: BottleSearchHit) => {
    if (moduleTable && hit.table !== moduleTable) return;
    const key = hitKey(hit);
    if (seen.has(key)) return;
    seen.add(key);
    results.push(hit);
  };

  if (beerSearch) {
    for (const entry of searchBeerCache(q, 8)) {
      const hit: BottleSearchHit = {
        source: "beer_cache",
        table: "packaged_beer",
        catalog_beer_id: entry.catalog_beer_id,
        product: beerCacheToInventoryFields(entry)
      };
      const key = beerCacheHitKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(hit);
    }

    // Catalog.beer is a fallback — skip when local vault + beer_cache already cover the query.
    // Count unique brewery+name identities (seen), not raw inventory/cache rows.
    const localUniqueCount = seen.size;
    const needsCatalogBeer = localUniqueCount < LOCAL_BEER_SUFFICIENCY_THRESHOLD;
    if (needsCatalogBeer && isCatalogBeerConfigured() && !isCatalogBeerQuotaExhausted()) {
      try {
        const beers = await searchCatalogBeers(q, 10);
        for (const beer of beers) {
          const product = catalogBeerToInventoryFields(beer);
          addHit({
            source: "catalog_beer",
            table: "packaged_beer",
            catalog_beer_id: beer.id,
            product
          });
        }
      } catch {
        // Vault and cache hits are still useful when Catalog.beer is down.
      }
    }
  }

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

  const needsColaFallback = !beerSearch || results.length < 5;
  if (needsColaFallback && isColaConfigured() && !isColaPaused()) {
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
