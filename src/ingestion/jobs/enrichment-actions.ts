/**
 * Keeper-only enrichment review actions on the current architecture.
 *
 * Reuses queue controls, entity metadata allowlists, canonical normalization,
 * and product_field_ownership. Does not introduce enrichment_field_overrides
 * or a parallel ownership sidecar.
 */
import { saveBarcodeCacheEntry, getBarcodeCacheEntry } from "../../barcode_cache.js";
import { normalizeCanonicalAbv } from "../../canonical-normalize.js";
import { db } from "../../db.js";
import { getFromCache, saveToCache } from "../catalogs/cola-cache-store.js";
import { confidenceForSource } from "../candidate/confidence.js";
import type { ProductFieldSource } from "../candidate/types.js";
import { TRUSTED_MIN } from "../enrichment/rules.js";
import { metadataFieldsForEntityType } from "../enrichment/metadata-fields.js";
import { recordAdminAuditEvent } from "./admin-audit.js";
import {
  buildBottleEnrichmentView,
  type BottleEnrichmentView,
  type ConflictView
} from "./enrichment-view.js";
import {
  getFieldOwnership,
  stampHumanFieldOwnership,
  type OwnedEnrichmentField
} from "./field-ownership.js";
import { loadInventoryRow } from "./inventory.js";
import {
  queueItemEnrichment,
  type ItemEnrichmentJobType,
  type ItemEnrichmentQueueResult
} from "./item-enrichment-queue.js";
import {
  isEnrichmentEntityType,
  isEnrichmentJobType,
  type EnrichmentEntityType
} from "./types.js";

export type EnrichmentActionError = { error: string; statusCode: number };

export type RerunEnrichmentResult = ItemEnrichmentQueueResult & {
  view: BottleEnrichmentView;
};

export type VerifyFieldResult = {
  entityType: EnrichmentEntityType;
  entityId: number;
  field: OwnedEnrichmentField;
  ownership: "human";
  source: "user";
  value: string | number | null;
  view: BottleEnrichmentView;
};

export type ResolveConflictResult = {
  entityType: EnrichmentEntityType;
  entityId: number;
  field: string;
  choice: "keep" | "accept";
  keptValue: string | number | null;
  appliedValue: string | number | null;
  view: BottleEnrichmentView;
};

/** Inventory columns Keeper may update for identity conflict acceptance. */
const IDENTITY_INVENTORY_COLUMN: Record<
  EnrichmentEntityType,
  Partial<Record<"name" | "brand", string>>
> = {
  spirits: { name: "name", brand: "brand" },
  packaged_beer: { name: "name", brand: "brewery" },
  wines: { name: "name", brand: "producer" }
};

const OWNERSHIP_VERIFY_FIELDS = new Set(["abv", "category", "style"]);

function isTrustedSource(source: string | null | undefined): boolean {
  if (!source) return false;
  return confidenceForSource(source as ProductFieldSource) >= TRUSTED_MIN;
}

function actionError(error: string, statusCode: number): EnrichmentActionError {
  return { error, statusCode };
}

function loadEntityOrError(
  entityTypeRaw: string,
  entityIdRaw: number
):
  | { entityType: EnrichmentEntityType; entityId: number; row: Record<string, unknown> }
  | EnrichmentActionError {
  if (!isEnrichmentEntityType(entityTypeRaw)) {
    return actionError("Enrichment not available for this module", 404);
  }
  const entityId = Math.floor(Number(entityIdRaw));
  if (!Number.isFinite(entityId) || entityId <= 0) {
    return actionError("Invalid id", 400);
  }
  const row = loadInventoryRow(entityTypeRaw, entityId);
  if (!row) return actionError("Item not found", 404);
  return { entityType: entityTypeRaw, entityId, row };
}

function refreshView(
  entityType: EnrichmentEntityType,
  entityId: number
): BottleEnrichmentView {
  const view = buildBottleEnrichmentView({
    entityType,
    entityId,
    includeDiagnostics: true
  });
  if (!view) {
    throw new Error("Item vanished after enrichment action");
  }
  return view;
}

/**
 * Explicit Keeper rerun/retry for one enrichment job type.
 * Dedupes through the existing queue scheduler.
 */
export function rerunItemEnrichmentJob(options: {
  entityType: string;
  entityId: number;
  jobType: unknown;
}): RerunEnrichmentResult | EnrichmentActionError {
  const loaded = loadEntityOrError(options.entityType, options.entityId);
  if ("error" in loaded) return loaded;

  if (typeof options.jobType !== "string" || !isEnrichmentJobType(options.jobType)) {
    return actionError("jobType must be metadata, tasting_notes, or image", 400);
  }
  const jobType = options.jobType as ItemEnrichmentJobType;

  const queued = queueItemEnrichment({
    entityType: loaded.entityType,
    entityId: loaded.entityId,
    jobTypes: [jobType],
    mode: "retry"
  });
  if ("error" in queued) return queued;

  recordAdminAuditEvent("enrichment_job_rerun", {
    entityType: loaded.entityType,
    entityId: loaded.entityId,
    jobType,
    queued: queued.queued,
    skipped: queued.skipped
  });

  return {
    ...queued,
    view: refreshView(loaded.entityType, loaded.entityId)
  };
}

function normalizeVerifyField(
  entityType: EnrichmentEntityType,
  raw: unknown
): OwnedEnrichmentField | EnrichmentActionError {
  if (typeof raw !== "string" || !raw.trim()) {
    return actionError("field is required", 400);
  }
  const field = raw.trim().toLowerCase();
  if (entityType !== "packaged_beer") {
    return actionError("Mark verified is only supported for packaged beer ABV and style", 400);
  }
  if (!OWNERSHIP_VERIFY_FIELDS.has(field)) {
    // Explicitly reject spirits-style metadata that packaged beer must not review.
    if (["proof", "volume_ml", "origin", "ttb_id"].includes(field)) {
      return actionError("Field is not reviewable for packaged beer", 400);
    }
    return actionError("Only abv and category/style can be marked verified", 400);
  }
  const allowed = new Set(metadataFieldsForEntityType("packaged_beer").map(String));
  const owned: OwnedEnrichmentField = field === "abv" ? "abv" : "category";
  if (!allowed.has(owned === "category" ? "category" : "abv")) {
    return actionError("Field is not allowed for this entity type", 400);
  }
  return owned;
}

/**
 * Mark an existing packaged-beer ABV/style value as Keeper/human-owned.
 * Does not change the stored value.
 */
export function verifyEnrichmentField(options: {
  entityType: string;
  entityId: number;
  field: unknown;
}): VerifyFieldResult | EnrichmentActionError {
  const loaded = loadEntityOrError(options.entityType, options.entityId);
  if ("error" in loaded) return loaded;

  const owned = normalizeVerifyField(loaded.entityType, options.field);
  if (typeof owned !== "string") return owned;

  const column = owned === "abv" ? "abv" : "style";
  const rawValue = loaded.row[column];
  if (owned === "abv") {
    const abv = normalizeCanonicalAbv(rawValue, { productType: "beer" });
    if (abv == null) {
      return actionError("Cannot verify an empty ABV value", 400);
    }
  } else {
    if (!String(rawValue ?? "").trim()) {
      return actionError("Cannot verify an empty style/category value", 400);
    }
  }

  stampHumanFieldOwnership({
    entityType: loaded.entityType,
    entityId: loaded.entityId,
    fields: [owned === "abv" ? "abv" : "style"]
  });

  const ownership = getFieldOwnership(loaded.entityType, loaded.entityId, owned);
  recordAdminAuditEvent("enrichment_field_verified", {
    entityType: loaded.entityType,
    entityId: loaded.entityId,
    field: owned,
    value: rawValue ?? null,
    ownership: ownership?.ownership ?? "human"
  });

  return {
    entityType: loaded.entityType,
    entityId: loaded.entityId,
    field: owned,
    ownership: "human",
    source: "user",
    value: (rawValue as string | number | null) ?? null,
    view: refreshView(loaded.entityType, loaded.entityId)
  };
}

function findResolvableConflict(
  view: BottleEnrichmentView,
  fieldRaw: unknown
): ConflictView | EnrichmentActionError {
  if (typeof fieldRaw !== "string" || !fieldRaw.trim()) {
    return actionError("field is required", 400);
  }
  const field = fieldRaw.trim().toLowerCase();
  const aliases = new Set([field]);
  if (field === "style") aliases.add("category");
  if (field === "category") aliases.add("style");
  if (field === "brewery" || field === "producer") aliases.add("brand");

  const match = view.enrichment.conflicts.find(
    (c) => aliases.has(c.field.toLowerCase()) && c.resolvable
  );
  if (!match) {
    return actionError("No resolvable conflict for that field", 400);
  }
  if (!isTrustedSource(match.competingSource)) {
    return actionError("Competing value is not from a trusted enrichment source", 400);
  }
  return match;
}

function applyIdentityInventoryUpdate(options: {
  entityType: EnrichmentEntityType;
  entityId: number;
  field: "name" | "brand";
  value: string;
}): void {
  const column = IDENTITY_INVENTORY_COLUMN[options.entityType][options.field];
  if (!column) {
    throw new Error(`No inventory column for ${options.entityType}.${options.field}`);
  }
  db.prepare(
    `UPDATE ${options.entityType}
     SET ${column} = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(options.value, options.entityId);
}

function alignIdentityCaches(options: {
  upc: string;
  field: "name" | "brand";
  value: string;
}): void {
  const upc = options.upc.trim();
  if (!upc) return;

  const barcode = getBarcodeCacheEntry(upc);
  if (barcode) {
    saveBarcodeCacheEntry({
      ...barcode,
      [options.field]: options.value,
      source: "keeper_confirmed"
    });
  }

  const cola = getFromCache(upc, { allowStale: true });
  if (cola && String(cola.name ?? "").trim()) {
    saveToCache(
      {
        ...cola,
        [options.field]: options.value
      },
      null,
      null,
      "keeper_confirmed"
    );
  }
}

function applyOwnershipInventoryUpdate(options: {
  entityId: number;
  field: OwnedEnrichmentField;
  value: string | number;
}): void {
  if (options.field === "abv") {
    const abv = normalizeCanonicalAbv(options.value, { productType: "beer" });
    if (abv == null) {
      throw new Error("Invalid ABV competing value");
    }
    db.prepare(
      `UPDATE packaged_beer SET abv = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(abv, options.entityId);
    return;
  }
  const style = String(options.value).trim();
  db.prepare(
    `UPDATE packaged_beer SET style = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(style, options.entityId);
}

/**
 * Resolve a displayed conflict using only server-known trusted competing values.
 * Client chooses keep|accept — never supplies a free-form replacement value.
 */
export function resolveEnrichmentConflict(options: {
  entityType: string;
  entityId: number;
  field: unknown;
  choice: unknown;
  /** Rejected if present — clients must not inject replacement values. */
  value?: unknown;
  competingValue?: unknown;
  replacement?: unknown;
}): ResolveConflictResult | EnrichmentActionError {
  if (
    options.value !== undefined
    || options.competingValue !== undefined
    || options.replacement !== undefined
  ) {
    return actionError("Replacement values are not accepted; choose keep or accept only", 400);
  }
  if (options.choice !== "keep" && options.choice !== "accept") {
    return actionError("choice must be keep or accept", 400);
  }

  const loaded = loadEntityOrError(options.entityType, options.entityId);
  if ("error" in loaded) return loaded;

  const view = refreshView(loaded.entityType, loaded.entityId);
  const conflict = findResolvableConflict(view, options.field);
  if ("error" in conflict) return conflict;

  const choice = options.choice;
  const kind = conflict.resolutionKind ?? "identity";

  if (kind === "ownership") {
    if (loaded.entityType !== "packaged_beer") {
      return actionError("Ownership conflict resolution is only supported for packaged beer", 400);
    }
    const owned: OwnedEnrichmentField =
      conflict.field === "abv" ? "abv" : "category";

    if (choice === "keep") {
      stampHumanFieldOwnership({
        entityType: "packaged_beer",
        entityId: loaded.entityId,
        fields: [owned === "abv" ? "abv" : "style"]
      });
    } else {
      if (conflict.competingValue == null || conflict.competingValue === "") {
        return actionError("Competing value is missing", 400);
      }
      try {
        applyOwnershipInventoryUpdate({
          entityId: loaded.entityId,
          field: owned,
          value: conflict.competingValue
        });
      } catch (err) {
        return actionError(
          err instanceof Error ? err.message : "Could not apply competing value",
          400
        );
      }
      stampHumanFieldOwnership({
        entityType: "packaged_beer",
        entityId: loaded.entityId,
        fields: [owned === "abv" ? "abv" : "style"]
      });
    }

    recordAdminAuditEvent("enrichment_conflict_resolved", {
      entityType: loaded.entityType,
      entityId: loaded.entityId,
      field: owned,
      choice,
      keptValue: conflict.keptValue,
      competingValue: conflict.competingValue,
      competingSource: conflict.competingSource,
      kind: "ownership"
    });

    return {
      entityType: loaded.entityType,
      entityId: loaded.entityId,
      field: owned,
      choice,
      keptValue: conflict.keptValue,
      appliedValue: choice === "accept" ? conflict.competingValue : conflict.keptValue,
      view: refreshView(loaded.entityType, loaded.entityId)
    };
  }

  // Identity conflicts: name / brand only (product_type is not durably inventory-mapped).
  const identityField = conflict.field === "brand" ? "brand" : conflict.field === "name" ? "name" : null;
  if (!identityField) {
    return actionError("Unsupported identity conflict field", 400);
  }
  if (!IDENTITY_INVENTORY_COLUMN[loaded.entityType][identityField]) {
    return actionError("Identity field is not writable for this entity", 400);
  }

  const upc = String(loaded.row.upc ?? "").trim();

  if (choice === "keep") {
    const kept = String(conflict.keptValue ?? "").trim();
    if (!kept) return actionError("Current value is empty", 400);
    alignIdentityCaches({ upc, field: identityField, value: kept });
  } else {
    const competing = String(conflict.competingValue ?? "").trim();
    if (!competing) return actionError("Competing value is missing", 400);
    applyIdentityInventoryUpdate({
      entityType: loaded.entityType,
      entityId: loaded.entityId,
      field: identityField,
      value: competing
    });
    alignIdentityCaches({ upc, field: identityField, value: competing });
  }

  recordAdminAuditEvent("enrichment_conflict_resolved", {
    entityType: loaded.entityType,
    entityId: loaded.entityId,
    field: identityField,
    choice,
    keptValue: conflict.keptValue,
    competingValue: conflict.competingValue,
    competingSource: conflict.competingSource,
    kind: "identity"
  });

  return {
    entityType: loaded.entityType,
    entityId: loaded.entityId,
    field: identityField,
    choice,
    keptValue: conflict.keptValue,
    appliedValue: choice === "accept" ? conflict.competingValue : conflict.keptValue,
    view: refreshView(loaded.entityType, loaded.entityId)
  };
}

/** Fields the UI may offer "Mark verified" for, given entity + current value. */
export function verifiableFieldsForEntity(
  entityType: EnrichmentEntityType,
  row: Record<string, unknown>
): OwnedEnrichmentField[] {
  if (entityType !== "packaged_beer") return [];
  const out: OwnedEnrichmentField[] = [];
  if (normalizeCanonicalAbv(row.abv, { productType: "beer" }) != null) {
    out.push("abv");
  }
  if (String(row.style ?? "").trim()) {
    out.push("category");
  }
  return out;
}
