import type { LookupSource } from "../../lookup-shared.js";
import { CONFIDENCE, type ProductFieldSource } from "./types.js";

/**
 * Central confidence rules (deterministic, source-based).
 *
 * | Band        | Score | When |
 * |-------------|-------|------|
 * | VERY_HIGH  | 0.95  | vault shelf hit, user edit, barcode_cache UPC memory |
 * | HIGH        | 0.80  | beer_cache, cola_cache, Iowa, FWGS, COLA, vision label text |
 * | MEDIUM      | 0.55  | Open Food Facts, upcitemdb, generic web extraction |
 * | LOW         | 0.30  | unsupported LLM inference, unknown |
 * | NONE        | 0.00  | unresolved / empty field |
 */
export const SOURCE_CONFIDENCE: Record<ProductFieldSource, number> = {
  vault: CONFIDENCE.VERY_HIGH,
  barcode_cache: CONFIDENCE.VERY_HIGH,
  user: CONFIDENCE.VERY_HIGH,
  beer_cache: CONFIDENCE.HIGH,
  cola_cache: CONFIDENCE.HIGH,
  plcb_spirits: CONFIDENCE.HIGH,
  plcb_wines: CONFIDENCE.HIGH,
  iowa: CONFIDENCE.HIGH,
  fwgs: CONFIDENCE.HIGH,
  cola: CONFIDENCE.HIGH,
  vision: CONFIDENCE.HIGH,
  open_food_facts: CONFIDENCE.MEDIUM,
  upcitemdb: CONFIDENCE.MEDIUM,
  web: CONFIDENCE.MEDIUM,
  llm: CONFIDENCE.LOW,
  unknown: CONFIDENCE.LOW
};

export function confidenceForSource(source: ProductFieldSource): number {
  return SOURCE_CONFIDENCE[source] ?? CONFIDENCE.LOW;
}

/**
 * Map public LookupSource chips onto internal ProductFieldSource.
 * LookupSource "cache" covers both barcode_cache and cola_cache hits today;
 * map to cola_cache (filled catalog cache). Callers with a precise stage should
 * pass ProductFieldSource directly via productFromSchema(..., source).
 */
export function fieldSourceFromLookupSource(source: LookupSource): ProductFieldSource {
  switch (source) {
    case "vault":
      return "vault";
    case "cache":
      return "cola_cache";
    case "beer_cache":
    case "catalog_beer":
      return "beer_cache";
    case "plcb_spirits":
      return "plcb_spirits";
    case "plcb_wines":
      return "plcb_wines";
    case "iowa":
      return "iowa";
    case "fwgs":
      return "fwgs";
    case "cola_cloud":
      return "cola";
    case "openfoodfacts":
      return "open_food_facts";
    case "upcitemdb":
      return "upcitemdb";
    case "label":
      return "vision";
    case "not_found":
    default:
      return "unknown";
  }
}
