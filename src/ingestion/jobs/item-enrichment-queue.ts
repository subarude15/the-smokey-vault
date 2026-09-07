/**
 * Keeper-only per-item enrichment queue / retry.
 * Schedules background jobs for one bottle; does not run enrichment inline.
 */
import { planEnrichment } from "../enrichment/index.js";
import { buildBottleEnrichmentView, type JobStatusLabel } from "./enrichment-view.js";
import { candidateFromInventoryRow, loadInventoryRow } from "./inventory.js";
import { inventoryHasUserImage } from "./product-images.js";
import {
  enqueueImageJob,
  enqueueMetadataJob,
  enqueueTastingNotesJob
} from "./store.js";
import {
  isEnrichmentEntityType,
  type EnrichmentEntityType
} from "./types.js";

export type ItemEnrichmentJobType = "metadata" | "tasting_notes" | "image";

export type ItemEnrichmentQueueMode = "missing" | "retry";

export type ItemEnrichmentSkipReason =
  | "already_complete"
  | "already_queued"
  | "not_identified"
  | "needs_review"
  | "user_image_protected"
  | "not_eligible";

export type ItemEnrichmentSkip = {
  type: ItemEnrichmentJobType;
  reason: ItemEnrichmentSkipReason;
};

export type ItemEnrichmentQueueResult = {
  entityType: EnrichmentEntityType;
  entityId: number;
  mode: ItemEnrichmentQueueMode;
  queued: ItemEnrichmentJobType[];
  skipped: ItemEnrichmentSkip[];
};

const ALL_JOB_TYPES: ItemEnrichmentJobType[] = ["metadata", "tasting_notes", "image"];

const MISSING_STATUSES = new Set<JobStatusLabel>([
  "not_started",
  "no_result",
  "partial",
  "failed"
]);

const ACTIVE_STATUSES = new Set<JobStatusLabel>(["waiting", "in_progress"]);

export function normalizeItemEnrichmentJobTypes(
  raw: unknown
): ItemEnrichmentJobType[] | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return null;
  const allowed = new Set<string>(ALL_JOB_TYPES);
  const out: ItemEnrichmentJobType[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !allowed.has(value)) return null;
    if (!out.includes(value as ItemEnrichmentJobType)) {
      out.push(value as ItemEnrichmentJobType);
    }
  }
  return out.length ? out : null;
}

export function normalizeItemEnrichmentQueueMode(
  raw: unknown
): ItemEnrichmentQueueMode | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === "missing" || raw === "retry") return raw;
  return null;
}

/** Primary per-row action label for EnrichmentPanel (null = no primary button). */
export function primaryItemEnrichmentActionLabel(
  statusLabel: JobStatusLabel
): "Run again" | "Retry" | null {
  switch (statusLabel) {
    case "failed":
      return "Retry";
    case "not_started":
    case "no_result":
    case "partial":
    case "complete":
      return "Run again";
    case "waiting":
    case "in_progress":
      return null;
    default: {
      const _exhaustive: never = statusLabel;
      void _exhaustive;
      return null;
    }
  }
}

export function showsItemEnrichmentRerunAction(statusLabel: JobStatusLabel): boolean {
  return statusLabel === "complete";
}

export function itemEnrichmentHasMissingWork(
  jobs: Array<{ type: string; statusLabel: JobStatusLabel }>
): boolean {
  return jobs.some(
    (job) =>
      (job.type === "metadata" || job.type === "tasting_notes" || job.type === "image") &&
      MISSING_STATUSES.has(job.statusLabel)
  );
}

function jobStatusMap(
  entityType: EnrichmentEntityType,
  entityId: number
): Map<ItemEnrichmentJobType, JobStatusLabel> {
  const view = buildBottleEnrichmentView({
    entityType,
    entityId,
    includeDiagnostics: true
  });
  const map = new Map<ItemEnrichmentJobType, JobStatusLabel>();
  for (const type of ALL_JOB_TYPES) {
    map.set(type, "not_started");
  }
  if (!view) return map;
  for (const job of view.enrichment.jobs) {
    if (job.type === "metadata" || job.type === "tasting_notes" || job.type === "image") {
      map.set(job.type, job.statusLabel);
    }
  }
  return map;
}

function enqueueJob(
  type: ItemEnrichmentJobType,
  entityType: EnrichmentEntityType,
  entityId: number,
  upc: string | null
): { created: boolean } {
  if (type === "metadata") {
    return enqueueMetadataJob({ entityType, entityId, upc });
  }
  if (type === "tasting_notes") {
    return enqueueTastingNotesJob({ entityType, entityId, upc });
  }
  return enqueueImageJob({ entityType, entityId, upc });
}

/**
 * Queue enrichment jobs for a single inventory item.
 * `missing` queues only incomplete work; `retry` may re-queue explicit complete jobs.
 */
export function queueItemEnrichment(options: {
  entityType: string;
  entityId: number;
  jobTypes?: ItemEnrichmentJobType[];
  mode?: ItemEnrichmentQueueMode;
}): ItemEnrichmentQueueResult | { error: string; statusCode: number } {
  if (!isEnrichmentEntityType(options.entityType)) {
    return { error: "Enrichment not available for this module", statusCode: 404 };
  }
  const entityType = options.entityType;
  const entityId = options.entityId;
  if (!Number.isFinite(entityId) || entityId <= 0) {
    return { error: "Invalid id", statusCode: 400 };
  }

  const mode: ItemEnrichmentQueueMode = options.mode ?? "missing";
  const requested = options.jobTypes?.length ? options.jobTypes : ALL_JOB_TYPES;
  const explicitTypes = Boolean(options.jobTypes?.length);

  const row = loadInventoryRow(entityType, entityId);
  if (!row) return { error: "Item not found", statusCode: 404 };

  const candidate = candidateFromInventoryRow(entityType, row);
  const plan = planEnrichment(candidate, {});
  const statuses = jobStatusMap(entityType, entityId);
  const upc = candidate.upc.value;

  const queued: ItemEnrichmentJobType[] = [];
  const skipped: ItemEnrichmentSkip[] = [];

  if (!plan.identified) {
    for (const type of requested) {
      skipped.push({ type, reason: "not_identified" });
    }
    return { entityType, entityId, mode, queued, skipped };
  }
  if (plan.needsReview) {
    for (const type of requested) {
      skipped.push({ type, reason: "needs_review" });
    }
    return { entityType, entityId, mode, queued, skipped };
  }

  for (const type of requested) {
    const statusLabel = statuses.get(type) ?? "not_started";

    if (ACTIVE_STATUSES.has(statusLabel)) {
      skipped.push({ type, reason: "already_queued" });
      continue;
    }

    if (mode === "missing") {
      if (!MISSING_STATUSES.has(statusLabel)) {
        skipped.push({
          type,
          reason: statusLabel === "complete" ? "already_complete" : "not_eligible"
        });
        continue;
      }
    } else {
      // retry: allow missing statuses always; complete only when explicitly requested
      if (statusLabel === "complete") {
        if (!explicitTypes || !options.jobTypes?.includes(type)) {
          skipped.push({ type, reason: "already_complete" });
          continue;
        }
      } else if (!MISSING_STATUSES.has(statusLabel)) {
        skipped.push({ type, reason: "not_eligible" });
        continue;
      }
    }

    if (type === "image" && inventoryHasUserImage(row, entityType, entityId)) {
      skipped.push({ type, reason: "user_image_protected" });
      continue;
    }

    const { created } = enqueueJob(type, entityType, entityId, upc);
    if (!created) {
      skipped.push({ type, reason: "already_queued" });
      continue;
    }
    queued.push(type);
  }

  return { entityType, entityId, mode, queued, skipped };
}
