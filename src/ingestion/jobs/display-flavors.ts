/**
 * PR156 — attach derived Guest/Keeper presentation flavors for spirit inventory rows.
 *
 * Source of truth (priority):
 *   1. Keeper structured `flavors`
 *   2. Recognized terms in Keeper `tasting_notes`
 *   3. Recognized terms in accepted enrichment official/house tasting text
 *
 * Never writes enrichment into Keeper-owned inventory columns. `display_flavors`
 * is response-only presentation data (same ownership pattern as `display_image_url`).
 */
import { deriveSpiritFlavors } from "../../spirit-flavors.js";
import { getProductContent } from "./product-content.js";

function enrichmentTastingText(entityId: number): string {
  const content = getProductContent("spirits", entityId);
  if (!content) return "";
  return [content.official_tasting_notes, content.house_tasting_profile]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Attach derived `display_flavors` for spirit inventory rows.
 * Safe for public inventory responses (canonical labels only — no diagnostics).
 */
export function attachInventoryDisplayFlavors(
  entityType: string,
  row: Record<string, unknown>
): Record<string, unknown> {
  if (entityType !== "spirits") return row;
  const id = Number(row.id);
  const enrichmentText =
    Number.isFinite(id) && id > 0 ? enrichmentTastingText(id) : "";
  return {
    ...row,
    display_flavors: deriveSpiritFlavors({
      flavors: row.flavors,
      tasting_notes: row.tasting_notes,
      enrichment_tasting_text: enrichmentText
    })
  };
}
