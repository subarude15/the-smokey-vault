/**
 * Single scan-facing barcode normalization helper.
 * Persistence / catalog keys still go through cola_client.canonicalGtin;
 * this module is the one place scan code should call for decode → lookup cleanup.
 */
import {
  barcodeVariants,
  canonicalGtin,
  ean13Form,
  looksLikeBarcode,
  normalizeUpc,
  primaryCatalogUpc,
  upcAForm
} from "./cola_client.js";

/** Stable format names used in scan metadata / logs (not ZXing enum numbers). */
export type BarcodeFormatName =
  | "UPC_A"
  | "UPC_E"
  | "EAN_8"
  | "EAN_13"
  | "CODE_128"
  | "QR_CODE"
  | "UNKNOWN";

export type NormalizedBarcode = {
  /** Digits-only (or trimmed text for non-GTIN formats like Code 128 / QR). */
  cleaned: string;
  /** normalizeUpc result when the value looks like a product GTIN; else "". */
  normalized: string;
  /** canonicalGtin for vault/catalog lookup keys; else "". */
  canonical: string;
  upcA: string;
  ean13: string;
  /** True when canonicalGtin produced a checksum-valid product identifier. */
  isValidGtin: boolean;
  /** True when the value is usable as a product barcode lookup key. */
  isLookupKey: boolean;
};

const FORMAT_BY_ZXING: Record<number, BarcodeFormatName> = {
  14: "UPC_A",
  15: "UPC_E",
  6: "EAN_8",
  7: "EAN_13",
  4: "CODE_128",
  11: "QR_CODE"
};

export function barcodeFormatName(zxingFormat: number | string | null | undefined): BarcodeFormatName {
  if (typeof zxingFormat === "number" && FORMAT_BY_ZXING[zxingFormat]) {
    return FORMAT_BY_ZXING[zxingFormat]!;
  }
  const asText = String(zxingFormat ?? "").toUpperCase().replace(/-/g, "_");
  if (
    asText === "UPC_A" ||
    asText === "UPC_E" ||
    asText === "EAN_8" ||
    asText === "EAN_13" ||
    asText === "CODE_128" ||
    asText === "QR_CODE"
  ) {
    return asText;
  }
  return "UNKNOWN";
}

/**
 * Clean a decoder/user raw value for lookup.
 * - strips whitespace and formatting punctuation for digit codes
 * - does not invent missing check digits
 * - does not strip significant leading zeroes from valid EAN-13 / GTIN forms
 *   (canonicalGtin / primaryCatalogUpc already map 0+UPC-A twins correctly)
 */
export function normalizeDecodedBarcode(
  rawValue: string,
  formatName: BarcodeFormatName | string = "UNKNOWN"
): NormalizedBarcode {
  const trimmed = String(rawValue ?? "").trim();
  const format = barcodeFormatName(formatName);

  // QR / Code 128 may carry non-digit payloads; keep trimmed text, only digitize when it looks like a GTIN.
  if (format === "QR_CODE" || format === "CODE_128") {
    const digits = trimmed.replace(/\D/g, "");
    if (looksLikeBarcode(digits) && canonicalGtin(digits)) {
      return normalizeProductDigits(digits);
    }
    return {
      cleaned: trimmed,
      normalized: "",
      canonical: "",
      upcA: "",
      ean13: "",
      isValidGtin: false,
      isLookupKey: false
    };
  }

  const digits = trimmed.replace(/[\s\-]/g, "").replace(/\D/g, "");
  if (!digits) {
    return {
      cleaned: "",
      normalized: "",
      canonical: "",
      upcA: "",
      ean13: "",
      isValidGtin: false,
      isLookupKey: false
    };
  }
  return normalizeProductDigits(digits);
}

function normalizeProductDigits(digits: string): NormalizedBarcode {
  const normalized = normalizeUpc(digits);
  const canonical = canonicalGtin(digits) || canonicalGtin(normalized);
  const upcA = upcAForm(canonical || normalized || digits);
  const ean13 = ean13Form(canonical || normalized || digits);
  return {
    cleaned: digits,
    normalized,
    canonical,
    upcA,
    ean13,
    isValidGtin: Boolean(canonical),
    isLookupKey: Boolean(canonical)
  };
}

/** Re-export variants helper so scan code has one import surface. */
export function decodedBarcodeVariants(canonicalOrRaw: string) {
  return barcodeVariants(canonicalOrRaw);
}

export function catalogLookupKey(raw: string) {
  return primaryCatalogUpc(raw) || canonicalGtin(raw);
}
