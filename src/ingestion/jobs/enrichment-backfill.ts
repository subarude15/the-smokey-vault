/**
 * Admin bulk enrichment backfill: preview and queue missing jobs using existing enqueue rules.
 */
import { db } from "../../db.js";
import { recordAdminAuditEvent } from "./admin-audit.js";
import { collectCacheConflicts } from "./enrichment-view.js";
import {
  maybeEnqueueImageEnrichment,
  maybeEnqueueMetadataEnrichment,
  maybeEnqueueTastingNotesEnrichment,
  shouldScheduleImageEnrichment,
  shouldScheduleTastingNotesEnrichment
} from "./enqueue.js";
import { candidateFromInventoryRow, shouldScheduleMetadataEnrichment } from "./inventory.js";
import { planEnrichment } from "../enrichment/index.js";
import { hasActiveEnrichmentJob } from "./store.js";
import {
  ENRICHMENT_ENTITY_TYPES,
  type EnrichmentEntityType,
  type EnrichmentJobType
} from "./types.js";

export type EnrichmentBackfillPreview = {
  scanned: number;
  eligible: number;
  metadata: number;
  tastingNotes: number;
  images: number;
  needsReview: number;
  unidentified: number;
  alreadyComplete: number;
};

export type EnrichmentBackfillQueueResult = {
  scanned: number;
  queued: {
    metadata: number;
    tasting_notes: number;
    image: number;
  };
  skipped: {
    needs_review: number;
    unidentified: number;
    complete: number;
  };
  auditId: number;
};

export type EnrichmentBackfillJobType = Extract<EnrichmentJobType, "metadata" | "tasting_notes" | "image">;

const ALL_JOB_TYPES: EnrichmentBackfillJobType[] = ["metadata", "tasting_notes", "image"];

type BottleEligibility = {
  metadata: boolean;
  tastingNotes: boolean;
  images: boolean;
  skipReason: "none" | "unidentified" | "needs_review" | "complete";
};

function normalizeJobTypes(types?: EnrichmentBackfillJobType[]): EnrichmentBackfillJobType[] {
  if (!types?.length) return ALL_JOB_TYPES;
  const allowed = new Set(ALL_JOB_TYPES);
  return types.filter((type) => allowed.has(type));
}

function evaluateBottleEligibility(
  entityType: EnrichmentEntityType,
  row: Record<string, unknown>
): BottleEligibility {
  const entityId = Number(row.id);
  const conflicts = collectCacheConflicts(entityType, row);
  const candidate = candidateFromInventoryRow(entityType, row);
  const plan = planEnrichment(candidate, { conflicts });

  if (!plan.identified) {
    return { metadata: false, tastingNotes: false, images: false, skipReason: "unidentified" };
  }
  if (plan.needsReview) {
    return { metadata: false, tastingNotes: false, images: false, skipReason: "needs_review" };
  }

  const metadata =
    shouldScheduleMetadataEnrichment({ candidate, entityType, entityId }) &&
    !hasActiveEnrichmentJob(entityType, entityId, "metadata");
  const tastingNotes =
    shouldScheduleTastingNotesEnrichment({ entityType, entityId }) &&
    !hasActiveEnrichmentJob(entityType, entityId, "tasting_notes");
  const images =
    shouldScheduleImageEnrichment({ entityType, entityId, row }) &&
    !hasActiveEnrichmentJob(entityType, entityId, "image");

  if (!metadata && !tastingNotes && !images) {
    return { metadata: false, tastingNotes: false, images: false, skipReason: "complete" };
  }
  return { metadata, tastingNotes, images, skipReason: "none" };
}

function scanInventory(): Array<{ entityType: EnrichmentEntityType; row: Record<string, unknown> }> {
  const items: Array<{ entityType: EnrichmentEntityType; row: Record<string, unknown> }> = [];
  for (const entityType of ENRICHMENT_ENTITY_TYPES) {
    const rows = db.prepare(`SELECT * FROM ${entityType}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      items.push({ entityType, row });
    }
  }
  return items;
}

export function previewEnrichmentBackfill(): EnrichmentBackfillPreview {
  const preview: EnrichmentBackfillPreview = {
    scanned: 0,
    eligible: 0,
    metadata: 0,
    tastingNotes: 0,
    images: 0,
    needsReview: 0,
    unidentified: 0,
    alreadyComplete: 0
  };

  for (const { entityType, row } of scanInventory()) {
    preview.scanned += 1;
    const eligibility = evaluateBottleEligibility(entityType, row);
    if (eligibility.skipReason === "unidentified") {
      preview.unidentified += 1;
      continue;
    }
    if (eligibility.skipReason === "needs_review") {
      preview.needsReview += 1;
      continue;
    }
    if (eligibility.skipReason === "complete") {
      preview.alreadyComplete += 1;
      continue;
    }

    preview.metadata += eligibility.metadata ? 1 : 0;
    preview.tastingNotes += eligibility.tastingNotes ? 1 : 0;
    preview.images += eligibility.images ? 1 : 0;
    if (eligibility.metadata || eligibility.tastingNotes || eligibility.images) {
      preview.eligible += 1;
    }
  }

  return preview;
}

export function queueEnrichmentBackfill(options?: {
  types?: EnrichmentBackfillJobType[];
}): EnrichmentBackfillQueueResult {
  const types = normalizeJobTypes(options?.types);
  const result: EnrichmentBackfillQueueResult = {
    scanned: 0,
    queued: { metadata: 0, tasting_notes: 0, image: 0 },
    skipped: { needs_review: 0, unidentified: 0, complete: 0 },
    auditId: 0
  };

  const run = db.transaction(() => {
    for (const { entityType, row } of scanInventory()) {
      result.scanned += 1;
      const eligibility = evaluateBottleEligibility(entityType, row);
      if (eligibility.skipReason === "unidentified") {
        result.skipped.unidentified += 1;
        continue;
      }
      if (eligibility.skipReason === "needs_review") {
        result.skipped.needs_review += 1;
        continue;
      }
      if (eligibility.skipReason === "complete") {
        result.skipped.complete += 1;
        continue;
      }

      const entityId = Number(row.id);
      const planOptions = { conflicts: collectCacheConflicts(entityType, row) };
      let queuedAny = false;

      if (types.includes("metadata") && eligibility.metadata) {
        const enqueue = maybeEnqueueMetadataEnrichment({
          entityType,
          entityId,
          row,
          planOptions
        });
        if (enqueue.enqueued && enqueue.created) {
          result.queued.metadata += 1;
          queuedAny = true;
        }
      }
      if (types.includes("tasting_notes") && eligibility.tastingNotes) {
        const enqueue = maybeEnqueueTastingNotesEnrichment({
          entityType,
          entityId,
          row,
          planOptions
        });
        if (enqueue.enqueued && enqueue.created) {
          result.queued.tasting_notes += 1;
          queuedAny = true;
        }
      }
      if (types.includes("image") && eligibility.images) {
        const enqueue = maybeEnqueueImageEnrichment({
          entityType,
          entityId,
          row,
          planOptions
        });
        if (enqueue.enqueued && enqueue.created) {
          result.queued.image += 1;
          queuedAny = true;
        }
      }

      if (!queuedAny) {
        result.skipped.complete += 1;
      }
    }
  });

  run();

  const audit = recordAdminAuditEvent("enrichment_backfill", {
    scanned: result.scanned,
    queued: result.queued,
    skipped: result.skipped,
    types
  });
  result.auditId = audit.id;
  return result;
}
