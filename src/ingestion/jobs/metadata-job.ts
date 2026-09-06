/**
 * Run one metadata enrichment job against a saved inventory entity.
 */
import type { OfficialBeerDiscoveryDeps } from "../../official_brewery_beer_discovery.js";
import {
  executeMetadataEnrichment,
  planEnrichment,
  type EnrichmentExecutionResult,
  type MetadataEnrichmentDeps
} from "../enrichment/index.js";
import {
  candidateFromInventoryRow,
  hasRecommendedMetadataWork,
  loadInventoryRow,
  persistMetadataImprovements
} from "./inventory.js";
import {
  buildMetadataJobResultPayload,
  type MetadataJobResultPayload,
  unresolvedMetadataFields
} from "./metadata-outcome.js";
import { applyOfficialBreweryBeerDiscovery } from "./official-brewery-beer.js";
import type { EnrichmentJob } from "./types.js";

export type MetadataJobResult = {
  skipped: boolean;
  reason?: string;
  execution?: EnrichmentExecutionResult;
  inventoryUpdated: string[];
  cacheUpdated: boolean;
  /** Lightweight progress for job.result_json. */
  resultPayload: MetadataJobResultPayload;
  officialBreweryDiscovery?: {
    attempted: boolean;
    status?: string;
    productPageStored?: boolean;
    abvUpdated?: boolean;
    styleUpdated?: boolean;
    imageRepairRequested?: boolean;
  };
};

export type MetadataJobDeps = MetadataEnrichmentDeps & {
  officialBeerDiscoveryDeps?: OfficialBeerDiscoveryDeps;
};

export async function runMetadataJob(
  job: EnrichmentJob,
  deps: MetadataJobDeps = {}
): Promise<MetadataJobResult> {
  const row = loadInventoryRow(job.entity_type, job.entity_id);
  if (!row) {
    throw new Error(`Inventory ${job.entity_type}#${job.entity_id} not found`);
  }

  let before = candidateFromInventoryRow(job.entity_type, row);
  const plan = planEnrichment(before);

  if (!plan.identified) {
    return {
      skipped: true,
      reason: "not_identified",
      inventoryUpdated: [],
      cacheUpdated: false,
      resultPayload: {
        requested: [],
        updated: [],
        unresolved: unresolvedMetadataFields(before).map(String)
      }
    };
  }
  if (plan.needsReview) {
    return {
      skipped: true,
      reason: "needs_review",
      inventoryUpdated: [],
      cacheUpdated: false,
      resultPayload: {
        requested: [],
        updated: [],
        unresolved: unresolvedMetadataFields(before).map(String)
      }
    };
  }

  // Official brewery discovery for identified packaged beer — even when other
  // metadata fields already look complete. Never runs on autocomplete keystrokes.
  let officialMeta: MetadataJobResult["officialBreweryDiscovery"];
  if (job.entity_type === "packaged_beer") {
    const snapshotBeforeOfficial = before;
    const applied = await applyOfficialBreweryBeerDiscovery({
      entityType: job.entity_type,
      entityId: job.entity_id,
      candidate: before,
      row,
      discoveryDeps: deps.officialBeerDiscoveryDeps
    });
    before = applied.candidate;
    officialMeta = {
      attempted: applied.attempted,
      status: applied.discovery?.status,
      productPageStored: applied.productPageStored,
      abvUpdated: applied.abvUpdated,
      styleUpdated: applied.styleUpdated,
      imageRepairRequested: applied.imageRepairRequested
    };

    if (applied.abvUpdated || applied.styleUpdated) {
      persistMetadataImprovements({
        entityType: job.entity_type,
        entityId: job.entity_id,
        before: snapshotBeforeOfficial,
        after: before
      });
    }

    if (applied.imageRepairRequested) {
      const { maybeEnqueueImageEnrichment } = await import("./enqueue.js");
      maybeEnqueueImageEnrichment({
        entityType: job.entity_type,
        entityId: job.entity_id,
        row
      });
    }
  }

  if (!hasRecommendedMetadataWork(before)) {
    return {
      skipped: true,
      reason:
        officialMeta?.productPageStored || officialMeta?.abvUpdated || officialMeta?.styleUpdated || officialMeta?.imageRepairRequested
          ? "official_brewery_only"
          : "already_complete",
      inventoryUpdated: [
        ...(officialMeta?.abvUpdated ? ["abv"] as const : []),
        ...(officialMeta?.styleUpdated ? ["style"] as const : [])
      ],
      cacheUpdated: false,
      officialBreweryDiscovery: officialMeta,
      resultPayload: {
        requested: [],
        updated: [
          ...(officialMeta?.abvUpdated ? ["abv"] as const : []),
          ...(officialMeta?.styleUpdated ? ["style"] as const : [])
        ],
        unresolved: []
      }
    };
  }

  const execution = await executeMetadataEnrichment(before, plan, deps);

  // Transient system/dep failures with zero progress should retry, not look like
  // a successful "nothing found" completion.
  if (execution.errors.length > 0 && execution.updated.length === 0) {
    const message =
      execution.errors.map((e) => e.message).join("; ") || "metadata enrichment failed";
    throw new Error(message);
  }

  const persisted = persistMetadataImprovements({
    entityType: job.entity_type,
    entityId: job.entity_id,
    before,
    after: execution.candidate
  });

  // Final diagnostics must reflect post-persist canonical state (vault + caches),
  // not the pre-run candidate or in-memory MEDIUM-confidence web fields alone.
  const finalRow = loadInventoryRow(job.entity_type, job.entity_id) ?? row;
  const afterFinal = candidateFromInventoryRow(job.entity_type, finalRow);

  const resultPayload = buildMetadataJobResultPayload({
    requested: execution.requested.map(String),
    before,
    after: afterFinal,
    inventoryUpdated: persisted.inventoryUpdated,
    diagnostics: execution.diagnostics
  });

  return {
    skipped: false,
    execution,
    inventoryUpdated: persisted.inventoryUpdated,
    cacheUpdated: persisted.cacheUpdated,
    officialBreweryDiscovery: officialMeta,
    resultPayload
  };
}
