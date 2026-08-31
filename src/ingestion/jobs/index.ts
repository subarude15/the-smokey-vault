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
  getEnrichmentJob,
  hasCompletedJob,
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

export {
  maybeEnqueueMetadataEnrichment,
  maybeEnqueueTastingNotesEnrichment,
  shouldScheduleTastingNotesEnrichment,
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
