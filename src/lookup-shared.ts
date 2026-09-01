export const LOOKUP_SOURCES = [
  "vault",
  "cache",
  "beer_cache",
  "plcb_spirits",
  "plcb_wines",
  "iowa",
  "fwgs",
  "cola_cloud",
  "catalog_beer",
  "openfoodfacts",
  "upcitemdb",
  "label",
  "not_found"
] as const;

export type LookupSource = (typeof LOOKUP_SOURCES)[number];

export const MISS_REASONS = ["invalid", "quota", "variant", "cola_gap", "no_catalog"] as const;
export type MissReason = (typeof MISS_REASONS)[number];

export const IMPORT_KINDS = ["spirits", "wines", "beer", "mixers"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const IMPORT_ROW_STATUSES = ["pending", "ready", "needs_review", "skipped"] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

export const IMPORT_TABLES = ["spirits", "packaged_beer", "wines"] as const;
export type ImportTable = (typeof IMPORT_TABLES)[number];

export const MISS_REASON_LABELS: Record<MissReason, string> = {
  invalid: "Not a barcode",
  quota: "Lookup paused",
  variant: "Code format",
  cola_gap: "Not in TTB",
  no_catalog: "No catalog match"
};

export const LOOKUP_SOURCE_LABELS: Record<LookupSource, string> = {
  vault: "Vault",
  cache: "Cache",
  beer_cache: "Cache",
  plcb_spirits: "PA Spirits",
  plcb_wines: "PA Wines",
  iowa: "Iowa",
  fwgs: "FWGS",
  cola_cloud: "COLA",
  catalog_beer: "Catalog",
  openfoodfacts: "Catalog",
  upcitemdb: "Catalog",
  label: "Label",
  not_found: "Not found"
};

export const IMPORT_KIND_LABELS: Record<ImportKind, string> = {
  spirits: "Spirits",
  wines: "Wine",
  beer: "Beer",
  mixers: "Mixers"
};

export type LookupQuota = {
  detail_views_remaining: string | null;
  detail_views_limit: string | null;
  list_records_remaining: string | null;
  list_records_limit: string | null;
  quota_reset: string | null;
};

export type LookupVariants = {
  upcA: string;
  ean13: string;
};

export type LookupResult = {
  source: LookupSource;
  upc: string;
  table?: ImportTable;
  kind?: ImportKind;
  product: Record<string, unknown> | null;
  reason?: MissReason;
  message?: string;
  quota?: LookupQuota;
  variants?: LookupVariants;
  suggestions?: Array<{
    source: "catalog_beer" | "beer_cache" | "vault" | "cola_cloud";
    table: ImportTable | "brews";
    catalog_beer_id?: string | null;
    ttb_id?: string | null;
    product: Record<string, unknown>;
  }>;
};

export type ImportQueueRow = {
  id: number;
  upc: string;
  kind: ImportKind;
  table: ImportTable;
  status: ImportRowStatus;
  reason: MissReason | null;
  source: LookupSource;
  product: Record<string, unknown>;
  message: string;
  variants: LookupVariants | null;
  created_at: string;
  updated_at: string;
};

export function isMissReason(value: string): value is MissReason {
  return (MISS_REASONS as readonly string[]).includes(value);
}

export function isLookupSource(value: string): value is LookupSource {
  return (LOOKUP_SOURCES as readonly string[]).includes(value);
}

export function isImportKind(value: string): value is ImportKind {
  return (IMPORT_KINDS as readonly string[]).includes(value);
}

export function missMessage(reason: MissReason, upc = "", variants?: LookupVariants): string {
  if (reason === "invalid") return "Not a barcode. Rescan only.";
  if (reason === "quota") return "Lookup paused. COLA is holding — other catalogs still ran.";
  if (reason === "variant") {
    const upcA = variants?.upcA || upc;
    const ean13 = variants?.ean13 || (upcA.length === 12 ? `0${upcA}` : upcA);
    return `Code format. Try UPC-A ${upcA} or EAN-13 ${ean13}.`;
  }
  if (reason === "cola_gap") return "Not in TTB.";
  return "No catalog match.";
}

export function lookupHasName(product: Record<string, unknown> | null | undefined): boolean {
  if (!product) return false;
  return Boolean(String(product.name ?? product.product_name ?? product.product_name_en ?? "").trim());
}

/** Overnight and live hits without a photo still count as Ready. */
export function isReadyLookup(result: Pick<LookupResult, "source" | "reason" | "product">): boolean {
  return !result.reason && result.source !== "not_found" && lookupHasName(result.product);
}
