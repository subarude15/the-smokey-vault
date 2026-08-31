/**
 * Central enrichment planning rules (deterministic).
 *
 * Identity (required to set identified=true):
 *   name, brand, product_type — each must be resolved with confidence >= TRUSTED_MIN
 *   UPC is helpful when present but not required (label-only paths may lack it)
 *
 * Recommended metadata (never blocks identified):
 *   abv, proof, volume_ml, origin, ttb_id, upc (when missing), category
 *
 * Optional content (never blocks identified; null is a valid final state):
 *   tasting_notes, image
 */
import { CONFIDENCE } from "../candidate/types.js";
import type { EnrichmentField, EnrichmentPriority } from "./types.js";

/** Field counts as trustworthy for identity / skip-enrichment when at or above this. */
export const TRUSTED_MIN = CONFIDENCE.HIGH;

/** Schedule enrichment when a present value is below this (e.g. LOW llm guess). */
export const ENRICH_BELOW = CONFIDENCE.HIGH;

/** Identity fields — all required at TRUSTED_MIN for identified=true. */
export const IDENTITY_FIELDS = ["name", "brand", "product_type"] as const;
export type IdentityField = (typeof IDENTITY_FIELDS)[number];

/** Recommended bottle metadata — tasks do not invalidate identity. */
export const RECOMMENDED_FIELDS = [
  "upc",
  "category",
  "abv",
  "proof",
  "volume_ml",
  "origin",
  "ttb_id"
] as const;
export type RecommendedField = (typeof RECOMMENDED_FIELDS)[number];

/**
 * Optional content not on BottleCandidate yet.
 * Missing these MUST NEVER make a bottle invalid / unidentified.
 */
export const OPTIONAL_CONTENT_FIELDS = ["tasting_notes", "image"] as const;
export type OptionalContentField = (typeof OPTIONAL_CONTENT_FIELDS)[number];

export function priorityForField(field: EnrichmentField): EnrichmentPriority {
  if ((IDENTITY_FIELDS as readonly string[]).includes(field)) return "required";
  if ((OPTIONAL_CONTENT_FIELDS as readonly string[]).includes(field)) return "optional";
  return "recommended";
}

export function isIdentityField(field: string): field is IdentityField {
  return (IDENTITY_FIELDS as readonly string[]).includes(field);
}
