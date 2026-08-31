/**
 * Read model for the bottle enrichment / review UI.
 * Combines inventory, candidate provenance, jobs, product_content, and product_images.
 */
import { getBarcodeCacheEntry } from "../../barcode_cache.js";
import {
  candidateFromProduct,
  CONFIDENCE,
  isUnresolvedField,
  mergeField,
  type BottleCandidate,
  type BottleCandidateFieldName,
  type FieldConflict,
  type ProductField,
  type ProductFieldSource
} from "../candidate/index.js";
import { getFromCache } from "../catalogs/cola-cache-store.js";
import { planEnrichment } from "../enrichment/index.js";
import { METADATA_ENRICHMENT_FIELDS } from "../enrichment/metadata-fields.js";
import { TRUSTED_MIN } from "../enrichment/rules.js";
import { candidateFromInventoryRow, loadInventoryRow } from "./inventory.js";
import { getProductContent, readPersonalNotes } from "./product-content.js";
import { getProductImage, inventoryHasUserImage } from "./product-images.js";
import { listJobsForEntity } from "./store.js";
import {
  ENRICHMENT_JOB_TYPES,
  isEnrichmentEntityType,
  type EnrichmentEntityType,
  type EnrichmentJob,
  type EnrichmentJobStatus,
  type EnrichmentJobType
} from "./types.js";

export type ConfidenceBand = "very_high" | "high" | "medium" | "low" | "none";

export type FieldViewStatus = "trusted" | "missing" | "low_confidence" | "review";

export type FieldView<T = string | number | null> = {
  value: T | null;
  source: string | null;
  sourceLabel: string | null;
  confidence: number | null;
  confidenceBand: ConfidenceBand;
  confidenceLabel: string;
  status: FieldViewStatus;
};

export type ConflictView = {
  field: string;
  keptValue: string | number | null;
  keptSource: string;
  keptSourceLabel: string;
  competingValue: string | number | null;
  competingSource: string;
  competingSourceLabel: string;
};

export type JobStatusLabel = "complete" | "in_progress" | "waiting" | "no_result" | "failed" | "not_started";

export type JobView = {
  type: EnrichmentJobType | string;
  status: EnrichmentJobStatus | "absent";
  statusLabel: JobStatusLabel;
  attempts: number;
  lastError: string | null;
};

export type BottleEnrichmentView = {
  entityType: EnrichmentEntityType;
  entityId: number;
  inventory: Record<string, unknown>;
  identity: {
    name: FieldView<string>;
    brand: FieldView<string>;
    productType: FieldView<string>;
    upc: FieldView<string>;
  };
  metadata: {
    category: FieldView<string>;
    abv: FieldView<number>;
    proof: FieldView<number>;
    volumeMl: FieldView<number>;
    origin: FieldView<string>;
    ttbId: FieldView<string>;
  };
  enrichment: {
    identified: boolean;
    needsReview: boolean;
    missing: string[];
    jobs: JobView[];
    conflicts: ConflictView[];
  };
  tastingNotes: {
    official: string | null;
    sourceUrl: string | null;
    sourceType: string | null;
    houseProfile: string | null;
    personal: string | null;
  };
  image: {
    /** Prefer user/shelf image when present. */
    displayUrl: string | null;
    enrichedUrl: string | null;
    sourceType: string | null;
    sourceUrl: string | null;
    score: number | null;
    verified: boolean | null;
    userPreferred: boolean;
  };
};

const SOURCE_LABELS: Record<ProductFieldSource, string> = {
  vault: "Vault",
  barcode_cache: "Barcode cache",
  beer_cache: "Beer cache",
  cola_cache: "COLA cache",
  fwgs: "FWGS",
  cola: "COLA",
  open_food_facts: "Open Food Facts",
  upcitemdb: "UPCitemdb",
  vision: "Vision",
  web: "Web",
  llm: "AI",
  user: "User",
  unknown: "Unknown"
};

export function sourceLabel(source: string | null | undefined): string {
  if (!source) return "Unknown";
  return SOURCE_LABELS[source as ProductFieldSource] ?? source;
}

/** Ensure tasting-note / house-profile fields are plain strings for React children. */
export function normalizeTextField(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function confidenceBandForScore(score: number | null | undefined): ConfidenceBand {
  if (score == null || !Number.isFinite(score) || score <= CONFIDENCE.NONE) return "none";
  if (score >= CONFIDENCE.VERY_HIGH) return "very_high";
  if (score >= CONFIDENCE.HIGH) return "high";
  if (score >= CONFIDENCE.MEDIUM) return "medium";
  if (score > CONFIDENCE.NONE) return "low";
  return "none";
}

export function confidenceLabelForBand(band: ConfidenceBand): string {
  switch (band) {
    case "very_high":
      return "Very high";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
    default:
      return "None";
  }
}

export function fieldViewFromProductField<T>(
  productField: ProductField<T> | null | undefined,
  options: { inReview?: boolean } = {}
): FieldView<T> {
  if (!productField || isUnresolvedField(productField)) {
    return {
      value: null,
      source: null,
      sourceLabel: null,
      confidence: null,
      confidenceBand: "none",
      confidenceLabel: "None",
      status: "missing"
    };
  }
  const band = confidenceBandForScore(productField.confidence);
  let status: FieldViewStatus = "trusted";
  if (options.inReview) status = "review";
  else if (productField.confidence < TRUSTED_MIN) status = "low_confidence";
  return {
    value: productField.value,
    source: productField.source,
    sourceLabel: sourceLabel(productField.source),
    confidence: productField.confidence,
    confidenceBand: band,
    confidenceLabel: confidenceLabelForBand(band),
    status
  };
}

/**
 * Map job row → user-facing status.
 * Completed with no useful result is "no_result", not failure.
 */
export function jobStatusLabel(
  job: EnrichmentJob | null,
  options: { hasResult?: boolean } = {}
): JobStatusLabel {
  if (!job) return "not_started";
  if (job.status === "pending") return "waiting";
  if (job.status === "running") return "in_progress";
  if (job.status === "failed") return "failed";
  if (job.status === "completed") {
    if (options.hasResult === false) return "no_result";
    return "complete";
  }
  return "waiting";
}

export function jobsHaveActiveWork(jobs: JobView[]): boolean {
  return jobs.some((j) => j.statusLabel === "waiting" || j.statusLabel === "in_progress");
}

function conflictViews(conflicts: FieldConflict[]): ConflictView[] {
  return conflicts.map((c) => ({
    field: c.field,
    keptValue: c.existing.value as string | number | null,
    keptSource: c.existing.source,
    keptSourceLabel: sourceLabel(c.existing.source),
    competingValue: c.incoming.value as string | number | null,
    competingSource: c.incoming.source,
    competingSourceLabel: sourceLabel(c.incoming.source)
  }));
}

/** Collect identity conflicts between vault row and UPC caches (read-only review). */
export function collectCacheConflicts(
  entityType: EnrichmentEntityType,
  row: Record<string, unknown>
): FieldConflict[] {
  const inferredType =
    entityType === "packaged_beer" ? "beer" : entityType === "wines" ? "wine" : "spirit";
  const normalized: Record<string, unknown> = {
    ...row,
    brand: row.brand ?? row.brewery ?? row.producer ?? "",
    category: row.category ?? row.style ?? row.varietal ?? row.type ?? "",
    product_type: row.product_type || inferredType,
    origin: row.origin ?? row.region ?? null,
    volume_ml: row.volume_ml === 0 || row.volume_ml === "0" ? null : row.volume_ml,
    abv: row.abv === 0 || row.abv === "0" ? null : row.abv
  };
  const vault = candidateFromProduct(normalized, "vault");
  if (isUnresolvedField(vault.product_type)) {
    vault.product_type = fieldLike(inferredType, "vault");
  }

  const conflicts: FieldConflict[] = [];
  const upc = String(row.upc ?? "").trim();
  if (!upc) return conflicts;

  const consider = (incoming: BottleCandidate, fields: BottleCandidateFieldName[]) => {
    for (const name of fields) {
      const merged = mergeField(
        vault[name] as ProductField<unknown>,
        incoming[name] as ProductField<unknown>,
        name
      );
      if (merged.conflict) conflicts.push(merged.conflict as FieldConflict);
    }
  };

  const cola = getFromCache(upc, { allowStale: true });
  if (cola) {
    consider(candidateFromProduct(cola, "cola_cache"), ["name", "brand", "product_type"]);
  }

  const barcode = getBarcodeCacheEntry(upc);
  if (barcode) {
    consider(
      candidateFromProduct(
        {
          upc: barcode.upc,
          name: barcode.name,
          brand: barcode.brand,
          category: barcode.category,
          abv: barcode.abv,
          proof: barcode.proof,
          volume_ml: barcode.volume_ml
        },
        "barcode_cache"
      ),
      ["name", "brand"]
    );
  }

  return conflicts;
}

function fieldLike<T>(value: T, source: ProductFieldSource): ProductField<T> {
  return {
    value,
    source,
    confidence: source === "vault" ? CONFIDENCE.VERY_HIGH : CONFIDENCE.HIGH
  };
}

function missingRecommendedLabels(candidate: BottleCandidate): string[] {
  const labels: Record<string, string> = {
    category: "Category",
    abv: "ABV",
    proof: "Proof",
    volume_ml: "Volume",
    origin: "Origin",
    ttb_id: "TTB ID",
    upc: "UPC"
  };
  const missing: string[] = [];
  for (const name of ["upc", "category", ...METADATA_ENRICHMENT_FIELDS] as const) {
    const f = candidate[name] as ProductField<unknown>;
    if (isUnresolvedField(f) || f.confidence < TRUSTED_MIN) {
      missing.push(labels[name] ?? name);
    }
  }
  return missing;
}

function buildJobViews(
  entityType: EnrichmentEntityType,
  entityId: number,
  content: ReturnType<typeof getProductContent>,
  image: ReturnType<typeof getProductImage>
): JobView[] {
  const jobs = listJobsForEntity(entityType, entityId);
  const byType = new Map(jobs.map((j) => [j.job_type, j]));

  return ENRICHMENT_JOB_TYPES.map((type) => {
    const job = byType.get(type) ?? null;
    let hasResult: boolean | undefined;
    if (type === "tasting_notes") {
      hasResult = Boolean(content?.official_tasting_notes || content?.house_tasting_profile);
    } else if (type === "image") {
      hasResult = Boolean(image?.url && image.verified);
    } else if (type === "metadata") {
      // Metadata "result" = completed job; gaps may remain without counting as no_result.
      hasResult = job?.status === "completed" ? true : undefined;
    }
    return {
      type,
      status: job?.status ?? "absent",
      statusLabel: jobStatusLabel(job, { hasResult }),
      attempts: job?.attempts ?? 0,
      lastError: job?.last_error ?? null
    };
  });
}

export function buildBottleEnrichmentView(options: {
  entityType: string;
  entityId: number;
  /** Optional injected conflicts (tests / advanced callers). */
  conflicts?: FieldConflict[];
}): BottleEnrichmentView | null {
  if (!isEnrichmentEntityType(options.entityType)) return null;
  const entityType = options.entityType;
  const row = loadInventoryRow(entityType, options.entityId);
  if (!row) return null;

  const candidate = candidateFromInventoryRow(entityType, row);
  const conflicts = options.conflicts ?? collectCacheConflicts(entityType, row);
  const plan = planEnrichment(candidate, { conflicts });
  const reviewFields = new Set(plan.reviewConflicts.map((c) => c.field));

  const content = getProductContent(entityType, options.entityId);
  const image = getProductImage(entityType, options.entityId);
  const userImage = inventoryHasUserImage(row);
  const shelfImage = String(row.image_url ?? "").trim() || null;

  const fieldOpt = (name: BottleCandidateFieldName) =>
    fieldViewFromProductField(candidate[name] as ProductField<unknown>, {
      inReview: reviewFields.has(name)
    });

  return {
    entityType,
    entityId: options.entityId,
    inventory: row,
    identity: {
      name: fieldOpt("name") as FieldView<string>,
      brand: fieldOpt("brand") as FieldView<string>,
      productType: fieldOpt("product_type") as FieldView<string>,
      upc: fieldOpt("upc") as FieldView<string>
    },
    metadata: {
      category: fieldOpt("category") as FieldView<string>,
      abv: fieldOpt("abv") as FieldView<number>,
      proof: fieldOpt("proof") as FieldView<number>,
      volumeMl: fieldOpt("volume_ml") as FieldView<number>,
      origin: fieldOpt("origin") as FieldView<string>,
      ttbId: fieldOpt("ttb_id") as FieldView<string>
    },
    enrichment: {
      identified: plan.identified,
      needsReview: plan.needsReview,
      missing: missingRecommendedLabels(candidate),
      jobs: buildJobViews(entityType, options.entityId, content, image),
      conflicts: conflictViews(plan.reviewConflicts)
    },
    tastingNotes: {
      official: content?.official_tasting_notes ?? null,
      sourceUrl: content?.official_source_url ?? null,
      sourceType: content?.official_source_type ?? null,
      // Never return a non-string — React white-screens if a JSON object is rendered as a child.
      houseProfile: normalizeTextField(content?.house_tasting_profile),
      personal: readPersonalNotes(row)
    },
    image: {
      displayUrl: userImage ? shelfImage : (image?.url ?? shelfImage),
      enrichedUrl: image?.url ?? null,
      sourceType: userImage ? "user" : (image?.source_type ?? null),
      sourceUrl: userImage ? null : (image?.source_url ?? null),
      score: userImage ? null : (image?.score ?? null),
      verified: userImage ? true : (image ? image.verified : null),
      userPreferred: userImage
    }
  };
}
