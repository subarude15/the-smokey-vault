/**
 * Fine Wine & Good Spirits image adapter over self-hosted Figranium.
 *
 * Image-first: extracts + validates FWGS product image URLs for a known PLCB item.
 * Requires FIGRANIUM_BASE_URL, FIGRANIUM_API_KEY, and FIGRANIUM_FWGS_IMAGE_TASK_ID
 * (resolver task ID is optional and only used by resolveFwgsPlcbProduct).
 */
import { z } from "zod";
import {
  figraniumRunTask,
  isFigraniumConfigured,
  type FigraniumRunResult
} from "./figranium.js";
import { parseVolumeMl } from "./cola_client.js";
import type { FwgsProduct } from "./fwgs.js";
import type { BottleCandidate, ProductField } from "./ingestion/candidate/types.js";

export const FWGS_SITE_ORIGIN = "https://www.finewineandgoodspirits.com";
export const FWGS_SITE_HOST = "www.finewineandgoodspirits.com";

const FwgsFigraniumDiagnosticsSchema = z
  .object({
    searchResultCount: z.number().nullable().optional(),
    captchaSeen: z.boolean().optional(),
    loginRequired: z.boolean().optional(),
    selectorFailures: z.array(z.string()).optional(),
    durationMs: z.number().nullable().optional()
  })
  .passthrough();

export const FwgsFigraniumProductSchema = z.object({
  matched: z.boolean(),
  ambiguous: z.boolean(),
  notFound: z.boolean(),
  plcbItem: z.string(),
  productUrl: z.string().nullable(),
  name: z.string().nullable(),
  brand: z.string().nullable(),
  proof: z.number().nullable(),
  abv: z.number().nullable(),
  volumeText: z.string().nullable(),
  category: z.string().nullable(),
  subcategory: z.string().nullable(),
  country: z.string().nullable(),
  region: z.string().nullable(),
  imageUrls: z.array(z.string()),
  primaryImageUrl: z.string().nullable(),
  diagnostics: FwgsFigraniumDiagnosticsSchema.nullable().optional()
});

export const FwgsFigraniumImageResultSchema = z.object({
  matched: z.boolean(),
  plcbItem: z.string(),
  imageUrls: z.array(z.string()),
  primaryImageUrl: z.string().nullable(),
  extractionSource: z.string().nullable().optional(),
  candidateCount: z.number().optional(),
  identityEvidence: z.record(z.string(), z.unknown()).nullable().optional(),
  diagnostics: FwgsFigraniumDiagnosticsSchema.nullable().optional()
});

export type FwgsFigraniumDiagnostics = z.infer<typeof FwgsFigraniumDiagnosticsSchema>;
export type FwgsFigraniumProduct = z.infer<typeof FwgsFigraniumProductSchema>;
export type FwgsFigraniumImageResult = z.infer<typeof FwgsFigraniumImageResultSchema>;

function trimEnv(value: string | undefined): string {
  return String(value ?? "").trim();
}

export function getFwgsResolverTaskId(): string {
  return trimEnv(process.env.FIGRANIUM_FWGS_RESOLVER_TASK_ID);
}

export function getFwgsImageTaskId(): string {
  return trimEnv(process.env.FIGRANIUM_FWGS_IMAGE_TASK_ID);
}

/**
 * FWGS Figranium image path is enabled only when base URL, API key,
 * and the image task ID are all configured (no implicit production defaults).
 */
export function isFwgsFigraniumConfigured(): boolean {
  return isFigraniumConfigured() && Boolean(getFwgsImageTaskId());
}

/**
 * Accept only digit-only PLCB codes after trim.
 * Pads numeric codes to 9 digits. Rejects mixed text and >9-digit values.
 */
export function normalizePlcbItem(plcbItem: string): string {
  const raw = String(plcbItem ?? "").trim();
  if (!raw) return "";
  if (!/^\d+$/.test(raw)) return "";
  // PLCB item codes are at most 9 digits when canonical; reject longer digit strings.
  if (raw.length > 9) return "";
  return raw.padStart(9, "0");
}

/**
 * Bind a Figranium-returned PLCB code to the originally requested item.
 * Both sides are normalized with digit-only rules; mismatch → false.
 */
export function validateReturnedPlcbItem(requested: string, returned: string): boolean {
  const requestedCode = normalizePlcbItem(requested);
  const returnedCode = normalizePlcbItem(returned);
  if (!requestedCode || !returnedCode) return false;
  return requestedCode === returnedCode;
}

/** Canonical short PDP URL for a zero-padded PLCB item code. */
export function fwgsPdpUrlForItem(plcbItem: string): string {
  const code = normalizePlcbItem(plcbItem);
  if (!code) return "";
  return `${FWGS_SITE_ORIGIN}/product/${code}`;
}

/**
 * Strict FWGS product-image URL gate.
 * Accepts only https://www.finewineandgoodspirits.com assets whose path/query
 * resolves to `/products/{PLCB}_...` or `/products/{PLCB}.ext` with a
 * structurally bounded PLCB match (not a substring).
 */
export function validateFwgsImageUrl(url: string, plcbItem: string): boolean {
  const code = normalizePlcbItem(plcbItem);
  if (!code) return false;
  const raw = String(url ?? "").trim();
  if (!raw) return false;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname !== FWGS_SITE_HOST) return false;

  const candidates: string[] = [parsed.pathname];
  const source = parsed.searchParams.get("source");
  if (source) {
    candidates.push(source);
    try {
      candidates.push(decodeURIComponent(source));
    } catch {
      // keep undecoded source only
    }
  }

  // Bounded: /products/{PLCB}_... or /products/{PLCB}.ext (optional query after)
  const productAsset = new RegExp(
    String.raw`(?:^|/)products/${code}(?:_[A-Za-z0-9._-]+)?\.(?:jpe?g|png|webp)(?:$|[?#])`,
    "i"
  );

  for (const candidate of candidates) {
    const pathOnly = candidate.split("?")[0] ?? candidate;
    if (productAsset.test(pathOnly) || productAsset.test(candidate)) return true;
  }
  return false;
}

export function filterValidatedFwgsImageUrls(
  urls: Iterable<string | null | undefined>,
  plcbItem: string
): string[] {
  const out: string[] = [];
  for (const entry of urls) {
    const text = String(entry ?? "").trim();
    if (!text || out.includes(text)) continue;
    if (validateFwgsImageUrl(text, plcbItem)) out.push(text);
  }
  return out;
}

/**
 * Parse a product resolver payload and bind it to the requested PLCB item.
 * Rejects when the returned `plcbItem` does not equal the requested code.
 */
export function parseFwgsFigraniumProduct(
  data: unknown,
  requestedPlcbItem: string
): FwgsFigraniumProduct | null {
  const requested = normalizePlcbItem(requestedPlcbItem);
  if (!requested) return null;
  const parsed = FwgsFigraniumProductSchema.safeParse(data);
  if (!parsed.success) return null;
  const hit = parsed.data;
  if (!validateReturnedPlcbItem(requested, hit.plcbItem)) return null;

  const imageUrls = filterValidatedFwgsImageUrls(hit.imageUrls, requested);
  const primary =
    hit.primaryImageUrl && validateFwgsImageUrl(hit.primaryImageUrl, requested)
      ? hit.primaryImageUrl
      : imageUrls[0] ?? null;

  return {
    ...hit,
    plcbItem: requested,
    imageUrls,
    primaryImageUrl: primary
  };
}

/**
 * Parse an image extractor payload and bind it to the requested PLCB item.
 * Image URLs are always validated against the requested code — never the returned one.
 */
export function parseFwgsFigraniumImages(
  data: unknown,
  requestedPlcbItem: string
): FwgsFigraniumImageResult | null {
  const requested = normalizePlcbItem(requestedPlcbItem);
  if (!requested) return null;
  const parsed = FwgsFigraniumImageResultSchema.safeParse(data);
  if (!parsed.success) return null;
  const hit = parsed.data;
  if (!validateReturnedPlcbItem(requested, hit.plcbItem)) return null;

  const imageUrls = filterValidatedFwgsImageUrls(hit.imageUrls, requested);
  const primary =
    hit.primaryImageUrl && validateFwgsImageUrl(hit.primaryImageUrl, requested)
      ? hit.primaryImageUrl
      : imageUrls[0] ?? null;

  return {
    ...hit,
    plcbItem: requested,
    matched: Boolean(hit.matched) && (Boolean(primary) || imageUrls.length > 0),
    imageUrls,
    primaryImageUrl: primary
  };
}

/** Map a Figranium product hit into the existing FWGS lookup product shape. */
export function fwgsFigraniumProductToFwgs(hit: FwgsFigraniumProduct): FwgsProduct | null {
  if (!hit.matched || !hit.name?.trim()) return null;
  const primary =
    hit.primaryImageUrl && validateFwgsImageUrl(hit.primaryImageUrl, hit.plcbItem)
      ? hit.primaryImageUrl
      : filterValidatedFwgsImageUrls(hit.imageUrls, hit.plcbItem)[0] ?? null;
  return {
    name: hit.name.trim(),
    brand: hit.brand?.trim() || "",
    volume_ml: hit.volumeText != null ? parseVolumeMl(hit.volumeText) : null,
    price: "",
    image_url: primary
  };
}

function figraniumFailureNull(
  result: FigraniumRunResult<unknown>
): null {
  void result;
  return null;
}

/**
 * Resolve a PLCB item against Fine Wine & Good Spirits via Figranium.
 * Requires FIGRANIUM_FWGS_RESOLVER_TASK_ID in addition to base Figranium config.
 */
export async function resolveFwgsPlcbProduct(
  plcbItem: string,
  pdpUrl?: string | null
): Promise<FwgsFigraniumProduct | null> {
  const code = normalizePlcbItem(plcbItem);
  const taskId = getFwgsResolverTaskId();
  if (!code || !isFigraniumConfigured() || !taskId) return null;
  const url = String(pdpUrl ?? "").trim() || fwgsPdpUrlForItem(code);
  const result = await figraniumRunTask(taskId, {
    variables: { plcbItem: code, pdpUrl: url },
    schema: FwgsFigraniumProductSchema
  });
  if (result.kind !== "success") return figraniumFailureNull(result);
  return parseFwgsFigraniumProduct(result.data, code);
}

/** Extract FWGS PDP images for a known PLCB item via Figranium (image-first path). */
export async function extractFwgsPlcbImages(
  plcbItem: string,
  pdpUrl?: string | null
): Promise<FwgsFigraniumImageResult | null> {
  const code = normalizePlcbItem(plcbItem);
  if (!code || !isFwgsFigraniumConfigured()) return null;
  const url = String(pdpUrl ?? "").trim() || fwgsPdpUrlForItem(code);
  const result = await figraniumRunTask(getFwgsImageTaskId(), {
    variables: { plcbItem: code, pdpUrl: url },
    schema: FwgsFigraniumImageResultSchema
  });
  if (result.kind !== "success") return figraniumFailureNull(result);
  return parseFwgsFigraniumImages(result.data, code);
}

/**
 * Image-first helper: resolve product only to fill missing images.
 * Does not merge metadata into vault candidates.
 */
export async function resolveFwgsPlcbProductWithImages(
  plcbItem: string,
  pdpUrl?: string | null
): Promise<FwgsFigraniumProduct | null> {
  const requested = normalizePlcbItem(plcbItem);
  if (!requested) return null;

  const product = await resolveFwgsPlcbProduct(requested, pdpUrl);
  if (!product?.matched) return product;

  const validatedFromProduct = filterValidatedFwgsImageUrls(
    [product.primaryImageUrl, ...product.imageUrls],
    requested
  );
  if (validatedFromProduct.length > 0) {
    return {
      ...product,
      plcbItem: requested,
      imageUrls: validatedFromProduct,
      primaryImageUrl: validatedFromProduct[0] ?? null
    };
  }

  const images = await extractFwgsPlcbImages(requested, product.productUrl || pdpUrl);
  if (!images?.matched) {
    return { ...product, plcbItem: requested, imageUrls: [], primaryImageUrl: null };
  }
  return {
    ...product,
    plcbItem: requested,
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
    const item = normalizePlcbItem(String(field.sourceItemId));
    return item || null;
  }
  for (const evidence of field.contributors ?? []) {
    if (
      (evidence.source === "plcb_spirits" || evidence.source === "plcb_wines")
      && evidence.sourceItemId
    ) {
      const item = normalizePlcbItem(String(evidence.sourceItemId));
      if (item) return item;
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
