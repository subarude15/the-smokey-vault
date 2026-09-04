/**
 * Discover, score, and verify product image candidates for an identified bottle.
 * Persists provenance only — does not rehost third-party images in this PR.
 */
import type { BottleCandidate } from "../candidate/types.js";
import {
  isWebSearchError,
  searchImageHitsFromSearx,
  searchWebHits,
  type WebSearchHit
} from "../web-search.js";
import { classifyImageSource } from "./image-sources.js";
import { isAuthoritativeSource } from "./tasting-notes-sources.js";
import {
  classifySourceUrlWithDiscovery,
  discoverOfficialDomains
} from "./official-domain.js";
import {
  buildImageQueryTiers,
  identityFromCandidate
} from "./search-query.js";
import {
  extractStructuredProductFacts,
  fetchBoundedPageHtml
} from "./page-extract.js";
import { extractOfficialPageImgCandidatesAsync } from "./official-page-images.js";
import {
  evaluateCandidate,
  hardRejectCandidate,
  meetsAcceptanceThreshold,
  scoreImageCandidateBase,
  type ImageCandidate,
  type ScoredImageCandidate,
  type VisionVerification
} from "./image-score.js";
import {
  IMAGE_ACCEPTANCE_THRESHOLD,
  IMAGE_MIN_HEIGHT,
  IMAGE_MIN_WIDTH,
  IMAGE_MAX_VISION_CHECKS,
  IMAGE_VISION_CANDIDATE_FLOOR
} from "./image-thresholds.js";
import { verifyProductImage } from "./image-verify.js";
import { readImageDimensionsFromHeader } from "./image-dimensions.js";
import {
  buildImageScoreComponents,
  checkVerificationDiagnosticConsistency,
  collectImageRejectionReasons,
  ImageCandidateDiagnosticStore,
  imageCandidateIdFromUrl,
  isNonImageAssetUrl,
  isVerificationStageDiagnostic,
  mergeImageSeedsByNormalizedUrl,
  orderSeedsForProbe,
  safeImageUrlParts,
  summarizeImageCandidateDiagnostics
} from "./image-candidate-diagnostics.js";
import {
  buildOfficialProductPageBroadQueries,
  buildOfficialProductPageQueries,
  discoverOfficialProductUrlsFromSite,
  extractExpressionTokensFromHits,
  filterHitsByOfficialRegisteredDomain,
  hasOfficialProductDetailHit,
  hostIsUnderOfficialDomain,
  safeOfficialPageDisplay,
  selectBestOfficialProductPage
} from "./official-product-page.js";
import {
  sanitizeJobDiagnostics,
  type EnrichmentDiagnosticStage,
  type JobDiagnosticsPayload,
  type NoResultReason
} from "./diagnostics.js";
import {
  extractFwgsPlcbImages,
  fetchFwgsImageViaFigranium,
  deriveFwgsImageRenditionUrl,
  filterValidatedFwgsImageUrls,
  fwgsPdpUrlForItem,
  isFwgsFigraniumConfigured,
  isFwgsFigraniumImageFetchConfigured,
  normalizePlcbItem,
  plcbItemFromCandidate,
  validateFwgsImageUrl,
  isFwgsFigraniumProviderError,
  type FwgsFigraniumImageResult,
  type FwgsImageFetchOutcome
} from "../../fwgs-figranium.js";

const MAX_PROBE_SEEDS = 20;
const MAX_OFFICIAL_PAGE_ASSET_STAGES = 8;
const MAX_OFFICIAL_PAGES_TO_FETCH = 4;

export type ImageProbeDetail =
  | "direct_probe_ok"
  | "direct_probe_http_rejected"
  | "direct_probe_timeout"
  | "figranium_fetch_fallback_attempted"
  | "figranium_fetch_fallback_ok"
  | "figranium_fetch_fallback_failed"
  | "fwgs_higher_res_rendition_attempted"
  | "fwgs_higher_res_rendition_preferred";

export type ImageMeta = {
  width: number | null;
  height: number | null;
  mimeType: string | null;
  reachable: boolean;
  dimensionsSource?: "seed" | "image_header" | "unknown" | null;
  /** Bounded probe diagnostic tokens (no secrets / unbounded URLs). */
  probeDetails?: ImageProbeDetail[];
  httpStatus?: number | null;
  /** Decoded image bytes as base64 when obtained via Figranium fallback (for vision). */
  imageBase64?: string | null;
  /** Final URL used after optional FWGS rendition upgrade. */
  resolvedUrl?: string | null;
};

export type ImageEnrichmentDeps = {
  searchWebHits?: (query: string, limit?: number) => Promise<WebSearchHit[]>;
  searchImageHits?: (query: string, limit?: number) => Promise<ImageCandidateSeed[]>;
  probeImageMeta?: (url: string) => Promise<ImageMeta>;
  fetchPageHtml?: (url: string) => Promise<string | null>;
  verifyImage?: (request: {
    candidate: BottleCandidate;
    imageUrl: string;
    imageBase64?: string | null;
  }) => Promise<VisionVerification | null>;
  /** Previously persisted official product page (reuse; do not rediscover blindly). */
  knownOfficialProductPageUrl?: string | null;
  /** Optional override for FWGS Figranium image extraction (tests). */
  extractFwgsPlcbImages?: (
    plcbItem: string,
    pdpUrl?: string | null
  ) => Promise<FwgsFigraniumImageResult | null>;
  /** Optional override for FWGS Figranium browser image fetch (tests). */
  fetchFwgsImageViaFigranium?: (
    imageUrl: string,
    plcbItem: string
  ) => Promise<FwgsImageFetchOutcome>;
};

export type ImageCandidateSeed = {
  url: string;
  sourceUrl?: string | null;
  width?: number | null;
  height?: number | null;
  mimeType?: string | null;
  /** Set only for Figranium FWGS PLCB-bound seeds — never SearXNG. */
  identityMatched?: boolean;
};

export type ImageEnrichmentResult = {
  selected: ScoredImageCandidate | null;
  evaluated: ScoredImageCandidate[];
  errors: string[];
  diagnostics: JobDiagnosticsPayload;
  /** Best official product-detail page selected this run (if any). */
  selectedOfficialProductPageUrl?: string | null;
};

function imageSearchQuery(candidate: BottleCandidate): string {
  const tiers = buildImageQueryTiers(identityFromCandidate(candidate));
  return tiers[0]?.query ?? "";
}

/** Default SearXNG image category search (throws WebSearchError on provider failure). */
export async function searchImageHits(query: string, limit = 8): Promise<ImageCandidateSeed[]> {
  return searchImageHitsFromSearx(query, limit);
}

async function defaultProbe(url: string): Promise<ImageMeta> {
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
      // Enough bytes for JPEG/PNG/WebP headers; still the same candidate URL.
      headers: { Range: "bytes=0-65535" }
    });
    const mimeType = (response.headers.get("content-type") ?? "").split(";")[0].trim() || null;
    const reachable = response.ok || response.status === 206;
    if (!reachable) {
      return {
        width: null,
        height: null,
        mimeType,
        reachable: false,
        dimensionsSource: null,
        probeDetails: ["direct_probe_http_rejected"],
        httpStatus: response.status
      };
    }
    const buf = Buffer.from(await response.arrayBuffer());
    const dims = readImageDimensionsFromHeader(buf);
    return {
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      mimeType: mimeType?.startsWith("image/") ? mimeType : mimeType,
      reachable: true,
      dimensionsSource: dims ? "image_header" : "unknown",
      probeDetails: ["direct_probe_ok"],
      httpStatus: response.status
    };
  } catch (error) {
    const name =
      error && typeof error === "object" && "name" in error
        ? String((error as { name?: unknown }).name ?? "")
        : "";
    const detail: ImageProbeDetail =
      name === "TimeoutError" || name === "AbortError"
        ? "direct_probe_timeout"
        : "direct_probe_http_rejected";
    return {
      width: null,
      height: null,
      mimeType: null,
      reachable: false,
      dimensionsSource: null,
      probeDetails: [detail],
      httpStatus: null
    };
  }
}

/**
 * Direct probe first. For validated FWGS URLs with a trusted PLCB item:
 * 1) Prefer a same-asset higher-res rendition (width/height=1200) when actual dims >= min.
 * 2) Fall back to Figranium browser fetch when the direct probe fails.
 */
export async function probeImageMetaWithFwgsFallback(
  url: string,
  options: {
    plcbItem?: string | null;
    fetchFwgsImageViaFigranium?: (
      imageUrl: string,
      plcbItem: string
    ) => Promise<FwgsImageFetchOutcome>;
  } = {}
): Promise<ImageMeta> {
  const plcb = normalizePlcbItem(String(options.plcbItem ?? ""));
  const fetchFn = options.fetchFwgsImageViaFigranium ?? fetchFwgsImageViaFigranium;
  const canFigranium =
    Boolean(options.fetchFwgsImageViaFigranium) || isFwgsFigraniumImageFetchConfigured();
  const fwgsValidated = Boolean(plcb && validateFwgsImageUrl(url, plcb));

  const probeOne = async (targetUrl: string): Promise<ImageMeta> => {
    const direct = await defaultProbe(targetUrl);
    if (direct.reachable) {
      return { ...direct, resolvedUrl: targetUrl };
    }
    if (!plcb || !validateFwgsImageUrl(targetUrl, plcb) || !canFigranium) {
      return { ...direct, resolvedUrl: targetUrl };
    }
    const details: ImageProbeDetail[] = [
      ...(direct.probeDetails ?? []),
      "figranium_fetch_fallback_attempted"
    ];
    const fetched = await fetchFn(targetUrl, plcb);
    if (!fetched.ok) {
      return {
        ...direct,
        probeDetails: [...details, "figranium_fetch_fallback_failed"],
        resolvedUrl: targetUrl
      };
    }
    return {
      width: fetched.image.width,
      height: fetched.image.height,
      mimeType: fetched.image.contentType,
      reachable: true,
      dimensionsSource: fetched.image.width != null ? "image_header" : "unknown",
      probeDetails: [...details, "figranium_fetch_fallback_ok"],
      httpStatus: direct.httpStatus ?? null,
      imageBase64: fetched.image.bytes.toString("base64"),
      resolvedUrl: targetUrl
    };
  };

  const meetsMinResolution = (meta: ImageMeta): boolean =>
    meta.width != null
    && meta.height != null
    && meta.width >= IMAGE_MIN_WIDTH
    && meta.height >= IMAGE_MIN_HEIGHT;

  if (fwgsValidated) {
    const preferred = deriveFwgsImageRenditionUrl(url, plcb!, {
      width: 1200,
      height: 1200
    });
    if (preferred && preferred !== url) {
      const preferredMeta = await probeOne(preferred);
      const details: ImageProbeDetail[] = [
        ...(preferredMeta.probeDetails ?? []),
        "fwgs_higher_res_rendition_attempted"
      ];
      if (preferredMeta.reachable && meetsMinResolution(preferredMeta)) {
        return {
          ...preferredMeta,
          probeDetails: [...details, "fwgs_higher_res_rendition_preferred"],
          resolvedUrl: preferred
        };
      }
      // Prefer failed or still below min — continue with the original asset URL.
    }
  }

  return probeOne(url);
}

function classifyVisionError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("vision_parse_failed") || m === "vision_parse_failed") return "vision_parse_failed";
  if (m.includes("vision_provider_error") || m.includes("ollama")) return "vision_provider_error";
  if (m.includes("fetch_failed")) return "fetch_failed";
  return "vision_provider_error";
}

async function defaultFetchPageHtml(url: string): Promise<string | null> {
  return fetchBoundedPageHtml(url);
}

/** Extract og:image / JSON-LD Product image URLs from an authoritative HTML page. */
export function extractProductImageUrlsFromHtml(html: string, pageUrl: string): string[] {
  return extractStructuredProductFacts(html, pageUrl).imageUrls;
}

function toCandidate(
  seed: ImageCandidateSeed,
  brand: string | null,
  name: string | null,
  discoveredOfficialDomains: string[] = []
): ImageCandidate {
  const sourceType = classifyImageSource(seed.url, {
    brand,
    name,
    pageUrl: seed.sourceUrl,
    discoveredOfficialDomains
  });
  return {
    url: seed.url,
    sourceUrl: seed.sourceUrl ?? null,
    sourceType,
    width: seed.width ?? null,
    height: seed.height ?? null,
    mimeType: seed.mimeType ?? null,
    identityMatched: seed.identityMatched === true ? true : undefined
  };
}

function emptyImageDiagnostics(): JobDiagnosticsPayload {
  return {
    jobType: "image",
    noResultReason: null,
    summary: null,
    stages: [],
    accepted: [],
    unresolved: []
  };
}

type OfficialPageIngestStats = {
  imagesFromMeta: number;
  pagesWithoutImageMeta: number;
  prefilteredCount: number;
};

/** Fetch one official page and push page-scoped image seeds + diagnostics. */
async function ingestOfficialPageForImages(options: {
  pageUrl: string;
  brand: string | null;
  name: string | null;
  fetchHtml: (url: string) => Promise<string | null>;
  seeds: ImageCandidateSeed[];
  stages: EnrichmentDiagnosticStage[];
}): Promise<OfficialPageIngestStats> {
  const stats: OfficialPageIngestStats = {
    imagesFromMeta: 0,
    pagesWithoutImageMeta: 0,
    prefilteredCount: 0
  };
  const html = await options.fetchHtml(options.pageUrl);
  if (!html) {
    options.stages.push({
      stage: "official_image_meta",
      status: "error",
      reason: "official_page_fetch_failed",
      sourceUrls: [options.pageUrl]
    });
    return stats;
  }

  const facts = extractStructuredProductFacts(html, options.pageUrl);
  const imageUrls = facts.imageUrls.length
    ? facts.imageUrls
    : extractProductImageUrlsFromHtml(html, options.pageUrl);

  if (imageUrls.length) {
    stats.imagesFromMeta = imageUrls.length;
    for (const imageUrl of imageUrls) {
      if (isNonImageAssetUrl(imageUrl)) continue;
      const safe = safeImageUrlParts(imageUrl);
      if (
        options.stages.filter((s) => s.stage === "official_page_asset").length
        < MAX_OFFICIAL_PAGE_ASSET_STAGES
      ) {
        options.stages.push({
          stage: "official_page_asset",
          status: "ok",
          reason: `${safe.host}${safe.path}`.slice(0, 160),
          sourceUrls: [options.pageUrl]
        });
      }
      options.seeds.push({ url: imageUrl, sourceUrl: options.pageUrl });
    }
    options.stages.push({
      stage: "official_image_meta",
      status: "ok",
      acceptedCount: imageUrls.length,
      reason: [
        facts.usedOpenGraph ? "og:image" : null,
        facts.usedJsonLd ? "json_ld_image" : null,
        facts.hasJsonLdProduct ? "json_ld_product" : null,
        facts.ogTypeProduct ? "og_type_product" : null
      ]
        .filter(Boolean)
        .join(",") || "image_metadata",
      sourceUrls: [options.pageUrl]
    });
    return stats;
  }

  stats.pagesWithoutImageMeta = 1;
  options.stages.push({
    stage: "official_image_meta",
    status: "no_result",
    reason: "official_page_no_image_metadata",
    sourceUrls: [options.pageUrl]
  });

  const imgScan = await extractOfficialPageImgCandidatesAsync(html, options.pageUrl, {
    brand: options.brand,
    name: options.name
  });
  options.stages.push({
    stage: "official_page_img_scan",
    status: imgScan.scanned ? "ok" : "no_result",
    candidateCount: imgScan.scanned,
    reason: imgScan.clientRenderedShell
      ? "official_page_client_rendered: static HTML contained no product image assets"
      : `${imgScan.scanned} image refs found`,
    sourceUrls: [options.pageUrl]
  });
  if (imgScan.diagnostic === "official_page_client_rendered") {
    options.stages.push({
      stage: "official_page_client_rendered",
      status: "no_result",
      reason: "static HTML contained no product image assets",
      sourceUrls: [options.pageUrl]
    });
  }
  const rejectBlob = Object.entries(imgScan.rejectedReasons)
    .map(([k, v]) => `${k}:${v}`)
    .join(",")
    .slice(0, 160);
  const emptyReason =
    imgScan.diagnostic === "official_page_client_rendered"
      ? "official_page_client_rendered"
      : rejectBlob || imgScan.diagnostic || "logos_or_small_assets_only";
  options.stages.push({
    stage: "official_page_img_prefilter",
    status: imgScan.prefiltered.length ? "ok" : "no_result",
    candidateCount: imgScan.scanned,
    acceptedCount: imgScan.prefiltered.length,
    reason: imgScan.prefiltered.length
      ? `${imgScan.prefiltered.length} candidates`
      : emptyReason,
    sourceUrls: [options.pageUrl]
  });
  for (const img of imgScan.prefiltered) {
    if (isNonImageAssetUrl(img.url)) continue;
    const safe = safeImageUrlParts(img.url);
    if (
      options.stages.filter((s) => s.stage === "official_page_asset").length
      < MAX_OFFICIAL_PAGE_ASSET_STAGES
    ) {
      options.stages.push({
        stage: "official_page_asset",
        status: "ok",
        reason: `${safe.host}${safe.path}`.slice(0, 160),
        sourceUrls: [options.pageUrl]
      });
    }
    options.seeds.push({
      url: img.url,
      sourceUrl: options.pageUrl,
      width: img.width,
      height: img.height
    });
  }
  stats.prefilteredCount = imgScan.prefiltered.filter((i) => !isNonImageAssetUrl(i.url)).length;
  if (stats.prefilteredCount) {
    options.stages.push({
      stage: "official_page_img_candidate",
      status: "ok",
      acceptedCount: stats.prefilteredCount,
      reason: "accepted for verification",
      sourceUrls: imgScan.prefiltered
        .filter((i) => !isNonImageAssetUrl(i.url))
        .slice(0, 6)
        .map((i) => i.url)
    });
  }
  return stats;
}

type ImageVisionBudget = {
  limit: number;
  used: number;
};

type ImageProbeBudget = {
  limit: number;
  used: number;
};

type EvaluateImageSeedsOptions = {
  candidate: BottleCandidate;
  seeds: ImageCandidateSeed[];
  discoveredDomains: string[];
  probe: (url: string) => Promise<ImageMeta>;
  verify: (request: {
    candidate: BottleCandidate;
    imageUrl: string;
    imageBase64?: string | null;
  }) => Promise<VisionVerification | null>;
  diagStore: ImageCandidateDiagnosticStore;
  figraniumImageBase64ByUrl: Map<string, string>;
  errors: string[];
  /** Shared per-execution vision budget (not per-stage). */
  visionBudget: ImageVisionBudget;
  /** Shared per-execution network-probe budget (not per-stage). */
  probeBudget: ImageProbeBudget;
  /**
   * Normalized candidate IDs already evaluated this execution.
   * Later stages must not re-probe / re-vision the same asset.
   */
  evaluatedCandidateIds: Set<string>;
  /** Skip probe/vision for definitively unapproved sources (generic SERP stage). */
  skipProbeForUnapprovedSources?: boolean;
  /** Stage label prefix for progressive discovery diagnostics. */
  evaluationStage?: string;
  selectedStage?: string;
  selectedReason?: string;
};

type EvaluateImageSeedsResult = {
  selected: ScoredImageCandidate | null;
  evaluated: ScoredImageCandidate[];
  stages: EnrichmentDiagnosticStage[];
  uniqueSeedCount: number;
  probedCount: number;
  /**
   * Provider/system failures (Figranium, vision, verification fetch) —
   * do not widen discovery blindly.
   */
  transientSystemFailure: boolean;
};

function isTransientVisionError(reason: string): boolean {
  return (
    reason === "vision_provider_error"
    || reason === "vision_parse_failed"
    || reason === "fetch_failed"
  );
}

function markCandidateEvaluated(
  evaluatedIds: Set<string>,
  ...urls: Array<string | null | undefined>
): void {
  for (const raw of urls) {
    const id = imageCandidateIdFromUrl(String(raw ?? ""));
    if (id) evaluatedIds.add(id);
  }
}

/**
 * Merge/dedupe seeds → hard-filter → probe → score → vision → select.
 * Invoked progressively (FWGS → official → generic) so discovery can stop early.
 */
export async function evaluateImageSeeds(
  options: EvaluateImageSeedsOptions
): Promise<EvaluateImageSeedsResult> {
  const brand = options.candidate.brand.value;
  const name = options.candidate.name.value;
  const stages: EnrichmentDiagnosticStage[] = [];
  const evaluationStage = options.evaluationStage ?? "candidates";

  const seenSeeds = mergeImageSeedsByNormalizedUrl(
    options.seeds.filter((s) => {
      const url = String(s.url ?? "").trim();
      return Boolean(url) && !isNonImageAssetUrl(url);
    })
  );
  const uniqueSeeds = seenSeeds.filter((s) => Boolean(String(s.url ?? "").trim()));
  // Prefer page-scoped seeds; shared probeBudget limits actual network probes.
  const probeSeeds = orderSeedsForProbe(uniqueSeeds);

  const probed: ImageCandidate[] = [];
  const dimensionSources = new Map<string, "seed" | "image_header" | "unknown">();
  let fetchFailed = 0;
  let fwgsDirectBlocked = 0;
  let fwgsFigraniumFetchOk = 0;
  let fwgsFigraniumFetchFailed = 0;
  let skippedUnapproved = 0;
  let skippedAlreadyEvaluated = 0;
  let skippedProbeBudget = 0;
  let transientSystemFailure = false;
  const preRejected: ScoredImageCandidate[] = [];

  for (const seed of probeSeeds) {
    const candidateId = imageCandidateIdFromUrl(seed.url);
    if (candidateId && options.evaluatedCandidateIds.has(candidateId)) {
      skippedAlreadyEvaluated += 1;
      const preview = toCandidate(seed, brand, name, options.discoveredDomains);
      options.diagStore.ensureDiscovered({
        url: seed.url,
        sourceType: preview.sourceType,
        sourceUrl: seed.sourceUrl,
        width: seed.width,
        height: seed.height,
        mimeType: seed.mimeType
      });
      continue;
    }

    const preview = toCandidate(seed, brand, name, options.discoveredDomains);
    options.diagStore.ensureDiscovered({
      url: seed.url,
      sourceType: preview.sourceType,
      sourceUrl: seed.sourceUrl,
      width: seed.width,
      height: seed.height,
      mimeType: seed.mimeType
    });

    if (
      options.skipProbeForUnapprovedSources
      && (preview.sourceType === "unknown" || hardRejectCandidate(preview).reason === "unapproved_source")
    ) {
      skippedUnapproved += 1;
      markCandidateEvaluated(options.evaluatedCandidateIds, seed.url);
      preRejected.push({
        ...preview,
        score: 0,
        rejected: true,
        rejectionReason: "unapproved_source",
        verified: false
      });
      options.diagStore.markHardFilter({
        url: preview.url,
        sourceType: preview.sourceType,
        sourceUrl: preview.sourceUrl,
        width: preview.width,
        height: preview.height,
        mimeType: preview.mimeType,
        dimensionsSource: null,
        fetchStatus: "ok",
        reasons: ["unapproved_source"]
      });
      continue;
    }

    if (options.probeBudget.used >= options.probeBudget.limit) {
      skippedProbeBudget += 1;
      markCandidateEvaluated(options.evaluatedCandidateIds, seed.url);
      preRejected.push({
        ...preview,
        score: 0,
        rejected: true,
        rejectionReason: "not_checked",
        verified: false
      });
      options.diagStore.markHardFilter({
        url: preview.url,
        sourceType: preview.sourceType,
        sourceUrl: preview.sourceUrl,
        width: preview.width,
        height: preview.height,
        mimeType: preview.mimeType,
        dimensionsSource: null,
        fetchStatus: "ok",
        reasons: ["not_checked"]
      });
      continue;
    }

    let meta: ImageMeta = {
      width: seed.width ?? null,
      height: seed.height ?? null,
      mimeType: seed.mimeType ?? null,
      reachable: true,
      dimensionsSource: seed.width != null && seed.height != null ? null : "unknown"
    };
    let dimsSource: "seed" | "image_header" | "unknown" =
      seed.width != null && seed.height != null ? "seed" : "unknown";
    try {
      options.probeBudget.used += 1;
      const probedMeta = await options.probe(seed.url);
      const probeDetails = Array.isArray(probedMeta.probeDetails)
        ? probedMeta.probeDetails.filter((value): value is ImageProbeDetail => typeof value === "string")
        : [];
      const width = probedMeta.width ?? seed.width ?? null;
      const height = probedMeta.height ?? seed.height ?? null;
      if (probedMeta.width != null && probedMeta.height != null) {
        dimsSource =
          probedMeta.dimensionsSource === "unknown" ? "unknown" : "image_header";
      } else if (seed.width != null && seed.height != null) {
        dimsSource = "seed";
      }
      meta = {
        width,
        height,
        mimeType: probedMeta.mimeType ?? seed.mimeType ?? null,
        reachable: probedMeta.reachable,
        dimensionsSource: dimsSource,
        probeDetails,
        httpStatus: probedMeta.httpStatus ?? null,
        imageBase64: probedMeta.imageBase64 ?? null,
        resolvedUrl: probedMeta.resolvedUrl ?? seed.url
      };
    } catch (error) {
      if (isFwgsFigraniumProviderError(error)) {
        options.errors.push(error.message);
        transientSystemFailure = true;
        markCandidateEvaluated(options.evaluatedCandidateIds, seed.url);
        options.diagStore.markHardFilter({
          url: preview.url,
          sourceType: preview.sourceType,
          sourceUrl: preview.sourceUrl,
          width: preview.width,
          height: preview.height,
          mimeType: preview.mimeType,
          dimensionsSource: null,
          fetchStatus: "failed",
          reasons: ["provider_error", error.kind].slice(0, 8)
        });
        break;
      }
      options.errors.push(error instanceof Error ? error.message : "Image probe failed");
      meta.reachable = false;
    }
    if (transientSystemFailure) break;
    if (!meta.reachable) {
      fetchFailed += 1;
      const failedCandidate = toCandidate(seed, brand, name, options.discoveredDomains);
      const failDetails = Array.isArray(meta.probeDetails) ? meta.probeDetails : [];
      if (failDetails.includes("direct_probe_http_rejected") || failDetails.includes("direct_probe_timeout")) {
        fwgsDirectBlocked += 1;
      }
      if (failDetails.includes("figranium_fetch_fallback_failed")) {
        fwgsFigraniumFetchFailed += 1;
      }
      markCandidateEvaluated(options.evaluatedCandidateIds, seed.url, meta.resolvedUrl);
      options.diagStore.markHardFilter({
        url: failedCandidate.url,
        sourceType: failedCandidate.sourceType,
        sourceUrl: failedCandidate.sourceUrl,
        width: failedCandidate.width,
        height: failedCandidate.height,
        mimeType: failedCandidate.mimeType,
        dimensionsSource: null,
        fetchStatus: "failed",
        reasons: ["fetch_failed", ...failDetails].slice(0, 8)
      });
      continue;
    }
    const resolvedUrl =
      typeof meta.resolvedUrl === "string" && meta.resolvedUrl.trim()
        ? meta.resolvedUrl.trim()
        : seed.url;
    if (typeof meta.imageBase64 === "string" && meta.imageBase64.trim()) {
      options.figraniumImageBase64ByUrl.set(resolvedUrl, meta.imageBase64.trim());
    }
    if ((meta.probeDetails ?? []).includes("figranium_fetch_fallback_ok")) {
      fwgsFigraniumFetchOk += 1;
    }
    if (
      (meta.probeDetails ?? []).includes("direct_probe_http_rejected")
      || (meta.probeDetails ?? []).includes("direct_probe_timeout")
    ) {
      fwgsDirectBlocked += 1;
    }
    const item = toCandidate(
      {
        ...seed,
        url: resolvedUrl,
        width: meta.width,
        height: meta.height,
        mimeType: meta.mimeType
      },
      brand,
      name,
      options.discoveredDomains
    );
    markCandidateEvaluated(options.evaluatedCandidateIds, seed.url, resolvedUrl);
    dimensionSources.set(imageCandidateIdFromUrl(item.url), dimsSource);
    probed.push(item);
  }

  const candidateReasonParts: string[] = [];
  if (!probed.length) {
    candidateReasonParts.push(
      uniqueSeeds.length
        ? skippedUnapproved && skippedUnapproved === uniqueSeeds.length
          ? "unapproved_source"
          : transientSystemFailure
            ? "provider_error"
            : "fetch_failed"
        : "no_image_candidates"
    );
  }
  if (skippedAlreadyEvaluated > 0) {
    candidateReasonParts.push(`already_evaluated_skipped:${skippedAlreadyEvaluated}`);
  }
  if (skippedProbeBudget > 0) {
    candidateReasonParts.push(`probe_budget_exhausted:${skippedProbeBudget}`);
  }
  if (skippedUnapproved > 0) {
    candidateReasonParts.push(`unapproved_source_skipped:${skippedUnapproved}`);
  }
  if (fwgsDirectBlocked > 0) {
    candidateReasonParts.push(`direct_fwgs_image_fetch_blocked:${fwgsDirectBlocked}`);
  }
  if (fwgsFigraniumFetchOk > 0) {
    candidateReasonParts.push(`fwgs_image_discovered_via_figranium:${fwgsFigraniumFetchOk}`);
    candidateReasonParts.push(`figranium_browser_fetch_succeeded:${fwgsFigraniumFetchOk}`);
  }
  if (fwgsFigraniumFetchFailed > 0) {
    candidateReasonParts.push(`figranium_browser_fetch_failed:${fwgsFigraniumFetchFailed}`);
  }

  stages.push({
    stage: evaluationStage,
    status: probed.length ? "ok" : transientSystemFailure ? "error" : "no_result",
    candidateCount: uniqueSeeds.length,
    acceptedCount: probed.length,
    rejectedCount: fetchFailed + skippedUnapproved + skippedProbeBudget,
    reason: candidateReasonParts.length ? candidateReasonParts.join(",").slice(0, 160) : undefined,
    sourceUrls: uniqueSeeds.slice(0, 10).map((s) => s.url)
  });

  if (evaluationStage !== "candidates") {
    stages.push({
      stage: "candidates",
      status: probed.length ? "ok" : transientSystemFailure ? "error" : "no_result",
      candidateCount: uniqueSeeds.length,
      acceptedCount: probed.length,
      rejectedCount: fetchFailed + skippedUnapproved + skippedProbeBudget,
      reason: candidateReasonParts.length ? candidateReasonParts.join(",").slice(0, 160) : undefined,
      sourceUrls: uniqueSeeds.slice(0, 10).map((s) => s.url)
    });
  }

  if (transientSystemFailure) {
    return {
      selected: null,
      evaluated: preRejected.slice(0, 20),
      stages,
      uniqueSeedCount: uniqueSeeds.length,
      probedCount: probed.length,
      transientSystemFailure: true
    };
  }

  if (!probed.length) {
    return {
      selected: null,
      evaluated: preRejected.slice(0, 20),
      stages,
      uniqueSeedCount: uniqueSeeds.length,
      probedCount: 0,
      transientSystemFailure: false
    };
  }

  const scored: ScoredImageCandidate[] = [...preRejected];
  const visionQueue: ImageCandidate[] = [];
  const rejectionCounts: Record<string, number> = {};

  for (const item of probed) {
    const hard = hardRejectCandidate(item);
    if (hard.rejected) {
      const reason = hard.reason || "hard_reject";
      rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
      scored.push({
        ...item,
        score: 0,
        rejected: true,
        rejectionReason: reason,
        verified: false
      });
      options.diagStore.markHardFilter({
        url: item.url,
        sourceType: item.sourceType,
        sourceUrl: item.sourceUrl,
        width: item.width,
        height: item.height,
        mimeType: item.mimeType,
        dimensionsSource: dimensionSources.get(imageCandidateIdFromUrl(item.url)) ?? "unknown",
        fetchStatus: "ok",
        reasons: [reason]
      });
      continue;
    }
    if (item.sourceType === "unknown") {
      rejectionCounts.unknown_source = (rejectionCounts.unknown_source ?? 0) + 1;
    }
    const base = scoreImageCandidateBase(item);
    if (base >= IMAGE_VISION_CANDIDATE_FLOOR) {
      visionQueue.push(item);
    } else {
      rejectionCounts.score_below_threshold = (rejectionCounts.score_below_threshold ?? 0) + 1;
      scored.push({
        ...item,
        score: base,
        rejected: true,
        rejectionReason: "below_vision_floor",
        verified: false
      });
      options.diagStore.markHardFilter({
        url: item.url,
        sourceType: item.sourceType,
        sourceUrl: item.sourceUrl,
        width: item.width,
        height: item.height,
        mimeType: item.mimeType,
        dimensionsSource: dimensionSources.get(imageCandidateIdFromUrl(item.url)) ?? "unknown",
        fetchStatus: "ok",
        reasons: ["below_vision_floor"],
        score: base
      });
    }
  }

  stages.push({
    stage: "hard_filter",
    status: visionQueue.length ? "ok" : "no_result",
    candidateCount: probed.length,
    acceptedCount: visionQueue.length,
    rejectedCount: probed.length - visionQueue.length,
    reason: Object.entries(rejectionCounts)
      .map(([k, v]) => `${k}:${v}`)
      .join(",")
      .slice(0, 160)
  });

  visionQueue.sort((a, b) => scoreImageCandidateBase(b) - scoreImageCandidateBase(a));
  let selected: ScoredImageCandidate | null = null;
  let verificationRejected = 0;
  let scoreRejected = 0;
  const remainingVisionSlots = Math.max(
    0,
    options.visionBudget.limit - options.visionBudget.used
  );
  const sentToVision = visionQueue.slice(0, remainingVisionSlots);
  let visionCallsStarted = 0;

  const verificationDiagIdsBefore = new Set(
    options.diagStore
      .toArray()
      .filter(isVerificationStageDiagnostic)
      .map((d) => d.candidateId)
      .filter((id): id is string => Boolean(id))
  );

  for (const item of sentToVision) {
    visionCallsStarted += 1;
    options.visionBudget.used += 1;
    const dimsSource = dimensionSources.get(imageCandidateIdFromUrl(item.url)) ?? "unknown";
    options.diagStore.markVerificationStarted({
      url: item.url,
      sourceType: item.sourceType,
      sourceUrl: item.sourceUrl,
      width: item.width,
      height: item.height,
      mimeType: item.mimeType,
      dimensionsSource: dimsSource
    });

    let vision: VisionVerification | null = null;
    let visionError: string | null = null;
    try {
      vision = await options.verify({
        candidate: options.candidate,
        imageUrl: item.url,
        imageBase64: options.figraniumImageBase64ByUrl.get(item.url) ?? null
      });
      if (!vision) {
        visionError = "vision_parse_failed";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Vision verify failed";
      options.errors.push(message);
      visionError = classifyVisionError(message);
    }

    if (visionError || !vision) {
      const reason = visionError || "vision_parse_failed";
      scored.push({
        ...item,
        score: scoreImageCandidateBase(item),
        rejected: true,
        rejectionReason: reason,
        verified: false
      });
      options.diagStore.markVerificationResult({
        url: item.url,
        sourceType: item.sourceType,
        sourceUrl: item.sourceUrl,
        width: item.width,
        height: item.height,
        mimeType: item.mimeType,
        dimensionsSource: dimsSource,
        fetchStatus: reason === "fetch_failed" ? "failed" : "ok",
        vision: null,
        visionError: reason,
        score: scoreImageCandidateBase(item),
        accepted: false,
        rejectionReasons: [reason],
        stageReached: "verification"
      });
      if (isTransientVisionError(reason)) {
        transientSystemFailure = true;
        break;
      }
      verificationRejected += 1;
      continue;
    }

    const evaluated = evaluateCandidate(item, vision);
    if (!evaluated.rejected && !meetsAcceptanceThreshold(evaluated.score)) {
      evaluated.rejected = true;
      evaluated.rejectionReason = "score_below_threshold";
      scoreRejected += 1;
    } else if (evaluated.rejected) {
      verificationRejected += 1;
    } else {
      selected = evaluated;
    }
    scored.push(evaluated);

    const rejectionReasons = collectImageRejectionReasons({
      hardReason: null,
      vision,
      visionError: null,
      score: evaluated.score,
      accepted: Boolean(selected && selected.url === evaluated.url),
      verified: evaluated.verified
    });
    if (evaluated.rejected && evaluated.rejectionReason) {
      if (!rejectionReasons.includes(evaluated.rejectionReason)) {
        rejectionReasons.unshift(evaluated.rejectionReason);
      }
    }

    const isAccepted = Boolean(selected && selected.url === evaluated.url && !evaluated.rejected);
    const stageReached = isAccepted
      ? "accepted"
      : evaluated.rejectionReason === "score_below_threshold"
        ? "scoring"
        : "verification";

    options.diagStore.markVerificationResult({
      url: item.url,
      sourceType: item.sourceType,
      sourceUrl: item.sourceUrl,
      width: item.width,
      height: item.height,
      mimeType: item.mimeType,
      dimensionsSource: dimsSource,
      vision,
      visionError: null,
      score: evaluated.score,
      scoreComponents: buildImageScoreComponents(item, vision),
      accepted: isAccepted,
      rejectionReasons: evaluated.rejected ? rejectionReasons : [],
      stageReached
    });

    if (selected) break;
  }

  let notCheckedCount = 0;
  const visionHandled = visionCallsStarted;
  for (const item of visionQueue.slice(visionHandled)) {
    notCheckedCount += 1;
    scored.push({
      ...item,
      score: scoreImageCandidateBase(item),
      rejected: true,
      rejectionReason: "not_checked",
      verified: false
    });
    options.diagStore.markVerificationResult({
      url: item.url,
      sourceType: item.sourceType,
      sourceUrl: item.sourceUrl,
      width: item.width,
      height: item.height,
      mimeType: item.mimeType,
      dimensionsSource: dimensionSources.get(imageCandidateIdFromUrl(item.url)) ?? "unknown",
      vision: null,
      visionError: "not_checked",
      score: scoreImageCandidateBase(item),
      accepted: false,
      rejectionReasons: ["not_checked"],
      stageReached: "verification"
    });
  }

  const verificationCountFromStages = visionCallsStarted + notCheckedCount;
  const stageVerificationDiags = options.diagStore.toArray().filter(
    (d) =>
      isVerificationStageDiagnostic(d)
      && d.candidateId
      && !verificationDiagIdsBefore.has(d.candidateId)
  );
  const consistency = checkVerificationDiagnosticConsistency({
    verificationCountFromStages,
    diagnostics: stageVerificationDiags
  });
  if (!consistency.ok && consistency.reason) {
    stages.push({
      stage: "verification_diagnostic_mismatch",
      status: "error",
      candidateCount: verificationCountFromStages,
      acceptedCount: consistency.diagnosticCount,
      reason: consistency.reason
    });
  }

  stages.push({
    stage: "verify",
    status: selected ? "ok" : transientSystemFailure ? "error" : "no_result",
    candidateCount: verificationCountFromStages,
    acceptedCount: selected ? 1 : 0,
    rejectedCount: verificationRejected + scoreRejected,
    reason: selected
      ? `accepted_score:${selected.score}`
      : transientSystemFailure
        ? "provider_error"
        : verificationRejected
          ? "verification_rejected"
          : scoreRejected
            ? "score_below_threshold"
            : "all_image_candidates_rejected",
    sourceUrls: scored.slice(0, 10).map((s) => s.url)
  });

  if (selected && options.selectedStage) {
    stages.push({
      stage: options.selectedStage,
      status: "ok",
      acceptedCount: 1,
      reason: options.selectedReason ?? "selected",
      sourceUrls: [selected.url]
    });
  }

  return {
    selected: transientSystemFailure ? null : selected,
    evaluated: scored.slice(0, 20),
    stages,
    uniqueSeedCount: uniqueSeeds.length,
    probedCount: probed.length,
    transientSystemFailure
  };
}


function finalizeImageResult(options: {
  selected: ScoredImageCandidate | null;
  evaluated: ScoredImageCandidate[];
  errors: string[];
  stages: EnrichmentDiagnosticStage[];
  diagStore: ImageCandidateDiagnosticStore;
  selectedOfficialProductPageUrl: string | null;
  forceNoResultReason?: NoResultReason | null;
  forceSummary?: string | null;
}): ImageEnrichmentResult {
  const diagnostics = emptyImageDiagnostics();
  let noResultReason: NoResultReason | null = options.forceNoResultReason ?? null;
  if (!options.selected && noResultReason == null) {
    const verifyStage = [...options.stages].reverse().find((s) => s.stage === "verify");
    if (verifyStage?.reason === "verification_rejected") noResultReason = "verification_rejected";
    else if (verifyStage?.reason === "score_below_threshold") noResultReason = "score_below_threshold";
    else if (options.evaluated.length === 0) {
      const hadSeeds = options.stages.some(
        (s) =>
          (s.stage === "candidates" || s.stage.endsWith("_evaluation"))
          && (s.candidateCount ?? 0) > 0
      );
      noResultReason = hadSeeds ? "source_fetch_failed" : "no_image_candidates";
    } else {
      noResultReason = "all_image_candidates_rejected";
    }
  }

  const workingDiags = options.diagStore.toArray();
  const boundedDiags = options.diagStore.toBoundedList();
  diagnostics.noResultReason = noResultReason;
  diagnostics.summary =
    options.forceSummary
    ?? summarizeImageCandidateDiagnostics(boundedDiags, {
      selectedScore: options.selected?.score ?? null,
      noResultReason
    });
  diagnostics.stages = options.stages;
  diagnostics.accepted = options.selected ? ["image"] : [];
  diagnostics.imageCandidates = workingDiags;

  return {
    selected: options.selected,
    evaluated: options.evaluated.slice(0, 20),
    errors: options.errors,
    diagnostics: sanitizeJobDiagnostics(diagnostics),
    selectedOfficialProductPageUrl: options.selectedOfficialProductPageUrl
  };
}

/**
 * Run image enrichment for an identified candidate.
 * Progressive discovery: FWGS → official product page → generic image SERP last.
 * Returns selected=null when nothing meets the acceptance threshold (success, not failure).
 */
export async function executeImageEnrichment(
  candidate: BottleCandidate,
  deps: ImageEnrichmentDeps = {}
): Promise<ImageEnrichmentResult> {
  const searchWeb = deps.searchWebHits ?? searchWebHits;
  const searchImages = deps.searchImageHits ?? searchImageHits;
  const plcbItem = plcbItemFromCandidate(candidate);
  const probe =
    deps.probeImageMeta
    ?? ((url: string) =>
      probeImageMetaWithFwgsFallback(url, {
        plcbItem,
        fetchFwgsImageViaFigranium: deps.fetchFwgsImageViaFigranium
      }));
  const fetchHtml = deps.fetchPageHtml ?? defaultFetchPageHtml;
  const verify = deps.verifyImage ?? ((req) => verifyProductImage(req));
  const extractFwgsImages = deps.extractFwgsPlcbImages ?? extractFwgsPlcbImages;
  const errors: string[] = [];
  const stages: EnrichmentDiagnosticStage[] = [];
  const figraniumImageBase64ByUrl = new Map<string, string>();
  const diagStore = new ImageCandidateDiagnosticStore();
  const allEvaluated: ScoredImageCandidate[] = [];
  const seenEvaluatedUrls = new Set<string>();
  const visionBudget: ImageVisionBudget = {
    limit: IMAGE_MAX_VISION_CHECKS,
    used: 0
  };
  const probeBudget: ImageProbeBudget = {
    limit: MAX_PROBE_SEEDS,
    used: 0
  };
  const evaluatedCandidateIds = new Set<string>();

  let selectedOfficialProductPageUrl: string | null =
    String(deps.knownOfficialProductPageUrl ?? "").trim() || null;
  let discoveredDomains: string[] = [];
  let fwgsTransientError = false;
  let fallbackReason: string | null = null;

  const rememberEvaluated = (items: ScoredImageCandidate[]) => {
    for (const item of items) {
      const key = imageCandidateIdFromUrl(item.url);
      if (seenEvaluatedUrls.has(key)) continue;
      seenEvaluatedUrls.add(key);
      allEvaluated.push(item);
    }
  };

  // ── Stage 1: trusted PLCB / FWGS Figranium images ─────────────────────────
  const fwgsSeeds: ImageCandidateSeed[] = [];
  if (plcbItem && (Boolean(deps.extractFwgsPlcbImages) || isFwgsFigraniumConfigured())) {
    const knownPdp =
      selectedOfficialProductPageUrl
      && /^https:\/\/www\.finewineandgoodspirits\.com\//i.test(selectedOfficialProductPageUrl)
        ? selectedOfficialProductPageUrl
        : fwgsPdpUrlForItem(plcbItem);
    try {
      if (knownPdp) selectedOfficialProductPageUrl = knownPdp;
      const images = await extractFwgsImages(plcbItem, knownPdp);
      const uniqueImageUrls = filterValidatedFwgsImageUrls(
        [images?.primaryImageUrl, ...((images?.imageUrls ?? []))],
        plcbItem
      );
      if (uniqueImageUrls.length) {
        for (const url of uniqueImageUrls) {
          fwgsSeeds.push({
            url,
            sourceUrl: knownPdp || null,
            mimeType: "image/jpeg",
            identityMatched: true
          });
        }
        stages.push({
          stage: "fwgs_figranium_images",
          status: "ok",
          candidateCount: uniqueImageUrls.length,
          reason: images?.extractionSource?.trim() || "figranium",
          sourceUrls: knownPdp ? [knownPdp] : uniqueImageUrls.slice(0, 1)
        });
      } else {
        stages.push({
          stage: "fwgs_figranium_images",
          status: "no_result",
          reason: images ? "no_validated_images" : "no_images"
        });
        fallbackReason = "fallback_no_fwgs_image";
      }
    } catch (error) {
      if (isFwgsFigraniumProviderError(error)) {
        errors.push(error.message);
        fwgsTransientError = true;
        stages.push({
          stage: "fwgs_figranium_images",
          status: "error",
          reason: `${error.kind}:${error.message}`.slice(0, 120)
        });
      } else {
        const message = error instanceof Error ? error.message : "FWGS Figranium failed";
        errors.push(message);
        fwgsTransientError = true;
        stages.push({
          stage: "fwgs_figranium_images",
          status: "error",
          reason: message.slice(0, 120)
        });
      }
    }
  } else if (!plcbItem) {
    fallbackReason = fallbackReason ?? "fallback_no_fwgs_image";
  }

  if (fwgsSeeds.length) {
    const fwgsEval = await evaluateImageSeeds({
      candidate,
      seeds: fwgsSeeds,
      discoveredDomains,
      probe,
      verify,
      diagStore,
      figraniumImageBase64ByUrl,
      errors,
      visionBudget,
      probeBudget,
      evaluatedCandidateIds,
      evaluationStage: "strong_source_evaluation",
      selectedStage: "strong_source_selected",
      selectedReason: "selected_from_fwgs"
    });
    stages.push(...fwgsEval.stages);
    rememberEvaluated(fwgsEval.evaluated);

    if (fwgsEval.selected) {
      stages.push({
        stage: "generic_image_search_skipped",
        status: "skipped",
        reason: "generic_search_not_needed"
      });
      return finalizeImageResult({
        selected: fwgsEval.selected,
        evaluated: allEvaluated,
        errors,
        stages,
        diagStore,
        selectedOfficialProductPageUrl
      });
    }

    if (fwgsEval.transientSystemFailure) {
      // Vision/Figranium provider unavailable — preserve retry semantics; do not widen discovery.
      return finalizeImageResult({
        selected: null,
        evaluated: allEvaluated,
        errors,
        stages,
        diagStore,
        selectedOfficialProductPageUrl,
        forceNoResultReason: "provider_error",
        forceSummary: "Provider or network error"
      });
    }

    fallbackReason = "fallback_fwgs_rejected";
  }

  // Transient FWGS extract failure: try official pages, but never generic image SERP.
  const blockGenericSearch = fwgsTransientError;

  const queryTiers = buildImageQueryTiers(identityFromCandidate(candidate));

  // ── Stage 2: official product-page images (before generic image SERP) ─────
  const officialSeeds: ImageCandidateSeed[] = [];
  let officialPagesFound = 0;
  let officialImagesFromMeta = 0;
  let officialPagesWithoutImageMeta = 0;

  try {
    const identity = identityFromCandidate(candidate);
    const webTiers = queryTiers.slice(0, 4);
    let allHits: WebSearchHit[] = [];
    for (const tier of webTiers) {
      const hits = await searchWeb(tier.query, 5);
      stages.push({
        stage: `page_query_tier_${tier.tier}`,
        status: hits.length ? "ok" : "no_result",
        query: tier.query,
        provider: "searxng",
        candidateCount: hits.length,
        reason: hits.length ? `tier:${tier.label}` : "no_search_results"
      });
      allHits.push(...hits);
      const discovery = discoverOfficialDomains(allHits, {
        brand: candidate.brand.value,
        name: candidate.name.value
      });
      if (discovery.domains.length) {
        discoveredDomains = [...new Set([...discoveredDomains, ...discovery.domains])];
        stages.push({
          stage: "official_domain_discovered",
          status: "ok",
          reason: discovery.domains.join(",").slice(0, 160),
          sourceUrls: discovery.sourceUrls
        });
      }
      if (
        discoveredDomains.length
        && hasOfficialProductDetailHit(allHits, discoveredDomains, identity)
      ) {
        break;
      }
    }

    const seenHit = new Set<string>();
    allHits = allHits.filter((h) => {
      if (!h.url || seenHit.has(h.url)) return false;
      seenHit.add(h.url);
      return true;
    });

    if (!discoveredDomains.length) {
      const discovery = discoverOfficialDomains(allHits, {
        brand: candidate.brand.value,
        name: candidate.name.value
      });
      discoveredDomains = discovery.domains;
      if (discovery.domains.length) {
        stages.push({
          stage: "official_domain_discovered",
          status: "ok",
          reason: discovery.domains.join(",").slice(0, 160),
          sourceUrls: discovery.sourceUrls
        });
      }
    }

    let expansionTokens = extractExpressionTokensFromHits(allHits, identity);
    if (expansionTokens.length) {
      stages.push({
        stage: "official_product_search_learned",
        status: "ok",
        reason: `learned token: ${expansionTokens.join(", ")}`.slice(0, 160),
        candidateCount: expansionTokens.length
      });
    }

    if (discoveredDomains.length) {
      const siteQueries = buildOfficialProductPageQueries(
        identity,
        discoveredDomains,
        expansionTokens
      );
      let siteHitCount = 0;
      for (const pq of siteQueries) {
        const hits = await searchWeb(pq.query, 5);
        siteHitCount += hits.length;
        for (const hit of hits) {
          if (!hit.url || seenHit.has(hit.url)) continue;
          seenHit.add(hit.url);
          allHits.push(hit);
        }
        stages.push({
          stage: "official_product_search",
          status: hits.length ? "ok" : "no_result",
          query: pq.query,
          provider: "searxng",
          candidateCount: hits.length,
          reason: `domain:${pq.domain};${pq.label}`.slice(0, 160)
        });
      }
      if (!siteQueries.length) {
        stages.push({
          stage: "official_product_search",
          status: "skipped",
          reason: "no_product_queries",
          candidateCount: 0
        });
      } else if (siteHitCount === 0) {
        stages.push({
          stage: "official_product_search",
          status: "no_result",
          reason: "site_queries_empty_continuing_broad",
          candidateCount: 0
        });
      }
    }

    const needBroad =
      !discoveredDomains.length
      || !hasOfficialProductDetailHit(allHits, discoveredDomains, identity);
    if (needBroad) {
      const broadQueries = buildOfficialProductPageBroadQueries(identity, expansionTokens);
      let broadRawCount = 0;
      for (const bq of broadQueries) {
        const hits = await searchWeb(bq.query, 8);
        broadRawCount += hits.length;
        stages.push({
          stage: "official_product_search_broad",
          status: hits.length ? "ok" : "no_result",
          query: bq.query,
          provider: "searxng",
          candidateCount: hits.length,
          reason: bq.label
        });
        for (const hit of hits) {
          if (!hit.url || seenHit.has(hit.url)) continue;
          seenHit.add(hit.url);
          allHits.push(hit);
        }
      }

      if (!discoveredDomains.length) {
        const discovery = discoverOfficialDomains(allHits, {
          brand: candidate.brand.value,
          name: candidate.name.value
        });
        if (discovery.domains.length) {
          discoveredDomains = discovery.domains;
          stages.push({
            stage: "official_domain_discovered",
            status: "ok",
            reason: discovery.domains.join(",").slice(0, 160),
            sourceUrls: discovery.sourceUrls
          });
        }
      }

      const learnedMore = extractExpressionTokensFromHits(allHits, identity);
      const newLearned = learnedMore.filter(
        (t) => !expansionTokens.some((e) => e.toLowerCase() === t.toLowerCase())
      );
      if (newLearned.length) {
        expansionTokens = [...expansionTokens, ...newLearned].slice(0, 3);
        stages.push({
          stage: "official_product_search_learned",
          status: "ok",
          reason: `learned token: ${expansionTokens.join(", ")}`.slice(0, 160),
          candidateCount: expansionTokens.length
        });
        const followUps = buildOfficialProductPageBroadQueries(identity, expansionTokens).filter(
          (q) => q.label.includes("expanded")
        );
        for (const fq of followUps.slice(0, 1)) {
          const hits = await searchWeb(fq.query, 8);
          broadRawCount += hits.length;
          stages.push({
            stage: "official_product_search_broad",
            status: hits.length ? "ok" : "no_result",
            query: fq.query,
            provider: "searxng",
            candidateCount: hits.length,
            reason: `${fq.label};followup`
          });
          for (const hit of hits) {
            if (!hit.url || seenHit.has(hit.url)) continue;
            seenHit.add(hit.url);
            allHits.push(hit);
          }
        }
      }

      if (discoveredDomains.length) {
        const filtered = filterHitsByOfficialRegisteredDomain(allHits, discoveredDomains);
        stages.push({
          stage: "official_domain_filter",
          status: filtered.length ? "ok" : "no_result",
          candidateCount: Math.max(broadRawCount, allHits.length),
          acceptedCount: filtered.length,
          reason: filtered.length
            ? `${filtered.length} official-domain results`
            : "0 domain-filtered results"
        });
      }
    }

    if (
      selectedOfficialProductPageUrl
      && discoveredDomains.length
      && !hostIsUnderOfficialDomain(selectedOfficialProductPageUrl, discoveredDomains)
      && !/^https:\/\/www\.finewineandgoodspirits\.com\//i.test(selectedOfficialProductPageUrl)
    ) {
      selectedOfficialProductPageUrl = null;
    }

    let ranked = selectBestOfficialProductPage(allHits, identity, {
      discoveredOfficialDomains: discoveredDomains,
      minScore: 40
    });

    if (!ranked && discoveredDomains.length) {
      const knownHosts: string[] = [];
      for (const hit of allHits) {
        try {
          const h = new URL(hit.url).hostname.toLowerCase();
          if (hostIsUnderOfficialDomain(h, discoveredDomains)) knownHosts.push(h);
        } catch {
          /* skip */
        }
      }
      const sitemap = await discoverOfficialProductUrlsFromSite({
        trustedDomains: discoveredDomains,
        knownHosts,
        identity,
        fetchText: fetchHtml
      });
      stages.push({
        stage: "official_sitemap_discovery",
        status: sitemap.urls.length ? "ok" : "no_result",
        candidateCount: sitemap.urls.length,
        acceptedCount: sitemap.urls.length ? 1 : 0,
        reason: `${sitemap.reason};hosts:${sitemap.hostsTried.join(",")}`.slice(0, 160),
        sourceUrls: sitemap.urls.slice(0, 4).map((u) => u.url)
      });
      for (const hit of sitemap.urls) {
        if (!hit.url || seenHit.has(hit.url)) continue;
        seenHit.add(hit.url);
        allHits.push({
          url: hit.url,
          title: hit.title ?? "",
          content: hit.content ?? ""
        });
      }
      ranked = selectBestOfficialProductPage(allHits, identity, {
        discoveredOfficialDomains: discoveredDomains,
        minScore: 40
      });
    }

    if (ranked) {
      selectedOfficialProductPageUrl = ranked.hit.url;
      stages.push({
        stage: "official_product_page_selected",
        status: "ok",
        reason: `${safeOfficialPageDisplay(ranked.hit.url)} · score:${ranked.score.total}`.slice(0, 160),
        sourceUrls: [ranked.hit.url],
        acceptedCount: 1,
        candidateCount: allHits.length
      });
    } else if (
      selectedOfficialProductPageUrl
      && !/^https:\/\/www\.finewineandgoodspirits\.com\//i.test(selectedOfficialProductPageUrl)
    ) {
      stages.push({
        stage: "official_product_page_selected",
        status: "ok",
        reason: `${safeOfficialPageDisplay(selectedOfficialProductPageUrl)} · reused`.slice(0, 160),
        sourceUrls: [selectedOfficialProductPageUrl]
      });
    } else if (!ranked) {
      stages.push({
        stage: "official_product_page_selected",
        status: "no_result",
        reason: discoveredDomains.length
          ? "official_domain_known_but_no_product_page"
          : "no_official_domain",
        candidateCount: allHits.length
      });
    }

    const officialPageUrls: string[] = [];
    const pushPage = (url: string | null | undefined) => {
      const u = String(url ?? "").trim();
      if (!u || officialPageUrls.includes(u)) return;
      if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(u)) return;
      // FWGS PDP is handled in stage 1; avoid re-fetching as "official manufacturer".
      if (/^https:\/\/www\.finewineandgoodspirits\.com\//i.test(u)) return;
      officialPageUrls.push(u);
    };
    pushPage(selectedOfficialProductPageUrl);

    for (const hit of allHits) {
      if (!hit.url) continue;
      const pageClass = classifySourceUrlWithDiscovery(hit.url, {
        brand: candidate.brand.value,
        name: candidate.name.value,
        discoveredOfficialDomains: discoveredDomains
      });
      if (!isAuthoritativeSource(pageClass) && pageClass !== "unknown") continue;
      const sourceType = classifyImageSource(hit.url, {
        brand: candidate.brand.value,
        name: candidate.name.value,
        pageUrl: hit.url,
        discoveredOfficialDomains: discoveredDomains
      });
      const pageLooksOfficial =
        pageClass === "official"
        || sourceType === "official"
        || (discoveredDomains.length > 0
          && classifySourceUrlWithDiscovery(hit.url, {
            brand: candidate.brand.value,
            name: candidate.name.value,
            discoveredOfficialDomains: discoveredDomains
          }) === "official");

      if (pageLooksOfficial && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(hit.url)) {
        if (!isNonImageAssetUrl(hit.url)) {
          officialSeeds.push({ url: hit.url, sourceUrl: hit.url });
          officialImagesFromMeta += 1;
          officialPagesFound += 1;
        }
        continue;
      }
      if (pageLooksOfficial || sourceType === "licensed" || sourceType === "approved") {
        if (pageLooksOfficial) pushPage(hit.url);
      }
    }

    for (const pageUrl of officialPageUrls.slice(0, MAX_OFFICIAL_PAGES_TO_FETCH)) {
      const pageClass = classifySourceUrlWithDiscovery(pageUrl, {
        brand: candidate.brand.value,
        name: candidate.name.value,
        discoveredOfficialDomains: discoveredDomains
      });
      const pageLooksOfficial =
        pageClass === "official"
        || (discoveredDomains.length > 0
          && hostIsUnderOfficialDomain(pageUrl, discoveredDomains));
      if (!pageLooksOfficial && !isAuthoritativeSource(pageClass)) continue;

      if (pageLooksOfficial) officialPagesFound += 1;
      const ingest = await ingestOfficialPageForImages({
        pageUrl,
        brand: candidate.brand.value,
        name: candidate.name.value,
        fetchHtml,
        seeds: officialSeeds,
        stages
      });
      officialImagesFromMeta += ingest.imagesFromMeta;
      officialPagesWithoutImageMeta += ingest.pagesWithoutImageMeta;
    }

    stages.push({
      stage: "page_discovery",
      status: officialPagesFound ? "ok" : "skipped",
      candidateCount: allHits.length,
      acceptedCount: officialPagesFound,
      reason: selectedOfficialProductPageUrl
        && !/^https:\/\/www\.finewineandgoodspirits\.com\//i.test(selectedOfficialProductPageUrl)
        ? "official_product_page_preferred"
        : officialPagesFound
          ? "official_pages_scanned"
          : discoveredDomains.length
            ? "official_domain_but_no_pages"
            : "no_official_pages"
    });
  } catch (error) {
    const message = isWebSearchError(error)
      ? `SearXNG ${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : "Web search failed";
    errors.push(message);
    stages.push({
      stage: "page_discovery",
      status: "error",
      provider: "searxng",
      reason: message.slice(0, 120)
    });
  }

  const imgFallbackAccepted = stages.some(
    (s) => s.stage === "official_page_img_candidate" && s.status === "ok"
  );
  if (!officialPagesFound) {
    stages.push({
      stage: "official_page_outcome",
      status: "no_result",
      reason: "no_official_page_discovered"
    });
    if (!fallbackReason) {
      fallbackReason = "fallback_no_official_image";
    }
  } else if (
    selectedOfficialProductPageUrl
    && !/^https:\/\/www\.finewineandgoodspirits\.com\//i.test(selectedOfficialProductPageUrl)
    && officialImagesFromMeta
  ) {
    stages.push({
      stage: "official_page_outcome",
      status: "ok",
      acceptedCount: officialImagesFromMeta,
      reason: "official_product_page_image_metadata",
      sourceUrls: [selectedOfficialProductPageUrl]
    });
  } else if (officialImagesFromMeta) {
    stages.push({
      stage: "official_page_outcome",
      status: "ok",
      acceptedCount: officialImagesFromMeta,
      reason: "official_image_metadata_found"
    });
  } else if (imgFallbackAccepted) {
    stages.push({
      stage: "official_page_outcome",
      status: "ok",
      reason: "official_page_img_fallback"
    });
  } else if (officialPagesWithoutImageMeta) {
    stages.push({
      stage: "official_page_outcome",
      status: "no_result",
      reason: "official_page_discovered_but_no_image_metadata"
    });
    fallbackReason = "fallback_no_official_image";
  }

  if (officialSeeds.length) {
    const officialEval = await evaluateImageSeeds({
      candidate,
      seeds: officialSeeds,
      discoveredDomains,
      probe,
      verify,
      diagStore,
      figraniumImageBase64ByUrl,
      errors,
      visionBudget,
      probeBudget,
      evaluatedCandidateIds,
      evaluationStage: "official_image_evaluation",
      selectedStage: "official_image_selected",
      selectedReason: "selected_from_official"
    });
    stages.push(...officialEval.stages);
    rememberEvaluated(officialEval.evaluated);

    if (officialEval.selected) {
      stages.push({
        stage: "generic_image_search_skipped",
        status: "skipped",
        reason: "generic_search_not_needed"
      });
      return finalizeImageResult({
        selected: officialEval.selected,
        evaluated: allEvaluated,
        errors,
        stages,
        diagStore,
        selectedOfficialProductPageUrl
      });
    }

    if (officialEval.transientSystemFailure) {
      return finalizeImageResult({
        selected: null,
        evaluated: allEvaluated,
        errors,
        stages,
        diagStore,
        selectedOfficialProductPageUrl,
        forceNoResultReason: "provider_error",
        forceSummary: "Provider or network error"
      });
    }

    fallbackReason = "fallback_no_official_image";
  }

  // ── Stage 3: generic SearXNG image-category search (last resort) ──────────
  if (blockGenericSearch) {
    stages.push({
      stage: "generic_image_search_skipped",
      status: "skipped",
      reason: "fwgs_provider_error_no_generic_fallback"
    });
    return finalizeImageResult({
      selected: null,
      evaluated: allEvaluated,
      errors,
      stages,
      diagStore,
      selectedOfficialProductPageUrl,
      forceNoResultReason: "provider_error",
      forceSummary: "Provider or network error"
    });
  }

  const genericSeeds: ImageCandidateSeed[] = [];
  let imageSearchHadResults = false;
  let primaryQuery = queryTiers[0]?.query ?? imageSearchQuery(candidate);

  stages.push({
    stage: "generic_image_search",
    status: "ok",
    reason: fallbackReason ?? "fallback_no_official_image",
    query: primaryQuery,
    provider: "searxng"
  });

  for (const tier of queryTiers.slice(0, 3)) {
    try {
      const imageSeeds = await searchImages(tier.query, 8);
      if (imageSeeds.length) {
        imageSearchHadResults = true;
        for (const seed of imageSeeds) {
          if (isNonImageAssetUrl(seed.url)) continue;
          genericSeeds.push(seed);
        }
        primaryQuery = tier.query;
        stages.push({
          stage: `query_tier_${tier.tier}`,
          status: "ok",
          query: tier.query,
          provider: "searxng",
          candidateCount: imageSeeds.length,
          reason: `tier:${tier.label}`
        });
        break;
      }
      stages.push({
        stage: `query_tier_${tier.tier}`,
        status: "no_result",
        query: tier.query,
        provider: "searxng",
        candidateCount: 0,
        reason: "no_search_results"
      });
    } catch (error) {
      const message = isWebSearchError(error)
        ? `SearXNG ${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : "Image search failed";
      errors.push(message);
      stages.push({
        stage: `query_tier_${tier.tier}`,
        status: "error",
        query: tier.query,
        provider: "searxng",
        reason: message.slice(0, 120)
      });
      stages.push({
        stage: "search",
        status: "error",
        query: tier.query,
        provider: "searxng",
        reason: message.slice(0, 120)
      });
      return finalizeImageResult({
        selected: null,
        evaluated: allEvaluated,
        errors,
        stages,
        diagStore,
        selectedOfficialProductPageUrl: null,
        forceNoResultReason: "provider_error",
        forceSummary: "Provider or network error"
      });
    }
  }

  stages.push({
    stage: "search",
    status: imageSearchHadResults ? "ok" : "no_result",
    query: primaryQuery,
    provider: "searxng",
    candidateCount: genericSeeds.length,
    reason: imageSearchHadResults ? undefined : "no_search_results"
  });

  if (genericSeeds.length) {
    const genericEval = await evaluateImageSeeds({
      candidate,
      seeds: genericSeeds,
      discoveredDomains,
      probe,
      verify,
      diagStore,
      figraniumImageBase64ByUrl,
      errors,
      visionBudget,
      probeBudget,
      evaluatedCandidateIds,
      skipProbeForUnapprovedSources: true,
      evaluationStage: "generic_image_evaluation"
    });
    stages.push(...genericEval.stages);
    rememberEvaluated(genericEval.evaluated);

    if (genericEval.selected) {
      return finalizeImageResult({
        selected: genericEval.selected,
        evaluated: allEvaluated,
        errors,
        stages,
        diagStore,
        selectedOfficialProductPageUrl
      });
    }

    if (genericEval.transientSystemFailure) {
      return finalizeImageResult({
        selected: null,
        evaluated: allEvaluated,
        errors,
        stages,
        diagStore,
        selectedOfficialProductPageUrl,
        forceNoResultReason: "provider_error",
        forceSummary: "Provider or network error"
      });
    }
  }

  return finalizeImageResult({
    selected: null,
    evaluated: allEvaluated,
    errors,
    stages,
    diagStore,
    selectedOfficialProductPageUrl
  });
}
