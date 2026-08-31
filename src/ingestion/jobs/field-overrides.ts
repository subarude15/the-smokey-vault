/**
 * Admin field overrides for enrichment review (resolve conflict / mark verified).
 * Stored separately so cache history remains; applied onto candidates as user/VERY_HIGH.
 */
import { db } from "../../db.js";
import {
  CONFIDENCE,
  field,
  type BottleCandidate,
  type BottleCandidateFieldName,
  type ProductFieldSource
} from "../candidate/index.js";
import type { EnrichmentEntityType } from "./types.js";

export const REVIEWABLE_FIELDS = [
  "name",
  "brand",
  "product_type",
  "category",
  "abv",
  "proof",
  "volume_ml",
  "origin",
  "ttb_id",
  "upc"
] as const;

export type ReviewableField = (typeof REVIEWABLE_FIELDS)[number];

export const OVERRIDE_ACTIONS = ["resolve_keep", "resolve_accept", "verify"] as const;
export type OverrideAction = (typeof OVERRIDE_ACTIONS)[number];

export type FieldOverride = {
  entity_type: EnrichmentEntityType;
  entity_id: number;
  field: ReviewableField;
  value_json: string;
  source: ProductFieldSource;
  confidence: number;
  action: OverrideAction;
  previous_value_json: string | null;
  previous_source: string | null;
  competing_value_json: string | null;
  competing_source: string | null;
  created_at: string;
  updated_at: string;
};

export function ensureFieldOverridesTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS enrichment_field_overrides (
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      field TEXT NOT NULL,
      value_json TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user',
      confidence REAL NOT NULL,
      action TEXT NOT NULL,
      previous_value_json TEXT,
      previous_source TEXT,
      competing_value_json TEXT,
      competing_source TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (entity_type, entity_id, field)
    );
    CREATE INDEX IF NOT EXISTS idx_enrichment_overrides_entity
      ON enrichment_field_overrides(entity_type, entity_id);
  `);
}

ensureFieldOverridesTable();

export function isReviewableField(value: string): value is ReviewableField {
  return (REVIEWABLE_FIELDS as readonly string[]).includes(value);
}

export function encodeOverrideValue(value: string | number | null): string {
  return JSON.stringify(value);
}

export function decodeOverrideValue(raw: string): string | number | null {
  try {
    return JSON.parse(raw) as string | number | null;
  } catch {
    return raw;
  }
}

export function getFieldOverride(
  entityType: EnrichmentEntityType,
  entityId: number,
  fieldName: ReviewableField
): FieldOverride | null {
  const row = db
    .prepare(
      `SELECT * FROM enrichment_field_overrides
       WHERE entity_type = ? AND entity_id = ? AND field = ?`
    )
    .get(entityType, entityId, fieldName) as FieldOverride | undefined;
  return row ?? null;
}

export function listFieldOverrides(
  entityType: EnrichmentEntityType,
  entityId: number
): FieldOverride[] {
  return db
    .prepare(
      `SELECT * FROM enrichment_field_overrides
       WHERE entity_type = ? AND entity_id = ?
       ORDER BY field ASC`
    )
    .all(entityType, entityId) as FieldOverride[];
}

export function hasFieldOverride(
  entityType: EnrichmentEntityType,
  entityId: number,
  fieldName: string
): boolean {
  if (!isReviewableField(fieldName)) return false;
  return Boolean(getFieldOverride(entityType, entityId, fieldName));
}

export function upsertFieldOverride(input: {
  entityType: EnrichmentEntityType;
  entityId: number;
  field: ReviewableField;
  value: string | number | null;
  action: OverrideAction;
  previousValue?: string | number | null;
  previousSource?: string | null;
  competingValue?: string | number | null;
  competingSource?: string | null;
}): FieldOverride {
  db.prepare(
    `
    INSERT INTO enrichment_field_overrides (
      entity_type, entity_id, field, value_json, source, confidence, action,
      previous_value_json, previous_source, competing_value_json, competing_source,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(entity_type, entity_id, field) DO UPDATE SET
      value_json = excluded.value_json,
      source = 'user',
      confidence = excluded.confidence,
      action = excluded.action,
      previous_value_json = excluded.previous_value_json,
      previous_source = excluded.previous_source,
      competing_value_json = excluded.competing_value_json,
      competing_source = excluded.competing_source,
      updated_at = CURRENT_TIMESTAMP
  `
  ).run(
    input.entityType,
    input.entityId,
    input.field,
    encodeOverrideValue(input.value),
    CONFIDENCE.VERY_HIGH,
    input.action,
    input.previousValue === undefined ? null : encodeOverrideValue(input.previousValue),
    input.previousSource ?? null,
    input.competingValue === undefined ? null : encodeOverrideValue(input.competingValue),
    input.competingSource ?? null
  );
  return getFieldOverride(input.entityType, input.entityId, input.field)!;
}

/** Apply user overrides onto a candidate (user / VERY_HIGH). */
export function applyFieldOverridesToCandidate(
  entityType: EnrichmentEntityType,
  entityId: number,
  candidate: BottleCandidate
): BottleCandidate {
  for (const override of listFieldOverrides(entityType, entityId)) {
    const name = override.field as BottleCandidateFieldName;
    const value = decodeOverrideValue(override.value_json);
    const next = field(value, "user", CONFIDENCE.VERY_HIGH);
    switch (name) {
      case "upc":
        candidate.upc = next as BottleCandidate["upc"];
        break;
      case "name":
        candidate.name = next as BottleCandidate["name"];
        break;
      case "brand":
        candidate.brand = next as BottleCandidate["brand"];
        break;
      case "product_type":
        candidate.product_type = next as BottleCandidate["product_type"];
        break;
      case "category":
        candidate.category = next as BottleCandidate["category"];
        break;
      case "abv":
        candidate.abv = next as BottleCandidate["abv"];
        break;
      case "proof":
        candidate.proof = next as BottleCandidate["proof"];
        break;
      case "volume_ml":
        candidate.volume_ml = next as BottleCandidate["volume_ml"];
        break;
      case "origin":
        candidate.origin = next as BottleCandidate["origin"];
        break;
      case "ttb_id":
        candidate.ttb_id = next as BottleCandidate["ttb_id"];
        break;
      default:
        break;
    }
  }
  return candidate;
}

export function clearFieldOverridesForTests() {
  db.exec("DELETE FROM enrichment_field_overrides");
}
