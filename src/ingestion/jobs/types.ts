/**
 * Persistent enrichment job queue types.
 * Job types: metadata, tasting_notes, image (optional content).
 */

export const ENRICHMENT_ENTITY_TYPES = ["spirits", "packaged_beer", "wines"] as const;
export type EnrichmentEntityType = (typeof ENRICHMENT_ENTITY_TYPES)[number];

export const ENRICHMENT_JOB_TYPES = ["metadata", "tasting_notes", "image"] as const;
export type EnrichmentJobType = (typeof ENRICHMENT_JOB_TYPES)[number];

export const ENRICHMENT_JOB_STATUSES = ["pending", "running", "completed", "failed"] as const;
export type EnrichmentJobStatus = (typeof ENRICHMENT_JOB_STATUSES)[number];

export type EnrichmentJob = {
  id: number;
  entity_type: EnrichmentEntityType;
  entity_id: number;
  upc: string;
  job_type: EnrichmentJobType;
  status: EnrichmentJobStatus;
  attempts: number;
  max_attempts: number;
  available_at: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_error: string | null;
};

export type EnrichmentJobCounts = {
  pending: number;
  running: number;
  completed: number;
  failed: number;
};

export type EnqueueJobInput = {
  entityType: EnrichmentEntityType;
  entityId: number;
  upc?: string | null;
  jobType: EnrichmentJobType;
};

/** Metadata enqueue helper input (jobType fixed to metadata). */
export type EnqueueMetadataInput = {
  entityType: EnrichmentEntityType;
  entityId: number;
  upc?: string | null;
};

export const DEFAULT_MAX_ATTEMPTS = 3;

/** Seconds before a stuck `running` job is considered stale after restart. */
export const STALE_RUNNING_SECONDS = 10 * 60;

/** Backoff after failed attempt N (1-based): 30s, 2m, 5m. */
export function retryDelaySeconds(attemptNumber: number): number {
  if (attemptNumber <= 1) return 30;
  if (attemptNumber === 2) return 120;
  return 300;
}

export function isEnrichmentEntityType(value: string): value is EnrichmentEntityType {
  return (ENRICHMENT_ENTITY_TYPES as readonly string[]).includes(value);
}

export function isEnrichmentJobType(value: string): value is EnrichmentJobType {
  return (ENRICHMENT_JOB_TYPES as readonly string[]).includes(value);
}
