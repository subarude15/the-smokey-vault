import {
  canonicalizeForCompare,
  isCompatibleClassificationSpecialization,
  normalizeCanonicalAbv,
  normalizeCanonicalProof,
  normalizeCanonicalTaxonomy,
  normalizeCanonicalVolumeMl,
  stripPackageTokensFromName
} from "../../canonical-normalize.js";
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

export function isUnresolvedField<T>(field: ProductField<T> | null | undefined): boolean {
  if (!field) return true;
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

/** True when both sides have resolvable values that differ after canonical comparison. */
export function valuesDisagree(
  a: unknown,
  b: unknown,
  fieldName?: BottleCandidateFieldName
): boolean {
  if (isUnresolvedValue(a) || isUnresolvedValue(b)) return false;
  if (typeof a === "number" && typeof b === "number") {
    // Invalid sentinels are unresolved — never compare as trusted facts.
    if (fieldName === "abv") {
      if (normalizeCanonicalAbv(a) == null || normalizeCanonicalAbv(b) == null) return false;
    }
    if (fieldName === "proof") {
      if (normalizeCanonicalProof(a) == null || normalizeCanonicalProof(b) == null) return false;
    }
    if (fieldName === "volume_ml") {
      if (normalizeCanonicalVolumeMl(a) == null || normalizeCanonicalVolumeMl(b) == null) return false;
    }
    return Math.abs(a - b) > 1e-6;
  }
  return canonicalizeForCompare(a, fieldName) !== canonicalizeForCompare(b, fieldName);
}

/**
 * Merge incoming into existing without letting weaker evidence overwrite stronger.
 * - Unresolved existing → take incoming when incoming is resolved
 * - Compatible classification specialization (Whiskey → Scotch Whisky) may fill without conflict
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

  // Classification: never downgrade Scotch Whisky → Whiskey; allow specialization fill.
  if (fieldName === "category" || fieldName === "product_type") {
    const existingText = String(existing.value ?? "");
    const incomingText = String(incoming.value ?? "");
    if (isCompatibleClassificationSpecialization(existingText, incomingText)) {
      if (incoming.confidence >= existing.confidence || incoming.confidence >= CONFIDENCE.HIGH) {
        return { field: incoming, overwritten: true };
      }
      // Weaker but more specific HIGH evidence may still specialize a generic family.
      if (incoming.confidence >= CONFIDENCE.HIGH && classificationIsGenericFamily(existingText)) {
        return { field: incoming, overwritten: true };
      }
    }
    if (isCompatibleClassificationSpecialization(incomingText, existingText)) {
      // Existing is already more specific — keep it, not a conflict.
      return { field: existing, overwritten: false };
    }
  }

  if (incoming.confidence > existing.confidence) {
    return { field: incoming, overwritten: true };
  }

  const disagreement = valuesDisagree(existing.value, incoming.value, fieldName);
  if (disagreement) {
    const conflict: FieldConflict<T> | undefined = fieldName
      ? { field: fieldName, existing, incoming }
      : { field: "name", existing, incoming };
    return { field: existing, overwritten: false, conflict };
  }

  return { field: existing, overwritten: false };
}

function classificationIsGenericFamily(value: string): boolean {
  const tax = normalizeCanonicalTaxonomy(value, "");
  return Boolean(tax.family) && !tax.type && !/scotch|bourbon|rye|irish|tennessee|canadian|japanese/i.test(value);
}

/** Re-export name helper for tests / callers comparing identity strings. */
export function comparableProductName(name: string): string {
  return canonicalizeForCompare(stripPackageTokensFromName(name), "name");
}
