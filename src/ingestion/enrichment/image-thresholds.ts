/**
 * Centralized thresholds and score weights for product-image enrichment.
 * Scores are applied deterministically — never LLM-assigned.
 */

/** Prefer roughly square product photos at least this large when dimensions are known. */
export const IMAGE_MIN_WIDTH = 600;
export const IMAGE_MIN_HEIGHT = 600;

/** Bonus band for large product photos. */
export const IMAGE_LARGE_MIN = 1200;

/**
 * Reject extreme landscape / social-card ratios.
 * aspect = max(w,h) / min(w,h); values above this are rejected when dimensions known.
 */
export const IMAGE_MAX_ASPECT_RATIO = 2.4;

/** Deterministic score weights (documented for audits/tests). */
export const IMAGE_SCORE = {
  officialSource: 40,
  licensedSource: 25,
  approvedSource: 15,
  exactIdentityMatch: 30,
  cleanProductPhoto: 20,
  largeImage: 10,
  personPresent: -40,
  memeOrGraphic: -50,
  multipleProducts: -20,
  lowResolution: -30,
  unknownSource: -100,
  retailerSource: -100
} as const;

/** Minimum score to accept a verified candidate. */
export const IMAGE_ACCEPTANCE_THRESHOLD = 75;

/** Soft floor before spending a vision call (after hard filters + base score). */
export const IMAGE_VISION_CANDIDATE_FLOOR = 40;

/** Max candidates to vision-verify per job. */
export const IMAGE_MAX_VISION_CHECKS = 3;
