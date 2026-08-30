import { db } from "../../db.js";
import {
  CACHE_TTL_SECONDS,
  ColaDetail,
  ColaSummary,
  normalizeUpc,
  type ProductSchema
} from "../../cola_client.js";

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

ensureColaCacheTable();
