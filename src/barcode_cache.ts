import { db } from "./db.js";
import { normalizeUpc, type ProductSchema } from "./cola_client.js";

/** A row of `barcode_cache`: everything the resolver learned about one barcode. */
export type BarcodeCacheEntry = {
  upc: string;
  name: string;
  brand: string;
  category: string;
  subcategory: string;
  /** Null when the source never stated a strength, which is different from 0%. */
  abv: number | null;
  proof: number | null;
  volume_ml: number;
  description: string;
  image_url: string;
  source: string;
};

type BarcodeCacheRow = BarcodeCacheEntry & { created_at: string };

export function getBarcodeCacheEntry(rawUpc: string): BarcodeCacheEntry | null {
  const upc = normalizeUpc(rawUpc);
  if (!upc) return null;
  const row = db.prepare("SELECT * FROM barcode_cache WHERE upc = ?").get(upc) as BarcodeCacheRow | undefined;
  if (!row || !String(row.name ?? "").trim()) return null;
  return {
    upc: row.upc,
    name: row.name,
    brand: row.brand ?? "",
    category: row.category || "Other",
    subcategory: row.subcategory ?? "",
    abv: row.abv == null ? null : Number(row.abv),
    proof: row.proof == null ? null : Number(row.proof),
    volume_ml: Number(row.volume_ml ?? 750),
    description: row.description ?? "",
    image_url: row.image_url ?? "",
    source: row.source || "imported"
  };
}

/** Upserts a barcode. Entries without a UPC or a name are ignored rather than stored empty. */
export function saveBarcodeCacheEntry(entry: Partial<BarcodeCacheEntry> & { upc: string; name: string }) {
  const upc = normalizeUpc(entry.upc);
  const name = String(entry.name ?? "").trim();
  if (!upc || !name) return null;
  const abv = entry.abv == null ? null : Number(entry.abv) || 0;
  const proof = entry.proof == null
    ? (abv === null ? null : Number((abv * 2).toFixed(1)))
    : Number(entry.proof) || 0;
  db.prepare(`
    INSERT INTO barcode_cache (upc, name, brand, category, subcategory, abv, proof, volume_ml, description, image_url, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(upc) DO UPDATE SET
      name=excluded.name, brand=excluded.brand, category=excluded.category, subcategory=excluded.subcategory,
      abv=excluded.abv, proof=excluded.proof, volume_ml=excluded.volume_ml, description=excluded.description,
      image_url=excluded.image_url, source=excluded.source
  `).run(
    upc,
    name,
    String(entry.brand ?? ""),
    String(entry.category ?? "Other"),
    String(entry.subcategory ?? ""),
    abv,
    proof,
    Math.round(Number(entry.volume_ml ?? 750)) || 750,
    String(entry.description ?? ""),
    String(entry.image_url ?? ""),
    String(entry.source ?? "imported")
  );
  return upc;
}

export function barcodeEntryToProduct(entry: BarcodeCacheEntry): ProductSchema {
  return {
    upc: entry.upc,
    name: entry.name,
    brand: entry.brand,
    // The finer style is the more useful label when the resolver found one.
    category: entry.subcategory || entry.category,
    abv: entry.abv || null,
    image_url: entry.image_url || null,
    fill_level_percent: 100,
    bottle_count: 1,
    notes: entry.description || null,
    volume_ml: entry.volume_ml || null,
    product_type: entry.category || null,
    ttb_id: null,
    origin: null,
    approval_date: null
  };
}
