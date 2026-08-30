import { hasExplicitProductType, inferProductTable, isSpiritInventoryFamily, spiritFamilyFromLabel } from "../../catalog.js";
import type { ProductSchema } from "../../cola_client.js";
import type { ImportKind, LookupResult } from "../../lookup-shared.js";

export function inferTable(product: ProductSchema | Record<string, unknown>): NonNullable<LookupResult["table"]> {
  return inferProductTable(product as Record<string, unknown>);
}

export function tableForKind(kind: ImportKind): NonNullable<LookupResult["table"]> {
  if (kind === "beer") return "packaged_beer";
  if (kind === "wines") return "wines";
  return "spirits";
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
