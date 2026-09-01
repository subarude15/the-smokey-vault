/**
 * Apply government catalog evidence onto an existing bottle candidate.
 * Does not change lookup precedence — only records contribution / confirmation / conflict.
 */
import { normalizeCanonicalTaxonomy } from "../../canonical-normalize.js";
import {
  field,
  isUnresolvedField,
  mergeField,
  type BottleCandidate,
  type BottleCandidateFieldName,
  type FieldConflict,
  type FieldEvidence,
  type ProductField,
  type ProductFieldSource
} from "../candidate/index.js";
import {
  governmentProductToSchema,
  logGovernmentLookupOutcome,
  type GovernmentLookupLog
} from "../catalogs/government/lookup.js";
import type {
  CatalogProductRecord,
  GovernmentDataset,
  GovernmentLookupResult
} from "../catalogs/government/types.js";

export type GovernmentEvidenceOutcome =
  | "hit_contributed"
  | "hit_confirmed_existing"
  | "hit_conflict"
  | "hit_no_usable_fields"
  | "miss"
  | "ambiguous";

export type GovernmentEvidenceApplyResult = {
  outcome: GovernmentEvidenceOutcome;
  dataset: GovernmentDataset | null;
  contributed: BottleCandidateFieldName[];
  confirmed: BottleCandidateFieldName[];
  conflicts: BottleCandidateFieldName[];
  sourceItemId: string | null;
  matchedCode: string | null;
  extractedAt: string | null;
};

const GOVERNMENT_SOURCES = new Set<ProductFieldSource>([
  "plcb_spirits",
  "plcb_wines",
  "iowa"
]);

export function isGovernmentFieldSource(source: string | null | undefined): boolean {
  return Boolean(source && GOVERNMENT_SOURCES.has(source as ProductFieldSource));
}

function datasetToSource(dataset: GovernmentDataset): ProductFieldSource {
  if (dataset === "plcb_spirits") return "plcb_spirits";
  if (dataset === "plcb_wines") return "plcb_wines";
  return "iowa";
}

function stampAudit<T>(
  productField: ProductField<T>,
  audit: {
    sourceItemId: string | null;
    matchedCode: string | null;
    extractedAt: string | null;
  }
): ProductField<T> {
  return {
    ...productField,
    sourceItemId: audit.sourceItemId,
    matchedCode: audit.matchedCode,
    extractedAt: audit.extractedAt
  };
}

function setField(
  candidate: BottleCandidate,
  name: BottleCandidateFieldName,
  next: ProductField<unknown>
): void {
  (candidate as unknown as Record<string, ProductField<unknown>>)[name] = next;
}

function buildIncomingFields(
  product: CatalogProductRecord,
  matchedCodeRaw: string | null,
  lookupUpc: string,
  source: ProductFieldSource
): Partial<Record<BottleCandidateFieldName, ProductField<string | number>>> {
  const schema = governmentProductToSchema(lookupUpc, product, matchedCodeRaw);
  const audit = {
    sourceItemId: product.sourceItemId ?? null,
    matchedCode: matchedCodeRaw,
    extractedAt: product.sourceExtractedAt ?? null
  };
  const category =
    product.normalizedFamily
    || product.normalizedSubcategory
    || (typeof schema.category === "string" ? schema.category : null);
  const tax = category ? normalizeCanonicalTaxonomy(category, "") : null;
  const categoryLabel = tax?.type || tax?.family || category;

  const out: Partial<Record<BottleCandidateFieldName, ProductField<string | number>>> = {};
  if (schema.proof != null) {
    out.proof = stampAudit(field(schema.proof, source), audit);
  }
  if (schema.abv != null) {
    out.abv = stampAudit(field(schema.abv, source), audit);
  }
  if (schema.volume_ml != null) {
    out.volume_ml = stampAudit(field(schema.volume_ml, source), audit);
  }
  if (schema.origin) {
    out.origin = stampAudit(field(schema.origin, source), audit);
  }
  if (categoryLabel) {
    out.category = stampAudit(field(categoryLabel, source), audit);
  }
  return out;
}

/**
 * Classify / apply a government lookup result onto candidate fields.
 * Mutates candidate in place. Preserves stronger canonical winners.
 */
export function applyGovernmentCatalogEvidence(
  candidate: BottleCandidate,
  lookup: GovernmentLookupResult,
  options: {
    targets?: BottleCandidateFieldName[];
    conflicts?: FieldConflict[];
    lookupUpc?: string;
  } = {}
): GovernmentEvidenceApplyResult {
  const targets = options.targets ?? [
    "category",
    "abv",
    "proof",
    "volume_ml",
    "origin"
  ];
  const conflictBucket = options.conflicts;

  if (lookup.status === "miss") {
    return {
      outcome: "miss",
      dataset: null,
      contributed: [],
      confirmed: [],
      conflicts: [],
      sourceItemId: null,
      matchedCode: null,
      extractedAt: null
    };
  }
  if (lookup.status === "ambiguous" || !lookup.winner) {
    return {
      outcome: "ambiguous",
      dataset: null,
      contributed: [],
      confirmed: [],
      conflicts: [],
      sourceItemId: null,
      matchedCode: null,
      extractedAt: null
    };
  }

  const winner = lookup.winner;
  const source = datasetToSource(winner.dataset);
  const upc = options.lookupUpc ?? candidate.upc.value ?? "";
  const incomingMap = buildIncomingFields(
    winner.product,
    winner.matchedCodeRaw,
    upc,
    source
  );

  const contributed: BottleCandidateFieldName[] = [];
  const confirmed: BottleCandidateFieldName[] = [];
  const conflictFields: BottleCandidateFieldName[] = [];

  for (const name of targets) {
    const incoming = incomingMap[name];
    if (!incoming || isUnresolvedField(incoming)) continue;
    const existing = candidate[name] as ProductField<string | number>;
    const merged = mergeField(existing, incoming, name);
    setField(candidate, name, merged.field as ProductField<unknown>);
    if (merged.overwritten) {
      contributed.push(name);
      continue;
    }
    if (merged.conflict) {
      conflictFields.push(name);
      conflictBucket?.push(merged.conflict as FieldConflict);
      continue;
    }
    if (merged.confirmed) {
      confirmed.push(name);
    }
  }

  // Prefer conflict when present without contributions; contributions win the outcome label.
  let outcome: GovernmentEvidenceOutcome = "hit_no_usable_fields";
  if (contributed.length) outcome = "hit_contributed";
  else if (conflictFields.length) outcome = "hit_conflict";
  else if (confirmed.length) outcome = "hit_confirmed_existing";

  return {
    outcome,
    dataset: winner.dataset,
    contributed,
    confirmed,
    conflicts: conflictFields,
    sourceItemId: winner.product.sourceItemId ?? null,
    matchedCode: winner.matchedCodeRaw,
    extractedAt: winner.product.sourceExtractedAt ?? null
  };
}

/** Bounded log for government evidence outcomes (no catalog payloads). */
export function logGovernmentEvidenceOutcome(
  logger: GovernmentLookupLog | undefined,
  upc: string,
  result: GovernmentEvidenceApplyResult
): void {
  const status =
    result.outcome === "miss"
      ? "miss"
      : result.outcome === "ambiguous"
        ? "ambiguous"
        : "hit";
  logGovernmentLookupOutcome(
    logger,
    upc,
    { status, candidates: [], winner: null },
    {
      outcome: result.outcome,
      source: result.dataset,
      contributedCount: result.contributed.length,
      confirmedCount: result.confirmed.length,
      conflictCount: result.conflicts.length,
      sourceItemId: result.sourceItemId,
      matchedCode: result.matchedCode
    }
  );
}

export function governmentConfirmationEvidence(
  field: ProductField<unknown> | null | undefined
): FieldEvidence[] {
  if (!field?.contributors?.length) return [];
  return field.contributors.filter(
    (c) => c.role === "confirmation" && isGovernmentFieldSource(c.source)
  );
}
