/**
 * Guest-safe inventory / enrichment response serializers.
 *
 * Keeper Mode keeps full shelf rows. Guest Mode gets an explicit allowlist so
 * patrons inspecting network traffic never receive UPC, stock counts, shelf
 * location, or enrichment operational plumbing.
 */
import { isSpiritEmpty, packagedCount } from "./catalog.js";
import type { BottleEnrichmentView } from "./ingestion/jobs/enrichment-view.js";

/** Fields attached by the inventory list route for vote-enabled tables. */
export const GUEST_VOTE_FIELDS = [
  "vote_up",
  "vote_down",
  "vote_net",
  "vote_total",
  "vote_score"
] as const;

/**
 * Explicit Guest allowlists per inventory table.
 * Derived from Guest Mode rendering (cards, bottle detail, votes, blocked ribbon)
 * plus a coarse `out_of_stock` availability signal for spirits / packaged beer.
 */
export const GUEST_INVENTORY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  spirits: [
    "id",
    "name",
    "brand",
    "category",
    "sub_category",
    "abv",
    "volume_ml",
    "purchase_date",
    "opened_date",
    "notes",
    "image_url",
    "display_image_url",
    "tasting_notes",
    "flavors",
    "tags",
    "base_ingredient",
    "blocked_from_ordering",
    "out_of_stock",
    ...GUEST_VOTE_FIELDS
  ],
  wines: [
    "id",
    "producer",
    "name",
    "varietal",
    "vintage",
    "type",
    "style",
    "region",
    "sweetness",
    "body",
    "drink_by_date",
    "pairings",
    "notes",
    "image_url",
    "display_image_url",
    "tasting_notes",
    "flavors",
    "tags",
    "base_ingredient",
    "blocked_from_ordering",
    ...GUEST_VOTE_FIELDS
  ],
  packaged_beer: [
    "id",
    "brewery",
    "name",
    "style",
    "pack_date",
    "abv",
    "image_url",
    "display_image_url",
    "notes",
    "tasting_notes",
    "flavors",
    "tags",
    "base_ingredient",
    "vessel",
    "out_of_stock",
    ...GUEST_VOTE_FIELDS
  ],
  taps: [
    "id",
    "tap_number",
    "source_type",
    "brewery_batch",
    "style",
    "abv",
    "ibu",
    "tapped_date",
    "maker",
    "notes",
    "image_url",
    "display_image_url",
    "tasting_notes",
    "flavors",
    "tags",
    "base_ingredient",
    ...GUEST_VOTE_FIELDS
  ],
  brews: [
    "id",
    "batch_name",
    "style",
    "brew_date",
    "calculated_abv",
    "schedule",
    "status",
    "notes",
    "maker",
    "image_url",
    "display_image_url",
    "tasting_notes",
    "flavors",
    "tags",
    "base_ingredient",
    "hops"
  ],
  cocktails: [
    "id",
    "name",
    "collection",
    "ingredients",
    "glassware",
    "garnish",
    "method",
    "notes",
    "season"
  ]
};

/**
 * Keeper-only keys that must never appear on Guest inventory responses.
 * Asserted by regression tests even when an allowlist accidentally drifts.
 */
export const GUEST_FORBIDDEN_INVENTORY_KEYS = [
  "upc",
  "stock_count",
  "bottle_count",
  "count",
  "fill_level",
  "shelf_location",
  "remaining_l",
  "keg_size_l",
  "brewfather_id",
  "target_og",
  "target_fg",
  "measured_og",
  "measured_fg"
] as const;

export function guestInventoryOutOfStock(
  table: string,
  row: Record<string, unknown>
): boolean | undefined {
  if (table === "spirits") return isSpiritEmpty(row);
  if (table === "packaged_beer") return packagedCount(row.count) <= 0;
  return undefined;
}

function pickAllowedFields(
  row: Record<string, unknown>,
  allowed: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined) {
      out[key] = row[key];
    }
  }
  return out;
}

/**
 * Project a canonical inventory row (+ display/vote fields) into a Guest-safe DTO.
 * Unknown tables fall back to an empty object rather than leaking raw rows.
 */
export function serializeGuestInventoryItem(
  table: string,
  row: Record<string, unknown>
): Record<string, unknown> {
  const allowed = GUEST_INVENTORY_FIELDS[table];
  if (!allowed) return {};

  const withAvailability: Record<string, unknown> = { ...row };
  const outOfStock = guestInventoryOutOfStock(table, row);
  if (typeof outOfStock === "boolean") {
    withAvailability.out_of_stock = outOfStock;
  }

  const safe = pickAllowedFields(withAvailability, allowed);
  for (const key of GUEST_FORBIDDEN_INVENTORY_KEYS) {
    delete safe[key];
  }
  return safe;
}

/** Keeper responses remain the full attached row (no field stripping). */
export function serializeKeeperInventoryItem(
  _table: string,
  row: Record<string, unknown>
): Record<string, unknown> {
  return row;
}

export function serializeInventoryItemForCaller(
  table: string,
  row: Record<string, unknown>,
  options: { admin: boolean }
): Record<string, unknown> {
  if (options.admin) return serializeKeeperInventoryItem(table, row);
  return serializeGuestInventoryItem(table, row);
}

/**
 * Guest enrichment projection: keep only patron tasting + display image fields.
 * Strips inventory dumps, UPC identity, jobs, conflicts, diagnostics, and provenance.
 */
export function serializeGuestEnrichmentView(
  view: BottleEnrichmentView
): Record<string, unknown> {
  return {
    entityType: view.entityType,
    entityId: view.entityId,
    tastingNotes: {
      official: view.tastingNotes.official,
      houseProfile: view.tastingNotes.houseProfile
    },
    image: {
      displayUrl: view.image.displayUrl,
      userPreferred: view.image.userPreferred
    }
  };
}

export function serializeEnrichmentViewForCaller(
  view: BottleEnrichmentView,
  options: { admin: boolean }
): BottleEnrichmentView | Record<string, unknown> {
  if (options.admin) return view;
  return serializeGuestEnrichmentView(view);
}

/** Keys that must never appear in Guest enrichment JSON (top-level or nested dump). */
export const GUEST_FORBIDDEN_ENRICHMENT_KEYS = [
  "upc",
  "stock_count",
  "bottle_count",
  "count",
  "fill_level",
  "shelf_location",
  "diagnostics",
  "diagnosticSummary",
  "contributors",
  "conflicts",
  "jobs",
  "inventory",
  "identity",
  "metadata",
  "enrichment",
  "sourceItemId",
  "matchedCode",
  "lastError",
  "attempts",
  "stillMissing",
  "lastRunLabel"
] as const;
