import { type ProductSchema } from "./cola_client.js";
import { normalizeSearchQuery } from "./search_normalize.js";

export const CATALOG_BEER_API_BASE = "https://api.catalog.beer";
export const CATALOG_BEER_MONTHLY_LIMIT = Number(process.env.CATALOG_BEER_MONTHLY_LIMIT ?? 1000);
/** Successful Catalog.beer search responses stay hot for a day. */
export const CATALOG_BEER_SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Empty successes get a shorter TTL so rare beers can reappear sooner. */
export const CATALOG_BEER_SEARCH_EMPTY_TTL_MS = 60 * 60 * 1000;
export const CATALOG_BEER_SEARCH_CACHE_MAX = 200;

export type CatalogBeerBrewer = {
  id?: string;
  name?: string;
  description?: string | null;
  url?: string | null;
};

export type CatalogBeerRecord = {
  id: string;
  name: string;
  style?: string | null;
  description?: string | null;
  abv?: number | null;
  ibu?: number | null;
  brewer?: CatalogBeerBrewer | null;
  match?: string | null;
};

type CatalogBeerList = {
  data?: CatalogBeerRecord[];
  has_more?: boolean;
  query?: string;
};

let monthKey = "";
let monthRequests = 0;

type CatalogBeerSearchCacheEntry = {
  key: string;
  results: CatalogBeerRecord[];
  storedAt: number;
  expiresAt: number;
  lastAccessAt: number;
};

const catalogBeerSearchCache = new Map<string, CatalogBeerSearchCacheEntry>();

function currentMonthKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`;
}

export function clearCatalogBeerSearchCache() {
  catalogBeerSearchCache.clear();
}

export function resetCatalogBeerQuota() {
  monthKey = "";
  monthRequests = 0;
  clearCatalogBeerSearchCache();
}

export function getCatalogBeerSearchCacheSize() {
  return catalogBeerSearchCache.size;
}

/** Test helper: mark every search-cache entry expired without clearing the map. */
export function expireCatalogBeerSearchCacheForTests(now = Date.now()) {
  for (const entry of catalogBeerSearchCache.values()) {
    entry.expiresAt = now - 1;
  }
}

function catalogBeerSearchCacheKey(query: string, count: number) {
  return `${normalizeSearchQuery(query)}|${count}`;
}

function readCatalogBeerSearchCache(key: string, now = Date.now()): CatalogBeerRecord[] | null {
  const entry = catalogBeerSearchCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    catalogBeerSearchCache.delete(key);
    return null;
  }
  entry.lastAccessAt = now;
  // Move to end for deterministic LRU eviction order.
  catalogBeerSearchCache.delete(key);
  catalogBeerSearchCache.set(key, entry);
  return entry.results.map((beer) => ({ ...beer, brewer: beer.brewer ? { ...beer.brewer } : beer.brewer }));
}

function writeCatalogBeerSearchCache(key: string, results: CatalogBeerRecord[], ttlMs: number, now = Date.now()) {
  while (catalogBeerSearchCache.size >= CATALOG_BEER_SEARCH_CACHE_MAX) {
    const oldestKey = catalogBeerSearchCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    catalogBeerSearchCache.delete(oldestKey);
  }
  catalogBeerSearchCache.set(key, {
    key,
    results: results.map((beer) => ({ ...beer, brewer: beer.brewer ? { ...beer.brewer } : beer.brewer })),
    storedAt: now,
    expiresAt: now + ttlMs,
    lastAccessAt: now
  });
}

export function getCatalogBeerApiKey() {
  return process.env.CATALOG_BEER_API_KEY?.trim() || "";
}

export function isCatalogBeerConfigured() {
  return Boolean(getCatalogBeerApiKey());
}

/** Process-local monthly counter only — not durable across restarts. */
export function getCatalogBeerUsage() {
  return {
    configured: isCatalogBeerConfigured(),
    month: monthKey,
    requests: monthRequests,
    limit: CATALOG_BEER_MONTHLY_LIMIT,
    remaining: Math.max(0, CATALOG_BEER_MONTHLY_LIMIT - monthRequests)
  };
}

function trackCatalogBeerRequest() {
  const key = currentMonthKey();
  if (key !== monthKey) {
    monthKey = key;
    monthRequests = 0;
  }
  monthRequests += 1;
}

export function isCatalogBeerQuotaExhausted() {
  if (!isCatalogBeerConfigured()) return true;
  const key = currentMonthKey();
  if (key !== monthKey) return false;
  return monthRequests >= CATALOG_BEER_MONTHLY_LIMIT;
}

async function catalogBeerFetch(path: string, params?: Record<string, string>) {
  const apiKey = getCatalogBeerApiKey();
  if (!apiKey) return null;
  if (isCatalogBeerQuotaExhausted()) return null;
  const url = new URL(`${CATALOG_BEER_API_BASE}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
  }
  trackCatalogBeerRequest();
  const auth = Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "User-Agent": "SmokeyVault/1.0 (home bar inventory)"
    },
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) return null;
  return await response.json() as unknown;
}

export async function searchCatalogBeers(query: string, count = 8): Promise<CatalogBeerRecord[]> {
  const q = query.trim();
  if (q.length < 2 || !isCatalogBeerConfigured()) return [];
  if (isCatalogBeerQuotaExhausted()) return [];
  const capped = Math.min(Math.max(count, 1), 20);
  const cacheKey = catalogBeerSearchCacheKey(q, capped);
  const cached = readCatalogBeerSearchCache(cacheKey);
  if (cached) return cached;

  const payload = await catalogBeerFetch("/beer/search", {
    q,
    count: String(capped)
  }) as CatalogBeerList | null;

  // Network / HTTP failures return null — do not poison the cache for a day.
  if (payload == null) return [];

  const results = payload.data ?? [];
  writeCatalogBeerSearchCache(
    cacheKey,
    results,
    results.length ? CATALOG_BEER_SEARCH_CACHE_TTL_MS : CATALOG_BEER_SEARCH_EMPTY_TTL_MS
  );
  return results;
}

export async function searchCatalogBrewers(query: string, count = 5): Promise<CatalogBeerBrewer[]> {
  const q = query.trim();
  if (q.length < 2 || !isCatalogBeerConfigured()) return [];
  const payload = await catalogBeerFetch("/brewer/search", {
    q,
    count: String(Math.min(Math.max(count, 1), 10))
  }) as { data?: CatalogBeerBrewer[] } | null;
  return payload?.data ?? [];
}

export async function getCatalogBeer(id: string): Promise<CatalogBeerRecord | null> {
  const beerId = String(id ?? "").trim();
  if (!beerId || !isCatalogBeerConfigured()) return null;
  const payload = await catalogBeerFetch(`/beer/${encodeURIComponent(beerId)}`) as CatalogBeerRecord | { data?: CatalogBeerRecord } | null;
  if (!payload) return null;
  if (typeof payload === "object" && "id" in payload && "name" in payload) return payload as CatalogBeerRecord;
  return (payload as { data?: CatalogBeerRecord }).data ?? null;
}

export function catalogBeerToSchema(beer: CatalogBeerRecord, upc = ""): ProductSchema {
  const brewery = String(beer.brewer?.name ?? "").trim();
  return {
    upc,
    name: String(beer.name ?? "").trim(),
    brand: brewery,
    category: String(beer.style ?? "Beer").trim() || "Beer",
    abv: beer.abv == null ? null : Number(beer.abv),
    image_url: null,
    fill_level_percent: 100,
    bottle_count: 1,
    notes: beer.description ? String(beer.description).slice(0, 500) : null,
    volume_ml: 355,
    product_type: "beer",
    ttb_id: null,
    origin: null,
    approval_date: null
  };
}

export function catalogBeerToInventoryFields(beer: CatalogBeerRecord, upc = "") {
  const brewery = String(beer.brewer?.name ?? "").trim();
  return {
    upc,
    catalog_beer_id: beer.id,
    name: String(beer.name ?? "").trim(),
    brewery,
    brand: brewery,
    style: String(beer.style ?? "").trim(),
    category: String(beer.style ?? "Beer").trim() || "Beer",
    abv: beer.abv == null ? 0 : Number(beer.abv),
    image_url: "",
    vessel: "Can",
    count: 1,
    volume_ml: 355,
    notes: beer.description ? String(beer.description).slice(0, 500) : ""
  };
}
