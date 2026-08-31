export {
  DEFAULT_MAX_ATTEMPTS,
  STALE_RUNNING_SECONDS,
  ENRICHMENT_ENTITY_TYPES,
  ENRICHMENT_JOB_STATUSES,
  ENRICHMENT_JOB_TYPES,
  isEnrichmentEntityType,
  isEnrichmentJobType,
  retryDelaySeconds,
  type EnrichmentEntityType,
  type EnrichmentJob,
  type EnrichmentJobCounts,
  type EnrichmentJobStatus,
  type EnrichmentJobType,
  type EnqueueJobInput,
  type EnqueueMetadataInput
} from "./types.js";

export {
  ensureEnrichmentJobsTable,
  enqueueEnrichmentJob,
  enqueueMetadataJob,
  enqueueTastingNotesJob,
  enqueueImageJob,
  getEnrichmentJob,
  hasCompletedJob,
  listJobsForEntity,
  claimNextPendingJob,
  markJobCompleted,
  markJobFailedOrRetry,
  recoverStaleRunningJobs,
  enrichmentJobCounts,
  clearEnrichmentJobsForTests
} from "./store.js";

export {
  loadInventoryRow,
  candidateFromInventoryRow,
  persistMetadataImprovements,
  hasRecommendedMetadataWork,
  hasPersistableMetadataWork,
  shouldScheduleMetadataEnrichment
} from "./inventory.js";

export {
  ensureProductContentTable,
  getProductContent,
  upsertProductContent,
  readPersonalNotes,
  toTastingNotesContent,
  clearProductContentForTests,
  productContentFullyPopulated,
  type ProductContent,
  type TastingNotesContent,
  type OfficialSourceType
} from "./product-content.js";

export { runMetadataJob, type MetadataJobResult } from "./metadata-job.js";
export { runTastingNotesJob, type TastingNotesJobResult } from "./tasting-notes-job.js";
export { runImageJob, type ImageJobResult } from "./image-job.js";

export {
  ensureProductImagesTable,
  getProductImage,
  upsertProductImage,
  inventoryHasUserImage,
  hasAcceptedProductImage,
  clearProductImagesForTests,
  markProductImageEmpty,
  type ProductImageRecord
} from "./product-images.js";

export {
  maybeEnqueueMetadataEnrichment,
  maybeEnqueueTastingNotesEnrichment,
  maybeEnqueueImageEnrichment,
  shouldScheduleTastingNotesEnrichment,
  shouldScheduleImageEnrichment,
  type MaybeEnqueueResult
} from "./enqueue.js";

export {
  startEnrichmentWorker,
  stopEnrichmentWorker,
  enrichmentWorkerRunning,
  activeEnrichmentJobId,
  runEnrichmentWorkerOnce,
  type EnrichmentLogger,
  type EnrichmentWorkerOptions
} from "./worker.js";

export {
  buildBottleEnrichmentView,
  sourceLabel,
  confidenceBandForScore,
  confidenceLabelForBand,
  fieldViewFromProductField,
  jobStatusLabel,
  jobsHaveActiveWork,
  collectCacheConflicts,
  type BottleEnrichmentView,
  type FieldView,
  type JobView,
  type ConflictView,
  type ConfidenceBand,
  type FieldViewStatus,
  type JobStatusLabel
} from "./enrichment-view.js";

export {
  ensureFieldOverridesTable,
  applyFieldOverridesToCandidate,
  upsertFieldOverride,
  listFieldOverrides,
  getFieldOverride,
  hasFieldOverride,
  clearFieldOverridesForTests,
  isReviewableField,
  REVIEWABLE_FIELDS,
  type FieldOverride,
  type ReviewableField,
  type OverrideAction
} from "./field-overrides.js";

export {
  ensureReviewAuditTable,
  recordReviewAudit,
  listReviewAudit,
  clearReviewAuditForTests,
  type ReviewAuditRow,
  type ReviewAuditAction
} from "./review-audit.js";

export {
  resolveFieldConflict,
  verifyEnrichmentField,
  rerunEnrichmentJob,
  ReviewActionError,
  inventoryColumnForField,
  candidateWithOverrides,
  type ConflictChoice
} from "./review-actions.js";
