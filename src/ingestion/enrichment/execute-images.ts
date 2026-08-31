/**
 * Discover, score, and verify product image candidates for an identified bottle.
 * Persists provenance only — does not rehost third-party images in this PR.
 */
import type { BottleCandidate } from "../candidate/types.js";
import { searchWebHits, type WebSearchHit } from "../web-search.js";
import { classifyImageSource } from "./image-sources.js";
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
  IMAGE_MAX_VISION_CHECKS,
  IMAGE_VISION_CANDIDATE_FLOOR
} from "./image-thresholds.js";
import { verifyProductImage } from "./image-verify.js";

export type ImageMeta = {
  width: number | null;
  height: number | null;
  mimeType: string | null;
  reachable: boolean;
};

export type ImageEnrichmentDeps = {
  searchWebHits?: (query: string, limit?: number) => Promise<WebSearchHit[]>;
  searchImageHits?: (query: string, limit?: number) => Promise<ImageCandidateSeed[]>;
  probeImageMeta?: (url: string) => Promise<ImageMeta>;
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
};

function imageSearchQuery(candidate: BottleCandidate): string {
  return [
    candidate.brand.value,
    candidate.name.value,
    candidate.product_type.value,
    candidate.upc.value,
    "bottle product photo"
  ]
    .map((p) => String(p ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

/** Default SearXNG image category search. */
export async function searchImageHits(query: string, limit = 8): Promise<ImageCandidateSeed[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const params = new URLSearchParams({
      q,
      format: "json",
      categories: "images"
    });
    const response = await fetch(`http://192.168.1.184:8888/search?${params}`, {
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return [];
    const data = await response.json() as {
      results?: Array<{
        url?: string;
        img_src?: string;
        thumbnail_src?: string;
        thumbnail?: string;
        title?: string;
        width?: number | string;
        height?: number | string;
      }>;
    };
    const out: ImageCandidateSeed[] = [];
    for (const row of (data.results ?? []).slice(0, Math.max(0, limit))) {
      const imageUrl = String(row.img_src || row.thumbnail_src || row.url || "").trim();
      const pageUrl = String(row.url || "").trim() || null;
      if (!imageUrl.startsWith("http")) continue;
      const width = row.width != null ? Number(row.width) : null;
      const height = row.height != null ? Number(row.height) : null;
      out.push({
        url: imageUrl,
        sourceUrl: pageUrl,
        width: Number.isFinite(width) ? width : null,
        height: Number.isFinite(height) ? height : null,
        mimeType: null
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function defaultProbe(url: string): Promise<ImageMeta> {
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
      headers: { Range: "bytes=0-0" }
    });
    const mimeType = (response.headers.get("content-type") ?? "").split(";")[0].trim() || null;
    // Dimensions often unavailable without decoding — leave null (not a hard reject alone).
    return {
      width: null,
      height: null,
      mimeType: mimeType?.startsWith("image/") ? mimeType : mimeType,
      reachable: response.ok || response.status === 206
    };
  } catch {
    return { width: null, height: null, mimeType: null, reachable: false };
  }
}

function toCandidate(
  seed: ImageCandidateSeed,
  brand: string | null,
  name: string | null
): ImageCandidate {
  const sourceType = classifyImageSource(seed.url, {
    brand,
    name,
    pageUrl: seed.sourceUrl
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
  const verify = deps.verifyImage ?? ((req) => verifyProductImage(req));
  const errors: string[] = [];
  const seeds: ImageCandidateSeed[] = [];

  const query = imageSearchQuery(candidate);
  try {
    seeds.push(...(await searchImages(query, 8)));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Image search failed");
  }

  // Supplement with official-looking page hits that may reference product imagery.
  try {
    const hits = await searchWeb(query, 5);
    for (const hit of hits) {
      if (!hit.url) continue;
      // Only keep hits that classify as official/licensed/approved when used as page context.
      const sourceType = classifyImageSource(hit.url, {
        brand: candidate.brand.value,
        name: candidate.name.value,
        pageUrl: hit.url
      });
      if (sourceType === "official" || sourceType === "licensed" || sourceType === "approved") {
        // Page URL alone is not an image; skip unless it looks like a direct image.
        if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(hit.url)) {
          seeds.push({ url: hit.url, sourceUrl: hit.url });
        }
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Web search failed");
  }

  // Deduplicate by URL.
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
  for (const seed of uniqueSeeds) {
    let meta: ImageMeta = {
      width: seed.width ?? null,
      height: seed.height ?? null,
      mimeType: seed.mimeType ?? null,
      reachable: true
    };
    try {
      const probedMeta = await probe(seed.url);
      meta = {
        width: seed.width ?? probedMeta.width,
        height: seed.height ?? probedMeta.height,
        mimeType: seed.mimeType ?? probedMeta.mimeType,
        reachable: probedMeta.reachable
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Image probe failed");
      meta.reachable = false;
    }
    if (!meta.reachable) continue;
    probed.push(
      toCandidate(
        {
          ...seed,
          width: meta.width,
          height: meta.height,
          mimeType: meta.mimeType
        },
        brand,
        name
      )
    );
  }

  const scored: ScoredImageCandidate[] = [];
  const visionQueue: ImageCandidate[] = [];

  for (const item of probed) {
    const hard = hardRejectCandidate(item);
    if (hard.rejected) {
      scored.push({
        ...item,
        score: 0,
        rejected: true,
        rejectionReason: hard.reason,
        verified: false
      });
      continue;
    }
    const base = scoreImageCandidateBase(item);
    if (base >= IMAGE_VISION_CANDIDATE_FLOOR) {
      visionQueue.push(item);
    } else {
      scored.push({
        ...item,
        score: base,
        rejected: true,
        rejectionReason: "below_vision_floor",
        verified: false
      });
    }
  }

  visionQueue.sort((a, b) => scoreImageCandidateBase(b) - scoreImageCandidateBase(a));
  let selected: ScoredImageCandidate | null = null;

  for (const item of visionQueue.slice(0, IMAGE_MAX_VISION_CHECKS)) {
    let vision: VisionVerification | null = null;
    try {
      vision = await verify({ candidate, imageUrl: item.url });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Vision verify failed");
      scored.push({
        ...item,
        score: scoreImageCandidateBase(item),
        rejected: true,
        rejectionReason: "vision_error",
        verified: false
      });
      continue;
    }
    if (!vision) {
      scored.push({
        ...item,
        score: scoreImageCandidateBase(item),
        rejected: true,
        rejectionReason: "vision_unavailable",
        verified: false
      });
      continue;
    }
    const evaluated = evaluateCandidate(item, vision);
    scored.push(evaluated);
    if (!evaluated.rejected && meetsAcceptanceThreshold(evaluated.score)) {
      selected = evaluated;
      break;
    }
  }

  // Remaining vision-queue items not checked.
  for (const item of visionQueue.slice(IMAGE_MAX_VISION_CHECKS)) {
    scored.push({
      ...item,
      score: scoreImageCandidateBase(item),
      rejected: true,
      rejectionReason: "not_checked",
      verified: false
    });
  }

  return { selected, evaluated: scored, errors };
}
