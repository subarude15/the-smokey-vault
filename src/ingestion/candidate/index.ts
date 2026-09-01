/**
 * Internal bottle field provenance + confidence.
 * Additive preparation for later enrichment; not persisted / not public API.
 */
export {
  CONFIDENCE,
  PRODUCT_FIELD_SOURCES,
  type BottleCandidate,
  type BottleCandidateFieldName,
  type BottleCandidateFields,
  type ConfidenceScore,
  type FieldConflict,
  type FieldEvidence,
  type FieldEvidenceRole,
  type MergeFieldResult,
  type ProductField,
  type ProductFieldSource
} from "./types.js";

export {
  SOURCE_CONFIDENCE,
  confidenceForSource,
  fieldSourceFromLookupSource
} from "./confidence.js";

export {
  emptyField,
  field,
  isUnresolvedField,
  isUnresolvedValue,
  mergeField,
  valuesDisagree
} from "./fields.js";

export {
  candidateFromLookup,
  candidateFromProduct,
  mergeCandidates,
  unresolvedFields,
  type CandidateMergeResult
} from "./from-lookup.js";
