/**
 * First enrichment executor: recommended factual metadata only
 * (abv, proof, volume_ml, origin, ttb_id).
 *
 * Source order:
 * 1. Deterministic abv ↔ proof derivation from trusted peer
 * 2. Existing catalog/lookup by UPC (lookupProduct)
 * 3. SearXNG snippets + targeted llama3.1 JSON extract (web confidence)
 *
 * Never handles tasting_notes/image or required identity tasks.
 * Never overwrites higher-confidence values; conflicts are returned.
 */
import { isReadyLookup } from "../../lookup-shared.js";
import { lookupProduct, type LookupResult } from "../../lookup.js";
import {
  candidateFromLookup,
  field,
  isUnresolvedField,
  mergeField,
  type BottleCandidate,
  type FieldConflict,
  type ProductField
} from "../candidate/index.js";
import { TRUSTED_MIN } from "./rules.js";
import { searchWebSnippets } from "../web-search.js";
import { smartWebQuery } from "../normalize.js";
import {
  extractMetadataFromWebText,
  type MetadataExtractRequest,
  type MetadataExtractResult
} from "./metadata-extract.js";
import {
  METADATA_ENRICHMENT_FIELDS,
  abvFromProof,
  isMetadataEnrichmentField,
  proofFromAbv,
  type MetadataEnrichmentField
} from "./metadata-fields.js";
import type { EnrichmentField, EnrichmentPlan } from "./types.js";

export type EnrichmentExecutionError = {
  field: EnrichmentField;
  message: string;
};

export type EnrichmentExecutionResult = {
  candidate: BottleCandidate;
  completed: EnrichmentField[];
  unresolved: EnrichmentField[];
  conflicts: FieldConflict[];
  errors: EnrichmentExecutionError[];
};

export type MetadataEnrichmentDeps = {
  lookupByUpc?: (upc: string) => Promise<LookupResult>;
  searchWeb?: (query: string, limit?: number) => Promise<string>;
  extractMetadata?: (request: MetadataExtractRequest) => Promise<MetadataExtractResult>;
};

function cloneCandidate(candidate: BottleCandidate): BottleCandidate {
  return {
    primarySource: candidate.primarySource,
    upc: { ...candidate.upc },
    name: { ...candidate.name },
    brand: { ...candidate.brand },
    product_type: { ...candidate.product_type },
    category: { ...candidate.category },
    abv: { ...candidate.abv },
    proof: { ...candidate.proof },
    volume_ml: { ...candidate.volume_ml },
    origin: { ...candidate.origin },
    ttb_id: { ...candidate.ttb_id }
  };
}

function targetMetadataFields(plan: EnrichmentPlan): MetadataEnrichmentField[] {
  const fields: MetadataEnrichmentField[] = [];
  for (const task of plan.tasks) {
    if (task.priority !== "recommended") continue;
    if (!isMetadataEnrichmentField(task.field)) continue;
    if (!fields.includes(task.field)) fields.push(task.field);
  }
  return fields;
}

function stillNeeded(candidate: BottleCandidate, targets: MetadataEnrichmentField[]): MetadataEnrichmentField[] {
  return targets.filter((name) => {
    const f = candidate[name] as ProductField<unknown>;
    return isUnresolvedField(f) || f.confidence < TRUSTED_MIN;
  });
}

function applyMerge(
  candidate: BottleCandidate,
  name: MetadataEnrichmentField,
  incoming: ProductField<string | number>,
  conflicts: FieldConflict[]
): void {
  const existing = candidate[name] as ProductField<string | number>;
  const merged = mergeField(existing, incoming, name);
  (candidate as unknown as Record<string, ProductField<unknown>>)[name] = merged.field as ProductField<unknown>;
  if (merged.conflict) conflicts.push(merged.conflict as FieldConflict);
}

function applyDeterministicDerivations(
  candidate: BottleCandidate,
  targets: MetadataEnrichmentField[],
  conflicts: FieldConflict[]
): void {
  const wantProof = targets.includes("proof") && isUnresolvedField(candidate.proof);
  const wantAbv = targets.includes("abv") && isUnresolvedField(candidate.abv);

  if (wantProof && !isUnresolvedField(candidate.abv) && candidate.abv.confidence >= TRUSTED_MIN) {
    const derived = field(proofFromAbv(candidate.abv.value as number), candidate.abv.source, candidate.abv.confidence);
    applyMerge(candidate, "proof", derived, conflicts);
  }

  if (wantAbv && !isUnresolvedField(candidate.proof) && candidate.proof.confidence >= TRUSTED_MIN) {
    const derived = field(abvFromProof(candidate.proof.value as number), candidate.proof.source, candidate.proof.confidence);
    applyMerge(candidate, "abv", derived, conflicts);
  }
}

function applyCatalogProduct(
  candidate: BottleCandidate,
  catalog: BottleCandidate,
  targets: MetadataEnrichmentField[],
  conflicts: FieldConflict[]
): void {
  for (const name of targets) {
    const incoming = catalog[name] as ProductField<string | number>;
    if (isUnresolvedField(incoming)) continue;
    applyMerge(candidate, name, incoming, conflicts);
  }
}

function applyExtracted(
  candidate: BottleCandidate,
  extracted: MetadataExtractResult,
  targets: MetadataEnrichmentField[],
  conflicts: FieldConflict[]
): void {
  for (const name of targets) {
    if (!(name in extracted)) continue;
    const value = extracted[name];
    // Web+LLM evidence → web (MEDIUM). Never stamp identity fields.
    const incoming = field(value as string | number | null, "web");
    applyMerge(candidate, name, incoming, conflicts);
  }
}

function summarize(
  candidate: BottleCandidate,
  targets: MetadataEnrichmentField[],
  conflicts: FieldConflict[],
  errors: EnrichmentExecutionError[]
): EnrichmentExecutionResult {
  const completed: EnrichmentField[] = [];
  const unresolved: EnrichmentField[] = [];
  for (const name of targets) {
    if (isUnresolvedField(candidate[name] as ProductField<unknown>)) unresolved.push(name);
    else completed.push(name);
  }
  return { candidate, completed, unresolved, conflicts, errors };
}

/**
 * Execute recommended metadata enrichment for a planned candidate.
 * Mutates nothing on the input candidate; returns a cloned result.
 */
export async function executeMetadataEnrichment(
  input: BottleCandidate,
  plan: EnrichmentPlan,
  deps: MetadataEnrichmentDeps = {}
): Promise<EnrichmentExecutionResult> {
  const candidate = cloneCandidate(input);
  const targets = targetMetadataFields(plan);
  const conflicts: FieldConflict[] = [];
  const errors: EnrichmentExecutionError[] = [];

  if (!targets.length) {
    return summarize(candidate, targets, conflicts, errors);
  }

  const lookupByUpc = deps.lookupByUpc ?? ((upc: string) => lookupProduct(upc, { mode: "live" }));
  const searchWeb = deps.searchWeb ?? searchWebSnippets;
  const extractMetadata = deps.extractMetadata ?? extractMetadataFromWebText;

  // 1. Deterministic abv ↔ proof
  try {
    applyDeterministicDerivations(candidate, targets, conflicts);
  } catch (error) {
    errors.push({
      field: "abv",
      message: error instanceof Error ? error.message : "Deterministic derivation failed"
    });
  }

  // 2. Catalog / lookup by UPC — apply for all planned metadata targets so
  // equal-confidence disagreements with an existing value surface as conflicts.
  const upc = candidate.upc.value?.trim();
  if (targets.length && upc) {
    try {
      const result = await lookupByUpc(upc);
      if (isReadyLookup(result) && result.product) {
        const catalog = candidateFromLookup(result);
        applyCatalogProduct(candidate, catalog, targets, conflicts);
      }
    } catch (error) {
      for (const name of stillNeeded(candidate, targets)) {
        errors.push({
          field: name,
          message: error instanceof Error ? error.message : "Catalog lookup failed"
        });
      }
    }
  }

  // 3. SearXNG + targeted LLM for remaining gaps
  const needed = stillNeeded(candidate, targets);
  if (needed.length) {
    try {
      const query = smartWebQuery({
        upc: upc || undefined,
        name: [candidate.brand.value, candidate.name.value].filter(Boolean).join(" ") || undefined
      });
      const snippets = query ? await searchWeb(query, 5) : "";
      if (snippets.trim()) {
        const extracted = await extractMetadata({
          candidate,
          fields: needed,
          webSnippets: snippets
        });
        // Strip any identity keys the model might still emit (defense in depth).
        const safe: MetadataExtractResult = {};
        for (const name of needed) {
          if (name in extracted) safe[name] = extracted[name] ?? null;
        }
        applyExtracted(candidate, safe, needed, conflicts);
      }
    } catch (error) {
      for (const name of needed) {
        errors.push({
          field: name,
          message: error instanceof Error ? error.message : "Web/LLM metadata extract failed"
        });
      }
    }
  }

  // Re-run derivation after catalog/web fills one side of abv/proof.
  try {
    applyDeterministicDerivations(candidate, targets, conflicts);
  } catch {
    // Already reported on first pass if needed.
  }

  return summarize(candidate, targets, conflicts, errors);
}

export { METADATA_ENRICHMENT_FIELDS };
