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
import type { JobDiagnosticsPayload } from "../enrichment/diagnostics.js";
import { searchGovernmentByBarcode } from "../catalogs/government/lookup.js";
import { applyGovernmentCatalogEvidence } from "../enrichment/government-evidence.js";
import { candidateFromInventoryRow, loadInventoryRow } from "./inventory.js";
import {
  getProductImage,
  hasAcceptedProductImage,
  inventoryHasUserImage,
  markProductImageEmpty,
  upsertProductImage
} from "./product-images.js";
import {
  getEnrichmentSource,
  upsertEnrichmentSource
} from "./enrichment-sources.js";
import type { EnrichmentJob } from "./types.js";

export type ImageJobResultPayload = {
  imageSaved: boolean;
  diagnostics?: JobDiagnosticsPayload | null;
  officialProductPageUrl?: string | null;
};

export type ImageJobResult = {
  skipped: boolean;
  reason?: string;
  execution?: ImageEnrichmentResult;
  imageSaved: boolean;
  inventoryImageUrl: string | null;
  resultPayload: ImageJobResultPayload;
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
    return {
      skipped: true,
      reason: "not_identified",
      imageSaved: false,
      inventoryImageUrl,
      resultPayload: { imageSaved: false }
    };
  }
  if (plan.needsReview) {
    return {
      skipped: true,
      reason: "needs_review",
      imageSaved: false,
      inventoryImageUrl,
      resultPayload: { imageSaved: false }
    };
  }
  if (inventoryHasUserImage(row)) {
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
    return {
      skipped: true,
      reason: "user_image_present",
      imageSaved: false,
      inventoryImageUrl,
      resultPayload: { imageSaved: false }
    };
  }
  if (hasAcceptedProductImage(job.entity_type, job.entity_id)) {
    return {
      skipped: true,
      reason: "already_complete",
      imageSaved: false,
      inventoryImageUrl,
      resultPayload: { imageSaved: false }
    };
  }

  // Inventory rows intentionally do not persist field-provenance internals. Reattach
  // trusted, barcode-bound government evidence for this in-memory image run so the
  // FWGS adapter can recover its PLCB identity. This never writes catalog metadata
  // or changes inventory image semantics; misses/optional-catalog failures simply
  // leave the existing generic image path unchanged.
  const lookupUpc = before.upc.value?.trim() || job.upc.trim();
  if (lookupUpc) {
    try {
      applyGovernmentCatalogEvidence(before, searchGovernmentByBarcode(lookupUpc), {
        lookupUpc
      });
    } catch {
      // The government catalog is optional for image enrichment.
    }
  }

  const knownOfficial = getEnrichmentSource(
    job.entity_type,
    job.entity_id,
    "official_product_page"
  );
  const execution = await executeImageEnrichment(before, {
    ...deps,
    knownOfficialProductPageUrl:
      deps.knownOfficialProductPageUrl ?? knownOfficial?.sourceUrl ?? null
  });

  if (execution.selectedOfficialProductPageUrl) {
    upsertEnrichmentSource({
      entityType: job.entity_type,
      entityId: job.entity_id,
      sourceType: "official_product_page",
      sourceUrl: execution.selectedOfficialProductPageUrl
    });
  }

  // Provider/system failures must retry via the enrichment queue — even when
  // progressive evaluation already produced rejected candidates in `evaluated`.
  // Deterministic rejections (wrong_product, score_below_threshold, etc.) complete.
  if (!execution.selected) {
    if (execution.diagnostics.noResultReason === "provider_error") {
      throw new Error(
        execution.errors.join("; ") || "image enrichment provider error"
      );
    }
    if (execution.errors.length > 0 && execution.evaluated.length === 0) {
      throw new Error(execution.errors.join("; ") || "image enrichment failed");
    }
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

  const rowAfter = loadInventoryRow(job.entity_type, job.entity_id)!;
  const afterUrl = String(rowAfter.image_url ?? "").trim() || null;
  if (afterUrl !== inventoryImageUrl) {
    throw new Error("Image job mutated inventory image_url — aborting");
  }

  return {
    skipped: false,
    execution,
    imageSaved,
    inventoryImageUrl,
    resultPayload: {
      imageSaved,
      diagnostics: execution.diagnostics,
      officialProductPageUrl: execution.selectedOfficialProductPageUrl ?? null
    }
  };
}

export { getProductImage };
