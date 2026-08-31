/**
 * Dedicated sourced tasting-note / house-profile storage.
 * Keeps official + AI content separate from inventory notes / tasting_notes (personal).
 */
import { db } from "../../db.js";
import type { EnrichmentEntityType } from "./types.js";

export type OfficialSourceType = "official" | "importer";

export type ProductContent = {
  entity_type: EnrichmentEntityType;
  entity_id: number;
  official_tasting_notes: string | null;
  official_source_url: string | null;
  official_source_type: OfficialSourceType | null;
  house_tasting_profile: string | null;
  house_profile_generated_at: string | null;
  updated_at: string;
};

export type TastingNotesContent = {
  official: string | null;
  officialSourceUrl: string | null;
  officialSourceType: OfficialSourceType | null;
  houseProfile: string | null;
  /** Personal notes live on the inventory row; never stored here. */
  personal: string | null;
};

export function ensureProductContentTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_content (
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      official_tasting_notes TEXT,
      official_source_url TEXT,
      official_source_type TEXT,
      house_tasting_profile TEXT,
      house_profile_generated_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (entity_type, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_product_content_entity
      ON product_content(entity_type, entity_id);
  `);
}

ensureProductContentTable();

type ContentRow = {
  entity_type: string;
  entity_id: number;
  official_tasting_notes: string | null;
  official_source_url: string | null;
  official_source_type: string | null;
  house_tasting_profile: string | null;
  house_profile_generated_at: string | null;
  updated_at: string;
};

function mapRow(row: ContentRow): ProductContent {
  const sourceType =
    row.official_source_type === "official" || row.official_source_type === "importer"
      ? row.official_source_type
      : null;
  return {
    entity_type: row.entity_type as EnrichmentEntityType,
    entity_id: Number(row.entity_id),
    official_tasting_notes: row.official_tasting_notes?.trim() || null,
    official_source_url: row.official_source_url?.trim() || null,
    official_source_type: sourceType,
    house_tasting_profile: row.house_tasting_profile?.trim() || null,
    house_profile_generated_at: row.house_profile_generated_at,
    updated_at: row.updated_at
  };
}

export function getProductContent(
  entityType: EnrichmentEntityType,
  entityId: number
): ProductContent | null {
  const row = db.prepare(`
    SELECT * FROM product_content WHERE entity_type = ? AND entity_id = ?
  `).get(entityType, entityId) as ContentRow | undefined;
  return row ? mapRow(row) : null;
}

/** Personal tasting/cellar notes from the inventory row — read-only for enrichment. */
export function readPersonalNotes(row: Record<string, unknown>): string | null {
  const tasting = String(row.tasting_notes ?? "").trim();
  const cellar = String(row.notes ?? "").trim();
  if (tasting) return tasting;
  if (cellar) return cellar;
  return null;
}

export function toTastingNotesContent(
  content: ProductContent | null,
  personal: string | null
): TastingNotesContent {
  return {
    official: content?.official_tasting_notes ?? null,
    officialSourceUrl: content?.official_source_url ?? null,
    officialSourceType: content?.official_source_type ?? null,
    houseProfile: content?.house_tasting_profile ?? null,
    personal
  };
}

function shouldReplaceOfficial(
  existing: ProductContent | null,
  incomingType: OfficialSourceType
): boolean {
  if (!existing?.official_tasting_notes) return true;
  if (existing.official_source_type === "importer" && incomingType === "official") return true;
  return false;
}

/**
 * Persist official notes and/or house profile.
 * Never clears existing official notes with weaker/unknown data.
 * Never writes personal notes. Never overwrites an existing house profile.
 */
export function upsertProductContent(options: {
  entityType: EnrichmentEntityType;
  entityId: number;
  officialNotes?: string | null;
  officialSourceUrl?: string | null;
  officialSourceType?: OfficialSourceType | null;
  houseProfile?: string | null;
}): ProductContent {
  const existing = getProductContent(options.entityType, options.entityId);

  let officialNotes = existing?.official_tasting_notes ?? null;
  let officialSourceUrl = existing?.official_source_url ?? null;
  let officialSourceType = existing?.official_source_type ?? null;

  const incomingNotes = options.officialNotes?.trim() || null;
  const incomingUrl = options.officialSourceUrl?.trim() || null;
  const incomingType = options.officialSourceType ?? null;

  if (incomingNotes && incomingUrl && incomingType && shouldReplaceOfficial(existing, incomingType)) {
    officialNotes = incomingNotes;
    officialSourceUrl = incomingUrl;
    officialSourceType = incomingType;
  }

  let houseProfile = existing?.house_tasting_profile ?? null;
  let houseGeneratedAt = existing?.house_profile_generated_at ?? null;
  const incomingHouse = options.houseProfile?.trim() || null;
  if (incomingHouse && !houseProfile) {
    houseProfile = incomingHouse;
    houseGeneratedAt = db.prepare(`SELECT CURRENT_TIMESTAMP`).pluck().get() as string;
  }

  db.prepare(`
    INSERT INTO product_content (
      entity_type, entity_id,
      official_tasting_notes, official_source_url, official_source_type,
      house_tasting_profile, house_profile_generated_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(entity_type, entity_id) DO UPDATE SET
      official_tasting_notes = excluded.official_tasting_notes,
      official_source_url = excluded.official_source_url,
      official_source_type = excluded.official_source_type,
      house_tasting_profile = excluded.house_tasting_profile,
      house_profile_generated_at = excluded.house_profile_generated_at,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    options.entityType,
    options.entityId,
    officialNotes,
    officialSourceUrl,
    officialSourceType,
    houseProfile,
    houseGeneratedAt
  );

  return getProductContent(options.entityType, options.entityId)!;
}

export function clearProductContentForTests() {
  db.exec("DELETE FROM product_content");
}

/** True when both official notes and house profile are already present. */
export function productContentFullyPopulated(content: ProductContent | null): boolean {
  return Boolean(content?.official_tasting_notes?.trim() && content?.house_tasting_profile?.trim());
}
