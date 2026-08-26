import { spiritFamilyFromLabel } from "./catalog.js";

export const COLA_API_BASE = "https://app.colacloud.us/api/v1";
export const CACHE_TTL_SECONDS = 86400 * 30;
export const COLA_BURST_LIMIT = Number(process.env.COLA_BURST_LIMIT ?? 10);

const lastRequests: number[] = [];
let lastQuota: ColaQuota | null = null;
let colaPausedUntil = 0;

export class ColaQuotaError extends Error {
  readonly code = "quota" as const;
  constructor(message = "Lookup paused", readonly status = 429) {
    super(message);
    this.name = "ColaQuotaError";
  }
}

export type ColaQuota = {
  detail_views_remaining: string | null;
  detail_views_limit: string | null;
  list_records_remaining: string | null;
  list_records_limit: string | null;
  quota_reset: string | null;
};

export type ColaSummary = {
  ttb_id?: string;
  brand_name?: string;
  product_name?: string;
  product_type?: string;
  class_type_code?: string;
  class_type_name?: string;
  origin_name?: string;
  permit_number?: string;
  approval_date?: string;
  status?: string;
  image_count?: number;
  has_barcode?: boolean;
  derived_category?: string;
  derived_subcategory?: string;
};

export type ColaDetail = ColaSummary & {
  ocr_abv?: string | number | null;
  ocr_volume?: string | null;
  images?: Array<{ image_type?: string; image_url?: string }>;
  barcodes?: Array<{ barcode_type?: string; barcode_value?: string }>;
};

export type ProductSchema = {
  upc: string;
  name: string;
  brand: string;
  category: string;
  abv: number | null;
  image_url: string | null;
  fill_level_percent: number;
  bottle_count: number;
  notes: string | null;
  volume_ml: number | null;
  product_type: string | null;
  ttb_id: string | null;
  origin: string | null;
  approval_date: string | null;
};

export function getColaApiKey() {
  return process.env.COLA_API_KEY?.trim() || process.env.COLACLOUD_API_KEY?.trim() || "";
}

export function isColaConfigured() {
  return Boolean(getColaApiKey());
}

export function getLastQuota() {
  return lastQuota;
}

export function isColaPaused() {
  return Date.now() < colaPausedUntil;
}

export function pauseCola(ms = 60_000) {
  colaPausedUntil = Math.max(colaPausedUntil, Date.now() + Math.max(0, ms));
}

export function resetColaBurst() {
  lastRequests.length = 0;
  colaPausedUntil = 0;
  lastQuota = null;
}

export function isColaQuotaError(error: unknown): error is ColaQuotaError {
  return error instanceof ColaQuotaError;
}

function captureQuota(headers: Headers) {
  lastQuota = {
    detail_views_remaining: headers.get("X-Detail-Views-Remaining"),
    detail_views_limit: headers.get("X-Detail-Views-Limit"),
    list_records_remaining: headers.get("X-List-Records-Remaining"),
    list_records_limit: headers.get("X-List-Records-Limit"),
    quota_reset: headers.get("X-Quota-Reset")
  };
  return lastQuota;
}

async function rateLimit(waitOnBurst: boolean) {
  if (isColaPaused()) throw new ColaQuotaError();
  const now = Date.now();
  const cutoff = now - 60_000;
  while (lastRequests.length && lastRequests[0]! < cutoff) lastRequests.shift();
  if (lastRequests.length >= COLA_BURST_LIMIT) {
    const sleepMs = 60_000 - (now - lastRequests[0]!) + 1000;
    if (!waitOnBurst) {
      pauseCola(Math.max(1_000, sleepMs));
      throw new ColaQuotaError();
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, sleepMs)));
  }
  lastRequests.push(Date.now());
}

type ColaFetchOptions = {
  waitOnBurst?: boolean;
};

async function colaFetch(path: string, params?: Record<string, string>, options?: ColaFetchOptions) {
  const apiKey = getColaApiKey();
  if (!apiKey) throw new Error("COLA_API_KEY is not configured");
  await rateLimit(options?.waitOnBurst === true);
  const url = new URL(`${COLA_API_BASE}${path}`);
  if (params) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { "X-API-Key": apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000)
  });
  captureQuota(response.headers);
  const listRemaining = lastQuota?.list_records_remaining;
  if (listRemaining === "0") pauseCola(60_000);
  if (response.status === 429) {
    pauseCola(60_000);
    throw new ColaQuotaError("Lookup paused", 429);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`COLA Cloud ${response.status}: ${body.slice(0, 200) || response.statusText}`);
  }
  return response.json();
}

/** GS1 check digit over the first 11 UPC-A digits (odd positions ×3, 1-based). */
export function upcCheckDigit(digits: string) {
  const body = String(digits ?? "").replace(/\D/g, "").slice(0, 11).padStart(11, "0");
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    const n = Number(body[i]);
    sum += i % 2 === 0 ? n * 3 : n;
  }
  return String((10 - (sum % 10)) % 10);
}

/**
 * Expands UPC-E (6–8 digits) to UPC-A. Eight-digit form is NS + 6 compact digits + check.
 * Six-digit form assumes number system 0.
 */
export function expandUpcE(raw: string): string {
  const cleaned = String(raw ?? "").replace(/\D/g, "");
  if (cleaned.length < 6 || cleaned.length > 8) return "";
  const ns = cleaned.length === 8 || cleaned.length === 7 ? cleaned[0]! : "0";
  const compact = cleaned.length === 8
    ? cleaned.slice(1, 7)
    : cleaned.length === 7
      ? cleaned.slice(1)
      : cleaned;
  if (compact.length !== 6 || !/^[01]$/.test(ns)) return "";
  const last = compact[5]!;
  let manufacturer: string;
  let product: string;
  if (last === "0" || last === "1" || last === "2") {
    manufacturer = compact.slice(0, 2) + last;
    product = `0000${compact.slice(2, 5)}`;
  } else if (last === "3") {
    manufacturer = compact.slice(0, 3);
    product = `00000${compact.slice(3, 5)}`;
  } else if (last === "4") {
    manufacturer = compact.slice(0, 4);
    product = `00000${compact[4]!}`;
  } else {
    manufacturer = compact.slice(0, 5);
    product = `0000${last}`;
  }
  const eleven = `${ns}${manufacturer}${product}`;
  if (eleven.length !== 11) return "";
  return eleven + upcCheckDigit(eleven);
}

export function looksLikeBarcode(raw: string) {
  const cleaned = String(raw ?? "").replace(/\D/g, "");
  return cleaned.length >= 6 && cleaned.length <= 14;
}

export function upcAForm(raw: string) {
  const normalized = normalizeUpc(raw);
  if (!normalized) return "";
  if (normalized.length === 13 && normalized.startsWith("0")) return normalized.slice(1);
  if (normalized.length === 12) return normalized;
  return normalized.padStart(12, "0").slice(-12);
}

export function ean13Form(raw: string) {
  const upcA = upcAForm(raw);
  if (!upcA) return "";
  if (upcA.length === 13) return upcA;
  return `0${upcA}`.slice(-13);
}

/** One catalog key: UPC-A when the EAN-13 is a leading-zero twin, otherwise the normalized code. */
export function primaryCatalogUpc(raw: string) {
  const normalized = normalizeUpc(raw);
  if (!normalized) return "";
  if (normalized.length === 13 && normalized.startsWith("0")) return normalized.slice(1);
  return normalized;
}

export function normalizeUpc(raw: string) {
  const cleaned = String(raw ?? "").replace(/\D/g, "");
  if (!cleaned) return "";
  if (cleaned.length === 6 || cleaned.length === 7 || cleaned.length === 8) {
    return expandUpcE(cleaned);
  }
  if (cleaned.length === 13) return cleaned;
  if (cleaned.length === 14 && cleaned.startsWith("0")) return cleaned.slice(1);
  return cleaned.padStart(12, "0").slice(-12);
}

export function normalizeAbv(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const match = String(raw).match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const value = Number.parseFloat(match[1]!);
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

export function parseVolumeMl(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const text = String(raw).toLowerCase().replace(/\s+/g, "");
  const ml = text.match(/(\d+(?:\.\d+)?)\s*ml/);
  if (ml) return Math.round(Number.parseFloat(ml[1]!));
  const l = text.match(/(\d+(?:\.\d+)?)\s*l(?![a-z])/);
  if (l) return Math.round(Number.parseFloat(l[1]!) * 1000);
  const oz = text.match(/(\d+(?:\.\d+)?)\s*(?:fl)?oz/);
  if (oz) return Math.round(Number.parseFloat(oz[1]!) * 29.5735);
  return null;
}

function leafCategory(value?: string | null) {
  if (!value) return null;
  const parts = value.split(">");
  return (parts.length > 1 ? parts.at(-1) : value)?.trim() || null;
}

export function normalizeCategory(summary: ColaSummary, detail?: ColaDetail | null) {
  const derived = leafCategory(detail?.derived_subcategory) || leafCategory(summary.derived_subcategory)
    || leafCategory(detail?.derived_category) || leafCategory(summary.derived_category);
  if (derived) return derived;
  if (summary.class_type_name) return summary.class_type_name.trim().replace(/\b\w/g, (c) => c.toUpperCase());
  if (summary.product_type) {
    const mapping: Record<string, string> = {
      "DISTILLED SPIRITS": "Spirits",
      WINE: "Wine",
      "MALT BEVERAGES": "Beer",
      "MALT BEVERAGE": "Beer"
    };
    return mapping[summary.product_type.toUpperCase()] ?? summary.product_type;
  }
  return null;
}

export function buildNotes(summary: ColaSummary, detail?: ColaDetail | null) {
  const parts: string[] = [];
  const origin = detail?.origin_name || summary.origin_name;
  if (origin) parts.push(`Origin: ${origin}`);
  if (detail?.ocr_volume) parts.push(`Volume: ${detail.ocr_volume}`);
  if (summary.approval_date) parts.push(`Approved: ${summary.approval_date}`);
  return parts.length ? parts.join(" | ") : null;
}

function preferImageUrl(detail?: ColaDetail | null) {
  const images = detail?.images?.filter((image) => image.image_url) ?? [];
  if (!images.length) return null;
  const front = images.find((image) => /front/i.test(image.image_type ?? ""));
  return front?.image_url ?? images[0]?.image_url ?? null;
}

export function mapColaToSchema(upc: string, summary: ColaSummary, detail?: ColaDetail | null): ProductSchema {
  return {
    upc: normalizeUpc(upc),
    name: summary.product_name || summary.brand_name || "Unknown",
    brand: summary.brand_name || "",
    category: normalizeCategory(summary, detail) || "Spirits",
    abv: detail ? normalizeAbv(detail.ocr_abv) : null,
    image_url: preferImageUrl(detail),
    fill_level_percent: 100,
    bottle_count: 1,
    notes: buildNotes(summary, detail),
    volume_ml: detail ? parseVolumeMl(detail.ocr_volume) : null,
    product_type: summary.product_type || detail?.product_type || null,
    ttb_id: summary.ttb_id || detail?.ttb_id || null,
    origin: detail?.origin_name || summary.origin_name || null,
    approval_date: summary.approval_date || detail?.approval_date || null
  };
}

/** Inventory-facing fields used by the existing scan review form. */
export function productToInventoryFields(product: ProductSchema) {
  const mapped = spiritFamilyFromLabel(product.category);
  return {
    upc: product.upc,
    name: product.name,
    brand: product.brand,
    category: mapped.family,
    sub_category: mapped.type,
    abv: product.abv ?? 0,
    image_url: product.image_url ?? "",
    notes: product.notes ?? "",
    fill_level: product.fill_level_percent,
    stock_count: product.bottle_count,
    volume_ml: product.volume_ml ?? 750,
    product_name: product.name,
    brands: product.brand,
    categories: product.category,
    product_type: product.product_type,
    ttb_id: product.ttb_id,
    origin: product.origin,
    approval_date: product.approval_date
  };
}

export function barcodeVariants(raw: string): string[] {
  const cleaned = String(raw ?? "").replace(/\D/g, "");
  if (!cleaned) return [];
  const variants = new Set<string>();
  variants.add(cleaned);
  variants.add(cleaned.replace(/^0+/, "") || cleaned);
  const normalized = normalizeUpc(cleaned);
  if (normalized) variants.add(normalized);
  const upcA = upcAForm(cleaned);
  const ean13 = ean13Form(cleaned);
  if (upcA) variants.add(upcA);
  if (ean13) variants.add(ean13);
  variants.add(cleaned.padStart(12, "0").slice(-12));
  variants.add(cleaned.padStart(13, "0").slice(-13));
  if (cleaned.length === 12) variants.add(`0${cleaned}`);
  if (cleaned.length === 13 && cleaned.startsWith("0")) variants.add(cleaned.slice(1));
  if (cleaned.length === 6 || cleaned.length === 7 || cleaned.length === 8) {
    const expanded = expandUpcE(cleaned);
    if (expanded) variants.add(expanded);
  }
  return [...variants].filter(Boolean);
}

/**
 * One network attempt per UPC. Variants are resolved in memory first; the
 * dedicated barcode endpoint is preferred so a live scan cannot burn Free-tier
 * burst (10/min) by looping UPC-A/EAN-13 twins.
 */
export async function searchByBarcode(
  upc: string,
  options?: ColaFetchOptions
): Promise<ColaSummary | null> {
  const code = primaryCatalogUpc(upc);
  if (!code) return null;
  try {
    const payload = await colaFetch(`/barcode/${encodeURIComponent(code)}`, undefined, options) as {
      data?: Array<ColaSummary & { cola?: ColaSummary }>;
    };
    const first = payload.data?.[0];
    if (!first) return null;
    if (first.ttb_id || first.product_name || first.brand_name) return first;
    return first.cola ?? null;
  } catch (error) {
    if (error instanceof ColaQuotaError) throw error;
    return null;
  }
}

export async function searchColasByQuery(
  query: string,
  perPage = 8,
  options?: { productType?: string }
): Promise<ColaSummary[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const params: Record<string, string> = {
    q,
    per_page: String(Math.min(perPage, 20)),
    approval_date_from: "2005-01-01"
  };
  if (options?.productType) params.product_type = options.productType;
  const data = await colaFetch("/colas", params, { waitOnBurst: true }) as { data?: ColaSummary[] };
  return data.data ?? [];
}

export async function getColaDetail(ttbId: string): Promise<ColaDetail | null> {
  if (lastQuota?.detail_views_remaining === "0") {
    throw new ColaQuotaError("Lookup paused", 429);
  }
  const data = await colaFetch(`/colas/${encodeURIComponent(ttbId)}`, undefined, { waitOnBurst: true }) as ColaDetail | { data?: ColaDetail };
  if (data && typeof data === "object" && "ttb_id" in data) return data as ColaDetail;
  if (data && typeof data === "object" && "data" in data) return (data as { data?: ColaDetail }).data ?? null;
  return null;
}

export function mapToSpiritCategory(raw?: string | null) {
  return spiritFamilyFromLabel(raw ?? "").family;
}

export function mapToSpiritType(raw?: string | null) {
  return spiritFamilyFromLabel(raw ?? "").type;
}

export async function fetchColaQuota(): Promise<ColaQuota & { tier?: string; configured: boolean; source: string }> {
  if (!isColaConfigured()) {
    return {
      configured: false,
      source: "unconfigured",
      detail_views_remaining: null,
      detail_views_limit: null,
      list_records_remaining: null,
      list_records_limit: null,
      quota_reset: null
    };
  }
  try {
    const payload = await colaFetch("/usage") as {
      data?: {
        tier?: string;
        detail_views?: { remaining?: number; limit?: number };
        list_records?: { remaining?: number; limit?: number };
      };
    };
    const usage = payload.data;
    return {
      configured: true,
      source: "usage",
      tier: usage?.tier,
      detail_views_remaining: usage?.detail_views?.remaining != null ? String(usage.detail_views.remaining) : lastQuota?.detail_views_remaining ?? null,
      detail_views_limit: usage?.detail_views?.limit != null ? String(usage.detail_views.limit) : lastQuota?.detail_views_limit ?? null,
      list_records_remaining: usage?.list_records?.remaining != null ? String(usage.list_records.remaining) : lastQuota?.list_records_remaining ?? null,
      list_records_limit: usage?.list_records?.limit != null ? String(usage.list_records.limit) : lastQuota?.list_records_limit ?? null,
      quota_reset: lastQuota?.quota_reset ?? null
    };
  } catch {
    if (lastQuota) return { ...lastQuota, configured: true, source: "headers" };
    throw new Error("Unable to read COLA Cloud quota");
  }
}
