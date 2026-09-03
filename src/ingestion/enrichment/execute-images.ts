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

/**
 * Run image enrichment for an identified candidate.
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
  const seeds: ImageCandidateSeed[] = [];
  const stages: EnrichmentDiagnosticStage[] = [];
  const diagnostics = emptyImageDiagnostics();
  const figraniumImageBase64ByUrl = new Map<string, string>();

  let selectedOfficialProductPageUrl: string | null =
    String(deps.knownOfficialProductPageUrl ?? "").trim() || null;

  // Image-first FWGS path: when a PLCB item is known, extract + validate
  // Fine Wine & Good Spirits product images via Figranium (no metadata merge).
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
          seeds.push({
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
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "FWGS Figranium failed";
      errors.push(message);
      stages.push({
        stage: "fwgs_figranium_images",
        status: "error",
        reason: message.slice(0, 120)
      });
    }
  }

  const queryTiers = buildImageQueryTiers(identityFromCandidate(candidate));
  let discoveredDomains: string[] = [];
  let imageSearchHadResults = false;
  let primaryQuery = queryTiers[0]?.query ?? imageSearchQuery(candidate);

  for (const tier of queryTiers.slice(0, 3)) {
    try {
      const imageSeeds = await searchImages(tier.query, 8);
      if (imageSeeds.length) {
        imageSearchHadResults = true;
        seeds.push(...imageSeeds);
        primaryQuery = tier.query;
        stages.push({
          stage: `query_tier_${tier.tier}`,
          status: "ok",
          query: tier.query,
          provider: "searxng",
          candidateCount: imageSeeds.length,
          reason: `tier:${tier.label}`
        });
        // First successful image SERP is enough for candidate seeds.
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
      diagnostics.noResultReason = "provider_error";
      diagnostics.summary = "Provider or network error";
      diagnostics.stages = stages;
      return {
        selected: null,
        evaluated: [],
        errors,
        diagnostics: sanitizeJobDiagnostics(diagnostics),
        selectedOfficialProductPageUrl: null
      };
    }
  }

  stages.push({
    stage: "search",
    status: imageSearchHadResults ? "ok" : "no_result",
    query: primaryQuery,
    provider: "searxng",
    candidateCount: seeds.length,
    reason: imageSearchHadResults ? undefined : "no_search_results"
  });

  // Progressive web search for official pages; prefer product-detail pages for images.
  let officialPagesScanned = 0;
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
      // IMAGE discovery: do not stop on a generic official homepage alone.
      if (
        discoveredDomains.length
        && hasOfficialProductDetailHit(allHits, discoveredDomains, identity)
      ) {
        break;
      }
    }

    // Dedup hits
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

    // Step B: official product-page discovery.
    // site: queries are optional — many SearXNG configs return zero for them.
    // Always follow with broad search + code-side registered-domain filtering.
    let expansionTokens = extractExpressionTokensFromHits(allHits, identity);
    if (expansionTokens.length) {
      stages.push({
        stage: "official_product_search_learned",
        status: "ok",
        reason: `learned token: ${expansionTokens.join(", ")}`.slice(0, 160),
        candidateCount: expansionTokens.length
      });
    }

    // Optional site:-scoped tier (kept for engines that support it).
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

    // Broad fallback (does not use site:). Filter results by registered domain in code.
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

      // Discover domains from broad hits when still unknown.
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

      // Re-learn expression tokens from richer SERP (e.g. Cask), then one expanded broad query.
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

    // Prefer a previously persisted product page when still on an official domain.
    if (
      selectedOfficialProductPageUrl
      && discoveredDomains.length
      && !hostIsUnderOfficialDomain(selectedOfficialProductPageUrl, discoveredDomains)
    ) {
      selectedOfficialProductPageUrl = null;
    }

    let ranked = selectBestOfficialProductPage(allHits, identity, {
      discoveredOfficialDomains: discoveredDomains,
      minScore: 40
    });

    // Bounded sitemap / homepage-link discovery when search still lacks a product page.
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
    } else if (selectedOfficialProductPageUrl) {
      stages.push({
        stage: "official_product_page_selected",
        status: "ok",
        reason: `${safeOfficialPageDisplay(selectedOfficialProductPageUrl)} · reused`.slice(0, 160),
        sourceUrls: [selectedOfficialProductPageUrl]
      });
    } else {
      stages.push({
        stage: "official_product_page_selected",
        status: "no_result",
        reason: discoveredDomains.length
          ? "official_domain_known_but_no_product_page"
          : "no_official_domain",
        candidateCount: allHits.length
      });
    }

    // Build ordered official page fetch list: selected product page first.
    const officialPageUrls: string[] = [];
    const pushPage = (url: string | null | undefined) => {
      const u = String(url ?? "").trim();
      if (!u || officialPageUrls.includes(u)) return;
      if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(u)) return;
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
        seeds.push({ url: hit.url, sourceUrl: hit.url });
        officialImagesFromMeta += 1;
        officialPagesFound += 1;
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
      officialPagesScanned += 1;
      const ingest = await ingestOfficialPageForImages({
        pageUrl,
        brand: candidate.brand.value,
        name: candidate.name.value,
        fetchHtml,
        seeds,
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

  // Record distinct image diagnostic outcomes for keeper review.
  const imgFallbackAccepted = stages.some(
    (s) => s.stage === "official_page_img_candidate" && s.status === "ok"
  );
  if (!officialPagesFound) {
    stages.push({
      stage: "official_page_outcome",
      status: "no_result",
      reason: "no_official_page_discovered"
    });
  } else if (selectedOfficialProductPageUrl && officialImagesFromMeta) {
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
  }

  const seenSeeds = mergeImageSeedsByNormalizedUrl(
    seeds.filter((s) => {
      const url = String(s.url ?? "").trim();
      return Boolean(url) && !isNonImageAssetUrl(url);
    })
  );
  const uniqueSeeds = seenSeeds.filter((s) => Boolean(String(s.url ?? "").trim()));
  // Prefer official page-scoped seeds in the probe window so verification
  // candidates are not starved by search junk / decorative insertion order.
  const probeSeeds = orderSeedsForProbe(uniqueSeeds).slice(0, MAX_PROBE_SEEDS);

  const brand = candidate.brand.value;
  const name = candidate.name.value;
  const probed: ImageCandidate[] = [];
  const dimensionSources = new Map<string, "seed" | "image_header" | "unknown">();
  let fetchFailed = 0;
  let fwgsDirectBlocked = 0;
  let fwgsFigraniumFetchOk = 0;
  let fwgsFigraniumFetchFailed = 0;
  const diagStore = new ImageCandidateDiagnosticStore();

  for (const seed of probeSeeds) {
    const preview = toCandidate(seed, brand, name, discoveredDomains);
    diagStore.ensureDiscovered({
      url: seed.url,
      sourceType: preview.sourceType,
      sourceUrl: seed.sourceUrl,
      width: seed.width,
      height: seed.height,
      mimeType: seed.mimeType
    });

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
      const probedMeta = await probe(seed.url);
      const probeDetails = Array.isArray(probedMeta.probeDetails)
        ? probedMeta.probeDetails.filter((value): value is ImageProbeDetail => typeof value === "string")
        : [];
      // Prefer real probed header dims over seed hints (FWGS URL size params are not authoritative).
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
      errors.push(error instanceof Error ? error.message : "Image probe failed");
      meta.reachable = false;
    }
    if (!meta.reachable) {
      fetchFailed += 1;
      const failedCandidate = toCandidate(seed, brand, name, discoveredDomains);
      const failDetails = Array.isArray(meta.probeDetails) ? meta.probeDetails : [];
      if (failDetails.includes("direct_probe_http_rejected") || failDetails.includes("direct_probe_timeout")) {
        fwgsDirectBlocked += 1;
      }
      if (failDetails.includes("figranium_fetch_fallback_failed")) {
        fwgsFigraniumFetchFailed += 1;
      }
      diagStore.markHardFilter({
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
      figraniumImageBase64ByUrl.set(resolvedUrl, meta.imageBase64.trim());
    }
    if ((meta.probeDetails ?? []).includes("figranium_fetch_fallback_ok")) {
      fwgsFigraniumFetchOk += 1;
    }
    if ((meta.probeDetails ?? []).includes("direct_probe_http_rejected") || (meta.probeDetails ?? []).includes("direct_probe_timeout")) {
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
      discoveredDomains
    );
    dimensionSources.set(imageCandidateIdFromUrl(item.url), dimsSource);
    probed.push(item);
  }

  const candidateReasonParts: string[] = [];
  if (!probed.length) {
    candidateReasonParts.push(uniqueSeeds.length ? "fetch_failed" : "no_image_candidates");
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
    stage: "candidates",
    status: probed.length ? "ok" : "no_result",
    candidateCount: uniqueSeeds.length,
    acceptedCount: probed.length,
    rejectedCount: fetchFailed,
    reason: candidateReasonParts.length ? candidateReasonParts.join(",").slice(0, 160) : undefined,
    sourceUrls: uniqueSeeds.slice(0, 10).map((s) => s.url)
  });

  if (!probed.length) {
    diagnostics.noResultReason = uniqueSeeds.length ? "source_fetch_failed" : "no_image_candidates";
    diagnostics.summary = uniqueSeeds.length
      ? "Image candidates could not be fetched"
      : "No image candidates found";
    diagnostics.stages = stages;
    diagnostics.imageCandidates = diagStore.toArray();
    return {
      selected: null,
      evaluated: [],
      errors,
      diagnostics: sanitizeJobDiagnostics(diagnostics),
      selectedOfficialProductPageUrl
    };
  }

  const scored: ScoredImageCandidate[] = [];
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
      diagStore.markHardFilter({
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
      diagStore.markHardFilter({
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
  const sentToVision = visionQueue.slice(0, IMAGE_MAX_VISION_CHECKS);
  let visionCallsStarted = 0;

  for (const item of sentToVision) {
    visionCallsStarted += 1;
    const dimsSource = dimensionSources.get(imageCandidateIdFromUrl(item.url)) ?? "unknown";
    diagStore.markVerificationStarted({
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
      vision = await verify({
        candidate,
        imageUrl: item.url,
        imageBase64: figraniumImageBase64ByUrl.get(item.url) ?? null
      });
      if (!vision) {
        visionError = "vision_parse_failed";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Vision verify failed";
      errors.push(message);
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
      diagStore.markVerificationResult({
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

    diagStore.markVerificationResult({
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
  for (const item of visionQueue.slice(IMAGE_MAX_VISION_CHECKS)) {
    notCheckedCount += 1;
    scored.push({
      ...item,
      score: scoreImageCandidateBase(item),
      rejected: true,
      rejectionReason: "not_checked",
      verified: false
    });
    diagStore.markVerificationResult({
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

  // Actual candidates that reached verification stage (calls started + overflow not_checked).
  const verificationCountFromStages = visionCallsStarted + notCheckedCount;
  // Cap applied only AFTER verification updates on the full working map.
  const workingDiags = diagStore.toArray();
  const consistency = checkVerificationDiagnosticConsistency({
    verificationCountFromStages,
    diagnostics: workingDiags
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
    status: selected ? "ok" : "no_result",
    candidateCount: verificationCountFromStages,
    acceptedCount: selected ? 1 : 0,
    rejectedCount: verificationRejected + scoreRejected,
    reason: selected
      ? `accepted_score:${selected.score}`
      : verificationRejected
        ? "verification_rejected"
        : scoreRejected
          ? "score_below_threshold"
          : "all_image_candidates_rejected",
    sourceUrls: scored.slice(0, 10).map((s) => s.url)
  });

  let noResultReason: NoResultReason | null = null;
  if (!selected) {
    if (verificationRejected > 0 && scoreRejected === 0) noResultReason = "verification_rejected";
    else if (scoreRejected > 0) noResultReason = "score_below_threshold";
    else noResultReason = "all_image_candidates_rejected";
  }

  const boundedDiags = diagStore.toBoundedList();
  diagnostics.noResultReason = noResultReason;
  diagnostics.summary = summarizeImageCandidateDiagnostics(boundedDiags, {
    selectedScore: selected?.score ?? null,
    noResultReason
  });
  diagnostics.stages = stages;
  diagnostics.accepted = selected ? ["image"] : [];
  // Assign unbounded working set; sanitizeJobDiagnostics applies final cap.
  diagnostics.imageCandidates = workingDiags;

  return {
    selected,
    evaluated: scored.slice(0, 20),
    errors,
    diagnostics: sanitizeJobDiagnostics(diagnostics),
    selectedOfficialProductPageUrl
  };
}
