/**
 * Lightweight audit log for admin enrichment review actions.
 * Never stores PINs, tokens, or environment secrets.
 */
import { db } from "../../db.js";
import type { EnrichmentEntityType, EnrichmentJobType } from "./types.js";

export const REVIEW_AUDIT_ACTIONS = [
  "resolve_keep",
  "resolve_accept",
  "verify_field",
  "rerun_enrichment",
  "retry_failed_job"
] as const;

export type ReviewAuditAction = (typeof REVIEW_AUDIT_ACTIONS)[number];

export type ReviewAuditRow = {
  id: number;
  entity_type: EnrichmentEntityType;
  entity_id: number;
  action: ReviewAuditAction;
  field: string | null;
  job_type: EnrichmentJobType | null;
  old_value_json: string | null;
  new_value_json: string | null;
  detail_json: string | null;
  created_at: string;
};

export function ensureReviewAuditTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS enrichment_review_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      field TEXT,
      job_type TEXT,
      old_value_json TEXT,
      new_value_json TEXT,
      detail_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_enrichment_review_audit_entity
      ON enrichment_review_audit(entity_type, entity_id, id DESC);
  `);
}

ensureReviewAuditTable();

export function recordReviewAudit(input: {
  entityType: EnrichmentEntityType;
  entityId: number;
  action: ReviewAuditAction;
  field?: string | null;
  jobType?: EnrichmentJobType | null;
  oldValue?: string | number | null;
  newValue?: string | number | null;
  detail?: Record<string, unknown> | null;
}): ReviewAuditRow {
  const result = db
    .prepare(
      `
    INSERT INTO enrichment_review_audit (
      entity_type, entity_id, action, field, job_type,
      old_value_json, new_value_json, detail_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      input.entityType,
      input.entityId,
      input.action,
      input.field ?? null,
      input.jobType ?? null,
      input.oldValue === undefined ? null : JSON.stringify(input.oldValue),
      input.newValue === undefined ? null : JSON.stringify(input.newValue),
      input.detail ? JSON.stringify(input.detail) : null
    );
  return db
    .prepare(`SELECT * FROM enrichment_review_audit WHERE id = ?`)
    .get(result.lastInsertRowid) as ReviewAuditRow;
}

export function listReviewAudit(
  entityType: EnrichmentEntityType,
  entityId: number,
  limit = 50
): ReviewAuditRow[] {
  return db
    .prepare(
      `
    SELECT * FROM enrichment_review_audit
    WHERE entity_type = ? AND entity_id = ?
    ORDER BY id DESC
    LIMIT ?
  `
    )
    .all(entityType, entityId, Math.max(1, Math.min(limit, 200))) as ReviewAuditRow[];
}

export function clearReviewAuditForTests() {
  db.exec("DELETE FROM enrichment_review_audit");
}
