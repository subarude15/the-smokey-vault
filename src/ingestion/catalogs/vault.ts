import { barcodeVariants } from "../../cola_client.js";
import { db } from "../../db.js";
import type { LookupResult } from "../../lookup-shared.js";

/** Existing shelf inventory hit for a barcode (spirits / packaged_beer / wines). */
export function findInVault(
  upc: string,
  rawUpc: string
): { table: NonNullable<LookupResult["table"]>; product: Record<string, unknown> } | null {
  const candidates = [...new Set([upc, rawUpc, ...barcodeVariants(upc), ...barcodeVariants(rawUpc)].filter((value) => value))];
  if (!candidates.length) return null;
  const placeholders = candidates.map(() => "?").join(",");
  for (const table of ["spirits", "packaged_beer", "wines"] as const) {
    const row = db.prepare(`SELECT * FROM ${table} WHERE upc IN (${placeholders}) AND upc != '' LIMIT 1`).get(...candidates) as Record<string, unknown> | undefined;
    if (row) return { table, product: row };
  }
  return null;
}
