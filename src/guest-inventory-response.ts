/**
 * Guest-safe inventory / enrichment response serializers.
 *
 * Keeper Mode keeps full shelf rows. Guest Mode gets an explicit allowlist so
 * patrons inspecting network traffic never receive UPC, stock counts, shelf
 * location, or enrichment operational plumbing.
 *
 * Approved availability carve-out (PR #97): Guest Mode may receive a derived
 * coarse `availability_pct` gauge for spirits and taps. Raw `fill_level`,
 * `remaining_l`, exact pint counts, and other operational quantities stay
 * Keeper-only. Derivation is theme-independent — never gated on CSS/theme.
 */
import {
  DEFAULT_KEG_L,
  isSpiritEmpty,
  isTapEmpty,
  nearestFillStop,
  nearestKegStop,
  openNextSpirit,
  packagedCount
} from "./catalog.js";
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
 * plus coarse availability signals (`out_of_stock`, `availability_pct`) for
 * spirits / packaged beer / taps where approved.
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
    // purchase_date / opened_date: Keeper form fields only — no Guest feature requires them.
    "notes",
    "image_url",
    "display_image_url",
    "tasting_notes",
    "flavors",
    "tags",
    "base_ingredient",
    "blocked_from_ordering",
    "out_of_stock",
    "availability_pct",
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
    "availability_pct",
    ...GUEST_VOTE_FIELDS
  ],
  brews: [
    "id",
    "batch_name",
    "display_name",
    "style",
    "brew_date",
    "calculated_abv",
    "schedule",
    "status",
    "notes",
    "maker",
    "image_url",
    "display_image_url",
    "guest_description",
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
  "keeper_owns_image",
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

/**
 * Guest-safe bottle/keg fill gauge (0–100), snapped to existing fill/keg stops.
 * Derived on the server from Keeper quantities — never a passthrough of raw fields.
 *
 * Spirits follow open-bottle semantics: an empty open bottle with spare stock
 * projects as a full available bottle (same meaning as `openNextSpirit`), so
 * guests never see "empty / last pours" while `out_of_stock` is false.
 */
export function guestInventoryAvailabilityPct(
  table: string,
  row: Record<string, unknown>
): number | undefined {
  if (table === "spirits") {
    const openFill = nearestFillStop(row.fill_level);
    if (openFill > 0) return openFill;
    // Empty open bottle + spare(s) → patron can still be poured a full bottle.
    if (openNextSpirit(row)) return 100;
    return 0;
  }
  if (table === "taps") {
    if (isTapEmpty(row)) return 0;
    const remaining = Number(row.remaining_l ?? 0);
    const size = Number(row.keg_size_l || DEFAULT_KEG_L);
    return nearestKegStop(remaining, size);
  }
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
  const availabilityPct = guestInventoryAvailabilityPct(table, row);
  if (typeof availabilityPct === "number") {
    withAvailability.availability_pct = availabilityPct;
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

/**
 * Guest overview projection: keep the derived keg gauge (`remaining_pct`) and
 * strip exact pint counts. Keeper Mode retains the full snapshot.
 */
export function serializeOverviewForCaller<T extends {
  taps: { list: Array<Record<string, unknown> & { pints?: number; remaining_pct?: number }> };
}>(
  snap: T,
  options: { admin: boolean }
): T {
  if (options.admin) return snap;
  return {
    ...snap,
    taps: {
      ...snap.taps,
      list: snap.taps.list.map((tap) => {
        const { pints: _pints, ...rest } = tap;
        return rest;
      })
    }
  };
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
