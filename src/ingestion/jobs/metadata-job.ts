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
import { maybeEnqueueImageEnrichment } from "./enqueue.js";
import { upsertEnrichmentSource } from "./enrichment-sources.js";
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
    followUpAttempted?: boolean;
    followUpStatus?: string;
    officialDomainEstablishedAfterGeneric?: string | null;
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
  let initialOfficialMatched = false;
  let initialOfficialWebsiteHost: string | null = null;
  let followUpOfficialAttempted = false;
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
    initialOfficialMatched = applied.discovery?.status === "matched";
    initialOfficialWebsiteHost = applied.resolvedWebsiteHost
      ? applied.resolvedWebsiteHost.replace(/^www\./, "").toLowerCase()
      : null;
    officialMeta = {
      attempted: applied.attempted,
      status: applied.discovery?.status,
      productPageStored: applied.productPageStored,
      abvUpdated: applied.abvUpdated,
      styleUpdated: applied.styleUpdated,
      imageRepairRequested: applied.imageRepairRequested,
      followUpAttempted: false,
      officialDomainEstablishedAfterGeneric: null
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

  // Persist generic metadata first so follow-up official repairs cannot be
  // overwritten by a later generic write.
  let persisted = persistMetadataImprovements({
    entityType: job.entity_type,
    entityId: job.entity_id,
    before,
    after: execution.candidate
  });
  const inventoryUpdated = new Set(persisted.inventoryUpdated);
  let cacheUpdated = persisted.cacheUpdated;

  // Sequencing: if generic enrichment newly established an official brewery
  // domain that the initial official attempt lacked, run ONE follow-up official
  // discovery attempt before the job ends. No loops.
  const establishedDomains = (execution.acceptedOfficialDomains ?? [])
    .map((d) => String(d).replace(/^www\./, "").toLowerCase())
    .filter(Boolean);
  const newlyEstablishedDomain = establishedDomains.find(
    (domain) => !initialOfficialWebsiteHost || domain !== initialOfficialWebsiteHost
  ) ?? null;

  if (officialMeta) {
    officialMeta.officialDomainEstablishedAfterGeneric = newlyEstablishedDomain;
  }

  const canFollowUpOfficial =
    job.entity_type === "packaged_beer"
    && !plan.needsReview
    && plan.identified
    && !initialOfficialMatched
    && Boolean(newlyEstablishedDomain)
    && !followUpOfficialAttempted
    && Boolean(before.name.value?.trim())
    && Boolean(before.brand.value?.trim());

  if (canFollowUpOfficial && newlyEstablishedDomain) {
    followUpOfficialAttempted = true;
    const domainUrl = `https://${newlyEstablishedDomain}`;
    upsertEnrichmentSource({
      entityType: job.entity_type,
      entityId: job.entity_id,
      sourceType: "official_brewery_domain",
      sourceUrl: domainUrl
    });

    execution.diagnostics.stages = [
      ...(execution.diagnostics.stages ?? []),
      {
        stage: "official_brewery_initial_attempt",
        status: officialMeta?.attempted ? "ok" : "skipped",
        reason: initialOfficialMatched
          ? "matched"
          : (officialMeta?.status ?? "not_attempted"),
        sourceUrls: initialOfficialWebsiteHost ? [`https://${initialOfficialWebsiteHost}`] : undefined
      },
      {
        stage: "official_domain_established_after_generic",
        status: "ok",
        reason: newlyEstablishedDomain,
        sourceUrls: [domainUrl]
      }
    ];

    const rowForFollowUp: Record<string, unknown> = {
      ...row,
      website_url: domainUrl,
      website_host: newlyEstablishedDomain
    };
    // Reload post-generic canonical candidate so official repairs see persisted state.
    const postGenericRow = loadInventoryRow(job.entity_type, job.entity_id) ?? rowForFollowUp;
    const postGenericCandidate = candidateFromInventoryRow(job.entity_type, postGenericRow);
    const snapshotBeforeFollowUp = postGenericCandidate;

    const followUp = await applyOfficialBreweryBeerDiscovery({
      entityType: job.entity_type,
      entityId: job.entity_id,
      candidate: postGenericCandidate,
      row: { ...postGenericRow, website_url: domainUrl, website_host: newlyEstablishedDomain },
      discoveryDeps: deps.officialBeerDiscoveryDeps
    });
    followUpOfficialAttempted = true;

    execution.diagnostics.stages = [
      ...(execution.diagnostics.stages ?? []),
      {
        stage: "official_brewery_followup_attempt",
        status: "ok",
        reason: followUp.discovery?.status ?? "attempted",
        sourceUrls: [domainUrl]
      },
      {
        stage: "official_brewery_followup_match",
        status: followUp.discovery?.status === "matched" ? "ok" : "no_result",
        reason: followUp.discovery?.match
          ? String(followUp.discovery.match)
          : (followUp.discovery?.reason ?? followUp.discovery?.status ?? "not_matched"),
        sourceUrls: followUp.discovery?.productPageUrl
          ? [followUp.discovery.productPageUrl]
          : [domainUrl]
      }
    ];

    if (officialMeta) {
      officialMeta.followUpAttempted = true;
      officialMeta.followUpStatus = followUp.discovery?.status;
      officialMeta.attempted = true;
      if (followUp.discovery?.status) officialMeta.status = followUp.discovery.status;
      officialMeta.productPageStored =
        Boolean(officialMeta.productPageStored) || followUp.productPageStored;
      officialMeta.abvUpdated = Boolean(officialMeta.abvUpdated) || followUp.abvUpdated;
      officialMeta.styleUpdated = Boolean(officialMeta.styleUpdated) || followUp.styleUpdated;
      officialMeta.imageRepairRequested =
        Boolean(officialMeta.imageRepairRequested) || followUp.imageRepairRequested;
    }

    if (followUp.abvUpdated || followUp.styleUpdated) {
      const followPersisted = persistMetadataImprovements({
        entityType: job.entity_type,
        entityId: job.entity_id,
        before: snapshotBeforeFollowUp,
        after: followUp.candidate
      });
      for (const fieldName of followPersisted.inventoryUpdated) inventoryUpdated.add(fieldName);
      cacheUpdated = cacheUpdated || followPersisted.cacheUpdated;
    }

    if (followUp.imageRepairRequested) {
      maybeEnqueueImageEnrichment({
        entityType: job.entity_type,
        entityId: job.entity_id,
        row: postGenericRow
      });
    }
  } else if (officialMeta && job.entity_type === "packaged_beer") {
    execution.diagnostics.stages = [
      ...(execution.diagnostics.stages ?? []),
      {
        stage: "official_brewery_initial_attempt",
        status: officialMeta.attempted ? "ok" : "skipped",
        reason: initialOfficialMatched
          ? "matched"
          : (officialMeta.status ?? "not_attempted"),
        sourceUrls: initialOfficialWebsiteHost ? [`https://${initialOfficialWebsiteHost}`] : undefined
      },
      {
        stage: "official_domain_established_after_generic",
        status: newlyEstablishedDomain ? "ok" : "no_result",
        reason: newlyEstablishedDomain
          ?? (establishedDomains.length ? "domain_already_known" : "no_official_domain"),
        sourceUrls: newlyEstablishedDomain
          ? [`https://${newlyEstablishedDomain}`]
          : establishedDomains.map((d) => `https://${d}`)
      },
      {
        stage: "official_brewery_followup_attempt",
        status: "skipped",
        reason: initialOfficialMatched
          ? "initial_already_matched"
          : (!newlyEstablishedDomain ? "no_new_official_domain" : "followup_not_eligible")
      }
    ];
  }

  // Final diagnostics must reflect post-persist canonical state (vault + caches),
  // not the pre-run candidate or in-memory MEDIUM-confidence web fields alone.
  const finalRow = loadInventoryRow(job.entity_type, job.entity_id) ?? row;
  const afterFinal = candidateFromInventoryRow(job.entity_type, finalRow);

  const resultPayload = buildMetadataJobResultPayload({
    requested: execution.requested.map(String),
    before,
    after: afterFinal,
    inventoryUpdated: [...inventoryUpdated],
    diagnostics: execution.diagnostics
  });

  return {
    skipped: false,
    execution,
    inventoryUpdated: [...inventoryUpdated],
    cacheUpdated,
    officialBreweryDiscovery: officialMeta,
    resultPayload
  };
}
