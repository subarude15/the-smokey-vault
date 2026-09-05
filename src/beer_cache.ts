import { db } from "./db.js";
import {
  ean13Form,
  normalizeUpc,
  primaryCatalogUpc,
  upcAForm,
  type ProductSchema
} from "./cola_client.js";

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

function findBeerCacheRow(rawUpc: string): BeerCacheRow | undefined {
  const keys = beerCacheUpcLookupKeys(rawUpc);
  if (!keys.length) return undefined;
  const placeholders = keys.map(() => "?").join(", ");
  return db.prepare(`SELECT * FROM beer_cache WHERE upc IN (${placeholders}) LIMIT 1`).get(...keys) as
    | BeerCacheRow
    | undefined;
}

export function getBeerCacheEntry(rawUpc: string, { allowStale = false } = {}): BeerCacheEntry | null {
  return rowFromDb(findBeerCacheRow(rawUpc), { allowStale });
}

function nonEmptyText(value: unknown): string {
  return String(value ?? "").trim();
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

  // Prefer an existing twin-row key so UPC-A/EAN-13 do not fork into duplicate rows.
  const existing = findBeerCacheRow(entry.upc);
  const upc = existing?.upc || primaryCatalogUpc(entry.upc) || normalizeUpc(entry.upc);
  if (!upc) return null;

  const brewery = nonEmptyText(entry.brewery);
  const style = nonEmptyText(entry.style);
  const abv = entry.abv == null || Number.isNaN(Number(entry.abv)) ? null : Number(entry.abv);
  const imageUrl = nonEmptyText(entry.image_url) || null;
  const catalogBeerId = nonEmptyText(entry.catalog_beer_id) || null;
  const untappdBid = nonEmptyText(entry.untappd_bid) || null;
  const source = nonEmptyText(entry.source) || "vault_seed";
  const cachedAt = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO beer_cache (
      upc, catalog_beer_id, untappd_bid, brewery, name, style, abv, image_url, source, cached_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(upc) DO UPDATE SET
      catalog_beer_id=COALESCE(excluded.catalog_beer_id, beer_cache.catalog_beer_id),
      untappd_bid=COALESCE(excluded.untappd_bid, beer_cache.untappd_bid),
      brewery=CASE WHEN TRIM(excluded.brewery) = '' THEN beer_cache.brewery ELSE excluded.brewery END,
      name=excluded.name,
      style=CASE WHEN TRIM(excluded.style) = '' THEN beer_cache.style ELSE excluded.style END,
      abv=COALESCE(excluded.abv, beer_cache.abv),
      image_url=COALESCE(excluded.image_url, beer_cache.image_url),
      source=CASE WHEN TRIM(excluded.source) = '' THEN beer_cache.source ELSE excluded.source END,
      cached_at=excluded.cached_at
  `).run(
    upc,
    catalogBeerId,
    untappdBid,
    brewery,
    name,
    style,
    abv,
    imageUrl,
    source,
    cachedAt
  );
  return upc;
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

export function searchBeerCache(query: string, limit = 8) {
  const tokens = foldBeerSearch(query).split(/[^a-z0-9]+/).filter(Boolean);
  if (!tokens.length) return [];
  const rows = db.prepare("SELECT * FROM beer_cache").all() as BeerCacheRow[];
  return rows
    .filter((row) => {
      const hay = foldBeerSearch(`${row.name} ${row.brewery} ${row.style} ${row.upc}`);
      return tokens.every((token) => hay.includes(token));
    })
    .map((row) => {
      const name = foldBeerSearch(row.name);
      const brewery = foldBeerSearch(row.brewery);
      let score = 0;
      if (tokens.every((token) => name.includes(token))) score += 8;
      if (tokens[0] && name.split(/[^a-z0-9]+/).some((part) => part.startsWith(tokens[0]!))) score += 4;
      if (tokens[0] && brewery.split(/[^a-z0-9]+/).some((part) => part.startsWith(tokens[0]!))) score += 3;
      return { entry: row as BeerCacheEntry, score: score + 2 };
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
