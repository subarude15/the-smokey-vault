/**
 * In-process enrichment worker: concurrency 1, backoff when idle, recovers stale jobs.
 */
import {
  claimNextPendingJob,
  enrichmentJobCounts,
  markJobCompleted,
  markJobFailedOrRetry,
  recoverStaleRunningJobs
} from "./store.js";
import { runMetadataJob } from "./metadata-job.js";
import type { MetadataEnrichmentDeps } from "../enrichment/index.js";

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
  /** Idle sleep when no jobs (ms). */
  idleMs?: number;
  /** Injected metadata execution deps (tests / offline). */
  metadataDeps?: MetadataEnrichmentDeps;
  logger?: EnrichmentLogger;
  /** Optional hook after each job cycle (tests). */
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
    entityType: job.entity_type,
    entityId: job.entity_id,
    attempt: job.attempts
  }, "enrichment job started");

  try {
    if (job.job_type !== "metadata") {
      throw new Error(`Unsupported job type: ${job.job_type}`);
    }
    const result = await runMetadataJob(job, workerOptions.metadataDeps);
    markJobCompleted(job.id);
    log.info({
      jobId: job.id,
      entityType: job.entity_type,
      entityId: job.entity_id,
      skipped: result.skipped,
      reason: result.reason,
      inventoryUpdated: result.inventoryUpdated,
      cacheUpdated: result.cacheUpdated,
      completedFields: result.execution?.completed ?? [],
      unresolvedFields: result.execution?.unresolved ?? []
    }, "enrichment job completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const updated = markJobFailedOrRetry(job.id, message);
    if (updated?.status === "failed") {
      log.error({
        jobId: job.id,
        entityType: job.entity_type,
        entityId: job.entity_id,
        attempts: updated.attempts,
        error: message
      }, "enrichment job failed");
    } else {
      log.warn({
        jobId: job.id,
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

  // Process next job immediately when work likely remains.
  scheduleNext(0);
}

/** Test helper: process at most one claimed job synchronously-ish. */
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
    const result = await runMetadataJob(job, workerOptions.metadataDeps);
    markJobCompleted(job.id);
    log.info({ jobId: job.id, skipped: result.skipped }, "enrichment job completed");
  } catch (error) {
    markJobFailedOrRetry(job.id, error instanceof Error ? error.message : String(error));
  } finally {
    activeJobId = null;
    workerOptions = previous;
  }
  return true;
}
