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
import { IMAGE_DOWNLOAD_MAX_BYTES, sniffImageType } from "./images.js";
import { readImageDimensionsFromHeader } from "./ingestion/enrichment/image-dimensions.js";
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

/** Payload from the dedicated FWGS PLCB Image Fetcher Figranium task. */
export const FwgsFigraniumImageFetchResultSchema = z.object({
  matched: z.boolean(),
  plcbItem: z.string(),
  sourceUrl: z.string(),
  contentType: z.string(),
  byteLength: z.number().int().nonnegative(),
  base64: z.string().min(1)
});

export type FwgsFigraniumImageFetchResult = z.infer<typeof FwgsFigraniumImageFetchResultSchema>;

export type FwgsFigraniumFetchedImage = {
  plcbItem: string;
  sourceUrl: string;
  contentType: string;
  bytes: Buffer;
  width: number | null;
  height: number | null;
};

export type FwgsImageFetchFailureReason =
  | "not_configured"
  | "invalid_request"
  | "invalid_url"
  | "plcb_mismatch"
  | "figranium_error"
  | "invalid_payload"
  | "oversized"
  | "non_image"
  | "malformed_base64"
  | "empty_payload";

export type FwgsImageFetchOutcome =
  | { ok: true; image: FwgsFigraniumFetchedImage }
  | { ok: false; reason: FwgsImageFetchFailureReason };

/** Provider/system failures distinct from legitimate "no FWGS image". */
export type FwgsFigraniumProviderFailureKind =
  | "auth_error"
  | "retryable_error"
  | "invalid_response";

/**
 * Thrown when Figranium was expected to run (configured) but the provider
 * failed. Callers must not treat this as "no image found".
 * Never carries secrets, cookies, raw HTML, or unbounded payloads.
 */
export class FwgsFigraniumProviderError extends Error {
  readonly kind: FwgsFigraniumProviderFailureKind;
  readonly httpStatus?: number;

  constructor(
    kind: FwgsFigraniumProviderFailureKind,
    message: string,
    httpStatus?: number
  ) {
    super(String(message ?? "Figranium provider error").slice(0, 200));
    this.name = "FwgsFigraniumProviderError";
    this.kind = kind;
    if (httpStatus != null) this.httpStatus = httpStatus;
  }
}

export function isFwgsFigraniumProviderError(
  error: unknown
): error is FwgsFigraniumProviderError {
  return error instanceof FwgsFigraniumProviderError;
}

/**
 * Map a non-success Figranium result into either legitimate absence (return)
 * or a typed provider error to throw.
 * `unavailable` = feature not configured → return (caller may fall back).
 */
export function throwIfFwgsFigraniumProviderFailure(
  result: Exclude<FigraniumRunResult<unknown>, { kind: "success" }>
): void {
  switch (result.kind) {
    case "unavailable":
      // Not configured / feature off — legitimate absence, not a provider outage.
      return;
    case "auth_error":
      throw new FwgsFigraniumProviderError(
        "auth_error",
        result.message || "Figranium authentication failed",
        result.httpStatus
      );
    case "retryable_error":
      throw new FwgsFigraniumProviderError(
        "retryable_error",
        result.message || "Figranium temporarily unavailable",
        result.httpStatus
      );
    case "invalid_response":
      throw new FwgsFigraniumProviderError(
        "invalid_response",
        result.message || "Figranium returned an invalid response",
        result.httpStatus
      );
    default: {
      const _exhaustive: never = result;
      void _exhaustive;
    }
  }
}


function trimEnv(value: string | undefined): string {
  return String(value ?? "").trim();
}

export function getFwgsResolverTaskId(): string {
  return trimEnv(process.env.FIGRANIUM_FWGS_RESOLVER_TASK_ID);
}

export function getFwgsImageTaskId(): string {
  return trimEnv(process.env.FIGRANIUM_FWGS_IMAGE_TASK_ID);
}

export function getFwgsImageFetchTaskId(): string {
  return trimEnv(process.env.FIGRANIUM_FWGS_IMAGE_FETCH_TASK_ID);
}

/**
 * FWGS Figranium image path is enabled only when base URL, API key,
 * and the image task ID are all configured (no implicit production defaults).
 */
export function isFwgsFigraniumConfigured(): boolean {
  return isFigraniumConfigured() && Boolean(getFwgsImageTaskId());
}

/** Browser image-fetch fallback requires its own saved Figranium task ID. */
export function isFwgsFigraniumImageFetchConfigured(): boolean {
  return isFigraniumConfigured() && Boolean(getFwgsImageFetchTaskId());
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

/**
 * Derive a same-asset FWGS ccstore rendition by changing only height/width query params.
 * Does not alter hostname, source path, PLCB-bound filename, or asset version.
 * Returns null unless the derived URL still passes validateFwgsImageUrl.
 */
export function deriveFwgsImageRenditionUrl(
  url: string,
  plcbItem: string,
  size: { width: number; height: number }
): string | null {
  const code = normalizePlcbItem(plcbItem);
  if (!code) return null;
  if (!validateFwgsImageUrl(url, code)) return null;
  const width = Math.floor(Number(size.width));
  const height = Math.floor(Number(size.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(String(url).trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== FWGS_SITE_HOST) return null;

  // Change ONLY height/width rendering params. Preserve source path encoding,
  // param order, and asset version — do not re-serialize the full query string.
  const raw = String(url).trim();
  const qIndex = raw.indexOf("?");
  if (qIndex < 0) return null;
  const base = raw.slice(0, qIndex);
  const query = raw.slice(qIndex + 1);
  if (!/(?:^|&)width=\d+(?:&|$)/i.test(query) || !/(?:^|&)height=\d+(?:&|$)/i.test(query)) {
    return null;
  }
  const replaced = query
    .replace(/(^|&)(width=)\d+/i, `$1$2${width}`)
    .replace(/(^|&)(height=)\d+/i, `$1$2${height}`);
  const derived = `${base}?${replaced}`;
  if (!validateFwgsImageUrl(derived, code)) return null;
  return derived;
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
  // Resolver / optional paths still collapse failures to null.
  // Image extraction uses fwgsFigraniumResultOrThrow instead.
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
  if (result.kind !== "success") {
    // Propagate provider/system failures; only "unavailable"/not-configured → null.
    throwIfFwgsFigraniumProviderFailure(result);
    return null;
  }
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


/**
 * Fetch a single already-validated FWGS product image through Figranium's browser
 * session. Not a generic URL proxy — rejects anything that is not an https
 * www.finewineandgoodspirits.com /products/{PLCB}_... asset for the requested item.
 */
export async function fetchFwgsImageViaFigranium(
  imageUrl: string,
  requestedPlcbItem: string
): Promise<FwgsImageFetchOutcome> {
  const requested = normalizePlcbItem(requestedPlcbItem);
  if (!requested) return { ok: false, reason: "invalid_request" };
  if (!isFwgsFigraniumImageFetchConfigured()) return { ok: false, reason: "not_configured" };
  if (!validateFwgsImageUrl(imageUrl, requested)) return { ok: false, reason: "invalid_url" };

  const result = await figraniumRunTask(getFwgsImageFetchTaskId(), {
    variables: { plcbItem: requested, imageUrl: String(imageUrl).trim() },
    schema: FwgsFigraniumImageFetchResultSchema
  });
  if (result.kind !== "success") return { ok: false, reason: "figranium_error" };

  const payload = result.data;
  if (!payload.matched) return { ok: false, reason: "invalid_payload" };
  if (!validateReturnedPlcbItem(requested, payload.plcbItem)) {
    return { ok: false, reason: "plcb_mismatch" };
  }
  if (!validateFwgsImageUrl(payload.sourceUrl, requested)) {
    return { ok: false, reason: "invalid_url" };
  }

  const maxBytes = IMAGE_DOWNLOAD_MAX_BYTES;
  if (payload.byteLength <= 0) return { ok: false, reason: "empty_payload" };
  if (payload.byteLength > maxBytes) return { ok: false, reason: "oversized" };

  const cleaned = String(payload.base64 ?? "").replace(/\s+/g, "");
  if (!cleaned || /[^A-Za-z0-9+/]/.test(cleaned.replace(/=+$/, "")) || cleaned.length % 4 !== 0) {
    return { ok: false, reason: "malformed_base64" };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(cleaned, "base64");
  } catch {
    return { ok: false, reason: "malformed_base64" };
  }
  if (!bytes.length) return { ok: false, reason: "empty_payload" };
  if (bytes.length > maxBytes) return { ok: false, reason: "oversized" };
  if (bytes.length !== payload.byteLength) return { ok: false, reason: "invalid_payload" };

  const sniffed = sniffImageType(bytes);
  if (!sniffed || !sniffed.startsWith("image/")) return { ok: false, reason: "non_image" };
  const declared = String(payload.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (declared && !declared.startsWith("image/") && declared !== "application/octet-stream") {
    return { ok: false, reason: "non_image" };
  }

  const dims = readImageDimensionsFromHeader(bytes);
  return {
    ok: true,
    image: {
      plcbItem: requested,
      sourceUrl: payload.sourceUrl,
      contentType: sniffed,
      bytes,
      width: dims?.width ?? null,
      height: dims?.height ?? null
    }
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
