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

export type ImageCandidateStageReached =
  | "discovered"
  | "hard_filter"
  | "verification"
  | "scoring"
  | "accepted";

/** Stable candidate identity for diagnostic lifecycle (normalized URL). */
export function imageCandidateIdFromUrl(url: string): string {
  return normalizeImageUrlForDedupe(url) || String(url ?? "").trim();
}

/**
 * True when a URL is clearly a non-product image asset:
 * stylesheet / script / font / document / SVG chrome, or an obvious
 * placeholder / spacer / missing-image filename.
 * Conservative path/filename matching only — never blocks by TLD (e.g. .edu).
 */
export function isNonImageAssetUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    // Stylesheet / script / font / document — not fetchable product photos.
    // Keep .svg out of image candidates (UI chrome); product photos are raster.
    if (
      /\.(css|js|mjs|cjs|map|json|html?|xml|woff2?|ttf|otf|eot)(\?|$)/i.test(path)
      || /\.svg(\?|$)/i.test(path)
      || /\/(stylesheet|styles|theme)\.css$/i.test(path)
    ) {
      return true;
    }
    // Obvious placeholder / non-product filenames (e.g. artic.edu/.../default.jpg).
    const leaf = path.split("/").filter(Boolean).pop() ?? "";
    if (
      /^(default|placeholder)\.(jpe?g|png|gif|webp|bmp)$/i.test(leaf)
      || /^no[-_]?image([._-].*)?\.(jpe?g|png|gif|webp|bmp)$/i.test(leaf)
      || /^noimage([._-].*)?\.(jpe?g|png|gif|webp|bmp)$/i.test(leaf)
      || /^image-not-found([._-].*)?\.(jpe?g|png|gif|webp|bmp)?$/i.test(leaf)
      || /^missing[-_]?image([._-].*)?\.(jpe?g|png|gif|webp|bmp)?$/i.test(leaf)
      || /^(spacer|blank|transparent|1x1|pixel)\.(jpe?g|png|gif|webp|bmp|gif)$/i.test(leaf)
    ) {
      return true;
    }
    return false;
  } catch {
    return /\.(css|js|mjs|svg)(\?|$)/i.test(url)
      || /\/(default|placeholder)\.(jpe?g|png)(\?|$)/i.test(url);
  }
}

export type ImageCandidateDiagnostic = {
  /** Stable id = normalized URL; used to update the same record through stages. */
  candidateId?: string;
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
  /** Highest pipeline stage this candidate reached. */
  stageReached?: ImageCandidateStageReached;
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

/** Public diagnostic cap — prioritization decides which rows survive. */
export const MAX_IMAGE_CANDIDATE_DIAGNOSTICS = 12;

const TRACKING_QUERY_RE =
  /^(utm_|fbclid|gclid|_ga|mc_|ref|referrer|source|campaign)/i;
const CACHE_BUSTER_RE = /^(v|ver|version|cb|cache|t|ts|timestamp)$/i;
const SIGNED_QUERY_RE =
  /^(x-amz-|x-goog-|signature|sig|token|expires|expire|policy|key-pair-id)/i;
/** Common CDN resize/transform params — same path ≈ same asset for provenance merge. */
const RESIZE_QUERY_RE =
  /^(width|height|w|h|fit|crop|quality|q|format|fm|auto|dpr|device)$/i;

/** FWGS ccstore image endpoint — `source=` is the asset path, not tracking. */
const FWGS_DEDUPE_HOST = "www.finewineandgoodspirits.com";
const FWGS_CCSTORE_IMAGES_PATH = "/ccstore/v1/images";

function isFwgsCcstoreImageEndpoint(u: URL): boolean {
  if (u.hostname.toLowerCase() !== FWGS_DEDUPE_HOST) return false;
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return path === FWGS_CCSTORE_IMAGES_PATH;
}

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

/**
 * Normalize image URLs for duplicate detection only.
 * Strips tracking/cache-buster/signed/resize query params; keeps path identity.
 * On FWGS ccstore `/ccstore/v1/images/`, preserves `source=` (asset identity)
 * while still stripping rendition-only params (`width`/`height`/…).
 * Does not mutate the fetch URL — callers keep the preferred original.
 */
export function normalizeImageUrlForDedupe(url: string): string {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    const preserveFwgsSource = isFwgsCcstoreImageEndpoint(u);
    const kept = new URLSearchParams();
    for (const [key, value] of u.searchParams.entries()) {
      const keyLower = key.toLowerCase();
      if (
        TRACKING_QUERY_RE.test(key)
        && !(preserveFwgsSource && keyLower === "source")
      ) {
        continue;
      }
      if (SIGNED_QUERY_RE.test(key)) continue;
      if (CACHE_BUSTER_RE.test(key) && /^\d+$/.test(value)) continue;
      if (RESIZE_QUERY_RE.test(key)) continue;
      kept.append(key, value);
    }
    const qs = kept.toString();
    return `${u.protocol}//${u.host}${u.pathname}${qs ? `?${qs}` : ""}`;
  } catch {
    return raw;
  }
}

export type ImageSeedLike = {
  url: string;
  sourceUrl?: string | null;
  width?: number | null;
  height?: number | null;
  mimeType?: string | null;
  /** Only Figranium FWGS PLCB-bound seeds — never SearXNG. */
  identityMatched?: boolean;
};

function seedHasPageProvenance(seed: ImageSeedLike): boolean {
  return Boolean(String(seed.sourceUrl ?? "").trim());
}

/**
 * Prefer the stronger page-scoped provenance when merging duplicate assets.
 * Official-page direct reference outranks bare search discovery.
 */
export function preferStrongerImageSeed(a: ImageSeedLike, b: ImageSeedLike): ImageSeedLike {
  const aPage = seedHasPageProvenance(a);
  const bPage = seedHasPageProvenance(b);
  const primary = bPage && !aPage ? b : aPage && !bPage ? a : a;
  const secondary = primary === a ? b : a;
  return {
    url: primary.url,
    sourceUrl: primary.sourceUrl ?? secondary.sourceUrl ?? null,
    width: primary.width ?? secondary.width ?? null,
    height: primary.height ?? secondary.height ?? null,
    mimeType: primary.mimeType ?? secondary.mimeType ?? null,
    identityMatched:
      primary.identityMatched === true || secondary.identityMatched === true
        ? true
        : primary.identityMatched ?? secondary.identityMatched
  };
}

/** Dedupe seeds by normalized URL; merge provenance monotonically. */
export function mergeImageSeedsByNormalizedUrl(seeds: ImageSeedLike[]): ImageSeedLike[] {
  const map = new Map<string, ImageSeedLike>();
  const order: string[] = [];
  for (const seed of seeds) {
    const key = normalizeImageUrlForDedupe(seed.url);
    if (!key) continue;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...seed });
      order.push(key);
      continue;
    }
    map.set(key, preferStrongerImageSeed(existing, seed));
  }
  return order.map((k) => map.get(k)!);
}

function stageRank(stage: ImageCandidateStageReached | undefined): number {
  switch (stage) {
    case "accepted":
      return 5;
    case "scoring":
      return 4;
    case "verification":
      return 3;
    case "hard_filter":
      return 2;
    case "discovered":
    default:
      return 1;
  }
}

function maxStage(
  a: ImageCandidateStageReached | undefined,
  b: ImageCandidateStageReached | undefined
): ImageCandidateStageReached | undefined {
  if (!a) return b;
  if (!b) return a;
  return stageRank(b) > stageRank(a) ? b : a;
}

/** True when a diagnostic reached vision/scoring/acceptance. */
export function isVerificationStageDiagnostic(d: ImageCandidateDiagnostic): boolean {
  return (
    d.stageReached === "verification"
    || d.stageReached === "scoring"
    || d.stageReached === "accepted"
    || Boolean(d.vision?.ran)
  );
}

/**
 * Working map of candidate diagnostics keyed by stable candidateId.
 * Updates the SAME record as a candidate progresses — never inserts duplicates.
 * Cap is applied only via toBoundedList() after verification completes.
 */
export class ImageCandidateDiagnosticStore {
  private readonly byId = new Map<string, ImageCandidateDiagnostic>();
  private readonly order: string[] = [];

  get(candidateId: string): ImageCandidateDiagnostic | undefined {
    return this.byId.get(candidateId);
  }

  size(): number {
    return this.byId.size;
  }

  /** Upsert by candidateId; merges fields and monotonically advances stageReached. */
  upsert(partial: ImageCandidateDiagnostic & { candidateId: string }): ImageCandidateDiagnostic {
    const id = partial.candidateId;
    const existing = this.byId.get(id);
    if (!existing) {
      const created: ImageCandidateDiagnostic = {
        ...partial,
        candidateId: id,
        accepted: Boolean(partial.accepted),
        rejectionReasons: [...(partial.rejectionReasons ?? [])],
        stageReached: partial.stageReached ?? "discovered",
        vision: partial.vision ?? { ran: false }
      };
      this.byId.set(id, created);
      this.order.push(id);
      return created;
    }

    const merged: ImageCandidateDiagnostic = {
      ...existing,
      ...partial,
      candidateId: id,
      urlHost: partial.urlHost || existing.urlHost,
      urlPath: partial.urlPath ?? existing.urlPath,
      sourceType: partial.sourceType ?? existing.sourceType,
      sourcePageHost: partial.sourcePageHost ?? existing.sourcePageHost,
      sourcePagePath: partial.sourcePagePath ?? existing.sourcePagePath,
      width: partial.width ?? existing.width,
      height: partial.height ?? existing.height,
      mimeType: partial.mimeType ?? existing.mimeType,
      dimensionsSource: partial.dimensionsSource ?? existing.dimensionsSource,
      fetchStatus: partial.fetchStatus ?? existing.fetchStatus,
      stageReached: maxStage(existing.stageReached, partial.stageReached),
      hardFilter: partial.hardFilter ?? existing.hardFilter,
      vision: partial.vision
        ? {
            ...(existing.vision ?? { ran: false }),
            ...partial.vision
          }
        : existing.vision,
      score: partial.score !== undefined ? partial.score : existing.score,
      scoreComponents: partial.scoreComponents ?? existing.scoreComponents,
      threshold: partial.threshold ?? existing.threshold,
      accepted: partial.accepted !== undefined ? partial.accepted : existing.accepted,
      rejectionReasons:
        partial.rejectionReasons !== undefined
          ? [...partial.rejectionReasons]
          : existing.rejectionReasons
    };
    this.byId.set(id, merged);
    return merged;
  }

  /** Ensure a discovered-stage row exists for a seed (idempotent). */
  ensureDiscovered(options: {
    url: string;
    sourceType: ImageSourceType;
    sourceUrl?: string | null;
    width?: number | null;
    height?: number | null;
    mimeType?: string | null;
  }): ImageCandidateDiagnostic {
    const candidateId = imageCandidateIdFromUrl(options.url);
    const urlParts = safeImageUrlParts(options.url);
    const pageParts = safeImageUrlParts(options.sourceUrl);
    return this.upsert({
      candidateId,
      urlHost: urlParts.host,
      urlPath: urlParts.path || undefined,
      sourceType: options.sourceType,
      sourcePageHost: pageParts.host || undefined,
      sourcePagePath: pageParts.path || undefined,
      width: options.width ?? null,
      height: options.height ?? null,
      mimeType: options.mimeType ?? null,
      stageReached: "discovered",
      accepted: false,
      rejectionReasons: [],
      vision: { ran: false }
    });
  }

  markHardFilter(options: {
    url: string;
    sourceType: ImageSourceType;
    sourceUrl?: string | null;
    width?: number | null;
    height?: number | null;
    mimeType?: string | null;
    dimensionsSource?: "seed" | "image_header" | "unknown" | null;
    fetchStatus?: "ok" | "failed";
    reasons: string[];
    score?: number | null;
  }): ImageCandidateDiagnostic {
    const candidateId = imageCandidateIdFromUrl(options.url);
    const urlParts = safeImageUrlParts(options.url);
    const pageParts = safeImageUrlParts(options.sourceUrl);
    return this.upsert({
      candidateId,
      urlHost: urlParts.host,
      urlPath: urlParts.path || undefined,
      sourceType: options.sourceType,
      sourcePageHost: pageParts.host || undefined,
      sourcePagePath: pageParts.path || undefined,
      width: options.width ?? null,
      height: options.height ?? null,
      mimeType: options.mimeType ?? null,
      dimensionsSource: options.dimensionsSource ?? null,
      fetchStatus: options.fetchStatus ?? "ok",
      stageReached: "hard_filter",
      hardFilter: { passed: false, reasons: options.reasons },
      score: options.score ?? null,
      threshold: IMAGE_ACCEPTANCE_THRESHOLD,
      accepted: false,
      rejectionReasons: options.reasons,
      vision: { ran: false }
    });
  }

  /** Before vision call: stageReached=verification, vision.ran=true. */
  markVerificationStarted(options: {
    url: string;
    sourceType: ImageSourceType;
    sourceUrl?: string | null;
    width?: number | null;
    height?: number | null;
    mimeType?: string | null;
    dimensionsSource?: "seed" | "image_header" | "unknown" | null;
  }): ImageCandidateDiagnostic {
    const candidateId = imageCandidateIdFromUrl(options.url);
    const urlParts = safeImageUrlParts(options.url);
    const pageParts = safeImageUrlParts(options.sourceUrl);
    return this.upsert({
      candidateId,
      urlHost: urlParts.host,
      urlPath: urlParts.path || undefined,
      sourceType: options.sourceType,
      sourcePageHost: pageParts.host || undefined,
      sourcePagePath: pageParts.path || undefined,
      width: options.width ?? null,
      height: options.height ?? null,
      mimeType: options.mimeType ?? null,
      dimensionsSource: options.dimensionsSource ?? null,
      fetchStatus: "ok",
      stageReached: "verification",
      hardFilter: { passed: true, reasons: [] },
      accepted: false,
      rejectionReasons: [],
      threshold: IMAGE_ACCEPTANCE_THRESHOLD,
      vision: { ran: true }
    });
  }

  /** After vision call: persist structured flags or provider/parse error. */
  markVerificationResult(options: {
    url: string;
    vision?: VisionVerification | null;
    visionError?: string | null;
    score?: number | null;
    scoreComponents?: ImageScoreComponents | null;
    accepted: boolean;
    rejectionReasons: string[];
    stageReached: ImageCandidateStageReached;
    fetchStatus?: "ok" | "failed";
    sourceType: ImageSourceType;
    sourceUrl?: string | null;
    width?: number | null;
    height?: number | null;
    mimeType?: string | null;
    dimensionsSource?: "seed" | "image_header" | "unknown" | null;
  }): ImageCandidateDiagnostic {
    const candidateId = imageCandidateIdFromUrl(options.url);
    const urlParts = safeImageUrlParts(options.url);
    const pageParts = safeImageUrlParts(options.sourceUrl);
    let vision: ImageCandidateVisionDiagnostic;
    if (options.visionError) {
      vision = { ran: true, error: options.visionError };
    } else if (options.vision) {
      vision = {
        ran: true,
        correctProduct: options.vision.correct_product,
        bottleProminent: options.vision.bottle_prominent,
        containsPeople: options.vision.contains_people,
        memeOrGraphic: options.vision.meme_or_graphic,
        cleanProductPhoto: options.vision.clean_product_photo,
        multipleProducts: options.vision.multiple_products ?? false,
        error: null
      };
    } else {
      vision = { ran: true };
    }
    return this.upsert({
      candidateId,
      urlHost: urlParts.host,
      urlPath: urlParts.path || undefined,
      sourceType: options.sourceType,
      sourcePageHost: pageParts.host || undefined,
      sourcePagePath: pageParts.path || undefined,
      width: options.width ?? null,
      height: options.height ?? null,
      mimeType: options.mimeType ?? null,
      dimensionsSource: options.dimensionsSource ?? null,
      fetchStatus: options.fetchStatus ?? "ok",
      stageReached: options.stageReached,
      hardFilter: { passed: true, reasons: [] },
      vision,
      score: options.score ?? null,
      scoreComponents: options.scoreComponents ?? null,
      threshold: IMAGE_ACCEPTANCE_THRESHOLD,
      accepted: options.accepted,
      rejectionReasons: options.rejectionReasons
    });
  }

  /** Unbounded working list (insertion order). Cap must not be applied here. */
  toArray(): ImageCandidateDiagnostic[] {
    return this.order.map((id) => this.byId.get(id)!).filter(Boolean);
  }

  verificationStageCount(): number {
    return this.toArray().filter(isVerificationStageDiagnostic).length;
  }

  /**
   * Sort by final stage priority, THEN apply max-N cap.
   * Call only after verification/scoring updates are complete.
   */
  toBoundedList(limit = MAX_IMAGE_CANDIDATE_DIAGNOSTICS): ImageCandidateDiagnostic[] {
    return prioritizeImageCandidateDiagnostics(this.toArray(), limit).map(
      sanitizeImageCandidateDiagnostic
    );
  }
}

/**
 * Prefer probing page-scoped (official) seeds before bare search discoveries
 * so verification candidates are not starved by the probe window.
 */
export function orderSeedsForProbe<T extends ImageSeedLike>(seeds: T[]): T[] {
  const withPage: T[] = [];
  const withoutPage: T[] = [];
  for (const seed of seeds) {
    if (seedHasPageProvenance(seed)) withPage.push(seed);
    else withoutPage.push(seed);
  }
  return [...withPage, ...withoutPage];
}

/**
 * Safe consistency check: stages sent-to-vision count must match
 * diagnostics with stageReached >= verification. Never throws.
 */
export function checkVerificationDiagnosticConsistency(options: {
  verificationCountFromStages: number;
  diagnostics: ImageCandidateDiagnostic[];
}): { ok: boolean; reason: string | null; diagnosticCount: number } {
  const diagnosticCount = options.diagnostics.filter(isVerificationStageDiagnostic).length;
  if (options.verificationCountFromStages <= 0) {
    return { ok: true, reason: null, diagnosticCount };
  }
  if (diagnosticCount === options.verificationCountFromStages) {
    return { ok: true, reason: null, diagnosticCount };
  }
  return {
    ok: false,
    reason: "verification_diagnostic_mismatch",
    diagnosticCount
  };
}

function sourceRank(sourceType: ImageSourceType | undefined): number {
  switch (sourceType) {
    case "official":
    case "user":
      return 4;
    case "licensed":
      return 3;
    case "approved":
      return 2;
    default:
      return 1;
  }
}

/** Higher = more important to retain in bounded diagnostics. */
export function imageCandidateDiagnosticPriority(d: ImageCandidateDiagnostic): number {
  let score = stageRank(d.stageReached) * 1000;
  score += sourceRank(d.sourceType) * 100;
  if (d.accepted) score += 500;
  if (d.vision?.ran) score += 200;
  // Prefer higher deterministic image scores as a tiebreaker so real bottle
  // candidates outrank decorative official assets that also reached verification.
  if (typeof d.score === "number" && Number.isFinite(d.score)) {
    score += Math.max(-200, Math.min(200, d.score));
  }
  if (d.fetchStatus === "failed") score -= 50;
  if (d.sourceType === "unknown" && d.stageReached === "discovered") score -= 100;
  return score;
}

/**
 * Bound diagnostics while preferring verification-stage / official candidates.
 * Invariant: verification-stage candidates are never all displaced by search junk.
 * Cap must be applied to FINAL diagnostic state (after verification updates).
 */
export function prioritizeImageCandidateDiagnostics(
  list: ImageCandidateDiagnostic[],
  limit = MAX_IMAGE_CANDIDATE_DIAGNOSTICS
): ImageCandidateDiagnostic[] {
  if (list.length <= limit) {
    return [...list].sort(
      (a, b) => imageCandidateDiagnosticPriority(b) - imageCandidateDiagnosticPriority(a)
    );
  }

  const verification = list.filter(isVerificationStageDiagnostic);
  const rest = list.filter((d) => !isVerificationStageDiagnostic(d));

  verification.sort(
    (a, b) => imageCandidateDiagnosticPriority(b) - imageCandidateDiagnosticPriority(a)
  );
  rest.sort(
    (a, b) => imageCandidateDiagnosticPriority(b) - imageCandidateDiagnosticPriority(a)
  );

  // Always reserve slots for verification-stage candidates first.
  const keptVerification = verification.slice(0, limit);
  const remaining = Math.max(0, limit - keptVerification.length);
  return [...keptVerification, ...rest.slice(0, remaining)];
}

/** Keeper-facing summary emphasizing verification-stage outcomes. */
export function summarizeImageCandidateDiagnostics(
  list: ImageCandidateDiagnostic[],
  options: { selectedScore?: number | null; noResultReason?: string | null } = {}
): string {
  const total = list.length;
  const verification = list.filter(isVerificationStageDiagnostic);
  const officialVerification = verification.filter(
    (d) => d.sourceType === "official" || d.sourceType === "user"
  );
  const accepted = list.filter((d) => d.accepted);
  if (accepted.length && options.selectedScore != null) {
    return `Accepted image score ${options.selectedScore}`;
  }
  if (verification.length) {
    const rejected = verification.filter((d) => !d.accepted);
    const officialBit = officialVerification.length
      ? `${officialVerification.length} official candidate${officialVerification.length === 1 ? "" : "s"} reached verification`
      : `${verification.length} candidate${verification.length === 1 ? "" : "s"} reached verification`;
    const rejectBit = rejected.length
      ? `${rejected.length} rejected by verification/scoring`
      : "none accepted";
    const topReason = rejected[0]?.rejectionReasons?.[0];
    return [
      `${total} candidates checked`,
      officialBit,
      rejectBit,
      topReason ? `top reason: ${formatImageRejectionReason(topReason)}` : null
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (options.noResultReason === "score_below_threshold") {
    return "Verified candidates scored below acceptance threshold";
  }
  if (options.noResultReason === "verification_rejected") {
    return "Image verification rejected candidates";
  }
  return total ? `${total} candidates checked; none accepted` : "No image candidates found";
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

  if (candidate.identityMatched === true) {
    components.identity_match = IMAGE_SCORE.exactIdentityMatch;
  }

  if (vision) {
    if (vision.correct_product) {
      // Keep max so we do not invent a new weight or double-count in diagnostics total.
      components.identity_match = Math.max(
        components.identity_match,
        IMAGE_SCORE.exactIdentityMatch
      );
    }
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
  stageReached?: ImageCandidateStageReached;
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

  let stageReached = options.stageReached;
  if (!stageReached) {
    if (options.accepted) stageReached = "accepted";
    else if (options.vision || options.visionError) stageReached = "verification";
    else if (!options.hardPassed || options.fetchStatus === "failed") stageReached = "hard_filter";
    else stageReached = "discovered";
  }

  const diag: ImageCandidateDiagnostic = {
    candidateId: imageCandidateIdFromUrl(options.candidate.url),
    urlHost: urlParts.host,
    urlPath: urlParts.path || undefined,
    sourceType: options.candidate.sourceType,
    width: options.candidate.width,
    height: options.candidate.height,
    mimeType: options.candidate.mimeType,
    dimensionsSource: options.dimensionsSource ?? (options.candidate.width != null ? "seed" : "unknown"),
    fetchStatus: options.fetchStatus ?? "ok",
    stageReached,
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
    candidateId: d.candidateId != null ? String(d.candidateId).slice(0, 320) : undefined,
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
    stageReached: d.stageReached,
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
  return prioritizeImageCandidateDiagnostics(list, MAX_IMAGE_CANDIDATE_DIAGNOSTICS).map(
    sanitizeImageCandidateDiagnostic
  );
}

/** Human-friendly rejection label for keeper UI. */
export function formatImageRejectionReason(reason: string): string {
  return String(reason)
    .replace(/^score_below_threshold:.*/, "score below threshold")
    .replace(/_/g, " ");
}
