/**
 * Run one image enrichment job against a saved inventory entity.
 * Never mutates identity fields; never replaces user-supplied inventory images.
 * Accepted machine images are persisted locally in product_images only.
 */
import { planEnrichment } from "../enrichment/index.js";
import {
  executeImageEnrichment,
  type ImageEnrichmentDeps,
  type ImageEnrichmentResult,
  type SelectedImageAsset
} from "../enrichment/execute-images.js";
import type { JobDiagnosticsPayload } from "../enrichment/diagnostics.js";
import type { ScoredImageCandidate } from "../enrichment/image-score.js";
import { searchGovernmentByBarcode } from "../catalogs/government/lookup.js";
import { applyGovernmentCatalogEvidence } from "../enrichment/government-evidence.js";
import {
  FWGS_SITE_HOST,
  fetchFwgsImageViaFigranium,
  isFwgsFigraniumProviderError,
  plcbItemFromCandidate,
  validateFwgsImageUrl
} from "../../fwgs-figranium.js";
import {
  isLocalImagePath,
  localizeImage,
  saveImageBuffer
} from "../../images.js";
import { candidateFromInventoryRow, loadInventoryRow } from "./inventory.js";
import {
  getProductImage,
  hasDurableAcceptedProductImage,
  inventoryHasUserImage,
  markProductImageEmpty,
  productImageNeedsLocalization,
  upsertProductImage
} from "./product-images.js";
import {
  getEnrichmentSource,
  upsertEnrichmentSource
} from "./enrichment-sources.js";
import type { EnrichmentJob } from "./types.js";

export type ImageJobDeps = ImageEnrichmentDeps & {
  /** Override local byte persistence (tests). */
  saveImageBuffer?: (
    buffer: Buffer,
    contentType?: string | null,
    originalName?: string
  ) => string;
  /** Override safe remote→local download (tests). */
  localizeImage?: (remoteUrl?: string | null) => Promise<string | null>;
};

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

function assertInventoryImageUnchanged(
  entityType: EnrichmentJob["entity_type"],
  entityId: number,
  inventoryImageUrl: string | null
): void {
  const rowAfter = loadInventoryRow(entityType, entityId)!;
  const afterUrl = String(rowAfter.image_url ?? "").trim() || null;
  if (afterUrl !== inventoryImageUrl) {
    throw new Error("Image job mutated inventory image_url — aborting");
  }
}

/**
 * Persist an accepted remote/machine image into the local media store.
 * Prefer already-fetched trusted bytes (Figranium); otherwise localizeImage.
 * Never silently leaves a known-unusable remote URL as the durable store.
 */
async function persistAcceptedImageLocally(options: {
  selected: ScoredImageCandidate;
  selectedAsset?: SelectedImageAsset | null;
  deps: ImageJobDeps;
}): Promise<string> {
  const save = options.deps.saveImageBuffer ?? saveImageBuffer;
  const localize = options.deps.localizeImage ?? localizeImage;
  const remoteUrl = options.selected.url;

  if (isLocalImagePath(remoteUrl)) {
    return remoteUrl;
  }

  if (options.selectedAsset?.bytes?.length) {
    return save(
      options.selectedAsset.bytes,
      options.selectedAsset.contentType || options.selected.mimeType,
      remoteUrl
    );
  }

  const localized = await localize(remoteUrl);
  if (localized && isLocalImagePath(localized)) {
    return localized;
  }

  throw new Error(
    "image_persistence_failed: could not localize accepted image"
  );
}

/** True when the URL is hosted on the exact FWGS site (not a PLCB-bound check). */
function isFwgsHostedRemoteUrl(url: string): boolean {
  try {
    const parsed = new URL(String(url ?? "").trim());
    return parsed.protocol === "https:" && parsed.hostname === FWGS_SITE_HOST;
  } catch {
    return false;
  }
}

/**
 * Efficient repair for an already-accepted remote product_images row.
 * Returns the new local URL on success, null to fall through to rediscovery,
 * or throws on typed provider/system failures (queue retry).
 *
 * FWGS URLs never use generic localizeImage — they require trusted PLCB binding
 * and Figranium only.
 */
async function tryRepairRemoteAcceptedImage(options: {
  job: EnrichmentJob;
  plcbItem: string | null;
  deps: ImageJobDeps;
}): Promise<string | null> {
  if (!productImageNeedsLocalization(options.job.entity_type, options.job.entity_id)) {
    return null;
  }
  const existing = getProductImage(options.job.entity_type, options.job.entity_id);
  if (!existing?.url) return null;

  const remoteUrl = existing.url;
  const save = options.deps.saveImageBuffer ?? saveImageBuffer;
  const localize = options.deps.localizeImage ?? localizeImage;
  const fetchFwgs =
    options.deps.fetchFwgsImageViaFigranium ?? fetchFwgsImageViaFigranium;

  // FWGS trust boundary: never hotlink-repair via generic HTTP download.
  if (isFwgsHostedRemoteUrl(remoteUrl)) {
    const plcb = options.plcbItem?.trim() || null;
    if (!plcb || !validateFwgsImageUrl(remoteUrl, plcb)) {
      // Missing or mismatched PLCB — fall through to progressive rediscovery.
      return null;
    }
    try {
      const fetched = await fetchFwgs(remoteUrl, plcb);
      if (fetched.ok) {
        return save(
          fetched.image.bytes,
          fetched.image.contentType || existing.mime_type,
          remoteUrl
        );
      }
      // Soft Figranium miss — fall through to rediscovery rather than trusting
      // a permanently broken remote hotlink.
      return null;
    } catch (error) {
      if (isFwgsFigraniumProviderError(error)) throw error;
      throw error;
    }
  }

  const localized = await localize(remoteUrl);
  if (localized && isLocalImagePath(localized)) {
    return localized;
  }
  return null;
}

function upsertAcceptedLocalImage(options: {
  job: EnrichmentJob;
  selected: ScoredImageCandidate;
  localUrl: string;
}): void {
  upsertProductImage({
    entityType: options.job.entity_type,
    entityId: options.job.entity_id,
    url: options.localUrl,
    sourceType: options.selected.sourceType,
    sourceUrl: options.selected.sourceUrl,
    width: options.selected.width,
    height: options.selected.height,
    mimeType: options.selected.mimeType,
    score: options.selected.score,
    verified: options.selected.verified,
    rejectionReason: null
  });
}

function upsertRepairedLocalUrl(options: {
  job: EnrichmentJob;
  localUrl: string;
}): void {
  const existing = getProductImage(options.job.entity_type, options.job.entity_id);
  if (!existing) return;
  upsertProductImage({
    entityType: options.job.entity_type,
    entityId: options.job.entity_id,
    url: options.localUrl,
    sourceType: existing.source_type,
    sourceUrl: existing.source_url,
    width: existing.width,
    height: existing.height,
    mimeType: existing.mime_type,
    score: existing.score,
    verified: existing.verified,
    rejectionReason: null
  });
}

export async function runImageJob(
  job: EnrichmentJob,
  deps: ImageJobDeps = {}
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

  // Inventory rows intentionally do not persist field-provenance internals. Reattach
  // trusted, barcode-bound government evidence for this in-memory image run so the
  // FWGS adapter can recover its PLCB identity — including remote-image repair.
  // This never writes catalog metadata or changes inventory image semantics.
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

  if (hasDurableAcceptedProductImage(job.entity_type, job.entity_id)) {
    return {
      skipped: true,
      reason: "already_complete",
      imageSaved: false,
      inventoryImageUrl,
      resultPayload: { imageSaved: false }
    };
  }

  // Repair existing accepted remote images before broad rediscovery when safe.
  if (productImageNeedsLocalization(job.entity_type, job.entity_id)) {
    const plcbItem = plcbItemFromCandidate(before);
    const repairedUrl = await tryRepairRemoteAcceptedImage({
      job,
      plcbItem,
      deps
    });
    if (repairedUrl) {
      upsertRepairedLocalUrl({ job, localUrl: repairedUrl });
      assertInventoryImageUnchanged(job.entity_type, job.entity_id, inventoryImageUrl);
      return {
        skipped: false,
        reason: "localized_existing",
        imageSaved: true,
        inventoryImageUrl,
        resultPayload: {
          imageSaved: true,
          diagnostics: null,
          officialProductPageUrl: null
        }
      };
    }
    // Unsafe / unsuccessful repair — fall through to progressive discovery.
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
    const localUrl = await persistAcceptedImageLocally({
      selected: execution.selected,
      selectedAsset: execution.selectedAsset,
      deps
    });
    upsertAcceptedLocalImage({
      job,
      selected: execution.selected,
      localUrl
    });
    imageSaved = true;
  } else {
    markProductImageEmpty(job.entity_type, job.entity_id, "no_acceptable_image");
  }

  assertInventoryImageUnchanged(job.entity_type, job.entity_id, inventoryImageUrl);

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
