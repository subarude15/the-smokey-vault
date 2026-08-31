/**
 * Per-candidate image verification diagnostics (keeper/admin).
 * Safe: no binaries, no secrets, no prompts, bounded URL display.
 */
import type { ImageSourceType } from "./image-sources.js";
import type { VisionVerification } from "./image-score.js";
import {
  IMAGE_ACCEPTANCE_THRESHOLD,
  IMAGE_LARGE_MIN,
  IMAGE_MIN_HEIGHT,
  IMAGE_MIN_WIDTH,
  IMAGE_SCORE
} from "./image-thresholds.js";
import type { ImageCandidate } from "./image-score.js";

export type ImageScoreComponents = {
  official_source: number;
  licensed_source: number;
  approved_source: number;
  identity_match: number;
  clean_photo: number;
  large_image: number;
  contains_people: number;
  meme_penalty: number;
  multi_product_penalty: number;
  low_res_penalty: number;
  unknown_source: number;
  total: number;
  threshold: number;
};

export type ImageCandidateVisionDiagnostic = {
  ran: boolean;
  correctProduct?: boolean | null;
  bottleProminent?: boolean | null;
  containsPeople?: boolean | null;
  memeOrGraphic?: boolean | null;
  cleanProductPhoto?: boolean | null;
  multipleProducts?: boolean | null;
  error?: string | null;
};

export type ImageCandidateDiagnostic = {
  urlHost: string;
  urlPath?: string;
  sourceType: ImageSourceType;
  sourcePageHost?: string;
  sourcePagePath?: string;
  width?: number | null;
  height?: number | null;
  mimeType?: string | null;
  dimensionsSource?: "seed" | "image_header" | "unknown" | null;
  fetchStatus?: "ok" | "failed";
  hardFilter?: {
    passed: boolean;
    reasons: string[];
  };
  vision?: ImageCandidateVisionDiagnostic;
  score?: number | null;
  scoreComponents?: ImageScoreComponents | null;
  threshold?: number;
  accepted: boolean;
  rejectionReasons: string[];
};

const MAX_IMAGE_CANDIDATE_DIAGNOSTICS = 12;

/** Safe host + short path for UI (strips query/hash/tokens). */
export function safeImageUrlParts(url: string | null | undefined): {
  host: string;
  path: string;
  display: string;
} {
  const raw = String(url ?? "").trim();
  if (!raw) return { host: "", path: "", display: "" };
  try {
    const u = new URL(raw);
    const segments = u.pathname.split("/").filter(Boolean);
    const leaf = segments.length ? segments[segments.length - 1] : "";
    const shortPath = leaf
      ? `…/${leaf.slice(0, 48)}`
      : u.pathname.slice(0, 40);
    return {
      host: u.host,
      path: shortPath,
      display: `${u.host}${shortPath}`
    };
  } catch {
    return { host: "", path: raw.slice(0, 64), display: raw.slice(0, 80) };
  }
}

/** Deterministic score breakdown matching image-score.ts weights (no new weights). */
export function buildImageScoreComponents(
  candidate: ImageCandidate,
  vision: VisionVerification | null
): ImageScoreComponents {
  const components: ImageScoreComponents = {
    official_source: 0,
    licensed_source: 0,
    approved_source: 0,
    identity_match: 0,
    clean_photo: 0,
    large_image: 0,
    contains_people: 0,
    meme_penalty: 0,
    multi_product_penalty: 0,
    low_res_penalty: 0,
    unknown_source: 0,
    total: 0,
    threshold: IMAGE_ACCEPTANCE_THRESHOLD
  };

  if (candidate.sourceType === "official" || candidate.sourceType === "user") {
    components.official_source = IMAGE_SCORE.officialSource;
  } else if (candidate.sourceType === "licensed") {
    components.licensed_source = IMAGE_SCORE.licensedSource;
  } else if (candidate.sourceType === "approved") {
    components.approved_source = IMAGE_SCORE.approvedSource;
  } else {
    components.unknown_source = IMAGE_SCORE.unknownSource;
  }

  const { width, height } = candidate;
  if (width != null && height != null) {
    if (width < IMAGE_MIN_WIDTH || height < IMAGE_MIN_HEIGHT) {
      components.low_res_penalty = IMAGE_SCORE.lowResolution;
    } else if (width >= IMAGE_LARGE_MIN && height >= IMAGE_LARGE_MIN) {
      components.large_image = IMAGE_SCORE.largeImage;
    }
  }

  if (vision) {
    if (vision.correct_product) components.identity_match = IMAGE_SCORE.exactIdentityMatch;
    if (vision.clean_product_photo && vision.bottle_prominent) {
      components.clean_photo = IMAGE_SCORE.cleanProductPhoto;
    }
    if (vision.contains_people) components.contains_people = IMAGE_SCORE.personPresent;
    if (vision.meme_or_graphic) components.meme_penalty = IMAGE_SCORE.memeOrGraphic;
    if (vision.multiple_products) components.multi_product_penalty = IMAGE_SCORE.multipleProducts;
  }

  components.total =
    components.official_source
    + components.licensed_source
    + components.approved_source
    + components.identity_match
    + components.clean_photo
    + components.large_image
    + components.contains_people
    + components.meme_penalty
    + components.multi_product_penalty
    + components.low_res_penalty
    + components.unknown_source;

  return components;
}

export function sumScoreComponents(components: ImageScoreComponents): number {
  return (
    components.official_source
    + components.licensed_source
    + components.approved_source
    + components.identity_match
    + components.clean_photo
    + components.large_image
    + components.contains_people
    + components.meme_penalty
    + components.multi_product_penalty
    + components.low_res_penalty
    + components.unknown_source
  );
}

/** Derive explicit rejection reasons after vision + score (never empty when rejected). */
export function collectImageRejectionReasons(options: {
  hardReason?: string | null;
  vision: VisionVerification | null;
  visionError?: string | null;
  score: number;
  accepted: boolean;
  verified: boolean;
}): string[] {
  const reasons: string[] = [];
  if (options.hardReason) reasons.push(options.hardReason);
  if (options.visionError) reasons.push(options.visionError);

  const vision = options.vision;
  if (vision) {
    if (!vision.correct_product) reasons.push("wrong_product");
    if (vision.meme_or_graphic) reasons.push("meme_or_graphic");
    if (vision.contains_people) reasons.push("contains_people");
    if (!vision.bottle_prominent) reasons.push("bottle_not_prominent");
    if (!vision.clean_product_photo) reasons.push("not_clean_product_photo");
  }

  if (
    options.verified
    && vision?.correct_product
    && vision.bottle_prominent
    && vision.clean_product_photo
    && !vision.meme_or_graphic
    && options.score < IMAGE_ACCEPTANCE_THRESHOLD
  ) {
    reasons.push("score_below_threshold");
  }

  if (!options.accepted && reasons.length === 0) {
    reasons.push("all_image_candidates_rejected");
  }

  // Deduplicate while preserving order.
  const seen = new Set<string>();
  return reasons.filter((r) => {
    if (seen.has(r)) return false;
    seen.add(r);
    return true;
  });
}

export function buildImageCandidateDiagnostic(options: {
  candidate: ImageCandidate;
  fetchStatus?: "ok" | "failed";
  dimensionsSource?: "seed" | "image_header" | "unknown" | null;
  hardPassed: boolean;
  hardReasons?: string[];
  vision?: VisionVerification | null;
  visionError?: string | null;
  score?: number | null;
  accepted: boolean;
  rejectionReasons: string[];
}): ImageCandidateDiagnostic {
  const urlParts = safeImageUrlParts(options.candidate.url);
  const pageParts = safeImageUrlParts(options.candidate.sourceUrl);
  const vision = options.vision ?? null;
  const score =
    options.score
    ?? (vision || options.hardPassed
      ? buildImageScoreComponents(options.candidate, vision).total
      : null);
  const scoreComponents =
    options.hardPassed || vision
      ? buildImageScoreComponents(options.candidate, vision)
      : null;

  const diag: ImageCandidateDiagnostic = {
    urlHost: urlParts.host,
    urlPath: urlParts.path || undefined,
    sourceType: options.candidate.sourceType,
    width: options.candidate.width,
    height: options.candidate.height,
    mimeType: options.candidate.mimeType,
    dimensionsSource: options.dimensionsSource ?? (options.candidate.width != null ? "seed" : "unknown"),
    fetchStatus: options.fetchStatus ?? "ok",
    hardFilter: {
      passed: options.hardPassed,
      reasons: options.hardReasons ?? []
    },
    score,
    scoreComponents,
    threshold: IMAGE_ACCEPTANCE_THRESHOLD,
    accepted: options.accepted,
    rejectionReasons: options.rejectionReasons
  };

  if (pageParts.host) {
    diag.sourcePageHost = pageParts.host;
    diag.sourcePagePath = pageParts.path || undefined;
  }

  if (options.visionError) {
    diag.vision = {
      ran: true,
      error: options.visionError
    };
  } else if (vision) {
    diag.vision = {
      ran: true,
      correctProduct: vision.correct_product,
      bottleProminent: vision.bottle_prominent,
      containsPeople: vision.contains_people,
      memeOrGraphic: vision.meme_or_graphic,
      cleanProductPhoto: vision.clean_product_photo,
      multipleProducts: vision.multiple_products ?? false,
      error: null
    };
  } else {
    diag.vision = { ran: false };
  }

  return diag;
}

export function sanitizeImageCandidateDiagnostic(
  d: ImageCandidateDiagnostic
): ImageCandidateDiagnostic {
  return {
    urlHost: String(d.urlHost ?? "").slice(0, 120),
    urlPath: d.urlPath != null ? String(d.urlPath).slice(0, 80) : undefined,
    sourceType: d.sourceType,
    sourcePageHost: d.sourcePageHost != null ? String(d.sourcePageHost).slice(0, 120) : undefined,
    sourcePagePath: d.sourcePagePath != null ? String(d.sourcePagePath).slice(0, 80) : undefined,
    width: d.width ?? null,
    height: d.height ?? null,
    mimeType: d.mimeType != null ? String(d.mimeType).slice(0, 64) : null,
    dimensionsSource: d.dimensionsSource ?? null,
    fetchStatus: d.fetchStatus,
    hardFilter: d.hardFilter
      ? {
          passed: Boolean(d.hardFilter.passed),
          reasons: (d.hardFilter.reasons ?? []).slice(0, 8).map((r) => String(r).slice(0, 64))
        }
      : undefined,
    vision: d.vision
      ? {
          ran: Boolean(d.vision.ran),
          correctProduct: d.vision.correctProduct ?? null,
          bottleProminent: d.vision.bottleProminent ?? null,
          containsPeople: d.vision.containsPeople ?? null,
          memeOrGraphic: d.vision.memeOrGraphic ?? null,
          cleanProductPhoto: d.vision.cleanProductPhoto ?? null,
          multipleProducts: d.vision.multipleProducts ?? null,
          error: d.vision.error != null ? String(d.vision.error).slice(0, 80) : null
        }
      : undefined,
    score: d.score ?? null,
    scoreComponents: d.scoreComponents ?? null,
    threshold: d.threshold ?? IMAGE_ACCEPTANCE_THRESHOLD,
    accepted: Boolean(d.accepted),
    rejectionReasons: (d.rejectionReasons ?? []).slice(0, 12).map((r) => String(r).slice(0, 64))
  };
}

export function boundImageCandidateDiagnostics(
  list: ImageCandidateDiagnostic[]
): ImageCandidateDiagnostic[] {
  return list.slice(0, MAX_IMAGE_CANDIDATE_DIAGNOSTICS).map(sanitizeImageCandidateDiagnostic);
}

/** Human-friendly rejection label for keeper UI. */
export function formatImageRejectionReason(reason: string): string {
  return String(reason)
    .replace(/^score_below_threshold:.*/, "score below threshold")
    .replace(/_/g, " ");
}
