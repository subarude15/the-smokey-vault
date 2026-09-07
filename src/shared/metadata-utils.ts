/**
 * Frontend version of metadata fields helper
 */
import { MetadataEntityType } from "../ingestion/enrichment/metadata-fields";

export function metadataFieldsForEntityType(entityType: string): string[] {
  if (entityType === "packaged_beer") {
    return ["category", "abv"];
  }
  return ["category", "abv", "proof", "volume_ml", "origin", "ttb_id"];
}
