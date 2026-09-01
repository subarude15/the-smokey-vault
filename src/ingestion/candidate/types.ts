/**
 * Internal field provenance for bottle ingestion.
 * Not persisted and not part of public API responses yet.
 */

export const PRODUCT_FIELD_SOURCES = [
  "vault",
  "barcode_cache",
  "beer_cache",
  "cola_cache",
  "plcb_spirits",
  "plcb_wines",
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

/**
 * Supporting evidence that did not become the canonical winner.
 * Confirmations agree with the canonical value; conflicts disagree.
 */
export type FieldEvidenceRole = "confirmation" | "conflict";

export type FieldEvidence = {
  source: ProductFieldSource;
  confidence: number;
  role: FieldEvidenceRole;
  /** Evidence value (useful for conflicts / audits). */
  value?: unknown;
  sourceItemId?: string | null;
  matchedCode?: string | null;
  extractedAt?: string | null;
  importedAt?: string | null;
};

export type ProductField<T> = {
  value: T | null;
  source: ProductFieldSource;
  confidence: number;
  /** Secondary sources that confirmed or conflicted with the canonical winner. */
  contributors?: FieldEvidence[];
  /** Optional audit metadata for the canonical winner (e.g. government source item). */
  sourceItemId?: string | null;
  matchedCode?: string | null;
  extractedAt?: string | null;
  importedAt?: string | null;
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
  /** True when incoming agreed with a stronger/equal existing value and was recorded as confirmation. */
  confirmed?: boolean;
};
