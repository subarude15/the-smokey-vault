/**
 * Keeper-only legacy packaged-beer audit.
 *
 * Finds historical packaged beers that never benefited from the modern
 * official-brewery enrichment pipeline and queues them for another metadata
 * pass. Does NOT mutate canonical beer metadata (style / ABV / notes / image).
 *
 * Preview is read-only. Queue may backfill durable `official_brewery_domain`
 * from already-trusted local evidence, then enqueue metadata via existing
 * PR110 retry semantics so PR111 / PR109 decide any real repairs.
 */
import { db } from "../../db.js";
import { registeredDomain } from "../enrichment/official-domain.js";
import { classifySourceUrl } from "../enrichment/tasting-notes-sources.js";
import { recordAdminAuditEvent } from "./admin-audit.js";
import {
  getEnrichmentSource,
  upsertEnrichmentSource
} from "./enrichment-sources.js";
import { getFieldOwnership } from "./field-ownership.js";
import {
  candidateFromInventoryRow,
  loadInventoryRow
} from "./inventory.js";
import { queueItemEnrichment } from "./item-enrichment-queue.js";
import {
  metadataOutcomeFromState,
  parseMetadataJobResult,
  type MetadataOutcomeLabel
} from "./metadata-outcome.js";
import { getProductContent } from "./product-content.js";
import { getProductImage } from "./product-images.js";
import {
  getLatestCompletedJobResult,
  hasActiveEnrichmentJob
} from "./store.js";
import type { EnrichmentEntityType } from "./types.js";

const ENTITY_TYPE = "packaged_beer" as const satisfies EnrichmentEntityType;

/** Bound queue size per Keeper action. */
export const LEGACY_BEER_AUDIT_QUEUE_LIMIT = 50;
/** Bound candidate list returned to the UI. */
export const LEGACY_BEER_AUDIT_LIST_LIMIT = 50;

export type LegacyBeerAuditReason =
  | "metadata_no_result"
  | "metadata_partial"
  | "metadata_failed"
  | "metadata_predates_official_pipeline"
  | "no_official_brewery_domain"
  | "historical_machine_metadata"
  | "historical_machine_image"
  | "no_official_notes"
  | "known_official_product_page_without_domain"
  | "official_source_available_but_not_reprocessed";

export type LegacyBeerAuditResult = {
  entityId: number;
  name: string;
  brewery: string | null;
  candidate: boolean;
  reasons: LegacyBeerAuditReason[];
  recoveredOfficialDomain: string | null;
};

export type LegacyBeerAuditPreview = {
  scanned: number;
  candidates: number;
  reasonCounts: Partial<Record<LegacyBeerAuditReason, number>>;
  items: LegacyBeerAuditResult[];
  truncated: boolean;
};

export type LegacyBeerAuditQueueResult = {
  candidates: number;
  queued: number;
  alreadyQueued: number;
  skipped: number;
  domainsBackfilled: number;
  remaining: number;
  auditId: number;
};

function logLegacyAudit(event: string, detail: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...detail }));
}

function isImageAssetUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return /\.(avif|gif|jpe?g|png|svg|webp)(\?|$)/i.test(path);
  } catch {
    return /\.(avif|gif|jpe?g|png|svg|webp)(\?|$)/i.test(url);
  }
}

function domainFromTrustedUrl(url: string): string | null {
  const sourceClass = classifySourceUrl(url);
  if (
    sourceClass === "retailer"
    || sourceClass === "ugc"
    || sourceClass === "regulatory"
    || sourceClass === "importer"
  ) {
    return null;
  }
  if (isImageAssetUrl(url) && sourceClass !== "official") return null;
  const domain = registeredDomain(url);
  if (!domain) return null;
  if (sourceClass === "official" || sourceClass === "unknown") return domain;
  return null;
}

/**
 * Recover a registered official brewery domain from durable local evidence only.
 * Never trusts retailer / UGC / CDN image hosts or guessed brewery-name domains.
 * Preview-safe: no network I/O.
 */
export function recoverOfficialBreweryDomainFromEvidence(options: {
  entityId: number;
  row?: Record<string, unknown> | null;
}): string | null {
  const { entityId } = options;

  const storedDomain = getEnrichmentSource(
    ENTITY_TYPE,
    entityId,
    "official_brewery_domain"
  );
  if (storedDomain?.sourceUrl) {
    return registeredDomain(storedDomain.sourceUrl);
  }

  const trustedUrls: string[] = [];

  const productPage = getEnrichmentSource(
    ENTITY_TYPE,
    entityId,
    "official_product_page"
  );
  if (productPage?.sourceUrl) trustedUrls.push(productPage.sourceUrl);

  const content = getProductContent(ENTITY_TYPE, entityId);
  if (
    content?.official_source_type === "official"
    && content.official_source_url
  ) {
    trustedUrls.push(content.official_source_url);
  }

  const image = getProductImage(ENTITY_TYPE, entityId);
  if (
    image?.verified
    && image.source_type === "official"
    && image.source_url
    && !isImageAssetUrl(image.source_url)
  ) {
    trustedUrls.push(image.source_url);
  }

  const websiteUrl = String(options.row?.website_url ?? "").trim();
  if (websiteUrl) trustedUrls.push(websiteUrl);

  for (const url of trustedUrls) {
    const domain = domainFromTrustedUrl(url);
    if (domain) return domain;
  }

  return null;
}

function beerHasOfficialBreweryDomain(entityId: number): boolean {
  return Boolean(
    getEnrichmentSource(ENTITY_TYPE, entityId, "official_brewery_domain")?.sourceUrl
  );
}

function beerHasOfficialProductPage(entityId: number): boolean {
  return Boolean(
    getEnrichmentSource(ENTITY_TYPE, entityId, "official_product_page")?.sourceUrl
  );
}

function latestOfficialDiscovery(entityId: number): {
  present: boolean;
  matched: boolean;
  productPageStored: boolean;
} {
  const raw = getLatestCompletedJobResult(ENTITY_TYPE, entityId, "metadata");
  const parsed = parseMetadataJobResult(raw);
  if (!parsed || typeof parsed !== "object") {
    return { present: false, matched: false, productPageStored: false };
  }
  const discovery = (parsed as Record<string, unknown>).officialBreweryDiscovery;
  if (!discovery || typeof discovery !== "object") {
    return { present: false, matched: false, productPageStored: false };
  }
  const status = String((discovery as { status?: unknown }).status ?? "");
  const productPageStored = Boolean(
    (discovery as { productPageStored?: unknown }).productPageStored
  );
  return {
    present: true,
    matched: status === "matched",
    productPageStored
  };
}

function hasMachineOwnedMetadata(entityId: number): boolean {
  const category = getFieldOwnership(ENTITY_TYPE, entityId, "category");
  const abv = getFieldOwnership(ENTITY_TYPE, entityId, "abv");
  return category?.ownership === "machine" || abv?.ownership === "machine";
}

function hasHistoricalMachineImage(entityId: number): boolean {
  const image = getProductImage(ENTITY_TYPE, entityId);
  if (!image?.url) return false;
  if (image.source_type === "user") return false;
  if (image.source_type === "official") return false;
  return (
    image.source_type === "approved"
    || image.source_type === "lookup"
    || image.source_type === "unknown"
    || image.source_type == null
  );
}

/**
 * Modern beers that already carry durable official brewery evidence should not
 * be selected merely because optional fields (TTB, origin, volume) are absent.
 */
function isHealthyModernOfficialBeer(entityId: number): boolean {
  if (!beerHasOfficialBreweryDomain(entityId)) return false;
  const page = beerHasOfficialProductPage(entityId);
  const discovery = latestOfficialDiscovery(entityId);
  return page || discovery.matched || discovery.productPageStored;
}

function metadataPredatesOfficialPipeline(entityId: number): boolean {
  const raw = getLatestCompletedJobResult(ENTITY_TYPE, entityId, "metadata");
  if (!raw?.trim()) return false;
  const parsed = parseMetadataJobResult(raw);
  if (!parsed) return false;
  return !Object.prototype.hasOwnProperty.call(parsed, "officialBreweryDiscovery");
}

export function auditPackagedBeer(
  entityId: number,
  row?: Record<string, unknown> | null
): LegacyBeerAuditResult {
  const inventoryRow = row ?? loadInventoryRow(ENTITY_TYPE, entityId);

  const name = String(inventoryRow?.name ?? "").trim() || `Beer #${entityId}`;
  const brewery = String(inventoryRow?.brewery ?? "").trim() || null;

  if (!inventoryRow) {
    return {
      entityId,
      name,
      brewery,
      candidate: false,
      reasons: [],
      recoveredOfficialDomain: null
    };
  }

  const recoveredOfficialDomain = recoverOfficialBreweryDomainFromEvidence({
    entityId,
    row: inventoryRow
  });

  if (isHealthyModernOfficialBeer(entityId)) {
    return {
      entityId,
      name,
      brewery,
      candidate: false,
      reasons: [],
      recoveredOfficialDomain
    };
  }

  const reasons: LegacyBeerAuditReason[] = [];
  const candidate = candidateFromInventoryRow(ENTITY_TYPE, inventoryRow);
  const outcome: MetadataOutcomeLabel = metadataOutcomeFromState({
    candidate,
    entityType: ENTITY_TYPE,
    entityId
  });

  if (outcome === "no_result") reasons.push("metadata_no_result");
  if (outcome === "partial") reasons.push("metadata_partial");
  if (outcome === "failed") reasons.push("metadata_failed");

  const hasDomain = beerHasOfficialBreweryDomain(entityId);
  const hasPage = beerHasOfficialProductPage(entityId);
  const discovery = latestOfficialDiscovery(entityId);
  const machineMeta = hasMachineOwnedMetadata(entityId);
  const machineImage = hasHistoricalMachineImage(entityId);
  const content = getProductContent(ENTITY_TYPE, entityId);
  const hasOfficialNotes = Boolean(content?.official_tasting_notes?.trim());

  if (!hasDomain) reasons.push("no_official_brewery_domain");

  if (machineMeta && !discovery.matched) {
    reasons.push("historical_machine_metadata");
  }

  if (machineImage && !hasPage && !discovery.matched) {
    reasons.push("historical_machine_image");
  }

  if (!hasOfficialNotes && (hasPage || Boolean(recoveredOfficialDomain))) {
    reasons.push("no_official_notes");
  }

  if (hasPage && !hasDomain) {
    reasons.push("known_official_product_page_without_domain");
  }

  if (metadataPredatesOfficialPipeline(entityId)) {
    reasons.push("metadata_predates_official_pipeline");
  }

  if (
    Boolean(recoveredOfficialDomain)
    && !discovery.matched
    && !hasDomain
  ) {
    reasons.push("official_source_available_but_not_reprocessed");
  }

  // Optional-field gaps alone never qualify. Require at least one strong signal.
  const strong = reasons.some(
    (reason) =>
      reason === "metadata_no_result"
      || reason === "metadata_partial"
      || reason === "metadata_failed"
      || reason === "metadata_predates_official_pipeline"
      || reason === "historical_machine_metadata"
      || reason === "historical_machine_image"
      || reason === "known_official_product_page_without_domain"
      || reason === "official_source_available_but_not_reprocessed"
      || (reason === "no_official_notes" && Boolean(recoveredOfficialDomain || hasPage))
  );

  const uniqueReasons = strong ? [...new Set(reasons)] : [];

  if (strong && recoveredOfficialDomain) {
    logLegacyAudit("legacy_beer_domain_recovered", {
      entityId,
      domain: recoveredOfficialDomain
    });
  }

  return {
    entityId,
    name,
    brewery,
    candidate: strong,
    reasons: uniqueReasons,
    recoveredOfficialDomain
  };
}

function listPackagedBeerRows(): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM packaged_beer ORDER BY id ASC`).all() as Array<
    Record<string, unknown>
  >;
}

export function previewLegacyBeerAudit(): LegacyBeerAuditPreview {
  const rows = listPackagedBeerRows();
  const reasonCounts: Partial<Record<LegacyBeerAuditReason, number>> = {};
  const candidates: LegacyBeerAuditResult[] = [];

  for (const row of rows) {
    const entityId = Number(row.id);
    if (!Number.isFinite(entityId) || entityId <= 0) continue;
    const result = auditPackagedBeer(entityId, row);
    if (!result.candidate) continue;
    candidates.push(result);
    for (const reason of result.reasons) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
  }

  logLegacyAudit("legacy_beer_audit_preview", {
    scanned: rows.length,
    candidates: candidates.length
  });

  return {
    scanned: rows.length,
    candidates: candidates.length,
    reasonCounts,
    items: candidates.slice(0, LEGACY_BEER_AUDIT_LIST_LIMIT),
    truncated: candidates.length > LEGACY_BEER_AUDIT_LIST_LIMIT
  };
}

/**
 * Persist a recovered official brewery domain (infrastructure only) and queue
 * metadata enrichment with PR110 explicit retry semantics.
 */
export function queueLegacyBeerAudit(options?: {
  limit?: number;
}): LegacyBeerAuditQueueResult {
  const limit = Math.max(
    1,
    Math.min(LEGACY_BEER_AUDIT_QUEUE_LIMIT, options?.limit ?? LEGACY_BEER_AUDIT_QUEUE_LIMIT)
  );

  const allCandidateIds: number[] = [];
  const auditsById = new Map<number, LegacyBeerAuditResult>();
  for (const row of listPackagedBeerRows()) {
    const entityId = Number(row.id);
    if (!Number.isFinite(entityId) || entityId <= 0) continue;
    const result = auditPackagedBeer(entityId, row);
    if (!result.candidate) continue;
    allCandidateIds.push(entityId);
    auditsById.set(entityId, result);
  }

  const toProcess = allCandidateIds.slice(0, limit);
  let queued = 0;
  let alreadyQueued = 0;
  let skipped = 0;
  let domainsBackfilled = 0;

  const run = db.transaction(() => {
    for (const entityId of toProcess) {
      const audit = auditsById.get(entityId) ?? auditPackagedBeer(entityId);
      if (!audit.candidate) {
        skipped += 1;
        continue;
      }

      if (audit.recoveredOfficialDomain && !beerHasOfficialBreweryDomain(entityId)) {
        upsertEnrichmentSource({
          entityType: ENTITY_TYPE,
          entityId,
          sourceType: "official_brewery_domain",
          sourceUrl: `https://${audit.recoveredOfficialDomain}`
        });
        domainsBackfilled += 1;
        logLegacyAudit("legacy_beer_domain_backfilled", {
          entityId,
          domain: audit.recoveredOfficialDomain
        });
      }

      if (hasActiveEnrichmentJob(ENTITY_TYPE, entityId, "metadata")) {
        alreadyQueued += 1;
        logLegacyAudit("legacy_beer_repair_skipped", {
          entityId,
          reason: "already_queued"
        });
        continue;
      }

      const enqueue = queueItemEnrichment({
        entityType: ENTITY_TYPE,
        entityId,
        jobTypes: ["metadata"],
        mode: "retry"
      });

      if ("error" in enqueue) {
        skipped += 1;
        logLegacyAudit("legacy_beer_repair_skipped", {
          entityId,
          reason: enqueue.error
        });
        continue;
      }

      if (enqueue.queued.includes("metadata")) {
        queued += 1;
        logLegacyAudit("legacy_beer_repair_queued", { entityId });
        continue;
      }

      const skip = enqueue.skipped.find((entry) => entry.type === "metadata");
      if (skip?.reason === "already_queued") {
        alreadyQueued += 1;
        logLegacyAudit("legacy_beer_repair_skipped", {
          entityId,
          reason: "already_queued"
        });
      } else {
        skipped += 1;
        logLegacyAudit("legacy_beer_repair_skipped", {
          entityId,
          reason: skip?.reason ?? "not_eligible"
        });
      }
    }
  });
  run();

  const remaining = Math.max(0, allCandidateIds.length - toProcess.length);
  const auditEvent = recordAdminAuditEvent("legacy_beer_audit_queue", {
    candidates: allCandidateIds.length,
    queued,
    alreadyQueued,
    skipped,
    domainsBackfilled,
    remaining,
    limit
  });

  return {
    candidates: allCandidateIds.length,
    queued,
    alreadyQueued,
    skipped,
    domainsBackfilled,
    remaining,
    auditId: auditEvent.id
  };
}
