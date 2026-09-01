/**
 * Iowa Liquor Products catalog stage — deterministic local product facts.
 *
 * Lookup order position: after barcode_cache, before cola_cache / FWGS / COLA.
 * Exact UPC match only (optional exact item_no). No fuzzy name matching.
 */
import {
  normalizeCanonicalTaxonomy,
  normalizeCanonicalVolumeMl
} from "../../canonical-normalize.js";
import { normalizeUpc, primaryCatalogUpc, type ProductSchema } from "../../cola_client.js";
import type { ImportKind, LookupResult } from "../../lookup-shared.js";
import { inferImportKind } from "./kind.js";
import { preferIowaRow } from "./iowa-category.js";
import {
  findIowaRowsByItemNo,
  findIowaRowsByUpc,
  type IowaProductRow
} from "./iowa-store.js";
import { success, withLocalImage } from "./result.js";

export type IowaCatalogFn = (upc: string) => Promise<ProductSchema | null>;

export type IowaStageResult = {
  hit: LookupResult | null;
};

export function iowaRowToSchema(lookupUpc: string, row: IowaProductRow): ProductSchema {
  const tax = normalizeCanonicalTaxonomy(row.category_name, "");
  const category = tax.family || row.category_name || "Spirits";
  const volume = normalizeCanonicalVolumeMl(row.bottle_volume_ml);
  const upc =
    primaryCatalogUpc(row.upc ?? "") ||
    normalizeUpc(row.upc ?? "") ||
    primaryCatalogUpc(lookupUpc) ||
    normalizeUpc(lookupUpc);

  // vendor_name is a distributor/bottler signal — brand fallback only.
  const brand = (row.vendor_name ?? "").trim();

  return {
    upc,
    name: row.name || "Unknown",
    brand,
    category,
    abv: row.abv,
    image_url: null,
    fill_level_percent: 100,
    bottle_count: 1,
    notes: [
      row.proof != null ? `Iowa proof: ${row.proof}` : "",
      row.raw_upc ? `Iowa raw UPC: ${row.raw_upc}` : "",
      row.report_as_of ? `Iowa report: ${row.report_as_of}` : "",
      row.item_no ? `Iowa item: ${row.item_no}` : ""
    ]
      .filter(Boolean)
      .join(" | ") || null,
    volume_ml: volume,
    product_type: tax.productType ?? "spirit",
    ttb_id: null,
    origin: null,
    approval_date: null,
    proof: row.proof
  };
}

export function searchIowaByUpc(upc: string): ProductSchema | null {
  const code = primaryCatalogUpc(upc) || normalizeUpc(upc);
  if (!code) return null;
  const variants = new Set<string>([
    code,
    normalizeUpc(code),
    primaryCatalogUpc(code),
    code.replace(/^0/, ""),
    code.padStart(12, "0").slice(-12)
  ]);
  const rows: IowaProductRow[] = [];
  for (const variant of variants) {
    if (!variant) continue;
    rows.push(...findIowaRowsByUpc(variant));
  }
  if (!rows.length) return null;
  const seen = new Set<string>();
  const unique: IowaProductRow[] = [];
  for (const row of rows) {
    const key = `${row.item_no}::${row.category_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return iowaRowToSchema(code, preferIowaRow(unique));
}

export function searchIowaByItemNo(itemNo: string): ProductSchema | null {
  const id = String(itemNo ?? "").trim();
  if (!id) return null;
  const rows = findIowaRowsByItemNo(id);
  if (!rows.length) return null;
  const preferred = preferIowaRow(rows);
  return iowaRowToSchema(preferred.upc ?? id, preferred);
}

export async function tryIowaStage(options: {
  upc: string;
  kindHint?: ImportKind;
  searchIowaFn?: IowaCatalogFn;
}): Promise<IowaStageResult> {
  try {
    const product = await (options.searchIowaFn ?? (async (u: string) => searchIowaByUpc(u)))(
      options.upc
    );
    if (!product?.name?.trim()) {
      return { hit: null };
    }
    const localized = await withLocalImage(product);
    const hit = await success(
      "iowa",
      options.upc,
      localized,
      inferImportKind(localized, options.kindHint)
    );
    return { hit };
  } catch {
    return { hit: null };
  }
}
