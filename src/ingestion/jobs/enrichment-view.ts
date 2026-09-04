/**
 * Read model for the bottle enrichment / review UI.
 * Combines inventory, candidate provenance, jobs, product_content, and product_images.
 */
import { getBarcodeCacheEntry } from "../../barcode_cache.js";
import {
  isUsableCanonicalFamily,
  normalizeCanonicalAbv,
  normalizeCanonicalProof,
  normalizeCanonicalTaxonomy,
  normalizeCanonicalVolumeMl
} from "../../canonical-normalize.js";
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
import { searchGovernmentByBarcode } from "../catalogs/government/lookup.js";
import { applyGovernmentCatalogEvidence } from "../enrichment/government-evidence.js";
import { planEnrichment } from "../enrichment/index.js";
import { METADATA_ENRICHMENT_FIELDS } from "../enrichment/metadata-fields.js";
import { TRUSTED_MIN } from "../enrichment/rules.js";
import { candidateFromInventoryRow, loadInventoryRow } from "./inventory.js";
import {
  metadataOutcomeFromState,
  metadataOutcomeToJobStatusLabel,
  metadataLastRunLabel,
  parseMetadataJobResult,
  unresolvedMetadataFields
} from "./metadata-outcome.js";
import { getProductContent, readPersonalNotes } from "./product-content.js";
import {
  getProductImage,
  inventoryHasUserImage,
  isAcceptedEnrichedProductImage
} from "./product-images.js";
import { getLatestCompletedJobResult, listJobsForEntity } from "./store.js";
import {
  friendlyDiagnosticSummary,
  type JobDiagnosticsPayload
} from "../enrichment/diagnostics.js";
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

export type FieldViewContributor = {
  source: string;
  sourceLabel: string;
  confidence: number | null;
  confidenceBand: ConfidenceBand;
  confidenceLabel: string;
  role: "confirmation" | "conflict";
  value?: string | number | null;
  sourceItemId?: string | null;
  matchedCode?: string | null;
};

export type FieldView<T = string | number | null> = {
  value: T | null;
  source: string | null;
  sourceLabel: string | null;
  confidence: number | null;
  confidenceBand: ConfidenceBand;
  confidenceLabel: string;
  status: FieldViewStatus;
  /** Keeper-only supporting evidence (confirmations / conflicts). */
  contributors?: FieldViewContributor[];
  /** Optional secondary note, e.g. derived ABV from government proof. */
  note?: string | null;
  sourceItemId?: string | null;
  matchedCode?: string | null;
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

export type JobStatusLabel = "complete" | "partial" | "in_progress" | "waiting" | "no_result" | "failed" | "not_started";

export type JobView = {
  type: EnrichmentJobType | string;
  status: EnrichmentJobStatus | "absent";
  statusLabel: JobStatusLabel;
  attempts: number;
  lastError: string | null;
  /** Keeper/admin only — stripped for patrons. */
  diagnostics?: JobDiagnosticsPayload | null;
  diagnosticSummary?: string | null;
  /** Bottle metadata completeness (Partial / Complete). Distinct from last-run wording. */
  lastRunLabel?: string | null;
  stillMissing?: string[];
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
  plcb_spirits: "PLCB Spirits",
  plcb_wines: "PLCB Wines",
  iowa: "Iowa",
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
  options: { inReview?: boolean; includeContributors?: boolean } = {}
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
  const view: FieldView<T> = {
    value: productField.value,
    source: productField.source,
    sourceLabel: sourceLabel(productField.source),
    confidence: productField.confidence,
    confidenceBand: band,
    confidenceLabel: confidenceLabelForBand(band),
    status
  };
  if (options.includeContributors) {
    if (productField.sourceItemId) view.sourceItemId = productField.sourceItemId;
    if (productField.matchedCode) view.matchedCode = productField.matchedCode;
    if (productField.contributors?.length) {
      view.contributors = productField.contributors.map((c) => {
        const cBand = confidenceBandForScore(c.confidence);
        return {
          source: c.source,
          sourceLabel: sourceLabel(c.source),
          confidence: c.confidence,
          confidenceBand: cBand,
          confidenceLabel: confidenceLabelForBand(cBand),
          role: c.role,
          value:
            c.value == null || typeof c.value === "string" || typeof c.value === "number"
              ? (c.value as string | number | null)
              : String(c.value),
          sourceItemId: c.sourceItemId ?? null,
          matchedCode: c.matchedCode ?? null
        };
      });
    }
  }
  return view;
}

/**
 * Map job row → user-facing status.
 * Completed with no useful result is "no_result", not failure.
 * Metadata may also be "partial" when some fields updated but gaps remain.
 */
export function jobStatusLabel(
  job: EnrichmentJob | null,
  options: { hasResult?: boolean; partial?: boolean } = {}
): JobStatusLabel {
  if (!job) return "not_started";
  if (job.status === "pending") return "waiting";
  if (job.status === "running") return "in_progress";
  if (job.status === "failed") return "failed";
  if (job.status === "completed") {
    if (options.partial) return "partial";
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
  const categoryRaw = String(row.category ?? row.style ?? row.varietal ?? row.type ?? "");
  const subRaw = String(row.sub_category ?? "");
  const tax = normalizeCanonicalTaxonomy(categoryRaw, subRaw);
  const classification =
    tax.type || tax.family || (isUsableCanonicalFamily(categoryRaw) ? categoryRaw : "");
  const normalized: Record<string, unknown> = {
    ...row,
    brand: row.brand ?? row.brewery ?? row.producer ?? "",
    category: classification,
    sub_category: tax.type,
    product_type: row.product_type || tax.productType || inferredType,
    origin: row.origin ?? row.region ?? null,
    volume_ml: normalizeCanonicalVolumeMl(row.volume_ml),
    abv: normalizeCanonicalAbv(row.abv, { productType: inferredType }),
    proof: normalizeCanonicalProof((row as { proof?: unknown }).proof)
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
  // Deterministic order; category appears once even though it is both a
  // recommended identity aid and a METADATA_ENRICHMENT_FIELDS entry.
  const order = ["upc", ...METADATA_ENRICHMENT_FIELDS] as const;
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const name of order) {
    if (seen.has(name)) continue;
    seen.add(name);
    const f = candidate[name] as ProductField<unknown>;
    if (isUnresolvedField(f) || f.confidence < TRUSTED_MIN) {
      missing.push(labels[name] ?? name);
    }
  }
  return missing;
}

/** Exported for regression tests — same dedupe rules as the bottle view. */
export function dedupeMissingLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of labels) {
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

function parseJobDiagnostics(raw: string | null | undefined): JobDiagnosticsPayload | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as { diagnostics?: JobDiagnosticsPayload | null } & Partial<JobDiagnosticsPayload>;
    if (parsed?.diagnostics && typeof parsed.diagnostics === "object") {
      return parsed.diagnostics;
    }
    // Image payload may store diagnostics at the top level with jobType.
    if (parsed && parsed.jobType && Array.isArray(parsed.stages)) {
      return parsed as JobDiagnosticsPayload;
    }
    return null;
  } catch {
    return null;
  }
}

function buildJobViews(
  entityType: EnrichmentEntityType,
  entityId: number,
  candidate: BottleCandidate,
  content: ReturnType<typeof getProductContent>,
  image: ReturnType<typeof getProductImage>,
  includeDiagnostics: boolean
): JobView[] {
  const jobs = listJobsForEntity(entityType, entityId);
  const byType = new Map(jobs.map((j) => [j.job_type, j]));

  return ENRICHMENT_JOB_TYPES.map((type) => {
    const job = byType.get(type) ?? null;
    let statusLabel: JobStatusLabel;
    if (type === "metadata") {
      const outcome = metadataOutcomeFromState({ candidate, entityType, entityId });
      if (!job) {
        statusLabel = outcome === "missing" ? "not_started" : metadataOutcomeToJobStatusLabel(outcome);
      } else if (job.status === "pending") {
        statusLabel = "waiting";
      } else if (job.status === "running") {
        statusLabel = "in_progress";
      } else if (job.status === "failed") {
        statusLabel = "failed";
      } else {
        statusLabel = metadataOutcomeToJobStatusLabel(outcome);
        if (statusLabel === "not_started") statusLabel = "no_result";
      }
    } else {
      let hasResult: boolean | undefined;
      if (type === "tasting_notes") {
        hasResult = Boolean(content?.official_tasting_notes || content?.house_tasting_profile);
      } else if (type === "image") {
        hasResult = Boolean(image?.url && image.verified);
      }
      statusLabel = jobStatusLabel(job, { hasResult });
    }

    let diagnostics: JobDiagnosticsPayload | null = null;
    let diagnosticSummary: string | null = null;
    let lastRunLabel: string | null = null;
    let stillMissing: string[] | undefined;
    if (includeDiagnostics && job && (job.status === "completed" || job.status === "failed")) {
      const raw = job.result_json ?? getLatestCompletedJobResult(entityType, entityId, type);
      diagnostics = parseJobDiagnostics(raw);
      // Metadata stores diagnostics nested; also try parseMetadataJobResult path.
      if (!diagnostics && type === "metadata" && raw) {
        try {
          const parsed = JSON.parse(raw) as { diagnostics?: JobDiagnosticsPayload };
          diagnostics = parsed.diagnostics ?? null;
        } catch {
          diagnostics = null;
        }
      }
      diagnosticSummary = friendlyDiagnosticSummary(diagnostics);
      if (!diagnosticSummary && job.status === "failed" && job.last_error) {
        diagnosticSummary = String(job.last_error).slice(0, 200);
      }
      if (type === "metadata") {
        const stored = parseMetadataJobResult(raw);
        const bottleOutcome = metadataOutcomeFromState({ candidate, entityType, entityId });
        lastRunLabel = metadataLastRunLabel({
          bottleOutcome,
          stored,
          jobFailed: job.status === "failed"
        });
        const fieldLabels: Record<string, string> = {
          category: "Category",
          abv: "ABV",
          proof: "Proof",
          volume_ml: "Volume",
          origin: "Origin",
          ttb_id: "TTB ID"
        };
        const labelize = (names: string[]) =>
          names.map((n) => fieldLabels[n] ?? n);
        stillMissing = labelize(unresolvedMetadataFields(candidate).map(String));
        // Prefer stored unresolved when present (final-state payload).
        if (stored?.unresolved?.length) stillMissing = labelize(stored.unresolved.map(String));
        // Prefer a clearer summary for partial bottles with empty reruns.
        if (lastRunLabel === "No new data found" && stillMissing.length) {
          diagnosticSummary = `Last run: No new data found. Still missing: ${stillMissing.join(", ")}`;
        } else if (lastRunLabel?.startsWith("Updated") && stillMissing.length) {
          diagnosticSummary = `${lastRunLabel}. Still missing: ${stillMissing.join(", ")}`;
        }
      }
    }

    const view: JobView = {
      type,
      status: job?.status ?? "absent",
      statusLabel,
      attempts: job?.attempts ?? 0,
      lastError: job?.last_error ?? null
    };
    if (includeDiagnostics) {
      view.diagnostics = diagnostics;
      view.diagnosticSummary = diagnosticSummary;
      if (lastRunLabel) view.lastRunLabel = lastRunLabel;
      if (stillMissing?.length) view.stillMissing = stillMissing;
    }
    return view;
  });
}


function resolveDisplayImage(options: {
  userImage: boolean;
  shelfImage: string | null;
  image: ReturnType<typeof getProductImage>;
}): BottleEnrichmentView["image"] {
  const { userImage, shelfImage, image } = options;

  // 1. User / shelf upload wins.
  if (userImage && shelfImage) {
    return {
      displayUrl: shelfImage,
      enrichedUrl: image?.url ?? null,
      sourceType: "user",
      sourceUrl: null,
      score: null,
      verified: true,
      userPreferred: true
    };
  }

  // 2. Verified enriched official/licensed/approved image.
  if (isAcceptedEnrichedProductImage(image) && image?.url) {
    return {
      displayUrl: image.url,
      enrichedUrl: image.url,
      sourceType: image.source_type,
      sourceUrl: image.source_url,
      score: image.score,
      verified: true,
      userPreferred: false
    };
  }

  // 3. Lookup / reference fallback (fast barcode image — not verified).
  const lookupUrl =
    (image?.source_type === "lookup" ? (image.url || shelfImage) : null)
    || (!image?.verified ? shelfImage : null)
    || shelfImage;

  if (lookupUrl) {
    return {
      displayUrl: lookupUrl,
      enrichedUrl: image?.url && image.source_type !== "lookup" ? image.url : null,
      sourceType: image?.source_type === "lookup" || !image?.verified ? "lookup" : (image?.source_type ?? "lookup"),
      sourceUrl: image?.source_type === "lookup" ? image.source_url : null,
      score: null,
      verified: false,
      userPreferred: false
    };
  }

  return {
    displayUrl: null,
    enrichedUrl: image?.url ?? null,
    sourceType: image?.source_type ?? null,
    sourceUrl: image?.source_url ?? null,
    score: image?.score ?? null,
    verified: image ? image.verified : null,
    userPreferred: false
  };
}

export function buildBottleEnrichmentView(options: {
  entityType: string;
  entityId: number;
  /** Optional injected conflicts (tests / advanced callers). */
  conflicts?: FieldConflict[];
  /** Include keeper/admin diagnostics on job views. */
  includeDiagnostics?: boolean;
}): BottleEnrichmentView | null {
  if (!isEnrichmentEntityType(options.entityType)) return null;
  const entityType = options.entityType;
  const row = loadInventoryRow(entityType, options.entityId);
  if (!row) return null;

  const candidate = candidateFromInventoryRow(entityType, row);
  const conflicts = options.conflicts ?? collectCacheConflicts(entityType, row);
  const includeDiagnostics = options.includeDiagnostics === true;

  // Keeper read model: overlay live government confirmations / conflicts without changing stored values.
  if (includeDiagnostics && entityType !== "packaged_beer") {
    const upc = String(row.upc ?? candidate.upc.value ?? "").trim();
    if (upc) {
      try {
        const governmentLookup = searchGovernmentByBarcode(upc);
        applyGovernmentCatalogEvidence(candidate, governmentLookup, {
          lookupUpc: upc,
          conflicts
        });
      } catch {
        /* government DB optional at read time */
      }
    }
  }

  const plan = planEnrichment(candidate, { conflicts });
  const reviewFields = new Set(plan.reviewConflicts.map((c) => c.field));

  const content = getProductContent(entityType, options.entityId);
  const image = getProductImage(entityType, options.entityId);
  const shelfImage = String(row.image_url ?? "").trim() || null;
  const userImage = inventoryHasUserImage(row, entityType, options.entityId);

  const fieldOpt = (name: BottleCandidateFieldName) =>
    fieldViewFromProductField(candidate[name] as ProductField<unknown>, {
      inReview: reviewFields.has(name),
      includeContributors: includeDiagnostics
    });

  const proofView = fieldOpt("proof") as FieldView<number>;
  const abvView = fieldOpt("abv") as FieldView<number>;
  if (
    includeDiagnostics
    && abvView.value != null
    && proofView.value != null
    && abvView.source
    && abvView.source === proofView.source
    && (abvView.source === "plcb_spirits" || abvView.source === "plcb_wines" || abvView.source === "iowa")
  ) {
    abvView.note = `Derived from ${sourceLabel(abvView.source)} proof`;
  }

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
      abv: abvView,
      proof: proofView,
      volumeMl: fieldOpt("volume_ml") as FieldView<number>,
      origin: fieldOpt("origin") as FieldView<string>,
      ttbId: fieldOpt("ttb_id") as FieldView<string>
    },
    enrichment: {
      identified: plan.identified,
      needsReview: plan.needsReview,
      missing: missingRecommendedLabels(candidate),
      jobs: buildJobViews(
        entityType,
        options.entityId,
        candidate,
        content,
        image,
        includeDiagnostics
      ),
      conflicts: conflictViews(plan.reviewConflicts)
    },
    tastingNotes: {
      official: content?.official_tasting_notes ?? null,
      sourceUrl: content?.official_source_url ?? null,
      sourceType: content?.official_source_type ?? null,
      houseProfile: normalizeTextField(content?.house_tasting_profile),
      personal: readPersonalNotes(row)
    },
    image: resolveDisplayImage({ userImage, shelfImage, image })
  };
}
