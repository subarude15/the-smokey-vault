/**
 * GTIN / UPC helpers for government catalogs.
 *
 * Never use floating-point math on barcodes. Preserve code_raw exactly.
 * Comparison normalization is reversible and validation-gated.
 */

export type GtinType = "gtin8" | "gtin12" | "gtin13" | "gtin14" | "unknown";

export type BarcodeNormalization = {
  codeRaw: string;
  digits: string;
  codeNormalized: string | null;
  comparisonKey: string | null;
  gtinType: GtinType | null;
  checkDigitValid: boolean | null;
  qualityFlags: string[];
  usable: boolean;
};

const SCI_RE = /^[+-]?(\d+)(?:\.(\d+))?e([+-]?\d+)$/i;

function onlyDigits(value: string): string {
  return String(value ?? "").replace(/\D/g, "");
}

function computeGtinCheckDigit(bodyWithoutCheck: string): number | null {
  const digits = onlyDigits(bodyWithoutCheck);
  if (!digits) return null;
  // GS1: rightmost body digit has weight 3, alternating 1/3 toward the left.
  let sum = 0;
  let weight = 3;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10;
}

export function validateGtinCheckDigit(digits: string): boolean | null {
  const d = onlyDigits(digits);
  if (![8, 12, 13, 14].includes(d.length)) return null;
  const expected = computeGtinCheckDigit(d.slice(0, -1));
  if (expected == null) return null;
  return expected === Number(d[d.length - 1]);
}

export function gtinTypeForLength(length: number): GtinType | null {
  if (length === 8) return "gtin8";
  if (length === 12) return "gtin12";
  if (length === 13) return "gtin13";
  if (length === 14) return "gtin14";
  return null;
}

/**
 * Expand scientific-notation barcode text only when mantissa digits are exact.
 * Returns null digits when expansion would invent significant digits.
 */
export function expandScientificBarcode(raw: string): { digits: string | null; precisionLost: boolean } {
  const text = String(raw ?? "").trim();
  const match = text.match(SCI_RE);
  if (!match) return { digits: null, precisionLost: false };
  const whole = match[1] ?? "";
  const frac = match[2] ?? "";
  const mantissa = `${whole}${frac}`;
  const exponent = Number.parseInt(match[3] ?? "0", 10);
  if (!Number.isFinite(exponent) || !mantissa) return { digits: null, precisionLost: true };
  const significant = mantissa.replace(/^0+/, "") || "0";
  // Retail UPCs need enough significant digits; short sci forms are unusable.
  if (significant.length < 11) return { digits: null, precisionLost: true };
  const shift = exponent - frac.length;
  if (shift >= 0) return { digits: `${mantissa}${"0".repeat(shift)}`, precisionLost: false };
  const cut = -shift;
  if (cut >= mantissa.length) return { digits: null, precisionLost: true };
  const head = mantissa.slice(0, mantissa.length - cut);
  const tail = mantissa.slice(mantissa.length - cut);
  if (/[1-9]/.test(tail)) return { digits: null, precisionLost: true };
  return { digits: head, precisionLost: false };
}

function formatNumberAsBarcodeText(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) return String(n);
  return n.toExponential().replace(/e\+?/, "e");
}

/**
 * Build a comparison key that recognizes UPC-A ↔ zero-prefixed EAN-13
 * only when check digits validate on both forms.
 */
export function barcodeComparisonKey(digits: string): string | null {
  const d = onlyDigits(digits);
  if (!d) return null;
  if (d.length === 12 && validateGtinCheckDigit(d) === true) {
    const ean13 = `0${d}`;
    if (validateGtinCheckDigit(ean13) === true) return ean13;
    return d;
  }
  if (d.length === 13 && d.startsWith("0") && validateGtinCheckDigit(d) === true) {
    const upc = d.slice(1);
    if (validateGtinCheckDigit(upc) === true) return d;
    return d;
  }
  if ([8, 12, 13, 14].includes(d.length)) return d;
  return null;
}

export function normalizeGovernmentBarcode(raw: unknown): BarcodeNormalization {
  const codeRaw =
    raw == null
      ? ""
      : typeof raw === "number" && Number.isFinite(raw)
        ? formatNumberAsBarcodeText(raw)
        : String(raw).trim();

  const flags: string[] = [];
  if (!codeRaw) {
    return {
      codeRaw: "",
      digits: "",
      codeNormalized: null,
      comparisonKey: null,
      gtinType: null,
      checkDigitValid: null,
      qualityFlags: ["empty"],
      usable: false
    };
  }

  let digits = "";
  const compact = codeRaw.replace(/\s+/g, "");
  if (SCI_RE.test(compact)) {
    const expanded = expandScientificBarcode(compact);
    if (expanded.precisionLost || !expanded.digits) {
      return {
        codeRaw,
        digits: "",
        codeNormalized: null,
        comparisonKey: null,
        gtinType: null,
        checkDigitValid: null,
        qualityFlags: ["scientific_precision_lost"],
        usable: false
      };
    }
    digits = expanded.digits;
  } else {
    digits = onlyDigits(codeRaw);
  }

  if (!digits) {
    return {
      codeRaw,
      digits: "",
      codeNormalized: null,
      comparisonKey: null,
      gtinType: null,
      checkDigitValid: null,
      qualityFlags: ["non_digit"],
      usable: false
    };
  }

  if (digits.length === 9) flags.push("nine_digit_review");

  const gtinType = gtinTypeForLength(digits.length);
  const checkDigitValid = validateGtinCheckDigit(digits);
  if (checkDigitValid === false) flags.push("check_digit_invalid");
  if (!gtinType && digits.length !== 9) flags.push("unsupported_length");

  const usable =
    Boolean(gtinType) || digits.length === 9 || (digits.length >= 8 && digits.length <= 14);

  return {
    codeRaw,
    digits,
    codeNormalized: usable ? digits : null,
    comparisonKey: usable ? barcodeComparisonKey(digits) ?? digits : null,
    gtinType,
    checkDigitValid,
    qualityFlags: flags,
    usable
  };
}

export function barcodesEquivalent(a: string, b: string): boolean {
  const left = normalizeGovernmentBarcode(a);
  const right = normalizeGovernmentBarcode(b);
  if (!left.comparisonKey || !right.comparisonKey) return false;
  return left.comparisonKey === right.comparisonKey;
}
