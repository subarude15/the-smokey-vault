export {
  DEFAULT_MAX_ATTEMPTS,
  STALE_RUNNING_SECONDS,
  ENRICHMENT_ENTITY_TYPES,
  ENRICHMENT_JOB_STATUSES,
  ENRICHMENT_JOB_TYPES,
  isEnrichmentEntityType,
  retryDelaySeconds,
  type EnrichmentEntityType,
  type EnrichmentJob,
  type EnrichmentJobCounts,
  type EnrichmentJobStatus,
  type EnrichmentJobType,
  type EnqueueMetadataInput
} from "./types.js";

export {
  ensureEnrichmentJobsTable,
  enqueueMetadataJob,
  getEnrichmentJob,
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

export { runMetadataJob, type MetadataJobResult } from "./metadata-job.js";

export {
  maybeEnqueueMetadataEnrichment,
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
