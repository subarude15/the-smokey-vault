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
  hasFailedJob,
  hasActiveEnrichmentJob,
  listJobsForEntity,
  claimNextPendingJob,
  markJobCompleted,
  markJobFailedOrRetry,
  recoverStaleRunningJobs,
  enrichmentJobCounts,
  clearEnrichmentJobsForTests,
  getLatestCompletedJobResult
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

export { runMetadataJob, type MetadataJobResult, type MetadataJobDeps } from "./metadata-job.js";
export { runTastingNotesJob, type TastingNotesJobResult } from "./tasting-notes-job.js";
export { runImageJob, type ImageJobResult, type ImageJobDeps } from "./image-job.js";

export {
  applyOfficialBreweryBeerDiscovery,
  type OfficialBreweryBeerApplyResult
} from "./official-brewery-beer.js";

export {
  ensureEnrichmentSourcesTable,
  getEnrichmentSource,
  upsertEnrichmentSource,
  clearEnrichmentSourcesForTests,
  type EnrichmentSourceRecord,
  type EnrichmentSourceType
} from "./enrichment-sources.js";

export {
  ensureProductImagesTable,
  getProductImage,
  upsertProductImage,
  inventoryHasUserImage,
  recordLookupImageFallback,
  hasAcceptedProductImage,
  hasDurableAcceptedProductImage,
  productImageNeedsLocalization,
  isRemoteProductImageUrl,
  isAcceptedEnrichedProductImage,
  acceptedEnrichedImageUrl,
  resolveInventoryDisplayImageUrl,
  attachInventoryDisplayImageUrl,
  clearProductImagesForTests,
  markProductImageEmpty,
  type ProductImageRecord
} from "./product-images.js";

export { attachInventoryDisplayFlavors } from "./display-flavors.js";

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
  dedupeMissingLabels,
  type BottleEnrichmentView,
  type FieldView,
  type JobView,
  type ConflictView,
  type ConfidenceBand,
  type FieldViewStatus,
  type JobStatusLabel
} from "./enrichment-view.js";

export {
  previewEnrichmentBackfill,
  queueEnrichmentBackfill,
  type EnrichmentBackfillPreview,
  type EnrichmentBackfillQueueResult,
  type EnrichmentBackfillJobType
} from "./enrichment-backfill.js";

export {
  LEGACY_BEER_AUDIT_QUEUE_LIMIT,
  LEGACY_BEER_AUDIT_LIST_LIMIT,
  recoverOfficialBreweryDomainFromEvidence,
  auditPackagedBeer,
  previewLegacyBeerAudit,
  queueLegacyBeerAudit,
  type LegacyBeerAuditReason,
  type LegacyBeerAuditResult,
  type LegacyBeerAuditPreview,
  type LegacyBeerAuditQueueResult
} from "./legacy-beer-audit.js";


export {
  queueItemEnrichment,
  normalizeItemEnrichmentJobTypes,
  normalizeItemEnrichmentQueueMode,
  primaryItemEnrichmentActionLabel,
  showsItemEnrichmentRerunAction,
  itemEnrichmentHasMissingWork,
  type ItemEnrichmentJobType,
  type ItemEnrichmentQueueMode,
  type ItemEnrichmentQueueResult,
  type ItemEnrichmentSkip,
  type ItemEnrichmentSkipReason
} from "./item-enrichment-queue.js";

export {
  rerunItemEnrichmentJob,
  verifyEnrichmentField,
  resolveEnrichmentConflict,
  verifiableFieldsForEntity,
  type EnrichmentActionError,
  type RerunEnrichmentResult,
  type VerifyFieldResult,
  type ResolveConflictResult
} from "./enrichment-actions.js";

export {
  metadataEnrichmentAvailability,
  tastingNotesEnrichmentAvailability,
  imageEnrichmentAvailability,
  bottleEnrichmentActuallyComplete,
  type EnrichmentAvailability
} from "./enrichment-availability.js";

export {
  metadataOutcomeFromState,
  metadataOutcomeToJobStatusLabel,
  metadataLastRunLabel,
  buildMetadataJobResultPayload,
  rebuildMetadataDiagnosticSummary,
  parseMetadataJobResult,
  unresolvedMetadataFields,
  type MetadataJobResultPayload,
  type MetadataOutcomeLabel
} from "./metadata-outcome.js";

export {
  clearAdminAuditForTests,
  getLatestAdminAuditEvent,
  recordAdminAuditEvent,
  type AdminAuditEvent
} from "./admin-audit.js";

export {
  isOfficialRepairMatchQuality,
  passesOfficialRepairGate,
  applyOfficialBeerRepairs,
  isKeeperVisibleRepairEvent,
  repairEventsAsConflicts,
  type OfficialRepairDecision,
  type OfficialFieldRepairEvent,
  type OfficialRepairSummary
} from "./official-beer-repair.js";

export {
  ensureFieldOwnershipTable,
  getFieldOwnership,
  upsertFieldOwnership,
  stampHumanFieldOwnership,
  stampMachineFieldOwnership,
  classifyStoredFieldForOfficialRepair,
  backfillMachineFieldOwnershipFromMetadataJobs,
  clearFieldOwnershipForTests,
  resolveCandidateSourceFromOwnership,
  type FieldOwnershipKind,
  type OwnedEnrichmentField,
  type FieldOwnershipRecord
} from "./field-ownership.js";

export {
  ensureOfficialImageRepairTable,
  requestOfficialImageRepair,
  getPendingOfficialImageRepair,
  hasPendingOfficialImageRepair,
  consumeOfficialImageRepair,
  clearOfficialImageRepairForTests
} from "./official-image-repair.js";

export {
  queueCommercialTapEnrichment,
  buildCommercialTapEnrichmentView,
  runCommercialTapEnrichmentJob,
  getLatestCommercialTapEnrichmentJob,
  isCommercialTapEnrichmentJob,
  type QueueCommercialTapEnrichmentResult,
  type CommercialTapEnrichmentView
} from "./commercial-tap-enrichment.js";
