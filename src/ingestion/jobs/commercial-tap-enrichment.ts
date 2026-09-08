/**
 * Queue helpers for commercial tap beer enrichment.
 * Uses enrichment_jobs with entity_type=taps / job_type=commercial_beer
 * without expanding the packaged-beer enrichment entity allowlist.
 */
import { db } from "../../db.js";
import {
  COMMERCIAL_TAP_ENTITY_TYPE,
  COMMERCIAL_TAP_JOB_TYPE,
  commercialTapEnrichmentResultPayload,
  enrichCommercialTap,
  isCommercialTap,
  loadTapRow,
  type CommercialTapEnrichmentDeps,
  type CommercialTapEnrichmentResult
} from "../../commercial_tap_enrichment.js";
import { isTapEmpty } from "../../catalog.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  type EnrichmentJob,
  type EnrichmentJobStatus
} from "./types.js";
import { getEnrichmentJob, markJobCompleted } from "./store.js";

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
  result_json?: string | null;
};

function mapJob(row: JobRow): EnrichmentJob {
  return {
    id: row.id,
    entity_type: row.entity_type as EnrichmentJob["entity_type"],
    entity_id: row.entity_id,
    upc: row.upc ?? "",
    job_type: row.job_type as EnrichmentJob["job_type"],
    status: row.status as EnrichmentJobStatus,
    attempts: Number(row.attempts ?? 0),
    max_attempts: Number(row.max_attempts ?? DEFAULT_MAX_ATTEMPTS),
    available_at: row.available_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    last_error: row.last_error,
    result_json: row.result_json ?? null
  };
}

function findActiveCommercialTapJob(tapId: number): EnrichmentJob | null {
  const row = db
    .prepare(
      `SELECT * FROM enrichment_jobs
       WHERE entity_type = ? AND entity_id = ? AND job_type = ?
         AND status IN ('pending', 'running')
       ORDER BY id DESC
       LIMIT 1`
    )
    .get(COMMERCIAL_TAP_ENTITY_TYPE, tapId, COMMERCIAL_TAP_JOB_TYPE) as JobRow | undefined;
  return row ? mapJob(row) : null;
}

export function getLatestCommercialTapEnrichmentJob(tapId: number): EnrichmentJob | null {
  const row = db
    .prepare(
      `SELECT * FROM enrichment_jobs
       WHERE entity_type = ? AND entity_id = ? AND job_type = ?
       ORDER BY id DESC
       LIMIT 1`
    )
    .get(COMMERCIAL_TAP_ENTITY_TYPE, tapId, COMMERCIAL_TAP_JOB_TYPE) as JobRow | undefined;
  return row ? mapJob(row) : null;
}

export type QueueCommercialTapEnrichmentResult =
  | { ok: true; job: EnrichmentJob; created: boolean }
  | { ok: false; error: string; statusCode: number };

export function queueCommercialTapEnrichment(
  tapId: number
): QueueCommercialTapEnrichmentResult {
  if (!Number.isFinite(tapId) || tapId <= 0) {
    return { ok: false, error: "Invalid id", statusCode: 400 };
  }
  const row = loadTapRow(tapId);
  if (!row) return { ok: false, error: "Tap not found", statusCode: 404 };
  if (isTapEmpty(row)) {
    return { ok: false, error: "Tap is empty", statusCode: 400 };
  }
  if (!isCommercialTap(row)) {
    return {
      ok: false,
      error: "Commercial beer enrichment is only for commercial taps",
      statusCode: 400
    };
  }
  const maker = String(row.maker ?? "").trim();
  const beer = String(row.brewery_batch ?? "").trim();
  if (!maker || !beer) {
    return {
      ok: false,
      error: "Brewery and beer name are required before enrichment",
      statusCode: 400
    };
  }

  const existing = findActiveCommercialTapJob(tapId);
  if (existing) return { ok: true, job: existing, created: false };

  const result = db
    .prepare(
      `INSERT INTO enrichment_jobs (
         entity_type, entity_id, upc, job_type, status, attempts, max_attempts, available_at
       ) VALUES (?, ?, '', ?, 'pending', 0, ?, CURRENT_TIMESTAMP)`
    )
    .run(COMMERCIAL_TAP_ENTITY_TYPE, tapId, COMMERCIAL_TAP_JOB_TYPE, DEFAULT_MAX_ATTEMPTS);

  const job = getEnrichmentJob(Number(result.lastInsertRowid));
  if (!job) return { ok: false, error: "Failed to queue enrichment", statusCode: 500 };
  return { ok: true, job, created: true };
}

export type CommercialTapEnrichmentView = {
  tapId: number;
  eligible: boolean;
  reason: string | null;
  job: {
    id: number;
    status: string;
    attempts: number;
    lastError: string | null;
    updatedAt: string;
    result: Record<string, unknown> | null;
  } | null;
};

export function buildCommercialTapEnrichmentView(
  tapId: number
): CommercialTapEnrichmentView | null {
  const row = loadTapRow(tapId);
  if (!row) return null;

  let eligible = true;
  let reason: string | null = null;
  if (isTapEmpty(row)) {
    eligible = false;
    reason = "tap_empty";
  } else if (!isCommercialTap(row)) {
    eligible = false;
    reason = "homebrew_excluded";
  } else if (!String(row.maker ?? "").trim() || !String(row.brewery_batch ?? "").trim()) {
    eligible = false;
    reason = "maker_and_beer_required";
  }

  const job = getLatestCommercialTapEnrichmentJob(tapId);
  let parsed: Record<string, unknown> | null = null;
  if (job?.result_json) {
    try {
      parsed = JSON.parse(job.result_json) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }

  return {
    tapId,
    eligible,
    reason,
    job: job
      ? {
          id: job.id,
          status: job.status,
          attempts: job.attempts,
          lastError: job.last_error,
          updatedAt: job.updated_at,
          result: parsed
        }
      : null
  };
}

export async function runCommercialTapEnrichmentJob(
  job: EnrichmentJob,
  deps: CommercialTapEnrichmentDeps = {}
): Promise<CommercialTapEnrichmentResult> {
  if (!isCommercialTapEnrichmentJob(job)) {
    throw new Error(`Unsupported commercial tap job: ${job.entity_type}/${job.job_type}`);
  }
  const result = await enrichCommercialTap(job.entity_id, deps);
  markJobCompleted(job.id, commercialTapEnrichmentResultPayload(result));
  return result;
}

export function isCommercialTapEnrichmentJob(job: {
  entity_type: string;
  job_type: string;
}): boolean {
  return (
    job.entity_type === COMMERCIAL_TAP_ENTITY_TYPE && job.job_type === COMMERCIAL_TAP_JOB_TYPE
  );
}
