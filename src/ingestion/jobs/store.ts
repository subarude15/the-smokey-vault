import { db } from "../../db.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  STALE_RUNNING_SECONDS,
  retryDelaySeconds,
  type EnrichmentEntityType,
  type EnrichmentJob,
  type EnrichmentJobCounts,
  type EnrichmentJobStatus,
  type EnrichmentJobType,
  type EnqueueJobInput,
  type EnqueueMetadataInput
} from "./types.js";

export function ensureEnrichmentJobsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS enrichment_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      upc TEXT NOT NULL DEFAULT '',
      job_type TEXT NOT NULL DEFAULT 'metadata',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_ATTEMPTS},
      available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_claim
      ON enrichment_jobs(status, available_at, id);
    CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_entity
      ON enrichment_jobs(entity_type, entity_id, job_type, status);
  `);
}

ensureEnrichmentJobsTable();

type JobRow = {
  id: number;
  entity_type: string;
  entity_id: number;
  upc: string;
  job_type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  available_at: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_error: string | null;
};

function mapJob(row: JobRow): EnrichmentJob {
  return {
    id: row.id,
    entity_type: row.entity_type as EnrichmentEntityType,
    entity_id: row.entity_id,
    upc: row.upc ?? "",
    job_type: row.job_type as EnrichmentJobType,
    status: row.status as EnrichmentJobStatus,
    attempts: Number(row.attempts ?? 0),
    max_attempts: Number(row.max_attempts ?? DEFAULT_MAX_ATTEMPTS),
    available_at: row.available_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    last_error: row.last_error
  };
}

function sqliteNowPlusSeconds(seconds: number): string {
  return db.prepare(`SELECT datetime('now', ?)`).pluck().get(`+${Math.max(0, Math.floor(seconds))} seconds`) as string;
}

function findActiveJob(
  entityType: EnrichmentEntityType,
  entityId: number,
  jobType: EnrichmentJobType
): EnrichmentJob | null {
  const row = db.prepare(`
    SELECT * FROM enrichment_jobs
    WHERE entity_type = ? AND entity_id = ? AND job_type = ?
      AND status IN ('pending', 'running')
    ORDER BY id DESC
    LIMIT 1
  `).get(entityType, entityId, jobType) as JobRow | undefined;
  return row ? mapJob(row) : null;
}

/** Enqueue any job type; dedupes active rows for the same entity + job type. */
export function enqueueEnrichmentJob(input: EnqueueJobInput): { job: EnrichmentJob; created: boolean } {
  const existing = findActiveJob(input.entityType, input.entityId, input.jobType);
  if (existing) return { job: existing, created: false };

  const upc = String(input.upc ?? "").trim();
  const result = db.prepare(`
    INSERT INTO enrichment_jobs (
      entity_type, entity_id, upc, job_type, status, attempts, max_attempts, available_at
    ) VALUES (?, ?, ?, ?, 'pending', 0, ?, CURRENT_TIMESTAMP)
  `).run(input.entityType, input.entityId, upc, input.jobType, DEFAULT_MAX_ATTEMPTS);

  const row = db.prepare("SELECT * FROM enrichment_jobs WHERE id=?").get(result.lastInsertRowid) as JobRow;
  return { job: mapJob(row), created: true };
}

export function enqueueMetadataJob(input: EnqueueMetadataInput): { job: EnrichmentJob; created: boolean } {
  return enqueueEnrichmentJob({ ...input, jobType: "metadata" });
}

export function enqueueTastingNotesJob(input: EnqueueMetadataInput): { job: EnrichmentJob; created: boolean } {
  return enqueueEnrichmentJob({ ...input, jobType: "tasting_notes" });
}

export function enqueueImageJob(input: EnqueueMetadataInput): { job: EnrichmentJob; created: boolean } {
  return enqueueEnrichmentJob({ ...input, jobType: "image" });
}

export function getEnrichmentJob(id: number): EnrichmentJob | null {
  const row = db.prepare("SELECT * FROM enrichment_jobs WHERE id=?").get(id) as JobRow | undefined;
  return row ? mapJob(row) : null;
}

export function hasCompletedJob(
  entityType: EnrichmentEntityType,
  entityId: number,
  jobType: EnrichmentJobType
): boolean {
  const row = db.prepare(`
    SELECT 1 AS ok FROM enrichment_jobs
    WHERE entity_type = ? AND entity_id = ? AND job_type = ? AND status = 'completed'
    LIMIT 1
  `).get(entityType, entityId, jobType) as { ok: number } | undefined;
  return Boolean(row);
}

/** Atomically claim the next available pending job. */
export function claimNextPendingJob(): EnrichmentJob | null {
  const claim = db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM enrichment_jobs
      WHERE status = 'pending' AND available_at <= CURRENT_TIMESTAMP
      ORDER BY id ASC
      LIMIT 1
    `).get() as JobRow | undefined;
    if (!row) return null;

    const updated = db.prepare(`
      UPDATE enrichment_jobs
      SET status = 'running',
          attempts = attempts + 1,
          started_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP,
          last_error = NULL
      WHERE id = ? AND status = 'pending'
    `).run(row.id);

    if (updated.changes !== 1) return null;
    return db.prepare("SELECT * FROM enrichment_jobs WHERE id=?").get(row.id) as JobRow;
  });

  const claimed = claim();
  return claimed ? mapJob(claimed) : null;
}

export function markJobCompleted(id: number): EnrichmentJob | null {
  db.prepare(`
    UPDATE enrichment_jobs
    SET status = 'completed',
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP,
        last_error = NULL
    WHERE id = ?
  `).run(id);
  return getEnrichmentJob(id);
}

export function markJobFailedOrRetry(id: number, errorMessage: string): EnrichmentJob | null {
  const job = getEnrichmentJob(id);
  if (!job) return null;

  const message = String(errorMessage ?? "unknown error").slice(0, 500);
  if (job.attempts >= job.max_attempts) {
    db.prepare(`
      UPDATE enrichment_jobs
      SET status = 'failed',
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP,
          last_error = ?
      WHERE id = ?
    `).run(message, id);
  } else {
    const delay = retryDelaySeconds(job.attempts);
    const availableAt = sqliteNowPlusSeconds(delay);
    db.prepare(`
      UPDATE enrichment_jobs
      SET status = 'pending',
          available_at = ?,
          started_at = NULL,
          updated_at = CURRENT_TIMESTAMP,
          last_error = ?
      WHERE id = ?
    `).run(availableAt, message, id);
  }
  return getEnrichmentJob(id);
}

export function recoverStaleRunningJobs(staleSeconds = STALE_RUNNING_SECONDS): number {
  const cutoff = sqliteNowPlusSeconds(-staleSeconds);
  const stale = db.prepare(`
    SELECT * FROM enrichment_jobs
    WHERE status = 'running'
      AND started_at IS NOT NULL
      AND started_at <= ?
  `).all(cutoff) as JobRow[];

  let recovered = 0;
  for (const row of stale) {
    const job = mapJob(row);
    if (job.attempts >= job.max_attempts) {
      db.prepare(`
        UPDATE enrichment_jobs
        SET status = 'failed',
            completed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP,
            last_error = COALESCE(last_error, 'Stale running job exceeded max attempts')
        WHERE id = ? AND status = 'running'
      `).run(job.id);
    } else {
      db.prepare(`
        UPDATE enrichment_jobs
        SET status = 'pending',
            available_at = CURRENT_TIMESTAMP,
            started_at = NULL,
            updated_at = CURRENT_TIMESTAMP,
            last_error = COALESCE(last_error, 'Recovered stale running job after restart')
        WHERE id = ? AND status = 'running'
      `).run(job.id);
    }
    recovered += 1;
  }
  return recovered;
}

export function enrichmentJobCounts(): EnrichmentJobCounts {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS n FROM enrichment_jobs GROUP BY status
  `).all() as Array<{ status: string; n: number }>;
  const counts: EnrichmentJobCounts = { pending: 0, running: 0, completed: 0, failed: 0 };
  for (const row of rows) {
    if (row.status === "pending") counts.pending = Number(row.n);
    if (row.status === "running") counts.running = Number(row.n);
    if (row.status === "completed") counts.completed = Number(row.n);
    if (row.status === "failed") counts.failed = Number(row.n);
  }
  return counts;
}

export function clearEnrichmentJobsForTests() {
  db.exec("DELETE FROM enrichment_jobs");
}
