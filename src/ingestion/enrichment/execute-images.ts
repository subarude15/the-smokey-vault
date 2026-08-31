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
  IMAGE_MAX_VISION_CHECKS,
  IMAGE_VISION_CANDIDATE_FLOOR
} from "./image-thresholds.js";
import { verifyProductImage } from "./image-verify.js";
import { readImageDimensionsFromHeader } from "./image-dimensions.js";
import {
  buildImageCandidateDiagnostic,
  collectImageRejectionReasons,
  type ImageCandidateDiagnostic
} from "./image-candidate-diagnostics.js";
import {
  sanitizeJobDiagnostics,
  type EnrichmentDiagnosticStage,
  type JobDiagnosticsPayload,
  type NoResultReason
} from "./diagnostics.js";

export type ImageMeta = {
  width: number | null;
  height: number | null;
  mimeType: string | null;
  reachable: boolean;
  dimensionsSource?: "seed" | "image_header" | "unknown" | null;
};

export type ImageEnrichmentDeps = {
  searchWebHits?: (query: string, limit?: number) => Promise<WebSearchHit[]>;
  searchImageHits?: (query: string, limit?: number) => Promise<ImageCandidateSeed[]>;
  probeImageMeta?: (url: string) => Promise<ImageMeta>;
  fetchPageHtml?: (url: string) => Promise<string | null>;
  verifyImage?: (request: {
    candidate: BottleCandidate;
    imageUrl: string;
  }) => Promise<VisionVerification | null>;
};

export type ImageCandidateSeed = {
  url: string;
  sourceUrl?: string | null;
  width?: number | null;
  height?: number | null;
  mimeType?: string | null;
};

export type ImageEnrichmentResult = {
  selected: ScoredImageCandidate | null;
  evaluated: ScoredImageCandidate[];
  errors: string[];
  diagnostics: JobDiagnosticsPayload;
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
      return { width: null, height: null, mimeType, reachable: false, dimensionsSource: null };
    }
    const buf = Buffer.from(await response.arrayBuffer());
    const dims = readImageDimensionsFromHeader(buf);
    return {
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      mimeType: mimeType?.startsWith("image/") ? mimeType : mimeType,
      reachable: true,
      dimensionsSource: dims ? "image_header" : "unknown"
    };
  } catch {
    return { width: null, height: null, mimeType: null, reachable: false, dimensionsSource: null };
  }
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
    mimeType: seed.mimeType ?? null
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
  const probe = deps.probeImageMeta ?? defaultProbe;
  const fetchHtml = deps.fetchPageHtml ?? defaultFetchPageHtml;
  const verify = deps.verifyImage ?? ((req) => verifyProductImage(req));
  const errors: string[] = [];
  const seeds: ImageCandidateSeed[] = [];
  const stages: EnrichmentDiagnosticStage[] = [];
  const diagnostics = emptyImageDiagnostics();

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
        diagnostics: sanitizeJobDiagnostics(diagnostics)
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

  // Progressive web search for official pages; pull og:image / JSON-LD when authoritative.
  let officialPagesScanned = 0;
  let officialPagesFound = 0;
  let officialImagesFromMeta = 0;
  let officialPagesWithoutImageMeta = 0;
  try {
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
      const authNow = allHits.filter((hit) => {
        const pageClass = classifySourceUrlWithDiscovery(hit.url, {
          brand: candidate.brand.value,
          name: candidate.name.value,
          discoveredOfficialDomains: discoveredDomains
        });
        return isAuthoritativeSource(pageClass);
      });
      if (authNow.length) break;
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
        pageUrl: hit.url
      });
      // Re-check with discovered domains for official classification of page hosts.
      const pageLooksOfficial =
        pageClass === "official"
        || sourceType === "official"
        || (discoveredDomains.length > 0
          && classifySourceUrlWithDiscovery(hit.url, {
            brand: candidate.brand.value,
            name: candidate.name.value,
            discoveredOfficialDomains: discoveredDomains
          }) === "official");

      if (pageLooksOfficial || sourceType === "licensed" || sourceType === "approved") {
        if (pageLooksOfficial) officialPagesFound += 1;
        if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(hit.url)) {
          seeds.push({ url: hit.url, sourceUrl: hit.url });
          if (pageLooksOfficial) officialImagesFromMeta += 1;
        } else if (pageLooksOfficial || isAuthoritativeSource(pageClass)) {
          officialPagesScanned += 1;
          const html = await fetchHtml(hit.url);
          if (html) {
            const facts = extractStructuredProductFacts(html, hit.url);
            const imageUrls = facts.imageUrls.length
              ? facts.imageUrls
              : extractProductImageUrlsFromHtml(html, hit.url);
            if (imageUrls.length) {
              officialImagesFromMeta += imageUrls.length;
              for (const imageUrl of imageUrls) {
                seeds.push({ url: imageUrl, sourceUrl: hit.url });
              }
              stages.push({
                stage: "official_image_meta",
                status: "ok",
                acceptedCount: imageUrls.length,
                reason: [
                  facts.usedOpenGraph ? "og:image" : null,
                  facts.usedJsonLd ? "json_ld_image" : null
                ]
                  .filter(Boolean)
                  .join(",") || "image_metadata",
                sourceUrls: [hit.url]
              });
            } else {
              officialPagesWithoutImageMeta += 1;
              stages.push({
                stage: "official_image_meta",
                status: "no_result",
                reason: "official_page_no_image_metadata",
                sourceUrls: [hit.url]
              });
              // Bounded static HTML fallback (img/picture/preload/CSS) — no JS render.
              const imgScan = await extractOfficialPageImgCandidatesAsync(html, hit.url, {
                brand: candidate.brand.value,
                name: candidate.name.value
              });
              stages.push({
                stage: "official_page_img_scan",
                status: imgScan.scanned ? "ok" : "no_result",
                candidateCount: imgScan.scanned,
                reason: imgScan.clientRenderedShell
                  ? "official_page_client_rendered: static HTML contained no product image assets"
                  : `${imgScan.scanned} image refs found`,
                sourceUrls: [hit.url]
              });
              if (imgScan.diagnostic === "official_page_client_rendered") {
                stages.push({
                  stage: "official_page_client_rendered",
                  status: "no_result",
                  reason: "static HTML contained no product image assets",
                  sourceUrls: [hit.url]
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
              stages.push({
                stage: "official_page_img_prefilter",
                status: imgScan.prefiltered.length ? "ok" : "no_result",
                candidateCount: imgScan.scanned,
                acceptedCount: imgScan.prefiltered.length,
                reason: imgScan.prefiltered.length
                  ? `${imgScan.prefiltered.length} candidates`
                  : emptyReason,
                sourceUrls: [hit.url]
              });
              for (const img of imgScan.prefiltered) {
                seeds.push({
                  url: img.url,
                  sourceUrl: hit.url,
                  width: img.width,
                  height: img.height
                });
              }
              if (imgScan.prefiltered.length) {
                stages.push({
                  stage: "official_page_img_candidate",
                  status: "ok",
                  acceptedCount: imgScan.prefiltered.length,
                  reason: "accepted for verification",
                  sourceUrls: imgScan.prefiltered.slice(0, 6).map((i) => i.url)
                });
              }
            }
          } else {
            stages.push({
              stage: "official_image_meta",
              status: "error",
              reason: "official_page_fetch_failed",
              sourceUrls: [hit.url]
            });
          }
        }
      }
    }
    stages.push({
      stage: "page_discovery",
      status: officialPagesFound ? "ok" : "skipped",
      candidateCount: allHits.length,
      acceptedCount: officialPagesFound,
      reason: officialPagesFound
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

  const seen = new Set<string>();
  const uniqueSeeds = seeds.filter((s) => {
    const key = s.url.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const brand = candidate.brand.value;
  const name = candidate.name.value;
  const probed: ImageCandidate[] = [];
  const dimensionSources = new Map<string, "seed" | "image_header" | "unknown">();
  let fetchFailed = 0;
  const imageCandidateDiags: ImageCandidateDiagnostic[] = [];

  for (const seed of uniqueSeeds.slice(0, 20)) {
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
      const width = seed.width ?? probedMeta.width;
      const height = seed.height ?? probedMeta.height;
      if (seed.width != null && seed.height != null) dimsSource = "seed";
      else if (probedMeta.width != null && probedMeta.height != null) {
        dimsSource =
          probedMeta.dimensionsSource === "unknown" ? "unknown" : "image_header";
      }
      meta = {
        width,
        height,
        mimeType: seed.mimeType ?? probedMeta.mimeType,
        reachable: probedMeta.reachable,
        dimensionsSource: dimsSource
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Image probe failed");
      meta.reachable = false;
    }
    if (!meta.reachable) {
      fetchFailed += 1;
      const failedCandidate = toCandidate(seed, brand, name, discoveredDomains);
      imageCandidateDiags.push(
        buildImageCandidateDiagnostic({
          candidate: failedCandidate,
          fetchStatus: "failed",
          dimensionsSource: null,
          hardPassed: false,
          hardReasons: ["fetch_failed"],
          accepted: false,
          rejectionReasons: ["fetch_failed"]
        })
      );
      continue;
    }
    const item = toCandidate(
      {
        ...seed,
        width: meta.width,
        height: meta.height,
        mimeType: meta.mimeType
      },
      brand,
      name,
      discoveredDomains
    );
    dimensionSources.set(item.url, dimsSource);
    probed.push(item);
  }

  stages.push({
    stage: "candidates",
    status: probed.length ? "ok" : "no_result",
    candidateCount: uniqueSeeds.length,
    acceptedCount: probed.length,
    rejectedCount: fetchFailed,
    reason: probed.length ? undefined : (uniqueSeeds.length ? "fetch_failed" : "no_image_candidates"),
    sourceUrls: uniqueSeeds.slice(0, 10).map((s) => s.url)
  });

  if (!probed.length) {
    diagnostics.noResultReason = uniqueSeeds.length ? "source_fetch_failed" : "no_image_candidates";
    diagnostics.summary = uniqueSeeds.length
      ? "Image candidates could not be fetched"
      : "No image candidates found";
    diagnostics.stages = stages;
    diagnostics.imageCandidates = imageCandidateDiags;
    return {
      selected: null,
      evaluated: [],
      errors,
      diagnostics: sanitizeJobDiagnostics(diagnostics)
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
      imageCandidateDiags.push(
        buildImageCandidateDiagnostic({
          candidate: item,
          fetchStatus: "ok",
          dimensionsSource: dimensionSources.get(item.url) ?? "unknown",
          hardPassed: false,
          hardReasons: [reason],
          accepted: false,
          rejectionReasons: [reason]
        })
      );
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
      imageCandidateDiags.push(
        buildImageCandidateDiagnostic({
          candidate: item,
          fetchStatus: "ok",
          dimensionsSource: dimensionSources.get(item.url) ?? "unknown",
          hardPassed: true,
          hardReasons: [],
          score: base,
          accepted: false,
          rejectionReasons: ["below_vision_floor"]
        })
      );
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

  for (const item of visionQueue.slice(0, IMAGE_MAX_VISION_CHECKS)) {
    let vision: VisionVerification | null = null;
    let visionError: string | null = null;
    try {
      vision = await verify({ candidate, imageUrl: item.url });
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
      imageCandidateDiags.push(
        buildImageCandidateDiagnostic({
          candidate: item,
          fetchStatus: reason === "fetch_failed" ? "failed" : "ok",
          dimensionsSource: dimensionSources.get(item.url) ?? "unknown",
          hardPassed: true,
          hardReasons: [],
          visionError: reason,
          score: scoreImageCandidateBase(item),
          accepted: false,
          rejectionReasons: [reason]
        })
      );
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
    // Prefer primary reason from evaluateCandidate when present.
    if (evaluated.rejected && evaluated.rejectionReason) {
      if (!rejectionReasons.includes(evaluated.rejectionReason)) {
        rejectionReasons.unshift(evaluated.rejectionReason);
      }
    }

    imageCandidateDiags.push(
      buildImageCandidateDiagnostic({
        candidate: item,
        fetchStatus: "ok",
        dimensionsSource: dimensionSources.get(item.url) ?? "unknown",
        hardPassed: true,
        hardReasons: [],
        vision,
        score: evaluated.score,
        accepted: Boolean(selected && selected.url === evaluated.url && !evaluated.rejected),
        rejectionReasons: evaluated.rejected ? rejectionReasons : []
      })
    );

    if (selected) break;
  }

  for (const item of visionQueue.slice(IMAGE_MAX_VISION_CHECKS)) {
    scored.push({
      ...item,
      score: scoreImageCandidateBase(item),
      rejected: true,
      rejectionReason: "not_checked",
      verified: false
    });
    imageCandidateDiags.push(
      buildImageCandidateDiagnostic({
        candidate: item,
        fetchStatus: "ok",
        dimensionsSource: dimensionSources.get(item.url) ?? "unknown",
        hardPassed: true,
        hardReasons: [],
        score: scoreImageCandidateBase(item),
        accepted: false,
        rejectionReasons: ["not_checked"]
      })
    );
  }

  stages.push({
    stage: "verify",
    status: selected ? "ok" : "no_result",
    candidateCount: Math.min(visionQueue.length, IMAGE_MAX_VISION_CHECKS),
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

  // Prefer a summary that surfaces the most specific verified failure.
  const verifiedDiags = imageCandidateDiags.filter((d) => d.vision?.ran);
  const scoreFail = verifiedDiags.find((d) => d.rejectionReasons.includes("score_below_threshold"));
  const visionFail = verifiedDiags.find((d) =>
    d.rejectionReasons.some((r) =>
      ["wrong_product", "bottle_not_prominent", "meme_or_graphic", "contains_people"].includes(r)
    )
  );

  diagnostics.noResultReason = noResultReason;
  diagnostics.summary = selected
    ? `Accepted image score ${selected.score}`
    : scoreFail
      ? `Vision passed; score ${scoreFail.score} / ${IMAGE_ACCEPTANCE_THRESHOLD}; rejected: score below threshold`
      : visionFail
        ? `Image verification rejected candidates (${visionFail.rejectionReasons[0]})`
        : noResultReason === "verification_rejected"
          ? "Image verification rejected candidates"
          : noResultReason === "score_below_threshold"
            ? "Verified candidates scored below acceptance threshold"
            : "All image candidates were rejected";
  diagnostics.stages = stages;
  diagnostics.accepted = selected ? ["image"] : [];
  diagnostics.imageCandidates = imageCandidateDiags;

  return {
    selected,
    evaluated: scored.slice(0, 20),
    errors,
    diagnostics: sanitizeJobDiagnostics(diagnostics)
  };
}
