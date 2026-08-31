/**
 * Recommended metadata fields handled by the first enrichment executor.
 * Identity + optional content (tasting_notes, image) are intentionally excluded.
 */
export const METADATA_ENRICHMENT_FIELDS = [
  "abv",
  "proof",
  "volume_ml",
  "origin",
  "ttb_id"
] as const;

export type MetadataEnrichmentField = (typeof METADATA_ENRICHMENT_FIELDS)[number];

export function isMetadataEnrichmentField(field: string): field is MetadataEnrichmentField {
  return (METADATA_ENRICHMENT_FIELDS as readonly string[]).includes(field);
}

/** US spirits convention: proof ≈ 2 × ABV. */
export function proofFromAbv(abv: number): number {
  return Math.round(abv * 2 * 10) / 10;
}

export function abvFromProof(proof: number): number {
  return Math.round((proof / 2) * 10) / 10;
}
