/**
 * First enrichment executor: recommended factual metadata
 * (category, abv, proof, volume_ml, origin, ttb_id).
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
  normalizeCanonicalTaxonomy
} from "../../canonical-normalize.js";
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
  /** Fields this run attempted to fill. */
  requested: EnrichmentField[];
  completed: EnrichmentField[];
  unresolved: EnrichmentField[];
  /** Fields that newly became trusted / improved during this run. */
  updated: EnrichmentField[];
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
    if (name === "category" && typeof incoming.value === "string") {
      const tax = normalizeCanonicalTaxonomy(incoming.value, "");
      const label = tax.type || tax.family;
      if (!label) continue;
      applyMerge(candidate, "category", field(label, incoming.source, incoming.confidence), conflicts);
      continue;
    }
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
    const incoming = field(value as string | number | null, "web");
    applyMerge(candidate, name, incoming, conflicts);
  }
}

function summarize(
  before: BottleCandidate,
  candidate: BottleCandidate,
  targets: MetadataEnrichmentField[],
  conflicts: FieldConflict[],
  errors: EnrichmentExecutionError[]
): EnrichmentExecutionResult {
  const completed: EnrichmentField[] = [];
  const unresolved: EnrichmentField[] = [];
  const updated: EnrichmentField[] = [];
  for (const name of targets) {
    const afterField = candidate[name] as ProductField<unknown>;
    const beforeField = before[name] as ProductField<unknown>;
    if (isUnresolvedField(afterField) || afterField.confidence < TRUSTED_MIN) {
      unresolved.push(name);
    } else {
      completed.push(name);
      if (
        isUnresolvedField(beforeField)
        || beforeField.value !== afterField.value
        || beforeField.confidence < afterField.confidence
      ) {
        updated.push(name);
      }
    }
  }
  return { candidate, requested: [...targets], completed, unresolved, updated, conflicts, errors };
}

/** Build a targeted web query from trusted identity + known classification. */
export function metadataSearchQuery(
  candidate: BottleCandidate,
  needed: MetadataEnrichmentField[] = [...METADATA_ENRICHMENT_FIELDS]
): string {
  const parts = [
    candidate.brand.value,
    candidate.name.value,
    candidate.upc.value,
    candidate.product_type.value,
    candidate.category.value
  ].filter((part) => part != null && String(part).trim());

  if (needed.includes("abv") || needed.includes("proof")) {
    parts.push("ABV", "proof");
  }
  if (needed.includes("origin")) parts.push("origin", "region", "distillery");
  if (needed.includes("category")) parts.push("whisky", "whiskey", "spirit");
  if (needed.includes("ttb_id")) parts.push("TTB", "COLA");
  if (needed.includes("volume_ml")) parts.push("750ml", "volume");

  return parts.map(String).join(" ").replace(/\s+/g, " ").trim();
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
  const before = cloneCandidate(input);
  const candidate = cloneCandidate(input);
  const targets = targetMetadataFields(plan);
  const conflicts: FieldConflict[] = [];
  const errors: EnrichmentExecutionError[] = [];

  if (!targets.length) {
    return summarize(before, candidate, targets, conflicts, errors);
  }

  const lookupByUpc = deps.lookupByUpc ?? ((upc: string) => lookupProduct(upc, { mode: "live" }));
  const searchWeb = deps.searchWeb ?? searchWebSnippets;
  const extractMetadata = deps.extractMetadata ?? extractMetadataFromWebText;

  try {
    applyDeterministicDerivations(candidate, targets, conflicts);
  } catch (error) {
    errors.push({
      field: "abv",
      message: error instanceof Error ? error.message : "Deterministic derivation failed"
    });
  }

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

  const needed = stillNeeded(candidate, targets);
  if (needed.length) {
    try {
      const query = metadataSearchQuery(candidate, needed);
      const snippets = query ? await searchWeb(query, 5) : "";
      if (snippets.trim()) {
        const extracted = await extractMetadata({
          candidate,
          fields: needed,
          webSnippets: snippets
        });
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

  try {
    applyDeterministicDerivations(candidate, targets, conflicts);
  } catch {
    // Already reported on first pass if needed.
  }

  return summarize(before, candidate, targets, conflicts, errors);
}

export { METADATA_ENRICHMENT_FIELDS };
