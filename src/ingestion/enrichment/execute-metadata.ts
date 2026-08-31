/**
 * First enrichment executor: recommended factual metadata
 * (category, abv, proof, volume_ml, origin, ttb_id).
 *
 * Source order:
 * 1. Deterministic abv ↔ proof derivation from trusted peer
 * 2. Existing catalog/lookup by UPC (lookupProduct)
 * 3. SearXNG hits → authoritative filter → llama3.1 JSON extract
 *
 * Never handles tasting_notes/image or required identity tasks.
 * Never overwrites higher-confidence values; conflicts are returned.
 */
import { isReadyLookup } from "../../lookup-shared.js";
import { lookupProduct, type LookupResult } from "../../lookup.js";
import {
  normalizeCanonicalAbv,
  normalizeCanonicalProof,
  normalizeCanonicalTaxonomy,
  normalizeCanonicalVolumeMl
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
import {
  isWebSearchError,
  searchWebHits,
  type WebSearchHit
} from "../web-search.js";
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
import {
  classifyHit,
  formatAuthoritativeSnippets,
  isAuthoritativeSource,
  type ClassifiedHit
} from "./tasting-notes-sources.js";
import {
  sanitizeJobDiagnostics,
  sourceClassDiagnosticReason,
  type EnrichmentDiagnosticStage,
  type FieldRejectReason,
  type JobDiagnosticsPayload,
  type NoResultReason
} from "./diagnostics.js";
import type { EnrichmentField, EnrichmentPlan } from "./types.js";

export type EnrichmentExecutionError = {
  field: EnrichmentField;
  message: string;
};

export type EnrichmentExecutionResult = {
  candidate: BottleCandidate;
  requested: EnrichmentField[];
  completed: EnrichmentField[];
  unresolved: EnrichmentField[];
  updated: EnrichmentField[];
  conflicts: FieldConflict[];
  errors: EnrichmentExecutionError[];
  diagnostics: JobDiagnosticsPayload;
};

export type MetadataEnrichmentDeps = {
  lookupByUpc?: (upc: string) => Promise<LookupResult>;
  /** Preferred: structured hits for source classification. */
  searchWebHits?: (query: string, limit?: number) => Promise<WebSearchHit[]>;
  /** Legacy snippet inject (tests) — treated as a single authoritative blob. */
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

function quotePart(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/\s/.test(trimmed)) return `"${trimmed.replace(/"/g, "")}"`;
  return trimmed;
}

/** Build up to 3 targeted queries from trusted identity + unresolved needs. */
export function buildMetadataSearchQueries(
  candidate: BottleCandidate,
  needed: MetadataEnrichmentField[] = [...METADATA_ENRICHMENT_FIELDS]
): string[] {
  const brand = String(candidate.brand.value ?? "").trim();
  const name = String(candidate.name.value ?? "").trim();
  const upc = String(candidate.upc.value ?? "").trim();
  const productType = String(candidate.product_type.value ?? "").trim();
  const category = String(candidate.category.value ?? "").trim();
  const queries: string[] = [];

  const identityCore = [quotePart(brand), quotePart(name), upc].filter(Boolean).join(" ");

  const wantsClass = needed.includes("category") || needed.includes("origin");
  const wantsStrength = needed.includes("abv") || needed.includes("proof");
  const wantsTtb = needed.includes("ttb_id");

  if (wantsClass) {
    queries.push(
      [identityCore, productType, category || "whisky whiskey", "spirit"]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    );
  }
  if (wantsStrength) {
    queries.push(
      [identityCore, "ABV", "proof"].filter(Boolean).join(" ").replace(/\s+/g, " ").trim()
    );
  }
  if (wantsTtb) {
    queries.push(
      [identityCore, "TTB", "COLA"].filter(Boolean).join(" ").replace(/\s+/g, " ").trim()
    );
  }
  if (!queries.length && identityCore) {
    queries.push([identityCore, productType, "ABV"].filter(Boolean).join(" "));
  }

  const unique: string[] = [];
  for (const q of queries) {
    if (q && !unique.includes(q)) unique.push(q);
  }
  return unique.slice(0, 3);
}

/** Single combined query (compat + diagnostics). */
export function metadataSearchQuery(
  candidate: BottleCandidate,
  needed: MetadataEnrichmentField[] = [...METADATA_ENRICHMENT_FIELDS]
): string {
  return buildMetadataSearchQueries(candidate, needed)[0] ?? "";
}

function applyMergeTracked(
  candidate: BottleCandidate,
  name: MetadataEnrichmentField,
  incoming: ProductField<string | number>,
  conflicts: FieldConflict[],
  rejects: FieldRejectReason[]
): boolean {
  const existing = candidate[name] as ProductField<string | number>;
  if (isUnresolvedField(incoming)) {
    if (name === "category") {
      rejects.push({ field: name, reason: "classification_not_canonical" });
    } else if (name === "abv" || name === "proof" || name === "volume_ml") {
      rejects.push({ field: name, reason: "invalid_numeric" });
    }
    return false;
  }
  const merged = mergeField(existing, incoming, name);
  (candidate as unknown as Record<string, ProductField<unknown>>)[name] = merged.field as ProductField<unknown>;
  if (merged.conflict) conflicts.push(merged.conflict as FieldConflict);
  if (!merged.overwritten) {
    if (!isUnresolvedField(existing) && !valuesDiffer(existing, incoming)) {
      rejects.push({ field: name, reason: "same_value_already_present" });
    } else if (!isUnresolvedField(existing) && incoming.confidence <= existing.confidence) {
      rejects.push({ field: name, reason: "rejected_weaker_source" });
    }
    return false;
  }
  return true;
}

function valuesDiffer(
  a: ProductField<string | number>,
  b: ProductField<string | number>
): boolean {
  return String(a.value) !== String(b.value);
}

function applyDeterministicDerivations(
  candidate: BottleCandidate,
  targets: MetadataEnrichmentField[],
  conflicts: FieldConflict[],
  rejects: FieldRejectReason[]
): string[] {
  const derived: string[] = [];
  const wantProof = targets.includes("proof") && isUnresolvedField(candidate.proof);
  const wantAbv = targets.includes("abv") && isUnresolvedField(candidate.abv);

  if (wantProof && !isUnresolvedField(candidate.abv)) {
    const incoming = field(
      proofFromAbv(candidate.abv.value as number),
      candidate.abv.source,
      candidate.abv.confidence
    );
    if (applyMergeTracked(candidate, "proof", incoming, conflicts, rejects)) {
      derived.push("proof");
    }
  }

  if (wantAbv && !isUnresolvedField(candidate.proof)) {
    const incoming = field(
      abvFromProof(candidate.proof.value as number),
      candidate.proof.source,
      candidate.proof.confidence
    );
    if (applyMergeTracked(candidate, "abv", incoming, conflicts, rejects)) {
      derived.push("abv");
    }
  }
  return derived;
}

function applyCatalogProduct(
  candidate: BottleCandidate,
  catalog: BottleCandidate,
  targets: MetadataEnrichmentField[],
  conflicts: FieldConflict[],
  rejects: FieldRejectReason[]
): string[] {
  const accepted: string[] = [];
  for (const name of targets) {
    const incoming = catalog[name] as ProductField<string | number>;
    if (isUnresolvedField(incoming)) continue;
    if (name === "category" && typeof incoming.value === "string") {
      const tax = normalizeCanonicalTaxonomy(incoming.value, "");
      const label = tax.type || tax.family;
      if (!label) {
        rejects.push({ field: name, reason: "classification_not_canonical" });
        continue;
      }
      if (applyMergeTracked(candidate, "category", field(label, incoming.source, incoming.confidence), conflicts, rejects)) {
        accepted.push(name);
      }
      continue;
    }
    if (applyMergeTracked(candidate, name, incoming, conflicts, rejects)) {
      accepted.push(name);
    }
  }
  return accepted;
}

function applyExtracted(
  candidate: BottleCandidate,
  extracted: MetadataExtractResult,
  targets: MetadataEnrichmentField[],
  conflicts: FieldConflict[],
  rejects: FieldRejectReason[]
): { extractedNonNull: string[]; accepted: string[] } {
  const extractedNonNull: string[] = [];
  const accepted: string[] = [];
  for (const name of targets) {
    if (!(name in extracted)) continue;
    let value = extracted[name];
    if (value == null) continue;

    // Normalize again at merge time so mocked/raw extracts cannot bypass validation.
    if (name === "category" && typeof value === "string") {
      const tax = normalizeCanonicalTaxonomy(value, "");
      value = tax.type || tax.family || null;
      if (value == null) {
        rejects.push({ field: name, reason: "classification_not_canonical" });
        continue;
      }
    }
    if (name === "abv") {
      value = normalizeCanonicalAbv(value);
      if (value == null) {
        rejects.push({ field: name, reason: "invalid_numeric" });
        continue;
      }
    }
    if (name === "proof") {
      value = normalizeCanonicalProof(value);
      if (value == null) {
        rejects.push({ field: name, reason: "invalid_numeric" });
        continue;
      }
    }
    if (name === "volume_ml") {
      value = normalizeCanonicalVolumeMl(value);
      if (value == null) {
        rejects.push({ field: name, reason: "invalid_numeric" });
        continue;
      }
    }

    extractedNonNull.push(name);
    const incoming = field(value as string | number | null, "web");
    if (applyMergeTracked(candidate, name, incoming, conflicts, rejects)) {
      accepted.push(name);
    }
  }
  return { extractedNonNull, accepted };
}

function summarize(
  before: BottleCandidate,
  candidate: BottleCandidate,
  targets: MetadataEnrichmentField[],
  conflicts: FieldConflict[],
  errors: EnrichmentExecutionError[],
  diagnostics: JobDiagnosticsPayload
): EnrichmentExecutionResult {
  const completed: EnrichmentField[] = [];
  const unresolved: EnrichmentField[] = [];
  const updated: EnrichmentField[] = [];
  for (const name of targets) {
    const afterField = candidate[name] as ProductField<unknown>;
    const beforeField = before[name] as ProductField<unknown>;
    const improved =
      (isUnresolvedField(beforeField) && !isUnresolvedField(afterField))
      || (
        !isUnresolvedField(afterField)
        && (beforeField.value !== afterField.value || beforeField.confidence < afterField.confidence)
      );

    if (isUnresolvedField(afterField) || afterField.confidence < TRUSTED_MIN) {
      unresolved.push(name);
    } else {
      completed.push(name);
    }
    if (improved && !isUnresolvedField(afterField)) {
      updated.push(name);
    }
  }
  diagnostics.requested = targets.map(String);
  diagnostics.unresolved = unresolved.map(String);
  diagnostics.accepted = [...new Set([...(diagnostics.accepted ?? []), ...updated.map(String)])];
  return {
    candidate,
    requested: [...targets],
    completed,
    unresolved,
    updated,
    conflicts,
    errors,
    diagnostics: sanitizeJobDiagnostics(diagnostics)
  };
}

function emptyDiagnostics(): JobDiagnosticsPayload {
  return {
    jobType: "metadata",
    noResultReason: null,
    summary: null,
    stages: [],
    requested: [],
    extracted: [],
    accepted: [],
    unresolved: [],
    rejectReasons: []
  };
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
  const rejects: FieldRejectReason[] = [];
  const stages: EnrichmentDiagnosticStage[] = [];
  const diagnostics = emptyDiagnostics();
  diagnostics.rejectReasons = rejects;

  if (!targets.length) {
    return summarize(before, candidate, targets, conflicts, errors, diagnostics);
  }

  const lookupByUpc = deps.lookupByUpc ?? ((upc: string) => lookupProduct(upc, { mode: "live" }));
  const searchHits = deps.searchWebHits ?? searchWebHits;
  const extractMetadata = deps.extractMetadata ?? extractMetadataFromWebText;

  try {
    const derived = applyDeterministicDerivations(candidate, targets, conflicts, rejects);
    if (derived.length) {
      diagnostics.accepted = [...(diagnostics.accepted ?? []), ...derived];
      stages.push({
        stage: "derive",
        status: "ok",
        acceptedCount: derived.length,
        reason: `derived:${derived.join(",")}`
      });
    }
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
        const accepted = applyCatalogProduct(candidate, catalog, targets, conflicts, rejects);
        stages.push({
          stage: "catalog",
          status: accepted.length ? "ok" : "no_result",
          provider: String(result.source ?? "catalog"),
          acceptedCount: accepted.length,
          reason: accepted.length ? `catalog:${accepted.join(",")}` : "catalog_no_usable_fields"
        });
        if (accepted.length) {
          diagnostics.accepted = [...(diagnostics.accepted ?? []), ...accepted];
        }
      } else {
        stages.push({
          stage: "catalog",
          status: "no_result",
          provider: "catalog",
          reason: "catalog_miss"
        });
      }
    } catch (error) {
      for (const name of stillNeeded(candidate, targets)) {
        errors.push({
          field: name,
          message: error instanceof Error ? error.message : "Catalog lookup failed"
        });
      }
      stages.push({
        stage: "catalog",
        status: "error",
        provider: "catalog",
        reason: error instanceof Error ? error.message.slice(0, 120) : "catalog_error"
      });
    }
  }

  const needed = stillNeeded(candidate, targets);
  if (needed.length) {
    const queries = buildMetadataSearchQueries(candidate, needed);
    let allHits: WebSearchHit[] = [];
    let searchError: Error | null = null;
    let totalResults = 0;

    for (const query of queries) {
      try {
        let hits: WebSearchHit[] = [];
        if (deps.searchWeb && !deps.searchWebHits) {
          const snippets = await deps.searchWeb(query, 5);
          if (snippets.trim()) {
            hits = [{ title: "injected", content: snippets, url: "https://injected.local/snippet" }];
          }
        } else {
          hits = await searchHits(query, 5);
        }
        totalResults += hits.length;
        stages.push({
          stage: "search",
          status: hits.length ? "ok" : "no_result",
          query,
          provider: "searxng",
          candidateCount: hits.length,
          reason: hits.length ? undefined : "no_search_results"
        });
        allHits.push(...hits);
      } catch (error) {
        searchError = error instanceof Error ? error : new Error(String(error));
        const reason = isWebSearchError(error)
          ? `${error.code}:${error.message}`.slice(0, 120)
          : (searchError.message.slice(0, 120));
        stages.push({
          stage: "search",
          status: "error",
          query,
          provider: "searxng",
          reason
        });
        // Provider failures should surface as retryable job errors.
        for (const name of needed) {
          errors.push({
            field: name,
            message: isWebSearchError(error)
              ? `SearXNG ${error.code}: ${error.message}`
              : searchError.message
          });
        }
        break;
      }
    }

    // Deduplicate hits by URL.
    const seenUrls = new Set<string>();
    allHits = allHits.filter((h) => {
      const key = h.url || `${h.title}:${h.content.slice(0, 40)}`;
      if (seenUrls.has(key)) return false;
      seenUrls.add(key);
      return true;
    });

    if (!searchError) {
      if (totalResults === 0 && allHits.length === 0) {
        diagnostics.noResultReason = "no_search_results";
        diagnostics.summary = "Search returned no results";
      } else {
        const brand = candidate.brand.value;
        const name = candidate.name.value;
        const classified: ClassifiedHit[] = allHits.map((h) =>
          classifyHit(h, { brand, name })
        );
        // Injected test snippets bypass retailer filter.
        const authoritative = classified.filter(
          (h) =>
            isAuthoritativeSource(h.sourceClass)
            || h.url.includes("injected.local")
        );
        const rejected = classified.filter((h) => !authoritative.includes(h));

        stages.push({
          stage: "source_selection",
          status: authoritative.length ? "ok" : "no_result",
          candidateCount: classified.length,
          acceptedCount: authoritative.length,
          rejectedCount: rejected.length,
          reason: authoritative.length
            ? undefined
            : "no_authoritative_sources",
          sourceUrls: [
            ...authoritative.map((h) => h.url),
            ...rejected.slice(0, 6).map((h) => h.url)
          ]
        });

        // Record per-class rejection reasons compactly.
        for (const hit of rejected.slice(0, 8)) {
          stages.push({
            stage: "source_reject",
            status: "skipped",
            reason: sourceClassDiagnosticReason(hit.sourceClass, false),
            sourceUrls: hit.url ? [hit.url] : undefined
          });
        }

        if (!authoritative.length) {
          diagnostics.noResultReason = "no_authoritative_sources";
          diagnostics.summary = "No authoritative source produced usable metadata";
        } else {
          try {
            const snippets = authoritative.some((h) => h.url.includes("injected.local"))
              ? authoritative.map((h) => h.content).join("\n")
              : formatAuthoritativeSnippets(authoritative);
            const extracted = await extractMetadata({
              candidate,
              fields: needed,
              webSnippets: snippets
            });
            const safe: MetadataExtractResult = {};
            for (const name of needed) {
              if (name in extracted) safe[name] = extracted[name] ?? null;
            }
            const { extractedNonNull, accepted } = applyExtracted(
              candidate,
              safe,
              needed,
              conflicts,
              rejects
            );
            diagnostics.extracted = extractedNonNull;
            diagnostics.accepted = [...(diagnostics.accepted ?? []), ...accepted];

            stages.push({
              stage: "extract",
              status: extractedNonNull.length ? "ok" : "no_result",
              provider: "ollama",
              candidateCount: authoritative.length,
              acceptedCount: accepted.length,
              reason: extractedNonNull.length
                ? undefined
                : "extractor_returned_null"
            });

            if (!extractedNonNull.length) {
              diagnostics.noResultReason = "extractor_returned_null";
              diagnostics.summary = "Extractor returned no supported values";
            } else if (!accepted.length) {
              const onlyInvalid = rejects.every(
                (r) => r.reason === "invalid_numeric" || r.reason === "classification_not_canonical"
              );
              diagnostics.noResultReason = onlyInvalid
                ? "extracted_values_invalid"
                : "all_values_weaker_than_existing";
              diagnostics.summary = onlyInvalid
                ? "Extracted values failed canonical validation"
                : "Extracted values were weaker than existing data";
            }
          } catch (error) {
            for (const name of needed) {
              errors.push({
                field: name,
                message: error instanceof Error ? error.message : "Web/LLM metadata extract failed"
              });
            }
            stages.push({
              stage: "extract",
              status: "error",
              provider: "ollama",
              reason: error instanceof Error ? error.message.slice(0, 120) : "extract_error"
            });
            diagnostics.noResultReason = "provider_error";
          }
        }
      }
    } else {
      diagnostics.noResultReason = "provider_error";
      diagnostics.summary = "Provider or network error";
    }
  }

  try {
    const derived = applyDeterministicDerivations(candidate, targets, conflicts, rejects);
    if (derived.length) {
      diagnostics.accepted = [...new Set([...(diagnostics.accepted ?? []), ...derived])];
    }
  } catch {
    // Already reported on first pass if needed.
  }

  diagnostics.stages = stages;
  const result = summarize(before, candidate, targets, conflicts, errors, diagnostics);

  // Clear no-result reason when we made useful progress.
  if (result.updated.length > 0) {
    result.diagnostics.noResultReason = null;
    if (!result.unresolved.length) {
      result.diagnostics.summary = "Metadata fields filled";
    } else {
      result.diagnostics.summary = `Updated ${result.updated.join(", ")}; still missing ${result.unresolved.join(", ")}`;
    }
  }

  return result;
}

export { METADATA_ENRICHMENT_FIELDS };
