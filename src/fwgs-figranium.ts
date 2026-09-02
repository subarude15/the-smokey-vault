/**
 * Fine Wine & Good Spirits adapter over the self-hosted Figranium instance.
 *
 * Saved tasks (defaults match fig.thesmokeybarrelbar.com):
 * - FWGS PLCB Product Resolver — plcbItem + pdpUrl → product JSON
 * - FWGS PLCB Image Extractor — plcbItem + pdpUrl → primary/label images
 */
import {
  figraniumRunTask,
  isFigraniumConfigured,
  type FigraniumExecutionResult
} from "./figranium.js";
import { parseVolumeMl } from "./cola_client.js";
import type { FwgsProduct } from "./fwgs.js";
import type { BottleCandidate, ProductField } from "./ingestion/candidate/types.js";

export const FWGS_SITE_ORIGIN = "https://www.finewineandgoodspirits.com";

/** Live Figranium task ids on fig.thesmokeybarrelbar.com (overridable via env). */
export const FWGS_FIGRANIUM_RESOLVER_TASK_ID_DEFAULT = "task_1788365630737";
export const FWGS_FIGRANIUM_IMAGE_TASK_ID_DEFAULT = "task_1788378025198";

export type FwgsFigraniumDiagnostics = {
  searchResultCount?: number | null;
  captchaSeen?: boolean;
  loginRequired?: boolean;
  selectorFailures?: string[];
  durationMs?: number | null;
};

export type FwgsFigraniumProduct = {
  matched: boolean;
  ambiguous: boolean;
  notFound: boolean;
  plcbItem: string;
  productUrl: string | null;
  name: string | null;
  brand: string | null;
  proof: number | null;
  abv: number | null;
  volumeText: string | null;
  category: string | null;
  subcategory: string | null;
  country: string | null;
  region: string | null;
  imageUrls: string[];
  primaryImageUrl: string | null;
  diagnostics?: FwgsFigraniumDiagnostics | null;
};

export type FwgsFigraniumImageResult = {
  matched: boolean;
  plcbItem: string;
  imageUrls: string[];
  primaryImageUrl: string | null;
  extractionSource?: string | null;
  candidateCount?: number;
  identityEvidence?: Record<string, unknown> | null;
  diagnostics?: FwgsFigraniumDiagnostics | null;
};

function trimEnv(value: string | undefined): string {
  return String(value ?? "").trim();
}

export function isFwgsFigraniumConfigured(): boolean {
  return isFigraniumConfigured();
}

export function getFwgsResolverTaskId(): string {
  return trimEnv(process.env.FIGRANIUM_FWGS_RESOLVER_TASK_ID) || FWGS_FIGRANIUM_RESOLVER_TASK_ID_DEFAULT;
}

export function getFwgsImageTaskId(): string {
  return trimEnv(process.env.FIGRANIUM_FWGS_IMAGE_TASK_ID) || FWGS_FIGRANIUM_IMAGE_TASK_ID_DEFAULT;
}

/** Canonical short PDP URL for a zero-padded PLCB item code. */
export function fwgsPdpUrlForItem(plcbItem: string): string {
  const code = normalizePlcbItem(plcbItem);
  return `${FWGS_SITE_ORIGIN}/product/${code}`;
}

export function normalizePlcbItem(plcbItem: string): string {
  const raw = String(plcbItem ?? "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits && /^\d+$/.test(digits)) return digits.padStart(9, "0");
  return raw;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const text = asString(entry);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function runSucceeded(result: FigraniumExecutionResult | null): boolean {
  if (!result) return false;
  if (result.outcome === "success") return true;
  if (result.success === true) return true;
  return false;
}

export function parseFwgsFigraniumProduct(
  data: unknown,
  fallbackPlcbItem = ""
): FwgsFigraniumProduct | null {
  const record = asRecord(data);
  if (!record) return null;
  const plcbItem = asString(record.plcbItem) || normalizePlcbItem(fallbackPlcbItem);
  const imageUrls = asStringList(record.imageUrls);
  const primaryImageUrl = asString(record.primaryImageUrl) || imageUrls[0] || null;
  return {
    matched: Boolean(record.matched),
    ambiguous: Boolean(record.ambiguous),
    notFound: Boolean(record.notFound),
    plcbItem,
    productUrl: asString(record.productUrl),
    name: asString(record.name),
    brand: asString(record.brand),
    proof: asNumber(record.proof),
    abv: asNumber(record.abv),
    volumeText: asString(record.volumeText),
    category: asString(record.category),
    subcategory: asString(record.subcategory),
    country: asString(record.country),
    region: asString(record.region),
    imageUrls,
    primaryImageUrl,
    diagnostics: asRecord(record.diagnostics) as FwgsFigraniumDiagnostics | null
  };
}

export function parseFwgsFigraniumImages(
  data: unknown,
  fallbackPlcbItem = ""
): FwgsFigraniumImageResult | null {
  const record = asRecord(data);
  if (!record) return null;
  const plcbItem = asString(record.plcbItem) || normalizePlcbItem(fallbackPlcbItem);
  const imageUrls = asStringList(record.imageUrls);
  const primaryImageUrl = asString(record.primaryImageUrl) || imageUrls[0] || null;
  return {
    matched: Boolean(record.matched) || Boolean(primaryImageUrl) || imageUrls.length > 0,
    plcbItem,
    imageUrls,
    primaryImageUrl,
    extractionSource: asString(record.extractionSource),
    candidateCount: asNumber(record.candidateCount) ?? imageUrls.length,
    identityEvidence: asRecord(record.identityEvidence),
    diagnostics: asRecord(record.diagnostics) as FwgsFigraniumDiagnostics | null
  };
}

/** Map a Figranium product hit into the existing FWGS lookup product shape. */
export function fwgsFigraniumProductToFwgs(hit: FwgsFigraniumProduct): FwgsProduct | null {
  if (!hit.matched || !hit.name?.trim()) return null;
  return {
    name: hit.name.trim(),
    brand: hit.brand?.trim() || "",
    volume_ml: hit.volumeText != null ? parseVolumeMl(hit.volumeText) : null,
    price: "",
    image_url: hit.primaryImageUrl
  };
}

/**
 * Resolve a PLCB item against Fine Wine & Good Spirits via Figranium.
 * `pdpUrl` defaults to `/product/{plcbItem}` when omitted.
 */
export async function resolveFwgsPlcbProduct(
  plcbItem: string,
  pdpUrl?: string | null
): Promise<FwgsFigraniumProduct | null> {
  const code = normalizePlcbItem(plcbItem);
  if (!code || !isFwgsFigraniumConfigured()) return null;
  const url = String(pdpUrl ?? "").trim() || fwgsPdpUrlForItem(code);
  const result = await figraniumRunTask<unknown>(getFwgsResolverTaskId(), {
    variables: { plcbItem: code, pdpUrl: url }
  });
  if (!runSucceeded(result)) return null;
  return parseFwgsFigraniumProduct(result?.data, code);
}

/** Extract FWGS PDP images for a known PLCB item via Figranium. */
export async function extractFwgsPlcbImages(
  plcbItem: string,
  pdpUrl?: string | null
): Promise<FwgsFigraniumImageResult | null> {
  const code = normalizePlcbItem(plcbItem);
  if (!code || !isFwgsFigraniumConfigured()) return null;
  const url = String(pdpUrl ?? "").trim() || fwgsPdpUrlForItem(code);
  const result = await figraniumRunTask<unknown>(getFwgsImageTaskId(), {
    variables: { plcbItem: code, pdpUrl: url }
  });
  if (!runSucceeded(result)) return null;
  return parseFwgsFigraniumImages(result?.data, code);
}

/**
 * Resolve product metadata, then fill missing images from the image extractor.
 */
export async function resolveFwgsPlcbProductWithImages(
  plcbItem: string,
  pdpUrl?: string | null
): Promise<FwgsFigraniumProduct | null> {
  const product = await resolveFwgsPlcbProduct(plcbItem, pdpUrl);
  if (!product?.matched) return product;
  if (product.primaryImageUrl || product.imageUrls.length > 0) return product;

  const images = await extractFwgsPlcbImages(
    product.plcbItem || plcbItem,
    product.productUrl || pdpUrl
  );
  if (!images?.matched) return product;
  return {
    ...product,
    imageUrls: images.imageUrls,
    primaryImageUrl: images.primaryImageUrl
  };
}

function fieldPlcbItem(field: ProductField<unknown> | undefined): string | null {
  if (!field) return null;
  if (
    (field.source === "plcb_spirits" || field.source === "plcb_wines")
    && field.sourceItemId
  ) {
    return normalizePlcbItem(String(field.sourceItemId));
  }
  for (const evidence of field.contributors ?? []) {
    if (
      (evidence.source === "plcb_spirits" || evidence.source === "plcb_wines")
      && evidence.sourceItemId
    ) {
      return normalizePlcbItem(String(evidence.sourceItemId));
    }
  }
  return null;
}

/** Prefer PLCB item codes already attached to government-catalog provenance. */
export function plcbItemFromCandidate(candidate: BottleCandidate): string | null {
  const fields: Array<ProductField<unknown> | undefined> = [
    candidate.name,
    candidate.brand,
    candidate.upc,
    candidate.proof,
    candidate.abv,
    candidate.volume_ml,
    candidate.origin,
    candidate.category,
    candidate.product_type,
    candidate.ttb_id
  ];
  for (const field of fields) {
    const item = fieldPlcbItem(field);
    if (item) return item;
  }
  return null;
}
