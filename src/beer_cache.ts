import { db } from "./db.js";
import {
  ean13Form,
  normalizeUpc,
  primaryCatalogUpc,
  upcAForm,
  type ProductSchema
} from "./cola_client.js";
import {
  matchesBeerQuery,
  scoreBeerHit,
  type ParsedBeerQuery
} from "./beer_search_query.js";

export const BEER_CACHE_TTL_SECONDS = 86400 * 90;

export type BeerCacheSource =
  | "catalog_beer"
  | "cola_cloud"
  | "openfoodfacts"
  | "upcitemdb"
  | "untappd_scrape"
  | "vault_seed"
  | "label_vision";

export type BeerCacheEntry = {
  upc: string;
  catalog_beer_id: string | null;
  untappd_bid: string | null;
  brewery: string;
  name: string;
  style: string;
  abv: number | null;
  image_url: string | null;
  source: BeerCacheSource | string;
  cached_at: number;
};

type BeerCacheRow = BeerCacheEntry;

export function ensureBeerCacheTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS beer_cache (
      upc TEXT PRIMARY KEY,
      catalog_beer_id TEXT,
      untappd_bid TEXT,
      brewery TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      style TEXT NOT NULL DEFAULT '',
      abv REAL,
      image_url TEXT,
      source TEXT NOT NULL DEFAULT 'vault_seed',
      cached_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_beer_cache_name ON beer_cache(brewery, name);
  `);
}

ensureBeerCacheTable();

/**
 * Exact UPC-A / EAN-13 twin forms only — no prefix, substring, or zero-stripping fuzzy matches.
 * Built on the shared cola_client helpers (no second conversion implementation).
 */
export function beerCacheUpcLookupKeys(rawUpc: string): string[] {
  const keys = new Set<string>();
  const normalized = normalizeUpc(rawUpc);
  const primary = primaryCatalogUpc(rawUpc);
  const upcA = upcAForm(rawUpc);
  const ean13 = ean13Form(rawUpc);
  for (const key of [normalized, primary, upcA, ean13]) {
    if (key) keys.add(key);
  }
  return [...keys];
}

function rowFromDb(row: BeerCacheRow | undefined, { allowStale = false } = {}): BeerCacheEntry | null {
  if (!row || !String(row.name ?? "").trim()) return null;
  const age = Math.floor(Date.now() / 1000) - Number(row.cached_at ?? 0);
  if (!allowStale && age > BEER_CACHE_TTL_SECONDS) return null;
  return {
    upc: row.upc,
    catalog_beer_id: row.catalog_beer_id ?? null,
    untappd_bid: row.untappd_bid ?? null,
    brewery: row.brewery ?? "",
    name: row.name,
    style: row.style ?? "",
    abv: row.abv == null ? null : Number(row.abv),
    image_url: row.image_url ?? null,
    source: row.source || "vault_seed",
    cached_at: Number(row.cached_at ?? 0)
  };
}

function nonEmptyText(value: unknown): string {
  return String(value ?? "").trim();
}

function canonicalBeerCacheUpc(rawUpc: string): string {
  return primaryCatalogUpc(rawUpc) || normalizeUpc(rawUpc);
}

/** Load every beer_cache row that is an exact UPC-A/EAN-13 twin of rawUpc. */
function loadBeerCacheTwinRows(rawUpc: string): BeerCacheRow[] {
  const keys = beerCacheUpcLookupKeys(rawUpc);
  if (!keys.length) return [];
  const placeholders = keys.map(() => "?").join(", ");
  return db.prepare(`SELECT * FROM beer_cache WHERE upc IN (${placeholders})`).all(...keys) as BeerCacheRow[];
}

function preferText(preferred: unknown, fallback: unknown): string {
  return nonEmptyText(preferred) || nonEmptyText(fallback);
}

function preferNullableText(preferred: unknown, fallback: unknown): string | null {
  return preferText(preferred, fallback) || null;
}

function preferAbv(preferred: unknown, fallback: unknown): number | null {
  if (preferred != null && preferred !== "" && !Number.isNaN(Number(preferred))) return Number(preferred);
  if (fallback != null && fallback !== "" && !Number.isNaN(Number(fallback))) return Number(fallback);
  return null;
}

/**
 * Fold historical twin rows oldest → newest so newer non-empty fields win,
 * while empty/null never erases an older useful value.
 */
function mergeBeerCacheTwinRows(rows: BeerCacheRow[]): BeerCacheRow | null {
  if (!rows.length) return null;
  const ordered = [...rows].sort(
    (a, b) => Number(a.cached_at) - Number(b.cached_at) || String(a.upc).localeCompare(String(b.upc))
  );
  let merged: BeerCacheRow = { ...ordered[0]! };
  for (const row of ordered.slice(1)) {
    merged = {
      upc: merged.upc,
      catalog_beer_id: preferNullableText(row.catalog_beer_id, merged.catalog_beer_id),
      untappd_bid: preferNullableText(row.untappd_bid, merged.untappd_bid),
      brewery: preferText(row.brewery, merged.brewery),
      name: preferText(row.name, merged.name) || merged.name,
      style: preferText(row.style, merged.style),
      abv: preferAbv(row.abv, merged.abv),
      image_url: preferNullableText(row.image_url, merged.image_url),
      source: preferText(row.source, merged.source) || merged.source,
      cached_at: Math.max(Number(merged.cached_at ?? 0), Number(row.cached_at ?? 0))
    };
  }
  return merged;
}

/**
 * Collapse UPC-A/EAN-13 twin rows onto primaryCatalogUpc.
 * Used by save and by lookup self-heal when historical duplicates exist.
 */
function consolidateBeerCacheTwins(
  rawUpc: string,
  incoming?: {
    catalog_beer_id?: string | null;
    untappd_bid?: string | null;
    brewery?: string;
    name?: string;
    style?: string;
    abv?: number | null;
    image_url?: string | null;
    source?: BeerCacheSource | string;
    cached_at?: number;
  }
): BeerCacheRow | null {
  const canonical = canonicalBeerCacheUpc(rawUpc);
  if (!canonical) return null;

  const twins = loadBeerCacheTwinRows(rawUpc);
  const mergedExisting = mergeBeerCacheTwinRows(twins);
  const name = preferText(incoming?.name, mergedExisting?.name);
  if (!name) return null;

  const brewery = preferText(incoming?.brewery, mergedExisting?.brewery);
  const style = preferText(incoming?.style, mergedExisting?.style);
  const abv = preferAbv(incoming?.abv, mergedExisting?.abv);
  const imageUrl = preferNullableText(incoming?.image_url, mergedExisting?.image_url);
  const catalogBeerId = preferNullableText(incoming?.catalog_beer_id, mergedExisting?.catalog_beer_id);
  const untappdBid = preferNullableText(incoming?.untappd_bid, mergedExisting?.untappd_bid);
  const source = preferText(incoming?.source, mergedExisting?.source) || "vault_seed";
  const cachedAt =
    incoming?.cached_at != null
      ? Number(incoming.cached_at)
      : Math.max(Number(mergedExisting?.cached_at ?? 0), ...twins.map((row) => Number(row.cached_at ?? 0)));

  // Drop every equivalent alias row, then write one canonical key.
  for (const key of beerCacheUpcLookupKeys(rawUpc)) {
    if (key !== canonical) {
      db.prepare("DELETE FROM beer_cache WHERE upc = ?").run(key);
    }
  }
  for (const row of twins) {
    if (row.upc !== canonical) {
      db.prepare("DELETE FROM beer_cache WHERE upc = ?").run(row.upc);
    }
  }

  db.prepare(`
    INSERT INTO beer_cache (
      upc, catalog_beer_id, untappd_bid, brewery, name, style, abv, image_url, source, cached_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(upc) DO UPDATE SET
      catalog_beer_id=excluded.catalog_beer_id,
      untappd_bid=excluded.untappd_bid,
      brewery=excluded.brewery,
      name=excluded.name,
      style=excluded.style,
      abv=excluded.abv,
      image_url=excluded.image_url,
      source=excluded.source,
      cached_at=excluded.cached_at
  `).run(
    canonical,
    catalogBeerId,
    untappdBid,
    brewery,
    name,
    style,
    abv,
    imageUrl,
    source,
    cachedAt || Math.floor(Date.now() / 1000)
  );

  return (db.prepare("SELECT * FROM beer_cache WHERE upc = ?").get(canonical) as BeerCacheRow | undefined) ?? null;
}

export function getBeerCacheEntry(rawUpc: string, { allowStale = false } = {}): BeerCacheEntry | null {
  const twins = loadBeerCacheTwinRows(rawUpc);
  if (!twins.length) return null;

  const canonical = canonicalBeerCacheUpc(rawUpc);
  const needsHeal = twins.length > 1 || (canonical && twins.some((row) => row.upc !== canonical));
  if (needsHeal) {
    // Historical duplicate or non-canonical lone twin → converge on primaryCatalogUpc.
    return rowFromDb(consolidateBeerCacheTwins(rawUpc) ?? undefined, { allowStale });
  }

  return rowFromDb(twins[0], { allowStale });
}

export function saveBeerCacheEntry(entry: {
  upc: string;
  catalog_beer_id?: string | null;
  untappd_bid?: string | null;
  brewery?: string;
  name: string;
  style?: string;
  abv?: number | null;
  image_url?: string | null;
  source?: BeerCacheSource | string;
}) {
  const name = nonEmptyText(entry.name);
  if (!name) return null;

  const saved = consolidateBeerCacheTwins(entry.upc, {
    catalog_beer_id: entry.catalog_beer_id,
    untappd_bid: entry.untappd_bid,
    brewery: entry.brewery,
    name,
    style: entry.style,
    abv: entry.abv,
    image_url: entry.image_url,
    source: entry.source,
    cached_at: Math.floor(Date.now() / 1000)
  });
  return saved?.upc ?? null;
}

export function beerCacheToProduct(entry: BeerCacheEntry): ProductSchema {
  return {
    upc: entry.upc,
    name: entry.name,
    brand: entry.brewery,
    category: entry.style || "Beer",
    abv: entry.abv,
    image_url: entry.image_url,
    fill_level_percent: 100,
    bottle_count: 1,
    notes: null,
    volume_ml: 355,
    product_type: "beer",
    ttb_id: null,
    origin: null,
    approval_date: null
  };
}

export function beerCacheToInventoryFields(entry: BeerCacheEntry) {
  return {
    upc: entry.upc,
    name: entry.name,
    brewery: entry.brewery,
    brand: entry.brewery,
    style: entry.style,
    category: entry.style || "Beer",
    abv: entry.abv ?? 0,
    image_url: entry.image_url ?? "",
    catalog_beer_id: entry.catalog_beer_id,
    untappd_bid: entry.untappd_bid,
    vessel: "Can",
    count: 1,
    volume_ml: 355
  };
}

export function searchBeerCache(
  query: string,
  limit = 8,
  options?: { beerParsed?: ParsedBeerQuery }
) {
  const beerParsed = options?.beerParsed;
  const tokens = foldBeerSearch(query).split(/[^a-z0-9]+/).filter(Boolean);
  if (!beerParsed && !tokens.length) return [];
  const rows = db.prepare("SELECT * FROM beer_cache").all() as BeerCacheRow[];
  return rows
    .flatMap((row) => {
      const entry = row as BeerCacheEntry;
      const product = beerCacheToInventoryFields(entry);
      if (beerParsed) {
        if (!matchesBeerQuery(product, beerParsed)) return [];
        return [{ entry, score: scoreBeerHit(product, beerParsed, "beer_cache") }];
      }
      const hay = foldBeerSearch(`${row.name} ${row.brewery} ${row.style} ${row.upc}`);
      if (!tokens.every((token) => hay.includes(token))) return [];
      const name = foldBeerSearch(row.name);
      const brewery = foldBeerSearch(row.brewery);
      let score = 0;
      if (tokens.every((token) => name.includes(token))) score += 8;
      if (tokens[0] && name.split(/[^a-z0-9]+/).some((part) => part.startsWith(tokens[0]!))) score += 4;
      if (tokens[0] && brewery.split(/[^a-z0-9]+/).some((part) => part.startsWith(tokens[0]!))) score += 3;
      return [{ entry, score: score + 2 }];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

function foldBeerSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .toLowerCase();
}

export function beerCacheHitKey(entry: Pick<BeerCacheEntry, "brewery" | "name">) {
  return foldBeerSearch(`${entry.name}|${entry.brewery}`);
}
