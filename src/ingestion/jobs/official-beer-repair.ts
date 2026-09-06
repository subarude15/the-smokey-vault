/**
 * Exact-match official brewery repair for packaged beer.
 * Does not change global SOURCE_CONFIDENCE ranking — only repairs machine-owned
 * values when an exact/strong official product page disagrees.
 */
import type { OfficialBeerDiscoveryResult } from "../../official_brewery_beer_discovery.js";
import {
  field,
  valuesDisagree,
  type BottleCandidate,
  type ProductField
} from "../candidate/index.js";
import type { ProductFieldSource } from "../candidate/types.js";
import { recordAdminAuditEvent } from "./admin-audit.js";
import {
  classifyStoredFieldForOfficialRepair,
  stampMachineFieldOwnership,
  type OwnedEnrichmentField
} from "./field-ownership.js";
import { requestOfficialImageRepair } from "./official-image-repair.js";
import { getProductImage, inventoryHasUserImage } from "./product-images.js";
import type { EnrichmentEntityType } from "./types.js";

export type OfficialRepairDecision =
  | "repaired_machine_value"
  | "preserved_human_value"
  | "unchanged_same_value"
  | "skipped_gate"
  | "unresolved_conflict";

export type OfficialFieldRepairEvent = {
  field: OwnedEnrichmentField | "ibu" | "image";
  decision: OfficialRepairDecision;
  previousValue: string | number | null;
  previousSource: string | null;
  incomingValue: string | number | null;
  incomingSource: "official_brewery";
  matchQuality: string;
  message: string;
};

export type OfficialRepairSummary = {
  evaluated: boolean;
  matchQuality: string | null;
  events: OfficialFieldRepairEvent[];
  styleRepaired: boolean;
  abvRepaired: boolean;
  imageRepairRequested: boolean;
};

const REPAIR_MATCHES = new Set(["exact_name", "strong_name"]);

export function isOfficialRepairMatchQuality(match: string | null | undefined): boolean {
  return REPAIR_MATCHES.has(String(match ?? ""));
}

export function passesOfficialRepairGate(options: {
  entityType: string;
  discovery: OfficialBeerDiscoveryResult | null;
}): boolean {
  if (options.entityType !== "packaged_beer") return false;
  const discovery = options.discovery;
  if (!discovery || discovery.status !== "matched") return false;
  if (!discovery.productPageUrl) return false;
  if (!isOfficialRepairMatchQuality(discovery.match)) return false;
  return true;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) < 1e-6;
  }
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

function audit(eventName: string, detail: Record<string, unknown>): void {
  try {
    recordAdminAuditEvent(eventName, detail);
  } catch {
    // Audit must never fail enrichment.
  }
}

function repairScalarField<T extends string | number>(options: {
  entityType: EnrichmentEntityType;
  entityId: number;
  fieldName: OwnedEnrichmentField;
  existing: ProductField<T>;
  incomingValue: T;
  matchQuality: string;
  candidate: BottleCandidate;
}): { candidate: BottleCandidate; event: OfficialFieldRepairEvent; repaired: boolean } {
  const classification = classifyStoredFieldForOfficialRepair({
    entityType: options.entityType,
    entityId: options.entityId,
    field: options.fieldName,
    candidateSource: options.existing.source
  });

  const baseDetail = {
    entityType: options.entityType,
    entityId: options.entityId,
    field: options.fieldName,
    previousValue: options.existing.value ?? null,
    previousSource: classification.source,
    incomingValue: options.incomingValue,
    incomingSource: "official_brewery" as const,
    matchQuality: options.matchQuality,
    ownership: classification.ownership,
    reason: classification.reason
  };

  audit("beer_official_repair_evaluated", baseDetail);

  if (options.existing.value != null && valuesEqual(options.existing.value, options.incomingValue)) {
    if (classification.repairable) {
      stampMachineFieldOwnership({
        entityType: options.entityType,
        entityId: options.entityId,
        field: options.fieldName,
        source: "official_brewery"
      });
      if (options.fieldName === "abv") {
        options.candidate.abv = field(options.incomingValue as number, "official_brewery");
      } else {
        options.candidate.category = field(String(options.incomingValue), "official_brewery");
      }
    }
    return {
      candidate: options.candidate,
      repaired: false,
      event: {
        field: options.fieldName,
        decision: "unchanged_same_value",
        previousValue: (options.existing.value as string | number | null) ?? null,
        previousSource: classification.source,
        incomingValue: options.incomingValue,
        incomingSource: "official_brewery",
        matchQuality: options.matchQuality,
        message: "Official brewery value already matches stored value"
      }
    };
  }

  if (!classification.repairable) {
    const decision: OfficialRepairDecision =
      classification.ownership === "human" || classification.reason === "user_source"
        ? "preserved_human_value"
        : "unresolved_conflict";
    audit(
      decision === "preserved_human_value"
        ? "beer_official_repair_preserved_human"
        : "beer_official_repair_evaluated",
      { ...baseDetail, decision }
    );
    return {
      candidate: options.candidate,
      repaired: false,
      event: {
        field: options.fieldName,
        decision,
        previousValue: (options.existing.value as string | number | null) ?? null,
        previousSource: classification.source,
        incomingValue: options.incomingValue,
        incomingSource: "official_brewery",
        matchQuality: options.matchQuality,
        message:
          decision === "preserved_human_value"
            ? "Official brewery value conflicts with Keeper-entered value; existing value preserved"
            : "Official brewery value conflicts with an ambiguous existing value; left unchanged"
      }
    };
  }

  // Bypass equal-confidence mergeField stalemate for machine-owned values.
  if (options.fieldName === "abv") {
    options.candidate.abv = field(options.incomingValue as number, "official_brewery");
  } else {
    options.candidate.category = field(String(options.incomingValue), "official_brewery");
  }
  stampMachineFieldOwnership({
    entityType: options.entityType,
    entityId: options.entityId,
    field: options.fieldName,
    source: "official_brewery"
  });
  audit("beer_official_repair_applied", {
    ...baseDetail,
    decision: "repaired_machine_value"
  });

  return {
    candidate: options.candidate,
    repaired: true,
    event: {
      field: options.fieldName,
      decision: "repaired_machine_value",
      previousValue: (options.existing.value as string | number | null) ?? null,
      previousSource: classification.source,
      incomingValue: options.incomingValue,
      incomingSource: "official_brewery",
      matchQuality: options.matchQuality,
      message: "Repaired prior machine-derived value using exact official brewery match"
    }
  };
}

function evaluateImageRepair(options: {
  entityType: EnrichmentEntityType;
  entityId: number;
  row: Record<string, unknown>;
  discovery: OfficialBeerDiscoveryResult;
  matchQuality: string;
}): OfficialFieldRepairEvent & { requested: boolean } {
  const imageUrl = options.discovery.fields.imageUrl?.trim() || null;
  audit("beer_official_image_repair_evaluated", {
    entityType: options.entityType,
    entityId: options.entityId,
    matchQuality: options.matchQuality,
    hasOfficialImageCandidate: Boolean(imageUrl)
  });

  if (inventoryHasUserImage(options.row, options.entityType, options.entityId)) {
    audit("beer_official_image_repair_skipped_user_owned", {
      entityType: options.entityType,
      entityId: options.entityId,
      matchQuality: options.matchQuality
    });
    return {
      field: "image",
      decision: "preserved_human_value",
      previousValue: String(options.row.image_url ?? "") || null,
      previousSource: "user",
      incomingValue: imageUrl,
      incomingSource: "official_brewery",
      matchQuality: options.matchQuality,
      message: "User/shelf image left untouched",
      requested: false
    };
  }

  if (!imageUrl) {
    return {
      field: "image",
      decision: "skipped_gate",
      previousValue: null,
      previousSource: null,
      incomingValue: null,
      incomingSource: "official_brewery",
      matchQuality: options.matchQuality,
      message: "No official image candidate on exact-match page",
      requested: false
    };
  }

  const existing = getProductImage(options.entityType, options.entityId);
  if (!existing?.url) {
    requestOfficialImageRepair({
      entityType: options.entityType,
      entityId: options.entityId,
      matchQuality: options.matchQuality,
      officialPageUrl: options.discovery.productPageUrl,
      officialImageUrl: imageUrl
    });
    return {
      field: "image",
      decision: "repaired_machine_value",
      previousValue: null,
      previousSource: null,
      incomingValue: imageUrl,
      incomingSource: "official_brewery",
      matchQuality: options.matchQuality,
      message: "Queued official image candidate for normal verify/select pipeline",
      requested: true
    };
  }

  if (existing.source_type === "user") {
    audit("beer_official_image_repair_skipped_user_owned", {
      entityType: options.entityType,
      entityId: options.entityId
    });
    return {
      field: "image",
      decision: "preserved_human_value",
      previousValue: existing.url,
      previousSource: "user",
      incomingValue: imageUrl,
      incomingSource: "official_brewery",
      matchQuality: options.matchQuality,
      message: "product_images user ownership preserved",
      requested: false
    };
  }

  if (!existing.source_type || existing.source_type === "lookup") {
    return {
      field: "image",
      decision: "unresolved_conflict",
      previousValue: existing.url,
      previousSource: existing.source_type,
      incomingValue: imageUrl,
      incomingSource: "official_brewery",
      matchQuality: options.matchQuality,
      message: "Existing image ownership ambiguous; not auto-replaced",
      requested: false
    };
  }

  // Already bound to this official page and verified — idempotent no-op.
  if (
    existing.source_type === "official" &&
    existing.source_url &&
    options.discovery.productPageUrl &&
    existing.source_url === options.discovery.productPageUrl &&
    existing.verified
  ) {
    return {
      field: "image",
      decision: "unchanged_same_value",
      previousValue: existing.url,
      previousSource: existing.source_type,
      incomingValue: imageUrl,
      incomingSource: "official_brewery",
      matchQuality: options.matchQuality,
      message: "Accepted official image already bound to this product page",
      requested: false
    };
  }

  // Machine-owned accepted image — reopen even if previously verified/high score.
  requestOfficialImageRepair({
    entityType: options.entityType,
    entityId: options.entityId,
    matchQuality: options.matchQuality,
    officialPageUrl: options.discovery.productPageUrl,
    officialImageUrl: imageUrl
  });
  audit("beer_official_image_repair_applied", {
    entityType: options.entityType,
    entityId: options.entityId,
    matchQuality: options.matchQuality,
    previousSource: existing.source_type,
    previousScore: existing.score ?? null
  });
  return {
    field: "image",
    decision: "repaired_machine_value",
    previousValue: existing.url,
    previousSource: existing.source_type,
    incomingValue: imageUrl,
    incomingSource: "official_brewery",
    matchQuality: options.matchQuality,
    message: "Reopened machine image selection for stronger exact official brewery candidate",
    requested: true
  };
}

/**
 * Apply gated metadata/image repair against an already-matched official discovery.
 * Mutates candidate for repairable fields; records ownership + audit events.
 */
export function applyOfficialBeerRepairs(options: {
  entityType: EnrichmentEntityType;
  entityId: number;
  row: Record<string, unknown>;
  candidate: BottleCandidate;
  discovery: OfficialBeerDiscoveryResult;
}): { candidate: BottleCandidate; summary: OfficialRepairSummary } {
  const matchQuality = options.discovery.match;
  const summary: OfficialRepairSummary = {
    evaluated: true,
    matchQuality,
    events: [],
    styleRepaired: false,
    abvRepaired: false,
    imageRepairRequested: false
  };

  if (!passesOfficialRepairGate({ entityType: options.entityType, discovery: options.discovery })) {
    summary.evaluated = false;
    return { candidate: options.candidate, summary };
  }

  let candidate = options.candidate;

  const style = options.discovery.fields.style?.trim() || null;
  if (style) {
    const result = repairScalarField({
      entityType: options.entityType,
      entityId: options.entityId,
      fieldName: "category",
      existing: candidate.category as ProductField<string>,
      incomingValue: style,
      matchQuality,
      candidate
    });
    candidate = result.candidate;
    summary.events.push(result.event);
    summary.styleRepaired = result.repaired;
  }

  if (options.discovery.fields.abv != null) {
    const result = repairScalarField({
      entityType: options.entityType,
      entityId: options.entityId,
      fieldName: "abv",
      existing: candidate.abv as ProductField<number>,
      incomingValue: options.discovery.fields.abv,
      matchQuality,
      candidate
    });
    candidate = result.candidate;
    summary.events.push(result.event);
    summary.abvRepaired = result.repaired;
  }

  // IBU is extracted but packaged_beer has no column — record only.
  if (options.discovery.fields.ibu != null) {
    summary.events.push({
      field: "ibu",
      decision: "skipped_gate",
      previousValue: null,
      previousSource: null,
      incomingValue: options.discovery.fields.ibu,
      incomingSource: "official_brewery",
      matchQuality,
      message: "IBU extracted from official page but packaged_beer has no IBU column"
    });
  }

  const imageEvent = evaluateImageRepair({
    entityType: options.entityType,
    entityId: options.entityId,
    row: options.row,
    discovery: options.discovery,
    matchQuality
  });
  summary.events.push(imageEvent);
  summary.imageRepairRequested = imageEvent.requested;

  return { candidate, summary };
}

export function isKeeperVisibleRepairEvent(event: OfficialFieldRepairEvent): boolean {
  return (
    event.decision === "repaired_machine_value" ||
    event.decision === "preserved_human_value" ||
    event.decision === "unresolved_conflict"
  );
}

export function repairEventsAsConflicts(events: OfficialFieldRepairEvent[]): Array<{
  field: string;
  existing: ProductField<unknown>;
  incoming: ProductField<unknown>;
}> {
  return events
    .filter(isKeeperVisibleRepairEvent)
    .filter((e) => e.field === "abv" || e.field === "category")
    .map((e) => ({
      field: e.field,
      existing: field(
        e.previousValue,
        (e.previousSource as ProductFieldSource) || "unknown"
      ),
      incoming: field(e.incomingValue, "official_brewery")
    }));
}

// Keep import referenced for future equal-value guards in callers.
void valuesDisagree;
