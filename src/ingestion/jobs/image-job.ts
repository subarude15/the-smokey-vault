/**
 * Run one image enrichment job against a saved inventory entity.
 * Never mutates identity fields; never replaces user-supplied inventory images.
 */
import { planEnrichment } from "../enrichment/index.js";
import {
  executeImageEnrichment,
  type ImageEnrichmentDeps,
  type ImageEnrichmentResult
} from "../enrichment/execute-images.js";
import { candidateFromInventoryRow, loadInventoryRow } from "./inventory.js";
import {
  getProductImage,
  hasAcceptedProductImage,
  inventoryHasUserImage,
  markProductImageEmpty,
  upsertProductImage
} from "./product-images.js";
import type { EnrichmentJob } from "./types.js";

export type ImageJobResult = {
  skipped: boolean;
  reason?: string;
  execution?: ImageEnrichmentResult;
  imageSaved: boolean;
  /** Inventory image_url before job — must remain unchanged by this job. */
  inventoryImageUrl: string | null;
};

export async function runImageJob(
  job: EnrichmentJob,
  deps: ImageEnrichmentDeps = {}
): Promise<ImageJobResult> {
  const row = loadInventoryRow(job.entity_type, job.entity_id);
  if (!row) {
    throw new Error(`Inventory ${job.entity_type}#${job.entity_id} not found`);
  }

  const inventoryImageUrl = String(row.image_url ?? "").trim() || null;
  const before = candidateFromInventoryRow(job.entity_type, row);
  const plan = planEnrichment(before);

  if (!plan.identified) {
    return { skipped: true, reason: "not_identified", imageSaved: false, inventoryImageUrl };
  }
  if (plan.needsReview) {
    return { skipped: true, reason: "needs_review", imageSaved: false, inventoryImageUrl };
  }
  if (inventoryHasUserImage(row)) {
    // Preserve user/existing shelf image as highest priority.
    upsertProductImage({
      entityType: job.entity_type,
      entityId: job.entity_id,
      url: inventoryImageUrl,
      sourceType: "user",
      sourceUrl: null,
      score: 100,
      verified: true,
      rejectionReason: null
    });
    return { skipped: true, reason: "user_image_present", imageSaved: false, inventoryImageUrl };
  }
  if (hasAcceptedProductImage(job.entity_type, job.entity_id)) {
    return { skipped: true, reason: "already_complete", imageSaved: false, inventoryImageUrl };
  }

  const execution = await executeImageEnrichment(before, deps);

  if (execution.errors.length > 0 && !execution.selected && execution.evaluated.length === 0) {
    throw new Error(execution.errors.join("; ") || "image enrichment failed");
  }

  let imageSaved = false;
  if (execution.selected) {
    upsertProductImage({
      entityType: job.entity_type,
      entityId: job.entity_id,
      url: execution.selected.url,
      sourceType: execution.selected.sourceType,
      sourceUrl: execution.selected.sourceUrl,
      width: execution.selected.width,
      height: execution.selected.height,
      mimeType: execution.selected.mimeType,
      score: execution.selected.score,
      verified: execution.selected.verified,
      rejectionReason: null
    });
    imageSaved = true;
  } else {
    markProductImageEmpty(job.entity_type, job.entity_id, "no_acceptable_image");
  }

  // Inventory image_url must remain untouched.
  const rowAfter = loadInventoryRow(job.entity_type, job.entity_id)!;
  const afterUrl = String(rowAfter.image_url ?? "").trim() || null;
  if (afterUrl !== inventoryImageUrl) {
    throw new Error("Image job mutated inventory image_url — aborting");
  }

  return {
    skipped: false,
    execution,
    imageSaved,
    inventoryImageUrl
  };
}

export { getProductImage };
