/**
 * Hard rejection + deterministic scoring for image candidates.
 */
import {
  IMAGE_ACCEPTANCE_THRESHOLD,
  IMAGE_LARGE_MIN,
  IMAGE_MAX_ASPECT_RATIO,
  IMAGE_MIN_HEIGHT,
  IMAGE_MIN_WIDTH,
  IMAGE_SCORE
} from "./image-thresholds.js";
import type { ImageSourceType } from "./image-sources.js";
import { isAcceptableImageSource } from "./image-sources.js";

export type ImageCandidate = {
  url: string;
  sourceUrl: string | null;
  sourceType: ImageSourceType;
  width: number | null;
  height: number | null;
  mimeType: string | null;
};

export type VisionVerification = {
  correct_product: boolean;
  bottle_prominent: boolean;
  contains_people: boolean;
  meme_or_graphic: boolean;
  clean_product_photo: boolean;
  multiple_products?: boolean;
};

export type ScoredImageCandidate = ImageCandidate & {
  score: number;
  rejected: boolean;
  rejectionReason: string | null;
  verified: boolean;
};

export type HardRejectResult = {
  rejected: boolean;
  reason: string | null;
};

function aspectRatio(width: number, height: number): number {
  const a = Math.max(width, height);
  const b = Math.min(width, height);
  if (b <= 0) return Number.POSITIVE_INFINITY;
  return a / b;
}

/** Hard filters applied before scoring / vision. */
export function hardRejectCandidate(candidate: ImageCandidate): HardRejectResult {
  if (!candidate.url?.trim()) {
    return { rejected: true, reason: "missing_url" };
  }
  if (!isAcceptableImageSource(candidate.sourceType) || candidate.sourceType === "unknown") {
    return { rejected: true, reason: "unapproved_source" };
  }

  const mime = candidate.mimeType?.toLowerCase() ?? null;
  if (mime && !mime.startsWith("image/") && mime !== "application/octet-stream") {
    return { rejected: true, reason: "unsupported_content_type" };
  }

  const { width, height } = candidate;
  if (width != null && height != null) {
    if (width < IMAGE_MIN_WIDTH || height < IMAGE_MIN_HEIGHT) {
      return { rejected: true, reason: "low_resolution" };
    }
    if (aspectRatio(width, height) > IMAGE_MAX_ASPECT_RATIO) {
      return { rejected: true, reason: "extreme_aspect_ratio" };
    }
  }

  const urlLower = candidate.url.toLowerCase();
  if (
    urlLower.includes("thumb") &&
    (urlLower.includes("/50x") || urlLower.includes("/100x") || urlLower.includes("_s.") || urlLower.includes("tiny"))
  ) {
    return { rejected: true, reason: "social_thumbnail" };
  }

  return { rejected: false, reason: null };
}

/**
 * Base deterministic score from source + dimensions (before vision).
 * Unknown/retailer sources return a heavily penalized score but should already be hard-rejected.
 */
export function scoreImageCandidateBase(candidate: ImageCandidate): number {
  let score = 0;
  if (candidate.sourceType === "official") score += IMAGE_SCORE.officialSource;
  else if (candidate.sourceType === "licensed") score += IMAGE_SCORE.licensedSource;
  else if (candidate.sourceType === "approved") score += IMAGE_SCORE.approvedSource;
  else if (candidate.sourceType === "user") score += IMAGE_SCORE.officialSource;
  else score += IMAGE_SCORE.unknownSource;

  const { width, height } = candidate;
  if (width != null && height != null) {
    if (width < IMAGE_MIN_WIDTH || height < IMAGE_MIN_HEIGHT) {
      score += IMAGE_SCORE.lowResolution;
    } else if (width >= IMAGE_LARGE_MIN && height >= IMAGE_LARGE_MIN) {
      score += IMAGE_SCORE.largeImage;
    }
  }

  return score;
}

/** Apply vision verification adjustments. Identity match assumes verifier says correct_product. */
export function applyVisionScoreAdjustments(baseScore: number, vision: VisionVerification): number {
  let score = baseScore;
  if (vision.correct_product) score += IMAGE_SCORE.exactIdentityMatch;
  if (vision.clean_product_photo && vision.bottle_prominent) score += IMAGE_SCORE.cleanProductPhoto;
  if (vision.contains_people) score += IMAGE_SCORE.personPresent;
  if (vision.meme_or_graphic) score += IMAGE_SCORE.memeOrGraphic;
  if (vision.multiple_products) score += IMAGE_SCORE.multipleProducts;
  return score;
}

export function meetsAcceptanceThreshold(score: number): boolean {
  return score >= IMAGE_ACCEPTANCE_THRESHOLD;
}

/**
 * Primary rejection reason after vision (most specific first).
 * Product-image acceptance requires a prominent bottle subject.
 */
export function primaryVisionRejectionReason(
  vision: VisionVerification,
  score: number
): string | null {
  if (!vision.correct_product) return "wrong_product";
  if (vision.meme_or_graphic) return "meme_or_graphic";
  if (!vision.bottle_prominent) return "bottle_not_prominent";
  if (!vision.clean_product_photo) return "not_clean_product_photo";
  if (vision.contains_people && score < IMAGE_ACCEPTANCE_THRESHOLD) return "contains_people";
  return null;
}

export function evaluateCandidate(
  candidate: ImageCandidate,
  vision: VisionVerification | null = null
): ScoredImageCandidate {
  const hard = hardRejectCandidate(candidate);
  if (hard.rejected) {
    return {
      ...candidate,
      score: 0,
      rejected: true,
      rejectionReason: hard.reason,
      verified: false
    };
  }
  let score = scoreImageCandidateBase(candidate);
  let verified = false;
  if (vision) {
    score = applyVisionScoreAdjustments(score, vision);
    verified = true;
    const visionReject = primaryVisionRejectionReason(vision, score);
    if (visionReject) {
      return {
        ...candidate,
        score,
        rejected: true,
        rejectionReason: visionReject,
        verified: true
      };
    }
  }
  return {
    ...candidate,
    score,
    rejected: false,
    rejectionReason: null,
    verified
  };
}

export { IMAGE_ACCEPTANCE_THRESHOLD, IMAGE_SCORE };
