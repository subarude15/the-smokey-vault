/**
 * In-process enrichment worker: concurrency 1, backoff when idle, recovers stale jobs.
 * Handles metadata, tasting_notes, and image job types sequentially.
 */
import {
  claimNextPendingJob,
  enrichmentJobCounts,
  markJobCompleted,
  markJobFailedOrRetry,
  recoverStaleRunningJobs
} from "./store.js";
import { runMetadataJob } from "./metadata-job.js";
import { runTastingNotesJob } from "./tasting-notes-job.js";
import { runImageJob } from "./image-job.js";
import type { MetadataEnrichmentDeps } from "../enrichment/index.js";
import type { TastingNotesEnrichmentDeps } from "../enrichment/execute-tasting-notes.js";
import type { ImageEnrichmentDeps } from "../enrichment/execute-images.js";

export type EnrichmentLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
};

const defaultLogger: EnrichmentLogger = {
  info: (obj, msg) => console.info(JSON.stringify({ level: "info", msg, ...obj })),
  warn: (obj, msg) => console.warn(JSON.stringify({ level: "warn", msg, ...obj })),
  error: (obj, msg) => console.error(JSON.stringify({ level: "error", msg, ...obj }))
};

export type EnrichmentWorkerOptions = {
  idleMs?: number;
  metadataDeps?: MetadataEnrichmentDeps;
  tastingNotesDeps?: TastingNotesEnrichmentDeps;
  imageDeps?: ImageEnrichmentDeps;
  logger?: EnrichmentLogger;
  onCycle?: () => void;
};

let workerTimer: ReturnType<typeof setTimeout> | null = null;
let workerRunning = false;
let stopping = false;
let activeJobId: number | null = null;
let workerOptions: EnrichmentWorkerOptions = {};

export function enrichmentWorkerRunning(): boolean {
  return workerRunning;
}

export function activeEnrichmentJobId(): number | null {
  return activeJobId;
}

export function startEnrichmentWorker(options: EnrichmentWorkerOptions = {}): boolean {
  if (workerRunning) return false;
  workerOptions = options;
  stopping = false;
  workerRunning = true;
  const log = options.logger ?? defaultLogger;

  const recovered = recoverStaleRunningJobs();
  if (recovered) {
    log.info({ recovered, counts: enrichmentJobCounts() }, "enrichment worker recovered stale jobs");
  }
  log.info({ counts: enrichmentJobCounts() }, "enrichment worker started");
  scheduleNext(0);
  return true;
}

export function stopEnrichmentWorker(): void {
  stopping = true;
  if (workerTimer) {
    clearTimeout(workerTimer);
    workerTimer = null;
  }
  workerRunning = false;
  activeJobId = null;
}

function scheduleNext(delayMs: number) {
  if (stopping) return;
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = setTimeout(() => {
    void tick().catch((error) => {
      const log = workerOptions.logger ?? defaultLogger;
      log.error({ error: error instanceof Error ? error.message : String(error) }, "enrichment worker tick failed");
      scheduleNext(workerOptions.idleMs ?? 2_000);
    });
  }, Math.max(0, delayMs));
  workerTimer.unref?.();
}

async function processClaimedJob(job: NonNullable<ReturnType<typeof claimNextPendingJob>>) {
  const log = workerOptions.logger ?? defaultLogger;
  if (job.job_type === "metadata") {
    const result = await runMetadataJob(job, workerOptions.metadataDeps);
    markJobCompleted(job.id, result.resultPayload);
    log.info({
      jobId: job.id,
      jobType: job.job_type,
      entityType: job.entity_type,
      entityId: job.entity_id,
      skipped: result.skipped,
      reason: result.reason,
      inventoryUpdated: result.inventoryUpdated,
      cacheUpdated: result.cacheUpdated,
      requested: result.resultPayload.requested,
      updated: result.resultPayload.updated,
      unresolved: result.resultPayload.unresolved
    }, "enrichment job completed");
    return;
  }
  if (job.job_type === "tasting_notes") {
    const result = await runTastingNotesJob(job, workerOptions.tastingNotesDeps);
    markJobCompleted(job.id);
    log.info({
      jobId: job.id,
      jobType: job.job_type,
      entityType: job.entity_type,
      entityId: job.entity_id,
      skipped: result.skipped,
      reason: result.reason,
      officialSaved: result.officialSaved,
      houseSaved: result.houseSaved
    }, "enrichment job completed");
    return;
  }
  if (job.job_type === "image") {
    const result = await runImageJob(job, workerOptions.imageDeps);
    markJobCompleted(job.id, result.resultPayload);
    log.info({
      jobId: job.id,
      jobType: job.job_type,
      entityType: job.entity_type,
      entityId: job.entity_id,
      skipped: result.skipped,
      reason: result.reason,
      imageSaved: result.imageSaved,
      selectedScore: result.execution?.selected?.score ?? null,
      noResultReason: result.resultPayload.diagnostics?.noResultReason ?? null
    }, "enrichment job completed");
    return;
  }
  throw new Error(`Unsupported job type: ${(job as { job_type: string }).job_type}`);
}

async function tick() {
  if (stopping) return;
  const log = workerOptions.logger ?? defaultLogger;
  const idleMs = workerOptions.idleMs ?? 2_000;

  const job = claimNextPendingJob();
  workerOptions.onCycle?.();

  if (!job) {
    scheduleNext(idleMs);
    return;
  }

  activeJobId = job.id;
  log.info({
    jobId: job.id,
    jobType: job.job_type,
    entityType: job.entity_type,
    entityId: job.entity_id,
    attempt: job.attempts
  }, "enrichment job started");

  try {
    await processClaimedJob(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const updated = markJobFailedOrRetry(job.id, message);
    if (updated?.status === "failed") {
      log.error({
        jobId: job.id,
        jobType: job.job_type,
        entityType: job.entity_type,
        entityId: job.entity_id,
        attempts: updated.attempts,
        error: message
      }, "enrichment job failed");
    } else {
      log.warn({
        jobId: job.id,
        jobType: job.job_type,
        entityType: job.entity_type,
        entityId: job.entity_id,
        attempts: updated?.attempts,
        availableAt: updated?.available_at,
        error: message
      }, "enrichment job retry scheduled");
    }
  } finally {
    activeJobId = null;
  }

  scheduleNext(0);
}

/** Test helper: process at most one claimed job. */
export async function runEnrichmentWorkerOnce(options: EnrichmentWorkerOptions = {}): Promise<boolean> {
  const previous = workerOptions;
  workerOptions = { ...previous, ...options };
  const log = workerOptions.logger ?? defaultLogger;
  recoverStaleRunningJobs();
  const job = claimNextPendingJob();
  if (!job) {
    workerOptions = previous;
    return false;
  }
  activeJobId = job.id;
  try {
    await processClaimedJob(job);
  } catch (error) {
    markJobFailedOrRetry(job.id, error instanceof Error ? error.message : String(error));
    log.warn({
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error)
    }, "enrichment job retry scheduled");
  } finally {
    activeJobId = null;
    workerOptions = previous;
  }
  return true;
}
