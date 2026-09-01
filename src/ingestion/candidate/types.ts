/**
 * Internal field provenance for bottle ingestion.
 * Not persisted and not part of public API responses yet.
 */

export const PRODUCT_FIELD_SOURCES = [
  "vault",
  "barcode_cache",
  "beer_cache",
  "cola_cache",
  "iowa",
  "fwgs",
  "cola",
  "open_food_facts",
  "upcitemdb",
  "vision",
  "web",
  "llm",
  "user",
  "unknown"
] as const;

export type ProductFieldSource = (typeof PRODUCT_FIELD_SOURCES)[number];

/**
 * Discrete confidence bands (not fake precision).
 * Rules live in confidence.ts — keep scores on these plateaus only.
 */
export const CONFIDENCE = {
  /** Exact vault / user / remembered barcode hit */
  VERY_HIGH: 0.95,
  /** Catalog UPC match or clear vision label text */
  HIGH: 0.8,
  /** Web / OFF / upcitemdb extraction */
  MEDIUM: 0.55,
  /** Unsupported LLM inference */
  LOW: 0.3,
  /** Unresolved / empty */
  NONE: 0
} as const;

export type ConfidenceScore = (typeof CONFIDENCE)[keyof typeof CONFIDENCE];

export type ProductField<T> = {
  value: T | null;
  source: ProductFieldSource;
  confidence: number;
};

/** Identification fields used today — proof included because barcode_cache/inventory use it. */
export type BottleCandidateFields = {
  upc: ProductField<string>;
  name: ProductField<string>;
  brand: ProductField<string>;
  product_type: ProductField<string>;
  category: ProductField<string>;
  abv: ProductField<number>;
  proof: ProductField<number>;
  volume_ml: ProductField<number>;
  origin: ProductField<string>;
  ttb_id: ProductField<string>;
};

export type BottleCandidate = BottleCandidateFields & {
  /** Overall provenance chip for the candidate (usually the lookup source). */
  primarySource: ProductFieldSource;
};

export type BottleCandidateFieldName = keyof BottleCandidateFields;

export type FieldConflict<T = unknown> = {
  field: BottleCandidateFieldName;
  existing: ProductField<T>;
  incoming: ProductField<T>;
};

export type MergeFieldResult<T> = {
  field: ProductField<T>;
  /** Set when both sides have non-null disagreeing values (incoming did not overwrite). */
  conflict?: FieldConflict<T>;
  overwritten: boolean;
};
