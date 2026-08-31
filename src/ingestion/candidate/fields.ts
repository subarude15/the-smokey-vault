import { confidenceForSource } from "./confidence.js";
import {
  CONFIDENCE,
  type BottleCandidateFieldName,
  type FieldConflict,
  type MergeFieldResult,
  type ProductField,
  type ProductFieldSource
} from "./types.js";

export function isUnresolvedValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (typeof value === "number") return !Number.isFinite(value);
  return false;
}

export function isUnresolvedField<T>(field: ProductField<T>): boolean {
  return isUnresolvedValue(field.value);
}

/** Build a field; empty/null values always get confidence NONE. */
export function field<T>(
  value: T | null | undefined,
  source: ProductFieldSource,
  confidence = confidenceForSource(source)
): ProductField<T> {
  if (isUnresolvedValue(value)) {
    return { value: null, source: "unknown", confidence: CONFIDENCE.NONE };
  }
  return { value: value as T, source, confidence };
}

export function emptyField<T>(): ProductField<T> {
  return { value: null, source: "unknown", confidence: CONFIDENCE.NONE };
}

/** True when both sides have resolvable values that differ. */
export function valuesDisagree(a: unknown, b: unknown): boolean {
  if (isUnresolvedValue(a) || isUnresolvedValue(b)) return false;
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) > 1e-6;
  }
  return normalizeComparable(a) !== normalizeComparable(b);
}

function normalizeComparable(value: unknown): string {
  if (typeof value === "string") return value.trim().toLowerCase();
  return String(value);
}

/**
 * Merge incoming into existing without letting weaker evidence overwrite stronger.
 * - Unresolved existing → take incoming when incoming is resolved
 * - Incoming weaker / equal with disagreement → keep existing
 * - Incoming stronger → overwrite
 * - Equal confidence + disagree → keep existing, report conflict
 */
export function mergeField<T>(
  existing: ProductField<T>,
  incoming: ProductField<T>,
  fieldName?: BottleCandidateFieldName
): MergeFieldResult<T> {
  if (isUnresolvedField(incoming)) {
    return { field: existing, overwritten: false };
  }

  if (isUnresolvedField(existing)) {
    return { field: incoming, overwritten: true };
  }

  if (incoming.confidence > existing.confidence) {
    return { field: incoming, overwritten: true };
  }

  const disagreement = valuesDisagree(existing.value, incoming.value);
  if (disagreement) {
    const conflict: FieldConflict<T> | undefined = fieldName
      ? { field: fieldName, existing, incoming }
      : { field: "name", existing, incoming };
    return { field: existing, overwritten: false, conflict };
  }

  return { field: existing, overwritten: false };
}
