/**
 * Recommended metadata fields handled by the first enrichment executor.
 * Identity + optional content (tasting_notes, image) are intentionally excluded.
 *
 * category is the alcohol classification label (Whiskey, Scotch Whisky, Bourbon, …).
 * On spirits persist it splits into inventory category (family) + sub_category (type).
 */
export const METADATA_ENRICHMENT_FIELDS = [
  "category",
  "abv",
  "proof",
  "volume_ml",
  "origin",
  "ttb_id"
] as const;

export type MetadataEnrichmentField = (typeof METADATA_ENRICHMENT_FIELDS)[number];

export type MetadataEntityType = "spirits" | "packaged_beer" | "wines";

const METADATA_FIELDS_BY_ENTITY_TYPE: Record<
  MetadataEntityType,
  readonly MetadataEnrichmentField[]
> = {
  spirits: METADATA_ENRICHMENT_FIELDS,
  wines: METADATA_ENRICHMENT_FIELDS,
  packaged_beer: ["category", "abv"]
};

/** Core completeness/enrichment fields for one inventory entity type. */
export function metadataFieldsForEntityType(
  entityType: MetadataEntityType
): readonly MetadataEnrichmentField[] {
  return METADATA_FIELDS_BY_ENTITY_TYPE[entityType];
}

/** Compatibility helper for candidate-only execution paths. */
export function metadataEntityTypeForProductType(
  productType: unknown
): MetadataEntityType {
  const value = String(productType ?? "").trim().toLowerCase();
  if (value === "beer" || value === "malt beverage" || value === "packaged_beer") {
    return "packaged_beer";
  }
  if (value === "wine" || value === "wines") return "wines";
  return "spirits";
}

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

/** String-valued metadata fields (classification + text facts). */
export const METADATA_STRING_FIELDS = new Set<MetadataEnrichmentField>([
  "category",
  "origin",
  "ttb_id"
]);
