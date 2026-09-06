/**
 * Durable machine-vs-human field ownership for packaged-beer repair.
 * Inventory rows remain vault-stamped on reload; this sidecar records whether a
 * value was Keeper/human entered or machine-derived so exact official matches
 * can repair explicitly machine-owned fields without clobbering Keeper edits.
 */
import { db } from "../../db.js";
import type { ProductFieldSource } from "../candidate/types.js";
import type { EnrichmentEntityType } from "./types.js";

export type FieldOwnershipKind = "human" | "machine";

/** Inventory-facing enrichment fields we may repair under exact official match. */
export type OwnedEnrichmentField = "abv" | "category";

export type FieldOwnershipRecord = {
  entity_type: EnrichmentEntityType;
  entity_id: number;
  field: OwnedEnrichmentField;
  ownership: FieldOwnershipKind;
  source: ProductFieldSource;
  updated_at: string;
};

const MACHINE_SOURCES = new Set<ProductFieldSource>([
  "beer_cache",
  "cola_cache",
  "open_food_facts",
  "upcitemdb",
  "vision",
  "web",
  "llm",
  "official_brewery",
  "unknown",
]);

let ensured = false;

export function ensureFieldOwnershipTable(): void {
  if (ensured) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_field_ownership (
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      field TEXT NOT NULL,
      ownership TEXT NOT NULL,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (entity_type, entity_id, field)
    );
    CREATE INDEX IF NOT EXISTS idx_product_field_ownership_entity
      ON product_field_ownership(entity_type, entity_id);
  `);
  ensured = true;
}

export function getFieldOwnership(
  entityType: EnrichmentEntityType,
  entityId: number,
  field: OwnedEnrichmentField
): FieldOwnershipRecord | null {
  ensureFieldOwnershipTable();
  const row = db
    .prepare(
      `SELECT entity_type, entity_id, field, ownership, source, updated_at
       FROM product_field_ownership
       WHERE entity_type = ? AND entity_id = ? AND field = ?`
    )
    .get(entityType, entityId, field) as FieldOwnershipRecord | undefined;
  return row ?? null;
}

export function upsertFieldOwnership(options: {
  entityType: EnrichmentEntityType;
  entityId: number;
  field: OwnedEnrichmentField;
  ownership: FieldOwnershipKind;
  source: ProductFieldSource;
}): FieldOwnershipRecord {
  ensureFieldOwnershipTable();
  db.prepare(
    `INSERT INTO product_field_ownership (entity_type, entity_id, field, ownership, source, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(entity_type, entity_id, field) DO UPDATE SET
       ownership = excluded.ownership,
       source = excluded.source,
       updated_at = CURRENT_TIMESTAMP`
  ).run(
    options.entityType,
    options.entityId,
    options.field,
    options.ownership,
    options.source
  );
  return getFieldOwnership(options.entityType, options.entityId, options.field)!;
}

export function stampHumanFieldOwnership(options: {
  entityType: string;
  entityId: number;
  fields: string[];
}): void {
  if (options.entityType !== "packaged_beer") return;
  const owned = new Set<OwnedEnrichmentField>();
  for (const raw of options.fields) {
    if (raw === "abv") owned.add("abv");
    if (raw === "style" || raw === "category") owned.add("category");
  }
  for (const field of owned) {
    upsertFieldOwnership({
      entityType: "packaged_beer",
      entityId: options.entityId,
      field,
      ownership: "human",
      source: "user"
    });
  }
}

export function stampMachineFieldOwnership(options: {
  entityType: EnrichmentEntityType;
  entityId: number;
  field: OwnedEnrichmentField;
  source: ProductFieldSource;
}): void {
  upsertFieldOwnership({
    ...options,
    ownership: "machine"
  });
}

/**
 * Classify whether an existing stored value may be repaired by exact-match
 * official brewery evidence. Prefer explicit ownership rows; fall back to
 * source heuristics only when ownership is absent.
 */
export function classifyStoredFieldForOfficialRepair(options: {
  entityType: EnrichmentEntityType;
  entityId: number;
  field: OwnedEnrichmentField;
  /** In-memory candidate source after inventory reload (often vault). */
  candidateSource: ProductFieldSource;
}): {
  repairable: boolean;
  ownership: FieldOwnershipKind | "unknown";
  source: ProductFieldSource;
  reason: string;
} {
  ensureFieldOwnershipTable();
  const row = getFieldOwnership(options.entityType, options.entityId, options.field);
  if (row?.ownership === "human" || row?.source === "user") {
    return {
      repairable: false,
      ownership: "human",
      source: (row?.source as ProductFieldSource) ?? "user",
      reason: "human_owned"
    };
  }
  if (row?.ownership === "machine") {
    return {
      repairable: true,
      ownership: "machine",
      source: row.source as ProductFieldSource,
      reason: "machine_owned"
    };
  }

  // No sidecar row: barcode_cache is trusted remembered identity — not silent repair.
  if (options.candidateSource === "barcode_cache") {
    return {
      repairable: false,
      ownership: "unknown",
      source: "barcode_cache",
      reason: "barcode_cache_protected"
    };
  }
  if (options.candidateSource === "user") {
    return {
      repairable: false,
      ownership: "human",
      source: "user",
      reason: "user_source"
    };
  }
  // Machine sources still present on the in-memory candidate are repairable.
  if (options.candidateSource !== "vault" && MACHINE_SOURCES.has(options.candidateSource)) {
    return {
      repairable: true,
      ownership: "machine",
      source: options.candidateSource,
      reason: "machine_source"
    };
  }
  // Inventory reload stamps everything as vault. Without an ownership row we
  // cannot tell Keeper/manual history from machine fill — do not guess.
  // DirtWolf-class repairs require durable machine evidence (or an explicit
  // machine ownership stamp), not the vault reload source alone.
  if (options.candidateSource === "vault") {
    return {
      repairable: false,
      ownership: "unknown",
      source: "vault",
      reason: "unmarked_vault_ambiguous"
    };
  }
  return {
    repairable: false,
    ownership: "unknown",
    source: options.candidateSource,
    reason: "ambiguous_ownership"
  };
}


/**
 * Deterministic ownership backfill from durable enrichment-job evidence only.
 * Stamps machine ownership for abv/category when a completed metadata job
 * recorded those fields in `updated` (or diagnostics.accepted). Never infers
 * machine ownership from a vault candidate reload stamp alone.
 */
export function backfillMachineFieldOwnershipFromMetadataJobs(options?: {
  entityId?: number;
}): { stamped: Array<{ entityId: number; field: OwnedEnrichmentField; source: ProductFieldSource }> } {
  ensureFieldOwnershipTable();
  const stamped: Array<{
    entityId: number;
    field: OwnedEnrichmentField;
    source: ProductFieldSource;
  }> = [];
  const params: Array<string | number> = ["packaged_beer", "metadata", "completed"];
  let sql = `
    SELECT entity_id, result_json
    FROM enrichment_jobs
    WHERE entity_type = ?
      AND job_type = ?
      AND status = ?
      AND result_json IS NOT NULL
  `;
  if (options?.entityId != null) {
    sql += ` AND entity_id = ?`;
    params.push(options.entityId);
  }
  sql += ` ORDER BY id ASC`;
  const rows = db.prepare(sql).all(...params) as Array<{
    entity_id: number;
    result_json: string | null;
  }>;

  const fieldsByEntity = new Map<number, Set<OwnedEnrichmentField>>();
  for (const row of rows) {
    if (!row.result_json) continue;
    let parsed: {
      updated?: unknown;
      diagnostics?: { accepted?: unknown };
    };
    try {
      parsed = JSON.parse(row.result_json);
    } catch {
      continue;
    }
    const names = new Set<string>();
    if (Array.isArray(parsed.updated)) {
      for (const item of parsed.updated) names.add(String(item));
    }
    const accepted = parsed.diagnostics?.accepted;
    if (Array.isArray(accepted)) {
      for (const item of accepted) names.add(String(item));
    }
    const owned = fieldsByEntity.get(row.entity_id) ?? new Set<OwnedEnrichmentField>();
    for (const name of names) {
      if (name === "abv") owned.add("abv");
      if (name === "category" || name === "style") owned.add("category");
    }
    if (owned.size) fieldsByEntity.set(row.entity_id, owned);
  }

  for (const [entityId, fields] of fieldsByEntity) {
    for (const field of fields) {
      const existing = getFieldOwnership("packaged_beer", entityId, field);
      if (existing) continue;
      stampMachineFieldOwnership({
        entityType: "packaged_beer",
        entityId,
        field,
        source: "web"
      });
      stamped.push({ entityId, field, source: "web" });
    }
  }
  return { stamped };
}

export function clearFieldOwnershipForTests(): void {
  ensureFieldOwnershipTable();
  db.exec("DELETE FROM product_field_ownership");
}

/** Overlay ownership onto a vault-stamped candidate field source. */
export function resolveCandidateSourceFromOwnership(
  entityType: EnrichmentEntityType,
  entityId: number,
  field: OwnedEnrichmentField,
  fallback: ProductFieldSource
): ProductFieldSource {
  const row = getFieldOwnership(entityType, entityId, field);
  if (!row) return fallback;
  if (row.ownership === "human") return "user";
  return (row.source as ProductFieldSource) || fallback;
}
